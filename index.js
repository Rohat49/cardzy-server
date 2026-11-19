const http = require('http');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL_MS = 20000;
const MAX_NAME_LENGTH = 16;

// Bulut platformlarının sağlık kontrolü (health check) için HTTP sunucu
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'cardzy-matchmaking' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// maxPayload: tek bir mesajın boyutunu sınırlar (kötüye kullanıma karşı).
const wss = new WebSocket.Server({ server, maxPayload: 16 * 1024 });

let matchmakingQueue = [];
const rooms = new Map();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Cardzy WebSocket Sunucusu ${PORT} portunda çalışıyor...`);
});

// Cardzy Destesi: 0-9 arası 4'er rakam (40 kart) + 4 Bomba + 4 Karıştırıcı (Toplam 48 kart)
function createShuffledDeck() {
  const deck = [];

  for (let num = 0; num <= 9; num++) {
    for (let copy = 0; copy < 4; copy++) {
      deck.push({ type: 'NUMBER', value: num });
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push({ type: 'BOMB', value: -1 });
  }

  for (let i = 0; i < 4; i++) {
    deck.push({ type: 'SHUFFLE', value: -2 });
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

// Bağlantı kapalıyken gönderim yapmaz, sunucunun hata verip çökmesini önler.
function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function cleanName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return 'Oyuncu';
  return name.slice(0, MAX_NAME_LENGTH);
}

wss.on('connection', (ws) => {
  ws.id = randomUUID();
  ws.roomId = null;
  ws.isAlive = true;

  console.log(`[+] Cardzy Yeni Bağlantı: ${ws.id}`);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (rawMessage) => {
    let data;
    try {
      data = JSON.parse(rawMessage.toString());
    } catch (e) {
      return;
    }

    if (!data || typeof data !== 'object') return;

    switch (data.type) {
      case 'FIND_MATCH':
        handleFindMatch(ws, data.playerName);
        break;

      case 'CANCEL_MATCH':
        removeFromQueue(ws);
        safeSend(ws, { type: 'CANCELLED' });
        break;

      case 'LEAVE_ROOM':
        handleDisconnectInRoom(ws);
        break;

      case 'GAME_ACTION':
        handleGameAction(ws, data);
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[-] Bağlantı koptu: ${ws.id}`);
    removeFromQueue(ws);
    handleDisconnectInRoom(ws);
  });

  ws.on('error', (err) => {
    console.error(`[!] Soket hatası (${ws.id}): ${err.message}`);
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

function handleFindMatch(ws, rawName) {
  if (ws.roomId) {
    safeSend(ws, { type: 'ERROR', message: 'ALREADY_IN_ROOM' });
    return;
  }
  if (matchmakingQueue.some((p) => p.ws.id === ws.id)) return;

  const playerName = cleanName(rawName);
  ws.playerName = playerName;
  matchmakingQueue.push({ ws, playerName });

  safeSend(ws, { type: 'SEARCHING' });
  console.log(`[?] Cardzy Eşleşme Kuyruğu: ${playerName} (Bekleyen: ${matchmakingQueue.length})`);

  tryMatch();
}

function tryMatch() {
  matchmakingQueue = matchmakingQueue.filter((p) => p.ws.readyState === WebSocket.OPEN);

  while (matchmakingQueue.length >= 2) {
    const player1 = matchmakingQueue.shift();
    const player2 = matchmakingQueue.shift();
    createMatchRoom(player1, player2);
  }
}

function createMatchRoom(p1, p2) {
  const roomId = randomUUID().slice(0, 8);
  const deck = createShuffledDeck();

  const p1Cards = deck.splice(0, 8);
  const p2Cards = deck.splice(0, 8);
  const discardPile = [deck.pop()];

  const firstPlayer = Math.random() < 0.5 ? p1 : p2;

  const roomState = {
    roomId,
    deck,
    discardPile,
    turnPlayerId: firstPlayer.ws.id,
    players: {
      [p1.ws.id]: {
        ws: p1.ws,
        name: p1.playerName,
        slots: p1Cards.map((card) => ({ card, revealed: false })),
      },
      [p2.ws.id]: {
        ws: p2.ws,
        name: p2.playerName,
        slots: p2Cards.map((card) => ({ card, revealed: false })),
      },
    },
  };

  p1.ws.roomId = roomId;
  p2.ws.roomId = roomId;
  rooms.set(roomId, roomState);

  console.log(`[⚔️] Cardzy Eşleşme Bulundu! Oda: ${roomId} (${p1.playerName} vs ${p2.playerName})`);

  sendMatchFound(p1.ws, p2.ws, roomState);
  sendMatchFound(p2.ws, p1.ws, roomState);
}

function sendMatchFound(targetWs, opponentWs, roomState) {
  safeSend(targetWs, {
    type: 'MATCH_FOUND',
    roomId: roomState.roomId,
    yourId: targetWs.id,
    opponentName: opponentWs.playerName,
    isYourTurn: roomState.turnPlayerId === targetWs.id,
    topDiscard: roomState.discardPile[roomState.discardPile.length - 1],
    deckCount: roomState.deck.length,
  });
}

function removeFromQueue(ws) {
  matchmakingQueue = matchmakingQueue.filter((p) => p.ws.id !== ws.id);
}

function handleGameAction(ws, data) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  // TODO: Kart çekme, kart açma ve sıra kontrolü sunucuda yapılacak.
}

function handleDisconnectInRoom(ws) {
  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);
  ws.roomId = null;
  if (!room) return;

  Object.values(room.players).forEach((player) => {
    if (player.ws.id !== ws.id) {
      player.ws.roomId = null;
      safeSend(player.ws, { type: 'OPPONENT_LEFT' });
    }
  });

  rooms.delete(room.roomId);
}