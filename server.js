// =============================================================
// BLACKJACK MULTIPLAYER SERVER
// =============================================================
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'client')));

const rooms = {};

function makeCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms[c]);
  return c;
}

function makeGs() {
  return {
    bets:           { 1:{main:0,pp:0,sp:0}, 2:{main:0,pp:0,sp:0}, 3:{main:0,pp:0,sp:0}, 4:{main:0,pp:0,sp:0}, 5:{main:0,pp:0,sp:0} },
    hands:          { dealer: [] },
    splitActive:    { 1:false, 2:false, 3:false, 4:false, 5:false },
    splitHandIndex: { 1:0, 2:0, 3:0, 4:0, 5:0 },
    splitBets:      { 1:0, 2:0, 3:0, 4:0, 5:0 },
    doubled:        { 1:false, 2:false, 3:false, 4:false, 5:false },
    deck:           [],
    gameStatus:     'idle',
    activeSeats:    [],
    seatOwners:     {},
    currentSeatIndex: 0,
    stoodSeats:     [],
    insurance:      {},
    badges:         {},
    sideBetWins:    {},
    bustSeats:      {},
    roundSideBetWon: 0,
    betHistory:     [],
    lastRoundBets:  {},
    readyPlayers:   [],
    betsLocked:     false,
    dealerRevealed: false,
    insurancePhase: false,
    insuranceResponses: null,
    insuredSeats: [],
    grandTotal:     null,
  };
}

function buildDeck() {
  const S = ['S','H','D','C'], V = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  let d = [];
  for (let n = 0; n < 6; n++) S.forEach(s => V.forEach(v => d.push({suit:s,value:v})));
  for (let i = d.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}

function score(hand) {
  if (!Array.isArray(hand) || !hand.length) return 0;
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
  if (isTrips && allSameSuit) return 100;
  if (isSeq && allSameSuit) return 40;
  if (isTrips) return 30;
  if (isSeq) return 10;
  if (allSameSuit) return 5;
  return 0;
}

function broadcast(code) {
  const room = rooms[code];
  if (!room) return;
  const players = {};
  for (const [sid, p] of Object.entries(room.players)) {
    players[sid] = { name: p.name, wallet: p.wallet, totalBet: p.totalBet, isHost: p.isHost };
  }
  io.to(code).emit('stateUpdate', { gs: room.gs, players, code, hostId: room.hostId });
}

function dealTo(gs, target) {
  const card = gs.deck.pop();
  if (!card) return;
  if (target === 'dealer') { gs.hands.dealer.push(card); return; }
  const sid = String(target);
  if (gs.splitActive[sid]) {
    const hk = 'hand' + (gs.splitHandIndex[sid] + 1);
    gs.hands[sid][hk].push(card);
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
    gs.splitBets[sid] = 0;
    gs.doubled[sid] = false;
  }
}

function startBetTimer(code) {
  const room = rooms[code];
  if (!room || room.betTimerTimeout) return;
  room.betTimerSecsLeft = 15;
  room.betTimerTimeout = setInterval(() => {
    // Cancel immediately if no bets at all
    const hasBets = room.gs.activeSeats.some(sid => (room.gs.bets[sid]?.main||0) > 0);
    if (!hasBets) {
      clearInterval(room.betTimerTimeout);
      room.betTimerTimeout = null;
      io.to(code).emit('timerCancel');
      return;
    }
    room.betTimerSecsLeft--;
    io.to(code).emit('timerTick', room.betTimerSecsLeft);
    if (room.betTimerSecsLeft <= 0) {
      clearInterval(room.betTimerTimeout);
      room.betTimerTimeout = null;
      startDeal(code);
    }
  }, 1000);
}

function cancelBetTimer(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.betTimerTimeout) { clearInterval(room.betTimerTimeout); room.betTimerTimeout = null; }
  io.to(code).emit('timerCancel');
}

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

function offerInsurance(code) {
  const room = rooms[code];
  const { gs } = room;
  gs.insurancePhase = true;
  gs.insuranceResponses = {};

  // Helper: does this seat have blackjack?
  const hasBJ = (sid) => {
    const hand = gs.hands[sid];
    return Array.isArray(hand) && hand.length === 2 && score(hand) === 21;
  };

  // Build per-seat queue: skip seats that already have BJ
  const eligibleSeats = Object.entries(gs.seatOwners)
    .filter(([sid]) => (gs.bets[sid]?.main || 0) > 0 && !hasBJ(sid))
    .sort(([a],[b]) => Number(b) - Number(a))
    .map(([sid, ownerId]) => ({ sid, ownerId }));

  // 1v1 special case: if there's only one active seat and it has BJ → skip insurance entirely
  if (gs.activeSeats.length === 1 && hasBJ(gs.activeSeats[0])) {
    gs.insurancePhase = false;
    broadcast(code);
    checkBJ(code);
    return;
  }

  gs.insuranceQueue = eligibleSeats;
  gs.insuranceQueueIndex = 0;
  broadcast(code);
  advanceInsuranceQueue(code);
}

function advanceInsuranceQueue(code) {
  const room = rooms[code];
  const { gs } = room;
  if (!gs.insuranceQueue || gs.insuranceQueueIndex >= gs.insuranceQueue.length) {
    // All seats done
    gs.insurancePhase = false;
    broadcast(code);
    checkBJ(code);
    return;
  }
  const { sid, ownerId } = gs.insuranceQueue[gs.insuranceQueueIndex];
  gs.insuranceCurrentSid = sid;
  broadcast(code);
  // Emit to the owner of this seat
  io.to(ownerId).emit('insuranceOfferSeat', {
    sid,
    cost: Math.floor((gs.bets[sid]?.main || 0) / 2),
  });
}

function checkBJ(code) {
  const room = rooms[code];
  const { gs, players } = room;

  const dBJ = score(gs.hands.dealer) === 21 && gs.hands.dealer.length === 2;

  if (dBJ) {
    for (const sid of gs.activeSeats) {
      const ins = gs.insurance[sid] || 0;
      if (ins > 0) {
        const player = players[gs.seatOwners[sid]];
        if (player) player.wallet += ins * 3;
      }
    }
    resolveMain(code, true);
    return;
  }

  for (const sid of gs.activeSeats) {
    const hand = gs.hands[sid];
    const pBJ  = Array.isArray(hand) && hand.length === 2 && score(hand) === 21;
    if (pBJ) {
      const player = players[gs.seatOwners[sid]];
      if (player) {
        player.wallet += Math.floor(gs.bets[sid].main * 2.5);
        if (!gs.badges[sid]) gs.badges[sid] = [];
        gs.badges[sid].push({ cls:'bj', text:'Blackjack!' });
      }
    }
  }

  broadcast(code);
  gs.gameStatus = 'playing';
  gs.currentSeatIndex = 0;
  advancePlay(code);
}

function rtlOrder(gs) {
  return [...gs.activeSeats].map(Number).sort((a,b)=>b-a).map(String);
}

function advancePlay(code) {
  const room = rooms[code];
  const { gs } = room;
  const rtl = rtlOrder(gs);

  while (gs.currentSeatIndex < rtl.length) {
    const sid = rtl[gs.currentSeatIndex];
    if (!(gs.badges[sid]||[]).some(b => b.cls === 'bj')) break;
    gs.currentSeatIndex++;
  }

  if (gs.currentSeatIndex >= rtl.length) {
    dealerTurn(code);
    return;
  }

  const sid = rtl[gs.currentSeatIndex];
  gs.gameStatus = 'playing';
  io.to(code).emit('yourTurn', { sid, handIdx: gs.splitHandIndex[sid]||0, ownerId: gs.seatOwners[sid] });
  broadcast(code);
}

function playerBust(code, sid) {
  const room = rooms[code];
  const { gs } = room;
  const hk       = gs.splitActive[sid] ? 'hand'+(gs.splitHandIndex[sid]+1) : null;
  const bustHand = hk ? gs.hands[sid][hk] : gs.hands[sid];
  if (!gs.bustSeats) gs.bustSeats = {};
  gs.bustSeats[sid + (hk ? '_'+hk : '')] = score(bustHand);
  broadcast(code);

  setTimeout(() => {
    if (gs.splitActive[sid] && gs.splitHandIndex[sid] === 0) {
      gs.splitHandIndex[sid] = 1;
      broadcast(code);
      io.to(code).emit('yourTurn', { sid, handIdx: 1, ownerId: gs.seatOwners[sid] });
    } else {
      gs.currentSeatIndex++;
      advancePlay(code);
    }
  }, 1200);
}

function dealerTurn(code) {
  const room = rooms[code];
  const { gs } = room;
  // 2.5s pause before dealer reveals — lets players see the outcome
  gs.gameStatus = 'dealer_turn';
  broadcast(code); // status change but NOT revealed yet
  setTimeout(() => {
    gs.dealerRevealed = true;
    broadcast(code);
    function dealerStep() {
    if (score(gs.hands.dealer) < 17) {
      dealTo(gs, 'dealer');
      broadcast(code);
      setTimeout(dealerStep, 700);
    } else {
      resolveMain(code, false);
    }
    }
    setTimeout(dealerStep, 800);
  }, 2500);
}

function resolveMain(code, dealerBJ) {
  const room = rooms[code];
  const { gs, players } = room;
  const ds    = score(gs.hands.dealer);
  const dBust = ds > 21;
  let totalWon = 0;

  if (!gs.badges) gs.badges = {};

  for (const sid of gs.activeSeats) {
    const player = players[gs.seatOwners[sid]];
    if (!player) continue;
    if (!gs.badges[sid]) gs.badges[sid] = [];

    const hasBJ = gs.badges[sid].some(b => b.cls === 'bj');
    if (hasBJ) {
      if (dealerBJ) {
        player.wallet += gs.bets[sid].main;
        totalWon += gs.bets[sid].main;
        gs.badges[sid].push({ cls:'push', text:'Push' });
      } else {
        totalWon += Math.floor(gs.bets[sid].main * 2.5);
      }
      continue;
    }

    if (gs.splitActive[sid]) {
      const mainBet  = gs.bets[sid].main;
      const splitBet = gs.splitBets[sid] || mainBet;
      const bets     = { hand1: mainBet, hand2: splitBet };

      for (const hk of ['hand1','hand2']) {
        const ps = score(gs.hands[sid][hk] || []);
        if (ps > 21) { gs.badges[sid].push({ cls:'lose', text:'Bust' }); continue; }
        if (dealerBJ) { gs.badges[sid].push({ cls:'lose', text:'Lose' }); continue; }
        if (dBust || ps > ds) {
          player.wallet += bets[hk]*2; totalWon += bets[hk]*2;
          gs.badges[sid].push({ cls:'win', text:'Win' });
        } else if (ps === ds) {
          player.wallet += bets[hk]; totalWon += bets[hk];
          gs.badges[sid].push({ cls:'push', text:'Push' });
        } else {
          gs.badges[sid].push({ cls:'lose', text:'Lose' });
        }
      }
    } else {
      const ps = score(Array.isArray(gs.hands[sid]) ? gs.hands[sid] : []);
      if (ps > 21) { gs.badges[sid].push({ cls:'lose', text:'Bust' }); continue; }
      if (dealerBJ) { gs.badges[sid].push({ cls:'lose', text:'Lose' }); continue; }
      if (dBust || ps > ds) {
        player.wallet += gs.bets[sid].main*2; totalWon += gs.bets[sid].main*2;
        gs.badges[sid].push({ cls:'win', text:'Win!' });
      } else if (ps === ds) {
        player.wallet += gs.bets[sid].main; totalWon += gs.bets[sid].main;
        gs.badges[sid].push({ cls:'push', text:'Push' });
      } else {
        gs.badges[sid].push({ cls:'lose', text:'Lose' });
      }
    }
  }

  gs.gameStatus = 'game_over';
  gs.grandTotal = totalWon + gs.roundSideBetWon;
  broadcast(code);
  setTimeout(() => newRound(code), 4000);
}

function newRound(code) {
  const room = rooms[code];
  if (!room) return;
  const { gs } = room;

  const byPlayer = {};
  for (const entry of gs.betHistory) {
    if (!byPlayer[entry.socketId]) byPlayer[entry.socketId] = [];
    byPlayer[entry.socketId].push({ sid: entry.sid, type: entry.type, amt: entry.amt });
  }

  const savedOwners = { ...gs.seatOwners };
  Object.assign(gs, makeGs());
  gs.seatOwners    = savedOwners;
  gs.gameStatus    = 'betting';
  gs.deck          = buildDeck();
  gs.lastRoundBets = byPlayer;

  for (const p of Object.values(room.players)) p.totalBet = 0;
  broadcast(code);
}

async function startDeal(code) {
  cancelBetTimer(code);
  const room = rooms[code];
  const { gs } = room;
  if (gs.activeSeats.length === 0) return;

  gs.gameStatus = 'dealing';
  gs.deck = buildDeck();
  initHandsForSeats(gs);
  gs.sideBetWins    = {};
  gs.badges         = {};
  gs.bustSeats      = {};
  gs.grandTotal     = null;
  gs.dealerRevealed = false;
  gs.insurancePhase = false;
  gs.insuranceResponses = null;
  gs.insurance      = {};
  gs.insuredSeats   = [];

  const rtl = rtlOrder(gs);

  for (const sid of rtl) { dealTo(gs, sid); broadcast(code); await delay(300); }
  dealTo(gs, 'dealer'); broadcast(code); await delay(300);
  for (const sid of rtl) { dealTo(gs, sid); broadcast(code); await delay(300); }
  dealTo(gs, 'dealer'); broadcast(code); await delay(500);

  resolveSideBets(code);
  broadcast(code);
  await delay(200);

  // Offer insurance if dealer shows Ace
  const upCard = gs.hands.dealer[0];
  if (upCard && upCard.value === 'A') {
    offerInsurance(code);
    return; // checkBJ called after all insurance responses
  }

  checkBJ(code);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function advanceSeat(code, sid) {
  const room = rooms[code];
  if (!room) return;
  const { gs } = room;

  if (gs.splitActive[sid] && gs.splitHandIndex[sid] === 0) {
    gs.splitHandIndex[sid] = 1;
    broadcast(code);
    io.to(code).emit('yourTurn', { sid, handIdx: 1, ownerId: gs.seatOwners[sid] });
    return;
  }

  if (!gs.stoodSeats.includes(sid)) gs.stoodSeats.push(sid);
  gs.currentSeatIndex++;
  advancePlay(code);
}

function assignNewHost(code) {
  const room = rooms[code];
  if (!room || !Object.keys(room.players).length) return;
  const playerIds = Object.keys(room.players);
  const newHostId = playerIds.reduce((best, id) =>
    room.players[id].joinOrder < room.players[best].joinOrder ? id : best
  , playerIds[0]);
  room.hostId = newHostId;
  for (const [id, p] of Object.entries(room.players)) p.isHost = (id === newHostId);
  io.to(code).emit('hostChanged', { hostId: newHostId });
  broadcast(code);
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, wallet, token }) => {
    const code = makeCode();
    rooms[code] = { code, gs: makeGs(), players: {}, betTimerTimeout: null, hostId: socket.id, joinCounter: 0, banList: new Set() };
    rooms[code].gs.gameStatus = 'betting';
    rooms[code].gs.deck = buildDeck();
    rooms[code].players[socket.id] = { name, wallet: wallet||5000, totalBet:0, isHost:true, joinOrder:0 };
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;
    socket.data.token = token || socket.id;
    socket.emit('roomJoined', { code, socketId: socket.id, isHost: true });
    broadcast(code);
  });

  socket.on('joinRoom', ({ code, name, wallet, token }) => {
    const room = rooms[code];
    if (!room) { socket.emit('roomError', 'Room not found'); return; }
    if (Object.keys(room.players).length >= 5) { socket.emit('roomError', 'Room is full'); return; }
    const playerToken = token || socket.id;
    if (room.banList && room.banList.has(playerToken)) {
      socket.emit('banned');
      return;
    }
    socket.data.token = playerToken;
    room.joinCounter = (room.joinCounter||0) + 1;
    room.players[socket.id] = { name, wallet: wallet||5000, totalBet:0, isHost:false, joinOrder: room.joinCounter };
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;
    socket.emit('roomJoined', { code, socketId: socket.id, isHost: false });
    broadcast(code);
    // Joining players auto-launch straight into the game
    io.to(socket.id).emit('autoLaunch');
  });

  socket.on('kickPlayer', ({ targetId }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (!['betting','idle'].includes(room.gs.gameStatus)) return;
    if (targetId === socket.id) return; // can't kick yourself
    const target = room.players[targetId];
    if (!target) return;
    // Free their seats
    for (const [sid, ownerId] of Object.entries(room.gs.seatOwners)) {
      if (ownerId === targetId) {
        delete room.gs.seatOwners[sid];
        room.gs.activeSeats = room.gs.activeSeats.filter(s => s !== sid);
        room.gs.bets[sid] = { main:0, pp:0, sp:0 };
      }
    }
    delete room.players[targetId];
    io.to(targetId).emit('kicked');
    broadcast(code);
  });

  socket.on('banPlayer', ({ targetId }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (!['betting','idle'].includes(room.gs.gameStatus)) return;
    if (targetId === socket.id) return;
    const target = room.players[targetId];
    if (!target) return;
    // Find the target's token from connected sockets
    const targetSocket = [...io.sockets.sockets.values()].find(s => s.id === targetId);
    const banToken = targetSocket?.data?.token || targetId;
    room.banList.add(banToken);
    // Also kick them now
    for (const [sid, ownerId] of Object.entries(room.gs.seatOwners)) {
      if (ownerId === targetId) {
        delete room.gs.seatOwners[sid];
        room.gs.activeSeats = room.gs.activeSeats.filter(s => s !== sid);
        room.gs.bets[sid] = { main:0, pp:0, sp:0 };
      }
    }
    delete room.players[targetId];
    io.to(targetId).emit('banned');
    broadcast(code);
  });

  socket.on('changeName', ({ name }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if(!room || !name) return;
    const player = room.players[socket.id];
    if(player) { player.name = name; socket.data.name = name; broadcast(code); }
  });

  socket.on('startGame', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    io.to(code).emit('gameLaunched');
  });

  socket.on('claimSeat', ({ sid }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs, players } = room;
    if (!['betting','idle'].includes(gs.gameStatus)) return;
    if (gs.seatOwners[sid]) return;
    gs.seatOwners[sid] = socket.id;

    // Mirror bets from any seat this player already owns
    const player = players[socket.id];
    const existingSeats = Object.entries(gs.seatOwners)
      .filter(([s, id]) => id === socket.id && s !== sid)
      .map(([s]) => s);
    if (existingSeats.length > 0 && player) {
      const srcSid = existingSeats[0]; // mirror from first owned seat
      for (const type of ['main', 'pp', 'sp']) {
        const amt = gs.bets[srcSid]?.[type] || 0;
        if (amt > 0 && player.wallet >= amt) {
          gs.bets[sid][type] = amt;
          player.wallet -= amt;
          player.totalBet += amt;
          gs.betHistory.push({ socketId: socket.id, sid, type, amt, groupId: 'mirror_'+Date.now() });
        }
      }
      if ((gs.bets[sid].main || 0) > 0 && !gs.activeSeats.includes(sid)) {
        gs.activeSeats.push(sid);
      }
    }

    broadcast(code);
  });

  socket.on('leaveSeat', ({ sid }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs, players } = room;
    if (gs.seatOwners[sid] !== socket.id) return;
    const player = players[socket.id];
    if (player) {
      const refund = gs.bets[sid].main + gs.bets[sid].pp + gs.bets[sid].sp;
      player.wallet   += refund;
      player.totalBet  = Math.max(0, player.totalBet - refund);
    }
    gs.bets[sid] = { main:0, pp:0, sp:0 };
    delete gs.seatOwners[sid];
    gs.activeSeats = gs.activeSeats.filter(s => s !== sid);
    gs.betHistory  = gs.betHistory.filter(e => !(e.sid === sid && e.socketId === socket.id));
    broadcast(code);
  });

  socket.on('placeBet', ({ sid, type, amt }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const { gs, players } = room;
    if (!['betting','idle'].includes(gs.gameStatus) || gs.betsLocked) return;
    if (gs.seatOwners[sid] !== socket.id) return;
    const player = players[socket.id];
    if (!player || player.wallet < amt) return;
    const maxBet = type === 'main' ? 10000 : 2000;
    const cur    = gs.bets[sid][type] || 0;
    if (cur >= maxBet) return;
    const allowed = Math.min(amt, maxBet - cur);
    player.wallet -= allowed; player.totalBet += allowed;
    gs.bets[sid][type] += allowed;
    gs.gameStatus = 'betting';
    if (type === 'main' && !gs.activeSeats.includes(sid)) gs.activeSeats.push(sid);
    const groupId = 'grp_' + Date.now() + '_' + Math.random();
    gs.betHistory.push({ socketId: socket.id, sid, type, amt: allowed, groupId });
    // Mirror
    const mySeats = Object.entries(gs.seatOwners).filter(([s,id]) => id === socket.id && s !== sid).map(([s])=>s);
    for (const other of mySeats) {
      const oCur = gs.bets[other][type] || 0;
      const oMax = type === 'main' ? 10000 : 2000;
      if ((type === 'main' || gs.bets[other].main > 0) && oCur < oMax && player.wallet >= allowed) {
        player.wallet -= allowed; player.totalBet += allowed;
        gs.bets[other][type] += allowed;
        if (type === 'main' && !gs.activeSeats.includes(other)) gs.activeSeats.push(other);
        gs.betHistory.push({ socketId: socket.id, sid: other, type, amt: allowed, groupId });
      }
    }
    broadcast(code);
    if (!room.betTimerTimeout) startBetTimer(code);
  });

  socket.on('undoBet', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.gs.betsLocked) return;
    const { gs, players } = room;
    const player = players[socket.id];
    if (!player) return;
    const mine = gs.betHistory.filter(e => e.socketId === socket.id);
    if (!mine.length) return;
    const lastGroup = mine[mine.length-1].groupId;
    for (const e of gs.betHistory.filter(e => e.groupId === lastGroup)) {
      gs.bets[e.sid][e.type] = Math.max(0, gs.bets[e.sid][e.type] - e.amt);
      player.wallet += e.amt; player.totalBet = Math.max(0, player.totalBet - e.amt);
      if (gs.bets[e.sid].main === 0) gs.activeSeats = gs.activeSeats.filter(s => s !== e.sid);
    }
    gs.betHistory = gs.betHistory.filter(e => e.groupId !== lastGroup);
    broadcast(code);
  });

  socket.on('clearBets', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.gs.betsLocked) return;
    const { gs, players } = room;
    const player = players[socket.id];
    if (!player) return;
    for (const e of gs.betHistory.filter(e => e.socketId === socket.id)) {
      gs.bets[e.sid][e.type] = Math.max(0, gs.bets[e.sid][e.type] - e.amt);
      player.wallet += e.amt; player.totalBet = Math.max(0, player.totalBet - e.amt);
    }
    gs.betHistory = gs.betHistory.filter(e => e.socketId !== socket.id);
    for (const sid of [...gs.activeSeats]) if (gs.bets[sid].main === 0) gs.activeSeats = gs.activeSeats.filter(s => s !== sid);
    broadcast(code);
  });

  socket.on('rebet', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.gs.betsLocked) return;
    const { gs, players } = room;
    const player = players[socket.id];
    if (!player) return;
    for (const e of gs.lastRoundBets[socket.id]||[]) {
      const maxBet = e.type === 'main' ? 10000 : 2000;
      const cur = gs.bets[e.sid][e.type] || 0;
      if (cur >= maxBet || player.wallet < e.amt) continue;
      const allowed = Math.min(e.amt, maxBet - cur);
      player.wallet -= allowed; player.totalBet += allowed;
      gs.bets[e.sid][e.type] += allowed;
      if (e.type === 'main' && !gs.activeSeats.includes(e.sid)) gs.activeSeats.push(e.sid);
      gs.betHistory.push({ socketId: socket.id, sid: e.sid, type: e.type, amt: allowed, groupId: 'rebet_'+Date.now() });
    }
    broadcast(code);
    if (gs.activeSeats.length > 0 && !room.betTimerTimeout) startBetTimer(code);
  });

  socket.on('doubleBets', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.gs.betsLocked) return;
    const { gs, players } = room;
    const player = players[socket.id];
    if (!player) return;
    for (const e of [...gs.betHistory.filter(e => e.socketId === socket.id)]) {
      const maxBet = e.type === 'main' ? 10000 : 2000;
      const cur = gs.bets[e.sid][e.type];
      const add = Math.min(e.amt, maxBet - cur);
      if (player.wallet < add || add <= 0) continue;
      player.wallet -= add; player.totalBet += add;
      gs.bets[e.sid][e.type] += add;
      gs.betHistory.push({ socketId: socket.id, sid: e.sid, type: e.type, amt: add, groupId: '2x_'+Date.now() });
    }
    broadcast(code);
  });

  socket.on('deal', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.gs.gameStatus !== 'betting') return;
    const { gs } = room;
    if (gs.activeSeats.length === 0) return;
    const playersWithBets = new Set(gs.activeSeats.map(sid => gs.seatOwners[sid]).filter(Boolean));
    if (!playersWithBets.has(socket.id)) return;
    if (!gs.betsLocked) { gs.betsLocked = true; cancelBetTimer(code); broadcast(code); }
    if (!gs.readyPlayers.includes(socket.id)) gs.readyPlayers.push(socket.id);
    io.to(code).emit('dealVote', { ready: gs.readyPlayers.length, needed: playersWithBets.size, readyIds: gs.readyPlayers });
    if ([...playersWithBets].every(id => gs.readyPlayers.includes(id))) startDeal(code);
  });

  socket.on('action', ({ action, sid }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.gs.gameStatus !== 'playing') return;
    const { gs, players } = room;
    const rtl = rtlOrder(gs);
    if (rtl[gs.currentSeatIndex] !== sid) return;
    if (gs.seatOwners[sid] !== socket.id) return;
    const player = players[socket.id];

    if (action === 'hit') {
      dealTo(gs, sid);
      const hand = gs.splitActive[sid] ? gs.hands[sid]['hand'+(gs.splitHandIndex[sid]+1)] : gs.hands[sid];
      const sc = score(hand);
      broadcast(code);
      if (sc > 21) { playerBust(code, sid); return; }
      if (sc === 21) { advanceSeat(code, sid); return; }
      io.to(code).emit('yourTurn', { sid, handIdx: gs.splitHandIndex[sid]||0, ownerId: gs.seatOwners[sid] });

    } else if (action === 'stand') {
      advanceSeat(code, sid);

    } else if (action === 'double') {
      if (player && player.wallet >= gs.bets[sid].main) {
        player.wallet -= gs.bets[sid].main; player.totalBet += gs.bets[sid].main;
        gs.bets[sid].main *= 2; gs.doubled[sid] = true;
        dealTo(gs, sid); broadcast(code); advanceSeat(code, sid);
      }

    } else if (action === 'split') {
      const hand = gs.hands[sid];
      if (!Array.isArray(hand) || hand.length !== 2) return;
      if (cardNum(hand[0]) !== cardNum(hand[1])) return;
      const splitBet = gs.bets[sid].main; // each hand = full main bet
      if (!player || player.wallet < splitBet) return;
      player.wallet -= splitBet; player.totalBet += splitBet;
      gs.splitBets[sid] = splitBet;
      const n1 = gs.deck.pop(), n2 = gs.deck.pop();
      gs.hands[sid] = { hand1: [hand[0], n1], hand2: [hand[1], n2] };
      gs.splitActive[sid] = true; gs.splitHandIndex[sid] = 0;
      broadcast(code);
      io.to(code).emit('yourTurn', { sid, handIdx: 0, ownerId: gs.seatOwners[sid] });
    }
  });

  socket.on('insuranceResponse', ({ sid, insure }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || !room.gs.insurancePhase) return;
    const { gs, players } = room;
    const player = players[socket.id];
    // Must be the owner of the current seat in queue
    if (gs.insuranceCurrentSid !== sid) return;
    if (gs.seatOwners[sid] !== socket.id) return;
    if (insure) {
      const cost = Math.floor(gs.bets[sid].main / 2);
      if (player && player.wallet >= cost) {
        player.wallet -= cost; player.totalBet += cost;
        gs.insurance[sid] = cost;
        if (!gs.insuredSeats) gs.insuredSeats = [];
        if (!gs.insuredSeats.includes(sid)) gs.insuredSeats.push(sid);
      }
    }
    gs.insuranceQueueIndex++;
    advanceInsuranceQueue(code);
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    delete room.players[socket.id];
    for (const [sid, ownerId] of Object.entries(room.gs.seatOwners)) {
      if (ownerId === socket.id) {
        delete room.gs.seatOwners[sid];
        room.gs.activeSeats = room.gs.activeSeats.filter(s => s !== sid);
        room.gs.bets[sid] = { main:0, pp:0, sp:0 };
      }
    }
    if (!Object.keys(room.players).length) {
      if (room.betTimerTimeout) clearInterval(room.betTimerTimeout);
      delete rooms[code];
    } else {
      if (room.hostId === socket.id) assignNewHost(code);
      else broadcast(code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Blackjack server on :${PORT}`));
