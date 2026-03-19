// =============================================================
// BLACKJACK MULTIPLAYER — client.js
// Thin renderer: sends socket events, draws server state
// =============================================================

const socket = io();

// ── Local state ───────────────────────────────────────────────
let mySocketId   = null;
let myName       = '';
let myWallet     = 5000;
let roomCode     = null;
let selectedChip = 100;
let activeTurnSid = null;      // which seat is currently playing
let prevGs       = null;       // for card fly-out detection
let betTimerRemaining = 15;

const CHIP_COLORS = {
  1:'#e8e8e8,#b0b0b0', 2:'#d0d0d0,#888', 5:'#e03030,#900',
  10:'#1a7ad4,#0a4a9a', 25:'#2da84e,#155a28', 50:'#c07020,#804010',
  100:'#222,#111', 200:'#b050f0,#6000b0', 500:'#8030a0,#400060',
  1000:'#e0b000,#a07000', 2000:'#e07030,#c03000',
  5000:'#10b0b0,#006060', 10000:'#f050a0,#900040',
};

// ── Utilities ─────────────────────────────────────────────────
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

$('lobby-code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-join-room').click();
});
$('lobby-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-create-room').click();
});

$('btn-start-game').addEventListener('click', () => {
  hide('waiting-screen');
  show('game-container');
  show('chip-tray');
  $('player-greeting').textContent = `${myName}`;
});

$('btn-leave-room').addEventListener('click', () => {
  location.reload();
});

function showLobbyError(msg) {
  const el = $('lobby-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Socket Events ─────────────────────────────────────────────
socket.on('roomJoined', ({ code, socketId }) => {
  mySocketId = socketId;
  roomCode   = code;
  hide('lobby-screen');
  show('waiting-screen');
  $('waiting-code').textContent = code;
  $('room-badge-code').textContent = code;
});

socket.on('roomError', (msg) => {
  showLobbyError(msg);
});

socket.on('stateUpdate', ({ gs, players }) => {
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
});

socket.on('timerCancel', () => {
  hide('bet-timer-wrap');
});

socket.on('yourTurn', ({ sid, ownerId }) => {
  activeTurnSid = sid;
  const isMe = ownerId === mySocketId;
  if (isMe) {
    showPlayButtons(sid);
  } else {
    hide('play-buttons');
  }
});

socket.on('insuranceOffer', () => {
  showInsuranceModal();
});

// ── Render State ──────────────────────────────────────────────
function renderState(gs, players) {
  // Waiting room player list
  const waitList = $('waiting-players');
  if (waitList) {
    waitList.innerHTML = Object.values(players).map(p =>
      `<div class="waiting-player">♦ ${p.name}</div>`
    ).join('');
  }

  // Players panel (in-game)
  const pList = $('players-list');
  if (pList) {
    pList.innerHTML = Object.entries(players).map(([id, p]) =>
      `<div class="player-entry ${id === mySocketId ? 'me' : ''}">
        <span class="pe-name">${p.name}</span>
        <span class="pe-wallet">€${p.wallet.toLocaleString()}</span>
      </div>`
    ).join('');
  }

  // My wallet
  const me = players[mySocketId];
  if (me) {
    myWallet = me.wallet;
    $('wallet-amount').textContent = '€' + me.wallet.toLocaleString();
    $('hud-bet-amount').textContent = '€' + (me.totalBet || 0).toLocaleString();
  }

  // Game status
  const status = gs.gameStatus;

  // Chip tray — show when betting
  if (['betting','idle'].includes(status)) {
    show('chip-tray');
  } else {
    // Keep showing during play so users can see, but chips aren't clickable
  }

  // Deal button
  const mySeats = Object.entries(gs.seatOwners || {}).filter(([,id]) => id === mySocketId).map(([s]) => s);
  const canDeal = status === 'betting' && gs.activeSeats.length > 0 && mySeats.length > 0;
  if (canDeal) show('deal-btn-wrap'); else hide('deal-btn-wrap');

  // Clear/rebet
  const myHasBets = mySeats.some(s => gs.bets[s]?.main > 0);
  if (myHasBets && status === 'betting') show('btn-clear'); else hide('btn-clear');

  // Rebet / 2x
  const hasLastBets = gs.lastRoundBets && gs.lastRoundBets[mySocketId]?.length > 0;
  if (hasLastBets && status === 'betting' && !myHasBets) show('btn-rebet'); else hide('btn-rebet');
  if (myHasBets && status === 'betting') show('btn-2x'); else hide('btn-2x');

  // Render each seat
  for (let i = 1; i <= 5; i++) {
    const sid = String(i);
    renderSeat(sid, gs, players);
  }

  // Dealer hand
  renderDealer(gs);

  // Win overlay
  if (gs.gameStatus === 'game_over' && gs.grandTotal > 0) {
    const myWon = calcMyWinnings(gs, players);
    if (myWon > 0) showWinOverlay(myWon);
  }

  // Status message
  updateStatusMsg(gs, players);
}

function calcMyWinnings(gs, players) {
  let total = 0;
  for (const [sid, ownerId] of Object.entries(gs.seatOwners || {})) {
    if (ownerId !== mySocketId) continue;
    const badges = gs.badges?.[sid] || [];
    const hasBJ  = badges.some(b => b.cls === 'bj');
    const hasWin = badges.some(b => b.cls === 'win');
    const hasPush = badges.some(b => b.cls === 'push');
    if (hasBJ)   total += Math.floor(gs.bets[sid].main * 2.5);
    else if (hasWin)  total += gs.bets[sid].main * 2;
    else if (hasPush) total += gs.bets[sid].main;
    // side bet wins
    if (gs.sideBetWins?.[sid]?.pp) total += gs.sideBetWins[sid].pp.payout;
    if (gs.sideBetWins?.[sid]?.sp) total += gs.sideBetWins[sid].sp.payout;
  }
  return total;
}

function updateStatusMsg(gs, players) {
  const el = $('status-message');
  if (!el) return;
  const status = gs.gameStatus;
  if (status === 'betting' || status === 'idle') {
    const cnt = Object.keys(gs.seatOwners || {}).length;
    el.textContent = cnt === 0 ? 'Click a seat to join!' : 'Place your bets';
  } else if (status === 'dealing') {
    el.textContent = 'Dealing…';
  } else if (status === 'playing') {
    if (activeTurnSid) {
      const ownerId = gs.seatOwners?.[activeTurnSid];
      const pName   = ownerId ? players[ownerId]?.name : '?';
      const isMe    = ownerId === mySocketId;
      el.textContent = isMe ? `Your turn — Seat ${activeTurnSid}` : `${pName}'s turn — Seat ${activeTurnSid}`;
    }
  } else if (status === 'dealer_turn') {
    el.textContent = "Dealer\u2019s turn\u2026";
  } else if (status === 'game_over') {
    el.textContent = 'Round over — next round soon…';
  }
}

// ── Seat Rendering ────────────────────────────────────────────
function renderSeat(sid, gs, players) {
  const seatEl = $('seat-' + sid);
  if (!seatEl) return;

  const ownerId  = gs.seatOwners?.[sid];
  const isMine   = ownerId === mySocketId;
  const isClaimed = !!ownerId;
  const ownerName = ownerId ? players[ownerId]?.name : null;
  const isBetting = ['betting','idle'].includes(gs.gameStatus);

  // Claim overlay / my-seat class
  const mainCircle = seatEl.querySelector('.bet-circle.main-bet');
  if (isClaimed) {
    seatEl.classList.add('my-seat');
    mainCircle?.classList.add('claimed');
  } else {
    seatEl.classList.remove('my-seat');
    mainCircle?.classList.remove('claimed');
  }

  // Leave button
  const leaveBtn = seatEl.querySelector('.leave-seat-btn');
  if (leaveBtn) {
    if (isMine && isBetting) leaveBtn.classList.remove('hidden');
    else leaveBtn.classList.add('hidden');
  }

  // Name tag
  const nameTag = seatEl.querySelector('.seat-name-tag');
  if (nameTag) {
    if (ownerName) {
      nameTag.textContent = ownerName;
      nameTag.classList.remove('hidden');
      // Color by owner
      nameTag.style.background = isMine ? 'rgba(255,215,0,0.18)' : 'rgba(255,255,255,0.1)';
      nameTag.style.color      = isMine ? '#ffd700' : '#fff';
    } else {
      nameTag.classList.add('hidden');
    }
  }

  // Betting circles
  for (const type of ['main','pp','sp']) {
    renderCircle(sid, type, gs, isMine && isBetting);
  }

  // Hand
  renderHand(sid, gs);

  // Score
  renderScore(sid, gs);

  // Badges
  renderBadges(sid, gs);

  // Active turn highlight
  const isActiveTurn = activeTurnSid === sid;
  seatEl.classList.toggle('active-turn', isActiveTurn);

  // Bust visual
  renderBust(sid, gs);
}

function renderCircle(sid, type, gs, canBet) {
  const circle = document.querySelector(`.bet-circle[data-seat="${sid}"][data-type="${type}"]`);
  if (!circle) return;

  const amt = gs.bets?.[sid]?.[type] || 0;

  // Click handler — only for my seats during betting
  circle.onclick = null;
  if (canBet && gs.gameStatus === 'betting') {
    if (type === 'main') {
      const ownerId = gs.seatOwners?.[sid];
      if (!ownerId) {
        circle.onclick = () => socket.emit('claimSeat', { sid });
      } else if (ownerId === mySocketId && selectedChip) {
        circle.onclick = () => socket.emit('placeBet', { sid, type: 'main', amt: selectedChip });
      }
    } else if (gs.seatOwners?.[sid] === mySocketId) {
      circle.onclick = () => socket.emit('placeBet', { sid, type, amt: selectedChip });
    }
  } else if (!gs.seatOwners?.[sid] && gs.gameStatus === 'betting') {
    circle.onclick = () => {
      const name = myName;
      socket.emit('claimSeat', { sid });
    };
  }

  // Render chip stack
  circle.querySelectorAll('.chip-stack').forEach(s => s.remove());
  circle.querySelectorAll('.mult-bubble').forEach(b => b.remove());

  // Side bet win
  const winData = gs.sideBetWins?.[sid]?.[type === 'pp' ? 'pp' : 'sp'];
  if (winData && type !== 'main') {
    renderWinChip(circle, winData, type);
    renderMultBubble(circle, `${winData.mult}:1`);
    return;
  }

  if (amt > 0) renderChipStack(circle, amt, type === 'main');

  // has-bet class
  circle.classList.toggle('has-bet', amt > 0);
}

function renderChipStack(circle, amt, isMain) {
  const denom = [10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];
  const chips = [];
  let rem = amt;
  for (const d of denom) {
    while (rem >= d && chips.length < 8) { chips.push(d); rem -= d; }
    if (chips.length >= 8) break;
  }
  const chipW  = isMain ? 58 : 38;
  const offsetY = isMain ? 4 : 3;
  const stack = document.createElement('div');
  stack.className = 'chip-stack';

  chips.forEach((val, i) => {
    const cols = CHIP_COLORS[val] || '#888,#444';
    const [c1, c2] = cols.split(',');
    const chip = document.createElement('div');
    chip.className = 'stacked-chip';
    chip.style.cssText = `width:${chipW}px;height:${chipW}px;background:radial-gradient(circle at 35% 35%,${c1},${c2});bottom:${4+i*offsetY}px;left:50%;transform:translateX(-50%);`;
    stack.appendChild(chip);
  });

  // Amount label on top chip
  const topBottom = 4 + (chips.length-1)*offsetY;
  const lbl = document.createElement('div');
  lbl.className = 'chip-stack-amt';
  lbl.style.bottom = (topBottom + chipW/2 - 9) + 'px';
  lbl.style.top    = 'auto';
  lbl.textContent  = fmtAmt(amt);
  stack.appendChild(lbl);
  circle.appendChild(stack);
}

function renderWinChip(circle, winData, type) {
  const chipW = type === 'main' ? 58 : 38;
  const stack = document.createElement('div');
  stack.className = 'chip-stack';
  const chip = document.createElement('div');
  chip.className = 'stacked-chip';
  chip.style.cssText = `width:${chipW}px;height:${chipW}px;background:radial-gradient(circle at 35% 35%,#ffe066,#c8900a);bottom:4px;left:50%;transform:translateX(-50%);`;
  stack.appendChild(chip);
  const lbl = document.createElement('div');
  lbl.className = 'chip-stack-amt';
  lbl.style.color  = '#ffd700';
  lbl.style.bottom = (4 + chipW/2 - 9) + 'px';
  lbl.style.top    = 'auto';
  lbl.textContent  = '+' + fmtAmt(winData.payout);
  stack.appendChild(lbl);
  circle.appendChild(stack);
}

function renderMultBubble(circleEl, label) {
  const bubble = document.createElement('div');
  bubble.className = 'mult-bubble';
  bubble.textContent = label;
  circleEl.appendChild(bubble);
}

// ── Hand Rendering ────────────────────────────────────────────
function renderHand(sid, gs) {
  const el = $('hand-' + sid);
  if (!el) return;

  if (gs.splitActive?.[sid]) {
    // For split, do a smart diff per sub-hand
    let wrap = el.querySelector('.split-hands');
    if (!wrap) {
      el.innerHTML = '';
      el.classList.add('split-mode');
      wrap = document.createElement('div');
      wrap.className = 'split-hands';
      el.appendChild(wrap);
    }

    ['hand1','hand2'].forEach((hk, idx) => {
      const h = gs.hands?.[sid]?.[hk] || [];
      const isActive = idx === (gs.splitHandIndex?.[sid] || 0);

      let col = wrap.querySelector(`.split-col[data-hk="${hk}"]`);
      if (!col) {
        col = document.createElement('div');
        col.dataset.hk = hk;
        col.className = 'split-col' + (isActive ? ' active-split-col' : '');

        const scorePill = document.createElement('div');
        scorePill.className = 'score-display split-score';
        scorePill.id = `score-${sid}-${hk}`;
        scorePill.innerHTML = `<span class="bust-num">0</span><span class="bust-icon">💥</span>`;
        scorePill.classList.add('hidden');

        const handDiv = document.createElement('div');
        handDiv.className = 'split-hand' + (isActive ? ' active-split' : '');
        handDiv.dataset.handDiv = hk;

        col.appendChild(scorePill);
        col.appendChild(handDiv);
        wrap.appendChild(col);
      }

      // Update active state
      col.className = 'split-col' + (isActive ? ' active-split-col' : '');
      const handDiv = col.querySelector(`[data-hand-div="${hk}"], .split-hand`);
      if (handDiv) {
        handDiv.className = 'split-hand' + (isActive ? ' active-split' : '');
        // Smart diff — only add new cards
        const existing = handDiv.querySelectorAll('.card').length;
        h.slice(existing).forEach((c, i) => {
          handDiv.appendChild(mkCard(c, true));
        });
      }

      // Update score pill
      const stood = gs.stoodSeats?.includes(sid);
      const sv = scoreLabel(h, stood);
      const pill = col.querySelector('.split-score');
      if (pill) {
        pill.querySelector('.bust-num').textContent = sv;
        if (h.length) pill.classList.remove('hidden');
      }
    });

  } else {
    el.classList.remove('split-mode');
    const hand = Array.isArray(gs.hands?.[sid]) ? gs.hands[sid] : [];
    const existing = el.querySelectorAll('.card').length;

    if (hand.length < existing) {
      // New round — wipe
      el.innerHTML = '';
      hand.forEach((c) => el.appendChild(mkCard(c, false)));
    } else {
      // Only append new cards
      hand.slice(existing).forEach((c) => el.appendChild(mkCard(c, true)));
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
  const label = scoreLabel(hand, stood);
  el.innerHTML = `<span class="bust-num">${label}</span><span class="bust-icon">💥</span>`;
  el.classList.remove('hidden');

  // Bust styling
  const s = score(hand);
  if (s > 21) {
    el.classList.add('busted');
    setTimeout(() => el.classList.add('show-icon'), 800);
  } else {
    el.classList.remove('busted','show-icon');
  }
}

function renderBust(sid, gs) {
  if (gs.bustSeats?.[sid]) {
    const el = $('score-' + sid);
    if (el && !gs.splitActive?.[sid]) {
      el.classList.add('busted');
      setTimeout(() => el.classList.add('show-icon'), 800);
    }
  }
}

function renderBadges(sid, gs) {
  const seatEl = $('seat-' + sid);
  if (!seatEl) return;
  seatEl.querySelectorAll('.result-badge').forEach(b => b.remove());
  const badges = gs.badges?.[sid] || [];
  // Show only last badge per cls to avoid stacking
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

function mkCard(c, animate) {
  const div = document.createElement('div');
  div.className = 'card';
  if (!animate) div.style.animation = 'none';
  const code = (c.value === '10' ? '0' : c.value) + c.suit;
  const img  = document.createElement('img');
  img.src = 'https://deckofcardsapi.com/static/img/' + code + '.png';
  img.onerror = () => {
    div.removeChild(img);
    div.style.cssText += ';background:#fff;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;color:' + (['H','D'].includes(c.suit)?'#c00':'#111');
    div.textContent = c.value + ({S:'♠',H:'♥',D:'♦',C:'♣'}[c.suit]||'');
  };
  div.appendChild(img);
  return div;
}

// ── Dealer ────────────────────────────────────────────────────
function renderDealer(gs) {
  const el = $('dealer-hand');
  if (!el) return;
  const hand = gs.hands?.dealer || [];

  // On reveal: wipe and re-render hole card face-up (no animation on existing cards)
  const wasHidden = el.querySelector('.card-back');
  if (gs.dealerRevealed && wasHidden) {
    el.innerHTML = '';
    hand.forEach((c, i) => el.appendChild(mkCard(c, false)));
  } else if (!gs.dealerRevealed) {
    // Smart diff during dealing
    const existingCards = el.querySelectorAll('.card, .card-back').length;
    if (hand.length < existingCards) {
      el.innerHTML = ''; // new round wipe
    } else {
      hand.slice(existingCards).forEach((c, i) => {
        const globalIdx = existingCards + i;
        if (globalIdx === 1 && !gs.dealerRevealed) {
          const back = document.createElement('div');
          back.className = 'card-back';
          el.appendChild(back);
        } else {
          el.appendChild(mkCard(c, true));
        }
      });
    }
  } else {
    // Dealer turn extra cards — smart append
    const existingCards = el.querySelectorAll('.card, .card-back').length;
    hand.slice(existingCards).forEach((c) => el.appendChild(mkCard(c, true)));
  }

  const scoreEl = $('dealer-score');
  if (scoreEl) {
    if (hand.length > 0) {
      const displayHand = gs.dealerRevealed ? hand : [hand[0]];
      const ds = score(displayHand);
      scoreEl.innerHTML = `<span class="bust-num">${ds}</span>`;
      scoreEl.classList.remove('hidden');
      if (gs.dealerRevealed && ds > 21) {
        scoreEl.classList.add('busted');
        setTimeout(() => scoreEl.classList.add('show-icon'), 800);
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
    ? gs.hands?.[sid]?.['hand'+(gs.splitHandIndex?.[sid]||0)+1] || []
    : gs.hands?.[sid] || [];
  const sc = score(hand);
  const canDouble = hand.length === 2 && myWallet >= (gs.bets?.[sid]?.main || 0) && !gs.doubled?.[sid];
  const canSplit  = hand.length === 2 && !gs.splitActive?.[sid]
                    && cardNum(hand[0]) === cardNum(hand[1])
                    && myWallet >= (gs.bets?.[sid]?.main || 0);
  $('btn-double').classList.toggle('hidden', !canDouble);
  $('btn-split').classList.toggle('hidden', !canSplit);
  show('play-buttons');
}

$('btn-hit').addEventListener('click', () => {
  if (activeTurnSid) socket.emit('action', { action: 'hit', sid: activeTurnSid });
});
$('btn-stand').addEventListener('click', () => {
  if (activeTurnSid) socket.emit('action', { action: 'stand', sid: activeTurnSid });
});
$('btn-double').addEventListener('click', () => {
  if (activeTurnSid) socket.emit('action', { action: 'double', sid: activeTurnSid });
});
$('btn-split').addEventListener('click', () => {
  if (activeTurnSid) socket.emit('action', { action: 'split', sid: activeTurnSid });
});

// ── Chip tray ─────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
    selectedChip = parseInt(chip.dataset.value);
  });
});
// Select €100 by default
document.querySelector('.chip[data-value="100"]')?.classList.add('selected');

$('btn-deal').addEventListener('click', () => socket.emit('deal'));
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

// ── Insurance ────────────────────────────────────────────────
function showInsuranceModal() {
  if (!prevGs) return;
  const gs = prevGs;
  const modal = $('insurance-modal');
  const seatsContainer = $('insurance-seats');
  seatsContainer.innerHTML = '';

  const mySeats = Object.entries(gs.seatOwners || {})
    .filter(([, id]) => id === mySocketId)
    .map(([sid]) => sid);

  if (!mySeats.length) return;

  const choices = {};
  mySeats.forEach(sid => {
    choices[sid] = false;
    const cost = Math.floor(gs.bets[sid].main / 2);
    const canAfford = myWallet >= cost;
    const row = document.createElement('div');
    row.className = 'ins-row';
    row.innerHTML = `
      <span class="ins-seat-label">Seat ${sid} — Cost: €${cost}</span>
      <button class="ins-yes${canAfford?'':' ins-disabled'}" data-sid="${sid}" ${canAfford?'':'disabled'}>✓ Insure</button>
      <button class="ins-no" data-sid="${sid}">✕ Decline</button>
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
  document.querySelectorAll('.round-result-overlay').forEach(e => e.remove());
  const overlay = document.createElement('div');
  overlay.className = 'round-result-overlay';
  overlay.innerHTML = `<div class="rr-label">You Win!</div><div class="rr-amount">€${amount.toLocaleString()}</div>`;
  document.getElementById('game-container').appendChild(overlay);
  setTimeout(() => overlay.classList.add('rr-fadeout'), 1800);
  setTimeout(() => { overlay.remove(); winOverlayShown = false; }, 2600);
}

// Reset win overlay flag on new round
socket.on('stateUpdate', ({ gs }) => {
  if (gs.gameStatus === 'betting') {
    winOverlayShown = false;
    activeTurnSid   = null;
    hide('play-buttons');
    // Clear fly-out cards on new round
    document.querySelectorAll('.card, .card-back').forEach((c, i) => {
      c.style.animationDelay = (i * 0.04) + 's';
      c.classList.add('fly-out');
    });
  }
});

// ── Info panel hover ──────────────────────────────────────────
const infoPanel = $('table-info-panel');
if (infoPanel) {
  infoPanel.addEventListener('mouseenter', () => {
    $('table-payout-menu')?.classList.add('visible');
  });
  infoPanel.addEventListener('mouseleave', () => {
    $('table-payout-menu')?.classList.remove('visible');
  });
}
