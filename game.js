// =============================================================
// game.js — Authoritative Blackjack game logic (server-side)
// All deck, hand, bet, turn, insurance, and payout logic lives
// here. server.js requires this module and passes io + rooms.
// No UI, no socket setup — pure game state mutations + events.
// =============================================================
'use strict';
const { randomInt } = require('crypto');

// ── Injected by server.js via Game.init() ────────────────────
let _io    = null;
let _rooms = null;

function init(io, rooms) {
  _io    = io;
  _rooms = rooms;
}

// ── State factory ────────────────────────────────────────────
function makeGs() {
  return {
    bets:           { 1:{main:0,pp:0,sp:0}, 2:{main:0,pp:0,sp:0}, 3:{main:0,pp:0,sp:0}, 4:{main:0,pp:0,sp:0}, 5:{main:0,pp:0,sp:0} },
    hands:          { dealer: [] },
    splitActive:    { 1:false, 2:false, 3:false, 4:false, 5:false },
    splitHandIndex: { 1:0, 2:0, 3:0, 4:0, 5:0 },
    splitBets:      { 1:0, 2:0, 3:0, 4:0, 5:0 },
    splitFromAces:  { 1:false, 2:false, 3:false, 4:false, 5:false },
    doubled:        { 1:false, 2:false, 3:false, 4:false, 5:false },
    doubledHands:   { 1:{hand1:false,hand2:false}, 2:{hand1:false,hand2:false}, 3:{hand1:false,hand2:false}, 4:{hand1:false,hand2:false}, 5:{hand1:false,hand2:false} },
    deck:           [],
    forcedCards:    null,
    isTrainingMode: false,
    betTimerEnabled: true,
    dealLabEnabled: false,
    gameStatus:     'idle',
    roundLock:      false,
    splitAnimStep:  {},
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
    insuranceQueue: null,
    insuranceQueueIndex: 0,
    insuranceCurrentSid: null,
    insuredSeats: [],
    grandTotal:     null,
  };
}

// ── Deck ─────────────────────────────────────────────────────
function buildDeck() {
  const S = ['S','H','D','C'], V = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  let d = [];
  for (let n = 0; n < 6; n++) S.forEach(s => V.forEach(v => d.push({suit:s,value:v})));
  for (let i = d.length-1; i > 0; i--) {
    const j = randomInt(0, i+1); [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}

// ── Pure card helpers ─────────────────────────────────────────
function isNaturalBJ(hand) {
  if (!Array.isArray(hand) || hand.length !== 2) return false;
  const vals = hand.map(c => c.value);
  return vals.includes('A') && vals.some(v => ['10','J','Q','K'].includes(v));
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

// ── Broadcast helpers ─────────────────────────────────────────
function broadcast(code) {
  const room = _rooms[code];
  if (!room) return;
  const players = {};
  for (const [sid, p] of Object.entries(room.players)) {
    players[sid] = { name: p.name, wallet: p.wallet, totalBet: p.totalBet, isHost: p.isHost };
  }
  _io.to(code).emit('stateUpdate', { gs: room.gs, players, code, hostId: room.hostId });
}

// ── Deal helpers ──────────────────────────────────────────────
function dealTo(gs, target) {
  let card = null;
  if (gs.forcedCards && gs.dealLabEnabled) {
    if (target === 'dealer' && gs.forcedCards.dealer && gs.forcedCards.dealer.length) {
      card = gs.forcedCards.dealer.shift();
    } else if (target !== 'dealer') {
      const sid = String(target);
      const fc = gs.forcedCards.seats?.[sid];
      if (fc && fc.length) { card = fc.shift(); }
    }
  }
  if (!card) card = gs.deck.pop();
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
    gs.splitFromAces[sid] = false;
    gs.doubled[sid] = false;
    gs.doubledHands[sid] = {hand1:false,hand2:false};
  }
}

function rtlOrder(gs) {
  return [...gs.activeSeats].map(Number).sort((a,b)=>b-a).map(String);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Bet timer ─────────────────────────────────────────────────
function startBetTimer(code) {
  const room = _rooms[code];
  if (!room || room.betTimerTimeout) return;
  if (!room.gs.betTimerEnabled) return;
  room.betTimerSecsLeft = 15;
  room.betTimerTimeout = setInterval(() => {
    const hasBets = room.gs.activeSeats.some(sid => (room.gs.bets[sid]?.main||0) > 0);
    if (!hasBets) {
      clearInterval(room.betTimerTimeout);
      room.betTimerTimeout = null;
      _io.to(code).emit('timerCancel');
      return;
    }
    room.betTimerSecsLeft--;
    _io.to(code).emit('timerTick', room.betTimerSecsLeft);
    if (room.betTimerSecsLeft <= 0) {
      clearInterval(room.betTimerTimeout);
      room.betTimerTimeout = null;
      startDeal(code);
    }
  }, 1000);
}

function cancelBetTimer(code) {
  const room = _rooms[code];
  if (!room) return;
  if (room.betTimerTimeout) { clearInterval(room.betTimerTimeout); room.betTimerTimeout = null; }
  _io.to(code).emit('timerCancel');
}

// ── Side bets ─────────────────────────────────────────────────
function resolveSideBets(code) {
  const room = _rooms[code];
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

// ── Insurance ─────────────────────────────────────────────────
function offerInsurance(code) {
  const room = _rooms[code];
  const { gs } = room;
  gs.insurancePhase = true;
  gs.insuranceResponses = {};

  const hasBJ = (sid) => isNaturalBJ(gs.hands[sid]);

  const eligibleSeats = Object.entries(gs.seatOwners)
    .filter(([sid]) => (gs.bets[sid]?.main || 0) > 0 && !hasBJ(sid))
    .sort(([a],[b]) => Number(b) - Number(a))
    .map(([sid, ownerId]) => ({ sid, ownerId }));

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
  const room = _rooms[code];
  const { gs } = room;
  if (!gs.insuranceQueue || gs.insuranceQueueIndex >= gs.insuranceQueue.length) {
    gs.insurancePhase = false;
    gs.insuranceCurrentSid = null;
    broadcast(code);
    checkBJ(code);
    return;
  }
  const { sid, ownerId } = gs.insuranceQueue[gs.insuranceQueueIndex];
  const cost = Math.floor((gs.bets[sid]?.main || 0) / 2);
  const owner = room.players[ownerId];
  // Auto-skip if can't afford
  if (!owner || owner.wallet < cost) {
    gs.insuranceQueueIndex++;
    advanceInsuranceQueue(code);
    return;
  }
  gs.insuranceCurrentSid = sid;
  broadcast(code);
  // Emit to seat owner only; also broadcast the indicator to all via stateUpdate above
  _io.to(ownerId).emit('insuranceOfferSeat', { sid, cost });
  const _qIdx = gs.insuranceQueueIndex;
  setTimeout(() => {
    if (!_rooms[code] || !_rooms[code].gs.insurancePhase) return;
    if (_rooms[code].gs.insuranceQueueIndex !== _qIdx) return;
    _rooms[code].gs.insuranceQueueIndex++;
    advanceInsuranceQueue(code);
  }, 20000);
}

function handleInsuranceResponse(code, socketId, sid, insure) {
  const room = _rooms[code];
  if (!room || !room.gs.insurancePhase) return false;
  if (room.gs.roundLock) return false;
  const { gs, players } = room;
  const player = players[socketId];
  if (gs.insuranceCurrentSid !== sid) return false;
  if (gs.seatOwners[sid] !== socketId) return false;
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
  return true;
}

// ── BJ check ──────────────────────────────────────────────────
function markPlayerBJBadges(gs) {
  for (const sid of gs.activeSeats) {
    const hand = gs.hands[sid];
    if (!gs.splitActive[sid] && isNaturalBJ(hand)) {
      if (!gs.badges[sid]) gs.badges[sid] = [];
      if (!gs.badges[sid].some(b => b.cls === 'bj')) {
        gs.badges[sid].push({ cls:'bj', text:'Blackjack!' });
      }
    }
  }
}

function payInsurance(gs, players) {
  for (const sid of gs.activeSeats) {
    const ins = gs.insurance[sid] || 0;
    if (ins > 0) {
      const player = players[gs.seatOwners[sid]];
      if (player) player.wallet += ins * 3;
    }
  }
}

async function checkBJ(code) {
  const room = _rooms[code];
  const { gs, players } = room;
  const dBJ = isNaturalBJ(gs.hands.dealer);

  if (dBJ) {
    gs.dealerRevealed = true;
    broadcast(code);
    await delay(1400);
    markPlayerBJBadges(gs);
    payInsurance(gs, players);
    resolveMain(code, true);
    return;
  }

  markPlayerBJBadges(gs);
  broadcast(code);
  gs.gameStatus = 'playing';
  gs.currentSeatIndex = 0;
  advancePlay(code);
}

// ── Play flow ─────────────────────────────────────────────────
function advancePlay(code) {
  const room = _rooms[code];
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
  _io.to(code).emit('yourTurn', { sid, handIdx: gs.splitHandIndex[sid]||0, ownerId: gs.seatOwners[sid] });
  broadcast(code);
}

function advanceSeat(code, sid) {
  const room = _rooms[code];
  if (!room) return;
  const { gs } = room;

  if (gs.splitActive[sid] && gs.splitHandIndex[sid] === 0) {
    gs.splitHandIndex[sid] = 1;
    broadcast(code);
    _io.to(code).emit('yourTurn', { sid, handIdx: 1, ownerId: gs.seatOwners[sid] });
    return;
  }

  if (!gs.stoodSeats.includes(sid)) gs.stoodSeats.push(sid);
  gs.currentSeatIndex++;
  advancePlay(code);
}

function playerBust(code, sid) {
  const room = _rooms[code];
  const { gs } = room;
  const hk       = gs.splitActive[sid] ? 'hand'+(gs.splitHandIndex[sid]+1) : null;
  const bustHand = hk ? gs.hands[sid][hk] : gs.hands[sid];
  if (!gs.bustSeats) gs.bustSeats = {};
  gs.bustSeats[sid + (hk ? '_'+hk : '')] = score(bustHand);
  broadcast(code);

  setTimeout(() => {
    if (!_rooms[code]) return;
    if (gs.splitActive[sid] && gs.splitHandIndex[sid] === 0) {
      gs.splitHandIndex[sid] = 1;
      broadcast(code);
      _io.to(code).emit('yourTurn', { sid, handIdx: 1, ownerId: gs.seatOwners[sid] });
    } else {
      gs.currentSeatIndex++;
      advancePlay(code);
    }
  }, 1200);
}

// ── Dealer turn ───────────────────────────────────────────────
function dealerTurn(code) {
  const room = _rooms[code];
  const { gs } = room;
  gs.gameStatus = 'dealer_turn';
  broadcast(code);
  setTimeout(() => {
    if (!_rooms[code]) return;
    gs.dealerRevealed = true;
    broadcast(code);
    function dealerStep() {
      if (!_rooms[code]) return;
      if (score(gs.hands.dealer) < 17) {
        dealTo(gs, 'dealer');
        broadcast(code);
        setTimeout(dealerStep, 700);
      } else {
        resolveMain(code, isNaturalBJ(gs.hands.dealer));
      }
    }
    setTimeout(dealerStep, 800);
  }, 2500);
}

// ── Resolve & new round ───────────────────────────────────────
function resolveMain(code, dealerBJ) {
  const room = _rooms[code];
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
        const bjPayout = Math.floor(gs.bets[sid].main * 2.5);
        player.wallet += bjPayout;
        totalWon += bjPayout;
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
  setTimeout(() => { if (_rooms[code]) newRound(code); }, 4000);
}

function newRound(code) {
  const room = _rooms[code];
  if (!room) return;
  const { gs } = room;

  const byPlayer = {};
  for (const entry of gs.betHistory) {
    if (!byPlayer[entry.socketId]) byPlayer[entry.socketId] = [];
    byPlayer[entry.socketId].push({ sid: entry.sid, type: entry.type, amt: entry.amt });
  }

  const saved = {
    seatOwners:    { ...gs.seatOwners },
    dealLabEnabled: gs.dealLabEnabled,
    isTrainingMode: gs.isTrainingMode,
    forcedCards:    gs.forcedCards,
    betTimerEnabled: gs.betTimerEnabled,
  };
  Object.assign(gs, makeGs());
  Object.assign(gs, saved);
  gs.gameStatus    = 'betting';
  gs.deck          = buildDeck();
  gs.lastRoundBets = byPlayer;

  for (const p of Object.values(room.players)) p.totalBet = 0;
  broadcast(code);
}

// ── Deal ──────────────────────────────────────────────────────
async function startDeal(code) {
  cancelBetTimer(code);
  const room = _rooms[code];
  const { gs } = room;
  if (gs.activeSeats.length === 0) return;

  gs.gameStatus = 'dealing';
  gs.roundLock  = true;
  gs.deck       = buildDeck();
  initHandsForSeats(gs);

  if (gs.dealLabEnabled && room.forcedConfig) {
    gs.forcedCards = JSON.parse(JSON.stringify(room.forcedConfig));
  }
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

  gs.roundLock = false;
  resolveSideBets(code);
  broadcast(code);
  await delay(200);

  const upCard = gs.hands.dealer[0];
  if (upCard && upCard.value === 'A') { offerInsurance(code); return; }
  checkBJ(code);
}

// ── Action handler ────────────────────────────────────────────
// Returns { ok, error } — server.js calls this from socket.on('action')
function handleAction(code, socketId, action, sid) {
  const room = _rooms[code];
  if (!room || room.gs.gameStatus !== 'playing') return { ok:false, error:'not playing' };
  const { gs, players } = room;
  if (gs.roundLock) return { ok:false, error:'roundLock' };
  const rtl = rtlOrder(gs);
  if (rtl[gs.currentSeatIndex] !== sid) return { ok:false, error:'not your turn' };
  if (gs.seatOwners[sid] !== socketId) return { ok:false, error:'not your seat' };
  const player = players[socketId];

  // Broadcast action indicator to all OTHER players in the room
  for (const pid of Object.keys(room.players)) {
    if (pid !== socketId) _io.to(pid).emit('playerAction', { sid, action });
  }

  if (action === 'hit') {
    if (gs.splitActive[sid] && gs.splitFromAces[sid]) return { ok:false, error:'split aces' };
    if (gs.dealLabEnabled && gs.forcedCards?.nextHit?.[sid]) {
      gs.deck.push(gs.forcedCards.nextHit[sid]);
      delete gs.forcedCards.nextHit[sid];
      if (!Object.keys(gs.forcedCards.nextHit).length) delete gs.forcedCards.nextHit;
    }
    dealTo(gs, sid);
    const hand = gs.splitActive[sid] ? gs.hands[sid]['hand'+(gs.splitHandIndex[sid]+1)] : gs.hands[sid];
    const sc = score(hand);
    broadcast(code);
    if (sc > 21) { playerBust(code, sid); return { ok:true }; }
    if (sc === 21) { advanceSeat(code, sid); return { ok:true }; }
    _io.to(code).emit('yourTurn', { sid, handIdx: gs.splitHandIndex[sid]||0, ownerId: gs.seatOwners[sid] });

  } else if (action === 'stand') {
    advanceSeat(code, sid);

  } else if (action === 'double') {
    if (gs.splitActive[sid]) {
      const hk = 'hand' + (gs.splitHandIndex[sid] + 1);
      const betAmt = hk === 'hand1' ? gs.bets[sid].main : (gs.splitBets[sid] || gs.bets[sid].main);
      if (player && player.wallet >= betAmt && !gs.doubledHands[sid][hk]) {
        player.wallet -= betAmt; player.totalBet += betAmt;
        if (hk === 'hand1') gs.bets[sid].main *= 2;
        else gs.splitBets[sid] = (gs.splitBets[sid] || gs.bets[sid].main/2) * 2;
        gs.doubledHands[sid][hk] = true;
        dealTo(gs, sid); broadcast(code); advanceSeat(code, sid);
      }
    } else if (player && player.wallet >= gs.bets[sid].main) {
      player.wallet -= gs.bets[sid].main; player.totalBet += gs.bets[sid].main;
      gs.bets[sid].main *= 2; gs.doubled[sid] = true;
      dealTo(gs, sid); broadcast(code); advanceSeat(code, sid);
    }

  } else if (action === 'split') {
    const hand = gs.hands[sid];
    if (!Array.isArray(hand) || hand.length !== 2) return { ok:false, error:'invalid hand' };
    if (cardNum(hand[0]) !== cardNum(hand[1])) return { ok:false, error:'not a pair' };
    const splitBet = gs.bets[sid].main;
    if (!player || player.wallet < splitBet) return { ok:false, error:'insufficient funds' };
    player.wallet -= splitBet; player.totalBet += splitBet;
    gs.splitBets[sid] = splitBet;
    gs.splitFromAces[sid] = (hand[0].value === 'A');

    const n1 = gs.deck.pop();
    const n2 = gs.deck.pop();
    gs.hands[sid] = { hand1: [hand[0]], hand2: [hand[1]] };
    gs.splitActive[sid] = true; gs.splitHandIndex[sid] = 0;
    gs.splitAnimStep[sid] = 0;
    gs.roundLock = true;
    broadcast(code);

    setTimeout(() => {
      if (!_rooms[code]) return;
      if (n1) gs.hands[sid].hand1.push(n1);
      gs.splitAnimStep[sid] = 1;
      broadcast(code);
      setTimeout(() => {
        if (!_rooms[code]) return;
        if (n2) gs.hands[sid].hand2.push(n2);
        gs.splitAnimStep[sid] = 2;
        gs.roundLock = false;
        broadcast(code);
        if (gs.splitFromAces[sid]) {
          gs.splitHandIndex[sid] = 1;
          broadcast(code);
          setTimeout(() => { if (_rooms[code]) advanceSeat(code, sid); }, 300);
        } else if (score(gs.hands[sid].hand1) === 21) {
          gs.splitHandIndex[sid] = 1;
          broadcast(code);
          _io.to(code).emit('yourTurn', { sid, handIdx: 1, ownerId: gs.seatOwners[sid] });
        } else {
          _io.to(code).emit('yourTurn', { sid, handIdx: 0, ownerId: gs.seatOwners[sid] });
        }
      }, 400);
    }, 400);
  }

  return { ok:true };
}

// ── Assign new host ───────────────────────────────────────────
function assignNewHost(code) {
  const room = _rooms[code];
  if (!room || !Object.keys(room.players).length) return;
  const playerIds = Object.keys(room.players);
  const newHostId = playerIds.reduce((best, id) =>
    room.players[id].joinOrder < room.players[best].joinOrder ? id : best
  , playerIds[0]);
  room.hostId = newHostId;
  for (const [id, p] of Object.entries(room.players)) p.isHost = (id === newHostId);
  _io.to(code).emit('hostChanged', { hostId: newHostId });
  broadcast(code);
}

// ── Exports ───────────────────────────────────────────────────
module.exports = {
  init,
  makeGs,
  buildDeck,
  broadcast,
  startBetTimer,
  cancelBetTimer,
  startDeal,
  handleAction,
  handleInsuranceResponse,
  advanceInsuranceQueue,
  assignNewHost,
  rtlOrder,
  // Pure helpers (used by server for validation)
  score,
  cardNum,
  isNaturalBJ,
  newRound,
};
