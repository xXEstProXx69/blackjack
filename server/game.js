// =============================================================
// game.js — Authoritative Blackjack Game Logic
// Pure functions + state factories. No socket/IO references.
// Required by server.js via require('./server/game')
// =============================================================
'use strict';
const { randomInt } = require('crypto');

// ── State factory ─────────────────────────────────────────────
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
    insuredSeats:   [],
    insuranceQueue: [],
    insuranceQueueIndex: 0,
    insuranceCurrentSid: null,
    grandTotal:     null,
  };
}

// ── Deck ──────────────────────────────────────────────────────
function buildDeck() {
  const S = ['S','H','D','C'], V = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  let d = [];
  for (let n = 0; n < 6; n++) S.forEach(s => V.forEach(v => d.push({ suit:s, value:v })));
  for (let i = d.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1); [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ── Card helpers ──────────────────────────────────────────────
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
  const o = { A:14,K:13,Q:12,J:11,'10':10,'9':9,'8':8,'7':7,'6':6,'5':5,'4':4,'3':3,'2':2 };
  return o[c.value] ?? 0;
}

// ── Side-bet payout ───────────────────────────────────────────
function twentyOneThreePayout(cards) {
  const suits = cards.map(c => c.suit);
  const allSameSuit = suits.every(s => s === suits[0]);
  const isTrips = cards[0].value === cards[1].value && cards[1].value === cards[2].value;
  const ranks = cards.map(cardRank).sort((a, b) => a - b);
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

// ── Deal helpers ──────────────────────────────────────────────
function dealTo(gs, target) {
  let card = null;
  if (gs.forcedCards && gs.dealLabEnabled) {
    if (target === 'dealer' && gs.forcedCards.dealer && gs.forcedCards.dealer.length) {
      card = gs.forcedCards.dealer.shift();
    } else if (target !== 'dealer') {
      const sid = String(target);
      const fc = gs.forcedCards.seats?.[sid];
      if (fc && fc.length) card = fc.shift();
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
    gs.splitActive[sid]    = false;
    gs.splitHandIndex[sid] = 0;
    gs.splitBets[sid]      = 0;
    gs.splitFromAces[sid]  = false;
    gs.doubled[sid]        = false;
    gs.doubledHands[sid]   = { hand1:false, hand2:false };
  }
}

// ── Seat turn ordering (RTL: seat 5 → seat 1) ────────────────
function rtlOrder(gs) {
  return [...gs.activeSeats].map(Number).sort((a,b) => b - a).map(String);
}

// ── Side bet resolution ───────────────────────────────────────
function resolveSideBets(gs, players) {
  gs.roundSideBetWon = 0;
  const dUp = gs.hands.dealer[0];
  for (const sid of gs.activeSeats) {
    const hand = Array.isArray(gs.hands[sid]) ? gs.hands[sid] : [];
    if (hand.length < 2) continue;
    const player = players[gs.seatOwners[sid]];
    if (!player) continue;

    if (gs.bets[sid].pp > 0) {
      const [c1, c2] = hand;
      if (c1.value === c2.value) {
        const sameSuit  = c1.suit === c2.suit;
        const sameColor = suitColor(c1.suit) === suitColor(c2.suit);
        const mult   = sameSuit ? 25 : sameColor ? 12 : 6;
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
/**
 * Build the insurance queue and return it.
 * Caller (server.js) is responsible for emitting events and advancing the queue.
 */
function buildInsuranceQueue(gs) {
  const hasBJ = sid => isNaturalBJ(gs.hands[sid]);
  const eligible = Object.entries(gs.seatOwners)
    .filter(([sid]) => (gs.bets[sid]?.main || 0) > 0 && !hasBJ(sid))
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([sid, ownerId]) => ({ sid, ownerId }));
  return eligible;
}

// ── BJ badge marking ──────────────────────────────────────────
function markPlayerBJBadges(gs) {
  for (const sid of gs.activeSeats) {
    if (!gs.splitActive[sid] && isNaturalBJ(gs.hands[sid])) {
      if (!gs.badges[sid]) gs.badges[sid] = [];
      if (!gs.badges[sid].some(b => b.cls === 'bj'))
        gs.badges[sid].push({ cls:'bj', text:'Blackjack!' });
    }
  }
}

// ── Insurance payout ──────────────────────────────────────────
function payInsurance(gs, players) {
  for (const sid of gs.activeSeats) {
    const ins = gs.insurance[sid] || 0;
    if (ins > 0) {
      const player = players[gs.seatOwners[sid]];
      if (player) player.wallet += ins * 3;
    }
  }
}

// ── Main bet resolution ───────────────────────────────────────
/**
 * Returns totalWon (used for gs.grandTotal).
 * Mutates gs.badges and player wallets.
 */
function resolveMain(gs, players, dealerBJ) {
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
        totalWon      += gs.bets[sid].main;
        gs.badges[sid].push({ cls:'push', text:'Push' });
      } else {
        const payout = Math.floor(gs.bets[sid].main * 2.5);
        player.wallet += payout;
        totalWon      += payout;
      }
      continue;
    }

    if (gs.splitActive[sid]) {
      const mainBet  = gs.bets[sid].main;
      const splitBet = gs.splitBets[sid] || mainBet;
      const bets     = { hand1: mainBet, hand2: splitBet };
      for (const hk of ['hand1','hand2']) {
        const ps = score(gs.hands[sid][hk] || []);
        if (ps > 21)       { gs.badges[sid].push({ cls:'lose', text:'Bust' }); continue; }
        if (dealerBJ)      { gs.badges[sid].push({ cls:'lose', text:'Lose' }); continue; }
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
      if (ps > 21)       { gs.badges[sid].push({ cls:'lose', text:'Bust' }); continue; }
      if (dealerBJ)      { gs.badges[sid].push({ cls:'lose', text:'Lose' }); continue; }
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
  return totalWon;
}

// ── New round state reset ─────────────────────────────────────
function resetForNewRound(gs, byPlayer) {
  const saved = {
    seatOwners:    { ...gs.seatOwners },
    dealLabEnabled: gs.dealLabEnabled,
    isTrainingMode: gs.isTrainingMode,
    forcedCards:   gs.forcedCards,
    betTimerEnabled: gs.betTimerEnabled,
  };
  Object.assign(gs, makeGs());
  gs.seatOwners     = saved.seatOwners;
  gs.dealLabEnabled = saved.dealLabEnabled;
  gs.isTrainingMode = saved.isTrainingMode;
  gs.forcedCards    = saved.forcedCards;
  gs.betTimerEnabled = saved.betTimerEnabled;
  gs.gameStatus     = 'betting';
  gs.deck           = buildDeck();
  gs.lastRoundBets  = byPlayer;
}

// ── Utility ───────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  makeGs, buildDeck,
  isNaturalBJ, score, cardNum, suitColor, cardRank, twentyOneThreePayout,
  dealTo, initHandsForSeats, rtlOrder,
  resolveSideBets, buildInsuranceQueue,
  markPlayerBJBadges, payInsurance, resolveMain, resetForNewRound,
  delay,
};
