const http = require('http');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL_MS = 20000;
const MAX_NAME_LENGTH = 16;
const MATCH_DURATION_MS = 3 * 60 * 1000; // 3 dakika (180 saniye)
const TURN_DURATION_MS = 15 * 1000; // Her hamle turu 15 saniye
const INTRO_DELAY_MS = 7200; // 5 sn geri sayım + deste dönüşü + kart dağıtımı
const SLOT_COUNT = 8;
const CARD_COLORS = ['RED', 'YELLOW', 'GREEN', 'BLUE'];

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

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 0-9 arası 4 renkten 2'şer adet (80) + 2 adet +1 + 2 adet +2 = 84 kartlık deste
function createFullDeck() {
  const deck = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const color of CARD_COLORS) {
      for (let value = 0; value <= 9; value++) {
        deck.push({ type: 'NUMBER', value, color });
      }
    }
  }
  for (let i = 0; i < 2; i++) {
    deck.push({ type: 'PLUS_ONE', value: 1, color: 'SPECIAL' });
    deck.push({ type: 'PLUS_TWO', value: 2, color: 'SPECIAL' });
  }
  return shuffleArray(deck);
}

function isSpecialCard(card) {
  return card && (card.type === 'PLUS_ONE' || card.type === 'PLUS_TWO');
}

function ensureDeckHasCards(room) {
  if (room.deck.length > 0) return;

  if (room.discardPile.length > 1) {
    const topCard = room.discardPile.pop();
    room.deck = shuffleArray([...room.discardPile]);
    room.discardPile = [topCard];
    console.log(`[♻️] Oda ${room.roomId}: Iskarta karıştırıldı, yeni deste: ${room.deck.length} kart`);
  } else {
    room.deck = createFullDeck();
    console.log(`[♻️] Oda ${room.roomId}: Yeni deste açıldı`);
  }
}

function drawSmartCard(room, player, opponent) {
  ensureDeckHasCards(room);

  const elapsedSec = (Date.now() - room.startedAt) / 1000;
  const closedSlotNumbers = new Set(
    player.slots.filter((s) => !s.revealed).map((s) => s.slotIndex)
  );
  const myOpenCount = SLOT_COUNT - closedSlotNumbers.size;
  const oppOpenCount = opponent.slots.filter((s) => s.revealed).length;
  const dryStreak = player.dryStreak || 0;
  const leadDiff = oppOpenCount - myOpenCount;

  if (dryStreak >= 3 && closedSlotNumbers.size > 0) {
    const guaranteedIdx = room.deck.findIndex(
      (c) => c.type === 'NUMBER' && closedSlotNumbers.has(c.value)
    );
    if (guaranteedIdx !== -1) {
      const [picked] = room.deck.splice(guaranteedIdx, 1);
      console.log(`[🎯 PITY-GARANTİ] ${player.name} (dryStreak=${dryStreak}) -> ${picked.color} ${picked.value}`);
      return picked;
    }
  }

  const weights = room.deck.map((card) => {
    if (isSpecialCard(card)) {
      if (player.savedSpecialCard) return 0.15;
      if (oppOpenCount === 0) return 0.25;

      let specialWeight = 0.95;
      if (oppOpenCount >= 3) {
        specialWeight *= 1.45;
      }
      if (leadDiff >= 2 && oppOpenCount >= 2) {
        specialWeight *= 1.75;
      }
      if (myOpenCount >= 6 && leadDiff <= -2) {
        specialWeight *= 0.65;
      }
      return specialWeight;
    }

    const isUseful = closedSlotNumbers.has(card.value);
    const isZeroOrNine = card.value === 0 || card.value === 9;
    let w = 1.0;

    if (isUseful) {
      if (elapsedSec < 60) {
        w *= 1.45;
      } else if (elapsedSec < 105) {
        w *= 1.25;
      } else {
        w *= 1.85;
      }

      if (dryStreak === 2) {
        w *= 2.8;
      } else if (dryStreak === 1) {
        w *= 1.35;
      }

      if (leadDiff >= 2) {
        w *= 1.55;
      }
    } else {
      if (dryStreak >= 2) {
        w *= isZeroOrNine ? 0.25 : 0.40;
      } else if (elapsedSec >= 105) {
        w *= 0.50;
      } else if (isZeroOrNine) {
        w *= 0.85;
      }
    }

    return Math.max(0.05, w);
  });

  const totalWeight = weights.reduce((acc, val) => acc + val, 0);
  let r = Math.random() * totalWeight;
  let chosenIndex = 0;

  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      chosenIndex = i;
      break;
    }
  }

  const [drawn] = room.deck.splice(chosenIndex, 1);
  return drawn;
}

function createInitialSlots(deck) {
  const slots = [];
  for (let i = 1; i <= SLOT_COUNT; i++) {
    let idx = deck.findIndex((c) => c.type === 'NUMBER');
    let card;
    if (idx !== -1) {
      [card] = deck.splice(idx, 1);
    } else {
      card = { type: 'NUMBER', value: Math.floor(Math.random() * 10), color: 'RED' };
    }
    slots.push({
      slotIndex: i,
      card,
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

// 15 saniyelik hamle sayacını başlatır / sıfırlar
function scheduleTurnTimer(room, extraDelayMs = 0) {
  if (!room || room.isFinished) return;
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }

  const duration = TURN_DURATION_MS + extraDelayMs;
  room.turnDurationMs = TURN_DURATION_MS;
  room.turnEndsAt = Date.now() + duration;

  room.turnTimer = setTimeout(() => {
    handleTurnTimeout(room.roomId);
  }, duration);
}

// Oyuncu 15 saniye içinde hamle yapmazsa kartı boşa atılır ve sıra rakibe geçer
function handleTurnTimeout(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.isFinished) return;

  const activeId = room.turnPlayerId;
  const player = room.players[activeId];
  const opponentId = Object.keys(room.players).find((id) => id !== activeId);
  const opponent = room.players[opponentId];
  if (!player || !opponent) return;

  let discardedCard = null;
  if (player.heldCard) {
    discardedCard = player.heldCard;
    if (discardedCard.type === 'NUMBER') {
      room.discardPile.push(discardedCard);
    } else {
      room.deck.push(discardedCard);
      shuffleArray(room.deck);
    }
    player.heldCard = null;
  }

  player.pendingFlipCount = 0;
  player.placedThisTurn = false;
  room.turnPlayerId = opponentId;

  console.log(`[⏰ SÜRE DOLDU] ${player.name} 15 sn içinde oynamadı -> Sıra ${opponent.name}'e geçti.`);

  scheduleTurnTimer(room, 0);
  broadcastRoomState(room, {
    kind: discardedCard && discardedCard.type === 'NUMBER'
      ? 'CARD_DISCARDED'
      : 'TURN_TIMEOUT',
    actorId: activeId,
    card: discardedCard,
    nextTurnPlayerId: opponentId,
  });
}

function broadcastRoomState(room, eventMeta = null) {
  if (!room || room.isFinished) return;

  const now = Date.now();
  const remainingMs = Math.max(0, room.endsAt - now);
  const turnRemainingMs = Math.max(0, (room.turnEndsAt || now) - now);
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
      turnRemainingMs,
      turnDurationMs: room.turnDurationMs || TURN_DURATION_MS,
      deckCount: room.deck.length,
      serverTime: now,
      topDiscard: room.discardPile.length > 0
        ? room.discardPile[room.discardPile.length - 1]
        : null,
      you: {
        id: pid,
        name: me.name,
        heldCard: me.heldCard,
        savedSpecialCard: me.savedSpecialCard,
        pendingFlipCount: me.pendingFlipCount || 0,
        mustDiscard: me.heldCard && me.heldCard.type === 'NUMBER'
          ? !canPlaceCard(me, me.heldCard)
          : false,
        openCount: me.slots.filter((s) => s.revealed).length,
        slots: sanitizeSlots(me.slots),
      },
      opponent: {
        id: oppId,
        name: opp.name,
        heldCard: opp.heldCard,
        savedSpecialCard: opp.savedSpecialCard,
        pendingFlipCount: opp.pendingFlipCount || 0,
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
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
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

      case 'REQUEST_STATE': {
        const room = rooms.get(ws.roomId);
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
  const endsAt = now + MATCH_DURATION_MS + INTRO_DELAY_MS;
  const deck = createFullDeck();

  const p1Slots = createInitialSlots(deck);
  const p2Slots = createInitialSlots(deck);

  const roomState = {
    roomId,
    deck,
    discardPile: [],
    turnPlayerId: firstPlayer.ws.id,
    startedAt: now,
    endsAt,
    turnEndsAt: now + INTRO_DELAY_MS + TURN_DURATION_MS,
    turnDurationMs: TURN_DURATION_MS,
    isFinished: false,
    timer: null,
    turnTimer: null,
    players: {
      [p1.ws.id]: {
        ws: p1.ws,
        name: p1.playerName,
        heldCard: null,
        savedSpecialCard: null,
        pendingFlipCount: 0,
        dryStreak: 0,
        placedThisTurn: false,
        slots: p1Slots,
      },
      [p2.ws.id]: {
        ws: p2.ws,
        name: p2.playerName,
        heldCard: null,
        savedSpecialCard: null,
        pendingFlipCount: 0,
        dryStreak: 0,
        placedThisTurn: false,
        slots: p2Slots,
      },
    },
  };

  roomState.timer = setTimeout(() => {
    handleMatchTimeout(roomId);
  }, MATCH_DURATION_MS + INTRO_DELAY_MS);

  scheduleTurnTimer(roomState, INTRO_DELAY_MS);

  p1.ws.roomId = roomId;
  p2.ws.roomId = roomId;
  rooms.set(roomId, roomState);

  console.log(`[⚔️] Cardzy Eşleşme Bulundu! Oda: ${roomId} (${p1.playerName} vs ${p2.playerName}) Kalan Deste: ${deck.length}`);

  sendMatchFound(p1.ws, p2.ws, roomState);
  sendMatchFound(p2.ws, p1.ws, roomState);
}

function sendMatchFound(targetWs, opponentWs, roomState) {
  const me = roomState.players[targetWs.id];
  const opp = roomState.players[opponentWs.id];
  const now = Date.now();

  safeSend(targetWs, {
    type: 'MATCH_FOUND',
    roomId: roomState.roomId,
    yourId: targetWs.id,
    opponentName: opponentWs.playerName,
    isYourTurn: roomState.turnPlayerId === targetWs.id,
    remainingMs: Math.max(0, roomState.endsAt - now),
    turnRemainingMs: Math.max(0, roomState.turnEndsAt - now),
    turnDurationMs: TURN_DURATION_MS,
    deckCount: roomState.deck.length,
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
  if (!room || room.isFinished) return;

  if (room.turnPlayerId !== ws.id) {
    safeSend(ws, {
      type: 'INVALID_MOVE',
      code: 'NOT_YOUR_TURN',
      message: 'Sıra sende değil.',
    });
    return;
  }

  const player = room.players[ws.id];
  const opponentId = Object.keys(room.players).find((id) => id !== ws.id);
  const opponent = room.players[opponentId];
  if (!player || !opponent) return;

  if (player.pendingFlipCount > 0 && data.action !== 'FLIP_OPPONENT_SLOT') {
    safeSend(ws, {
      type: 'INVALID_MOVE',
      code: 'MUST_SELECT_OPPONENT_CARD',
      message: `Önce rakibin ${player.pendingFlipCount} açık kartını seçmelisin!`,
    });
    return;
  }

  switch (data.action) {
    case 'DRAW_CARD': {
      if (player.heldCard !== null) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'ALREADY_HOLDING_CARD',
          message: 'Önce elindeki kartı tamamlamalısın.',
        });
        return;
      }

      const drawnCard = drawSmartCard(room, player, opponent);
      player.heldCard = drawnCard;
      player.placedThisTurn = false;
      console.log(`[DRAW] ${player.name} çekti: ${drawnCard.type} ${drawnCard.color} ${drawnCard.value} | Kalan: ${room.deck.length}`);

      broadcastRoomState(room, {
        kind: 'CARD_DRAWN',
        actorId: ws.id,
        card: drawnCard,
      });
      break;
    }

    case 'KEEP_SPECIAL_CARD': {
      const held = player.heldCard;
      if (!isSpecialCard(held)) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'NOT_SPECIAL_CARD',
          message: 'Sadece +1 ve +2 kartları elde tutulabilir.',
        });
        return;
      }

      if (player.savedSpecialCard) {
        room.discardPile.push(player.savedSpecialCard);
      }

      player.savedSpecialCard = held;
      player.heldCard = null;
      console.log(`[KEEP] ${player.name} ${held.type} kartını elde tuttu.`);

      broadcastRoomState(room, {
        kind: 'SPECIAL_KEPT',
        actorId: ws.id,
        card: held,
      });
      break;
    }

    case 'ACTIVATE_SPECIAL_CARD': {
      const source = data.source === 'SAVED' ? 'SAVED' : 'HELD';
      const card = source === 'SAVED' ? player.savedSpecialCard : player.heldCard;

      if (!isSpecialCard(card)) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'NO_SPECIAL_CARD',
          message: 'Kullanılacak +1 veya +2 kartın yok.',
        });
        return;
      }

      if (source === 'SAVED' && player.heldCard !== null) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'RESOLVE_HELD_FIRST',
          message: 'Önce ortadaki açık kartını oyna.',
        });
        return;
      }

      const oppOpenCount = opponent.slots.filter((s) => s.revealed).length;
      if (oppOpenCount === 0) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'NO_OPPONENT_OPEN_CARDS',
          message: 'Rakibin kapatılacak açık kartı yok!',
        });
        return;
      }

      const neededFlips = card.type === 'PLUS_TWO' ? 2 : 1;
      const actualFlips = Math.min(neededFlips, oppOpenCount);

      if (source === 'SAVED') {
        player.savedSpecialCard = null;
      } else {
        player.heldCard = null;
      }

      room.discardPile.push(card);
      player.pendingFlipCount = actualFlips;
      console.log(`[SPECIAL] ${player.name} ${card.type} oynadı! Kapatılacak kart: ${actualFlips}`);

      broadcastRoomState(room, {
        kind: 'SPECIAL_ACTIVATED',
        actorId: ws.id,
        card,
        remainingFlips: actualFlips,
      });
      break;
    }

    case 'FLIP_OPPONENT_SLOT': {
      if ((player.pendingFlipCount || 0) <= 0) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'NO_PENDING_FLIP',
          message: 'Şu an rakip kartı seçme hakkın yok.',
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

      const targetSlot = opponent.slots[targetSlotIndex - 1];
      if (!targetSlot || !targetSlot.revealed) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'SLOT_ALREADY_CLOSED',
          message: 'Bu kart zaten kapalı, açık bir kart seç!',
        });
        return;
      }

      if (targetSlot.card) {
        room.deck.push(targetSlot.card);
        shuffleArray(room.deck);
      }

      targetSlot.revealed = false;
      player.pendingFlipCount -= 1;

      const remainingOppOpen = opponent.slots.filter((s) => s.revealed).length;
      if (remainingOppOpen === 0) {
        player.pendingFlipCount = 0;
      }

      console.log(`[FLIP] ${player.name}, ${opponent.name}'in ${targetSlotIndex}. kartını kapattı. Kalan seçim: ${player.pendingFlipCount}`);

      broadcastRoomState(room, {
        kind: 'OPPONENT_CARD_FLIPPED',
        actorId: ws.id,
        targetPlayerId: opponentId,
        slotIndex: targetSlotIndex,
        remainingFlips: player.pendingFlipCount,
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

      if (held.type !== 'NUMBER') {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'SPECIAL_CANNOT_BE_PLACED',
          message: '+1 ve +2 kartları yuvaya konmaz; kullan veya elde tut.',
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
      player.placedThisTurn = true;
      player.dryStreak = 0;

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

      // Kart yuvaya yerleşince hamle süresi yeni açık kart için 15 sn olarak yenilenir
      scheduleTurnTimer(room, 0);

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

      if (isSpecialCard(held)) {
        safeSend(ws, {
          type: 'INVALID_MOVE',
          code: 'SPECIAL_CANNOT_DISCARD',
          message: '+1 veya +2 kartını kullanabilir ya da elde tutabilirsin.',
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

      if (!player.placedThisTurn) {
        player.dryStreak = (player.dryStreak || 0) + 1;
      } else {
        player.dryStreak = 0;
      }
      player.placedThisTurn = false;

      room.discardPile.push(held);
      player.heldCard = null;
      room.turnPlayerId = opponentId;

      scheduleTurnTimer(room, 0);

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
    if (room.turnTimer) clearTimeout(room.turnTimer);
    rooms.delete(room.roomId);
  }
}
