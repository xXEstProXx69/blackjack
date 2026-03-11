// =============================================================
// BLACKJACK MULTIPLAYER — client.js — v3 Full Fix
// =============================================================

const socket = io();

let mySocketId   = null;
let myName       = '';
let myWallet     = 5000;
let roomCode     = null;
let selectedChip = 100;
let activeTurnSid = null;
let activeSplitHandIndex = 0;
let prevGs       = null;
let isHost       = false;
let actionPending = false;

// Track card counts to avoid re-animating existing cards
const prevCardCounts = {}; // { 'dealer': n, '1': n, '1-hand1': n, ... }

// ── AUTH (localStorage) ───────────────────────────────────────
const STORAGE_KEY = 'bj_player';

function loadSavedPlayer() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function savePlayer(email, name) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ email, name }));
}

function clearPlayer() {
  localStorage.removeItem(STORAGE_KEY);
}

// ── SFX ───────────────────────────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let sfxVolume = 0.5;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioCtx();
  return audioCtx;
}

function playTone(freq, type, dur, vol, delay=0) {
  if (sfxVolume === 0) return;
  try {
    const ctx = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
    gain.gain.setValueAtTime(vol * sfxVolume, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + dur);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + dur);
  } catch(e) {}
}

// Realistic card deal sound — layered noise burst + low thud
function playCardSound() {
  if (sfxVolume === 0) return;
  try {
    const ctx = getAudioCtx();
    // High freq swish
    const swishBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate);
    const swishData = swishBuf.getChannelData(0);
    for (let i = 0; i < swishData.length; i++) swishData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / swishData.length, 2);
    const swishSrc = ctx.createBufferSource(); swishSrc.buffer = swishBuf;
    const swishFilter = ctx.createBiquadFilter(); swishFilter.type = 'bandpass'; swishFilter.frequency.value = 4200; swishFilter.Q.value = 1.2;
    const swishGain = ctx.createGain(); swishGain.gain.setValueAtTime(0.55 * sfxVolume, ctx.currentTime);
    swishGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.10);
    swishSrc.connect(swishFilter); swishFilter.connect(swishGain); swishGain.connect(ctx.destination);
    swishSrc.start();
    // Low felt thud
    const thudOsc = ctx.createOscillator(); thudOsc.type = 'sine'; thudOsc.frequency.setValueAtTime(180, ctx.currentTime); thudOsc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.06);
    const thudGain = ctx.createGain(); thudGain.gain.setValueAtTime(0.30 * sfxVolume, ctx.currentTime); thudGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.07);
    thudOsc.connect(thudGain); thudGain.connect(ctx.destination);
    thudOsc.start(); thudOsc.stop(ctx.currentTime + 0.08);
  } catch(e) {}
}

// Chip clink — bright metallic
function playChipSound() {
  if (sfxVolume === 0) return;
  playTone(2200, 'sine', 0.06, 0.25);
  playTone(3100, 'sine', 0.04, 0.15, 0.015);
  playTone(1600, 'sine', 0.03, 0.18, 0.03);
}

const SFX = {
  card:      () => playCardSound(),
  chip:      () => playChipSound(),
  // Blackjack fanfare — ascending major arpeggio
  blackjack: () => {
    const notes = [523, 659, 784, 1047, 1319];
    notes.forEach((f, i) => playTone(f, 'sine', 0.35, 0.28, i * 0.09));
    // final shimmer
    setTimeout(() => {
      [1568, 2093].forEach((f, i) => playTone(f, 'sine', 0.2, 0.18, i * 0.06));
    }, 500);
  },
  // Win — upbeat 3-note
  win: () => {
    [523, 784, 1047].forEach((f, i) => playTone(f, 'sine', 0.25, 0.22, i * 0.1));
  },
  // Lose — descending
  lose: () => {
    [300, 240, 180].forEach((f, i) => playTone(f, 'triangle', 0.22, 0.22, i * 0.13));
  },
  // Bust — thud
  bust: () => {
    playTone(120, 'sawtooth', 0.18, 0.35);
    playTone(80,  'sine',     0.15, 0.28, 0.06);
  },
  // Deal button click
  deal: () => {
    playTone(440, 'sine', 0.08, 0.2);
    playTone(660, 'sine', 0.06, 0.14, 0.06);
  },
  // Countdown tick (last 5s)
  tick: () => {
    playTone(880, 'square', 0.04, 0.12);
  },
};

// ── Utils ─────────────────────────────────────────────────────
const CHIP_COLORS = {
  1:'#e8e8e8,#b0b0b0', 2:'#d0d0d0,#888', 5:'#e03030,#900',
  10:'#1a7ad4,#0a4a9a', 25:'#2da84e,#155a28', 50:'#c07020,#804010',
  100:'#222,#111', 200:'#b050f0,#6000b0', 500:'#8030a0,#400060',
  1000:'#e0b000,#a07000', 2000:'#e07030,#c03000',
  5000:'#10b0b0,#006060', 10000:'#f050a0,#900040',
};

const $ = id => document.getElementById(id);
const show = id => $(id)?.classList.remove('hidden');
const hide = id => $(id)?.classList.add('hidden');

function fmtAmt(n) {
  if (n >= 1000) return '€' + (n/1000).toFixed(n%1000===0?0:1) + 'k';
  return '€' + n;
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

function scoreLabel(hand, stood) {
  if (!Array.isArray(hand) || !hand.length) return '';
  let total = 0, aces = 0;
  for (const c of hand) {
    if (['J','Q','K'].includes(c.value)) total += 10;
    else if (c.value === 'A') { aces++; total += 11; }
    else total += parseInt(c.value) || 0;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  if (aces > 0 && total !== 21 && !stood) return `${total-10}/${total}`;
  return String(total);
}

function cardNum(c) {
  if (['J','Q','K'].includes(c.value)) return 10;
  if (c.value === 'A') return 11;
  return parseInt(c.value);
}

// ── Auth / Registration ────────────────────────────────────────
function initAuth() {
  const saved = loadSavedPlayer();
  if (saved) {
    // Auto-fill lobby
    if ($('lobby-name')) $('lobby-name').value = saved.name;
    // Show "logged in as" banner
    const banner = $('auth-banner');
    if (banner) {
      banner.textContent = `👤 ${saved.name} (${saved.email})`;
      banner.classList.remove('hidden');
    }
    const logoutBtn = $('auth-logout');
    if (logoutBtn) logoutBtn.classList.remove('hidden');
  }
}

$('btn-show-register')?.addEventListener('click', () => {
  hide('lobby-screen');
  show('register-screen');
});

$('btn-register-back')?.addEventListener('click', () => {
  hide('register-screen');
  show('lobby-screen');
});

$('btn-register-submit')?.addEventListener('click', () => {
  const email = $('reg-email').value.trim();
  const name  = $('reg-name').value.trim();
  if (!email || !name) { showRegError('Please fill in all fields'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showRegError('Enter a valid email'); return; }
  savePlayer(email, name);
  // Fill lobby name
  if ($('lobby-name')) $('lobby-name').value = name;
  hide('register-screen');
  show('lobby-screen');
  initAuth();
});

$('auth-logout')?.addEventListener('click', () => {
  clearPlayer();
  if ($('lobby-name')) $('lobby-name').value = '';
  hide('auth-banner');
  hide('auth-logout');
});

function showRegError(msg) {
  const el = $('reg-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Lobby ─────────────────────────────────────────────────────
$('btn-create-room').addEventListener('click', () => {
  const name = $('lobby-name').value.trim();
  if (!name) { showLobbyError('Enter your name first'); return; }
  myName = name;
  // Auto-save if not saved yet
  const saved = loadSavedPlayer();
  if (!saved) savePlayer('', name);
  socket.emit('createRoom', { name, wallet: 5000 });
});

$('btn-join-room').addEventListener('click', () => {
  const name = $('lobby-name').value.trim();
  const code = $('lobby-code-input').value.trim().toUpperCase();
  if (!name) { showLobbyError('Enter your name first'); return; }
  if (code.length !== 4) { showLobbyError('Enter a 4-digit room code'); return; }
  myName = name;
  if (!loadSavedPlayer()) savePlayer('', name);
  socket.emit('joinRoom', { code, name, wallet: 5000 });
});

$('lobby-code-input').addEventListener('keydown', e => { if (e.key==='Enter') $('btn-join-room').click(); });
$('lobby-name').addEventListener('keydown', e => { if (e.key==='Enter') $('btn-create-room').click(); });

$('btn-start-game').addEventListener('click', () => { socket.emit('startGame'); });
$('btn-leave-room').addEventListener('click', () => { location.reload(); });

// X button in waiting room — leave room
$('btn-close-waiting')?.addEventListener('click', () => { location.reload(); });

function showLobbyError(msg) {
  const el = $('lobby-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Socket Events ─────────────────────────────────────────────
socket.on('roomJoined', ({ code, socketId, isHost: hostFlag }) => {
  mySocketId = socketId;
  roomCode   = code;
  isHost     = hostFlag;
  hide('lobby-screen');
  show('waiting-screen');
  $('waiting-code').textContent = code;
  $('room-badge-code').textContent = code;
  updateWaitingHostUI();
});

socket.on('becameHost', () => {
  isHost = true;
  updateWaitingHostUI();
  const notif = document.createElement('div');
  notif.className = 'host-notif';
  notif.textContent = '👑 You are now the host';
  document.body.appendChild(notif);
  setTimeout(() => notif.remove(), 3000);
});

socket.on('launchGame', () => {
  hide('waiting-screen');
  show('game-container');
  show('chip-tray');
  $('player-greeting').textContent = myName;
  // Reset card counts
  Object.keys(prevCardCounts).forEach(k => delete prevCardCounts[k]);
});

socket.on('roomError', (msg) => { showLobbyError(msg); });

socket.on('stateUpdate', ({ gs, players }) => {
  detectAndPlaySFX(gs, players);
  renderState(gs, players);
  prevGs = JSON.parse(JSON.stringify(gs));
});

socket.on('timerTick', (secs) => {
  const el = $('bet-timer-text');
  const bar = $('bet-timer-bar');
  if (el) el.textContent = secs;
  if (bar) bar.style.width = (secs / 15 * 100) + '%';
  show('bet-timer-wrap');
  show('place-your-bets');
  if (secs <= 5) SFX.tick();
});

socket.on('timerCancel', () => { hide('bet-timer-wrap'); });

socket.on('yourTurn', ({ sid, ownerId, splitHandIndex }) => {
  activeTurnSid = sid;
  activeSplitHandIndex = splitHandIndex ?? 0;
  actionPending = false;
  const isMe = ownerId === mySocketId;
  if (isMe) showPlayButtons(sid);
  else hide('play-buttons');
  // Refresh seat highlight on split side
  if (prevGs) {
    for (let i = 1; i <= 5; i++) renderSeat(String(i), prevGs, {});
  }
});

socket.on('insuranceOffer', () => { showInsuranceModal(); });

socket.on('dealVote', ({ ready, needed, readyIds }) => {
  const dealBtn = $('btn-deal');
  if (!dealBtn) return;
  const iReady = readyIds.includes(mySocketId);
  dealBtn.textContent = iReady ? `Waiting… (${ready}/${needed})` : `Deal (${ready}/${needed})`;
  dealBtn.disabled = iReady;
  dealBtn.style.opacity = iReady ? '0.6' : '1';
});

// New round reset
socket.on('stateUpdate', ({ gs }) => {
  if (gs.gameStatus === 'betting') {
    winOverlayShown = false;
    activeTurnSid   = null;
    activeSplitHandIndex = 0;
    hide('play-buttons');
    actionPending = false;
    const dealBtn = $('btn-deal');
    if (dealBtn) { dealBtn.disabled=false; dealBtn.style.opacity='1'; dealBtn.textContent='Deal'; }
    // Fly out old cards
    document.querySelectorAll('.card, .card-back').forEach((c, i) => {
      c.style.animationDelay = (i * 0.03) + 's';
      c.classList.add('fly-out');
    });
    // Reset card counts for new round
    Object.keys(prevCardCounts).forEach(k => delete prevCardCounts[k]);
  }
});

// ── SFX Detection ─────────────────────────────────────────────
function detectAndPlaySFX(gs, players) {
  if (!prevGs) return;

  // New cards dealt
  const prevDLen = prevGs.hands?.dealer?.length || 0;
  const newDLen  = gs.hands?.dealer?.length || 0;
  if (newDLen > prevDLen) SFX.card();

  for (let i = 1; i <= 5; i++) {
    const sid = String(i);
    if (gs.splitActive?.[sid]) {
      const ph1 = prevGs.hands?.[sid]?.hand1?.length || 0;
      const ph2 = prevGs.hands?.[sid]?.hand2?.length || 0;
      const nh1 = gs.hands?.[sid]?.hand1?.length || 0;
      const nh2 = gs.hands?.[sid]?.hand2?.length || 0;
      if (nh1 > ph1 || nh2 > ph2) SFX.card();
    } else {
      const prev = Array.isArray(prevGs.hands?.[sid]) ? prevGs.hands[sid].length : 0;
      const curr = Array.isArray(gs.hands?.[sid])     ? gs.hands[sid].length     : 0;
      if (curr > prev) SFX.card();
    }
    // Bust
    if (gs.bustSeats?.[sid] && !prevGs.bustSeats?.[sid]) SFX.bust();
  }

  // Game over — win/lose
  if (gs.gameStatus === 'game_over' && prevGs.gameStatus !== 'game_over') {
    const mySeats = Object.entries(gs.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
    const hasBJ  = mySeats.some(s => (gs.badges?.[s]||[]).some(b=>b.cls==='bj'));
    const hasWin = mySeats.some(s => (gs.badges?.[s]||[]).some(b=>b.cls==='win'||b.cls==='bj'));
    const hasLose = mySeats.some(s => (gs.badges?.[s]||[]).some(b=>b.cls==='lose'));
    if (hasBJ) SFX.blackjack();
    else if (hasWin) SFX.win();
    else if (hasLose) SFX.lose();
  }
}

// ── Render State ──────────────────────────────────────────────
function renderState(gs, players) {
  if (!players) return;

  // Waiting room player list
  const waitList = $('waiting-players');
  if (waitList) {
    waitList.innerHTML = Object.entries(players).map(([id, p]) =>
      `<div class="waiting-player">
        ${p.isHost ? '<span class="crown">👑</span>' : '<span class="wp-dot">♦</span>'} ${p.name}
        ${id === mySocketId ? '<span class="you-label">(you)</span>' : ''}
      </div>`
    ).join('');
  }

  // In-game players panel
  const pList = $('players-list');
  if (pList) {
    pList.innerHTML = Object.entries(players).map(([id, p]) =>
      `<div class="player-entry ${id===mySocketId?'me':''}">
        <span class="pe-name">${p.isHost?'👑 ':''}${p.name}</span>
        <span class="pe-wallet">€${p.wallet.toLocaleString()}</span>
      </div>`
    ).join('');
  }

  // HUD
  const me = players[mySocketId];
  if (me) {
    myWallet = me.wallet;
    $('wallet-amount').textContent = '€' + me.wallet.toLocaleString();
    $('hud-bet-amount').textContent = '€' + (me.totalBet||0).toLocaleString();
  }

  const status = gs.gameStatus;
  if (['betting','idle'].includes(status)) show('chip-tray');

  // Deal button
  const mySeats = Object.entries(gs.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
  const canDeal = status==='betting' && gs.activeSeats.length>0 && mySeats.length>0;
  const myAlreadyReady = Array.isArray(gs.readyPlayers) && gs.readyPlayers.includes(mySocketId);
  if (canDeal && !myAlreadyReady) {
    show('deal-btn-wrap');
    const dealBtn = $('btn-deal');
    if (dealBtn && !gs.betsLocked) { dealBtn.disabled=false; dealBtn.style.opacity='1'; dealBtn.textContent='Deal'; }
  } else if (canDeal && myAlreadyReady) {
    show('deal-btn-wrap');
  } else {
    hide('deal-btn-wrap');
  }

  // Bet controls
  if (gs.betsLocked) hide('btn-undo'); else show('btn-undo');
  const myHasBets = mySeats.some(s=>gs.bets[s]?.main>0);
  const betsLocked = gs.betsLocked;
  if (myHasBets&&status==='betting'&&!betsLocked) show('btn-clear'); else hide('btn-clear');
  const hasLastBets = gs.lastRoundBets&&gs.lastRoundBets[mySocketId]?.length>0;
  if (hasLastBets&&status==='betting'&&!myHasBets&&!betsLocked) show('btn-rebet'); else hide('btn-rebet');
  if (myHasBets&&status==='betting'&&!betsLocked) show('btn-2x'); else hide('btn-2x');

  // Seats
  for (let i = 1; i <= 5; i++) renderSeat(String(i), gs, players);

  // Dealer
  renderDealer(gs);

  // Win overlay
  if (gs.gameStatus==='game_over' && gs.grandTotal>0) {
    const myWon = calcMyWinnings(gs, players);
    if (myWon > 0) {
      const mySeats = Object.entries(gs.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
      const isBJ = mySeats.some(s => (gs.badges?.[s]||[]).some(b=>b.cls==='bj'));
      showWinOverlay(isBJ);
    }
  }

  updateStatusMsg(gs, players);
}

function updateWaitingHostUI() {
  if (isHost) { show('btn-start-game'); hide('waiting-hint-join'); }
  else { hide('btn-start-game'); show('waiting-hint-join'); }
}

function calcMyWinnings(gs, players) {
  let total = 0;
  for (const [sid, ownerId] of Object.entries(gs.seatOwners||{})) {
    if (ownerId!==mySocketId) continue;
    const badges = gs.badges?.[sid]||[];
    const bet = gs.bets?.[sid]?.main || 0;
    if (gs.splitActive?.[sid]) {
      // Split: count win badges (one per hand)
      const winCount  = badges.filter(b=>b.cls==='win').length;
      const pushCount = badges.filter(b=>b.cls==='push').length;
      const betPerHand = bet; // server snapped betPerHand at split time
      total += winCount * betPerHand * 2;
      total += pushCount * betPerHand;
    } else {
      if (badges.some(b=>b.cls==='bj'))   total += Math.floor(bet*2.5);
      else if (badges.some(b=>b.cls==='win'))  total += bet*2;
      else if (badges.some(b=>b.cls==='push')) total += bet;
    }
    if (gs.sideBetWins?.[sid]?.pp) total += gs.sideBetWins[sid].pp.payout;
    if (gs.sideBetWins?.[sid]?.sp) total += gs.sideBetWins[sid].sp.payout;
  }
  return total;
}

function updateStatusMsg(gs, players) {
  const el = $('status-message');
  if (!el) return;
  const status = gs.gameStatus;
  if (['betting','idle'].includes(status)) {
    if (gs.betsLocked && gs.readyPlayers?.length>0) {
      const pwb = new Set(gs.activeSeats.map(sid=>gs.seatOwners?.[sid]).filter(Boolean));
      el.textContent = `Waiting for all players to deal… (${gs.readyPlayers.length}/${pwb.size})`;
    } else {
      const cnt = Object.keys(gs.seatOwners||{}).length;
      el.textContent = cnt===0 ? 'Click a seat to join!' : 'Place your bets';
    }
  } else if (status==='dealing') el.textContent = 'Dealing…';
  else if (status==='playing') {
    if (activeTurnSid) {
      const ownerId = gs.seatOwners?.[activeTurnSid];
      const pName = ownerId ? players[ownerId]?.name : '?';
      const isMe = ownerId===mySocketId;
      el.textContent = isMe ? `Your turn — Seat ${activeTurnSid}` : `${pName}'s turn — Seat ${activeTurnSid}`;
    }
  } else if (status==='dealer_turn') el.textContent = "Dealer's turn…";
  else if (status==='game_over') el.textContent = 'Round over — next round soon…';
}

// ── Seat Rendering ────────────────────────────────────────────
function renderSeat(sid, gs, players) {
  const seatEl = $('seat-' + sid);
  if (!seatEl) return;

  const ownerId  = gs.seatOwners?.[sid];
  const isMine   = ownerId===mySocketId;
  const isBetting = ['betting','idle'].includes(gs.gameStatus);

  const mainCircle = seatEl.querySelector('.bet-circle.main-bet');
  if (ownerId) { seatEl.classList.add('my-seat'); mainCircle?.classList.add('claimed'); }
  else { seatEl.classList.remove('my-seat'); mainCircle?.classList.remove('claimed'); }

  const leaveBtn = seatEl.querySelector('.leave-seat-btn');
  if (leaveBtn) {
    if (isMine&&isBetting) leaveBtn.classList.remove('hidden');
    else leaveBtn.classList.add('hidden');
  }

  const nameTag = seatEl.querySelector('.seat-name-tag');
  if (nameTag) {
    const ownerName   = ownerId ? players?.[ownerId]?.name : null;
    const isHostOwner = ownerId ? players?.[ownerId]?.isHost : false;
    if (ownerName) {
      nameTag.textContent = (isHostOwner ? '👑 ' : '') + ownerName;
      nameTag.classList.remove('hidden');
      nameTag.style.background = isMine ? 'rgba(255,215,0,0.18)' : 'rgba(255,255,255,0.1)';
      nameTag.style.color = isMine ? '#ffd700' : '#fff';
    } else {
      nameTag.classList.add('hidden');
    }
  }

  for (const type of ['main','pp','sp']) renderCircle(sid, type, gs, isMine&&isBetting);
  renderHand(sid, gs);
  renderScore(sid, gs);
  renderBadges(sid, gs);

  seatEl.classList.toggle('active-turn', activeTurnSid===sid);
  renderBust(sid, gs);
}

function renderCircle(sid, type, gs, canBet) {
  const circle = document.querySelector(`.bet-circle[data-seat="${sid}"][data-type="${type}"]`);
  if (!circle) return;

  const amt = gs.bets?.[sid]?.[type] || 0;
  circle.onclick = null;

  if (canBet && gs.gameStatus==='betting') {
    if (type==='main') {
      const ownerId = gs.seatOwners?.[sid];
      if (!ownerId) circle.onclick = () => socket.emit('claimSeat', { sid });
      else if (ownerId===mySocketId) circle.onclick = () => { SFX.chip(); socket.emit('placeBet', { sid, type:'main', amt:selectedChip }); };
    } else if (gs.seatOwners?.[sid]===mySocketId) {
      circle.onclick = () => { SFX.chip(); socket.emit('placeBet', { sid, type, amt:selectedChip }); };
    }
  } else if (!gs.seatOwners?.[sid] && gs.gameStatus==='betting') {
    circle.onclick = () => socket.emit('claimSeat', { sid });
  }

  circle.querySelectorAll('.chip-stack,.sidebet-win-display').forEach(s=>s.remove());

  const ppWin = gs.sideBetWins?.[sid]?.pp;
  const spWin = gs.sideBetWins?.[sid]?.sp;
  if (ppWin && type==='pp') { renderSideBetWin(circle, ppWin); return; }
  if (spWin && type==='sp') { renderSideBetWin(circle, spWin); return; }

  if (amt > 0) renderChipStack(circle, amt, type==='main');
  circle.classList.toggle('has-bet', amt>0);
}

function renderSideBetWin(circle, winData) {
  circle.classList.add('has-bet');
  const div = document.createElement('div');
  div.className = 'sidebet-win-display';
  div.innerHTML = `<div class="sbw-mult">${winData.mult}:1</div><div class="sbw-payout">+${fmtAmt(winData.payout)}</div>`;
  circle.appendChild(div);
}

function renderChipStack(circle, amt, isMain) {
  const denom = [10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];
  const chips = [];
  let rem = amt;
  for (const d of denom) { while (rem>=d && chips.length<8) { chips.push(d); rem-=d; } if (chips.length>=8) break; }
  const chipW = isMain ? 58 : 38;
  const offsetY = isMain ? 4 : 3;
  const stack = document.createElement('div');
  stack.className = 'chip-stack';
  chips.forEach((val, i) => {
    const [c1,c2] = (CHIP_COLORS[val]||'#888,#444').split(',');
    const chip = document.createElement('div');
    chip.className = 'stacked-chip';
    chip.style.cssText = `width:${chipW}px;height:${chipW}px;background:radial-gradient(circle at 35% 35%,${c1},${c2});bottom:${4+i*offsetY}px;left:50%;transform:translateX(-50%);`;
    stack.appendChild(chip);
  });
  const lbl = document.createElement('div');
  lbl.className = 'chip-stack-amt';
  lbl.style.bottom = (4+(chips.length-1)*offsetY + chipW/2 - 9) + 'px';
  lbl.style.top = 'auto';
  lbl.textContent = fmtAmt(amt);
  stack.appendChild(lbl);
  circle.appendChild(stack);
}

// ── Hand Rendering — Only animate NEW cards ────────────────────
// Key insight: track how many cards each seat/hand had last render.
// New cards get class 'card-new' (animated), existing get 'card-old' (no anim).

function getHandKey(sid, hk) { return hk ? `${sid}-${hk}` : sid; }

function renderHand(sid, gs) {
  const el = $('hand-' + sid);
  if (!el) return;

  if (gs.splitActive?.[sid]) {
    el.innerHTML = '';
    el.classList.add('split-mode');
    const wrap = document.createElement('div');
    wrap.className = 'split-hands';

    // hand1 = RIGHT (played first), hand2 = LEFT
    ['hand1','hand2'].forEach((hk, idx) => {
      const h = gs.hands?.[sid]?.[hk] || [];
      const isActive = activeTurnSid===sid && idx===activeSplitHandIndex;
      const col = document.createElement('div');
      col.className = 'split-col' + (isActive ? ' active-split-col' : '');

      // Score pill
      const scorePill = document.createElement('div');
      scorePill.className = 'score-display split-score';
      const sv = scoreLabel(h, false);
      scorePill.innerHTML = `<span class="bust-num">${sv}</span><span class="bust-icon">💥</span>`;
      const sc = score(h);
      if (sc > 21) { scorePill.classList.add('busted'); setTimeout(()=>scorePill.classList.add('show-icon'),800); }
      if (!h.length) scorePill.classList.add('hidden');

      // Arrow indicator
      const splitInd = document.createElement('div');
      splitInd.className = 'split-indicator';
      splitInd.textContent = idx===0 ? '❯' : '❮';

      // Bet chips — show FULL original bet per hand (not half)
      const betPerHand = gs.bets?.[sid]?.main || 0;
      const chipDiv = document.createElement('div');
      chipDiv.className = 'split-bet-chips';
      if (betPerHand > 0) renderMiniChipStack(chipDiv, betPerHand);

      // Cards
      const handDiv = document.createElement('div');
      handDiv.className = 'split-hand' + (isActive ? ' active-split' : '');
      const key = getHandKey(sid, hk);
      const prevCount = prevCardCounts[key] || 0;
      h.forEach((c, i) => {
        const isNew = i >= prevCount;
        handDiv.appendChild(mkCard(c, i, isNew));
      });
      prevCardCounts[key] = h.length;

      col.appendChild(chipDiv);
      col.appendChild(scorePill);
      col.appendChild(splitInd);
      col.appendChild(handDiv);
      wrap.appendChild(col);
    });
    el.appendChild(wrap);
  } else {
    el.classList.remove('split-mode');
    el.innerHTML = '';
    const hand = Array.isArray(gs.hands?.[sid]) ? gs.hands[sid] : [];
    const key = getHandKey(sid, null);
    const prevCount = prevCardCounts[key] || 0;
    hand.forEach((c, i) => {
      const isNew = i >= prevCount;
      el.appendChild(mkCard(c, i, isNew));
    });
    prevCardCounts[key] = hand.length;
  }
}

function renderMiniChipStack(container, amt) {
  const denom = [10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];
  const chips = [];
  let rem = amt;
  for (const d of denom) { while (rem>=d && chips.length<4) { chips.push(d); rem-=d; } if (chips.length>=4) break; }
  const chipW = 28, offsetY = 3;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:34px;height:'+(chipW+chips.length*offsetY+16)+'px;display:inline-block;';
  chips.forEach((val, i) => {
    const [c1,c2] = (CHIP_COLORS[val]||'#888,#444').split(',');
    const chip = document.createElement('div');
    chip.className = 'stacked-chip';
    chip.style.cssText = `width:${chipW}px;height:${chipW}px;background:radial-gradient(circle at 35% 35%,${c1},${c2});position:absolute;bottom:${i*offsetY}px;left:50%;transform:translateX(-50%);`;
    wrap.appendChild(chip);
  });
  const lbl = document.createElement('div');
  lbl.className = 'chip-stack-amt';
  lbl.style.cssText = `position:absolute;bottom:${chips.length*offsetY+chipW-6}px;left:50%;transform:translateX(-50%);font-size:.5rem;padding:1px 4px;`;
  lbl.textContent = fmtAmt(amt);
  wrap.appendChild(lbl);
  container.appendChild(wrap);
}

// mkCard — isNew flag controls animation
function mkCard(c, idx, isNew=true) {
  const div = document.createElement('div');
  div.className = isNew ? 'card card-new' : 'card card-old';
  const code = (c.value==='10'?'0':c.value) + c.suit;
  const img  = document.createElement('img');
  img.src = 'https://deckofcardsapi.com/static/img/' + code + '.png';
  img.onerror = () => {
    try { div.removeChild(img); } catch(e) {}
    div.style.cssText += ';background:#fff;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;color:'+(['H','D'].includes(c.suit)?'#c00':'#111');
    div.textContent = c.value + ({S:'♠',H:'♥',D:'♦',C:'♣'}[c.suit]||'');
  };
  div.appendChild(img);
  return div;
}

// ── Dealer ────────────────────────────────────────────────────
function renderDealer(gs) {
  const el = $('dealer-hand');
  if (!el) return;

  const hand = gs.hands?.dealer||[];
  const key = 'dealer';
  const prevCount = prevCardCounts[key] || 0;

  // Only rebuild if card count changed (or revealed)
  const wasRevealed = prevGs?.dealerRevealed;
  const nowRevealed = gs.dealerRevealed;
  if (hand.length === prevCount && wasRevealed === nowRevealed) {
    // No change — skip rebuild
  } else {
    el.innerHTML = '';
    hand.forEach((c, i) => {
      if (i===1 && !gs.dealerRevealed) {
        const back = document.createElement('div');
        // Red card back
        back.className = 'card-back' + (i >= prevCount ? ' card-new' : ' card-old');
        el.appendChild(back);
      } else {
        const isNew = i >= prevCount || (i===1 && nowRevealed && !wasRevealed);
        el.appendChild(mkCard(c, i, isNew));
      }
    });
    prevCardCounts[key] = hand.length;
  }

  const scoreEl = $('dealer-score');
  if (scoreEl) {
    if (hand.length > 0) {
      const displayHand = gs.dealerRevealed ? hand : [hand[0]];
      const ds = score(displayHand);
      scoreEl.innerHTML = `<span class="bust-num">${ds}</span><span class="bust-icon">💥</span>`;
      scoreEl.classList.remove('hidden');
      if (gs.dealerRevealed && ds > 21) {
        scoreEl.classList.add('busted');
        setTimeout(()=>scoreEl.classList.add('show-icon'), 800);
      } else {
        scoreEl.classList.remove('busted','show-icon');
      }
    } else {
      scoreEl.classList.add('hidden');
    }
  }
}

function renderScore(sid, gs) {
  const el = $('score-' + sid);
  if (!el) return;
  if (gs.splitActive?.[sid]) { el.classList.add('hidden'); return; }
  const hand = Array.isArray(gs.hands?.[sid]) ? gs.hands[sid] : [];
  if (!hand.length) { el.classList.add('hidden'); return; }
  const stood = gs.stoodSeats?.includes(sid);
  el.innerHTML = `<span class="bust-num">${scoreLabel(hand, stood)}</span><span class="bust-icon">💥</span>`;
  el.classList.remove('hidden');
  const s = score(hand);
  if (s > 21) { el.classList.add('busted'); setTimeout(()=>el.classList.add('show-icon'),800); }
  else el.classList.remove('busted','show-icon');
}

function renderBust(sid, gs) {
  if (gs.bustSeats?.[sid] && !gs.splitActive?.[sid]) {
    const el = $('score-'+sid);
    if (el) { el.classList.add('busted'); setTimeout(()=>el.classList.add('show-icon'),800); }
  }
}

function renderBadges(sid, gs) {
  const seatEl = $('seat-'+sid);
  if (!seatEl) return;
  seatEl.querySelectorAll('.result-badge').forEach(b=>b.remove());
  const badges = gs.badges?.[sid]||[];
  const seen = new Set();
  for (const b of [...badges].reverse()) {
    if (seen.has(b.cls)) continue;
    seen.add(b.cls);
    const div = document.createElement('div');
    div.className = `result-badge ${b.cls}`;
    div.textContent = b.text;
    seatEl.appendChild(div);
  }
}

// ── Play Buttons ──────────────────────────────────────────────
function showPlayButtons(sid) {
  const gs = prevGs;
  if (!gs) return;
  const hand = gs.splitActive?.[sid]
    ? (gs.hands?.[sid]?.['hand'+(activeSplitHandIndex+1)] || [])
    : (gs.hands?.[sid] || []);
  const canDouble = hand.length===2 && myWallet>=(gs.bets?.[sid]?.main||0) && !gs.doubled?.[sid];
  const canSplit  = hand.length===2 && !gs.splitActive?.[sid]
                    && cardNum(hand[0])===cardNum(hand[1])
                    && myWallet>=(gs.bets?.[sid]?.main||0);
  $('btn-double').classList.toggle('hidden', !canDouble);
  $('btn-split').classList.toggle('hidden', !canSplit);
  show('play-buttons');
}

function doAction(action) {
  if (actionPending || !activeTurnSid) return;
  actionPending = true;
  hide('play-buttons');
  setTimeout(() => { socket.emit('action', { action, sid: activeTurnSid }); }, 150);
}

$('btn-hit').addEventListener('click',    () => doAction('hit'));
$('btn-stand').addEventListener('click',  () => doAction('stand'));
$('btn-double').addEventListener('click', () => doAction('double'));
$('btn-split').addEventListener('click',  () => doAction('split'));

// ── Chip tray ─────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c=>c.classList.remove('selected'));
    chip.classList.add('selected');
    selectedChip = parseInt(chip.dataset.value);
  });
});
document.querySelector('.chip[data-value="100"]')?.classList.add('selected');

$('btn-deal').addEventListener('click',  () => { SFX.deal(); socket.emit('deal'); });
$('btn-clear').addEventListener('click', () => socket.emit('clearBets'));
$('btn-undo').addEventListener('click',  () => socket.emit('undoBet'));
$('btn-rebet').addEventListener('click', () => socket.emit('rebet'));
$('btn-2x').addEventListener('click',    () => socket.emit('doubleBets'));

// ── Leave seat buttons ────────────────────────────────────────
document.querySelectorAll('.leave-seat-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const sid = btn.closest('.seat')?.dataset.seat;
    if (sid) socket.emit('leaveSeat', { sid });
    e.stopPropagation();
  });
});

// ── In-game X / leave room ────────────────────────────────────
// ── In-game X button — leave room ─────────────────────────────
$('btn-leave-ingame')?.addEventListener('click', () => {
  if (confirm('Leave the table and return to lobby?')) { socket.disconnect(); location.reload(); }
});

// ── Settings ──────────────────────────────────────────────────
$('btn-gear').addEventListener('click', () => show('settings-modal'));
$('settings-close')?.addEventListener('click', () => hide('settings-modal'));
$('settings-close-btn')?.addEventListener('click', () => hide('settings-modal'));
$('settings-modal')?.addEventListener('click', (e) => { if (e.target === $('settings-modal')) hide('settings-modal'); });
$('sfx-volume').addEventListener('input', (e) => {
  sfxVolume = parseFloat(e.target.value);
  $('sfx-vol-label').textContent = Math.round(sfxVolume*100) + '%';
});

// ── In-game X (table-info-bar) — leave room ───────────────────
$('table-info-x')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (confirm('Leave the table and return to lobby?')) { socket.disconnect(); location.reload(); }
});

// ── Insurance ────────────────────────────────────────────────
function showInsuranceModal() {
  if (!prevGs) return;
  const gs = prevGs;
  const seatsContainer = $('insurance-seats');
  seatsContainer.innerHTML = '';

  const mySeats = Object.entries(gs.seatOwners||{})
    .filter(([,id])=>id===mySocketId).map(([s])=>s);

  if (!mySeats.length) {
    socket.emit('insuranceResponse', { choices: {} });
    return;
  }

  const choices = {};
  mySeats.forEach(sid => {
    choices[sid] = false;
    const cost = Math.floor(gs.bets[sid].main/2);
    const canAfford = myWallet >= cost;
    const row = document.createElement('div');
    row.className = 'ins-row';
    row.innerHTML = `
      <span class="ins-seat-label">Seat ${sid} — Cost: €${cost}</span>
      <button class="ins-yes${canAfford?'':' ins-disabled'}" data-sid="${sid}" ${canAfford?'':'disabled'}>✓ Insure</button>
      <button class="ins-no selected" data-sid="${sid}">✕ Decline</button>
    `;
    row.querySelector('.ins-yes').addEventListener('click', function() {
      if (!canAfford) return;
      choices[sid] = true;
      this.classList.add('selected');
      row.querySelector('.ins-no').classList.remove('selected');
    });
    row.querySelector('.ins-no').addEventListener('click', function() {
      choices[sid] = false;
      this.classList.add('selected');
      row.querySelector('.ins-yes').classList.remove('selected');
    });
    seatsContainer.appendChild(row);
  });

  $('insurance-confirm').onclick = () => {
    socket.emit('insuranceResponse', { choices });
    hide('insurance-modal');
  };

  show('insurance-modal');
}

// ── Win overlay ───────────────────────────────────────────────
let winOverlayShown = false;
function showWinOverlay(isBJ) {
  if (winOverlayShown) return;
  winOverlayShown = true;
  document.querySelectorAll('.round-result-overlay').forEach(e=>e.remove());
  const overlay = document.createElement('div');
  overlay.className = 'round-result-overlay';
  overlay.innerHTML = isBJ
    ? `<div class="rr-label" style="color:#ffd700;">Blackjack! 🃏</div>`
    : `<div class="rr-label">You Win!</div>`;
  document.getElementById('game-container').appendChild(overlay);
  setTimeout(()=>overlay.classList.add('rr-fadeout'), 1800);
  setTimeout(()=>{ overlay.remove(); winOverlayShown=false; }, 2600);
}

// ── Table info hover ──────────────────────────────────────────
const infoPanel = $('table-info-panel');
if (infoPanel) {
  infoPanel.addEventListener('mouseenter', () => $('table-payout-menu')?.classList.add('visible'));
  infoPanel.addEventListener('mouseleave', () => $('table-payout-menu')?.classList.remove('visible'));
}

// ── Boot ──────────────────────────────────────────────────────
initAuth();
