const http = require('http');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL_MS = 20000;
const MAX_NAME_LENGTH = 16;
const MATCH_DURATION_MS = 3 * 60 * 1000; // 3 dakika (180 saniye)
const SLOT_COUNT = 8;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'cardzy-game-server' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server, maxPayload: 16 * 1024 });

let matchmakingQueue = [];
const rooms = new Map();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Cardzy Oyun Sunucusu ${PORT} portunda çalışıyor...`);
});

function drawRandomCard() {
  const value = Math.floor(Math.random() * 10); // 0..9
  return { type: 'NUMBER', value };
}

function createInitialSlots() {
  const slots = [];
  for (let i = 1; i <= SLOT_COUNT; i++) {
    slots.push({
      slotIndex: i,
      card: drawRandomCard(),
      revealed: false,
    });
  }
  return slots;
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function cleanName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return 'Oyuncu';
  return name.slice(0, MAX_NAME_LENGTH);
}

function canPlaceCard(playerState, card) {
  if (!card || card.type !== 'NUMBER') return false;
  const val = card.value;
  if (val < 1 || val > SLOT_COUNT) return false;
  const targetSlot = playerState.slots[val - 1];
  return Boolean(targetSlot && !targetSlot.revealed);
}

function broadcastRoomState(room, eventMeta = null) {
  if (!room || room.isFinished) return;

  const remainingMs = Math.max(0, room.endsAt - Date.now());
  const playerIds = Object.keys(room.players);

  playerIds.forEach((pid) => {
    const me = room.players[pid];
    const oppId = playerIds.find((id) => id !== pid);
    const opp = room.players[oppId];

    const sanitizeSlots = (slots) =>
      slots.map((s) => ({
        slotIndex: s.slotIndex,
        revealed: s.revealed,
        card: s.revealed ? s.card : null,
      }));

    safeSend(me.ws, {
      type: 'GAME_STATE_UPDATE',
      roomId: room.roomId,
      isYourTurn: room.turnPlayerId === pid,
      remainingMs,
      serverTime: Date.now(),
      topDiscard: room.discardPile.length > 0
        ? room.discardPile[room.discardPile.length - 1]
        : null,
      you: {
        id: pid,
        name: me.name,
        heldCard: me.heldCard,
        mustDiscard: me.heldCard ? !canPlaceCard(me, me.heldCard) : false,
        openCount: me.slots.filter((s) => s.revealed).length,
        slots: sanitizeSlots(me.slots),
      },
      opponent: {
        id: oppId,
        name: opp.name,
        heldCard: opp.heldCard,
        openCount: opp.slots.filter((s) => s.revealed).length,
        slots: sanitizeSlots(opp.slots),
      },
      event: eventMeta,
    });
  });
}

function finishMatch(room, winnerId, reason) {
  if (!room || room.isFinished) return;
  room.isFinished = true;

  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }

  const playerIds = Object.keys(room.players);
  playerIds.forEach((pid) => {
    const me = room.players[pid];
    const oppId = playerIds.find((id) => id !== pid);
    const opp = room.players[oppId];

    const myOpen = me.slots.filter((s) => s.revealed).length;
    const oppOpen = opp.slots.filter((s) => s.revealed).length;

    let result = 'DRAW';
    if (winnerId) {
      result = winnerId === pid ? 'WIN' : 'LOSE';
    }

    safeSend(me.ws, {
      type: 'GAME_OVER',
      roomId: room.roomId,
      result,
      reason,
      yourOpenCount: myOpen,
      opponentOpenCount: oppOpen,
      yourSlots: me.slots,
      opponentSlots: opp.slots,
    });

    if (me.ws) {
      me.ws.roomId = null;
    }
  });

  rooms.delete(room.roomId);
  console.log(`[🏆] Oda ${room.roomId} tamamlandı. Kazanan: ${winnerId || 'BERABERE'} (${reason})`);
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
      console.log(`[!] Geçersiz JSON (${ws.id})`);
      return;
    }

    if (!data || typeof data !== 'object') return;
    console.log(`[MSG] ${ws.playerName || ws.id} -> ${JSON.stringify(data)}`);

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

      case 'REQUEST_STATE': {
        const room = rooms.get(ws.roomId);
        console.log(`[SYNC] ${ws.playerName || ws.id} oda: ${ws.roomId}, bulundu: ${Boolean(room)}`);
        if (room) broadcastRoomState(room, { kind: 'SYNC' });
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`[-] Bağlantı koptu: ${ws.playerName || ws.id}`);
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
  const firstPlayer = Math.random() < 0.5 ? p1 : p2;
  const now = Date.now();
  const endsAt = now + MATCH_DURATION_MS;

  const roomState = {
    roomId,
    discardPile: [],
    turnPlayerId: firstPlayer.ws.id,
    startedAt: now,
    endsAt,
    isFinished: false,
    timer: null,
    players: {
      [p1.ws.id]: {
        ws: p1.ws,
        name: p1.playerName,
        heldCard: null,
        slots: createInitialSlots(),
      },
      [p2.ws.id]: {
        ws: p2.ws,
        name: p2.playerName,
        heldCard: null,
        slots: createInitialSlots(),
      },
    },
  };

  roomState.timer = setTimeout(() => {
    handleMatchTimeout(roomId);
  }, MATCH_DURATION_MS);

  p1.ws.roomId = roomId;
  p2.ws.roomId = roomId;
  rooms.set(roomId, roomState);

  console.log(`[⚔️] Cardzy Eşleşme Bulundu! Oda: ${roomId} (${p1.playerName} vs ${p2.playerName}) İlk Sıra: ${firstPlayer.playerName}`);

  sendMatchFound(p1.ws, p2.ws, roomState);
  sendMatchFound(p2.ws, p1.ws, roomState);
}

function sendMatchFound(targetWs, opponentWs, roomState) {
  const me = roomState.players[targetWs.id];
  const opp = roomState.players[opponentWs.id];

  safeSend(targetWs, {
    type: 'MATCH_FOUND',
    roomId: roomState.roomId,
    yourId: targetWs.id,
    opponentName: opponentWs.playerName,
    isYourTurn: roomState.turnPlayerId === targetWs.id,
    remainingMs: Math.max(0, roomState.endsAt - Date.now()),
    slotCount: SLOT_COUNT,
    yourSlots: me.slots.map((s) => ({ slotIndex: s.slotIndex, revealed: false, card: null })),
    opponentSlots: opp.slots.map((s) => ({ slotIndex: s.slotIndex, revealed: false, card: null })),
  });
}

function handleMatchTimeout(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.isFinished) return;

  const [p1Id, p2Id] = Object.keys(room.players);
  const p1Open = room.players[p1Id].slots.filter((s) => s.revealed).length;
  const p2Open = room.players[p2Id].slots.filter((s) => s.revealed).length;

  let winnerId = null;
  if (p1Open > p2Open) {
    winnerId = p1Id;
  } else if (p2Open > p1Open) {
    winnerId = p2Id;
  }

  finishMatch(room, winnerId, 'TIME_UP');
}

function handleGameAction(ws, data) {
  const room = rooms.get(ws.roomId);
  if (!room || room.isFinished) {
    console.log(`[ACTION-ERR] Oda bulunamadı (${ws.playerName}): roomId=${ws.roomId}`);
    return;
  }

  if (room.turnPlayerId !== ws.id) {
    console.log(`[ACTION-ERR] Sıra hatası (${ws.playerName}): sıra=${room.turnPlayerId}, basan=${ws.id}`);
    safeSend(ws, {
      type: 'INVALID_MOVE',
      code: 'NOT_YOUR_TURN',
      message: 'Sıra sende değil.',
    });
    return;
  }

  const player = room.players[ws.id];
  const opponentId = Object.keys(room.players).find((id) => id !== ws.id);
  if (!player || !opponentId) return;

  switch (data.action) {
    case 'DRAW_CARD': {
      if (player.heldCard !== null) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'ALREADY_HOLDING_CARD',
          message: 'Elindeki kartı önce yerleştirmeli veya kenara atmalısın.',
        });
        return;
      }

      const drawnCard = drawRandomCard();
      player.heldCard = drawnCard;
      console.log(`[DRAW] ${player.name} kart çekti: ${drawnCard.value}`);

      broadcastRoomState(room, {
        kind: 'CARD_DRAWN',
        actorId: ws.id,
        card: drawnCard,
      });
      break;
    }

    case 'PLACE_CARD': {
      const held = player.heldCard;
      if (!held) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'NO_HELD_CARD',
          message: 'Önce desteden kart çekmelisin.',
        });
        return;
      }

      const targetSlotIndex = Number(data.slotIndex);
      if (!Number.isInteger(targetSlotIndex) || targetSlotIndex < 1 || targetSlotIndex > SLOT_COUNT) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'INVALID_SLOT',
          message: 'Geçersiz kart yuvası.',
        });
        return;
      }

      if (held.value < 1 || held.value > SLOT_COUNT) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'MUST_DISCARD_CARD',
          message: 'Bu kart yuvaya konamaz, kenara atmalısın.',
        });
        return;
      }

      if (targetSlotIndex !== held.value) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'WRONG_SLOT',
          expectedSlot: held.value,
          message: `Bu kart sadece ${held.value}. yuvaya konabilir.`,
        });
        return;
      }

      const slot = player.slots[targetSlotIndex - 1];
      if (slot.revealed) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'SLOT_ALREADY_OPEN',
          message: 'Bu yuva zaten açık, kartı kenara atmalısın.',
        });
        return;
      }

      const revealedUnderneathCard = slot.card;
      slot.card = held;
      slot.revealed = true;
      player.heldCard = revealedUnderneathCard;
      console.log(`[PLACE] ${player.name} -> ${targetSlotIndex}. yuva açıldı, yeni kart: ${revealedUnderneathCard.value}`);

      const allOpened = player.slots.every((s) => s.revealed);
      if (allOpened) {
        player.heldCard = null;
        broadcastRoomState(room, {
          kind: 'CARD_PLACED',
          actorId: ws.id,
          slotIndex: targetSlotIndex,
          placedCard: held,
          revealedCard: null,
        });
        finishMatch(room, ws.id, 'ALL_SLOTS_OPENED');
        return;
      }

      broadcastRoomState(room, {
        kind: 'CARD_PLACED',
        actorId: ws.id,
        slotIndex: targetSlotIndex,
        placedCard: held,
        revealedCard: revealedUnderneathCard,
      });
      break;
    }

    case 'DISCARD_CARD': {
      const held = player.heldCard;
      if (!held) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'NO_HELD_CARD',
          message: 'Atılacak bir kartın yok.',
        });
        return;
      }

      if (canPlaceCard(player, held)) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'MUST_PLACE_IN_MATCHING_SLOT',
          expectedSlot: held.value,
          message: `Önce bu kartı ${held.value}. yuvaya yerleştirmelisin.`,
        });
        return;
      }

      room.discardPile.push(held);
      player.heldCard = null;
      room.turnPlayerId = opponentId;
      console.log(`[DISCARD] ${player.name} kart attı: ${held.value} -> Sıra rakibe geçti`);

      broadcastRoomState(room, {
        kind: 'CARD_DISCARDED',
        actorId: ws.id,
        card: held,
        nextTurnPlayerId: opponentId,
      });
      break;
    }
  }
}

function removeFromQueue(ws) {
  matchmakingQueue = matchmakingQueue.filter((p) => p.ws.id !== ws.id);
}

function handleDisconnectInRoom(ws) {
  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);
  ws.roomId = null;
  if (!room || room.isFinished) return;

  const opponentId = Object.keys(room.players).find((id) => id !== ws.id);
  if (opponentId) {
    finishMatch(room, opponentId, 'OPPONENT_LEFT');
  } else {
    if (room.timer) clearTimeout(room.timer);
    rooms.delete(room.roomId);
  }
}
