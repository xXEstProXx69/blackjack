// =============================================================
// BLACKJACK MULTIPLAYER SERVER
// Node.js + Socket.io + Express
// =============================================================
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'client')));

// ── Rooms ──────────────────────────────────────────────────
// rooms[code] = { code, gs, players, betTimerTimeout }
const rooms = {};

function makeCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms[c]);
  return c;
}

// ── Game State Factory ──────────────────────────────────────
function makeGs() {
  return {
    bets:          { 1:{main:0,pp:0,sp:0}, 2:{main:0,pp:0,sp:0}, 3:{main:0,pp:0,sp:0}, 4:{main:0,pp:0,sp:0}, 5:{main:0,pp:0,sp:0} },
    hands:         { dealer: [] },
    splitActive:   { 1:false, 2:false, 3:false, 4:false, 5:false },
    splitHandIndex:{ 1:0, 2:0, 3:0, 4:0, 5:0 },
    doubled:       { 1:false, 2:false, 3:false, 4:false, 5:false },
    deck:          [],
    gameStatus:    'idle',
    activeSeats:   [],         // string[] seats with a main bet
    seatOwners:    {},         // { [sid]: socketId }
    currentSeatIndex: 0,
    stoodSeats:    [],         // array (JSON-safe version of Set)
    insurance:     {},
    badges:        {},         // { [sid]: {cls, text}[] }
    sideBetWins:   {},         // { [sid]: { pp?: {mult,payout}, sp?: {mult,payout} } }
    bustSeats:     {},         // { [sid]: number } bust value
    roundSideBetWon: 0,
    betHistory:    [],         // [{ socketId, sid, type, amt, groupId }]
    lastRoundBets: {},         // { [socketId]: [{sid,type,amt}] }
    readyPlayers:  [],         // socketIds who clicked Deal
    betsLocked:    false,      // true once first player clicks Deal
  };
}

// ── Deck ────────────────────────────────────────────────────
function buildDeck() {
  const S = ['S','H','D','C'], V = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  let d = [];
  for (let n = 0; n < 6; n++) S.forEach(s => V.forEach(v => d.push({suit:s,value:v})));
  for (let i = d.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}

// ── Score ────────────────────────────────────────────────────
function score(hand) {
  if (!Array.isArray(hand) || hand.length === 0) return 0;
  let total = 0, aces = 0;
  for (const c of hand) {
    if (['J','Q','K'].includes(c.value)) total += 10;
    else if (c.value === 'A') { aces++; total += 11; }
    else total += parseInt(c.value) || 0;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function cardNum(c) {
  if (['J','Q','K'].includes(c.value)) return 10;
  if (c.value === 'A') return 11;
  return parseInt(c.value);
}

function suitColor(s) { return ['H','D'].includes(s) ? 'red' : 'black'; }

function cardRank(c) {
  const o = {'A':14,'K':13,'Q':12,'J':11,'10':10,'9':9,'8':8,'7':7,'6':6,'5':5,'4':4,'3':3,'2':2};
  return o[c.value] ?? 0;
}

function twentyOneThreePayout(cards) {
  const suits = cards.map(c => c.suit);
  const allSameSuit = suits.every(s => s === suits[0]);
  const isTrips = cards[0].value === cards[1].value && cards[1].value === cards[2].value;
  const ranks = cards.map(cardRank).sort((a,b) => a-b);
  const isSeq = (ranks[2]-ranks[1]===1 && ranks[1]-ranks[0]===1) ||
                JSON.stringify(ranks) === JSON.stringify([2,3,14]) ||
                JSON.stringify(ranks) === JSON.stringify([12,13,14]);
  const isFlush = allSameSuit;
  const isStraight = isSeq;
  if (isTrips && isFlush) return 100;
  if (isStraight && isFlush) return 40;
  if (isTrips) return 30;
  if (isStraight) return 10;
  if (isFlush) return 5;
  return 0;
}

// ── Broadcast ────────────────────────────────────────────────
function broadcast(code) {
  const room = rooms[code];
  if (!room) return;
  // Build per-player view (each client gets their own wallet info)
  const players = {};
  for (const [sid, p] of Object.entries(room.players)) {
    players[sid] = { name: p.name, wallet: p.wallet, totalBet: p.totalBet };
  }
  io.to(code).emit('stateUpdate', { gs: room.gs, players, code });
}

function broadcastToSocket(socketId, code) {
  const room = rooms[code];
  if (!room) return;
  const players = {};
  for (const [sid, p] of Object.entries(room.players)) {
    players[sid] = { name: p.name, wallet: p.wallet, totalBet: p.totalBet };
  }
  io.to(socketId).emit('stateUpdate', { gs: room.gs, players, code });
}

// ── Dealing helpers ──────────────────────────────────────────
function dealTo(gs, target) {
  const card = gs.deck.pop();
  if (!card) return;
  if (target === 'dealer') { gs.hands.dealer.push(card); return; }
  const sid = String(target);
  if (gs.splitActive[sid]) {
    gs.hands[sid]['hand'+(gs.splitHandIndex[sid]+1)].push(card);
  } else {
    if (!Array.isArray(gs.hands[sid])) gs.hands[sid] = [];
    gs.hands[sid].push(card);
  }
}

function initHandsForSeats(gs) {
  for (const sid of gs.activeSeats) {
    gs.hands[sid] = [];
    gs.splitActive[sid] = false;
    gs.splitHandIndex[sid] = 0;
    gs.doubled[sid] = false;
  }
}

// ── Bet Timer ────────────────────────────────────────────────
function startBetTimer(code) {
  const room = rooms[code];
  if (!room || room.betTimerTimeout) return;
  room.betTimerSecsLeft = 15;
  room.betTimerTimeout = setInterval(() => {
    room.betTimerSecsLeft--;
    io.to(code).emit('timerTick', room.betTimerSecsLeft);
    if (room.betTimerSecsLeft <= 0) {
      clearInterval(room.betTimerTimeout);
      room.betTimerTimeout = null;
      if (room.gs.activeSeats.length > 0) {
        startDeal(code);
      }
    }
  }, 1000);
}

function cancelBetTimer(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.betTimerTimeout) { clearInterval(room.betTimerTimeout); room.betTimerTimeout = null; }
  io.to(code).emit('timerCancel');
}

// ── Side Bets ────────────────────────────────────────────────
function resolveSideBets(code) {
  const room = rooms[code];
  const { gs, players } = room;
  gs.roundSideBetWon = 0;
  const dUp = gs.hands.dealer[0];

  for (const sid of gs.activeSeats) {
    const hand = Array.isArray(gs.hands[sid]) ? gs.hands[sid] : [];
    if (hand.length < 2) continue;
    const ownerId = gs.seatOwners[sid];
    const player  = players[ownerId];
    if (!player) continue;

    if (gs.bets[sid].pp > 0) {
      const [c1, c2] = hand;
      if (c1.value === c2.value) {
        const sameSuit  = c1.suit === c2.suit;
        const sameColor = suitColor(c1.suit) === suitColor(c2.suit);
        const mult = sameSuit ? 25 : sameColor ? 12 : 6;
        const payout = gs.bets[sid].pp * (mult + 1);
        player.wallet += payout;
        gs.roundSideBetWon += payout;
        if (!gs.sideBetWins[sid]) gs.sideBetWins[sid] = {};
        gs.sideBetWins[sid].pp = { mult, payout };
      }
    }

    if (gs.bets[sid].sp > 0 && dUp) {
      const mult = twentyOneThreePayout([hand[0], hand[1], dUp]);
      if (mult > 0) {
        const payout = gs.bets[sid].sp * (mult + 1);
        player.wallet += payout;
        gs.roundSideBetWon += payout;
        if (!gs.sideBetWins[sid]) gs.sideBetWins[sid] = {};
        gs.sideBetWins[sid].sp = { mult, payout };
      }
    }
  }
}

// ── Check BJ ────────────────────────────────────────────────
function checkBJ(code) {
  const room = rooms[code];
  const { gs, players } = room;

  // If dealer's up-card is an Ace, offer insurance first
  // (up-card is index 0; hole card is index 1, still hidden)
  const dealerUpCard = gs.hands.dealer[0];
  if (dealerUpCard && dealerUpCard.value === 'A' && !gs.insurancePhase && !gs.insuranceResponses) {
    offerInsurance(code);
    return; // checkBJ will be called again after all players respond
  }

  const dBJ = score(gs.hands.dealer) === 21 && gs.hands.dealer.length === 2;

  if (dBJ) {
    // Resolve insurance, then end round
    for (const sid of gs.activeSeats) {
      const ownerId = gs.seatOwners[sid];
      const player  = players[ownerId];
      if (!player) continue;
      const ins = gs.insurance[sid] || 0;
      if (ins > 0) { player.wallet += ins * 3; }
    }
    // Pay player BJs (push), lose everyone else
    resolveMain(code, true);
    return;
  }
  // No dealer BJ — pay player BJs
  for (const sid of gs.activeSeats) {
    const pBJ = score(gs.hands[sid]) === 21 && Array.isArray(gs.hands[sid]) && gs.hands[sid].length === 2;
    if (pBJ) {
      const ownerId = gs.seatOwners[sid];
      const player  = players[ownerId];
      if (player) {
        const payout = Math.floor(gs.bets[sid].main * 2.5);
        player.wallet += payout;
        gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'bj', text:'Blackjack!' }];
      }
    }
  }
  broadcast(code);
  // Start play
  gs.gameStatus = 'playing';
  gs.currentSeatIndex = 0;
  advancePlay(code);
}

// ── Play ─────────────────────────────────────────────────────
function advancePlay(code) {
  const room = rooms[code];
  const { gs } = room;
  const rtl = [...gs.activeSeats].map(Number).sort((a,b)=>b-a).map(String);

  // Skip BJ seats
  while (gs.currentSeatIndex < rtl.length) {
    const sid = rtl[gs.currentSeatIndex];
    const hasBJ = (gs.badges[sid]||[]).some(b => b.cls === 'bj');
    if (!hasBJ) break;
    gs.currentSeatIndex++;
  }

  if (gs.currentSeatIndex >= rtl.length) {
    // All done — dealer turn
    dealerTurn(code);
    return;
  }

  const sid = rtl[gs.currentSeatIndex];
  gs.gameStatus = 'playing';
  io.to(code).emit('yourTurn', { sid, ownerId: gs.seatOwners[sid] });
  broadcast(code);
}

function playerBust(code, sid) {
  const room = rooms[code];
  const { gs } = room;
  const hk = gs.splitActive[sid] ? 'hand'+(gs.splitHandIndex[sid]+1) : null;
  const bustHand = hk ? gs.hands[sid][hk] : gs.hands[sid];
  const val = score(bustHand);
  gs.bustSeats[sid] = val;
  broadcast(code);

  setTimeout(() => {
    if (gs.splitActive[sid] && gs.splitHandIndex[sid] === 0) {
      gs.splitHandIndex[sid] = 1;
      broadcast(code);
      const rtl = [...gs.activeSeats].map(Number).sort((a,b)=>b-a).map(String);
      const sid2 = rtl[gs.currentSeatIndex];
      io.to(code).emit('yourTurn', { sid: sid2, ownerId: gs.seatOwners[sid2] });
    } else {
      gs.currentSeatIndex++;
      advancePlay(code);
    }
  }, 1200);
}

// ── Dealer Turn ───────────────────────────────────────────────
function dealerTurn(code) {
  const room = rooms[code];
  const { gs } = room;
  gs.gameStatus = 'dealer_turn';
  gs.hands.dealer[1] = gs.hands.dealer[1]; // reveal hole card
  gs.dealerRevealed = true;
  broadcast(code);

  function dealerStep() {
    const ds = score(gs.hands.dealer);
    if (ds < 17) {
      dealTo(gs, 'dealer');
      broadcast(code);
      setTimeout(dealerStep, 700);
    } else {
      resolveMain(code, false);
    }
  }
  setTimeout(dealerStep, 800);
}

// ── Resolve Main ─────────────────────────────────────────────
function resolveMain(code, dealerBJ) {
  const room = rooms[code];
  const { gs, players } = room;
  const ds = score(gs.hands.dealer);
  const dBust = ds > 21;
  let totalWon = 0;

  for (const sid of gs.activeSeats) {
    const ownerId = gs.seatOwners[sid];
    const player  = players[ownerId];
    if (!player) continue;

    const hasBJ = (gs.badges[sid]||[]).some(b => b.cls === 'bj');
    if (hasBJ) {
      if (dealerBJ) {
        // Push — return stake
        player.wallet += gs.bets[sid].main;
        totalWon += gs.bets[sid].main;
        gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'push', text:'Push' }];
      } else {
        totalWon += Math.floor(gs.bets[sid].main * 2.5);
      }
      continue;
    }

    if (gs.splitActive[sid]) {
      const half = Math.floor(gs.bets[sid].main / 2);
      for (const hk of ['hand1','hand2']) {
        const ps = score(gs.hands[sid][hk]);
        if (ps > 21) { gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'lose', text:'Bust' }]; continue; }
        if (dealerBJ) { gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'lose', text:'Lose' }]; continue; }
        if (dBust || ps > ds) {
          player.wallet += half*2; totalWon += half*2;
          gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'win', text:'Win' }];
        } else if (ps === ds) {
          player.wallet += half; totalWon += half;
          gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'push', text:'Push' }];
        } else {
          gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'lose', text:'Lose' }];
        }
      }
    } else {
      const ps = score(Array.isArray(gs.hands[sid]) ? gs.hands[sid] : []);
      if (ps > 21) { gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'lose', text:'Bust' }]; continue; }
      if (dealerBJ) { gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'lose', text:'Lose' }]; continue; }
      if (dBust || ps > ds) {
        const payout = gs.bets[sid].main * 2;
        player.wallet += payout; totalWon += payout;
        gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'win', text:'Win!' }];
      } else if (ps === ds) {
        player.wallet += gs.bets[sid].main; totalWon += gs.bets[sid].main;
        gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'push', text:'Push' }];
      } else {
        gs.badges[sid] = [...(gs.badges[sid]||[]), { cls:'lose', text:'Lose' }];
      }
    }
  }

  const grand = totalWon + gs.roundSideBetWon;
  gs.gameStatus = 'game_over';
  gs.grandTotal  = grand;
  broadcast(code);

  // Schedule new round
  setTimeout(() => newRound(code), 4000);
}

// ── New Round ────────────────────────────────────────────────
function newRound(code) {
  const room = rooms[code];
  if (!room) return;
  const { gs } = room;

  // Save last round bets per player
  const byPlayer = {};
  for (const entry of gs.betHistory) {
    if (!byPlayer[entry.socketId]) byPlayer[entry.socketId] = [];
    byPlayer[entry.socketId].push({ sid: entry.sid, type: entry.type, amt: entry.amt });
  }
  gs.lastRoundBets = byPlayer;

  // Reset
  const savedOwners = { ...gs.seatOwners };
  Object.assign(gs, makeGs());
  gs.seatOwners  = savedOwners;
  gs.gameStatus  = 'betting';
  gs.deck        = buildDeck();
  gs.lastRoundBets = byPlayer;

  // Reset per-player totalBet
  for (const p of Object.values(room.players)) p.totalBet = 0;

  broadcast(code);
}

// ── Deal ─────────────────────────────────────────────────────
async function startDeal(code) {
  cancelBetTimer(code);
  const room = rooms[code];
  const { gs } = room;

  if (gs.activeSeats.length === 0) return;
  gs.gameStatus = 'dealing';
  gs.deck = buildDeck();
  initHandsForSeats(gs);
  gs.sideBetWins = {};
  gs.badges      = {};
  gs.bustSeats   = {};
  gs.grandTotal  = null;
  gs.dealerRevealed = false;

  const rtl = [...gs.activeSeats].map(Number).sort((a,b)=>b-a).map(String);

  // Round 1 — player cards + dealer up
  for (const sid of rtl) { dealTo(gs, sid); broadcast(code); await delay(300); }
  dealTo(gs, 'dealer'); broadcast(code); await delay(300);
  // Round 2 — player cards + dealer hole (hidden)
  for (const sid of rtl) { dealTo(gs, sid); broadcast(code); await delay(300); }
  dealTo(gs, 'dealer'); broadcast(code); await delay(300);

  resolveSideBets(code);
  broadcast(code);
  await delay(300);
  checkBJ(code);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Insurance ────────────────────────────────────────────────
function offerInsurance(code) {
  const room = rooms[code];
  const { gs } = room;
  gs.insurancePhase = true;
  gs.insuranceResponses = {};
  broadcast(code);
  io.to(code).emit('insuranceOffer');
}

// ── Socket.io ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // ── Create Room
  socket.on('createRoom', ({ name, wallet }) => {
    const code = makeCode();
    rooms[code] = {
      code,
      gs: makeGs(),
      players: {},
      betTimerTimeout: null,
    };
    rooms[code].gs.gameStatus = 'betting';
    rooms[code].gs.deck = buildDeck();
    rooms[code].players[socket.id] = { name, wallet: wallet || 5000, totalBet: 0 };
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;
    socket.emit('roomJoined', { code, socketId: socket.id });
    broadcast(code);
    console.log(`Room ${code} created by ${name}`);
  });

  // ── Join Room
  socket.on('joinRoom', ({ code, name, wallet }) => {
    const room = rooms[code];
    if (!room) { socket.emit('roomError', 'Room not found'); return; }
    if (Object.keys(room.players).length >= 5) { socket.emit('roomError', 'Room is full'); return; }
    room.players[socket.id] = { name, wallet: wallet || 5000, totalBet: 0 };
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;
    socket.emit('roomJoined', { code, socketId: socket.id });
    broadcast(code);
    console.log(`${name} joined room ${code}`);
  });

  // ── Claim Seat
  socket.on('claimSeat', ({ sid }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs } = room;
    if (gs.gameStatus !== 'betting' && gs.gameStatus !== 'idle') return;
    if (gs.seatOwners[sid]) return; // already claimed
    gs.seatOwners[sid] = socket.id;
    broadcast(code);
  });

  // ── Leave Seat
  socket.on('leaveSeat', ({ sid }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs, players } = room;
    if (gs.seatOwners[sid] !== socket.id) return;
    // Refund bets
    const player = players[socket.id];
    if (player) {
      player.wallet += gs.bets[sid].main + gs.bets[sid].pp + gs.bets[sid].sp;
      player.totalBet -= gs.bets[sid].main + gs.bets[sid].pp + gs.bets[sid].sp;
    }
    gs.bets[sid] = { main:0, pp:0, sp:0 };
    delete gs.seatOwners[sid];
    gs.activeSeats = gs.activeSeats.filter(s => s !== sid);
    broadcast(code);
  });

  // ── Place Bet
  socket.on('placeBet', ({ sid, type, amt }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs, players } = room;
    if (!['betting','idle'].includes(gs.gameStatus)) return;
    if (gs.seatOwners[sid] !== socket.id) return;

    const player = players[socket.id];
    if (!player || player.wallet < amt) return;

    const maxBet = type === 'main' ? 10000 : 2000;
    const current = gs.bets[sid][type] || 0;
    if (current >= maxBet) return;
    const allowed = Math.min(amt, maxBet - current);

    player.wallet   -= allowed;
    player.totalBet  = (player.totalBet || 0) + allowed;
    gs.bets[sid][type] += allowed;
    gs.gameStatus = 'betting';

    if (type === 'main' && !gs.activeSeats.includes(sid)) gs.activeSeats.push(sid);

    const groupId = 'grp_' + Date.now() + '_' + Math.random();
    gs.betHistory.push({ socketId: socket.id, sid, type, amt: allowed, groupId });

    // Mirror to other seats owned by same player
    const mySeats = Object.entries(gs.seatOwners)
      .filter(([s, id]) => id === socket.id && s !== sid)
      .map(([s]) => s);

    for (const other of mySeats) {
      const oMax = type === 'main' ? 10000 : 2000;
      const oCur = gs.bets[other][type] || 0;
      if (type === 'main' || gs.bets[other].main > 0) {
        if (oCur < oMax && player.wallet >= allowed) {
          player.wallet   -= allowed;
          player.totalBet += allowed;
          gs.bets[other][type] += allowed;
          if (type === 'main' && !gs.activeSeats.includes(other)) gs.activeSeats.push(other);
          gs.betHistory.push({ socketId: socket.id, sid: other, type, amt: allowed, groupId });
        }
      }
    }

    broadcast(code);
    if (!room.betTimerTimeout) startBetTimer(code);
  });

  // ── Undo Bet
  socket.on('undoBet', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs, players } = room;
    if (gs.betsLocked) return;  // bets locked once Deal is clicked
    const player = players[socket.id];
    if (!player) return;

    // Find last groupId for this player
    const mine = gs.betHistory.filter(e => e.socketId === socket.id);
    if (mine.length === 0) return;
    const lastGroup = mine[mine.length-1].groupId;
    const toRemove  = gs.betHistory.filter(e => e.groupId === lastGroup);

    for (const e of toRemove) {
      gs.bets[e.sid][e.type] = Math.max(0, gs.bets[e.sid][e.type] - e.amt);
      player.wallet   += e.amt;
      player.totalBet  = Math.max(0, player.totalBet - e.amt);
      if (gs.bets[e.sid].main === 0) {
        gs.activeSeats = gs.activeSeats.filter(s => s !== e.sid);
      }
    }
    gs.betHistory = gs.betHistory.filter(e => e.groupId !== lastGroup);
    broadcast(code);
  });

  // ── Clear Bets
  socket.on('clearBets', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs, players } = room;
    if (gs.betsLocked) return;  // bets locked once Deal is clicked
    const player = players[socket.id];
    if (!player) return;

    const mine = gs.betHistory.filter(e => e.socketId === socket.id);
    for (const e of mine) {
      gs.bets[e.sid][e.type] = Math.max(0, gs.bets[e.sid][e.type] - e.amt);
      player.wallet   += e.amt;
      player.totalBet  = Math.max(0, player.totalBet - e.amt);
    }
    gs.betHistory = gs.betHistory.filter(e => e.socketId !== socket.id);
    // Remove from activeSeats if no main bet left
    for (const sid of [...gs.activeSeats]) {
      if (gs.bets[sid].main === 0) gs.activeSeats = gs.activeSeats.filter(s => s !== sid);
    }
    broadcast(code);
  });

  // ── Rebet
  socket.on('rebet', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs, players } = room;
    if (gs.betsLocked) return;  // bets locked once Deal is clicked
    const player = players[socket.id];
    if (!player) return;

    const last = gs.lastRoundBets[socket.id] || [];
    for (const e of last) {
      const maxBet = e.type === 'main' ? 10000 : 2000;
      const cur    = gs.bets[e.sid][e.type] || 0;
      if (cur >= maxBet || player.wallet < e.amt) continue;
      const allowed = Math.min(e.amt, maxBet - cur);
      player.wallet   -= allowed;
      player.totalBet += allowed;
      gs.bets[e.sid][e.type] += allowed;
      if (e.type === 'main' && !gs.activeSeats.includes(e.sid)) gs.activeSeats.push(e.sid);
      gs.betHistory.push({ socketId: socket.id, sid: e.sid, type: e.type, amt: allowed, groupId: 'rebet_'+Date.now() });
    }
    broadcast(code);
    if (gs.activeSeats.length > 0 && !room.betTimerTimeout) startBetTimer(code);
  });

  // ── Double bets
  socket.on('doubleBets', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs, players } = room;
    if (gs.betsLocked) return;  // bets locked once Deal is clicked
    const player = players[socket.id];
    if (!player) return;

    const mine = gs.betHistory.filter(e => e.socketId === socket.id);
    for (const e of mine) {
      const maxBet = e.type === 'main' ? 10000 : 2000;
      const cur    = gs.bets[e.sid][e.type];
      const add    = Math.min(e.amt, maxBet - cur);
      if (player.wallet < add || add <= 0) continue;
      player.wallet   -= add;
      player.totalBet += add;
      gs.bets[e.sid][e.type] += add;
      gs.betHistory.push({ socketId: socket.id, sid: e.sid, type: e.type, amt: add, groupId: '2x_'+Date.now() });
    }
    broadcast(code);
  });

  // ── Deal
  socket.on('deal', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.gs.gameStatus !== 'betting') return;
    const { gs } = room;
    if (gs.activeSeats.length === 0) return;

    // Only players who have an active bet seat can vote to deal
    const playersWithBets = new Set(
      gs.activeSeats.map(sid => gs.seatOwners[sid]).filter(Boolean)
    );
    if (!playersWithBets.has(socket.id)) return;

    // Lock bets the moment the first player clicks Deal
    if (!gs.betsLocked) {
      gs.betsLocked = true;
      cancelBetTimer(code);
      broadcast(code);
    }

    if (!gs.readyPlayers.includes(socket.id)) {
      gs.readyPlayers.push(socket.id);
    }

    // Notify everyone how many have readied up
    io.to(code).emit('dealVote', {
      ready: gs.readyPlayers.length,
      needed: playersWithBets.size,
      readyIds: gs.readyPlayers,
    });

    // All players with bets have voted — start deal
    if ([...playersWithBets].every(id => gs.readyPlayers.includes(id))) {
      startDeal(code);
    }
  });

  // ── Player Action
  socket.on('action', ({ action, sid }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs, players } = room;
    if (gs.gameStatus !== 'playing') return;

    const rtl = [...gs.activeSeats].map(Number).sort((a,b)=>b-a).map(String);
    const currentSid = rtl[gs.currentSeatIndex];
    if (currentSid !== sid) return;
    if (gs.seatOwners[sid] !== socket.id) return;

    const player = players[socket.id];

    if (action === 'hit') {
      dealTo(gs, sid);
      const hand = gs.splitActive[sid] ? gs.hands[sid]['hand'+(gs.splitHandIndex[sid]+1)] : gs.hands[sid];
      const sc   = score(hand);
      broadcast(code);
      if (sc > 21) { playerBust(code, sid); return; }
      if (sc === 21) { advanceSeat(code, sid); return; }
      // Stays on seat for more actions
      io.to(code).emit('yourTurn', { sid, ownerId: gs.seatOwners[sid] });

    } else if (action === 'stand') {
      advanceSeat(code, sid);

    } else if (action === 'double') {
      if (player && player.wallet >= gs.bets[sid].main) {
        const extra = gs.bets[sid].main;
        player.wallet   -= extra;
        player.totalBet += extra;
        gs.bets[sid].main *= 2;
        gs.doubled[sid] = true;
        dealTo(gs, sid);
        broadcast(code);
        advanceSeat(code, sid);
      }

    } else if (action === 'split') {
      const hand = gs.hands[sid];
      if (!Array.isArray(hand) || hand.length !== 2) return;
      if (!player || player.wallet < gs.bets[sid].main) return;
      player.wallet   -= gs.bets[sid].main;
      player.totalBet += gs.bets[sid].main;
      const [c1, c2] = hand;
      const n1 = gs.deck.pop(), n2 = gs.deck.pop();
      gs.hands[sid] = { hand1: [c1, n1], hand2: [c2, n2] };
      gs.splitActive[sid]    = true;
      gs.splitHandIndex[sid] = 0;
      broadcast(code);
      io.to(code).emit('yourTurn', { sid, ownerId: gs.seatOwners[sid] });
    }
  });

  // ── Insurance response
  socket.on('insuranceResponse', ({ choices }) => {
    // choices: { [sid]: bool }
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs, players } = room;
    const player = players[socket.id];

    for (const [sid, insure] of Object.entries(choices)) {
      if (gs.seatOwners[sid] !== socket.id) continue;
      if (insure) {
        const cost = Math.floor(gs.bets[sid].main / 2);
        if (player && player.wallet >= cost) {
          player.wallet   -= cost;
          player.totalBet += cost;
          gs.insurance[sid] = cost;
        }
      }
    }
    gs.insuranceResponses[socket.id] = true;
    // Check if all players responded
    const needResponse = new Set(Object.values(gs.seatOwners));
    const responded    = new Set(Object.keys(gs.insuranceResponses));
    const allDone = [...needResponse].every(id => responded.has(id));
    if (allDone) {
      gs.insurancePhase = false;
      broadcast(code);
      checkBJ(code);
    } else {
      broadcast(code);
    }
  });

  // ── Disconnect
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    delete room.players[socket.id];
    // Free their seats
    for (const [sid, ownerId] of Object.entries(room.gs.seatOwners)) {
      if (ownerId === socket.id) {
        delete room.gs.seatOwners[sid];
        room.gs.activeSeats = room.gs.activeSeats.filter(s => s !== sid);
        room.gs.bets[sid] = { main:0, pp:0, sp:0 };
      }
    }
    if (Object.keys(room.players).length === 0) {
      if (room.betTimerTimeout) clearInterval(room.betTimerTimeout);
      delete rooms[code];
      console.log(`Room ${code} deleted (empty)`);
    } else {
      broadcast(code);
    }
  });
});

function advanceSeat(code, sid) {
  const room = rooms[code];
  if (!room) return;
  const { gs } = room;
  if (gs.splitActive[sid] && gs.splitHandIndex[sid] === 0) {
    gs.splitHandIndex[sid] = 1;
    broadcast(code);
    const rtl = [...gs.activeSeats].map(Number).sort((a,b)=>b-a).map(String);
    io.to(code).emit('yourTurn', { sid, ownerId: gs.seatOwners[sid] });
    return;
  }
  gs.stoodSeats.push(sid);
  gs.currentSeatIndex++;
  advancePlay(code);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Blackjack server on :${PORT}`));
