// =============================================================
// BLACKJACK MULTIPLAYER — client.js  v5
// =============================================================
const socket = io();

let mySocketId      = null;
let myName          = '';
let myWallet        = 5000;
let roomCode        = null;
let selectedChip    = 100;
let activeTurnSid   = null;
let activeTurnHandIdx = 0;
let prevGs          = null;
let winOverlayShown = false;
let actionPending   = false;
let sfxVolume       = 0.4;

// Round tracking for history
let currentRoundLog = null; // built during a round, saved on game_over

const CHIP_COLORS = {
  1:'#e8e8e8,#b0b0b0', 2:'#d0d0d0,#888', 5:'#e03030,#900',
  10:'#1a7ad4,#0a4a9a', 25:'#2da84e,#155a28', 50:'#c07020,#804010',
  100:'#222,#111', 200:'#b050f0,#6000b0', 500:'#8030a0,#400060',
  1000:'#e0b000,#a07000', 2000:'#e07030,#c03000',
  5000:'#10b0b0,#006060', 10000:'#f050a0,#900040',
};

// ── Audio ──────────────────────────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let actx = null;
function getACtx() { if (!actx) actx = new AudioCtx(); return actx; }
function playTone(freq, dur, type='sine', vol=sfxVolume) {
  if (!vol) return;
  try {
    const ctx = getACtx(), osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol*0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+dur);
    osc.start(); osc.stop(ctx.currentTime+dur);
  } catch(e){}
}
function sfxChip()  { playTone(900,0.06,'square',sfxVolume*0.5); }
function sfxCard()  {
  try {
    const ctx = getACtx(), buf = ctx.createBuffer(1,ctx.sampleRate*0.08,ctx.sampleRate);
    const d = buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.3));
    const src=ctx.createBufferSource(), f=ctx.createBiquadFilter(), g=ctx.createGain();
    f.type='bandpass'; f.frequency.value=3800; f.Q.value=0.8;
    src.buffer=buf; src.connect(f); f.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(sfxVolume*0.6,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.08);
    src.start();
  } catch(e){ playTone(300,0.08,'triangle'); }
}
function sfxWin()  { [600,800,1000].forEach((f,i)=>setTimeout(()=>playTone(f,0.18,'sine'),i*80)); }
function sfxBust() { [200,160,120].forEach((f,i)=>setTimeout(()=>playTone(f,0.15,'sawtooth'),i*60)); }
function sfxDeal() { playTone(440,0.1,'triangle'); }
function sfxClick(){ playTone(600,0.04,'square',sfxVolume*0.4); }

// ── Utils ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id)?.classList.remove('hidden');
const hide = id => $(id)?.classList.add('hidden');
function fmt(n) { return n>=1000 ? '€'+(n/1000).toFixed(n%1000===0?0:1)+'k' : '€'+n; }
function fmtNet(n) { return (n>=0?'+':'')+fmt(n); }
function score(hand) {
  if(!Array.isArray(hand)||!hand.length) return 0;
  let t=0,a=0;
  for(const c of hand){
    if(['J','Q','K'].includes(c.value)) t+=10;
    else if(c.value==='A'){a++;t+=11;}
    else t+=parseInt(c.value)||0;
  }
  while(t>21&&a>0){t-=10;a--;}
  return t;
}
function scoreLabel(hand,stood){
  if(!Array.isArray(hand)||!hand.length) return '';
  let t=0,a=0;
  for(const c of hand){
    if(['J','Q','K'].includes(c.value)) t+=10;
    else if(c.value==='A'){a++;t+=11;}
    else t+=parseInt(c.value)||0;
  }
  while(t>21&&a>0){t-=10;a--;}
  if(a>0&&t!==21&&!stood) return `${t-10}/${t}`;
  return String(t);
}
function cardNum(c){
  if(['J','Q','K'].includes(c.value)) return 10;
  if(c.value==='A') return 11;
  return parseInt(c.value);
}
function cardStr(c){ return c.value+({S:'♠',H:'♥',D:'♦',C:'♣'}[c.suit]||''); }
function suitIsRed(s){ return s==='H'||s==='D'; }

// ── localStorage helpers ────────────────────────────────────────
function loadName() {
  try { return JSON.parse(localStorage.getItem('kk_name')||'null')||''; } catch(e){ return ''; }
}
function saveName(n) {
  try { localStorage.setItem('kk_name', JSON.stringify(n)); } catch(e){}
}

// ── History localStorage ────────────────────────────────────────
// Structure: kk_history = [ { date, roomCode, tableName, roundId, time, seats:[{sid,mainBet,ppBet,spBet,hands:[{cards,decisions,result,score}],ppResult,spResult}], netCash, totalBet } ]
function loadHistory() {
  try { return JSON.parse(localStorage.getItem('kk_history')||'[]'); } catch(e){ return []; }
}
function saveHistory(h) {
  try { localStorage.setItem('kk_history', JSON.stringify(h)); } catch(e){}
}
function pushRound(entry) {
  const h = loadHistory();
  h.unshift(entry);
  if(h.length > 500) h.length = 500;
  saveHistory(h);
}

// ── Pre-fill name ──────────────────────────────────────────────
(function(){
  const saved = loadName();
  if(saved) {
    const inp = $('lobby-name');
    if(inp) inp.value = saved;
  }
})();

// ── Lobby ──────────────────────────────────────────────────────
$('btn-create-room').addEventListener('click', () => {
  const name = $('lobby-name').value.trim();
  if(!name){ showLobbyError('Enter your name first'); return; }
  myName = name; saveName(name);
  socket.emit('createRoom', { name, wallet:5000 });
});
$('btn-join-room').addEventListener('click', () => {
  const name = $('lobby-name').value.trim();
  const code = $('lobby-code-input').value.trim().toUpperCase();
  if(!name){ showLobbyError('Enter your name first'); return; }
  if(code.length!==4){ showLobbyError('Enter a 4-digit room code'); return; }
  myName = name; saveName(name);
  socket.emit('joinRoom', { code, name, wallet:5000 });
});
$('lobby-code-input').addEventListener('keydown', e=>{ if(e.key==='Enter') $('btn-join-room').click(); });
$('lobby-name').addEventListener('keydown',      e=>{ if(e.key==='Enter') $('btn-create-room').click(); });
$('btn-start-game').addEventListener('click', ()=>{ sfxClick(); socket.emit('startGame'); });
$('btn-leave-room').addEventListener('click', ()=> showLeaveConfirm());

function showLobbyError(msg){
  const el=$('lobby-error'); el.textContent=msg; el.classList.remove('hidden');
  setTimeout(()=>el.classList.add('hidden'),3000);
}

// ── Leave confirm modal ────────────────────────────────────────
function showLeaveConfirm(){
  let modal = $('leave-confirm-modal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'leave-confirm-modal';
    modal.innerHTML = `
      <div class="leave-confirm-card">
        <div class="leave-confirm-title">Leave Room?</div>
        <div class="leave-confirm-sub">You'll lose your current seat and bets.</div>
        <div class="leave-confirm-btns">
          <button id="leave-confirm-yes" class="leave-btn-yes">Leave</button>
          <button id="leave-confirm-no"  class="leave-btn-no">Stay</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    $('leave-confirm-yes').addEventListener('click',()=>{ socket.disconnect(); location.reload(); });
    $('leave-confirm-no').addEventListener('click', ()=>modal.remove());
  }
}

function launchGame(){
  hide('waiting-screen'); hide('lobby-screen');
  show('game-container'); show('chip-tray');
  // No player-greeting-wrap name shown
}

// ── Socket events ──────────────────────────────────────────────
socket.on('roomJoined',({ code, socketId, isHost })=>{
  mySocketId=socketId; roomCode=code;
  hide('lobby-screen'); show('waiting-screen');
  $('waiting-code').textContent    = code;
  $('room-badge-code').textContent = code;
  updateWaitingHostUI(isHost);
});
socket.on('roomError', msg=>showLobbyError(msg));
socket.on('gameLaunched', ()=>launchGame());
socket.on('autoLaunch',   ()=>launchGame());
socket.on('hostChanged',({ hostId })=>{
  updateWaitingHostUI(hostId===mySocketId);
  if(hostId===mySocketId){
    const t=document.createElement('div'); t.className='host-toast';
    t.textContent='👑 You are now the host';
    document.body.appendChild(t); setTimeout(()=>t.remove(),3000);
  }
});

function updateWaitingHostUI(isHost){
  const btn=$('btn-start-game');
  if(btn) btn.style.display=isHost?'':'none';
}

socket.on('stateUpdate',({ gs, players, hostId })=>{
  // Waiting room list
  const wl=$('waiting-players');
  if(wl){
    wl.innerHTML=Object.entries(players).map(([id,p])=>{
      const crown=(id===hostId)?'<span class="lobby-crown">👑</span>':'';
      return `<div class="waiting-player">${crown}${p.name}</div>`;
    }).join('');
  }
  const sb=$('btn-start-game');
  if(sb) sb.style.display=(mySocketId===hostId)?'':'none';

  // Record round data
  trackRound(gs, players);

  renderState(gs,players,hostId);
  prevGs=JSON.parse(JSON.stringify(gs));
});

socket.on('timerTick', secs=>{
  const el=$('bet-timer-text'), bar=$('bet-timer-bar');
  if(el) el.textContent=secs;
  if(bar) bar.style.width=(secs/15*100)+'%';
  show('bet-timer-wrap');
  if(secs<=5&&secs>0) playTone(880,0.05,'square',sfxVolume*0.3);
});
socket.on('timerCancel',()=>hide('bet-timer-wrap'));
socket.on('yourTurn',({ sid, handIdx, ownerId })=>{
  activeTurnSid=sid; activeTurnHandIdx=handIdx||0; actionPending=false;
  if(ownerId===mySocketId) showPlayButtons(sid,handIdx||0);
  else hide('play-buttons');
  // Track decisions per hand
  if(currentRoundLog){
    const myEntry = currentRoundLog.seats.find(s=>s.sid===sid && s.ownerSocketId===mySocketId);
    if(myEntry && !myEntry._currentHandIdx) myEntry._currentHandIdx = handIdx||0;
  }
});
socket.on('dealVote',({ ready, needed, readyIds })=>{
  const btn=$('btn-deal'); if(!btn) return;
  if(readyIds.includes(mySocketId)){
    btn.textContent=`Waiting… (${ready}/${needed})`; btn.disabled=true; btn.style.opacity='0.6';
  } else {
    btn.textContent=`Deal (${ready}/${needed} ready)`; btn.disabled=false; btn.style.opacity='1';
  }
});
socket.on('insuranceOffer',()=>showInsuranceModal());

// ── Round tracking for history ──────────────────────────────────
function trackRound(gs, players){
  // When dealing starts, init log
  if(gs.gameStatus==='dealing' && !currentRoundLog){
    currentRoundLog = {
      time: new Date().toISOString(),
      roomCode: roomCode,
      tableName: 'Kikikov BlackJack',
      seats: [],
      decisions: {},  // { "sid_hk": [action, action, ...] }
      saved: false,
    };
  }
  // On game_over, snapshot everything and save
  if(gs.gameStatus==='game_over' && currentRoundLog && !currentRoundLog.saved){
    currentRoundLog.saved = true;
    buildAndSaveHistory(gs, players);
    currentRoundLog = null;
  }
  // On new betting round, reset
  if(gs.gameStatus==='betting' && currentRoundLog){
    currentRoundLog = null;
  }
}

function buildAndSaveHistory(gs, players){
  const mySeats = Object.entries(gs.seatOwners||{})
    .filter(([,id])=>id===mySocketId)
    .map(([sid])=>sid);
  if(!mySeats.length) return;

  // Seats ordered right-to-left: seat 5 first, seat 1 last
  const orderedSeats = [...mySeats].sort((a,b)=>Number(b)-Number(a));

  let totalBet=0, netCash=0;
  const seatEntries = orderedSeats.map(sid=>{
    const main = gs.bets?.[sid]?.main || 0;
    const pp   = gs.bets?.[sid]?.pp   || 0;
    const sp   = gs.bets?.[sid]?.sp   || 0;
    totalBet += main+pp+sp;

    const badges   = gs.badges?.[sid] || [];
    const hasBJ    = badges.some(b=>b.cls==='bj');
    const hasWin   = badges.some(b=>b.cls==='win');
    const hasPush  = badges.some(b=>b.cls==='push');
    let mainReturn = 0;
    if(hasBJ)        mainReturn = Math.floor(main*2.5);
    else if(hasWin)  mainReturn = main*2;
    else if(hasPush) mainReturn = main;
    const mainNet = mainReturn - main;

    const ppWin = gs.sideBetWins?.[sid]?.pp?.payout || 0;
    const spWin = gs.sideBetWins?.[sid]?.sp?.payout || 0;
    const ppNet = ppWin - pp;
    const spNet = spWin - sp;
    netCash += mainNet + ppNet + spNet;

    // Build hand display
    let hands = [];
    if(gs.splitActive?.[sid]){
      ['hand1','hand2'].forEach((hk,i)=>{
        const cards = gs.hands?.[sid]?.[hk] || [];
        const res   = badges[i] || {};
        hands.push({ cards, result: res.text||'', score: score(cards) });
      });
    } else {
      const cards = Array.isArray(gs.hands?.[sid]) ? gs.hands[sid] : [];
      const res   = badges[0] || {};
      hands.push({ cards, result: res.text||'', score: score(cards) });
    }

    return { sid, mainBet:main, ppBet:pp, spBet:sp, mainNet, ppNet, spNet, ppWin, spWin, hands };
  });

  const dealerCards = gs.hands?.dealer || [];

  const entry = {
    id:       Date.now(),
    time:     new Date().toISOString(),
    roomCode: roomCode,
    tableName:'Kikikov BlackJack',
    totalBet,
    netCash,
    seats: seatEntries,
    dealerCards,
  };
  pushRound(entry);
}

// ── Volume slider ──────────────────────────────────────────────
const volSlider=$('sfx-volume'), volLabel=$('sfx-volume-val');
if(volSlider){
  volSlider.addEventListener('input',()=>{
    sfxVolume=parseFloat(volSlider.value);
    if(volLabel) volLabel.textContent=Math.round(sfxVolume*100)+'%';
    sfxClick();
  });
}

// ── Name change in settings ───────────────────────────────────
$('btn-save-name')?.addEventListener('click',()=>{
  const inp=$('settings-name-input');
  const newName=inp?.value.trim();
  if(!newName){ return; }
  myName=newName; saveName(newName);
  socket.emit('changeName',{ name:newName });
  sfxClick();
  const msg=$('settings-name-msg');
  if(msg){ msg.textContent='✓ Saved'; msg.style.color='#ffd700'; setTimeout(()=>msg.textContent='',2000); }
});

// ── Render State ───────────────────────────────────────────────
function renderState(gs,players,hostId){
  const pList=$('players-list');
  if(pList){
    pList.innerHTML=Object.entries(players).map(([id,p])=>{
      const crown=(id===hostId)?'👑 ':'';
      return `<div class="player-entry ${id===mySocketId?'me':''}">
        <span class="pe-name">${crown}${p.name}</span>
        <span class="pe-wallet">€${p.wallet.toLocaleString()}</span>
      </div>`;
    }).join('');
  }
  const me=players[mySocketId];
  if(me){
    myWallet=me.wallet;
    $('wallet-amount').textContent ='€'+me.wallet.toLocaleString();
    $('hud-bet-amount').textContent='€'+(me.totalBet||0).toLocaleString();
  }

  const status  = gs.gameStatus;
  const mySeats = Object.entries(gs.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
  const bLocked = gs.betsLocked;

  // Deal button
  const myHasBets = mySeats.some(s=>gs.bets[s]?.main>0);
  const canDeal   = status==='betting'&&gs.activeSeats.length>0&&mySeats.length>0&&myHasBets;
  const myReady   = Array.isArray(gs.readyPlayers)&&gs.readyPlayers.includes(mySocketId);
  if(canDeal) show('deal-btn-wrap'); else hide('deal-btn-wrap');
  const dealBtn=$('btn-deal');
  if(dealBtn&&!myReady){ dealBtn.disabled=false; dealBtn.style.opacity='1'; if(!bLocked) dealBtn.textContent='DEAL'; }

  // Chip tray — hide undo/2x/clear for EVERYONE when bets are locked
  if(bLocked){
    hide('btn-undo'); hide('btn-clear'); hide('btn-rebet'); hide('btn-2x');
  } else {
    show('btn-undo');
    if(myHasBets&&status==='betting') show('btn-clear'); else hide('btn-clear');
    const hasLast=!!(gs.lastRoundBets?.[mySocketId]?.length);
    if(hasLast&&status==='betting'&&!myHasBets) show('btn-rebet'); else hide('btn-rebet');
    if(myHasBets&&status==='betting') show('btn-2x'); else hide('btn-2x');
  }

  for(let i=1;i<=5;i++) renderSeat(String(i),gs,players);
  renderDealer(gs);

  if(gs.gameStatus==='game_over'&&gs.grandTotal>0){
    const myWon=calcMyWinnings(gs);
    if(myWon>0) showWinOverlay(myWon);
  }
  updateStatusMsg(gs,players);
}

function calcMyWinnings(gs){
  let t=0;
  for(const [sid,ownerId] of Object.entries(gs.seatOwners||{})){
    if(ownerId!==mySocketId) continue;
    const b=gs.badges?.[sid]||[];
    const hasBJ=b.some(x=>x.cls==='bj'), hasWin=b.some(x=>x.cls==='win'), hasPush=b.some(x=>x.cls==='push');
    if(hasBJ)       t+=Math.floor(gs.bets[sid].main*2.5);
    else if(hasWin)  t+=gs.bets[sid].main*2;
    else if(hasPush) t+=gs.bets[sid].main;
    if(gs.sideBetWins?.[sid]?.pp) t+=gs.sideBetWins[sid].pp.payout;
    if(gs.sideBetWins?.[sid]?.sp) t+=gs.sideBetWins[sid].sp.payout;
  }
  return t;
}

function updateStatusMsg(gs,players){
  const el=$('status-message'); if(!el) return;
  const st=gs.gameStatus;
  if(st==='betting'||st==='idle'){
    if(gs.betsLocked&&gs.readyPlayers?.length){
      const n=new Set(gs.activeSeats.map(s=>gs.seatOwners?.[s]).filter(Boolean)).size;
      el.textContent=`Waiting for all to deal… (${gs.readyPlayers.length}/${n})`;
    } else {
      el.textContent=Object.keys(gs.seatOwners||{}).length===0?'Click a seat to join!':'Place your bets';
    }
  } else if(st==='dealing'){ el.textContent='Dealing…';
  } else if(st==='playing'){
    if(activeTurnSid){
      const oid=gs.seatOwners?.[activeTurnSid];
      const pn=oid?players[oid]?.name:'?';
      el.textContent=(oid===mySocketId)?`Your turn — Seat ${activeTurnSid}`:`${pn}'s turn`;
    }
  } else if(st==='dealer_turn'){ el.textContent='Dealer\u2019s turn\u2026';
  } else if(st==='game_over'){   el.textContent='Round over — next round soon\u2026'; }
}

// ── Seat Rendering ─────────────────────────────────────────────
function renderSeat(sid,gs,players){
  const seatEl=$('seat-'+sid); if(!seatEl) return;
  const ownerId=gs.seatOwners?.[sid], isMine=ownerId===mySocketId;
  const ownerName=ownerId?players[ownerId]?.name:null;
  const isBetting=['betting','idle'].includes(gs.gameStatus);
  const mainCircle=seatEl.querySelector('.bet-circle.main-bet');
  if(ownerId){ seatEl.classList.add('my-seat'); mainCircle?.classList.add('claimed'); }
  else { seatEl.classList.remove('my-seat'); mainCircle?.classList.remove('claimed'); }
  const lb=seatEl.querySelector('.leave-seat-btn');
  if(lb){ if(isMine&&isBetting) lb.classList.remove('hidden'); else lb.classList.add('hidden'); }
  const nt=seatEl.querySelector('.seat-name-tag');
  if(nt){
    if(ownerName){ nt.textContent=ownerName; nt.classList.remove('hidden');
      nt.style.background=isMine?'rgba(255,215,0,0.18)':'rgba(255,255,255,0.1)';
      nt.style.color=isMine?'#ffd700':'#fff';
    } else nt.classList.add('hidden');
  }
  for(const t of ['main','pp','sp']) renderCircle(sid,t,gs,isMine&&isBetting);
  renderHand(sid,gs);
  renderScore(sid,gs);
  renderBadges(sid,gs);
  renderBust(sid,gs);
  seatEl.classList.toggle('active-turn', activeTurnSid===sid);
}

// ── Betting Circles ────────────────────────────────────────────
function renderCircle(sid,type,gs,canBet){
  const circle=document.querySelector(`.bet-circle[data-seat="${sid}"][data-type="${type}"]`);
  if(!circle) return;
  const amt=gs.bets?.[sid]?.[type]||0;
  circle.onclick=null;
  const ba=['betting','idle'].includes(gs.gameStatus)&&!gs.betsLocked;
  if(ba){
    if(type==='main'){
      const oid=gs.seatOwners?.[sid];
      if(!oid) circle.onclick=()=>{ sfxClick(); socket.emit('claimSeat',{sid}); };
      else if(oid===mySocketId) circle.onclick=()=>{ sfxChip(); socket.emit('placeBet',{sid,type:'main',amt:selectedChip}); };
    } else if(gs.seatOwners?.[sid]===mySocketId){
      circle.onclick=()=>{ sfxChip(); socket.emit('placeBet',{sid,type,amt:selectedChip}); };
    } else if(!gs.seatOwners?.[sid]){
      circle.onclick=()=>{ sfxClick(); socket.emit('claimSeat',{sid}); };
    }
  }
  circle.querySelectorAll('.chip-stack,.sidebet-win-pill').forEach(e=>e.remove());
  const wk=type==='pp'?'pp':'sp', wd=gs.sideBetWins?.[sid]?.[wk];
  if(wd&&type!=='main'){ renderSideBetWinPill(circle,wd,type); return; }
  if(amt>0) renderChipStack(circle,amt,type==='main');
  circle.classList.toggle('has-bet',amt>0);
}

function renderSideBetWinPill(circle,winData,type){
  renderChipStack(circle,winData.payout,false,true);
  const pill=document.createElement('div');
  pill.className='sidebet-win-pill';
  pill.textContent=`${winData.mult}:1`;
  circle.appendChild(pill);
  circle.classList.add('has-bet');
}

function renderChipStack(circle,amt,isMain,isGold=false){
  const denom=[10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];
  const chips=[]; let rem=amt;
  for(const d of denom){ while(rem>=d&&chips.length<8){chips.push(d);rem-=d;} if(chips.length>=8) break; }
  // chipW: main circle is 66px diameter, side bet is 44px — chips fill ~85% of circle
  const chipW  = isMain ? 56 : 36;
  const offsetY= isMain ? 4 : 3;
  const stack=document.createElement('div');
  stack.className='chip-stack';
  chips.forEach((val,i)=>{
    let c1,c2;
    if(isGold){c1='#ffe066';c2='#c8900a';}
    else{const cols=CHIP_COLORS[val]||'#888,#444';[c1,c2]=cols.split(',');}
    const chip=document.createElement('div');
    chip.className='stacked-chip';
    chip.style.cssText=`width:${chipW}px;height:${chipW}px;background:radial-gradient(circle at 35% 35%,${c1},${c2});bottom:${4+i*offsetY}px;left:50%;transform:translateX(-50%);`;
    stack.appendChild(chip);
  });
  const topBottom=4+(chips.length-1)*offsetY;
  const lbl=document.createElement('div');
  lbl.className='chip-stack-amt';
  if(isGold) lbl.style.color='#ffd700';
  // Place label centred on top chip face
  lbl.style.bottom=(topBottom+chipW/2-9)+'px';
  lbl.style.top='auto';
  lbl.textContent=fmt(amt);
  stack.appendChild(lbl);
  circle.appendChild(stack);
}

function ensureSplitBetCircle(seatEl,sid,gs){
  let sc=seatEl.querySelector('.split-bet-circle');
  if(!gs.splitActive?.[sid]){ if(sc) sc.remove(); return; }
  if(!sc){ sc=document.createElement('div'); sc.className='split-bet-circle'; seatEl.querySelector('.betting-circles')?.appendChild(sc); }
  sc.querySelectorAll('.chip-stack').forEach(e=>e.remove());
  const sb=gs.splitBets?.[sid]||Math.floor((gs.bets?.[sid]?.main||0)/2);
  if(sb>0) renderChipStack(sc,sb,true);
}

// ── Hand Rendering ─────────────────────────────────────────────
function renderHand(sid,gs){
  const el=$('hand-'+sid); if(!el) return;
  if(gs.splitActive?.[sid]){
    let wrap=el.querySelector('.split-hands');
    if(!wrap||el.querySelector('.card:not(.split-hands *)')){
      el.innerHTML=''; el.classList.add('split-mode');
      wrap=document.createElement('div'); wrap.className='split-hands'; el.appendChild(wrap);
    }
    const iHA=[activeTurnSid===sid&&activeTurnHandIdx===0, activeTurnSid===sid&&activeTurnHandIdx===1];
    ['hand1','hand2'].forEach((hk,idx)=>{
      const h=gs.hands?.[sid]?.[hk]||[];
      const isActive=idx===(gs.splitHandIndex?.[sid]||0);
      let col=wrap.querySelector(`.split-col[data-hk="${hk}"]`);
      if(!col){
        col=document.createElement('div'); col.dataset.hk=hk; wrap.appendChild(col);
        const sp=document.createElement('div'); sp.className='score-display split-score';
        sp.id=`score-${sid}-${hk}`; sp.innerHTML='<span class="bust-num"></span><span class="bust-icon">💥</span>'; sp.classList.add('hidden');
        const hd=document.createElement('div'); hd.className='split-hand'; hd.dataset.hk=hk;
        const ind=document.createElement('div'); ind.className='split-indicator'; ind.textContent=idx===0?'<':'>';
        col.appendChild(ind); col.appendChild(sp); col.appendChild(hd);
      }
      col.className=`split-col${isActive?' active-split-col':''}`;
      col.classList.toggle('active-turn-hand',iHA[idx]);
      const hd=col.querySelector('.split-hand');
      if(hd){
        const ex=hd.querySelectorAll('.card').length;
        h.slice(ex).forEach(c=>{ sfxCard(); hd.appendChild(mkCard(c,true)); });
      }
      const pill=col.querySelector('.split-score');
      if(pill){
        const stood=gs.stoodSeats?.includes(sid);
        const sv=scoreLabel(h,stood&&idx===(gs.splitHandIndex?.[sid]||0));
        pill.querySelector('.bust-num').textContent=sv;
        if(h.length) pill.classList.remove('hidden'); else pill.classList.add('hidden');
        const sc=score(h);
        if(sc>21){pill.classList.add('busted');setTimeout(()=>pill.classList.add('show-icon'),800);}
        else pill.classList.remove('busted','show-icon');
      }
    });
    const seatEl=$('seat-'+sid); if(seatEl) ensureSplitBetCircle(seatEl,sid,gs);
  } else {
    const seatEl=$('seat-'+sid); if(seatEl) ensureSplitBetCircle(seatEl,sid,gs);
    el.classList.remove('split-mode');
    const hand=Array.isArray(gs.hands?.[sid])?gs.hands[sid]:[];
    const ex=el.querySelectorAll(':scope > .card').length;
    if(hand.length<ex){ el.innerHTML=''; hand.forEach(c=>el.appendChild(mkCard(c,false))); }
    else { hand.slice(ex).forEach(c=>{ sfxCard(); el.appendChild(mkCard(c,true)); }); }
    el.querySelector('.split-hands')?.remove();
  }
}

function renderScore(sid,gs){
  const el=$('score-'+sid); if(!el) return;
  if(gs.splitActive?.[sid]){el.classList.add('hidden');return;}
  const hand=Array.isArray(gs.hands?.[sid])?gs.hands[sid]:[];
  if(!hand.length){el.classList.add('hidden');return;}
  const stood=gs.stoodSeats?.includes(sid);
  el.innerHTML=`<span class="bust-num">${scoreLabel(hand,stood)}</span><span class="bust-icon">💥</span>`;
  el.classList.remove('hidden');
  const sc=score(hand);
  if(sc>21){el.classList.add('busted');setTimeout(()=>el.classList.add('show-icon'),800);}
  else el.classList.remove('busted','show-icon');
}
function renderBust(sid,gs){
  if(!gs.bustSeats) return;
  if(Object.keys(gs.bustSeats).some(k=>k.startsWith(sid))&&!gs.splitActive?.[sid]){
    const el=$('score-'+sid);
    if(el){el.classList.add('busted');setTimeout(()=>el.classList.add('show-icon'),800);}
  }
}
function renderBadges(sid,gs){
  const seatEl=$('seat-'+sid); if(!seatEl) return;
  seatEl.querySelectorAll('.result-badge').forEach(b=>b.remove());
  const badges=gs.badges?.[sid]||[], seen=new Set();
  for(const b of [...badges].reverse()){
    if(seen.has(b.cls)) continue; seen.add(b.cls);
    const div=document.createElement('div'); div.className=`result-badge ${b.cls}`; div.textContent=b.text;
    seatEl.appendChild(div);
    if(b.cls==='win'||b.cls==='bj') sfxWin();
    if(b.cls==='lose'&&b.text==='Bust') sfxBust();
  }
}

// ── Card Factory — with shoe fly-in animation ──────────────────
function mkCard(c,animate){
  const div=document.createElement('div');
  div.className='card'+(animate?' card-deal-anim':'');
  if(!animate) div.style.animation='none';
  const code=(c.value==='10'?'0':c.value)+c.suit;
  const img=document.createElement('img');
  img.src=`https://deckofcardsapi.com/static/img/${code}.png`;
  img.onerror=()=>{
    img.remove();
    div.style.cssText+=';background:#fff;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;color:'+(suitIsRed(c.suit)?'#c00':'#111');
    div.textContent=cardStr(c);
  };
  div.appendChild(img);
  return div;
}

// ── Dealer ─────────────────────────────────────────────────────
function renderDealer(gs){
  const el=$('dealer-hand'); if(!el) return;
  const hand=gs.hands?.dealer||[];
  const wasHidden=el.querySelector('.card-back');
  if(gs.dealerRevealed&&wasHidden){
    el.innerHTML=''; hand.forEach(c=>el.appendChild(mkCard(c,false)));
  } else if(!gs.dealerRevealed){
    const ex=el.querySelectorAll('.card,.card-back').length;
    if(hand.length<ex){el.innerHTML='';}
    else{
      hand.slice(ex).forEach((c,i)=>{
        if(ex+i===1){const b=document.createElement('div');b.className='card-back card-deal-anim';el.appendChild(b);}
        else el.appendChild(mkCard(c,true));
      });
    }
  } else {
    const ex=el.querySelectorAll('.card,.card-back').length;
    hand.slice(ex).forEach(c=>el.appendChild(mkCard(c,true)));
  }
  const scoreEl=$('dealer-score');
  if(scoreEl&&hand.length>0){
    const dh=gs.dealerRevealed?hand:[hand[0]];
    const ds=score(dh);
    scoreEl.innerHTML=`<span class="bust-num">${ds}</span><span class="bust-icon">💥</span>`;
    scoreEl.classList.remove('hidden');
    if(gs.dealerRevealed&&ds>21){scoreEl.classList.add('busted');setTimeout(()=>scoreEl.classList.add('show-icon'),800);}
    else scoreEl.classList.remove('busted','show-icon');
  } else if(scoreEl) scoreEl.classList.add('hidden');
}

// ── Play Buttons ───────────────────────────────────────────────
function showPlayButtons(sid,handIdx){
  const gs=prevGs; if(!gs) return;
  const hand=gs.splitActive?.[sid]?gs.hands?.[sid]?.['hand'+(handIdx+1)]||[]:gs.hands?.[sid]||[];
  const canDouble=hand.length===2&&myWallet>=(gs.bets?.[sid]?.main||0)&&!gs.doubled?.[sid];
  const canSplit=hand.length===2&&!gs.splitActive?.[sid]&&cardNum(hand[0])===cardNum(hand[1])&&myWallet>=Math.floor((gs.bets?.[sid]?.main||0)/2);
  $('btn-double').classList.toggle('hidden',!canDouble);
  $('btn-split').classList.toggle('hidden',!canSplit);
  show('play-buttons'); actionPending=false;
}
function doAction(action){
  if(!activeTurnSid||actionPending) return;
  actionPending=true; hide('play-buttons'); sfxClick();
  setTimeout(()=>socket.emit('action',{action,sid:activeTurnSid}),150);
}
$('btn-hit').addEventListener('click',   ()=>doAction('hit'));
$('btn-stand').addEventListener('click', ()=>doAction('stand'));
$('btn-double').addEventListener('click',()=>doAction('double'));
$('btn-split').addEventListener('click', ()=>doAction('split'));

// ── Chip Tray ──────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip=>{
  chip.addEventListener('click',()=>{
    document.querySelectorAll('.chip').forEach(c=>c.classList.remove('selected'));
    chip.classList.add('selected'); selectedChip=parseInt(chip.dataset.value); sfxChip();
  });
});
document.querySelector('.chip[data-value="100"]')?.classList.add('selected');
$('btn-deal').addEventListener('click',  ()=>{ sfxDeal(); socket.emit('deal'); });
$('btn-clear').addEventListener('click', ()=>{ sfxClick(); socket.emit('clearBets'); });
$('btn-undo').addEventListener('click',  ()=>{ sfxClick(); socket.emit('undoBet'); });
$('btn-rebet').addEventListener('click', ()=>{ sfxClick(); socket.emit('rebet'); });
$('btn-2x').addEventListener('click',    ()=>{ sfxClick(); socket.emit('doubleBets'); });

document.querySelectorAll('.leave-seat-btn').forEach(btn=>{
  btn.addEventListener('click',e=>{
    const sid=btn.closest('.seat')?.dataset.seat;
    if(sid){sfxClick();socket.emit('leaveSeat',{sid});}
    e.stopPropagation();
  });
});

// ── Insurance ──────────────────────────────────────────────────
function showInsuranceModal(){
  if(!prevGs) return;
  const gs=prevGs, sc=$('insurance-seats'); sc.innerHTML='';
  const mySeats=Object.entries(gs.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
  if(!mySeats.length) return;
  const choices={};
  mySeats.forEach(sid=>{
    choices[sid]=false;
    const cost=Math.floor(gs.bets[sid].main/2), canAfford=myWallet>=cost;
    const row=document.createElement('div'); row.className='ins-row';
    row.innerHTML=`<span class="ins-seat-label">Seat ${sid} — Cost: €${cost}</span>
      <button class="ins-yes${canAfford?'':' ins-disabled'}" ${canAfford?'':'disabled'}>✓ Insure</button>
      <button class="ins-no">✕ Decline</button>`;
    row.querySelector('.ins-yes').addEventListener('click',function(){choices[sid]=true;this.classList.add('selected');row.querySelector('.ins-no').classList.remove('selected');});
    row.querySelector('.ins-no').addEventListener('click',function(){choices[sid]=false;this.classList.add('selected');row.querySelector('.ins-yes').classList.remove('selected');});
    sc.appendChild(row);
  });
  $('insurance-confirm').onclick=()=>{ socket.emit('insuranceResponse',{choices}); hide('insurance-modal'); };
  show('insurance-modal');
}

// ── Win Overlay ────────────────────────────────────────────────
function showWinOverlay(amount){
  if(winOverlayShown) return; winOverlayShown=true; sfxWin();
  document.querySelectorAll('.round-result-overlay').forEach(e=>e.remove());
  const ov=document.createElement('div'); ov.className='round-result-overlay';
  ov.innerHTML=`<div class="rr-label">You Win!</div><div class="rr-amount">€${amount.toLocaleString()}</div>`;
  $('game-container').appendChild(ov);
  setTimeout(()=>ov.classList.add('rr-fadeout'),1800);
  setTimeout(()=>{ov.remove();winOverlayShown=false;},2600);
}
socket.on('stateUpdate',({gs})=>{
  if(gs.gameStatus==='betting'){
    winOverlayShown=false; activeTurnSid=null; actionPending=false;
    hide('play-buttons');
    const db=$('btn-deal'); if(db){db.disabled=false;db.style.opacity='1';db.textContent='DEAL';}
    document.querySelectorAll('.card,.card-back').forEach(c=>c.classList.add('fly-out'));
  }
});

// ── Info Panel ─────────────────────────────────────────────────
const infoPanel=$('table-info-panel');
if(infoPanel){
  infoPanel.addEventListener('mouseenter',()=>$('table-payout-menu')?.classList.add('visible'));
  infoPanel.addEventListener('mouseleave',()=>$('table-payout-menu')?.classList.remove('visible'));
}

// ── Settings ───────────────────────────────────────────────────
$('btn-gear')?.addEventListener('click',()=>{
  const mod=$('settings-modal');
  if(mod){
    mod.classList.toggle('hidden');
    // Pre-fill name
    const inp=$('settings-name-input'); if(inp) inp.value=myName;
  }
  sfxClick();
});
$('settings-close')?.addEventListener('click',()=>{ $('settings-modal')?.classList.add('hidden'); sfxClick(); });

// ── History Panel ──────────────────────────────────────────────
$('btn-history')?.addEventListener('click',()=>{
  sfxClick(); openHistoryPanel();
});

function openHistoryPanel(){
  let panel=$('history-panel');
  if(!panel){
    panel=document.createElement('div'); panel.id='history-panel';
    panel.innerHTML=`
      <div class="history-header">
        <span class="history-title">HISTORY</span>
        <button class="history-close" id="history-close">✕</button>
      </div>
      <div id="history-body"></div>`;
    document.body.appendChild(panel);
    $('history-close').addEventListener('click',()=>panel.remove());
  }
  renderHistoryList(panel.querySelector('#history-body'));
  panel.classList.remove('hidden');
}

function renderHistoryList(container){
  const history=loadHistory();
  if(!history.length){
    container.innerHTML='<div class="history-empty">No rounds played yet.</div>'; return;
  }
  // Group by date (YYYY-MM-DD)
  const byDay={};
  history.forEach(r=>{
    const d=r.time.slice(0,10);
    if(!byDay[d]) byDay[d]=[];
    byDay[d].push(r);
  });
  const days=Object.keys(byDay).sort((a,b)=>b.localeCompare(a));
  container.innerHTML=days.map(day=>{
    const dayRounds=byDay[day];
    const net=dayRounds.reduce((s,r)=>s+r.netCash,0);
    const dateStr=new Date(day+'T12:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    const netClass=net>=0?'hist-pos':'hist-neg';
    return `<div class="hist-day-row" data-day="${day}">
      <span class="hist-arrow">›</span>
      <span class="hist-date">${dateStr}</span>
      <span class="hist-net ${netClass}">${net>=0?'+':''}&euro;${Math.abs(net).toFixed(2)}</span>
    </div>
    <div class="hist-day-rounds hidden" id="day-${day.replace(/-/g,'_')}"></div>`;
  }).join('');

  // Attach click handlers
  container.querySelectorAll('.hist-day-row').forEach(row=>{
    row.addEventListener('click',()=>{
      const day=row.dataset.day;
      const roundsEl=$(`day-${day.replace(/-/g,'_')}`);
      if(!roundsEl) return;
      roundsEl.classList.toggle('hidden');
      if(!roundsEl.classList.contains('hidden')) renderDayRounds(roundsEl,byDay[day]);
    });
  });
}

function renderDayRounds(container,rounds){
  container.innerHTML=rounds.map(r=>{
    const t=new Date(r.time).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    const netClass=r.netCash>=0?'hist-pos':'hist-neg';
    return `<div class="hist-round-row" data-id="${r.id}">
      <div class="hist-round-top">
        <span class="hist-round-table">${r.tableName}</span>
        <span class="hist-round-net ${netClass}">${r.netCash>=0?'+':''}&euro;${Math.abs(r.netCash).toFixed(2)}</span>
      </div>
      <div class="hist-round-sub">${t} &nbsp;·&nbsp; Room ${r.roomCode} &nbsp;·&nbsp; Bet €${r.totalBet}</div>
    </div>`;
  }).join('');
  container.querySelectorAll('.hist-round-row').forEach(row=>{
    row.addEventListener('click',()=>{
      const id=parseInt(row.dataset.id);
      const entry=loadHistory().find(r=>r.id===id);
      if(entry) openRoundDetail(entry);
    });
  });
}

function openRoundDetail(entry){
  let detail=$('history-detail');
  if(detail) detail.remove();
  detail=document.createElement('div'); detail.id='history-detail';
  const t=new Date(entry.time).toLocaleString('en-GB',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const netClass=entry.netCash>=0?'hist-pos':'hist-neg';

  // Dealer hand
  const dealerStr=(entry.dealerCards||[]).map(c=>`<span class="hd-card ${suitIsRed(c.suit)?'red':''}">${cardStr(c)}</span>`).join('');
  const dealerScore=score(entry.dealerCards||[]);

  // Seats (already ordered right-to-left)
  const seatsHtml=entry.seats.map(s=>{
    const seatNum=parseInt(s.sid);
    // Visual seat order: seat 5 = 1st column displayed
    const handsHtml=s.hands.map((h,hi)=>{
      const cardsHtml=h.cards.map(c=>`<span class="hd-card ${suitIsRed(c.suit)?'red':''}">${cardStr(c)}</span>`).join('');
      const resClass=h.result.toLowerCase().includes('win')||h.result==='Blackjack!'?'res-win':h.result.toLowerCase().includes('push')?'res-push':'res-lose';
      return `<div class="hd-hand">
        <div class="hd-cards">${cardsHtml} <span class="hd-score">${h.score}</span></div>
        <div class="hd-result ${resClass}">${h.result||'—'}</div>
      </div>`;
    }).join('');

    const ppLine=s.ppBet>0?`<div class="hd-bet-line"><span>PP</span><span>€${s.ppBet}</span><span class="${s.ppNet>=0?'hist-pos':'hist-neg'}">${s.ppNet>=0?'+':''}€${Math.abs(s.ppNet)}</span></div>`:'';
    const spLine=s.spBet>0?`<div class="hd-bet-line"><span>21+3</span><span>€${s.spBet}</span><span class="${s.spNet>=0?'hist-pos':'hist-neg'}">${s.spNet>=0?'+':''}€${Math.abs(s.spNet)}</span></div>`:'';

    return `<div class="hd-seat">
      <div class="hd-seat-label">Seat ${seatNum}</div>
      ${handsHtml}
      <div class="hd-bets-table">
        <div class="hd-bet-line hd-bet-header"><span>Bet Type</span><span>Bet</span><span>Net</span></div>
        <div class="hd-bet-line"><span>Main Bet</span><span>€${s.mainBet}</span><span class="${s.mainNet>=0?'hist-pos':'hist-neg'}">${s.mainNet>=0?'+':''}€${Math.abs(s.mainNet)}</span></div>
        ${ppLine}${spLine}
      </div>
    </div>`;
  }).join('');

  detail.innerHTML=`
    <div class="hist-detail-card">
      <div class="hist-detail-header">
        <button class="hist-detail-back" id="hist-detail-back">‹</button>
        <span class="hist-detail-title">${entry.tableName}</span>
      </div>
      <div class="hist-detail-meta">
        <div>${t} &nbsp;·&nbsp; Room <b>${entry.roomCode}</b></div>
        <div>Total Bet: <b>€${entry.totalBet}</b> &nbsp; Net Cash: <b class="${netClass}">${entry.netCash>=0?'+':''}€${Math.abs(entry.netCash).toFixed(2)}</b></div>
      </div>
      <div class="hd-dealer-row">
        <span class="hd-section-label">Dealer's hand</span>
        <div class="hd-cards">${dealerStr} <span class="hd-score">${dealerScore}</span></div>
      </div>
      <div class="hd-seats">${seatsHtml}</div>
    </div>`;
  document.body.appendChild(detail);
  $('hist-detail-back').addEventListener('click',()=>detail.remove());
}
