// =============================================================
// BLACKJACK MULTIPLAYER — client.js  v7 (clean)
// =============================================================
const socket = io();

// ── Globals ────────────────────────────────────────────────────
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
let currentRoundLog = null;
let countdownTimer  = null;
let autoplayOn      = false;
let autoplayThreshold = 17;
const _prevScores   = {};   // score-pill-id → last displayed value

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
function getACtx(){ if(!actx) actx = new AudioCtx(); return actx; }
function playTone(f,d,t='sine',v=sfxVolume){
  if(!v) return;
  try{
    const ctx=getACtx(), o=ctx.createOscillator(), g=ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type=t; o.frequency.value=f;
    g.gain.setValueAtTime(v*0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+d);
    o.start(); o.stop(ctx.currentTime+d);
  } catch(e){}
}
function sfxChip()  { playTone(900,0.06,'square',sfxVolume*0.5); }
function sfxCard()  {
  try {
    const ctx=getACtx(), buf=ctx.createBuffer(1,ctx.sampleRate*0.08,ctx.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.3));
    const s=ctx.createBufferSource(), f=ctx.createBiquadFilter(), g=ctx.createGain();
    f.type='bandpass'; f.frequency.value=3800; f.Q.value=0.8;
    s.buffer=buf; s.connect(f); f.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(sfxVolume*0.6, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+0.08);
    s.start();
  } catch(e){ playTone(300,0.08,'triangle'); }
}
function sfxWin()   { [600,800,1000].forEach((f,i)=>setTimeout(()=>playTone(f,0.18,'sine'),i*80)); }
function sfxBust()  { [200,160,120].forEach((f,i)=>setTimeout(()=>playTone(f,0.15,'sawtooth'),i*60)); }
function sfxDeal()  { playTone(440,0.1,'triangle'); }
function sfxClick() { playTone(600,0.04,'square',sfxVolume*0.4); }

// ── Utils ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id)?.classList.remove('hidden');
const hide = id => $(id)?.classList.add('hidden');
function fmt(n){ return n>=1000 ? '€'+(n/1000).toFixed(n%1000===0?0:1)+'k' : '€'+n; }
function score(h){
  if(!Array.isArray(h)||!h.length) return 0;
  let t=0, a=0;
  for(const c of h){
    if(['J','Q','K'].includes(c.value)) t+=10;
    else if(c.value==='A'){ a++; t+=11; }
    else t+=parseInt(c.value)||0;
  }
  while(t>21&&a>0){ t-=10; a--; }
  return t;
}
function scoreLabel(h, stood){
  if(!Array.isArray(h)||!h.length) return '';
  let t=0, a=0;
  for(const c of h){
    if(['J','Q','K'].includes(c.value)) t+=10;
    else if(c.value==='A'){ a++; t+=11; }
    else t+=parseInt(c.value)||0;
  }
  while(t>21&&a>0){ t-=10; a--; }
  if(a>0 && t!==21 && !stood) return `${t-10}/${t}`;
  return String(t);
}
function cardNum(c){
  if(['J','Q','K'].includes(c.value)) return 10;
  if(c.value==='A') return 11;
  return parseInt(c.value);
}
function cardStr(c){ return c.value + ({S:'♠',H:'♥',D:'♦',C:'♣'}[c.suit]||''); }
function suitIsRed(s){ return s==='H'||s==='D'; }
function loadName(){ try{ return JSON.parse(localStorage.getItem('kk_name')||'null')||''; }catch(e){ return ''; } }
function saveName(n){ try{ localStorage.setItem('kk_name',JSON.stringify(n)); }catch(e){} }
function loadHistory(){ try{ return JSON.parse(localStorage.getItem('kk_history')||'[]'); }catch(e){ return []; } }
function saveHistory(h){ try{ localStorage.setItem('kk_history',JSON.stringify(h)); }catch(e){} }
function pushRound(e){ const h=loadHistory(); h.unshift(e); if(h.length>500) h.length=500; saveHistory(h); }

// Pre-fill saved name
(function(){ const s=loadName(); if(s){ const i=$('lobby-name'); if(i) i.value=s; } })();

// ── Lobby ──────────────────────────────────────────────────────
$('btn-create-room').addEventListener('click', ()=>{
  const name=$('lobby-name').value.trim();
  if(!name){ showLobbyError('Enter your name first'); return; }
  myName=name; saveName(name);
  socket.emit('createRoom', {name, wallet:5000});
});
$('btn-join-room').addEventListener('click', ()=>{
  const name=$('lobby-name').value.trim();
  const code=$('lobby-code-input').value.trim().toUpperCase();
  if(!name){ showLobbyError('Enter your name first'); return; }
  if(code.length!==4){ showLobbyError('Enter a 4-digit room code'); return; }
  myName=name; saveName(name);
  socket.emit('joinRoom', {code, name, wallet:5000});
});
$('lobby-code-input').addEventListener('keydown', e=>{ if(e.key==='Enter') $('btn-join-room').click(); });
$('lobby-name').addEventListener('keydown',      e=>{ if(e.key==='Enter') $('btn-create-room').click(); });
$('btn-start-game').addEventListener('click', ()=>{ sfxClick(); socket.emit('startGame'); });
$('btn-leave-room').addEventListener('click', ()=> showLeaveConfirm());

function showLobbyError(msg){
  const el=$('lobby-error'); el.textContent=msg; el.classList.remove('hidden');
  setTimeout(()=>el.classList.add('hidden'), 3000);
}
function showLeaveConfirm(){
  if($('leave-confirm-modal')) return;
  const m=document.createElement('div'); m.id='leave-confirm-modal';
  m.innerHTML=`<div class="leave-confirm-card">
    <div class="leave-confirm-title">Leave Room?</div>
    <div class="leave-confirm-sub">You'll lose your seat and bets.</div>
    <div class="leave-confirm-btns">
      <button id="leave-yes" class="leave-btn-yes">Leave</button>
      <button id="leave-no"  class="leave-btn-no">Stay</button>
    </div></div>`;
  document.body.appendChild(m);
  $('leave-yes').addEventListener('click', ()=>{ socket.disconnect(); location.reload(); });
  $('leave-no').addEventListener('click',  ()=> m.remove());
}
function launchGame(){
  hide('waiting-screen'); hide('lobby-screen');
  show('game-container');
  // Show chip tray (faded in)
  const ct=$('chip-tray'); if(ct){ ct.classList.remove('hidden'); ct.classList.remove('tray-hidden'); }
  const ca=$('chip-action-floats'); if(ca) ca.classList.remove('hidden');
}

// ── Socket core events ─────────────────────────────────────────
socket.on('roomJoined', ({code, socketId, isHost})=>{
  mySocketId=socketId; roomCode=code;
  hide('lobby-screen'); show('waiting-screen');
  $('waiting-code').textContent    = code;
  $('room-badge-code').textContent = code;
  updateWaitingHostUI(isHost);
});
socket.on('roomError',   msg => showLobbyError(msg));
socket.on('gameLaunched',()  => launchGame());
socket.on('autoLaunch',  ()  => launchGame());
socket.on('kicked', ()=>{
  document.querySelectorAll('.kick-modal').forEach(e=>e.remove());
  const m=document.createElement('div'); m.className='kick-modal';
  m.innerHTML=`<div class="kick-card"><div class="kick-title">You were kicked</div><button onclick="location.reload()" class="kick-btn">Back to Lobby</button></div>`;
  document.body.appendChild(m);
});
socket.on('hostChanged', ({hostId})=>{
  updateWaitingHostUI(hostId===mySocketId);
  if(hostId===mySocketId){
    const t=document.createElement('div'); t.className='host-toast';
    t.textContent='👑 You are now the host';
    document.body.appendChild(t); setTimeout(()=>t.remove(), 3000);
  }
});
function updateWaitingHostUI(isHost){
  const b=$('btn-start-game'); if(b) b.style.display=isHost?'':'none';
}

// ── State update ───────────────────────────────────────────────
socket.on('stateUpdate', ({gs, players, hostId})=>{
  // Waiting room list
  const wl=$('waiting-players');
  if(wl) wl.innerHTML=Object.entries(players).map(([id,p])=>
    `<div class="waiting-player">${id===hostId?'<span class="lobby-crown">👑</span>':''}${p.name}</div>`
  ).join('');
  const sb=$('btn-start-game');
  if(sb) sb.style.display=(mySocketId===hostId)?'':'none';

  trackRound(gs, players);
  renderState(gs, players, hostId);
  prevGs = JSON.parse(JSON.stringify(gs));
});

socket.on('timerTick', secs=>{
  const el=$('bet-timer-text'), bar=$('bet-timer-bar');
  if(el)  el.textContent = secs;
  if(bar) bar.style.width = (secs/15*100)+'%';
  show('bet-timer-wrap');
  if(secs<=5 && secs>0) playTone(880,0.05,'square',sfxVolume*0.3);
});
socket.on('timerCancel', ()=> hide('bet-timer-wrap'));

socket.on('yourTurn', ({sid, handIdx, ownerId})=>{
  activeTurnSid     = sid;
  activeTurnHandIdx = handIdx||0;
  actionPending     = false;
  stopCountdownRing();
  if(ownerId===mySocketId){
    showPlayButtons(sid, handIdx||0);
    // Start countdown ring after buttons are shown
    setTimeout(()=>{
      const pb=$('play-buttons');
      if(pb && !pb.classList.contains('betting-hidden') && !pb.classList.contains('hidden'))
        startCountdownRing(pb, 15, ()=> autoPlayAction(sid, handIdx||0));
    }, 150);
  } else {
    hide('play-buttons');
  }
});

socket.on('dealVote', ({ready, needed, readyIds})=>{
  const b=$('btn-deal'); if(!b) return;
  if(readyIds.includes(mySocketId)){
    b.textContent=`Waiting… (${ready}/${needed})`; b.disabled=true; b.style.opacity='0.6';
  } else {
    b.textContent=`Deal (${ready}/${needed} ready)`; b.disabled=false; b.style.opacity='1';
  }
});
socket.on('insuranceOffer', ()=> showInsuranceModal());

// Reset on new betting round
socket.on('stateUpdate', ({gs})=>{
  if(gs.gameStatus==='betting'){
    winOverlayShown=false; activeTurnSid=null; actionPending=false;
    stopCountdownRing();
    hide('play-buttons');
    const db=$('btn-deal'); if(db){ db.disabled=false; db.style.opacity='1'; db.textContent='DEAL'; }
    document.querySelectorAll('.card,.card-back').forEach(c=>c.classList.add('fly-out'));
    document.querySelectorAll('.circle-win-label,.win-chips-overlay').forEach(e=>e.remove());
    Object.keys(_prevScores).forEach(k=>delete _prevScores[k]);
  }
});

// ── Countdown Ring ─────────────────────────────────────────────
function startCountdownRing(targetEl, totalSecs, onTimeout){
  stopCountdownRing();
  if(!targetEl) return;
  const rect=targetEl.getBoundingClientRect();
  const cx=rect.left+rect.width/2, cy=rect.top+rect.height/2;
  const R=Math.max(rect.width, rect.height)/2+28;
  const circ=2*Math.PI*R;
  const wrap=document.createElement('div');
  wrap.id='countdown-ring'; wrap.className='countdown-ring-wrap';
  const sz=(R+10)*2;
  wrap.style.cssText=`position:fixed;left:${cx-R-10}px;top:${cy-R-10}px;width:${sz}px;height:${sz}px;pointer-events:none;z-index:201;`;
  wrap.innerHTML=`<svg width="${sz}" height="${sz}">
    <circle cx="${R+10}" cy="${R+10}" r="${R}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="3.5"/>
    <circle id="cd-arc" cx="${R+10}" cy="${R+10}" r="${R}" fill="none" stroke="#fff" stroke-width="3.5"
      stroke-dasharray="${circ}" stroke-dashoffset="0" stroke-linecap="round"
      transform="rotate(-90 ${R+10} ${R+10})"/>
  </svg>`;
  document.body.appendChild(wrap);
  let left=totalSecs;
  countdownTimer=setInterval(()=>{
    left--;
    const arc=document.getElementById('cd-arc'); if(!arc){ stopCountdownRing(); return; }
    const p=1-left/totalSecs;
    arc.style.strokeDashoffset=String(circ*p);
    const r=Math.min(255,Math.round(255*p*2));
    const g=Math.max(0,Math.round(255*(1-p*1.6)));
    arc.style.stroke=`rgb(${r},${g},40)`;
    if(left<=0){ stopCountdownRing(); if(onTimeout) onTimeout(); }
  }, 1000);
}
function stopCountdownRing(){
  if(countdownTimer){ clearInterval(countdownTimer); countdownTimer=null; }
  document.getElementById('countdown-ring')?.remove();
}
function autoPlayAction(sid, handIdx){
  if(!activeTurnSid||actionPending) return;
  if(autoplayOn){
    const gs=prevGs;
    const hand=gs?.splitActive?.[sid] ? gs?.hands?.[sid]?.['hand'+(handIdx+1)]||[] : gs?.hands?.[sid]||[];
    doAction(score(hand)<autoplayThreshold ? 'hit' : 'stand');
  } else {
    doAction('stand');
  }
}

// ── Auto-play setting ──────────────────────────────────────────
const autoToggle=$('autoplay-toggle'), threshWrap=$('autoplay-threshold-wrap');
if(autoToggle){
  autoToggle.addEventListener('click', ()=>{
    autoplayOn=!autoplayOn;
    autoToggle.classList.toggle('on', autoplayOn);
    if(threshWrap) threshWrap.style.display=autoplayOn?'flex':'none';
    sfxClick();
  });
}
$('autoplay-threshold')?.addEventListener('change', ()=>{
  autoplayThreshold=parseInt($('autoplay-threshold').value)||17;
});

// ── Settings ───────────────────────────────────────────────────
const volSlider=$('sfx-volume'), volLabel=$('sfx-volume-val');
if(volSlider){
  volSlider.addEventListener('input', ()=>{
    sfxVolume=parseFloat(volSlider.value);
    if(volLabel) volLabel.textContent=Math.round(sfxVolume*100)+'%';
    sfxClick();
  });
}
$('btn-save-name')?.addEventListener('click', ()=>{
  const inp=$('settings-name-input'), newName=inp?.value.trim();
  if(!newName) return;
  myName=newName; saveName(newName);
  socket.emit('changeName', {name:newName});
  sfxClick();
  const msg=$('settings-name-msg');
  if(msg){ msg.textContent='✓ Saved'; msg.style.color='#ffd700'; setTimeout(()=>msg.textContent='',2000); }
});
$('btn-gear')?.addEventListener('click', ()=>{
  const m=$('settings-modal');
  if(m){ m.classList.toggle('hidden'); const i=$('settings-name-input'); if(i) i.value=myName; }
  sfxClick();
});
$('settings-close')?.addEventListener('click', ()=>{ $('settings-modal')?.classList.add('hidden'); sfxClick(); });

// ── History tracking ───────────────────────────────────────────
function trackRound(gs, players){
  if(gs.gameStatus==='dealing' && !currentRoundLog)
    currentRoundLog={time:new Date().toISOString(), roomCode, saved:false};
  if(gs.gameStatus==='game_over' && currentRoundLog && !currentRoundLog.saved){
    currentRoundLog.saved=true;
    buildAndSaveHistory(gs, players);
    currentRoundLog=null;
  }
  if(gs.gameStatus==='betting' && currentRoundLog) currentRoundLog=null;
}
function buildAndSaveHistory(gs, players){
  const mySeats=Object.entries(gs.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
  if(!mySeats.length) return;
  const ordered=[...mySeats].sort((a,b)=>Number(b)-Number(a));
  let totalBet=0, netCash=0;
  const seats=ordered.map(sid=>{
    const main=gs.bets?.[sid]?.main||0, pp=gs.bets?.[sid]?.pp||0, sp=gs.bets?.[sid]?.sp||0;
    totalBet+=main+pp+sp;
    const badges=gs.badges?.[sid]||[];
    const hasBJ=badges.some(b=>b.cls==='bj'), hasWin=badges.some(b=>b.cls==='win'), hasPush=badges.some(b=>b.cls==='push');
    let mr=hasBJ?Math.floor(main*2.5):hasWin?main*2:hasPush?main:0;
    const mainNet=mr-main;
    const ppWin=gs.sideBetWins?.[sid]?.pp?.payout||0, spWin=gs.sideBetWins?.[sid]?.sp?.payout||0;
    netCash+=mainNet+(ppWin-pp)+(spWin-sp);
    let hands=[];
    if(gs.splitActive?.[sid]){
      ['hand1','hand2'].forEach((hk,i)=>{
        const cards=gs.hands?.[sid]?.[hk]||[];
        hands.push({cards, result:badges[i]?.text||'', score:score(cards)});
      });
    } else {
      const cards=Array.isArray(gs.hands?.[sid])?gs.hands[sid]:[];
      hands.push({cards, result:badges[0]?.text||'', score:score(cards)});
    }
    return{sid, mainBet:main, ppBet:pp, spBet:sp, mainNet, ppNet:ppWin-pp, spNet:spWin-sp, ppWin, spWin, hands};
  });
  pushRound({id:Date.now(), time:new Date().toISOString(), roomCode, tableName:'Kikikov BlackJack', totalBet, netCash, seats, dealerCards:gs.hands?.dealer||[]});
}

// ── Render State ───────────────────────────────────────────────
function renderState(gs, players, hostId){
  const pList=$('players-list');
  if(pList) pList.innerHTML=Object.entries(players).map(([id,p])=>`
    <div class="player-entry ${id===mySocketId?'me':''}">
      <span class="pe-name">${id===hostId?'👑 ':''}${p.name}</span>
      <span class="pe-wallet">€${p.wallet.toLocaleString()}</span>
    </div>`).join('');

  const me=players[mySocketId];
  if(me){
    myWallet=me.wallet;
    $('wallet-amount').textContent ='€'+me.wallet.toLocaleString();
    $('hud-bet-amount').textContent='€'+(me.totalBet||0).toLocaleString();
  }

  const status=gs.gameStatus;
  const mySeats=Object.entries(gs.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
  const bLocked=gs.betsLocked;
  const isBetting=['betting','idle'].includes(status);
  const myHasBets=mySeats.some(s=>gs.bets[s]?.main>0);
  const canDeal=isBetting && gs.activeSeats.length>0 && mySeats.length>0 && myHasBets;
  const myReady=Array.isArray(gs.readyPlayers)&&gs.readyPlayers.includes(mySocketId);

  // Deal button
  if(canDeal) show('deal-btn-wrap'); else hide('deal-btn-wrap');
  const db=$('btn-deal');
  if(db&&!myReady){ db.disabled=false; db.style.opacity='1'; if(!bLocked) db.textContent='DEAL'; }

  // Chip tray fade
  const ct=$('chip-tray');
  if(ct){ ct.classList.remove('hidden'); if(isBetting) ct.classList.remove('tray-hidden'); else ct.classList.add('tray-hidden'); }

  // Floating action row (undo/rebet/2x) — separate from tray
  const ca=$('chip-action-floats');
  if(ca){ if(isBetting) ca.classList.remove('hidden'); else ca.classList.add('hidden'); }

  if(bLocked){
    hide('btn-undo'); hide('btn-clear'); hide('btn-rebet'); hide('btn-2x');
  } else {
    if(isBetting) show('btn-undo'); else hide('btn-undo');
    if(myHasBets&&isBetting) show('btn-clear'); else hide('btn-clear');
    const hasLast=!!(gs.lastRoundBets?.[mySocketId]?.length);
    if(hasLast&&isBetting&&!myHasBets) show('btn-rebet'); else hide('btn-rebet');
    if(myHasBets&&isBetting) show('btn-2x'); else hide('btn-2x');
  }

  // Play buttons: hide during betting
  const pb=$('play-buttons');
  if(pb){ if(isBetting) pb.classList.add('betting-hidden'); else pb.classList.remove('betting-hidden'); }

  for(let i=1;i<=5;i++) renderSeat(String(i), gs, players);
  renderDealer(gs);

  if(gs.gameStatus==='game_over' && gs.grandTotal>0){
    const w=calcMyWinnings(gs); if(w>0) showWinOverlay(w);
  }
  updateStatusMsg(gs, players);
  renderAdminPanel(gs, players, hostId);
}

function calcMyWinnings(gs){
  let t=0;
  for(const [sid,oid] of Object.entries(gs.seatOwners||{})){
    if(oid!==mySocketId) continue;
    const b=gs.badges?.[sid]||[];
    const hasBJ=b.some(x=>x.cls==='bj'), hasWin=b.some(x=>x.cls==='win'), hasPush=b.some(x=>x.cls==='push');
    if(hasBJ)        t+=Math.floor(gs.bets[sid].main*2.5);
    else if(hasWin)  t+=gs.bets[sid].main*2;
    else if(hasPush) t+=gs.bets[sid].main;
    if(gs.sideBetWins?.[sid]?.pp) t+=gs.sideBetWins[sid].pp.payout;
    if(gs.sideBetWins?.[sid]?.sp) t+=gs.sideBetWins[sid].sp.payout;
  }
  return t;
}

function updateStatusMsg(gs, players){
  const el=$('status-message'); if(!el) return;
  const st=gs.gameStatus;
  if(st==='betting'||st==='idle'){
    if(gs.betsLocked&&gs.readyPlayers?.length){
      const n=new Set(gs.activeSeats.map(s=>gs.seatOwners?.[s]).filter(Boolean)).size;
      el.textContent=`Waiting for all to deal… (${gs.readyPlayers.length}/${n})`;
    } else {
      el.textContent=Object.keys(gs.seatOwners||{}).length===0?'Click a seat to join!':'Place your bets';
    }
  } else if(st==='dealing')      el.textContent='Dealing…';
  else if(st==='playing' && activeTurnSid){
    const oid=gs.seatOwners?.[activeTurnSid], pn=oid?players[oid]?.name:'?';
    el.textContent=(oid===mySocketId)?`Your turn — Seat ${activeTurnSid}`:`${pn}'s turn`;
  } else if(st==='dealer_turn')  el.textContent='Dealer\u2019s turn\u2026';
  else if(st==='game_over')      el.textContent='Round over — next round soon\u2026';
}

// ── Admin Panel ────────────────────────────────────────────────
function renderAdminPanel(gs, players, hostId){
  const isHost=mySocketId===hostId;
  const canShow=isHost&&['betting','idle'].includes(gs.gameStatus);

  // Find or create inside settings card
  let panel=$('admin-panel');
  if(!canShow){ if(panel) panel.remove(); return; }
  if(!panel){
    panel=document.createElement('div'); panel.id='admin-panel';
    const sc=$('settings-card');
    if(sc){
      const hr=document.createElement('hr');
      hr.style.cssText='border:none;border-top:1px solid rgba(255,255,255,0.1);margin:14px 0;';
      sc.insertBefore(hr, $('settings-close'));
      sc.insertBefore(panel, $('settings-close'));
    } else {
      $('game-container')?.appendChild(panel);
    }
  }
  const others=Object.entries(players).filter(([id])=>id!==mySocketId);
  if(!others.length){ panel.innerHTML='<div class="admin-title" style="opacity:.4">No other players</div>'; return; }
  panel.innerHTML=`<div class="admin-title">👑 Kick Players</div>`+
    others.map(([id,p])=>`<div class="admin-row"><span class="admin-name">${p.name}</span><button class="admin-kick-btn" data-id="${id}">Kick</button></div>`).join('');
  panel.querySelectorAll('.admin-kick-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{ sfxClick(); socket.emit('kickPlayer',{targetId:btn.dataset.id}); });
  });
}

// ── Seat Rendering ─────────────────────────────────────────────
function renderSeat(sid, gs, players){
  const seatEl=$('seat-'+sid); if(!seatEl) return;
  const ownerId=gs.seatOwners?.[sid], isMine=ownerId===mySocketId;
  const ownerName=ownerId?players[ownerId]?.name:null;
  const isBetting=['betting','idle'].includes(gs.gameStatus);
  const mc=seatEl.querySelector('.bet-circle.main-bet');
  if(ownerId){ seatEl.classList.add('my-seat'); mc?.classList.add('claimed'); }
  else       { seatEl.classList.remove('my-seat'); mc?.classList.remove('claimed'); }
  const lb=seatEl.querySelector('.leave-seat-btn');
  if(lb){ if(isMine&&isBetting) lb.classList.remove('hidden'); else lb.classList.add('hidden'); }
  const nt=seatEl.querySelector('.seat-name-tag');
  if(nt){
    if(ownerName){ nt.textContent=ownerName; nt.classList.remove('hidden');
      nt.style.background=isMine?'rgba(255,215,0,0.18)':'rgba(255,255,255,0.1)';
      nt.style.color=isMine?'#ffd700':'#fff';
    } else nt.classList.add('hidden');
  }
  for(const t of ['main','pp','sp']) renderCircle(sid, t, gs, isMine&&isBetting);
  renderHand(sid, gs);
  renderScore(sid, gs);
  renderBadges(sid, gs);
  renderBust(sid, gs);
  seatEl.classList.toggle('active-turn', activeTurnSid===sid);
}

// ── Betting Circles ────────────────────────────────────────────
function renderCircle(sid, type, gs, canBet){
  const circle=document.querySelector(`.bet-circle[data-seat="${sid}"][data-type="${type}"]`);
  if(!circle) return;
  const amt=gs.bets?.[sid]?.[type]||0;
  circle.onclick=null;
  const ba=['betting','idle'].includes(gs.gameStatus)&&!gs.betsLocked;
  if(ba){
    if(type==='main'){
      const oid=gs.seatOwners?.[sid];
      if(!oid)              circle.onclick=()=>{ sfxClick(); socket.emit('claimSeat',{sid}); };
      else if(oid===mySocketId) circle.onclick=()=>{ sfxChip(); socket.emit('placeBet',{sid,type:'main',amt:selectedChip}); };
    } else if(gs.seatOwners?.[sid]===mySocketId){
      circle.onclick=()=>{ sfxChip(); socket.emit('placeBet',{sid,type,amt:selectedChip}); };
    } else if(!gs.seatOwners?.[sid]){
      circle.onclick=()=>{ sfxClick(); socket.emit('claimSeat',{sid}); };
    }
  }
  circle.querySelectorAll('.chip-stack,.sidebet-win-pill').forEach(e=>e.remove());
  const wk=type==='pp'?'pp':'sp', wd=gs.sideBetWins?.[sid]?.[wk];
  if(wd&&type!=='main'){ renderSideBetWinPill(circle,wd); return; }
  if(amt>0) renderChipStack(circle, amt, type==='main');
  circle.classList.toggle('has-bet', amt>0);
}

function renderSideBetWinPill(circle, wd){
  renderChipStack(circle, wd.payout, false, true);
  const pill=document.createElement('div'); pill.className='sidebet-win-pill';
  pill.textContent=`${wd.mult}:1`;
  circle.appendChild(pill); circle.classList.add('has-bet');
}

function renderChipStack(circle, amt, isMain, isGold=false){
  const denom=[10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];
  const chips=[]; let rem=amt;
  for(const d of denom){ while(rem>=d&&chips.length<8){ chips.push(d); rem-=d; } if(chips.length>=8) break; }
  const chipW=isMain?56:36, offsetY=isMain?4:3;
  const stack=document.createElement('div'); stack.className='chip-stack';
  chips.forEach((val,i)=>{
    let c1,c2;
    if(isGold){ c1='#ffe066'; c2='#c8900a'; }
    else{ const cols=CHIP_COLORS[val]||'#888,#444'; [c1,c2]=cols.split(','); }
    const chip=document.createElement('div'); chip.className='stacked-chip';
    chip.style.cssText=`width:${chipW}px;height:${chipW}px;background:radial-gradient(circle at 35% 35%,${c1},${c2});bottom:${4+i*offsetY}px;left:50%;transform:translateX(-50%);`;
    stack.appendChild(chip);
  });
  const topBottom=4+(chips.length-1)*offsetY;
  const lbl=document.createElement('div'); lbl.className='chip-stack-amt';
  if(isGold) lbl.style.color='#ffd700';
  lbl.style.bottom=(topBottom+chipW/2-9)+'px'; lbl.style.top='auto';
  lbl.textContent=fmt(amt);
  stack.appendChild(lbl); circle.appendChild(stack);
}

function ensureSplitBetCircle(seatEl, sid, gs){
  let sc=seatEl.querySelector('.split-bet-circle');
  if(!gs.splitActive?.[sid]){ if(sc) sc.remove(); return; }
  if(!sc){ sc=document.createElement('div'); sc.className='split-bet-circle'; seatEl.querySelector('.betting-circles')?.appendChild(sc); }
  sc.querySelectorAll('.chip-stack').forEach(e=>e.remove());
  const sb=gs.splitBets?.[sid]||gs.bets?.[sid]?.main||0;
  if(sb>0) renderChipStack(sc, sb, true);
}

// ── Hand Rendering ─────────────────────────────────────────────
function renderHand(sid, gs){
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
      col.classList.toggle('active-turn-hand', iHA[idx]);
      const hd=col.querySelector('.split-hand');
      if(hd){ const ex=hd.querySelectorAll('.card').length; h.slice(ex).forEach(c=>{ sfxCard(); hd.appendChild(mkCard(c,true)); }); }
      const pill=col.querySelector('.split-score');
      if(pill){
        const stood=gs.stoodSeats?.includes(sid);
        const sv=scoreLabel(h, stood&&idx===(gs.splitHandIndex?.[sid]||0));
        animateScoreUpdate(pill, sv);
        if(h.length) pill.classList.remove('hidden'); else pill.classList.add('hidden');
        if(score(h)>21){ pill.classList.add('busted'); setTimeout(()=>pill.classList.add('show-icon'),800); }
        else pill.classList.remove('busted','show-icon');
      }
    });
    const seatEl=$('seat-'+sid); if(seatEl) ensureSplitBetCircle(seatEl, sid, gs);
  } else {
    const seatEl=$('seat-'+sid); if(seatEl) ensureSplitBetCircle(seatEl, sid, gs);
    el.classList.remove('split-mode');
    const hand=Array.isArray(gs.hands?.[sid])?gs.hands[sid]:[];
    const ex=el.querySelectorAll(':scope > .card').length;
    if(hand.length<ex){ el.innerHTML=''; hand.forEach(c=>el.appendChild(mkCard(c,false))); }
    else{ hand.slice(ex).forEach(c=>{ sfxCard(); el.appendChild(mkCard(c,true)); }); }
    el.querySelector('.split-hands')?.remove();
  }
}

// ── Score ──────────────────────────────────────────────────────
function animateScoreUpdate(pill, newVal){
  const bustNum=pill.querySelector('.bust-num'); if(!bustNum) return;
  const id=pill.id, old=_prevScores[id];
  if(old===newVal){ bustNum.textContent=newVal; return; }
  const oldNum=parseInt(old)||0, newNum=parseInt(newVal)||0, delta=newNum-oldNum;
  if(old!==undefined && delta!==0 && !pill.classList.contains('busted')){
    pill.classList.add('score-flash');
    bustNum.textContent=delta>0?'+':'−';
    setTimeout(()=>{ bustNum.textContent=newVal; pill.classList.remove('score-flash'); }, 800);
  } else {
    bustNum.textContent=newVal;
  }
  _prevScores[id]=newVal;
}

function renderScore(sid, gs){
  const el=$('score-'+sid); if(!el) return;
  if(gs.splitActive?.[sid]){ el.classList.add('hidden'); return; }
  const hand=Array.isArray(gs.hands?.[sid])?gs.hands[sid]:[];
  if(!hand.length){ el.classList.add('hidden'); return; }
  const stood=gs.stoodSeats?.includes(sid);
  // BJ: show gold BJ
  if(score(hand)===21&&hand.length===2){
    el.innerHTML='<span class="bust-num bj-text">BJ</span><span class="bust-icon">💥</span>';
    el.classList.remove('hidden','busted','show-icon'); _prevScores[el.id]='BJ'; return;
  }
  const newVal=scoreLabel(hand, stood);
  const old=_prevScores[el.id];
  el.innerHTML=`<span class="bust-num"></span><span class="bust-icon">💥</span>`;
  el.classList.remove('hidden');
  animateScoreUpdate(el, newVal);
  if(score(hand)>21){ el.classList.add('busted'); setTimeout(()=>el.classList.add('show-icon'),800); }
  else el.classList.remove('busted','show-icon');
}

function renderBust(sid, gs){
  if(!gs.bustSeats) return;
  if(Object.keys(gs.bustSeats).some(k=>k.startsWith(sid))&&!gs.splitActive?.[sid]){
    const el=$('score-'+sid);
    if(el){ el.classList.add('busted'); setTimeout(()=>el.classList.add('show-icon'),800); }
  }
}

// ── Badges → win chip labels ───────────────────────────────────
function renderBadges(sid, gs){
  const seatEl=$('seat-'+sid); if(!seatEl) return;
  seatEl.querySelectorAll('.result-badge').forEach(b=>b.remove());
  const badges=gs.badges?.[sid]||[], seen=new Set();
  for(const b of badges){
    if(seen.has(b.cls)) continue; seen.add(b.cls);
    if(b.cls==='win'||b.cls==='bj') sfxWin();
    if(b.cls==='lose'&&b.text==='Bust') sfxBust();
  }
  const mc=seatEl.querySelector('.bet-circle.main-bet'); if(!mc) return;
  mc.querySelectorAll('.circle-win-label').forEach(e=>e.remove());
  if(gs.gameStatus==='betting') return;
  if(!badges.length) return;
  const hasBJ=badges.some(b=>b.cls==='bj'), hasWin=badges.some(b=>b.cls==='win'), hasPush=badges.some(b=>b.cls==='push');
  const main=gs.bets?.[sid]?.main||0;
  const lbl=document.createElement('div');
  if(hasBJ){
    lbl.className='circle-win-label bj-label';
    lbl.textContent='+'+fmt(Math.floor(main*2.5));
  } else if(hasWin){
    lbl.className='circle-win-label';
    lbl.textContent='+'+fmt(main*2);
  } else if(hasPush){
    lbl.className='circle-win-label push-label';
    lbl.textContent='+'+fmt(main)+' back';
  } else return;
  mc.appendChild(lbl);
}

// ── Card Factory ───────────────────────────────────────────────
function mkCard(c, animate){
  const div=document.createElement('div');
  div.className='card'+(animate?' card-deal-anim':'');
  if(!animate) div.style.animation='none';
  const code=(c.value==='10'?'0':c.value)+c.suit;
  const url=`https://deckofcardsapi.com/static/img/${code}.png`;
  // Use background-image: shows immediately, no wrong-side flicker
  div.style.backgroundImage=`url(${url})`;
  div.style.backgroundSize='100% 100%';
  div.style.backgroundColor='#fff';
  // Text fallback if image fails
  const probe=new Image();
  probe.onerror=()=>{
    div.style.backgroundImage='none';
    div.style.display='flex'; div.style.alignItems='center'; div.style.justifyContent='center';
    div.style.fontSize='1rem'; div.style.fontWeight='700';
    div.style.color=suitIsRed(c.suit)?'#c00':'#111';
    div.textContent=cardStr(c);
  };
  probe.src=url;
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
    if(hand.length<ex){ el.innerHTML=''; }
    else{
      hand.slice(ex).forEach((c,i)=>{
        if(ex+i===1){ const b=document.createElement('div'); b.className='card-back card-deal-anim'; el.appendChild(b); }
        else el.appendChild(mkCard(c,true));
      });
    }
  } else {
    const ex=el.querySelectorAll('.card,.card-back').length;
    hand.slice(ex).forEach(c=>el.appendChild(mkCard(c,true)));
  }
  const sc=$('dealer-score');
  if(sc&&hand.length>0){
    const dh=gs.dealerRevealed?hand:[hand[0]];
    const ds=score(dh);
    sc.innerHTML=`<span class="bust-num">${ds}</span><span class="bust-icon">💥</span>`;
    sc.classList.remove('hidden');
    if(gs.dealerRevealed&&ds>21){ sc.classList.add('busted'); setTimeout(()=>sc.classList.add('show-icon'),800); }
    else sc.classList.remove('busted','show-icon');
  } else if(sc) sc.classList.add('hidden');
}

// ── Play Buttons ───────────────────────────────────────────────
function showPlayButtons(sid, handIdx){
  const gs=prevGs; if(!gs) return;
  const hand=gs.splitActive?.[sid]?gs.hands?.[sid]?.['hand'+(handIdx+1)]||[]:gs.hands?.[sid]||[];
  const canDouble=hand.length===2&&myWallet>=(gs.bets?.[sid]?.main||0)&&!gs.doubled?.[sid];
  const canSplit=hand.length===2&&!gs.splitActive?.[sid]&&cardNum(hand[0])===cardNum(hand[1])&&myWallet>=(gs.bets?.[sid]?.main||0);
  $('btn-double').classList.toggle('hidden',!canDouble);
  $('btn-split').classList.toggle('hidden',!canSplit);
  show('play-buttons'); actionPending=false;
}
function doAction(action){
  if(!activeTurnSid||actionPending) return;
  actionPending=true; hide('play-buttons'); stopCountdownRing(); sfxClick();
  setTimeout(()=>socket.emit('action',{action,sid:activeTurnSid}), 150);
}
$('btn-hit').addEventListener('click',    ()=>doAction('hit'));
$('btn-stand').addEventListener('click',  ()=>doAction('stand'));
$('btn-double').addEventListener('click', ()=>doAction('double'));
$('btn-split').addEventListener('click',  ()=>doAction('split'));

// ── Chip Tray ──────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip=>{
  chip.addEventListener('click', ()=>{
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
  btn.addEventListener('click', e=>{
    const sid=btn.closest('.seat')?.dataset.seat;
    if(sid){ sfxClick(); socket.emit('leaveSeat',{sid}); }
    e.stopPropagation();
  });
});

// ── Insurance (big shields, auto-submit) ───────────────────────
function showInsuranceModal(){
  if(!prevGs) return;
  const gs=prevGs, sc=$('insurance-seats'); sc.innerHTML='';
  const mySeats=Object.entries(gs.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
  if(!mySeats.length) return;
  const choices={}; mySeats.forEach(s=>choices[s]=false);

  const modal=$('insurance-modal');
  modal.innerHTML=`
    <div id="insurance-title">🃏 Dealer Shows an Ace</div>
    <div id="insurance-subtitle">Insurance pays 2:1 — costs half your main bet</div>
    <div class="ins-shield-row">
      <button class="ins-shield ins-shield-yes" id="ins-yes-btn">
        <svg viewBox="0 0 60 70" fill="none" xmlns="http://www.w3.org/2000/svg" width="70" height="82">
          <path d="M30 4 L56 14 L56 36 C56 52 30 66 30 66 C30 66 4 52 4 36 L4 14 Z" fill="rgba(46,125,50,0.85)" stroke="#4caf50" stroke-width="2"/>
          <polyline points="18,35 27,45 44,26" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        </svg>
        <span>YES</span>
      </button>
      <button class="ins-shield ins-shield-no" id="ins-no-btn">
        <svg viewBox="0 0 60 70" fill="none" xmlns="http://www.w3.org/2000/svg" width="70" height="82">
          <path d="M30 4 L56 14 L56 36 C56 52 30 66 30 66 C30 66 4 52 4 36 L4 14 Z" fill="rgba(198,40,40,0.85)" stroke="#ef5350" stroke-width="2"/>
          <line x1="19" y1="25" x2="41" y2="47" stroke="white" stroke-width="4" stroke-linecap="round"/>
          <line x1="41" y1="25" x2="19" y2="47" stroke="white" stroke-width="4" stroke-linecap="round"/>
        </svg>
        <span>NO</span>
      </button>
    </div>`;

  function submitIns(){
    stopCountdownRing(); socket.emit('insuranceResponse',{choices}); hide('insurance-modal');
  }
  $('ins-yes-btn').addEventListener('click', ()=>{
    mySeats.forEach(s=>choices[s]=true);
    $('ins-yes-btn').classList.add('ins-shield-active');
    submitIns();
  }, {once:true});
  $('ins-no-btn').addEventListener('click', ()=>{
    submitIns();
  }, {once:true});

  show('insurance-modal');
  // Ring around modal
  setTimeout(()=>{
    const m=$('insurance-modal');
    if(m&&!m.classList.contains('hidden'))
      startCountdownRing(m, 15, ()=>submitIns());
  }, 200);
}

// ── Win Overlay ────────────────────────────────────────────────
function showWinOverlay(amount){
  if(winOverlayShown) return; winOverlayShown=true; sfxWin();
  document.querySelectorAll('.round-result-overlay').forEach(e=>e.remove());
  const ov=document.createElement('div'); ov.className='round-result-overlay';
  ov.innerHTML=`<div class="rr-label">You Win!</div><div class="rr-amount">€${amount.toLocaleString()}</div>`;
  $('game-container').appendChild(ov);
  setTimeout(()=>ov.classList.add('rr-fadeout'), 1800);
  setTimeout(()=>{ ov.remove(); winOverlayShown=false; }, 2600);
}

// ── Info Panel ─────────────────────────────────────────────────
const ip=$('table-info-panel');
if(ip){
  ip.addEventListener('mouseenter', ()=>$('table-payout-menu')?.classList.add('visible'));
  ip.addEventListener('mouseleave', ()=>$('table-payout-menu')?.classList.remove('visible'));
}

// ── History ────────────────────────────────────────────────────
$('btn-history')?.addEventListener('click', ()=>{ sfxClick(); openHistoryPanel(); });

function openHistoryPanel(){
  let panel=$('history-panel');
  if(!panel){
    panel=document.createElement('div'); panel.id='history-panel';
    panel.innerHTML=`<div class="history-header"><span class="history-title">HISTORY</span><button class="history-close" id="history-close">✕</button></div><div id="history-body"></div>`;
    $('game-container').appendChild(panel);
    $('history-close').addEventListener('click', ()=>panel.remove());
  }
  renderHistoryList($('history-body'));
}

function renderHistoryList(container){
  const history=loadHistory();
  if(!history.length){ container.innerHTML='<div class="history-empty">No rounds yet.</div>'; return; }
  const byDay={};
  history.forEach(r=>{ const d=r.time.slice(0,10); if(!byDay[d]) byDay[d]=[]; byDay[d].push(r); });
  const days=Object.keys(byDay).sort((a,b)=>b.localeCompare(a));
  container.innerHTML=days.map(day=>{
    const rounds=byDay[day], net=rounds.reduce((s,r)=>s+r.netCash,0);
    const dateStr=new Date(day+'T12:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    const nc=net>=0?'hist-pos':'hist-neg';
    return `<div class="hist-day-row" data-day="${day}">
      <span class="hist-arrow">›</span><span class="hist-date">${dateStr}</span>
      <span class="hist-net ${nc}">${net>=0?'+':''}€${Math.abs(net).toFixed(2)}</span>
    </div>
    <div class="hist-day-rounds hidden" id="hdr-${day.replace(/-/g,'_')}"></div>`;
  }).join('');
  container.querySelectorAll('.hist-day-row').forEach(row=>{
    row.addEventListener('click', ()=>{
      const day=row.dataset.day, re=$(`hdr-${day.replace(/-/g,'_')}`);
      if(!re) return;
      re.classList.toggle('hidden');
      if(!re.classList.contains('hidden')) renderDayRounds(re, byDay[day]);
    });
  });
}

function renderDayRounds(container, rounds){
  container.innerHTML=rounds.map(r=>{
    const t=new Date(r.time).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    const nc=r.netCash>=0?'hist-pos':'hist-neg';
    return `<div class="hist-round-row" data-id="${r.id}">
      <div class="hist-round-top"><span class="hist-round-table">${r.tableName}</span>
      <span class="hist-round-net ${nc}">${r.netCash>=0?'+':''}€${Math.abs(r.netCash).toFixed(2)}</span></div>
      <div class="hist-round-sub">${t} · Room ${r.roomCode} · Bet €${r.totalBet}</div>
    </div>`;
  }).join('');
  container.querySelectorAll('.hist-round-row').forEach(row=>{
    row.addEventListener('click', ()=>{
      const id=parseInt(row.dataset.id), entry=loadHistory().find(r=>r.id===id);
      if(entry) openRoundDetail(entry);
    });
  });
}

function mkHistCard(c){
  const el=document.createElement('div');
  el.className='hd-card-img'+(suitIsRed(c.suit)?' red':'');
  el.innerHTML=`<span class="card-val">${c.value}</span><span class="card-suit">${{S:'♠',H:'♥',D:'♦',C:'♣'}[c.suit]||''}</span>`;
  return el;
}

function openRoundDetail(entry){
  const panel=$('history-panel'); if(!panel) return;
  const body=$('history-body');   if(!body)  return;
  const t=new Date(entry.time).toLocaleString('en-GB',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const nc=entry.netCash>=0?'hist-pos':'hist-neg';
  // Dealer cards
  const dealerRow=document.createElement('div'); dealerRow.className='hd-cards-row';
  (entry.dealerCards||[]).forEach(c=>dealerRow.appendChild(mkHistCard(c)));
  const ds=score(entry.dealerCards||[]);

  // Seats
  const seatsDiv=document.createElement('div'); seatsDiv.className='hd-seats';
  entry.seats.forEach(s=>{
    const seatDiv=document.createElement('div'); seatDiv.className='hd-seat';
    seatDiv.innerHTML=`<div class="hd-seat-label">Seat ${s.sid}</div>`;
    s.hands.forEach((h,hi)=>{
      const handDiv=document.createElement('div'); handDiv.className='hd-hand';
      handDiv.innerHTML=`<div class="hd-section-label">Hand ${hi+1}</div>`;
      const cardsRow=document.createElement('div'); cardsRow.className='hd-cards-row';
      h.cards.forEach((c,ci)=>{
        const img=mkHistCard(c);
        // Mark last card with decision class
        if(ci===h.cards.length-1){
          const isWin=h.result?.toLowerCase().includes('win');
          const isBust=h.result?.toLowerCase().includes('bust');
          img.classList.add(isBust?'hd-decision-stand':'hd-decision-hit'); // simplified
          const moveLabel=document.createElement('div');
          moveLabel.className='hd-move-label '+(isBust?'hd-move-stand':'hd-move-hit');
          moveLabel.textContent=isBust?'BUST':h.result||'';
          const wrap=document.createElement('div'); wrap.style.cssText='display:flex;flex-direction:column;align-items:center;gap:2px;';
          wrap.appendChild(img); wrap.appendChild(moveLabel); cardsRow.appendChild(wrap);
        } else {
          cardsRow.appendChild(img);
        }
      });
      const rc=h.result?.toLowerCase().includes('win')?'res-win':h.result?.toLowerCase().includes('push')?'res-push':'res-lose';
      handDiv.appendChild(cardsRow);
      handDiv.innerHTML+=`<div class="hd-result ${rc}">${h.result||'—'} · Score ${h.score}</div>`;
      seatDiv.appendChild(handDiv);
    });
    const betsDiv=document.createElement('div'); betsDiv.className='hd-bets-table';
    const pp=s.ppBet>0?`<div class="hd-bet-line"><span>PP</span><span>€${s.ppBet}</span><span class="${s.ppNet>=0?'hist-pos':'hist-neg'}">${s.ppNet>=0?'+':''}€${Math.abs(s.ppNet)}</span></div>`:'';
    const sp=s.spBet>0?`<div class="hd-bet-line"><span>21+3</span><span>€${s.spBet}</span><span class="${s.spNet>=0?'hist-pos':'hist-neg'}">${s.spNet>=0?'+':''}€${Math.abs(s.spNet)}</span></div>`:'';
    betsDiv.innerHTML=`<div class="hd-bet-line hd-bet-header"><span>Bet</span><span>Amount</span><span>Net</span></div>
      <div class="hd-bet-line"><span>Main</span><span>€${s.mainBet}</span><span class="${s.mainNet>=0?'hist-pos':'hist-neg'}">${s.mainNet>=0?'+':''}€${Math.abs(s.mainNet)}</span></div>${pp}${sp}`;
    seatDiv.appendChild(betsDiv);
    seatsDiv.appendChild(seatDiv);
  });

  body.innerHTML='';
  const backBtn=document.createElement('div'); backBtn.className='hist-detail-back-row';
  backBtn.innerHTML='<button class="hist-detail-back" id="hd-back">‹ Back</button>';
  const meta=document.createElement('div'); meta.className='hist-detail-meta';
  meta.innerHTML=`<b>${entry.tableName}</b><br>${t} · Room <b>${entry.roomCode}</b><br>Bet €${entry.totalBet} &nbsp; Net: <b class="${nc}">${entry.netCash>=0?'+':''}€${Math.abs(entry.netCash).toFixed(2)}</b>`;
  const dealerSec=document.createElement('div'); dealerSec.className='hd-dealer-row';
  dealerSec.innerHTML=`<span class="hd-section-label">Dealer · ${ds}</span>`;
  dealerSec.appendChild(dealerRow);

  body.appendChild(backBtn); body.appendChild(meta); body.appendChild(dealerSec); body.appendChild(seatsDiv);
  $('hd-back').addEventListener('click', ()=>renderHistoryList(body));
}
