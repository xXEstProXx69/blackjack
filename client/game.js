// =============================================================
// game.js — Client-side game helpers
// Pure functions: card scoring, chip math, history persistence.
// No DOM, no socket, no sound. Loaded before ui.js.
// =============================================================

// ── Chip colours (value → 'top,bottom' CSS colours) ──────────
const CHIP_COLORS = {
  1:'#ffe050,#c8a000', 2:'#5090f0,#1a50c8', 5:'#e83030,#9a0808',
  10:'#40d8f8,#0898c0', 25:'#80e040,#3a9000', 50:'#f08020,#b04000',
  100:'#282828,#080808', 200:'#f060b0,#b01868', 500:'#9050d0,#4a0890',
  1000:'#2858c8,#0a2880', 2000:'#182898,#080850', 5000:'#b01820,#680008',
  10000:'#187028,#083810',
};

// ── Best chip selection ───────────────────────────────────────
function bestChip(preferred, wallet) {
  const DENOMS = [10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];
  if (wallet >= preferred) return preferred;
  for (const d of DENOMS) { if (wallet >= d) return d; }
  return 0;
}

// ── Card helpers ──────────────────────────────────────────────
function isNaturalBJ(h) {
  if (!Array.isArray(h) || h.length !== 2) return false;
  const vals = h.map(c => c.value);
  return vals.includes('A') && vals.some(v => ['10','J','Q','K'].includes(v));
}

function score(h) {
  if (!Array.isArray(h) || !h.length) return 0;
  let t = 0, a = 0;
  for (const c of h) {
    if (['J','Q','K'].includes(c.value)) t += 10;
    else if (c.value === 'A') { a++; t += 11; }
    else t += parseInt(c.value) || 0;
  }
  while (t > 21 && a > 0) { t -= 10; a--; }
  return t;
}

function scoreLabel(h, stood) {
  if (!Array.isArray(h) || !h.length) return '';
  let t = 0, a = 0;
  for (const c of h) {
    if (['J','Q','K'].includes(c.value)) t += 10;
    else if (c.value === 'A') { a++; t += 11; }
    else t += parseInt(c.value) || 0;
  }
  while (t > 21 && a > 0) { t -= 10; a--; }
  if (a > 0 && t !== 21 && !stood) return `${t-10}/${t}`;
  return String(t);
}

function cardNum(c) {
  if (['J','Q','K'].includes(c.value)) return 10;
  if (c.value === 'A') return 11;
  return parseInt(c.value);
}

function cardStr(c) {
  return c.value + ({ S:'\u2660', H:'\u2665', D:'\u2666', C:'\u2663' }[c.suit] || '');
}

function suitIsRed(s) { return s === 'H' || s === 'D'; }

// ── Number formatting ─────────────────────────────────────────
function fmt(n) {
  return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k' : String(n);
}

// ── LocalStorage helpers ──────────────────────────────────────
function loadName() {
  try { return JSON.parse(localStorage.getItem('kk_name') || 'null') || ''; } catch { return ''; }
}
function saveName(n) {
  try { localStorage.setItem('kk_name', JSON.stringify(n)); } catch {}
}
function loadToken() {
  try {
    let t = localStorage.getItem('kk_token');
    if (!t) { t = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); localStorage.setItem('kk_token', t); }
    return t;
  } catch { return 'anon_' + Date.now(); }
}
function loadHistory() {
  try { return JSON.parse(localStorage.getItem('kk_history') || '[]'); } catch { return []; }
}
function saveHistory(h) {
  try { localStorage.setItem('kk_history', JSON.stringify(h)); } catch {}
}
function pushRound(entry) {
  const h = loadHistory();
  h.unshift(entry);
  if (h.length > 500) h.length = 500;
  saveHistory(h);
}

// ── Winnings calculation (local display only) ─────────────────
function calcMyWinnings(gs, mySocketId) {
  let t = 0;
  for (const [sid, oid] of Object.entries(gs.seatOwners || {})) {
    if (oid !== mySocketId) continue;
    const b = gs.badges?.[sid] || [];
    const isBJPush = b.some(x => x.cls==='bj') && b.some(x => x.cls==='push');
    if (isBJPush)                  t += gs.bets[sid].main;
    else if (b.some(x=>x.cls==='bj'))   t += Math.floor(gs.bets[sid].main * 2.5);
    else if (b.some(x=>x.cls==='win'))  t += gs.bets[sid].main * 2;
    else if (b.some(x=>x.cls==='push')) t += gs.bets[sid].main;
    if (gs.sideBetWins?.[sid]?.pp) t += gs.sideBetWins[sid].pp.payout;
    if (gs.sideBetWins?.[sid]?.sp) t += gs.sideBetWins[sid].sp.payout;
  }
  return t;
}

// ── Round history building ────────────────────────────────────
function buildRoundHistoryEntry(gs, players, mySocketId, roomCode) {
  const mySeats = Object.entries(gs.seatOwners || {})
    .filter(([, id]) => id === mySocketId).map(([s]) => s);
  if (!mySeats.length) return null;
  const ordered = [...mySeats].sort((a, b) => Number(b) - Number(a));
  const allSeats = ['1','2','3','4','5'];
  const seatMap  = allSeats.map(n => ({ n, mine: mySeats.includes(n), taken: !!(gs.seatOwners?.[n]) }));
  let totalBet = 0, netCash = 0;

  const seats = ordered.map(sid => {
    const main = gs.bets?.[sid]?.main || 0;
    const pp   = gs.bets?.[sid]?.pp   || 0;
    const sp   = gs.bets?.[sid]?.sp   || 0;
    totalBet += main + pp + sp;
    const badges = gs.badges?.[sid] || [];
    const hasBJ  = badges.some(b => b.cls==='bj');
    const hasWin = badges.some(b => b.cls==='win') || hasBJ;
    const hasPush = badges.some(b => b.cls==='push');
    const isBJPush = hasBJ && hasPush;
    const mr = isBJPush ? main : hasBJ ? Math.floor(main*2.5) : hasWin ? main*2 : hasPush ? main : 0;
    const mainNet = mr - main;
    const ppWin = gs.sideBetWins?.[sid]?.pp?.payout || 0;
    const spWin = gs.sideBetWins?.[sid]?.sp?.payout || 0;
    netCash += mainNet + (ppWin - pp) + (spWin - sp);
    const isDoubledSeat = gs.doubled?.[sid] || false;
    const mkHandEntry = (cards, resultBadge, hk) => {
      const isBust = resultBadge?.toLowerCase().includes('bust');
      const handDoubled = hk ? gs.doubledHands?.[sid]?.[hk] : isDoubledSeat;
      const decisions = cards.map((c, i) => {
        if (i < 2) return null;
        if (handDoubled && cards.length === 3 && i === 2) return 'double';
        return 'hit';
      });
      return { cards, decisions, stood: !isBust, result: resultBadge || '', score: score(cards) };
    };
    let hands = [];
    if (gs.splitActive?.[sid]) {
      ['hand1','hand2'].forEach((hk, i) => { hands.push(mkHandEntry(gs.hands?.[sid]?.[hk]||[], badges[i]?.text, hk)); });
    } else {
      hands.push(mkHandEntry(Array.isArray(gs.hands?.[sid]) ? gs.hands[sid] : [], badges[0]?.text));
    }
    return { sid, mainBet:main, ppBet:pp, spBet:sp, mainNet, ppNet:ppWin-pp, spNet:spWin-sp, ppWin, spWin, hands };
  });

  return {
    id: Date.now(),
    time: new Date().toISOString(),
    roomCode,
    tableName: 'Kikikov BlackJack',
    totalBet, netCash, seats, seatMap,
    dealerCards: gs.hands?.dealer || [],
  };
}
