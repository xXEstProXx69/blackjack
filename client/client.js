// =============================================================
// BLACKJACK MULTIPLAYER — client.js — Fixed
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
let betTimerRemaining = 15;
let isHost       = false;

// ── SFX ───────────────────────────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let sfxVolume = 0.5;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioCtx();
  return audioCtx;
}

function playTone(freq, type, duration, vol, delay=0) {
  if (sfxVolume === 0) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
    gain.gain.setValueAtTime(vol * sfxVolume, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + duration);
  } catch(e) {}
}

const SFX = {
  card: () => {
    playTone(800, 'sine', 0.06, 0.3);
    playTone(600, 'sine', 0.05, 0.15, 0.04);
  },
  chip: () => {
    playTone(1200, 'sine', 0.08, 0.2);
    playTone(900, 'triangle', 0.06, 0.15, 0.05);
  },
  win: () => {
    [523,659,784,1047].forEach((f,i) => playTone(f,'sine',0.3,0.25,i*0.1));
  },
  lose: () => {
    [300,250,200].forEach((f,i) => playTone(f,'sawtooth',0.2,0.2,i*0.12));
  },
  blackjack: () => {
    [523,659,784,880,1047].forEach((f,i) => playTone(f,'sine',0.4,0.3,i*0.08));
  },
  deal: () => {
    playTone(440,'sine',0.1,0.2);
  },
  bust: () => {
    [400,300,200].forEach((f,i) => playTone(f,'sawtooth',0.15,0.3,i*0.1));
  },
  tick: () => {
    playTone(1000,'square',0.05,0.1);
  },
};

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

// ── Lobby ─────────────────────────────────────────────────────
$('btn-create-room').addEventListener('click', () => {
  const name = $('lobby-name').value.trim();
  if (!name) { showLobbyError('Enter your name first'); return; }
  myName = name;
  socket.emit('createRoom', { name, wallet: 5000 });
});

$('btn-join-room').addEventListener('click', () => {
  const name = $('lobby-name').value.trim();
  const code = $('lobby-code-input').value.trim().toUpperCase();
  if (!name) { showLobbyError('Enter your name first'); return; }
  if (code.length !== 4) { showLobbyError('Enter a 4-digit room code'); return; }
  myName = name;
  socket.emit('joinRoom', { code, name, wallet: 5000 });
});

$('lobby-code-input').addEventListener('keydown', e => { if (e.key==='Enter') $('btn-join-room').click(); });
$('lobby-name').addEventListener('keydown', e => { if (e.key==='Enter') $('btn-create-room').click(); });

$('btn-start-game').addEventListener('click', () => {
  socket.emit('startGame');
});

$('btn-leave-room').addEventListener('click', () => { location.reload(); });

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

  // Show/hide start button based on host status
  if (isHost) {
    show('btn-start-game');
    hide('waiting-hint-join');
  } else {
    hide('btn-start-game');
    show('waiting-hint-join');
  }
  // Update crown
  updateWaitingHostUI();
});

socket.on('becameHost', () => {
  isHost = true;
  show('btn-start-game');
  hide('waiting-hint-join');
  updateWaitingHostUI();
  // Show notification
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
});

socket.on('roomError', (msg) => { showLobbyError(msg); });

socket.on('stateUpdate', ({ gs, players }) => {
  // Detect new cards for SFX — only play for newly added cards, not all
  if (prevGs) {
    const prevDealerLen = prevGs.hands?.dealer?.length || 0;
    const newDealerLen  = gs.hands?.dealer?.length || 0;
    if (newDealerLen > prevDealerLen) SFX.card();
    for (let i = 1; i <= 5; i++) {
      const sid = String(i);
      const prev = prevGs.hands?.[sid];
      const curr = gs.hands?.[sid];
      if (Array.isArray(curr) && Array.isArray(prev) && curr.length > prev.length) SFX.card();
    }
    // Detect bust
    for (let i = 1; i <= 5; i++) {
      const sid = String(i);
      if (gs.bustSeats?.[sid] && !prevGs.bustSeats?.[sid]) SFX.bust();
    }
    // Detect win/lose at game over
    if (gs.gameStatus === 'game_over' && prevGs.gameStatus !== 'game_over') {
      const mySeats = Object.entries(gs.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
      const hasWin = mySeats.some(s => (gs.badges?.[s]||[]).some(b=>b.cls==='win'||b.cls==='bj'));
      const hasLose = mySeats.some(s => (gs.badges?.[s]||[]).some(b=>b.cls==='lose'));
      if (mySeats.some(s => (gs.badges?.[s]||[]).some(b=>b.cls==='bj'))) SFX.blackjack();
      else if (hasWin) SFX.win();
      else if (hasLose && !hasWin) SFX.lose();
    }
  }

  renderState(gs, players);
  prevGs = JSON.parse(JSON.stringify(gs));
});

socket.on('timerTick', (secs) => {
  betTimerRemaining = secs;
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
  const isMe = ownerId === mySocketId;
  if (isMe) {
    showPlayButtons(sid);
  } else {
    hide('play-buttons');
  }
  // Re-render seats to update active-turn highlight on correct split col
  if (prevGs) renderState(prevGs, null);
});

socket.on('insuranceOffer', () => { showInsuranceModal(); });

socket.on('dealVote', ({ ready, needed, readyIds }) => {
  const dealBtn = $('btn-deal');
  if (!dealBtn) return;
  const iReady = readyIds.includes(mySocketId);
  if (iReady) {
    dealBtn.textContent = `Waiting… (${ready}/${needed} ready)`;
    dealBtn.disabled = true;
    dealBtn.style.opacity = '0.6';
  } else {
    dealBtn.textContent = `Deal (${ready}/${needed} ready)`;
    dealBtn.disabled = false;
    dealBtn.style.opacity = '1';
  }
});

// ── Render State ──────────────────────────────────────────────
function renderState(gs, players) {
  if (!players) {
    // Called from yourTurn with no players - just re-render seats
    if (prevGs) {
      for (let i = 1; i <= 5; i++) renderSeat(String(i), prevGs, {});
    }
    return;
  }

  // Waiting room
  const waitList = $('waiting-players');
  if (waitList) {
    waitList.innerHTML = Object.entries(players).map(([id, p]) =>
      `<div class="waiting-player">
        ${p.isHost ? '<span class="crown">👑</span>' : '♦'} ${p.name}
        ${id === mySocketId ? '<span class="you-label">(you)</span>' : ''}
      </div>`
    ).join('');
  }

  // Players panel
  const pList = $('players-list');
  if (pList) {
    pList.innerHTML = Object.entries(players).map(([id, p]) =>
      `<div class="player-entry ${id===mySocketId?'me':''}">
        <span class="pe-name">${p.isHost?'👑 ':''}${p.name}</span>
        <span class="pe-wallet">€${p.wallet.toLocaleString()}</span>
      </div>`
    ).join('');
  }

  const me = players[mySocketId];
  if (me) {
    myWallet = me.wallet;
    $('wallet-amount').textContent = '€' + me.wallet.toLocaleString();
    $('hud-bet-amount').textContent = '€' + (me.totalBet||0).toLocaleString();
  }

  const status = gs.gameStatus;
  if (['betting','idle'].includes(status)) show('chip-tray');

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
    const dealBtn = $('btn-deal');
    if (dealBtn) { dealBtn.disabled=false; dealBtn.style.opacity='1'; dealBtn.textContent='Deal'; }
  }

  if (gs.betsLocked) hide('btn-undo'); else show('btn-undo');

  const myHasBets = mySeats.some(s=>gs.bets[s]?.main>0);
  const betsLocked = gs.betsLocked;
  if (myHasBets&&status==='betting'&&!betsLocked) show('btn-clear'); else hide('btn-clear');

  const hasLastBets = gs.lastRoundBets&&gs.lastRoundBets[mySocketId]?.length>0;
  if (hasLastBets&&status==='betting'&&!myHasBets&&!betsLocked) show('btn-rebet'); else hide('btn-rebet');
  if (myHasBets&&status==='betting'&&!betsLocked) show('btn-2x'); else hide('btn-2x');

  for (let i = 1; i <= 5; i++) renderSeat(String(i), gs, players);

  renderDealer(gs);

  if (gs.gameStatus==='game_over' && gs.grandTotal>0) {
    const myWon = calcMyWinnings(gs, players);
    if (myWon > 0) showWinOverlay(myWon);
  }

  updateStatusMsg(gs, players);
}

function updateWaitingHostUI() {
  const startBtn = $('btn-start-game');
  if (startBtn) {
    if (isHost) startBtn.classList.remove('hidden');
    else startBtn.classList.add('hidden');
  }
}

function calcMyWinnings(gs, players) {
  let total = 0;
  for (const [sid, ownerId] of Object.entries(gs.seatOwners||{})) {
    if (ownerId!==mySocketId) continue;
    const badges = gs.badges?.[sid]||[];
    if (badges.some(b=>b.cls==='bj'))  total += Math.floor(gs.bets[sid].main*2.5);
    else if (badges.some(b=>b.cls==='win'))  total += gs.bets[sid].main*2;
    else if (badges.some(b=>b.cls==='push')) total += gs.bets[sid].main;
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
    const cnt = Object.keys(gs.seatOwners||{}).length;
    if (gs.betsLocked && Array.isArray(gs.readyPlayers) && gs.readyPlayers.length>0) {
      const pwb = new Set(gs.activeSeats.map(sid=>gs.seatOwners?.[sid]).filter(Boolean));
      el.textContent = `Waiting for all players to deal… (${gs.readyPlayers.length}/${pwb.size})`;
    } else {
      el.textContent = cnt===0 ? 'Click a seat to join!' : 'Place your bets';
    }
  } else if (status==='dealing') {
    el.textContent = 'Dealing…';
  } else if (status==='playing') {
    if (activeTurnSid) {
      const ownerId = gs.seatOwners?.[activeTurnSid];
      const pName = ownerId ? players[ownerId]?.name : '?';
      const isMe = ownerId===mySocketId;
      el.textContent = isMe ? `Your turn — Seat ${activeTurnSid}` : `${pName}'s turn — Seat ${activeTurnSid}`;
    }
  } else if (status==='dealer_turn') {
    el.textContent = 'Dealer\'s turn…';
  } else if (status==='game_over') {
    el.textContent = 'Round over — next round soon…';
  }
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
    const ownerName = ownerId ? players?.[ownerId]?.name : null;
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

  // Active turn highlight — also show on correct split side
  const isActiveTurn = activeTurnSid===sid;
  seatEl.classList.toggle('active-turn', isActiveTurn);

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
      else if (ownerId===mySocketId && selectedChip) circle.onclick = () => { SFX.chip(); socket.emit('placeBet', { sid, type:'main', amt:selectedChip }); };
    } else if (gs.seatOwners?.[sid]===mySocketId) {
      circle.onclick = () => { SFX.chip(); socket.emit('placeBet', { sid, type, amt:selectedChip }); };
    }
  } else if (!gs.seatOwners?.[sid] && gs.gameStatus==='betting') {
    circle.onclick = () => socket.emit('claimSeat', { sid });
  }

  circle.querySelectorAll('.chip-stack').forEach(s=>s.remove());
  circle.querySelectorAll('.mult-bubble').forEach(b=>b.remove());
  circle.querySelectorAll('.sidebet-win-display').forEach(b=>b.remove());

  // Side bet win display — styled like the reference image (bold multiplier + payout)
  const ppWin = gs.sideBetWins?.[sid]?.pp;
  const spWin = gs.sideBetWins?.[sid]?.sp;

  if (ppWin && type==='pp') {
    renderSideBetWin(circle, ppWin, 'pp');
    return;
  }
  if (spWin && type==='sp') {
    renderSideBetWin(circle, spWin, 'sp');
    return;
  }

  if (amt > 0) renderChipStack(circle, amt, type==='main');
  circle.classList.toggle('has-bet', amt>0);
}

// Side bet win display — styled per reference image: big multiplier + payout amount
function renderSideBetWin(circle, winData, type) {
  circle.classList.add('has-bet');
  const div = document.createElement('div');
  div.className = 'sidebet-win-display';
  div.innerHTML = `
    <div class="sbw-mult">${winData.mult}:1</div>
    <div class="sbw-payout">+${fmtAmt(winData.payout)}</div>
  `;
  circle.appendChild(div);
}

function renderChipStack(circle, amt, isMain) {
  const denom = [10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];
  const chips = [];
  let rem = amt;
  for (const d of denom) {
    while (rem>=d && chips.length<8) { chips.push(d); rem-=d; }
    if (chips.length>=8) break;
  }
  const chipW   = isMain ? 58 : 38;
  const offsetY = isMain ? 4 : 3;
  const stack = document.createElement('div');
  stack.className = 'chip-stack';

  chips.forEach((val, i) => {
    const cols = CHIP_COLORS[val] || '#888,#444';
    const [c1,c2] = cols.split(',');
    const chip = document.createElement('div');
    chip.className = 'stacked-chip';
    chip.style.cssText = `width:${chipW}px;height:${chipW}px;background:radial-gradient(circle at 35% 35%,${c1},${c2});bottom:${4+i*offsetY}px;left:50%;transform:translateX(-50%);`;
    stack.appendChild(chip);
  });

  const topBottom = 4 + (chips.length-1)*offsetY;
  const lbl = document.createElement('div');
  lbl.className = 'chip-stack-amt';
  lbl.style.bottom = (topBottom + chipW/2 - 9) + 'px';
  lbl.style.top = 'auto';
  lbl.textContent = fmtAmt(amt);
  stack.appendChild(lbl);
  circle.appendChild(stack);
}

// ── Hand Rendering ────────────────────────────────────────────
function renderHand(sid, gs) {
  const el = $('hand-' + sid);
  if (!el) return;

  if (gs.splitActive?.[sid]) {
    el.innerHTML = '';
    el.classList.add('split-mode');
    const wrap = document.createElement('div');
    wrap.className = 'split-hands';

    // Split: hand1 = right, hand2 = left (play right first, then left)
    // Visually: hand1 on RIGHT, hand2 on LEFT
    ['hand1','hand2'].forEach((hk, idx) => {
      const h = gs.hands?.[sid]?.[hk] || [];
      // idx 0 = hand1 = right side, idx 1 = hand2 = left side
      const isActive = activeTurnSid===sid && idx===activeSplitHandIndex;
      const col = document.createElement('div');
      col.className = 'split-col' + (isActive ? ' active-split-col' : '');

      const scorePill = document.createElement('div');
      scorePill.className = 'score-display split-score';
      const stood = gs.stoodSeats?.includes(sid);
      const sv = scoreLabel(h, stood);
      scorePill.innerHTML = `<span class="bust-num">${sv}</span><span class="bust-icon">💥</span>`;
      const sc = score(h);
      if (sc > 21) { scorePill.classList.add('busted'); setTimeout(()=>scorePill.classList.add('show-icon'),800); }
      if (!h.length) scorePill.classList.add('hidden');

      // Split indicator
      const splitInd = document.createElement('div');
      splitInd.className = 'split-indicator';
      splitInd.textContent = idx===0 ? '❯' : '❮';

      const handDiv = document.createElement('div');
      handDiv.className = 'split-hand' + (isActive ? ' active-split' : '');

      // Split chips — show half bet
      const halfBet = Math.floor((gs.bets?.[sid]?.main || 0) / 2);
      if (halfBet > 0) {
        const chipDiv = document.createElement('div');
        chipDiv.className = 'split-bet-chips';
        renderChipStackInEl(chipDiv, halfBet, false);
        col.appendChild(chipDiv);
      }

      h.forEach((c, i) => { handDiv.appendChild(mkCard(c, i)); });
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
    hand.forEach((c, i) => el.appendChild(mkCard(c, i)));
  }
}

function renderChipStackInEl(container, amt, isMain) {
  const denom = [10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];
  const chips = [];
  let rem = amt;
  for (const d of denom) {
    while (rem>=d && chips.length<5) { chips.push(d); rem-=d; }
    if (chips.length>=5) break;
  }
  const chipW = isMain ? 44 : 30;
  const offsetY = 3;
  const stack = document.createElement('div');
  stack.className = 'chip-stack-inline';
  chips.forEach((val, i) => {
    const cols = CHIP_COLORS[val]||'#888,#444';
    const [c1,c2] = cols.split(',');
    const chip = document.createElement('div');
    chip.className = 'stacked-chip';
    chip.style.cssText = `width:${chipW}px;height:${chipW}px;background:radial-gradient(circle at 35% 35%,${c1},${c2});position:absolute;bottom:${i*offsetY}px;left:50%;transform:translateX(-50%);`;
    stack.appendChild(chip);
  });
  const lbl = document.createElement('div');
  lbl.className = 'chip-stack-amt';
  lbl.style.bottom = (chips.length*offsetY + chipW/2 - 7) + 'px';
  lbl.style.position = 'absolute';
  lbl.style.left = '50%';
  lbl.style.transform = 'translateX(-50%)';
  lbl.textContent = fmtAmt(amt);
  stack.appendChild(lbl);
  container.appendChild(stack);
}

function renderScore(sid, gs) {
  const el = $('score-' + sid);
  if (!el) return;
  if (gs.splitActive?.[sid]) { el.classList.add('hidden'); return; }
  const hand = Array.isArray(gs.hands?.[sid]) ? gs.hands[sid] : [];
  if (!hand.length) { el.classList.add('hidden'); return; }
  const stood = gs.stoodSeats?.includes(sid);
  const label = scoreLabel(hand, stood);
  el.innerHTML = `<span class="bust-num">${label}</span><span class="bust-icon">💥</span>`;
  el.classList.remove('hidden');
  const s = score(hand);
  if (s > 21) {
    el.classList.add('busted');
    setTimeout(()=>el.classList.add('show-icon'),800);
  } else {
    el.classList.remove('busted','show-icon');
  }
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

function mkCard(c, idx) {
  const div = document.createElement('div');
  div.className = 'card';
  // Only animate the newest card — give all existing cards no delay
  div.style.animationDelay = idx === 0 ? '0s' : '0s';
  div.dataset.cardIdx = idx;
  const code = (c.value==='10'?'0':c.value) + c.suit;
  const img  = document.createElement('img');
  img.src = 'https://deckofcardsapi.com/static/img/' + code + '.png';
  img.onerror = () => {
    div.removeChild(img);
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
  el.innerHTML = '';
  const hand = gs.hands?.dealer||[];
  hand.forEach((c, i) => {
    if (i===1 && !gs.dealerRevealed) {
      const back = document.createElement('div');
      back.className = 'card-back';
      el.appendChild(back);
    } else {
      el.appendChild(mkCard(c, i));
    }
  });

  const scoreEl = $('dealer-score');
  if (scoreEl) {
    if (hand.length>0) {
      const displayHand = gs.dealerRevealed ? hand : [hand[0]];
      const ds = score(displayHand);
      scoreEl.innerHTML = `<span class="bust-num">${ds}</span>`;
      scoreEl.classList.remove('hidden');
      if (gs.dealerRevealed && ds>21) {
        scoreEl.classList.add('busted');
        setTimeout(()=>scoreEl.classList.add('show-icon'),800);
      } else {
        scoreEl.classList.remove('busted','show-icon');
      }
    } else {
      scoreEl.classList.add('hidden');
    }
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

let actionPending = false;

function doAction(action) {
  if (actionPending || !activeTurnSid) return;
  actionPending = true;
  // Hide buttons immediately
  hide('play-buttons');
  // Wait briefly then send
  setTimeout(() => {
    socket.emit('action', { action, sid: activeTurnSid });
    actionPending = false;
  }, 150);
}

$('btn-hit').addEventListener('click', () => doAction('hit'));
$('btn-stand').addEventListener('click', () => doAction('stand'));
$('btn-double').addEventListener('click', () => doAction('double'));
$('btn-split').addEventListener('click', () => doAction('split'));

// ── Chip tray ─────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c=>c.classList.remove('selected'));
    chip.classList.add('selected');
    selectedChip = parseInt(chip.dataset.value);
  });
});
document.querySelector('.chip[data-value="100"]')?.classList.add('selected');

$('btn-deal').addEventListener('click', () => { SFX.deal(); socket.emit('deal'); });
$('btn-clear').addEventListener('click', () => socket.emit('clearBets'));
$('btn-undo').addEventListener('click', () => socket.emit('undoBet'));
$('btn-rebet').addEventListener('click', () => socket.emit('rebet'));
$('btn-2x').addEventListener('click', () => socket.emit('doubleBets'));

// ── Leave seat buttons ────────────────────────────────────────
document.querySelectorAll('.leave-seat-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const sid = btn.closest('.seat')?.dataset.seat;
    if (sid) socket.emit('leaveSeat', { sid });
    e.stopPropagation();
  });
});

// ── Settings ──────────────────────────────────────────────────
$('btn-gear').addEventListener('click', () => {
  $('btn-gear').classList.remove('hidden');
  show('settings-modal');
});
$('settings-close').addEventListener('click', () => hide('settings-modal'));
$('sfx-volume').addEventListener('input', (e) => {
  sfxVolume = parseFloat(e.target.value);
  $('sfx-vol-label').textContent = Math.round(sfxVolume*100)+'%';
});
// Show gear button always
show('btn-gear');

// ── Insurance ────────────────────────────────────────────────
function showInsuranceModal() {
  if (!prevGs) return;
  const gs = prevGs;
  const modal = $('insurance-modal');
  const seatsContainer = $('insurance-seats');
  seatsContainer.innerHTML = '';

  const mySeats = Object.entries(gs.seatOwners||{})
    .filter(([,id])=>id===mySocketId)
    .map(([sid])=>sid);

  if (!mySeats.length) {
    // Auto-respond with no insurance
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
function showWinOverlay(amount) {
  if (winOverlayShown) return;
  winOverlayShown = true;
  document.querySelectorAll('.round-result-overlay').forEach(e=>e.remove());
  const overlay = document.createElement('div');
  overlay.className = 'round-result-overlay';
  overlay.innerHTML = `<div class="rr-label">You Win!</div><div class="rr-amount">€${amount.toLocaleString()}</div>`;
  document.getElementById('game-container').appendChild(overlay);
  setTimeout(()=>overlay.classList.add('rr-fadeout'), 1800);
  setTimeout(()=>{ overlay.remove(); winOverlayShown=false; }, 2600);
}

socket.on('stateUpdate', ({ gs }) => {
  if (gs.gameStatus==='betting') {
    winOverlayShown = false;
    activeTurnSid   = null;
    activeSplitHandIndex = 0;
    hide('play-buttons');
    actionPending = false;
    const dealBtn = $('btn-deal');
    if (dealBtn) { dealBtn.disabled=false; dealBtn.style.opacity='1'; dealBtn.textContent='Deal'; }
    // Card fly-out
    document.querySelectorAll('.card, .card-back').forEach((c,i) => {
      c.style.animationDelay = (i*0.04)+'s';
      c.classList.add('fly-out');
    });
  }
});

// ── Info panel hover ──────────────────────────────────────────
const infoPanel = $('table-info-panel');
if (infoPanel) {
  infoPanel.addEventListener('mouseenter', () => $('table-payout-menu')?.classList.add('visible'));
  infoPanel.addEventListener('mouseleave', () => $('table-payout-menu')?.classList.remove('visible'));
}
