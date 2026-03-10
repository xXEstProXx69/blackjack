// =============================================================
// BLACKJACK — script.js  (fully fixed)
// =============================================================

const settings = {
  autoRoundDelay: 3,
  startingBalance: 5000,
  betTimerSeconds: 15,
};

let playerName = '';
let wallet     = settings.startingBalance;
let totalBet   = 0;
let betHistory = [];
let lastRoundBets = {};
let betTimerInterval  = null;
let betTimerRemaining = 0;
let _roundSideBetWon  = 0;  // tracked during resolveSideBets

const gs = {
  selectedChip: null,
  bets:          {},
  hands:         {},
  splitActive:   {},
  splitHandIndex:{},
  doubled:       {},
  deck:          [],
  gameStatus:    'idle',
  activeSeats:   [],
  mySeatIds:     [],
  currentSeatIndex: 0,
  stoodSeats:    new Set(),
  insurance:     {},
};

// ── Storage ────────────────────────────────────────────────
function loadPlayer() {
  try {
    const d = JSON.parse(localStorage.getItem('bj_player') || 'null');
    if (d && d.name) {
      playerName = d.name;
      wallet = (typeof d.wallet === 'number' && d.wallet > 0) ? d.wallet : settings.startingBalance;
    }
  } catch(e) {}
}
function savePlayer() {
  try { localStorage.setItem('bj_player', JSON.stringify({name:playerName, wallet})); } catch(e) {}
}

// ── HUD ────────────────────────────────────────────────────
function updateWallet(animate) {
  const el = document.getElementById('wallet-amount');
  if (!el) return;
  el.textContent = '€' + wallet.toLocaleString();
  if (animate) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
}
function updateBetHud() {
  const el = document.getElementById('hud-bet-amount');
  if (el) el.textContent = totalBet > 0 ? '€' + totalBet.toLocaleString() : '€0';
}

// ── Helpers ────────────────────────────────────────────────
function setStatus(msg) { const el = document.getElementById('status-message'); if (el) el.textContent = msg; }
function show(id) { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
function hide(id) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Boot ───────────────────────────────────────────────────
loadPlayer();

document.addEventListener('DOMContentLoaded', () => {
  const nameInput  = document.getElementById('name-input');
  const nameSubmit = document.getElementById('name-submit');

  function submitName() {
    const n = nameInput.value.trim();
    if (!n) { nameInput.style.borderColor = '#c62828'; nameInput.focus(); return; }
    playerName = n;
    wallet = settings.startingBalance;
    savePlayer();
    document.getElementById('name-modal').classList.add('hidden');
    document.getElementById('game-container').classList.remove('hidden');
    launchGame();
  }

  nameSubmit.addEventListener('click', submitName);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitName(); });

  if (playerName) {
    document.getElementById('name-modal').classList.add('hidden');
    document.getElementById('game-container').classList.remove('hidden');
    launchGame();
  } else {
    setTimeout(() => nameInput.focus(), 200);
  }

  document.getElementById('btn-gear').addEventListener('click', () => show('settings-modal'));
  document.getElementById('settings-close').addEventListener('click', () => hide('settings-modal'));
  document.getElementById('setting-delay').addEventListener('input', function() {
    settings.autoRoundDelay = parseInt(this.value);
    document.getElementById('setting-delay-val').textContent = this.value + 's';
  });
  document.getElementById('setting-balance').addEventListener('change', function() {
    settings.startingBalance = parseInt(this.value);
  });
});

// ── Launch ─────────────────────────────────────────────────
function launchGame() {
  document.getElementById('player-greeting').textContent = 'Welcome, ' + playerName;
  resetState();
  updateWallet(false);
  updateBetHud();

  document.querySelectorAll('.bet-circle').forEach(c => {
    c.addEventListener('click', e => { e.stopPropagation(); onCircleClick(c); });
  });
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => onChipClick(chip));
  });
  document.getElementById('btn-deal').addEventListener('click', onDeal);
  document.getElementById('btn-clear').addEventListener('click', onClear);
  document.getElementById('btn-hit').addEventListener('click',    () => onAction('hit'));
  document.getElementById('btn-stand').addEventListener('click',  () => onAction('stand'));
  document.getElementById('btn-double').addEventListener('click', () => onAction('double'));
  document.getElementById('btn-split').addEventListener('click',  () => onAction('split'));
  document.getElementById('btn-undo').addEventListener('click', onUndo);
  document.getElementById('btn-rebet').addEventListener('click', onRebet);
  document.getElementById('btn-2x').addEventListener('click', onDouble2x);

  document.querySelectorAll('.leave-seat-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const sid = btn.closest('.seat')?.dataset.seat;
      if (sid) leaveSeat(sid);
    });
  });

  setStatus('Click a seat to claim it');
}

// ── Leave seat ─────────────────────────────────────────────
function leaveSeat(sid) {
  if (!['idle','betting'].includes(gs.gameStatus)) return;

  // Refund any bets on this seat
  wallet += (gs.bets[sid]?.main || 0) + (gs.bets[sid]?.pp || 0) + (gs.bets[sid]?.sp || 0);
  totalBet -= (gs.bets[sid]?.main || 0) + (gs.bets[sid]?.pp || 0) + (gs.bets[sid]?.sp || 0);
  if (totalBet < 0) totalBet = 0;
  gs.bets[sid] = {main:0, pp:0, sp:0};
  gs.activeSeats = gs.activeSeats.filter(s => s !== sid);
  gs.mySeatIds   = gs.mySeatIds.filter(s => s !== sid);

  // Remove history entries for this seat
  betHistory = betHistory.filter(e => e.isRebet || e.sid !== sid);

  // Reset seat UI
  const seat    = document.getElementById('seat-' + sid);
  const mc      = document.querySelector(`.bet-circle.main-bet[data-seat="${sid}"]`);
  const tag     = document.querySelector(`#seat-${sid} .seat-name-tag`);
  const deco    = document.querySelector(`#seat-${sid} .seat-chip-deco`);
  const overlay = document.querySelector(`#seat-${sid} .claim-overlay`);

  if (seat)    { seat.classList.remove('my-seat','selected','active-turn'); seat.style.cssText = ''; }
  if (mc)      { mc.classList.remove('claimed','has-bet'); mc.querySelector('.bet-amount').textContent = ''; }
  if (tag)     tag.classList.add('hidden');
  if (deco)    deco.style.display = '';
  if (overlay) overlay.style.display = '';

  document.querySelectorAll(`.bet-circle[data-seat="${sid}"]`).forEach(c => {
    c.classList.remove('has-bet');
    const amt = c.querySelector('.bet-amount');
    if (amt) amt.textContent = '';
  });

  updateWallet(true);
  updateBetHud();
  savePlayer();

  if (gs.activeSeats.length === 0) {
    hide('deal-btn-wrap');
    hide('btn-clear');
    stopBetTimer();
    gs.gameStatus = 'idle';
  }
  if (gs.mySeatIds.length === 0) {
    hideChipTray();
    setStatus('Click a seat to claim it');
  } else {
    setStatus('Seat ' + sid + ' left');
  }
}
function resetState() {
  for (let i = 1; i <= 5; i++) {
    gs.bets[i]           = {main:0, pp:0, sp:0};
    gs.hands[i]          = [];
    gs.splitActive[i]    = false;
    gs.splitHandIndex[i] = 0;
    gs.doubled[i]        = false;
  }
  gs.hands.dealer     = [];
  gs.activeSeats      = [];
  gs.gameStatus       = 'idle';
  gs.currentSeatIndex = 0;
  gs.stoodSeats       = new Set();
  gs.insurance        = {};
  totalBet            = 0;
  _roundSideBetWon    = 0;
}

function showChipTray() { show('chip-tray'); }
function hideChipTray() { hide('chip-tray'); }

// =============================================================
// CIRCLE CLICK
// =============================================================
function onCircleClick(circle) {
  if (!['idle','betting'].includes(gs.gameStatus)) return;

  const sid  = circle.dataset.seat;
  const type = circle.dataset.type;

  if (type === 'main' && !gs.mySeatIds.includes(sid)) {
    if (gs.mySeatIds.length >= 5) { setStatus('All 5 seats claimed'); return; }
    claimSeat(sid);
    showChipTray();
    mirrorBetsToNewSeat(sid);
    return;
  }

  if (!gs.mySeatIds.includes(sid)) {
    setStatus('Click the circle to claim Seat ' + sid + ' first');
    return;
  }
  if (!gs.selectedChip) { setStatus('Pick a chip first!'); return; }
  if (type !== 'main' && gs.bets[sid].main === 0) { setStatus('Place a main bet first'); return; }

  const amt = gs.selectedChip;
  _placeBet(sid, type, amt, true);
}

// =============================================================
// PLACE BET
// =============================================================
function _placeBet(sid, type, amt, mirrorToOthers, groupId) {
  // Max bet enforcement
  const maxBet = type === 'main' ? 10000 : 2000;
  const current = gs.bets[sid][type] || 0;
  if (current >= maxBet) {
    // Only show tooltip for direct (non-mirrored) bets
    if (mirrorToOthers) _showMaxTip(sid, type, maxBet);
    return false;
  }
  // Cap amount to not exceed max
  const allowed = Math.min(amt, maxBet - current);
  const actualAmt = allowed;

  if (wallet < actualAmt) { setStatus('Not enough balance!'); return false; }

  wallet   -= actualAmt;
  totalBet += actualAmt;
  updateWallet(true);
  updateBetHud();
  savePlayer();

  gs.bets[sid][type] += actualAmt;
  gs.gameStatus = 'betting';

  betHistory.push({sid, type, amt: actualAmt, groupId: groupId || null});

  _refreshCircle(sid, type);
  _renderChipStack(sid, type);

  // Animate chip flying to the circle
  const targetCircle = document.querySelector(`.bet-circle[data-seat="${sid}"][data-type="${type}"]`);
  _flyChip(amt, targetCircle);

  if (type === 'main' && !gs.activeSeats.includes(sid)) {
    gs.activeSeats.push(sid);
    show('deal-btn-wrap');
    show('btn-clear');
  }

  document.querySelectorAll('.seat').forEach(s => s.classList.remove('selected'));
  document.getElementById('seat-' + sid)?.classList.add('selected');

  startBetTimer();
  _autoSwitchChip();

  if (mirrorToOthers) {
    const gid = 'grp_' + Date.now() + '_' + Math.random();
    betHistory[betHistory.length - 1].groupId = gid;
    for (const other of gs.mySeatIds) {
      if (other === sid) continue;
      if (type === 'main') {
        // Mirror every main bet chip to all other claimed seats
        if (gs.bets[other].main < 10000 && wallet >= actualAmt) {
          _placeBet(other, 'main', actualAmt, false, gid);
        }
      } else {
        // Mirror side bet to seats that have a main bet — every chip click
        if (gs.bets[other].main > 0 && gs.bets[other][type] < 2000 && wallet >= actualAmt) {
          _placeBet(other, type, actualAmt, false, gid);
        }
      }
    }
  }

  return true;
}

function _autoSwitchChip() {
  if (!gs.selectedChip) return;
  // If wallet can still afford current chip, keep it
  if (wallet >= gs.selectedChip) return;
  // Find the largest chip the player can still afford
  const chipValues = [10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];
  const affordable = chipValues.find(v => wallet >= v);
  if (!affordable) return; // broke!
  if (affordable === gs.selectedChip) return;
  gs.selectedChip = affordable;
  document.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('selected', parseInt(c.dataset.value) === affordable);
  });
}

// ── Stacked chips visual on bet circle ─────────────────────
const CHIP_COLORS = {
  1:'#888,#444', 2:'#5090ee,#1a4bb0', 5:'#e05050,#a01010',
  10:'#50b8e0,#0e6fa0', 25:'#50c060,#1a7a20', 50:'#d07830,#8a3c00',
  100:'#222,#111', 200:'#b050f0,#6000b0', 500:'#8030a0,#400060',
  1000:'#e0b000,#a07000', 2000:'#e07030,#c03000',
  5000:'#10b0b0,#006060', 10000:'#f050a0,#900040',
};

function _amtToChips(amount) {
  const denom = [10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];
  const result = [];
  let rem = amount;
  for (const d of denom) {
    while (rem >= d && result.length < 8) { result.push(d); rem -= d; }
    if (result.length >= 8) break;
  }
  return result;
}

function _renderChipStack(sid, type) {
  const circle = document.querySelector(`.bet-circle[data-seat="${sid}"][data-type="${type}"]`);
  if (!circle) return;

  // Remove old stack
  circle.querySelectorAll('.chip-stack').forEach(s => s.remove());

  const amt = gs.bets[sid][type];
  if (amt <= 0) return;

  const chips = _amtToChips(amt);
  const isMain = type === 'main';
  // Fill the circle: main=62px, side=40px (matches CSS circle sizes minus border)
  const chipW  = isMain ? 58 : 38;
  const offsetY = isMain ? 4 : 3; // vertical stack offset per chip

  const stack = document.createElement('div');
  stack.className = 'chip-stack';

  chips.forEach((val, i) => {
    const cols = CHIP_COLORS[val] || '#888,#444';
    const [c1, c2] = cols.split(',');
    const chip = document.createElement('div');
    chip.className = 'stacked-chip';
    chip.style.cssText = `
      width:${chipW}px;height:${chipW}px;
      background:radial-gradient(circle at 35% 35%,${c1},${c2});
      bottom:${4 + i * offsetY}px;
      left:50%;transform:translateX(-50%);
    `;
    stack.appendChild(chip);
  });

  // Amount label: centered on the face of the TOP chip
  const topChipBottom = 4 + (chips.length - 1) * offsetY; // bottom of top chip
  const labelBottom   = topChipBottom + chipW / 2 - 9;     // vertically centered on chip
  const amtLabel = document.createElement('div');
  amtLabel.className = 'chip-stack-amt';
  amtLabel.style.bottom = labelBottom + 'px';
  amtLabel.style.top    = 'auto';
  amtLabel.textContent = '€' + (amt >= 1000 ? (amt/1000).toFixed(amt%1000===0?0:1)+'k' : amt);
  stack.appendChild(amtLabel);

  circle.appendChild(stack);
}

function _showMaxTip(sid, type, maxBet) {
  const circle = document.querySelector(`.bet-circle[data-seat="${sid}"][data-type="${type}"]`);
  if (!circle) return;
  // Remove any existing tip
  circle.querySelectorAll('.max-bet-tip').forEach(t => t.remove());
  const tip = document.createElement('div');
  tip.className = 'max-bet-tip';
  tip.textContent = `Maximum bet: €${maxBet.toLocaleString()}`;
  circle.style.position = 'relative';
  circle.appendChild(tip);
  setTimeout(() => tip.remove(), 2100);
}

function mirrorBetsToNewSeat(newSid) {
  const template = gs.mySeatIds.find(s => s !== newSid && gs.bets[s]?.main > 0);
  if (!template) return;
  const tmpl = gs.bets[template];
  if (tmpl.main > 0 && wallet >= tmpl.main) _placeBet(newSid, 'main', tmpl.main, false);
  if (tmpl.pp   > 0 && wallet >= tmpl.pp)   _placeBet(newSid, 'pp',   tmpl.pp,   false);
  if (tmpl.sp   > 0 && wallet >= tmpl.sp)   _placeBet(newSid, 'sp',   tmpl.sp,   false);
}

function _refreshCircle(sid, type) {
  const c = document.querySelector(`.bet-circle[data-seat="${sid}"][data-type="${type}"]`);
  if (!c) return;
  const amtEl = c.querySelector('.bet-amount');
  if (amtEl) amtEl.textContent = gs.bets[sid][type] > 0 ? '€' + gs.bets[sid][type] : '';
  if (gs.bets[sid][type] > 0) c.classList.add('has-bet'); else c.classList.remove('has-bet');
}

// ── 3D Chip fly-in animation ───────────────────────────────
function _flyChip(chipValue, targetCircleEl) {
  if (!targetCircleEl) return;
  const targetRect = targetCircleEl.getBoundingClientRect();
  const cx = targetRect.left + targetRect.width  / 2;
  const cy = targetRect.top  + targetRect.height / 2;

  const chipEl = document.querySelector(`.chip[data-value="${chipValue}"]`);
  let sx, sy;
  if (chipEl) {
    const cr = chipEl.getBoundingClientRect();
    sx = cr.left + cr.width  / 2;
    sy = cr.top  + cr.height / 2;
  } else {
    sx = window.innerWidth / 2;
    sy = window.innerHeight - 80;
  }

  // Chip color map
  const chipColors = {
    1:'#888,#444',2:'#5090ee,#1a4bb0',5:'#e05050,#a01010',10:'#50b8e0,#0e6fa0',
    25:'#50c060,#1a7a20',50:'#d07830,#8a3c00',100:'#333,#111',200:'#b050f0,#6000b0',
    500:'#8030a0,#400060',1000:'#e0b000,#a07000',2000:'#e07030,#c03000',
    5000:'#10b0b0,#006060',10000:'#f050a0,#900040',
  };
  const cols = chipColors[chipValue] || '#888,#444';
  const [c1, c2] = cols.split(',');

  const size = 36;
  const flyEl = document.createElement('div');
  flyEl.className = 'chip-flyto';
  flyEl.style.cssText = `width:${size}px;height:${size}px;left:${sx-size/2}px;top:${sy-size/2}px;`;

  // Face
  const face = document.createElement('div');
  face.className = 'chip-flyto-face';
  face.style.background = `radial-gradient(circle at 35% 35%, ${c1}, ${c2})`;

  // Edge (3D bottom shadow)
  const edge = document.createElement('div');
  edge.className = 'chip-flyto-edge';
  edge.style.background = c2;

  flyEl.appendChild(face);
  flyEl.appendChild(edge);
  document.body.appendChild(flyEl);

  const dx = cx - sx;
  const dy = cy - sy;

  // 3D arc — chip tilts and tumbles as it flies
  flyEl.animate([
    {transform: `translate(0px,0px) rotateX(0deg) rotateY(0deg) scale(1)`,          opacity: 1, offset: 0},
    {transform: `translate(${dx*0.5}px,${dy*0.5-30}px) rotateX(40deg) rotateY(180deg) scale(1.1)`, opacity: 1, offset: 0.45},
    {transform: `translate(${dx}px,${dy}px) rotateX(0deg) rotateY(360deg) scale(0.35)`,  opacity: 0, offset: 1},
  ], {duration: 420, easing: 'cubic-bezier(0.25,0.46,0.45,0.94)', fill: 'forwards'})
  .onfinish = () => flyEl.remove();
}

// ── Claim seat ─────────────────────────────────────────────
function claimSeat(sid) {
  gs.mySeatIds.push(sid);
  gs.gameStatus = 'betting';
  const mc = document.querySelector(`.bet-circle.main-bet[data-seat="${sid}"]`);
  if (mc) mc.classList.add('claimed');
  const tag = document.querySelector(`#seat-${sid} .seat-name-tag`);
  if (tag) { tag.textContent = playerName; tag.classList.remove('hidden'); }
  const deco = document.querySelector(`#seat-${sid} .seat-chip-deco`);
  if (deco) deco.style.display = 'none';
  const seat = document.getElementById('seat-' + sid);
  if (seat) seat.classList.add('my-seat');
  document.querySelectorAll('.seat').forEach(s => s.classList.remove('selected'));
  seat?.classList.add('selected');
  setStatus('Seat ' + sid + ' claimed! Pick a chip and click a circle');
}

// ── Chip click ─────────────────────────────────────────────
function onChipClick(chip) {
  gs.selectedChip = parseInt(chip.dataset.value);
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
  chip.classList.add('selected');
  setStatus('€' + gs.selectedChip.toLocaleString() + ' selected — click a betting circle');
}

// =============================================================
// UNDO
// =============================================================
function onUndo() {
  if (!betHistory.length) { setStatus('Nothing to undo'); return; }

  const lastEntry = betHistory[betHistory.length - 1];

  // If last item is rebet sentinel — remove it and restore rebet button
  if (lastEntry.isRebet) {
    betHistory.pop();
    _restoreRebetBtn();
    setStatus('Rebet cancelled');
    return;
  }

  // Check for rebet sentinel in stack — undo everything from it onward
  let rebetIdx = -1;
  for (let i = betHistory.length - 1; i >= 0; i--) {
    if (betHistory[i].isRebet) { rebetIdx = i; break; }
  }
  if (rebetIdx !== -1) {
    const toUndo = betHistory.splice(rebetIdx);
    for (const entry of toUndo) {
      if (entry.isRebet) continue;
      _undoEntry(entry);
    }
    _restoreRebetBtn();
    setStatus('Rebet fully undone');
    _checkEmptyBets();
    return;
  }

  // Normal undo — if last entry has a groupId, undo ALL entries with that same groupId
  const gid = lastEntry.groupId;
  if (gid) {
    // Remove all entries sharing this groupId
    const toUndo = betHistory.filter(e => e.groupId === gid);
    betHistory = betHistory.filter(e => e.groupId !== gid);
    for (const entry of toUndo) _undoEntry(entry);
    setStatus('Undone: mirrored bets (€' + toUndo.reduce((s,e)=>s+e.amt,0) + ' total)');
  } else {
    const entry = betHistory.pop();
    _undoEntry(entry);
    setStatus('Undone: €' + entry.amt + ' from Seat ' + entry.sid);
  }

  _checkEmptyBets();
}

function _restoreRebetBtn() {
  // Show rebet button again if we have previous round bets
  const hasLastBets = gs.mySeatIds.some(s => lastRoundBets[s]?.main > 0);
  if (hasLastBets) { show('btn-rebet'); hide('btn-2x'); }
}

function _checkEmptyBets() {
  if (totalBet === 0) {
    gs.gameStatus = 'idle';
    stopBetTimer();
    hide('deal-btn-wrap');
    hide('btn-clear');
  }
}

function _undoEntry(entry) {
  const { sid, type, amt } = entry;
  gs.bets[sid][type] -= amt;
  wallet   += amt;
  totalBet -= amt;
  if (totalBet < 0) totalBet = 0;
  updateWallet(true);
  updateBetHud();
  savePlayer();
  _refreshCircle(sid, type);
  _renderChipStack(sid, type);
  _autoSwitchChip();
  if (type === 'main' && gs.bets[sid].main === 0) {
    gs.activeSeats = gs.activeSeats.filter(s => s !== sid);
    if (gs.activeSeats.length === 0) { hide('deal-btn-wrap'); hide('btn-clear'); }
  }
}

// =============================================================
// REBET
// =============================================================
function onRebet() {
  if (!Object.keys(lastRoundBets).length) { setStatus('No previous bets to repeat'); return; }

  let needed = 0;
  for (const sid of gs.mySeatIds) {
    const p = lastRoundBets[sid];
    if (p) needed += p.main + p.pp + p.sp;
  }
  if (wallet < needed) { setStatus('Not enough balance for rebet!'); return; }

  betHistory.push({isRebet: true});

  for (const sid of gs.mySeatIds) {
    const prev = lastRoundBets[sid];
    if (!prev) continue;
    if (prev.main > 0 && wallet >= prev.main) _placeBet(sid, 'main', prev.main, false);
    if (prev.pp   > 0 && wallet >= prev.pp)   _placeBet(sid, 'pp',   prev.pp,   false);
    if (prev.sp   > 0 && wallet >= prev.sp)   _placeBet(sid, 'sp',   prev.sp,   false);
  }

  show('btn-2x');
  hide('btn-rebet');
  setStatus('Bets repeated — press 2× to double, or deal!');
}

// =============================================================
// 2× ALL
// =============================================================
function onDouble2x() {
  if (gs.gameStatus !== 'betting') return;

  let needed = 0;
  for (const sid of gs.mySeatIds) {
    needed += gs.bets[sid].main + gs.bets[sid].pp + gs.bets[sid].sp;
  }
  if (wallet < needed) { setStatus('Not enough balance to double all bets!'); return; }

  betHistory.push({isRebet: true});

  for (const sid of gs.mySeatIds) {
    const b = gs.bets[sid];
    if (b.main > 0 && wallet >= b.main) _placeBet(sid, 'main', b.main, false);
    if (b.pp   > 0 && wallet >= b.pp)   _placeBet(sid, 'pp',   b.pp,   false);
    if (b.sp   > 0 && wallet >= b.sp)   _placeBet(sid, 'sp',   b.sp,   false);
  }
  setStatus('All bets doubled!');
}

// =============================================================
// BET TIMER
// =============================================================
function startBetTimer() {
  if (betTimerInterval) return; // already running
  betTimerRemaining = settings.betTimerSeconds;
  show('bet-timer-wrap');
  _renderTimerBar();
  betTimerInterval = setInterval(() => {
    betTimerRemaining--;
    _renderTimerBar();
    if (betTimerRemaining <= 0) {
      stopBetTimer();
      if (gs.activeSeats.length > 0) onDeal();
    }
  }, 1000);
}

function stopBetTimer() {
  if (betTimerInterval) { clearInterval(betTimerInterval); betTimerInterval = null; }
  hide('bet-timer-wrap');
}

function _renderTimerBar() {
  const txt = document.getElementById('bet-timer-text');
  if (txt) txt.textContent = betTimerRemaining;
  const barEl = document.getElementById('bet-timer-bar');
  if (!barEl) return;
  let fill = barEl.querySelector('.timer-fill');
  if (!fill) {
    fill = document.createElement('div');
    fill.className = 'timer-fill';
    fill.style.cssText = 'position:absolute;inset:0;border-radius:2px;transform-origin:left;transition:transform 0.95s linear;';
    barEl.appendChild(fill);
  }
  const pct = betTimerRemaining / settings.betTimerSeconds;
  fill.style.transform  = `scaleX(${pct})`;
  fill.style.background = betTimerRemaining <= 5
    ? 'linear-gradient(90deg,#e53935,#ff5722)'
    : 'linear-gradient(90deg,#ffd700,#ff9800)';
}

// =============================================================
// CLEAR
// =============================================================
function onClear() {
  if (!['idle','betting'].includes(gs.gameStatus)) return;
  stopBetTimer();
  betHistory = [];

  for (let i = 1; i <= 5; i++) {
    wallet += gs.bets[i].main + gs.bets[i].pp + gs.bets[i].sp;
    gs.bets[i] = {main:0, pp:0, sp:0};
    gs.hands[i] = [];
    gs.splitActive[i] = false;
    gs.doubled[i] = false;
  }
  gs.hands.dealer = [];
  gs.activeSeats  = [];
  gs.selectedChip = null;
  gs.gameStatus   = 'idle';
  totalBet = 0;
  updateWallet(true);
  updateBetHud();
  savePlayer();

  document.querySelectorAll('.bet-circle').forEach(c => {
    const t = c.dataset.type;
    const lbl = c.querySelector('.bet-label');
    const amt = c.querySelector('.bet-amount');
    if (lbl) lbl.textContent = t === 'pp' ? 'PP' : t === 'sp' ? '21+3' : '';
    if (amt) amt.textContent = '';
    c.classList.remove('has-bet');
    c.querySelectorAll('.chip-stack').forEach(s => s.remove());
    c.querySelectorAll('.mult-bubble').forEach(b => b.remove());
  });
  document.querySelectorAll('.seat').forEach(s => {
    s.classList.remove('selected','active-turn','my-seat');
    s.style.cssText = '';
  });
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
  document.getElementById('dealer-hand').innerHTML = '';
  const ds = document.getElementById('dealer-score');
  if (ds) { ds.textContent = '0'; ds.classList.add('hidden'); }
  for (let i = 1; i <= 5; i++) {
    const h  = document.getElementById('hand-'  + i); if (h)  h.innerHTML = '';
    const sc = document.getElementById('score-' + i);
    if (sc) { sc.innerHTML = '<span class="bust-num">0</span><span class="bust-icon">💥</span>'; sc.classList.add('hidden'); sc.classList.remove('busted','show-icon'); }
    document.getElementById('seat-' + i)?.querySelectorAll('.result-badge').forEach(b => b.remove());
  }
  hideChipTray();
  hide('deal-btn-wrap');
  hide('btn-clear');
  hide('play-buttons');
  setStatus('Click a seat to claim it');
}

// =============================================================
// DEAL — always right-to-left (seat 5 → seat 1)
// =============================================================
async function onDeal() {
  if (gs.activeSeats.length === 0) { setStatus('Place a bet first!'); return; }
  if (!['betting'].includes(gs.gameStatus)) return;

  stopBetTimer();
  betHistory = [];

  lastRoundBets = {};
  for (const sid of gs.mySeatIds) {
    lastRoundBets[sid] = {...gs.bets[sid]};
  }

  gs.gameStatus = 'playing';
  hide('deal-btn-wrap');
  hide('btn-clear');
  hideChipTray();
  hide('play-buttons');
  hide('btn-rebet');
  hide('btn-2x');
  setStatus('Dealing…');

  for (const sid of gs.activeSeats) {
    gs.hands[sid]          = [];
    gs.splitActive[sid]    = false;
    gs.splitHandIndex[sid] = 0;
    gs.doubled[sid]        = false;
  }
  gs.hands.dealer = [];

  buildDeck();

  // Always right-to-left: highest seat number first
  const rtl = [...gs.activeSeats].map(Number).sort((a, b) => b - a).map(String);

  // Round 1
  for (const sid of rtl) { dealTo(sid); renderHand(sid, false); await delay(280); }
  dealTo('dealer'); renderDealer(false); await delay(280);
  // Round 2
  for (const sid of rtl) { dealTo(sid); renderHand(sid, true); await delay(280); }
  dealTo('dealer'); renderDealer(false); await delay(280);

  for (const sid of gs.activeSeats) {
    const sc = document.getElementById('score-' + sid);
    if (sc) sc.classList.remove('hidden');
    refreshScore(sid);
  }

  resolveSideBets();
  checkBJ();
}

// =============================================================
// DECK
// =============================================================
function buildDeck() {
  const S = ['S','H','D','C'];
  const V = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  let d = [];
  for (let n = 0; n < 6; n++)
    S.forEach(s => V.forEach(v => d.push({suit:s, value:v})));
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  gs.deck = d;
}

function dealTo(target) {
  const card = gs.deck.pop();
  if (!card) return;
  if (target === 'dealer') { gs.hands.dealer.push(card); return; }
  const sid = String(target);
  if (gs.splitActive[sid]) {
    gs.hands[sid]['hand' + (gs.splitHandIndex[sid] + 1)].push(card);
  } else {
    if (!Array.isArray(gs.hands[sid])) gs.hands[sid] = [];
    gs.hands[sid].push(card);
  }
}

// =============================================================
// SIDE BETS
// =============================================================
function resolveSideBets() {
  _roundSideBetWon = 0;  // reset for this round
  const dUp = gs.hands.dealer[0];
  for (const sid of gs.activeSeats) {
    const hand = Array.isArray(gs.hands[sid]) ? gs.hands[sid] : [];
    if (hand.length < 2) continue;

    if (gs.bets[sid].pp > 0) {
      const [c1, c2] = hand;
      if (c1.value === c2.value) {
        const sameSuit  = c1.suit === c2.suit;
        const sameColor = suitColor(c1.suit) === suitColor(c2.suit);
        const mult = sameSuit ? 25 : sameColor ? 12 : 6;
        const payout = gs.bets[sid].pp * (mult + 1);
        wallet += payout;
        _roundSideBetWon += payout;
        updateWallet(true);
        _showSideBetWin(sid, 'pp', mult, payout);
      }
    }

    if (gs.bets[sid].sp > 0 && dUp) {
      const three = [hand[0], hand[1], dUp];
      const mult = twentyOneThreePayout(three);
      if (mult > 0) {
        const payout = gs.bets[sid].sp * (mult + 1);
        wallet += payout;
        _roundSideBetWon += payout;
        updateWallet(true);
        _showSideBetWin(sid, 'sp', mult, payout);
      }
    }
  }
  savePlayer();
}

function _showSideBetWin(sid, type, mult, payout) {
  const circle = document.querySelector(`.bet-circle[data-seat="${sid}"][data-type="${type}"]`);
  if (!circle) return;
  // Convert chip stack to gold winner chip with payout amount
  circle.querySelectorAll('.chip-stack').forEach(s => s.remove());
  const winStack = document.createElement('div');
  winStack.className = 'chip-stack';
  const chipW = type === 'main' ? 58 : 38;
  const winChip = document.createElement('div');
  winChip.className = 'stacked-chip';
  winChip.style.cssText = `width:${chipW}px;height:${chipW}px;background:radial-gradient(circle at 35% 35%,#ffe066,#c8900a);bottom:4px;left:50%;transform:translateX(-50%);`;
  winStack.appendChild(winChip);
  const amtLabel = document.createElement('div');
  amtLabel.className = 'chip-stack-amt';
  amtLabel.style.color = '#ffd700';
  amtLabel.textContent = '+\u20ac' + (payout >= 1000 ? (payout/1000).toFixed(payout%1000===0?0:1)+'k' : payout);
  winStack.appendChild(amtLabel);
  circle.appendChild(winStack);
  _showMultBubble(circle, `${mult}:1`);
}

function _showMultBubble(circleEl, label) {
  circleEl.querySelectorAll('.mult-bubble').forEach(b => b.remove());
  const bubble = document.createElement('div');
  bubble.className = 'mult-bubble';
  bubble.textContent = label;
  circleEl.appendChild(bubble);
}

function suitColor(s) { return ['H','D'].includes(s) ? 'red' : 'black'; }

function cardFaceValue(c) {
  // Returns the face value string for comparison — treats 10/J/Q/K as distinct for trips
  return c.value; // 'A','2'–'10','J','Q','K'
}

function cardRank(c) {
  // Numeric rank for straight detection: A=1or14, 2-9, 10/J/Q/K=10,11,12,13
  const order = {'A':14,'K':13,'Q':12,'J':11,'10':10,'9':9,'8':8,'7':7,'6':6,'5':5,'4':4,'3':3,'2':2};
  return order[c.value] ?? 0;
}

function twentyOneThreePayout(cards) {
  const suits  = cards.map(c => c.suit);
  const allSameSuit = suits.every(s => s === suits[0]);

  // Trips: all three cards have same face value (J+J+J, not J+Q+K)
  const isTrips = cards[0].value === cards[1].value && cards[1].value === cards[2].value;

  // Straight: consecutive ranks, allow A-2-3 and Q-K-A wraps
  const ranks  = cards.map(cardRank).sort((a,b) => a-b);
  const isStraight = (ranks[2]-ranks[1] === 1 && ranks[1]-ranks[0] === 1) ||
                     // Ace-low: A=1, so check [1,2,3] → ranks would be [2,3,14] after sort → check separately
                     (ranks[0] === 2 && ranks[1] === 3 && ranks[2] === 14);

  if (allSameSuit && isTrips)    return 100;
  if (allSameSuit && isStraight) return 40;
  if (isTrips)                   return 30;
  if (isStraight)                return 10;
  if (allSameSuit)               return 5;
  return 0;
}

function cardNum(c) {
  if (['J','Q','K'].includes(c.value)) return 10;
  if (c.value === 'A')                 return 11;
  return parseInt(c.value);
}

// =============================================================
// BLACKJACK CHECK
// =============================================================
function checkBJ() {
  const dBJ    = score(gs.hands.dealer) === 21 && gs.hands.dealer.length === 2;
  const dUpAce = gs.hands.dealer[0]?.value === 'A';

  const dScEl = document.getElementById('dealer-score');
  if (dScEl) {
    dScEl.innerHTML = `<span class="bust-num">${cardNum(gs.hands.dealer[0])}</span>`;
    dScEl.classList.remove('hidden');
  }

  if (dUpAce) {
    offerInsurance(() => {
      resolveInsurance(dBJ);
      if (!dBJ) proceedAfterInsurance();
    });
    return;
  }

  if (dBJ) {
    renderDealer(true);
    for (const sid of gs.activeSeats) {
      const pBJ = score(gs.hands[sid]) === 21 && gs.hands[sid].length === 2;
      if (pBJ) { wallet += gs.bets[sid].main; badge(sid, 'push', 'Push'); }
      else       badge(sid, 'lose', 'D.BJ');
    }
    updateWallet(true); savePlayer();
    endRound('Dealer Blackjack!');
    return;
  }

  proceedAfterInsurance();
}

function proceedAfterInsurance() {
  for (const sid of gs.activeSeats) {
    const pBJ = score(gs.hands[sid]) === 21 && gs.hands[sid].length === 2;
    if (pBJ) {
      wallet += Math.floor(gs.bets[sid].main * 2.5);
      badge(sid, 'bj', 'Blackjack!');
      updateWallet(true);
    }
  }
  savePlayer();
  gs.currentSeatIndex = 0;
  nextTurn();
}

// =============================================================
// INSURANCE
// =============================================================
function offerInsurance(callback) {
  gs.insurance = {};
  const modal    = document.getElementById('insurance-modal');
  const seatsDiv = document.getElementById('insurance-seats');
  seatsDiv.innerHTML = '';

  for (const sid of gs.activeSeats) {
    const insAmt = Math.floor(gs.bets[sid].main / 2);
    gs.insurance[sid] = 0; // default: no insurance
    const canAfford = wallet >= insAmt;

    const row = document.createElement('div');
    row.className = 'insurance-seat-row ins-selected-no';
    row.innerHTML = `
      <div class="insurance-seat-info">
        <div class="insurance-seat-label">Seat ${sid}</div>
        <div class="insurance-seat-bet">Cost: €${insAmt}${!canAfford ? ' <span style="color:#e05050;font-size:.65rem">(insufficient funds)</span>' : ''}</div>
      </div>
      <div class="insurance-btns">
        <button class="ins-yes${!canAfford ? ' ins-disabled' : ''}" data-sid="${sid}" data-amt="${insAmt}"${!canAfford ? ' disabled' : ''}>
          <span class="ins-icon">✓</span> Insure
        </button>
        <button class="ins-no active" data-sid="${sid}">
          <span class="ins-icon">✕</span> Decline
        </button>
      </div>`;
    seatsDiv.appendChild(row);
  }

  seatsDiv.querySelectorAll('.ins-yes, .ins-no').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled || btn.classList.contains('ins-disabled')) return;
      const sid = btn.dataset.sid;
      const row = btn.closest('.insurance-seat-row');
      row.querySelectorAll('.ins-yes, .ins-no').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.classList.contains('ins-yes')) {
        const insAmt = parseInt(btn.dataset.amt);
        if (wallet >= insAmt) {
          gs.insurance[sid] = insAmt;
          row.className = 'insurance-seat-row ins-selected-yes';
        } else {
          btn.classList.remove('active');
          row.querySelector('.ins-no').classList.add('active');
          gs.insurance[sid] = 0;
          row.className = 'insurance-seat-row ins-selected-no';
          setStatus('Not enough balance for insurance');
        }
      } else {
        gs.insurance[sid] = 0;
        row.className = 'insurance-seat-row ins-selected-no';
      }
    });
  });

  document.getElementById('insurance-confirm').onclick = () => {
    for (const sid of gs.activeSeats) {
      if (gs.insurance[sid] > 0) {
        wallet   -= gs.insurance[sid];
        totalBet += gs.insurance[sid];
      }
    }
    updateWallet(true); updateBetHud(); savePlayer();
    modal.classList.add('hidden');
    callback();
  };

  modal.classList.remove('hidden');
}

function resolveInsurance(dealerHasBJ) {
  if (!gs.insurance) return;
  for (const sid of gs.activeSeats) {
    const insAmt = gs.insurance[sid] || 0;
    if (insAmt > 0 && dealerHasBJ) {
      wallet += insAmt * 3;
      badge(sid, 'win', 'Insurance 2:1');
    }
  }
  if (dealerHasBJ) {
    renderDealer(true);
    for (const sid of gs.activeSeats) {
      const pBJ = score(gs.hands[sid]) === 21 && gs.hands[sid].length === 2;
      if (pBJ) { wallet += gs.bets[sid].main; badge(sid, 'push', 'Push'); }
      else       badge(sid, 'lose', 'D.BJ');
    }
    updateWallet(true); savePlayer();
    endRound('Dealer Blackjack!');
  } else {
    updateWallet(true); savePlayer();
  }
}

// =============================================================
// TURNS
// =============================================================
function nextTurn() {
  const rtl = [...gs.activeSeats].map(Number).sort((a, b) => b - a).map(String);

  while (gs.currentSeatIndex < rtl.length) {
    const sid = rtl[gs.currentSeatIndex];
    if (gs.stoodSeats.has(sid)) { gs.currentSeatIndex++; continue; }
    const bjBadge = document.querySelector(`#seat-${sid} .result-badge.bj`);
    if (bjBadge) { gs.currentSeatIndex++; continue; }
    startTurn(sid);
    return;
  }
  dealerTurn();
}

function startTurn(sid) {
  document.querySelectorAll('.seat').forEach(s => s.classList.remove('active-turn'));
  document.getElementById('seat-' + sid)?.classList.add('active-turn');
  setStatus('Seat ' + sid + ' — your turn');

  const hand = gs.splitActive[sid]
    ? gs.hands[sid]['hand' + (gs.splitHandIndex[sid] + 1)]
    : gs.hands[sid];

  if (!Array.isArray(hand)) { endTurn(sid); return; }

  const sc = score(hand);
  if (sc > 21)  { bust(sid); return; }
  if (sc === 21) { endTurn(sid); return; }

  const canDouble = hand.length === 2 && wallet >= gs.bets[sid].main && !gs.doubled[sid];
  const canSplit  = hand.length === 2 && cardNum(hand[0]) === cardNum(hand[1])
                    && !gs.splitActive[sid] && wallet >= gs.bets[sid].main;

  document.getElementById('btn-double').classList.toggle('hidden', !canDouble);
  document.getElementById('btn-split').classList.toggle('hidden',  !canSplit);
  document.getElementById('btn-hit').classList.remove('hidden');
  show('play-buttons');
}

async function onAction(action) {
  const rtl = [...gs.activeSeats].map(Number).sort((a, b) => b - a).map(String);
  const sid  = rtl[gs.currentSeatIndex];
  if (!sid) return;

  if (action === 'hit') {
    hide('play-buttons');
    await delay(600);
    dealTo(sid);
    renderHand(sid, true);
    refreshScore(sid);
    const currentHand = gs.splitActive[sid]
      ? gs.hands[sid]['hand' + (gs.splitHandIndex[sid] + 1)]
      : gs.hands[sid];
    const sc = score(currentHand);
    if (sc > 21) { await bust(sid); return; }
    if (sc === 21) { await advanceOrStand(sid); return; }
    document.getElementById('btn-double').classList.add('hidden');
    document.getElementById('btn-split').classList.add('hidden');
    document.getElementById('btn-hit').classList.remove('hidden');
    show('play-buttons');

  } else if (action === 'stand') {
    await advanceOrStand(sid);

  } else if (action === 'double') {
    hide('play-buttons');
    const extraBet = gs.bets[sid].main;
    wallet   -= extraBet;
    totalBet += extraBet;
    gs.bets[sid].main *= 2;
    updateWallet(true); updateBetHud(); savePlayer();
    gs.doubled[sid] = true;
    await delay(600);
    dealTo(sid);
    renderHand(sid, true);
    refreshScore(sid);
    const currentHand = gs.splitActive[sid]
      ? gs.hands[sid]['hand' + (gs.splitHandIndex[sid] + 1)]
      : gs.hands[sid];
    const sc = score(currentHand);
    if (sc > 21) { await bust(sid); return; }
    await advanceOrStand(sid);

  } else if (action === 'split') {
    hide('play-buttons');
    const hand = gs.hands[sid];
    if (!Array.isArray(hand) || hand.length !== 2) return;
    wallet   -= gs.bets[sid].main;
    totalBet += gs.bets[sid].main;
    updateWallet(true); updateBetHud(); savePlayer();

    const c1 = hand[0], c2 = hand[1];
    const n1 = gs.deck.pop();
    const n2 = gs.deck.pop();
    gs.hands[sid] = {
      hand1: [c1, n1],
      hand2: [c2, n2]
    };
    gs.splitActive[sid]    = true;
    gs.splitHandIndex[sid] = 0;
    renderHand(sid, false);
    refreshScore(sid);
    document.getElementById('btn-double').classList.add('hidden');
    document.getElementById('btn-split').classList.add('hidden');
    document.getElementById('btn-hit').classList.remove('hidden');
    show('play-buttons');
  }
}

async function advanceOrStand(sid) {
  if (gs.splitActive[sid] && gs.splitHandIndex[sid] === 0) {
    // Mark hand1 as stood visually — update its pill to show final score (no slash)
    const h1El = document.getElementById(`score-${sid}-hand1`);
    if (h1El) {
      const s = _calcScore(gs.hands[sid].hand1);
      h1El.innerHTML = `<span class="bust-num">${s}</span><span class="bust-icon">💥</span>`;
      h1El.classList.remove('hidden');
    }
    gs.splitHandIndex[sid] = 1;
    renderHand(sid, false);
    refreshScore(sid);
    setStatus('Seat ' + sid + ' — Hand 2');
    document.getElementById('btn-double').classList.add('hidden');
    document.getElementById('btn-split').classList.add('hidden');
    document.getElementById('btn-hit').classList.remove('hidden');
    show('play-buttons');
    return;
  }
  endTurn(sid);
}

function _calcScore(hand) {
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

async function bust(sid) {
  // Target correct score pill — split hands have their own pills
  const hk = gs.splitActive[sid] ? 'hand' + (gs.splitHandIndex[sid] + 1) : null;
  const scElId = hk ? `score-${sid}-${hk}` : `score-${sid}`;
  const scEl = document.getElementById(scElId);

  if (scEl) {
    const bustHand = hk ? gs.hands[sid][hk] : gs.hands[sid];
    const bustVal = score(bustHand);
    scEl.classList.add('busted');
    scEl.innerHTML = `<span class="bust-num">${bustVal}</span><span class="bust-icon">💥</span>`;
    setTimeout(() => scEl.classList.add('show-icon'), 800);
  }
  await delay(500);
  if (gs.splitActive[sid] && gs.splitHandIndex[sid] === 0) {
    await advanceOrStand(sid);
    return;
  }
  endTurn(sid);
}

function endTurn(sid) {
  gs.stoodSeats.add(String(sid));
  // Refresh score display — drops "X/" from soft hands now that player stood
  refreshScore(sid);
  gs.currentSeatIndex++;
  hide('play-buttons');
  setTimeout(nextTurn, 400);
}

// =============================================================
// DEALER TURN
// =============================================================
async function dealerTurn() {
  gs.gameStatus = 'dealer_turn';
  document.querySelectorAll('.seat').forEach(s => s.classList.remove('active-turn'));
  hide('play-buttons');
  renderDealer(true);
  const dScEl = document.getElementById('dealer-score');
  if (dScEl) { dScEl.innerHTML = `<span class='bust-num'>${score(gs.hands.dealer)}</span>`; dScEl.classList.remove('hidden'); }
  await delay(800);

  let ds = score(gs.hands.dealer);
  while (ds < 17) {
    dealTo('dealer');
    renderDealer(true);
    ds = score(gs.hands.dealer);
    if (dScEl) dScEl.innerHTML = `<span class='bust-num'>${ds}</span>`;
    await delay(680);
  }
  if (dScEl) { dScEl.innerHTML = `<span class='bust-num'>${ds}</span>`; dScEl.classList.remove('hidden'); }
  resolveMain();
}

function isSoft17(hand) {
  if (!Array.isArray(hand)) return false;
  let total = 0, aces = 0;
  for (const c of hand) {
    if (['J','Q','K'].includes(c.value)) total += 10;
    else if (c.value === 'A') { total += 11; aces++; }
    else total += parseInt(c.value);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total === 17 && aces > 0;
}

// =============================================================
// RESOLVE MAIN BETS
// =============================================================
function resolveMain() {
  const ds    = score(gs.hands.dealer);
  const dBust = ds > 21;

  let totalWon = 0; // total money returned to wallet from main bets this round

  for (const sid of gs.activeSeats) {
    // BJ already paid in proceedAfterInsurance — just count for banner
    const bjBadge = document.querySelector(`#seat-${sid} .result-badge.bj`);
    if (bjBadge) {
      totalWon += Math.floor(gs.bets[sid].main * 2.5);
      continue;
    }

    if (gs.splitActive[sid]) {
      const half = Math.floor(gs.bets[sid].main / 2);
      ['hand1','hand2'].forEach(hk => {
        const ps = score(gs.hands[sid][hk]);
        if (ps > 21) return; // bust — lose, no payout
        if (dBust || ps > ds) {
          wallet += half * 2; totalWon += half * 2;
          badge(sid, 'win', 'Win');
        } else if (ps === ds) {
          wallet += half; totalWon += half;
          badge(sid, 'push', 'Push');
        } else {
          badge(sid, 'lose', 'Lose');
        }
      });
    } else {
      const ps = score(Array.isArray(gs.hands[sid]) ? gs.hands[sid] : []);
      if (ps > 21) { badge(sid, 'lose', 'Bust'); continue; } // bust — lose
      if (dBust || ps > ds) {
        const payout = gs.bets[sid].main * 2;
        wallet += payout; totalWon += payout;
        badge(sid, 'win', 'Win!');
      } else if (ps === ds) {
        wallet += gs.bets[sid].main; totalWon += gs.bets[sid].main;
        badge(sid, 'push', 'Push');
      } else {
        badge(sid, 'lose', 'Lose');
      }
    }
  }
  updateWallet(true);
  savePlayer();

  const grandTotal = totalWon + _roundSideBetWon;
  if (grandTotal > 0) showRoundResult(grandTotal);

  endRound('Round over');
}

function showRoundResult(amount) {
  document.querySelectorAll('.round-result-overlay').forEach(e => e.remove());
  if (amount <= 0) return;

  const overlay = document.createElement('div');
  overlay.className = 'round-result-overlay';
  overlay.innerHTML = `
    <div class="rr-label">You Win!</div>
    <div class="rr-amount">€${amount.toLocaleString()}</div>
  `;
  document.getElementById('game-container').appendChild(overlay);
  setTimeout(() => overlay.classList.add('rr-fadeout'), 1800);
  setTimeout(() => overlay.remove(), 2600);
}

// =============================================================
// END ROUND
// =============================================================
function endRound(msg) {
  gs.gameStatus = 'game_over';
  setStatus(msg + ' — New round in ' + settings.autoRoundDelay + 's…');
  hide('play-buttons');
  // Fly cards to discard pile after a short pause
  setTimeout(() => flyCardsOut(), (settings.autoRoundDelay * 1000) - 600);
  setTimeout(() => {
    if (gs.gameStatus === 'game_over') onNewRound();
  }, settings.autoRoundDelay * 1000);
}

function flyCardsOut() {
  document.querySelectorAll('#dealer-hand .card, #dealer-hand .card-back, .player-hand .card, .player-hand .card-back').forEach((card, i) => {
    card.style.animationDelay = (i * 0.04) + 's';
    card.classList.add('fly-out');
  });
}

// =============================================================
// NEW ROUND
// =============================================================
function onNewRound() {
  const savedSeats = [...gs.mySeatIds];
  resetState();
  betHistory   = [];
  gs.mySeatIds = savedSeats;
  gs.gameStatus = 'betting';

  document.querySelectorAll('.bet-circle').forEach(c => {
    const t   = c.dataset.type;
    const lbl = c.querySelector('.bet-label');
    const amt = c.querySelector('.bet-amount');
    if (lbl) lbl.textContent = t === 'pp' ? 'PP' : t === 'sp' ? '21+3' : '';
    if (amt) amt.textContent = '';
    c.classList.remove('has-bet');
    c.querySelectorAll('.chip-stack').forEach(s => s.remove());
    c.querySelectorAll('.mult-bubble').forEach(b => b.remove());
    if (t === 'main' && savedSeats.includes(c.dataset.seat)) {
      c.classList.add('claimed');
    } else {
      c.classList.remove('claimed');
    }
  });

  for (let i = 1; i <= 5; i++) {
    const seat    = document.getElementById('seat-' + i);
    const tag     = document.querySelector(`#seat-${i} .seat-name-tag`);
    const deco    = document.querySelector(`#seat-${i} .seat-chip-deco`);
    const overlay = document.querySelector(`#seat-${i} .claim-overlay`);
    // Clear ALL inline styles so CSS positions take effect again
    if (seat) seat.style.cssText = '';
    if (savedSeats.includes(String(i))) {
      if (seat)    seat.classList.add('my-seat');
      if (tag)     { tag.textContent = playerName; tag.classList.remove('hidden'); }
      if (deco)    deco.style.display = 'none';
      if (overlay) overlay.style.display = 'none';
    } else {
      if (tag)     tag.classList.add('hidden');
      if (deco)    deco.style.display = '';
      if (overlay) overlay.style.display = '';
    }
  }

  document.querySelectorAll('.seat').forEach(s => s.classList.remove('selected','active-turn'));
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
  document.getElementById('dealer-hand').innerHTML = '';
  const ds = document.getElementById('dealer-score');
  if (ds) { ds.textContent = '0'; ds.classList.add('hidden'); }
  for (let i = 1; i <= 5; i++) {
    const h  = document.getElementById('hand-'  + i); if (h)  h.innerHTML = '';
    const sc = document.getElementById('score-' + i);
    if (sc) { sc.innerHTML = '<span class="bust-num">0</span><span class="bust-icon">💥</span>'; sc.classList.add('hidden'); sc.classList.remove('busted','show-icon'); }
    document.getElementById('seat-' + i)?.querySelectorAll('.result-badge').forEach(b => b.remove());
  }

  hide('play-buttons');
  updateBetHud();

  const hasLastBets = savedSeats.some(s => lastRoundBets[s]?.main > 0);
  if (hasLastBets && savedSeats.length > 0) show('btn-rebet'); else hide('btn-rebet');
  hide('btn-2x');

  if (savedSeats.length > 0) {
    showChipTray();
    show('btn-clear');
    document.getElementById('seat-' + savedSeats[0])?.classList.add('selected');
    setStatus('New round — place your bets!');
  } else {
    setStatus('Click a seat to claim it');
  }
}

// =============================================================
// SCORE
// =============================================================
function score(hand) {
  if (!Array.isArray(hand)) return 0;
  let s = 0, aces = 0;
  for (const c of hand) {
    if (['J','Q','K'].includes(c.value)) s += 10;
    else if (c.value === 'A') { aces++; s += 11; }
    else s += parseInt(c.value) || 0;
  }
  while (s > 21 && aces > 0) { s -= 10; aces--; }
  return s;
}

// =============================================================
// RENDER HANDS
// =============================================================
function renderHand(sid, newCardOnly) {
  const el = document.getElementById('hand-' + sid);
  if (!el) return;

  if (gs.splitActive[sid]) {
    el.innerHTML = '';
    el.classList.add('split-mode');
    const wrap = document.createElement('div');
    wrap.className = 'split-hands';

    ['hand1', 'hand2'].forEach((hk, idx) => {
      const h = gs.hands[sid][hk] || [];
      const isActive = idx === gs.splitHandIndex[sid];

      const col = document.createElement('div');
      col.className = 'split-col' + (isActive ? ' active-split-col' : '');
      col.dataset.hand = hk;

      // Per-hand score pill
      const scorePill = document.createElement('div');
      scorePill.className = 'score-display split-score';
      scorePill.id = 'score-' + sid + '-' + hk;
      const sv = _calcScoreLabel(h);
      scorePill.innerHTML = '<span class="bust-num">' + sv + '</span><span class="bust-icon">💥</span>';
      if (h.length === 0) scorePill.classList.add('hidden');

      const handDiv = document.createElement('div');
      handDiv.className = 'split-hand' + (isActive ? ' active-split' : '');
      h.forEach((c, i) => {
        const card = mkCard(c, true, i);
        if (i < h.length - 1) card.style.animation = 'none';
        handDiv.appendChild(card);
      });

      col.appendChild(scorePill);
      col.appendChild(handDiv);
      wrap.appendChild(col);
    });

    el.appendChild(wrap);

  } else {
    el.classList.remove('split-mode');
    const hand = Array.isArray(gs.hands[sid]) ? gs.hands[sid] : [];
    if (newCardOnly && el.childElementCount === hand.length - 1) {
      const c = hand[hand.length - 1];
      el.appendChild(mkCard(c, true, hand.length - 1));
    } else {
      el.innerHTML = '';
      hand.forEach((c, i) => {
        const card = mkCard(c, true, i);
        if (i < hand.length - 1) card.style.animation = 'none';
        el.appendChild(card);
      });
    }
  }
}

function _calcScoreLabel(hand) {
  if (!Array.isArray(hand) || hand.length === 0) return '0';
  let total = 0, aces = 0;
  for (const c of hand) {
    if (['J','Q','K'].includes(c.value)) total += 10;
    else if (c.value === 'A') { aces++; total += 11; }
    else total += parseInt(c.value) || 0;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  // Show soft hand as X/Y unless 21 or stood
  if (aces > 0 && total !== 21) {
    return (total - 10) + '/' + total;
  }
  return String(total);
}


function renderDealer(reveal) {
  const el = document.getElementById('dealer-hand');
  if (!el) return;
  el.innerHTML = '';
  gs.hands.dealer.forEach((c, i) => {
    if (i === 1 && !reveal) {
      const back = document.createElement('div');
      back.className = 'card-back';
      back.style.animationDelay = (i * 0.08) + 's';
      el.appendChild(back);
    } else {
      el.appendChild(mkCard(c, false, i));
    }
  });
}

function mkCard(c, small, idx) {
  const div = document.createElement('div');
  div.className = 'card';
  div.style.animationDelay = (idx * 0.08) + 's';
  const code = (c.value === '10' ? '0' : c.value) + c.suit;
  const img  = document.createElement('img');
  img.src = 'https://deckofcardsapi.com/static/img/' + code + '.png';
  img.alt = c.value + c.suit;
  img.onerror = () => {
    div.removeChild(img);
    div.style.cssText += ';background:#fff;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;color:' + (['H','D'].includes(c.suit) ? '#c00' : '#111');
    div.textContent = c.value + ({S:'♠',H:'♥',D:'♦',C:'♣'}[c.suit]||'');
  };
  div.appendChild(img);
  return div;
}

function refreshScore(sid) {
  if (gs.splitActive[sid]) {
    // Update BOTH split hand pills
    ['hand1','hand2'].forEach((hk, idx) => {
      const el = document.getElementById('score-' + sid + '-' + hk);
      if (!el) return;
      const hand = gs.hands[sid][hk] || [];
      if (hand.length === 0) { el.classList.add('hidden'); return; }
      const label = _calcScoreLabel(hand);
      el.innerHTML = `<span class="bust-num">${label}</span><span class="bust-icon">💥</span>`;
      el.classList.remove('hidden');
    });
    // Also hide the main seat score pill during split
    const mainEl = document.getElementById('score-' + sid);
    if (mainEl) mainEl.classList.add('hidden');
    return;
  }

  const el = document.getElementById('score-' + sid);
  if (!el) return;
  const hand = Array.isArray(gs.hands[sid]) ? gs.hands[sid] : [];
  if (!hand.length) return;

  let hardTotal = 0, aces = 0;
  for (const c of hand) {
    if (['J','Q','K'].includes(c.value)) hardTotal += 10;
    else if (c.value === 'A') { aces++; hardTotal += 11; }
    else hardTotal += parseInt(c.value) || 0;
  }
  while (hardTotal > 21 && aces > 0) { hardTotal -= 10; aces--; }

  let label;
  const isStood = gs.stoodSeats && gs.stoodSeats.has(String(sid));
  if (aces > 0 && hardTotal !== 21 && !isStood) {
    label = `${hardTotal - 10}/${hardTotal}`;
  } else {
    label = `${hardTotal}`;
  }
  el.innerHTML = `<span class="bust-num">${label}</span><span class="bust-icon">💥</span>`;
  el.classList.remove('hidden');
}

// =============================================================
// BADGES — never touch seat.style.position
// =============================================================
function badge(sid, cls, text) {
  const seat = document.getElementById('seat-' + sid);
  if (!seat) return;
  seat.querySelectorAll('.result-badge.' + cls).forEach(b => b.remove());
  const b = document.createElement('div');
  b.className = 'result-badge ' + cls;
  b.textContent = text;
  seat.appendChild(b);
}