// =============================================================
// ui.js — Client UI: socket events, rendering, sounds, timers.
// Depends on game.js being loaded first (CHIP_COLORS, score, etc.)
// =============================================================
const myToken = loadToken(); // loaded from game.js
const socket = io();
let mySocketId=null,myName='',myWallet=5000,roomCode=null,selectedChip=100;
let activeTurnSid=null,activeTurnHandIdx=0,prevGs=null,winOverlayShown=false;
let actionPending=false,sfxVolume=0.4,currentRoundLog=null;
let countdownRafId=null,countdownStart=0,countdownTotal=15000;
let autoplayOn=false,autoplayThreshold=17,bjSoundedSeats=new Set(),shownSideBetPills=new Set();
let betTimerEnabled=true; // toggled by host
let _isHost=false; // whether this client is the room host
let _pendingCountdownSid=null,_countdownGen=0;
const _prevScores={};
const _scoreOverride={}; // pillId → {text, locked} — persists until real value arrives
const _sindOverride={}; // sid → {html, tok, timer} — sind-N action symbol override

  return 0; // broke
}
const AudioCtx=window.AudioContext||window.webkitAudioContext;let actx=null;
function getACtx(){if(!actx){actx=new AudioCtx();}if(actx.state==='suspended')actx.resume();return actx;}

// ── CARD DEAL: papery swish — bandpass filtered noise ──
function sfxCard(){try{
  const ctx=getACtx(),sr=ctx.sampleRate,len=Math.floor(sr*0.07);
  const buf=ctx.createBuffer(1,len,sr),d=buf.getChannelData(0);
  for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/len,2.5);
  const src=ctx.createBufferSource();
  const bp=ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=4200;bp.Q.value=1.2;
  const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=1800;
  const g=ctx.createGain();g.gain.setValueAtTime(sfxVolume*0.55,ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.07);
  src.buffer=buf;src.connect(hp);hp.connect(bp);bp.connect(g);g.connect(ctx.destination);src.start();
}catch(e){}}

// ── CARD FLIP: sharp click + quick pitch snap ──
function sfxFlip(){try{
  const ctx=getACtx(),now=ctx.currentTime;
  // Click transient
  const buf=ctx.createBuffer(1,Math.floor(ctx.sampleRate*0.015),ctx.sampleRate);
  const d=buf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.4));
  const src=ctx.createBufferSource();src.buffer=buf;
  const g=ctx.createGain();g.gain.setValueAtTime(sfxVolume*0.7,now);g.gain.exponentialRampToValueAtTime(0.0001,now+0.015);
  src.connect(g);g.connect(ctx.destination);src.start();
  // Snap tone
  const o=ctx.createOscillator(),og=ctx.createGain();
  o.type='triangle';o.frequency.setValueAtTime(320,now+0.005);
  o.frequency.exponentialRampToValueAtTime(120,now+0.06);
  og.gain.setValueAtTime(sfxVolume*0.18,now+0.005);og.gain.exponentialRampToValueAtTime(0.0001,now+0.07);
  o.connect(og);og.connect(ctx.destination);o.start(now+0.005);o.stop(now+0.07);
}catch(e){}}

// ── HIT: two quick felt thumps (knuckles on table) ──
function sfxHit(){try{
  const ctx=getACtx();
  const mkThump=(t)=>{
    const buf=ctx.createBuffer(1,Math.floor(ctx.sampleRate*0.04),ctx.sampleRate);
    const d=buf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.25));
    const src=ctx.createBufferSource();src.buffer=buf;
    const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=280;
    const g=ctx.createGain();g.gain.setValueAtTime(sfxVolume*0.45,t);g.gain.exponentialRampToValueAtTime(0.0001,t+0.04);
    src.connect(lp);lp.connect(g);g.connect(ctx.destination);src.start(t);
  };
  mkThump(ctx.currentTime);mkThump(ctx.currentTime+0.09);
}catch(e){}}

// ── STAND: soft air whoosh ──
function sfxStand(){try{
  const ctx=getACtx(),sr=ctx.sampleRate,len=Math.floor(sr*0.18),now=ctx.currentTime;
  const buf=ctx.createBuffer(1,len,sr),d=buf.getChannelData(0);
  for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*Math.sin(i/len*Math.PI);
  const src=ctx.createBufferSource();src.buffer=buf;
  const bp=ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=800;bp.Q.value=0.5;
  const g=ctx.createGain();g.gain.setValueAtTime(0.0001,now);g.gain.linearRampToValueAtTime(sfxVolume*0.18,now+0.04);
  g.gain.exponentialRampToValueAtTime(0.0001,now+0.18);
  src.connect(bp);bp.connect(g);g.connect(ctx.destination);src.start(now);
}catch(e){}}

// ── WIN: two soft rising chimes ──
function sfxWin(){try{
  const ctx=getACtx(),now=ctx.currentTime;
  [[660,0],[880,0.12]].forEach(([f,dt])=>{
    const o=ctx.createOscillator(),g=ctx.createGain();
    o.type='sine';o.frequency.value=f;
    g.gain.setValueAtTime(sfxVolume*0.22,now+dt);g.gain.exponentialRampToValueAtTime(0.0001,now+dt+0.25);
    o.connect(g);g.connect(ctx.destination);o.start(now+dt);o.stop(now+dt+0.25);
  });
}catch(e){}}

// ── BUST: short descending thud ──
function sfxBust(){try{
  const ctx=getACtx(),now=ctx.currentTime;
  const o=ctx.createOscillator(),g=ctx.createGain();
  o.type='triangle';o.frequency.setValueAtTime(220,now);o.frequency.exponentialRampToValueAtTime(60,now+0.2);
  g.gain.setValueAtTime(sfxVolume*0.3,now);g.gain.exponentialRampToValueAtTime(0.0001,now+0.2);
  o.connect(g);g.connect(ctx.destination);o.start(now);o.stop(now+0.2);
}catch(e){}}

// ── CHIP PLACE: ceramic click + metallic ring ──
let _sfxChipLast=0;
function sfxChip(){
  const now=Date.now();if(now-_sfxChipLast<60)return; // debounce overlapping calls
  _sfxChipLast=now;
  try{
    const ctx=getACtx(),t=ctx.currentTime;
    // Ceramic click transient
    const buf=ctx.createBuffer(1,Math.floor(ctx.sampleRate*0.018),ctx.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.15));
    const src=ctx.createBufferSource();src.buffer=buf;
    const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=2200;
    const g=ctx.createGain();g.gain.setValueAtTime(sfxVolume*0.55,t);g.gain.exponentialRampToValueAtTime(0.0001,t+0.025);
    src.connect(hp);hp.connect(g);g.connect(ctx.destination);src.start(t);
    // Subtle metallic ring — pitched slightly differently each time for realism
    const freq=1800+Math.random()*600;
    const o=ctx.createOscillator(),og=ctx.createGain();
    o.type='sine';o.frequency.setValueAtTime(freq,t+0.003);
    og.gain.setValueAtTime(sfxVolume*0.06,t+0.003);og.gain.exponentialRampToValueAtTime(0.0001,t+0.09);
    o.connect(og);og.connect(ctx.destination);o.start(t+0.003);o.stop(t+0.09);
  }catch(e){}
}

// ── CHIP STACK: multiple chips in rapid succession ──
function sfxChipStack(count=3){
  try{
    const ctx=getACtx();
    const n=Math.min(count,6);
    for(let i=0;i<n;i++){
      const t=ctx.currentTime+i*0.055;
      const buf=ctx.createBuffer(1,Math.floor(ctx.sampleRate*0.02),ctx.sampleRate);
      const d=buf.getChannelData(0);
      for(let j=0;j<d.length;j++)d[j]=(Math.random()*2-1)*Math.exp(-j/(d.length*0.12));
      const src=ctx.createBufferSource();src.buffer=buf;
      const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=1800+Math.random()*400;
      const g=ctx.createGain();
      g.gain.setValueAtTime(sfxVolume*(0.5-i*0.04),t);
      g.gain.exponentialRampToValueAtTime(0.0001,t+0.022);
      src.connect(hp);hp.connect(g);g.connect(ctx.destination);src.start(t);
    }
  }catch(e){}
}

// ── CHIP WIN: coins spilling/cascading ──
function sfxChipWin(){
  try{
    const ctx=getACtx();
    const count=8;
    for(let i=0;i<count;i++){
      const t=ctx.currentTime+i*0.04+Math.random()*0.015;
      const buf=ctx.createBuffer(1,Math.floor(ctx.sampleRate*0.025),ctx.sampleRate);
      const d=buf.getChannelData(0);
      for(let j=0;j<d.length;j++)d[j]=(Math.random()*2-1)*Math.exp(-j/(d.length*0.1));
      const src=ctx.createBufferSource();src.buffer=buf;
      const bp=ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=2400+Math.random()*800;bp.Q.value=1.5;
      const g=ctx.createGain();
      g.gain.setValueAtTime(sfxVolume*(0.45-i*0.025),t);
      g.gain.exponentialRampToValueAtTime(0.0001,t+0.028);
      src.connect(bp);bp.connect(g);g.connect(ctx.destination);src.start(t);
    }
  }catch(e){}
}

// ── UI CLICK: very soft tick ──
function sfxClick(){
  try{
    const ctx=getACtx(),t=ctx.currentTime;
    const o=ctx.createOscillator(),g=ctx.createGain();
    o.type='sine';o.frequency.setValueAtTime(800,t);
    g.gain.setValueAtTime(sfxVolume*0.06,t);g.gain.exponentialRampToValueAtTime(0.0001,t+0.03);
    o.connect(g);g.connect(ctx.destination);o.start(t);o.stop(t+0.03);
  }catch(e){}
}

// ── DEAL START: whoosh ──
function sfxDeal(){
  try{
    const ctx=getACtx(),sr=ctx.sampleRate,len=Math.floor(sr*0.12),t=ctx.currentTime;
    const buf=ctx.createBuffer(1,len,sr),d=buf.getChannelData(0);
    for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*Math.pow(i/len,0.4)*Math.pow(1-i/len,1.2);
    const src=ctx.createBufferSource();src.buffer=buf;
    const bp=ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=1200;bp.Q.value=0.7;
    const g=ctx.createGain();g.gain.setValueAtTime(sfxVolume*0.35,t);g.gain.exponentialRampToValueAtTime(0.0001,t+0.12);
    src.connect(bp);bp.connect(g);g.connect(ctx.destination);src.start(t);
  }catch(e){}
}
const $=id=>document.getElementById(id);
const show=id=>$(id)?.classList.remove('hidden');
const hide=id=>$(id)?.classList.add('hidden');


// ── Pre-fill saved name ─────────────────────────────────────────
(function(){
  const s=loadName();
  if(s){const i=$('lobby-name');if(i)i.value=s;const d=$('lobby-header-name-display');if(d)d.textContent=s;}
})();

// ── Loading screen ───────────────────────────────────────────────
// Show loading screen briefly, then reveal lobby when ready
(function(){
  const ls=$('loading-screen');
  const lobby=$('lobby-screen');
  // Wait for fonts + socket connection attempt, then transition
  const showLobby=()=>{
    if(ls){ls.classList.add('fade-out');setTimeout(()=>{ls.style.display='none';},500);}
    if(lobby)lobby.classList.remove('hidden');
  };
  // Minimum 1.8s loading screen, then reveal
  setTimeout(showLobby, 1800);
})();

// ── Helpers ─────────────────────────────────────────────────────
function showLobbyError(msg){
  const el=$('lobby-error');
  if(!el)return;
  el.textContent=msg;
  el.style.opacity='1';
  clearTimeout(el._t);
  el._t=setTimeout(()=>{el.style.opacity='0';setTimeout(()=>el.textContent='',400);},3200);
}

function showLeaveConfirm(){
  showConfirmModal('Leave Room?','You\'ll lose your seat and any bets.','Leave','#ef5350',()=>{socket.disconnect();location.reload();});
}

function showConfirmModal(title,sub,confirmLabel,confirmColor,onConfirm){
  if($('confirm-modal'))return;
  const m=document.createElement('div');m.id='confirm-modal';
  m.innerHTML=`<div class="confirm-card"><div class="confirm-title">${title}</div><div class="confirm-sub">${sub}</div><div class="confirm-btns"><button class="confirm-btn-yes" style="background:${confirmColor}">${confirmLabel}</button><button class="confirm-btn-no">Cancel</button></div></div>`;
  document.body.appendChild(m);
  m.querySelector('.confirm-btn-yes').addEventListener('click',()=>{m.remove();onConfirm();});
  m.querySelector('.confirm-btn-no').addEventListener('click',()=>m.remove());
}

function launchGame(){
  hide('waiting-screen');hide('lobby-screen');
  show('game-container');
  const ct=$('chip-tray');
  if(ct){ct.classList.remove('hidden');ct.classList.remove('tray-hidden');}
}

// ── Lobby panel toggle ───────────────────────────────────────────
let _activePanel=null;
function openPanel(id){
  if(_activePanel&&_activePanel!==id)closePanel(_activePanel);
  const p=$(id);if(p){p.classList.add('open');_activePanel=id;}
  if(id==='lobby-public-panel')loadPublicRooms();
}
function closePanel(id){const p=$(id);if(p)p.classList.remove('open');if(_activePanel===id)_activePanel=null;}

document.querySelectorAll('.lobby-panel-close').forEach(btn=>{
  btn.addEventListener('click',()=>closePanel(btn.dataset.close));
});

// ── Room type toggle ─────────────────────────────────────────────
let _roomType='public';
document.querySelectorAll('.room-type-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.room-type-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    _roomType=btn.dataset.type;
  });
});

// ── Name input sync ─────────────────────────────────────────────
$('lobby-name')?.addEventListener('input',()=>{
  const v=$('lobby-name').value;
  const d=$('lobby-header-name-display');
  if(d)d.textContent=v||'Set your name';
});

// ── Action buttons ───────────────────────────────────────────────
$('btn-lobby-create')?.addEventListener('click',()=>{
  openPanel('lobby-create-panel');
  closePanel('lobby-public-panel');closePanel('lobby-private-panel');
});
$('btn-lobby-public')?.addEventListener('click',()=>{
  openPanel('lobby-public-panel');
  closePanel('lobby-create-panel');closePanel('lobby-private-panel');
});
$('btn-lobby-private')?.addEventListener('click',()=>{
  openPanel('lobby-private-panel');
  closePanel('lobby-create-panel');closePanel('lobby-public-panel');
});

// ── Create Room ──────────────────────────────────────────────────
$('btn-create-confirm')?.addEventListener('click',()=>{
  const name=$('lobby-name').value.trim();
  if(!name){showLobbyError('Enter your name first');return;}
  const roomName=$('create-room-name').value.trim();
  const password=$('create-room-password').value;
  const balance=parseInt($('create-room-balance').value)||5000;
  const isPublic=_roomType==='public';
  myName=name;saveName(name);
  socket.emit('createRoom',{name,token:myToken,roomName,isPublic,password,startingBalance:balance});
});

// ── Join Private ─────────────────────────────────────────────────
$('btn-join-private-confirm')?.addEventListener('click',()=>doJoinPrivate());
$('lobby-code-input')?.addEventListener('keydown',e=>{if(e.key==='Enter')doJoinPrivate();});

function doJoinPrivate(){
  const name=$('lobby-name').value.trim();
  if(!name){showLobbyError('Enter your name first');return;}
  const code=$('lobby-code-input').value.trim().toUpperCase();
  if(code.length<4){showLobbyError('Enter a valid room code');return;}
  const pw=$('lobby-private-pw').value;
  myName=name;saveName(name);
  socket.emit('joinRoom',{code,name,token:myToken,password:pw});
}

// ── Public Room List ─────────────────────────────────────────────
let _pendingJoinCode=null;

async function loadPublicRooms(){
  const list=$('rooms-list');
  if(list)list.innerHTML='<div class="rooms-empty">Loading…</div>';
  try{
    const r=await fetch('/api/rooms');
    const rooms=await r.json();
    renderRoomList(rooms);
  }catch(e){
    if(list)list.innerHTML='<div class="rooms-empty">Could not load rooms</div>';
  }
}

function renderRoomList(rooms){
  const list=$('rooms-list');if(!list)return;
  const search=($('rooms-search')?.value||'').toLowerCase();
  const sort=$('rooms-sort')?.value||'seats';
  let filtered=rooms.filter(r=>{
    if(search&&!r.name.toLowerCase().includes(search)&&!r.hostName.toLowerCase().includes(search))return false;
    return true;
  });
  filtered.sort((a,b)=>{
    if(sort==='seats')return b.seatsOpen-a.seatsOpen;
    if(sort==='players')return b.players-a.players;
    if(sort==='balance')return b.startingBalance-a.startingBalance;
    if(sort==='name')return a.name.localeCompare(b.name);
    return 0;
  });
  if(!filtered.length){list.innerHTML='<div class="rooms-empty">No public rooms found</div>';return;}
  list.innerHTML='';
  filtered.forEach(room=>{
    const card=document.createElement('div');card.className='room-card';
    const statusIcon=room.gameStatus==='betting'?'🟢':room.gameStatus==='game_over'?'🟡':'🔵';
    const statusLabel=room.gameStatus==='betting'?'Betting':room.gameStatus==='game_over'?'Round ending':'In game';
    card.innerHTML=`
      <div class="room-card-icon">${statusIcon}</div>
      <div class="room-card-info">
        <div class="room-card-name">${room.name}</div>
        <div class="room-card-meta">Host: ${room.hostName} · €${room.startingBalance.toLocaleString()} start · ${statusLabel}</div>
      </div>
      <div class="room-card-right">
        <div class="room-card-seats">${room.seatsOpen}/${room.maxPlayers} open</div>
        ${room.hasPassword?'<div class="room-card-lock">🔒</div>':''}
        <button class="room-card-join" data-code="${room.code}" data-locked="${room.hasPassword}">Join</button>
      </div>`;
    list.appendChild(card);
    card.querySelector('.room-card-join').addEventListener('click',e=>{
      e.stopPropagation();
      joinPublicRoom(room.code, room.hasPassword);
    });
    card.addEventListener('click',()=>joinPublicRoom(room.code, room.hasPassword));
  });
}

function joinPublicRoom(code, hasPassword){
  const name=$('lobby-name').value.trim();
  if(!name){showLobbyError('Enter your name first');return;}
  if(hasPassword){
    _pendingJoinCode=code;
    $('lobby-pw-input').value='';
    $('lobby-pw-error').textContent='';
    $('lobby-pw-modal').classList.add('open');
    setTimeout(()=>$('lobby-pw-input')?.focus(),100);
  }else{
    myName=name;saveName(name);
    socket.emit('joinRoom',{code,name,token:myToken});
  }
}

$('btn-pw-confirm')?.addEventListener('click',()=>{
  const name=$('lobby-name').value.trim();
  const pw=$('lobby-pw-input').value;
  if(!_pendingJoinCode)return;
  myName=name;saveName(name);
  socket.emit('joinRoom',{code:_pendingJoinCode,name,token:myToken,password:pw});
  $('lobby-pw-modal').classList.remove('open');
  _pendingJoinCode=null;
});
$('lobby-pw-input')?.addEventListener('keydown',e=>{if(e.key==='Enter')$('btn-pw-confirm')?.click();});
$('btn-pw-cancel')?.addEventListener('click',()=>{$('lobby-pw-modal').classList.remove('open');_pendingJoinCode=null;});

$('rooms-search')?.addEventListener('input',async()=>{
  try{const r=await fetch('/api/rooms');renderRoomList(await r.json());}catch(e){}
});
$('rooms-sort')?.addEventListener('change',async()=>{
  try{const r=await fetch('/api/rooms');renderRoomList(await r.json());}catch(e){}
});
$('btn-rooms-refresh')?.addEventListener('click',loadPublicRooms);

// ── Waiting room ─────────────────────────────────────────────────
$('btn-start-game')?.addEventListener('click',()=>socket.emit('startGame'));
$('btn-leave-room')?.addEventListener('click',()=>showLeaveConfirm());
function updateWaitingHostUI(isHost){const b=$('btn-start-game');if(b)b.style.display=isHost?'':'none';}

// ── Socket core ────────────────────────────────────────────────
socket.on('roomJoined',({code,socketId,isHost,roomName})=>{
  _isHost=!!isHost;
  mySocketId=socketId;roomCode=code;
  hide('lobby-screen');
  show('waiting-screen');
  const wc=$('waiting-code');if(wc)wc.textContent=code;
  const rb=$('room-badge-code');if(rb)rb.textContent=code;
  const rn=$('waiting-room-name');if(rn)rn.textContent=roomName||'';
  updateWaitingHostUI(isHost);
});
socket.on('roomError',msg=>{
  showLobbyError(msg);
  // If password was wrong, re-open the pw modal
  if(msg==='Wrong password'&&_pendingJoinCode){
    $('lobby-pw-error').textContent='Incorrect password';
    $('lobby-pw-modal').classList.add('open');
  }
});
socket.on('gameLaunched',()=>launchGame());
socket.on('autoLaunch',()=>launchGame());
socket.on('banned',()=>{const m=document.createElement('div');m.className='kick-modal';m.innerHTML='<div class="kick-card"><div class="kick-title" style="color:#ff9800">🚫 You are banned</div><div style="color:rgba(255,255,255,0.5);font-size:.85rem;margin-bottom:20px;">You were banned from this room by the host.</div><button onclick="location.reload()" class="kick-btn">Back to Lobby</button></div>';document.body.appendChild(m);});
socket.on('kicked',()=>{const m=document.createElement('div');m.className='kick-modal';m.innerHTML='<div class="kick-card"><div class="kick-title">You were kicked</div><button onclick="location.reload()" class="kick-btn">Back to Lobby</button></div>';document.body.appendChild(m);});
socket.on('hostChanged',({hostId})=>{_isHost=(hostId===mySocketId);syncBetTimerHostLock(_isHost);updateWaitingHostUI(hostId===mySocketId);if(hostId===mySocketId){const t=document.createElement('div');t.className='host-toast';t.textContent='\ud83d\udc51 You are now the host';document.body.appendChild(t);setTimeout(()=>t.remove(),3000);}});
socket.on('insuranceOfferSeat',({sid,cost})=>showInsuranceForSeat(sid,cost));
socket.on('stateUpdate',({gs,players,hostId})=>{const wl=$('waiting-players');if(wl)wl.innerHTML=Object.entries(players).map(([id,p])=>`<div class="waiting-player">${id===hostId?'<span class="lobby-crown">\ud83d\udc51</span>':''}${p.name}</div>`).join('');const sb=$('btn-start-game');if(sb)sb.style.display=(mySocketId===hostId)?'':'none';// Always sync room badge
if(roomCode){const rb=$('room-badge-code');if(rb)rb.textContent=roomCode;}window._gsInsurancePhase=!!gs.insurancePhase;if(!gs.insurancePhase){document.querySelectorAll('.seat.insurance-highlight').forEach(e=>e.classList.remove('insurance-highlight'));$('insurance-modal')?.classList.add('hidden');}trackRound(gs,players);renderState(gs,players,hostId);prevGs=JSON.parse(JSON.stringify(gs));});
socket.on('timerTick',secs=>{
  const gs=prevGs;
  if(gs&&gs.activeSeats.length===0){hide('bet-timer-wrap');stopBetTimerArc();return;}
  hide('bet-timer-wrap'); // hide old text timer, use arc instead
  updateBetTimerArc(secs,15);
  // no sound for timer ticks
});
socket.on('timerCancel',()=>{hide('bet-timer-wrap');stopBetTimerArc();});
// Another player placed a bet — play chip sound
socket.on('betPlaced',({sid,type,amt})=>{sfxChip();});
// Broadcast from server: another player took an action — show their indicator
socket.on('playerAction',({sid,action})=>{
  if(sid===activeTurnSid&&_sindOverride[sid]?.active)return; // already shown locally
  const ind=$('sind-'+sid);if(!ind||ind.classList.contains('sind-bust'))return;
  const SPLIT_SVG='<svg width="22" height="16" viewBox="0 0 28 20" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="10,4 2,10 10,16"/><polyline points="18,4 26,10 18,16"/></svg>';
  const overrideHTML=
    action==='hit'   ?'<span class="sind-action-sym sind-action-hit">+</span>':
    action==='stand' ?'<span class="sind-action-sym sind-action-stand">−</span>':
    action==='double'?'<span class="sind-action-sym sind-action-double">2×</span>':
    action==='split' ?SPLIT_SVG:null;
  if(!overrideHTML)return;
  const tok=((_sindOverride[sid]?.tok)||0)+1;
  if(_sindOverride[sid]?.timer)clearTimeout(_sindOverride[sid].timer);
  const shownAt=Date.now();
  _sindOverride[sid]={tok,active:true,shownAt};
  const savedClass=ind.className,savedHTML=ind.innerHTML;
  ind.className='seat-bottom-ind sind-action-overlay';
  ind.innerHTML=overrideHTML;
  const timer=setTimeout(()=>{
    if(_sindOverride[sid]?.tok!==tok)return;
    delete _sindOverride[sid];
    ind.className=savedClass;ind.innerHTML=savedHTML;
  },1500);
  _sindOverride[sid].timer=timer;
  _sindOverride[sid].restore=()=>{
    if(_sindOverride[sid]?.tok!==tok)return;
    const elapsed=Date.now()-(_sindOverride[sid].shownAt||0);
    const remaining=Math.max(0,1000-elapsed); // enforce 1s minimum
    if(remaining>0){
      setTimeout(()=>{
        if(_sindOverride[sid]?.tok!==tok)return;
        delete _sindOverride[sid];clearTimeout(timer);
        ind.className=savedClass;ind.innerHTML=savedHTML;
      },remaining);
    }else{
      delete _sindOverride[sid];clearTimeout(timer);
      ind.className=savedClass;ind.innerHTML=savedHTML;
    }
  };
});
socket.on('yourTurn',({sid,handIdx,ownerId})=>{
  activeTurnSid=sid;activeTurnHandIdx=handIdx||0;actionPending=false;stopCountdown();
  if(ownerId===mySocketId){
    _pendingCountdownSid=sid;
    const myGen=++_countdownGen;
    setTimeout(()=>{
      if(_countdownGen!==myGen)return;
      showPlayButtons(sid,handIdx||0);
      setTimeout(()=>{
        if(_countdownGen!==myGen)return;
        const pb=$('play-buttons');
        if(pb&&!pb.classList.contains('betting-hidden')&&!pb.classList.contains('hidden'))
          startCountdown(15000,()=>autoPlayAction(sid,handIdx||0));
      },400);
    },350);
  }else{
    hide('play-buttons');
  }
});
socket.on('dealVote',({ready,needed,readyIds})=>{const b=$('btn-deal');if(!b)return;if(readyIds.includes(mySocketId)){b.textContent=`Waiting\u2026 (${ready}/${needed})`;b.disabled=true;b.style.opacity='0.6';}else{b.textContent=`Deal (${ready}/${needed} ready)`;b.disabled=false;b.style.opacity='1';}});

// ── Action turn timer circle (below play-buttons) ──────────────
const _AT_R=22, _AT_CIRC=2*Math.PI*_AT_R; // r=22 → circumference≈138.23
function _positionActionTimer(){
  const wrap=document.getElementById('action-timer-wrap');if(!wrap)return;
  const pb=$('play-buttons');if(!pb)return;
  const rect=pb.getBoundingClientRect();
  if(rect.width===0){setTimeout(_positionActionTimer,80);return;}
  wrap.style.position='fixed';
  wrap.style.left=(rect.left+rect.width/2-27)+'px';
  wrap.style.top=(rect.bottom+10)+'px';
  wrap.style.width='54px';
  wrap.style.height='54px';
}
function startCountdown(durationMs,onTimeout){
  stopCountdown();
  countdownStart=performance.now();countdownTotal=durationMs;
  const wrap=document.getElementById('action-timer-wrap');
  const fill=document.getElementById('action-timer-fill');
  const num=document.getElementById('action-timer-num');
  if(!wrap||!fill||!num)return;
  fill.setAttribute('stroke-dasharray',String(_AT_CIRC));
  fill.setAttribute('stroke-dashoffset','0');
  fill.setAttribute('stroke','#4caf50');
  wrap.classList.remove('hidden','urgent');
  _positionActionTimer();
  function tick(now){
    const p=Math.min((now-countdownStart)/durationMs,1);
    // Drain clockwise: dashoffset grows from 0 → circumference
    fill.setAttribute('stroke-dashoffset',String(_AT_CIRC*p));
    // Color: green → yellow → red
    const r=Math.min(255,Math.round(p<0.5?p*2*255:255));
    const g=Math.max(0,Math.round(p<0.5?255:(1-(p-0.5)*2)*255));
    fill.setAttribute('stroke',`rgb(${r},${g},30)`);
    // Number: seconds remaining
    const secsLeft=Math.ceil((1-p)*durationMs/1000);
    num.textContent=String(secsLeft);
    if(p>0.6)wrap.classList.add('urgent'); else wrap.classList.remove('urgent');
    if(p<1){countdownRafId=requestAnimationFrame(tick);}else{stopCountdown();if(onTimeout)onTimeout();}
  }
  countdownRafId=requestAnimationFrame(tick);
}
function stopCountdown(){
  if(countdownRafId){cancelAnimationFrame(countdownRafId);countdownRafId=null;}
  const wrap=document.getElementById('action-timer-wrap');
  if(wrap){wrap.classList.add('hidden');wrap.classList.remove('urgent');}
}
// Countdown around deal button
let dealCountdownRaf=null;
function startDealCountdown(){
  if(dealCountdownRaf){cancelAnimationFrame(dealCountdownRaf);dealCountdownRaf=null;}
  document.getElementById('deal-countdown-svg')?.remove();
  const dealBtn=$('btn-deal');if(!dealBtn)return;
  const rect=dealBtn.getBoundingClientRect();
  const pad=10;
  const x=rect.left-pad, y=rect.top-pad;
  const w=rect.width+pad*2, h=rect.height+pad*2;
  const rx=30;
  const mx=w/2;
  const pathD=`M ${mx} 0 L ${w-rx} 0 Q ${w} 0 ${w} ${rx} L ${w} ${h-rx} Q ${w} ${h} ${w-rx} ${h} L ${rx} ${h} Q 0 ${h} 0 ${h-rx} L 0 ${rx} Q 0 0 ${rx} 0 Z`;
  const perim=2*(w-2*rx)+2*(h-2*rx)+2*Math.PI*rx;
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.id='deal-countdown-svg';
  svg.style.cssText=`position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;pointer-events:none;z-index:199;overflow:visible;`;
  const track=document.createElementNS('http://www.w3.org/2000/svg','path');
  track.setAttribute('d',pathD);track.setAttribute('fill','none');
  track.setAttribute('stroke','rgba(0,0,0,0.2)');track.setAttribute('stroke-width','3');
  const line=document.createElementNS('http://www.w3.org/2000/svg','path');
  line.id='deal-cd-path';line.setAttribute('d',pathD);line.setAttribute('fill','none');
  line.setAttribute('stroke','#000');line.setAttribute('stroke-width','3');
  line.setAttribute('stroke-linecap','round');line.setAttribute('stroke-linejoin','round');
  line.setAttribute('stroke-dasharray',String(perim));line.setAttribute('stroke-dashoffset','0');
  svg.appendChild(track);svg.appendChild(line);document.body.appendChild(svg);
  const start=performance.now(), dur=15000;
  function tick(now){
    const p=Math.min((now-start)/dur,1);
    line.setAttribute('stroke-dashoffset',String(perim*p));
    if(p<1){dealCountdownRaf=requestAnimationFrame(tick);}
    else{cancelAnimationFrame(dealCountdownRaf);dealCountdownRaf=null;svg.remove();}
  }
  dealCountdownRaf=requestAnimationFrame(tick);
}
function stopDealCountdown(){
  if(dealCountdownRaf){cancelAnimationFrame(dealCountdownRaf);dealCountdownRaf=null;}
  document.getElementById('deal-countdown-svg')?.remove();
}
// ── Bet timer arc — smooth RAF-interpolated (not jumpy 1s ticks) ──
let _betArcMax=15,_betArcRaf=null,_betArcTickTime=null,_betArcTickSecs=null;
function _ensureBetArcSVG(){
  let svg=document.getElementById('bet-arc-svg');
  if(svg)return svg;
  const dealBtn=$('btn-deal');if(!dealBtn)return null;
  svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.id='bet-arc-svg';
  svg.style.cssText='position:fixed;pointer-events:none;z-index:199;overflow:visible;';
  document.body.appendChild(svg);
  const pad=10;
  const rect=dealBtn.getBoundingClientRect();
  const x=rect.left-pad,y=rect.top-pad,w=rect.width+pad*2,h=rect.height+pad*2,rx=28;
  const mx=w/2;
  const pathD=`M ${mx} 0 L ${rx} 0 Q 0 0 0 ${rx} L 0 ${h-rx} Q 0 ${h} ${rx} ${h} L ${w-rx} ${h} Q ${w} ${h} ${w} ${h-rx} L ${w} ${rx} Q ${w} 0 ${w-rx} 0 L ${mx} 0`;
  const perim=2*(w-2*rx)+2*(h-2*rx)+2*Math.PI*rx;
  svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  svg.style.left=x+'px';svg.style.top=y+'px';svg.style.width=w+'px';svg.style.height=h+'px';
  const track=document.createElementNS('http://www.w3.org/2000/svg','path');
  track.id='bet-arc-track';track.setAttribute('d',pathD);track.setAttribute('fill','none');
  track.setAttribute('stroke','rgba(255,255,255,0.12)');track.setAttribute('stroke-width','3.5');
  track.setAttribute('stroke-linecap','round');track.setAttribute('stroke-linejoin','round');
  const line=document.createElementNS('http://www.w3.org/2000/svg','path');
  line.id='bet-arc-line';line.setAttribute('d',pathD);line.setAttribute('fill','none');
  line.setAttribute('stroke','#4caf50');line.setAttribute('stroke-width','3.5');
  line.setAttribute('stroke-linecap','round');line.setAttribute('stroke-linejoin','round');
  line.setAttribute('stroke-dasharray',String(perim));line.setAttribute('stroke-dashoffset','0');
  svg.appendChild(track);svg.appendChild(line);
  svg._perim=perim;
  return svg;
}
function _betArcFrame(){
  const svg=document.getElementById('bet-arc-svg');
  const line=document.getElementById('bet-arc-line');
  if(!svg||!line||_betArcTickTime===null){_betArcRaf=null;return;}
  // Interpolate: each tick represents 1 second draining
  const elapsed=(performance.now()-_betArcTickTime)/1000; // secs since last tick
  const secsConsumed=(_betArcMax-_betArcTickSecs)+elapsed; // total consumed
  const p=Math.min(secsConsumed/_betArcMax,1);
  line.setAttribute('stroke-dashoffset',String(svg._perim*p));
  // Color: green→yellow→red as timer drains
  const r=Math.min(255,Math.round(p<0.5?p*2*255:255));
  const g=Math.max(0,Math.round(p<0.5?255:(1-(p-0.5)*2)*255));
  line.setAttribute('stroke',`rgb(${r},${g},20)`);
  if(p<1)_betArcRaf=requestAnimationFrame(_betArcFrame);
  else _betArcRaf=null;
}
function updateBetTimerArc(secsLeft,total){
  _betArcMax=total||15;
  _betArcTickSecs=secsLeft;
  _betArcTickTime=performance.now();
  _ensureBetArcSVG();
  if(!_betArcRaf)_betArcRaf=requestAnimationFrame(_betArcFrame);
}
function stopBetTimerArc(){
  if(_betArcRaf){cancelAnimationFrame(_betArcRaf);_betArcRaf=null;}
  _betArcTickTime=null;_betArcTickSecs=null;
  const svg=document.getElementById('bet-arc-svg');
  if(svg){svg.style.transition='opacity 0.4s';svg.style.opacity='0';setTimeout(()=>svg.remove(),420);}
}
function positionCountdownBorder(){_positionActionTimer();}
function autoPlayAction(sid,handIdx){
  if(!activeTurnSid||actionPending)return;
  if(autoplayOn){const gs=prevGs;const hand=gs?.splitActive?.[sid]?gs?.hands?.[sid]?.['hand'+(handIdx+1)]||[]:gs?.hands?.[sid]||[];doAction(score(hand)<autoplayThreshold?'hit':'stand');}
  else doAction('stand');
}

// ── Auto-play setting ──────────────────────────────────────────
const autoToggle=$('autoplay-toggle'),threshWrap=$('autoplay-threshold-wrap');
if(autoToggle){autoToggle.addEventListener('click',()=>{autoplayOn=!autoplayOn;autoToggle.classList.toggle('on',autoplayOn);if(threshWrap)threshWrap.style.display=autoplayOn?'flex':'none';sfxClick();});}
const betTimerToggle=$('bet-timer-toggle');
if(betTimerToggle){betTimerToggle.addEventListener('click',()=>{
  // Only host can toggle — check current known hostId
  if(!_isHost){return;}
  betTimerEnabled=!betTimerEnabled;
  betTimerToggle.classList.toggle('on',betTimerEnabled);
  socket.emit('setBetTimerEnabled',{enabled:betTimerEnabled});
});}
// Lock/unlock bet timer row based on host status
function syncBetTimerHostLock(isHost){
  const row=$('bet-timer-row');
  if(!row)return;
  if(isHost){row.classList.remove('host-locked-off');}
  else{row.classList.add('host-locked-off');}
}
$('autoplay-threshold')?.addEventListener('change',()=>{autoplayThreshold=parseInt($('autoplay-threshold').value)||17;});

// ── Settings ───────────────────────────────────────────────────
const volSlider=$('sfx-volume'),volLabel=$('sfx-volume-val');
if(volSlider){volSlider.addEventListener('input',()=>{sfxVolume=parseFloat(volSlider.value);if(volLabel)volLabel.textContent=Math.round(sfxVolume*100)+'%';sfxClick();});}
$('btn-save-name')?.addEventListener('click',()=>{const inp=$('settings-name-input'),newName=inp?.value.trim();if(!newName)return;myName=newName;saveName(newName);socket.emit('changeName',{name:newName});sfxClick();const msg=$('settings-name-msg');if(msg){msg.textContent='\u2713 Saved';msg.style.color='#ffd700';setTimeout(()=>msg.textContent='',2000);}});
$('btn-gear')?.addEventListener('click',()=>{const m=$('settings-modal');if(m){m.classList.toggle('hidden');const i=$('settings-name-input');if(i)i.value=myName;}sfxClick();});
$('settings-close')?.addEventListener('click',()=>{$('settings-modal')?.classList.add('hidden');sfxClick();});

// ── History tracking ───────────────────────────────────────────
function trackRound(gs,players){
  if(gs.gameStatus==='dealing'&&!currentRoundLog)currentRoundLog={time:new Date().toISOString(),roomCode,saved:false};
  if(gs.gameStatus==='game_over'&&currentRoundLog&&!currentRoundLog.saved){currentRoundLog.saved=true;buildAndSaveHistory(gs,players);currentRoundLog=null;}
  if(gs.gameStatus==='betting'&&currentRoundLog)currentRoundLog=null;
}
function buildAndSaveHistory(gs,players){
  const entry=buildRoundHistoryEntry(gs,players,mySocketId,roomCode);
  if(entry){pushRound(entry);}

}

// ── Render State ───────────────────────────────────────────────
function renderState(gs,players,hostId){
  // Betting phase reset — runs BEFORE chip rendering so re-render adds chips back correctly
  if(gs.gameStatus==='betting'){
    winOverlayShown=false;activeTurnSid=null;actionPending=false;
    bjSoundedSeats.clear();shownSideBetPills.clear();stopCountdown();
    hide('play-buttons');
    const db=$('btn-deal');if(db){db.disabled=false;db.style.opacity='1';db.textContent='DEAL';}
    document.querySelectorAll('.card,.card-back').forEach(c=>c.classList.add('fly-out'));
    stopDealCountdown();
    document.querySelectorAll('.circle-win-label,.win-chip-stack,.sidebet-win-pill,.seat-result-icon').forEach(e=>e.remove());
    stopBetTimerArc();
    document.querySelectorAll('.seat-bottom-ind').forEach(e=>{e.classList.add('hidden');e.innerHTML='';e.className='seat-bottom-ind hidden';});
    document.querySelectorAll('.chip-stack').forEach(e=>e.remove());
    Object.keys(_prevScores).forEach(k=>delete _prevScores[k]);
    Object.keys(_scoreOverride).forEach(k=>delete _scoreOverride[k]);
    Object.keys(_sindOverride).forEach(k=>delete _sindOverride[k]);
    _pendingCountdownSid=null;
    // Cancel any stale score animation tokens on all pills
    document.querySelectorAll('.score-display,.split-score').forEach(p=>{p._animTok=(p._animTok||0)+1;});
  }
  // Sync host status
  const isHostNow=(mySocketId===hostId);
  if(isHostNow!==_isHost){_isHost=isHostNow;syncBetTimerHostLock(_isHost);}
  // Sync bet timer toggle to server state (gs.betTimerEnabled)
  const btt=$('bet-timer-toggle');
  if(btt){const serverOn=gs.betTimerEnabled!==false;if(btt.classList.contains('on')!==serverOn)btt.classList.toggle('on',serverOn);betTimerEnabled=serverOn;}
  // Training mode banner — visible to ALL players when lab is active
  let tmBanner=document.getElementById('training-mode-banner');
  if(gs.isTrainingMode){
    if(!tmBanner){tmBanner=document.createElement('div');tmBanner.id='training-mode-banner';document.getElementById('game-container')?.appendChild(tmBanner);}
    tmBanner.textContent='⚠️ TRAINING MODE — FORCED CARDS ACTIVE';tmBanner.style.display='block';
  } else {
    if(tmBanner)tmBanner.style.display='none';
  }
  const pList=$('players-list');
  if(pList)pList.innerHTML=Object.entries(players).map(([id,p])=>`<div class="player-entry ${id===mySocketId?'me':''}${id===hostId?' host-player':''}" title="${id===hostId?'Host/Admin':'Player'}"><span class="pe-name">${id===hostId?'<span class="host-crown">👑</span> ':''}${p.name}${id===mySocketId?' <span class="you-tag">YOU</span>':''}</span><span class="pe-wallet">€${p.wallet.toLocaleString()}</span></div>`).join('');
  const me=players[mySocketId];
  if(me){myWallet=me.wallet;$('wallet-amount').textContent='\u20ac'+me.wallet.toLocaleString();$('hud-bet-amount').textContent='\u20ac'+(me.totalBet||0).toLocaleString();
    // Dim chips player can't afford
    document.querySelectorAll('.chip').forEach(c=>{const v=parseInt(c.dataset.value)||0;c.style.opacity=myWallet>=v?'1':'0.32';c.style.filter=myWallet>=v?'':'grayscale(0.5)';});
  }
  const status=gs.gameStatus;
  const mySeats=Object.entries(gs.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
  const bLocked=gs.betsLocked,isBetting=['betting','idle'].includes(status);
  const myHasBets=mySeats.some(s=>gs.bets[s]?.main>0);
  const canDeal=isBetting&&gs.activeSeats.length>0&&mySeats.length>0&&myHasBets;
  const myReady=Array.isArray(gs.readyPlayers)&&gs.readyPlayers.includes(mySocketId);
  if(canDeal)show('deal-btn-wrap');else hide('deal-btn-wrap');
  const db=$('btn-deal');if(db&&!myReady){db.disabled=false;db.style.opacity='1';if(!bLocked)db.textContent='DEAL';}
  const ct=$('chip-tray');if(ct){ct.classList.remove('hidden');if(isBetting)ct.classList.remove('tray-hidden');else ct.classList.add('tray-hidden');}
  // Dim chips the player can't afford
  document.querySelectorAll('.chip[data-value]').forEach(ch=>{
    const val=parseInt(ch.dataset.value)||0;
    ch.classList.toggle('chip-disabled',myWallet<val);
  });
  const ca=$('chip-action-floats');if(ca){if(isBetting)ca.classList.remove('hidden');else ca.classList.add('hidden');}
  if(bLocked){hide('btn-undo');hide('btn-rebet');hide('btn-2x');}
  else{if(isBetting)show('btn-undo');else hide('btn-undo');const hasLast=!!(gs.lastRoundBets?.[mySocketId]?.length);if(hasLast&&isBetting&&!myHasBets){show('btn-rebet');hide('btn-2x');}else{hide('btn-rebet');}if(myHasBets&&isBetting){show('btn-2x');hide('btn-rebet');}else if(!myHasBets||!isBetting){hide('btn-2x');}}
  const pb=$('play-buttons');
  if(pb){
    // Only hide when not in playing phase — yourTurn/doAction manage show/hide during playing
    if(status!=='playing') pb.classList.add('betting-hidden');
    // During playing phase, don't touch it — yourTurn adds/removes betting-hidden
  }
  for(let i=1;i<=5;i++)renderSeat(String(i),gs,players);
  renderDealer(gs);
  if(gs.gameStatus==='game_over'&&gs.grandTotal>0){const w=calcMyWinnings(gs);if(w>0)showWinOverlay(w);}
  updateStatusMsg(gs,players);
  renderAdminPanel(gs,players,hostId);
  if(mySocketId===hostId)renderDealLab(gs);
}
function calcMyWinnings(gs){let t=0;for(const [sid,oid] of Object.entries(gs.seatOwners||{})){if(oid!==mySocketId)continue;const b=gs.badges?.[sid]||[];const isBJPush=b.some(x=>x.cls==='bj')&&b.some(x=>x.cls==='push');if(isBJPush)t+=gs.bets[sid].main;else if(b.some(x=>x.cls==='bj'))t+=Math.floor(gs.bets[sid].main*2.5);else if(b.some(x=>x.cls==='win'))t+=gs.bets[sid].main*2;else if(b.some(x=>x.cls==='push'))t+=gs.bets[sid].main;if(gs.sideBetWins?.[sid]?.pp)t+=gs.sideBetWins[sid].pp.payout;if(gs.sideBetWins?.[sid]?.sp)t+=gs.sideBetWins[sid].sp.payout;}return t;}
function updateStatusMsg(gs,players){const el=$('status-message');if(!el)return;const st=gs.gameStatus;if(st==='betting'||st==='idle'){if(gs.betsLocked&&gs.readyPlayers?.length){const n=new Set(gs.activeSeats.map(s=>gs.seatOwners?.[s]).filter(Boolean)).size;el.textContent=`Waiting for all to deal\u2026 (${gs.readyPlayers.length}/${n})`;}else{const firstBettor=gs.betHistory?.length>0?players[gs.betHistory[0].socketId]?.name:null;el.textContent=Object.keys(gs.seatOwners||{}).length===0?'Click a seat to join!':'Place your bets';}}else if(st==='dealing')el.textContent='Dealing\u2026';else if(st==='playing'&&activeTurnSid){const oid=gs.seatOwners?.[activeTurnSid],pn=oid?players[oid]?.name:'?';el.textContent=(oid===mySocketId)?`Your turn \u2014 Seat ${activeTurnSid}`:`${pn}'s turn`;}else if(st==='dealer_turn')el.textContent='Dealer\u2019s turn\u2026';else if(st==='game_over')el.textContent='Round over \u2014 next round soon\u2026';}
function renderAdminPanel(gs,players,hostId){const canShow=mySocketId===hostId&&['betting','idle'].includes(gs.gameStatus);let panel=$('admin-panel');if(!canShow){if(panel)panel.remove();return;}if(!panel){panel=document.createElement('div');panel.id='admin-panel';const sc=$('settings-card');if(sc){const hr=document.createElement('hr');hr.style.cssText='border:none;border-top:1px solid rgba(255,255,255,0.1);margin:14px 0;';sc.insertBefore(hr,$('settings-close'));sc.insertBefore(panel,$('settings-close'));}else $('game-container')?.appendChild(panel);}const others=Object.entries(players).filter(([id])=>id!==mySocketId);if(!others.length){panel.innerHTML='<div class="admin-title" style="opacity:.4">No other players</div>';return;}panel.innerHTML=`<div class="admin-title">\ud83d\udc51 Kick Players</div>`+others.map(([id,p])=>`<div class="admin-row"><span class="admin-name">${p.name}</span><div class="admin-action-btns"><button class="admin-kick-btn" data-id="${id}">Kick</button><button class="admin-ban-btn" data-id="${id}">Ban</button></div></div>`).join('');panel.querySelectorAll('.admin-kick-btn').forEach(btn=>{btn.addEventListener('click',()=>{sfxClick();socket.emit('kickPlayer',{targetId:btn.dataset.id});});});
  panel.querySelectorAll('.admin-ban-btn').forEach(btn=>{btn.addEventListener('click',()=>{sfxClick();const name=btn.closest('.admin-row')?.querySelector('.admin-name')?.textContent||'this player';showConfirmModal(`Ban ${name}?`,`They won't be able to rejoin this room.`,'Ban','#ff9800',()=>socket.emit('banPlayer',{targetId:btn.dataset.id}));});});
}
let _dealLabOn=false;
function renderDealLab(gs){
  const sc=$('settings-card');if(!sc)return;
  // Build the panel once; afterwards only update seat pickers
  let lab=$('deal-lab');
  if(!lab){
    lab=document.createElement('div');lab.id='deal-lab';
    // Insert a divider then the panel before the Done button
    const hr=document.createElement('hr');hr.style.cssText='border:none;border-top:1px solid rgba(255,255,255,0.1);margin:14px 0;';
    sc.insertBefore(hr,$('settings-close'));
    sc.insertBefore(lab,$('settings-close'));
    // ── Build static structure ──
    const VALS=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    const SUITS=['S','H','D','C'];
    const SUIT_SYM={S:'♠',H:'♥',D:'♦',C:'♣'};
    const sel=(id,opts,sym)=>{const s=document.createElement('select');s.id=id;s.style.cssText='flex:1;background:#111;color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:4px 6px;font-family:Rajdhani,sans-serif;font-size:.82rem;';opts.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=sym?sym[v]:v;s.appendChild(o);});return s;};
    const row2=(a,b)=>{const r=document.createElement('div');r.style.cssText='display:flex;gap:6px;margin-bottom:2px;';r.appendChild(a);r.appendChild(b);return r;};
    const lbl=(t)=>{const d=document.createElement('div');d.style.cssText='font-size:.62rem;font-weight:700;letter-spacing:.1em;color:rgba(255,200,50,0.7);text-transform:uppercase;margin:6px 0 2px;';d.textContent=t;return d;};
    // Title + toggle row
    const hdr=document.createElement('div');hdr.style.cssText='display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;';
    const ttl=document.createElement('div');ttl.style.cssText='font-weight:700;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,0.5);';ttl.textContent='🃏 Deal Lab';
    const tog=document.createElement('div');tog.className='autoplay-toggle-btn';tog.id='deal-lab-toggle';tog.title='Enable forced dealing';
    tog.addEventListener('click',()=>{_dealLabOn=!_dealLabOn;tog.classList.toggle('on',_dealLabOn);socket.emit('dealLabToggle',{on:_dealLabOn});sfxClick();});
    hdr.appendChild(ttl);hdr.appendChild(tog);lab.appendChild(hdr);
    // Dealer pickers
    lab.appendChild(lbl('Dealer Face (visible)'));
    lab.appendChild(row2(sel('dl-d1-v',VALS),sel('dl-d1-s',SUITS,SUIT_SYM)));
    lab.appendChild(lbl('Dealer Hole (hidden)'));
    lab.appendChild(row2(sel('dl-d2-v',VALS),sel('dl-d2-s',SUITS,SUIT_SYM)));
    // Seat pickers container
    const seatsCont=document.createElement('div');seatsCont.id='dl-seats-cont';lab.appendChild(seatsCont);
    // Next-hit container
    const hitCont=document.createElement('div');hitCont.id='dl-hits-cont';lab.appendChild(hitCont);
    // Apply button
    const applyBtn=document.createElement('button');applyBtn.id='dl-apply';applyBtn.textContent='Apply & Arm';applyBtn.style.cssText='width:100%;padding:9px;background:linear-gradient(135deg,#b8860b,#6b4a08);color:#fff;border:none;border-radius:10px;font-family:Rajdhani,sans-serif;font-weight:700;font-size:.85rem;cursor:pointer;margin-top:8px;';
    applyBtn.addEventListener('click',()=>{
      if(!_dealLabOn){const msg=document.createElement('div');msg.style.cssText='color:#ef5350;font-size:.75rem;text-align:center;margin-top:4px;';msg.textContent='Enable Deal Lab switch first';applyBtn.after(msg);setTimeout(()=>msg.remove(),2000);return;}
      sfxClick();
      // Always read from prevGs (live state), not stale closure
      const curGs=prevGs;
      const gc=(v,s)=>({value:$(v)?.value||'A',suit:$(s)?.value||'S'});
      const forced={dealer:[gc('dl-d1-v','dl-d1-s'),gc('dl-d2-v','dl-d2-s')],seats:{},nextHit:{}};
      const liveSeats=Object.entries(curGs?.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
      liveSeats.forEach(sid=>{
        forced.seats[sid]=[gc('dl-s'+sid+'c1-v','dl-s'+sid+'c1-s'),gc('dl-s'+sid+'c2-v','dl-s'+sid+'c2-s')];
        forced.nextHit[sid]=gc('dl-s'+sid+'h-v','dl-s'+sid+'h-s');
      });
      socket.emit('forceDeck',forced);
      const msg=document.createElement('div');msg.style.cssText='color:#4caf50;font-size:.75rem;text-align:center;margin-top:6px;';msg.textContent='✓ Armed — applies to next deal';applyBtn.after(msg);setTimeout(()=>msg.remove(),3000);
    });
    lab.appendChild(applyBtn);
  }
  // Update seat pickers dynamically (seats may change each round)
  const VALS=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const SUITS=['S','H','D','C'];
  const SUIT_SYM={S:'♠',H:'♥',D:'♦',C:'♣'};
  const mySeats=Object.entries(gs.seatOwners||{}).filter(([,id])=>id===mySocketId).map(([s])=>s);
  const sc2=$('dl-seats-cont');const hc=$('dl-hits-cont');
  if(sc2&&hc){
    sc2.innerHTML='';hc.innerHTML='';
    const sel2=(id,opts,sym)=>{const s=document.createElement('select');s.id=id;s.style.cssText='flex:1;background:#111;color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:4px 6px;font-family:Rajdhani,sans-serif;font-size:.82rem;';opts.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=sym?sym[v]:v;s.appendChild(o);});return s;};
    const row3=(a,b)=>{const r=document.createElement('div');r.style.cssText='display:flex;gap:6px;margin-bottom:2px;';r.appendChild(a);r.appendChild(b);return r;};
    const lbl2=(t)=>{const d=document.createElement('div');d.style.cssText='font-size:.62rem;font-weight:700;letter-spacing:.1em;color:rgba(255,200,50,0.7);text-transform:uppercase;margin:6px 0 2px;';d.textContent=t;return d;};
    mySeats.forEach(sid=>{
      sc2.appendChild(lbl2('Seat '+sid+' Card 1'));sc2.appendChild(row3(sel2('dl-s'+sid+'c1-v',VALS),sel2('dl-s'+sid+'c1-s',SUITS,SUIT_SYM)));
      sc2.appendChild(lbl2('Seat '+sid+' Card 2'));sc2.appendChild(row3(sel2('dl-s'+sid+'c2-v',VALS),sel2('dl-s'+sid+'c2-s',SUITS,SUIT_SYM)));
      hc.appendChild(lbl2('Seat '+sid+' Next Hit'));hc.appendChild(row3(sel2('dl-s'+sid+'h-v',VALS),sel2('dl-s'+sid+'h-s',SUITS,SUIT_SYM)));
    });
  }
  // Sync toggle visual + local state from server
  if(gs.dealLabEnabled!==undefined&&gs.dealLabEnabled!==_dealLabOn){
    _dealLabOn=gs.dealLabEnabled;
  }
  const tog2=$('deal-lab-toggle');if(tog2)tog2.classList.toggle('on',_dealLabOn);
}

// ── Seat Rendering ─────────────────────────────────────────────
function renderSeat(sid,gs,players){
  const seatEl=$('seat-'+sid);if(!seatEl)return;
  const ownerId=gs.seatOwners?.[sid],isMine=ownerId===mySocketId;
  const ownerName=ownerId?players[ownerId]?.name:null;
  const isBetting=['betting','idle'].includes(gs.gameStatus);
  const mc=seatEl.querySelector('.bet-circle.main-bet');
  if(ownerId){seatEl.classList.add('my-seat');mc?.classList.add('claimed');}
  else{seatEl.classList.remove('my-seat');mc?.classList.remove('claimed');}
  // Gold ring + bobbing arrow only for seats I own
  seatEl.classList.toggle('my-seat-owned', isMine);
  let arr=seatEl.querySelector('.my-seat-arrow');
  if(isMine){if(!arr){arr=document.createElement('div');arr.className='my-seat-arrow';seatEl.appendChild(arr);}}
  else{arr?.remove();}
  // Tooltip: all seats show owner name on hover
  seatEl.title=ownerName?ownerName:'';
  const lb=seatEl.querySelector('.leave-seat-btn');
  if(lb){if(isMine&&isBetting)lb.classList.remove('hidden');else lb.classList.add('hidden');}
  const nt=seatEl.querySelector('.seat-name-tag');
  if(nt){
    if(ownerName){
      const isInsured=Array.isArray(gs.insuredSeats)&&gs.insuredSeats.includes(sid);
      nt.textContent=(isInsured?'🛡 ':'')+ownerName;
      // Show name in betting + dealing; hide once playing starts (score pill takes over top-right)
      const showName=isBetting||gs.gameStatus==='dealing';
      nt.classList.toggle('hidden',!showName);
      // No yellow bg/border — plain subtle style
      nt.style.background='rgba(0,0,0,0)';
      nt.style.border='none';
      nt.style.color='rgba(255,255,255,0.75)';
    }else nt.classList.add('hidden');
  }
  for(const t of ['main','pp','sp'])renderCircle(sid,t,gs,isMine&&isBetting);
  renderHand(sid,gs);renderScore(sid,gs);renderBadges(sid,gs);renderBust(sid,gs);
  renderSeatIndicator(sid,gs,players);
  // Only show active-turn outline during play phase, not betting
  seatEl.classList.toggle('active-turn', activeTurnSid===sid && !isBetting);
  if(isBetting){
    seatEl.querySelectorAll('.circle-win-label,.win-chip-stack').forEach(e=>e.remove());
    seatEl.classList.remove('insurance-highlight');
  }
}
function renderSeatIndicator(sid,gs,players){
  const seatEl=$('seat-'+sid);if(!seatEl)return;
  const ownerId=gs.seatOwners?.[sid];
  const isBetting=['betting','idle'].includes(gs.gameStatus);
  const ind=$('sind-'+sid);if(!ind)return;
  // Insurance phase: show shield prompt on current insurance seat (visible to all)
  if(gs.insurancePhase&&gs.insuranceCurrentSid===sid&&ownerId){
    if(!_sindOverride[sid]?.active){
      ind.className='seat-bottom-ind sind-action-overlay';
      ind.style.background='linear-gradient(145deg,#7b5e00,#3d2e00)';
      ind.style.boxShadow='0 4px 14px rgba(232,160,32,0.5)';
      ind.innerHTML='<svg viewBox="0 0 28 32" fill="none" width="18" height="22"><path d="M14 1.5L26 6.5L26 17C26 24.5 14 30.5 14 30.5C14 30.5 2 24.5 2 17L2 6.5Z" fill="rgba(232,160,32,0.25)" stroke="#e8a020" stroke-width="1.8"/><text x="14" y="21" text-anchor="middle" font-size="10" font-weight="900" fill="#e8a020" font-family="Rajdhani,sans-serif">?</text></svg>';
      ind.classList.remove('hidden');
    }
    return;
  }
  // Clear insurance style if it was set
  if(ind.style.background&&!_sindOverride[sid]?.active){ind.style.background='';ind.style.boxShadow='';}
  // Betting: hide indicator, show name tag
  if(isBetting||!ownerId){ind.className='seat-bottom-ind hidden';ind.innerHTML='';return;}
  const hand=Array.isArray(gs.hands?.[sid])?gs.hands[sid]:[];
  if(gs.gameStatus==='game_over'){
    const badges=gs.badges?.[sid]||[];
    if(!badges.length){ind.className='seat-bottom-ind hidden';ind.innerHTML='';return;}
    // Helper: build one result cell
    const mkResultCell=(cls,content,extra='')=>`<div class="sind-cell ${cls}${extra}">${content}</div>`;
    const PUSH_SVG='<svg viewBox="0 0 28 28" fill="none" width="26" height="26"><path d="M8 18V10M8 10L5 13M8 10L11 13" stroke="#e8a020" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 10v8M20 18L17 15M20 18L23 15" stroke="#e8a020" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    // Insurance indicator: show golden shield if insured and dealer had BJ
    const dBJ=isNaturalBJ(gs.hands?.dealer||[])&&gs.dealerRevealed;
    const wasInsured=Array.isArray(gs.insuredSeats)&&gs.insuredSeats.includes(sid);
    if(dBJ&&wasInsured){
      // Dealer BJ, I was insured — show golden shield in indicator
      ind.className='seat-bottom-ind sind-insured';
      ind.innerHTML='<svg viewBox="0 0 40 46" fill="none" width="18" height="20"><path d="M20 2 L37 9 L37 24 C37 35 20 44 20 44 C20 44 3 35 3 24 L3 9 Z" fill="rgba(232,160,32,0.25)" stroke="#e8a020" stroke-width="2"/><polyline points="12,23 18,30 29,17" stroke="#e8a020" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
      ind.classList.remove('hidden');return;
    }
    if(gs.splitActive?.[sid]){
      // Per-hand results: badges[0]=hand1, badges[1]=hand2
      const b1=badges[0]||{};const b2=badges[1]||{};
      const cellFor=(b)=>{
        const isBJ=b.cls==='bj';
        const isWin=b.cls==='win'||isBJ;
        const isPush=b.cls==='push';
        if(isBJ)return mkResultCell('sind-cell sind-result-win','<span>BJ</span>');
        if(isWin)return mkResultCell('sind-cell sind-result-win','🏅');
        if(isPush)return mkResultCell('sind-cell sind-result-push',PUSH_SVG);
        return mkResultCell('sind-cell sind-result-lose','<span style="filter:grayscale(1);opacity:0.65;font-size:1rem;">✖</span>');
      };
      ind.className='seat-bottom-ind sind-split';
      ind.innerHTML=cellFor(b2)+cellFor(b1); // H2 left, H1 right
      ind.classList.remove('hidden');
    } else {
      const hasBJ=badges.some(b=>b.cls==='bj');
      const hasWin=badges.some(b=>b.cls==='win')||hasBJ;
      const hasPush=badges.some(b=>b.cls==='push');
      const hasLose=badges.some(b=>b.cls==='lose');
      ind.innerHTML='';ind.className='seat-bottom-ind';
      if(hasBJ&&hasPush){ind.classList.add('sind-push');ind.innerHTML='<span style="font-family:Rajdhani,sans-serif;font-weight:900;font-size:.75rem;color:#e8a020;">BJ</span>'+PUSH_SVG;}
      else if(hasBJ){ind.classList.add('sind-win');ind.innerHTML='<span>BJ</span>';}
      else if(hasWin){ind.classList.add('sind-win');ind.innerHTML='🏅';}
      else if(hasPush){ind.classList.add('sind-push');ind.innerHTML=PUSH_SVG;}
      else if(hasLose){ind.classList.add('sind-lose');ind.innerHTML='<span style="filter:grayscale(1);opacity:0.7;font-size:1.1rem;">✖</span>';}
      else{ind.className='seat-bottom-ind hidden';return;}
      ind.classList.remove('hidden');
    }
    return;
  }
  // Dealing / playing / dealer_turn: show live score in bottom slot
  if(!hand.length&&!gs.splitActive?.[sid]){ind.className='seat-bottom-ind hidden';ind.innerHTML='';return;}
  // If action override active, trigger restore so new score shows immediately
  if(_sindOverride[sid]?.active){_sindOverride[sid].restore?.();}

  // Helper to render a single score cell
  const mkScoreCell=(h,extraClass='')=>{
    const isBust=score(h)>21;
    const isBJHand=isNaturalBJ(h)&&!gs.splitActive?.[sid];
    const stood=gs.stoodSeats?.includes(sid);
    if(isBust) return `<div class="sind-cell sind-score sind-bust${extraClass}"><span style="filter:grayscale(1);opacity:0.6;">💥</span></div>`;
    if(isBJHand) return `<div class="sind-cell sind-score sind-bj${extraClass}"><span>BJ</span></div>`;
    const val=scoreLabel(h,stood);
    return `<div class="sind-cell sind-score${extraClass}"><span>${val}</span></div>`;
  };

  if(gs.splitActive?.[sid]){
    // Two cells side-by-side: H2 left, H1 right
    const h2=gs.hands?.[sid]?.hand2||[];
    const h1=gs.hands?.[sid]?.hand1||[];
    ind.className='seat-bottom-ind sind-split';
    ind.innerHTML=mkScoreCell(h2,' h2-cell')+mkScoreCell(h1,' h1-cell');
    ind.classList.remove('hidden');
  } else {
    ind.className='seat-bottom-ind sind-score';
    const isBust=score(hand)>21;
    const isBJHand=isNaturalBJ(hand)&&!gs.splitActive?.[sid];
    if(isBust){ind.classList.add('sind-bust');ind.innerHTML='<span style="filter:grayscale(1);opacity:0.6;">💥</span>';}
    else if(isBJHand){ind.classList.add('sind-bj');ind.innerHTML='<span>BJ</span>';}
    else{const stood=gs.stoodSeats?.includes(sid);const val=scoreLabel(hand,stood);ind.innerHTML=`<span>${val}</span>`;}
    ind.classList.remove('hidden');
  }
}
function renderCircle(sid,type,gs,canBet){
  const circle=document.querySelector(`.bet-circle[data-seat="${sid}"][data-type="${type}"]`);if(!circle)return;
  const amt=gs.bets?.[sid]?.[type]||0;circle.onclick=null;
  const ba=['betting','idle'].includes(gs.gameStatus)&&!gs.betsLocked;
  // Lock side bet circles until mainbet is placed on this seat
  const mainAmt=gs.bets?.[sid]?.main||0;
  if(type!=='main'){
    const noMain=mainAmt===0;
    circle.classList.toggle('sidebet-locked',noMain);
    if(noMain){circle.onclick=null;return;}
    else circle.classList.remove('sidebet-locked');
  }
  if(ba){if(type==='main'){const oid=gs.seatOwners?.[sid];if(!oid)circle.onclick=()=>{sfxClick();socket.emit('claimSeat',{sid});};else if(oid===mySocketId)circle.onclick=()=>{sfxChip();const amt=bestChip(selectedChip);if(amt>0)socket.emit('placeBet',{sid,type:'main',amt});};}else if(gs.seatOwners?.[sid]===mySocketId){circle.onclick=()=>{sfxChip();const amt=bestChip(selectedChip);if(amt>0)socket.emit('placeBet',{sid,type,amt});};}else if(!gs.seatOwners?.[sid]){circle.onclick=()=>{sfxClick();socket.emit('claimSeat',{sid});};}}
  // Don't clear the win pill if it's already showing (let its own timeout handle removal)
  circle.querySelectorAll('.chip-stack').forEach(e=>e.remove());
  if(!circle.querySelector('.sidebet-win-pill'))circle.querySelectorAll('.sidebet-win-pill').forEach(e=>e.remove());
  const wk=type==='pp'?'pp':'sp',wd=gs.sideBetWins?.[sid]?.[wk];
  if(wd&&type!=='main'){renderSideBetWinPill(circle,wd,`${sid}_${type}`,gs.gameStatus);return;}
  const isPlaying=['playing','dealer_turn','game_over'].includes(gs.gameStatus);
  if(amt>0){
    // During split, main-bet chip is shown in split-chips-row instead
    if(type==='main'&&gs.splitActive?.[sid]){circle.style.opacity='0';circle.classList.remove('has-bet');}
    else{
      renderChipStack(circle,amt,type==='main');
      if(type!=='main'&&isPlaying){
        const wk2=type==='pp'?'pp':'sp';
        const won=!!(gs.sideBetWins?.[sid]?.[wk2]);
        circle.style.opacity=won?'1':'0.25';
      } else {circle.style.opacity='';}
    }
  } else {
    circle.style.opacity='';
  }
  circle.classList.toggle('has-bet',amt>0);
}
function renderSideBetWinPill(circle,wd,pillKey,gsStatus){
  // Always render the winning chip stack
  renderChipStack(circle,wd.payout,false,true);
  circle.classList.add('has-bet');
  // Show the bouncing mult:1 pill only once, and only after playing phase begins
  if(pillKey&&!shownSideBetPills.has(pillKey)&&(['playing','dealer_turn','game_over'].includes(gsStatus)||window._gsInsurancePhase)){
    shownSideBetPills.add(pillKey);
    const pill=document.createElement('div');pill.className='sidebet-win-pill';pill.textContent=`${wd.mult}:1`;
    circle.appendChild(pill);
    setTimeout(()=>{if(pill.parentNode)pill.remove();},3000);
  }
}
function renderChipStack(circle,amt,isMain,isGold=false){
  const denom=[10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];const chips=[];let rem=amt;
  for(const d of denom){while(rem>=d&&chips.length<8){chips.push(d);rem-=d;}if(chips.length>=8)break;}
  const chipW=isMain?56:36,offsetY=isMain?4:3;
  const stack=document.createElement('div');stack.className='chip-stack';
  chips.forEach((val,i)=>{let c1,c2;if(isGold){c1='#ffe066';c2='#c8900a';}else{const cols=CHIP_COLORS[val]||'#888,#444';[c1,c2]=cols.split(',');}const chip=document.createElement('div');chip.className='stacked-chip';chip.style.cssText=`width:${chipW}px;height:${chipW}px;background:radial-gradient(circle at 35% 35%,${c1},${c2});bottom:${4+i*offsetY}px;left:50%;transform:translateX(-50%);`;stack.appendChild(chip);});
  const topBottom=4+(chips.length-1)*offsetY;const lbl=document.createElement('div');lbl.className='chip-stack-amt';if(isGold)lbl.style.color='#ffd700';lbl.style.bottom=(topBottom+chipW/2-9)+'px';lbl.style.top='auto';lbl.textContent=fmt(amt);stack.appendChild(lbl);circle.appendChild(stack);
}
function ensureSplitBetCircle(seatEl,sid,gs){
  // Remove old single split-bet-circle (replaced by split-chips-row)
  seatEl.querySelector('.split-bet-circle')?.remove();
  // Also hide the main-bet circle chips during split (shown in split-chips-row instead)
  const splitHandWrap=seatEl.querySelector('.split-hands');
  let row=seatEl.querySelector('.split-chips-row');
  if(!gs.splitActive?.[sid]){
    row?.remove();
    // Restore main-bet circle opacity
    seatEl.querySelector('.bet-circle.main-bet')?.style.setProperty('opacity','');
    return;
  }
  if(!splitHandWrap)return;
  if(!row){
    row=document.createElement('div');row.className='split-chips-row';
    // Insert into seat element directly, after the player-hand div, before betting-circles
    const playerHand=seatEl.querySelector('.player-hand');
    const bettingCircles=seatEl.querySelector('.betting-circles');
    if(bettingCircles){seatEl.insertBefore(row,bettingCircles);}
    else if(playerHand){playerHand.after(row);}
    else{seatEl.appendChild(row);}
  }
  row.innerHTML='';
  // Left slot = hand2 bet (splitBets), Right slot = hand1 bet (bets.main)
  const h2Amt=gs.splitBets?.[sid]||0;
  const h1Amt=gs.bets?.[sid]?.main||0;
  const mkSlot=(amt,label)=>{
    const slot=document.createElement('div');slot.className='split-chip-slot';
    const lbl=document.createElement('div');lbl.className='split-chip-label';lbl.textContent=label;
    slot.appendChild(lbl);
    if(amt>0){const circ=document.createElement('div');circ.className='split-bet-circle';renderChipStack(circ,amt,true);slot.appendChild(circ);}
    return slot;
  };
  row.appendChild(mkSlot(h2Amt,'H2'));
  row.appendChild(mkSlot(h1Amt,'H1'));
}
function renderHand(sid,gs){
  const el=$('hand-'+sid);if(!el)return;
  if(gs.splitActive?.[sid]){
    let wrap=el.querySelector('.split-hands');
    if(!wrap||el.querySelector('.card:not(.split-hands *)')){el.innerHTML='';el.classList.add('split-mode');wrap=document.createElement('div');wrap.className='split-hands';el.appendChild(wrap);}
    // Display order: hand2 (left, idx=0), hand1 (right, idx=1)
    // Server: splitHandIndex 0=hand1, handIdx 0=hand1
    // So hand1 is active when handIdx===0, hand2 when handIdx===1
    const iHA_h1=activeTurnSid===sid&&activeTurnHandIdx===0; // hand1 active
    const iHA_h2=activeTurnSid===sid&&activeTurnHandIdx===1; // hand2 active
    ['hand2','hand1'].forEach((hk,idx)=>{
      const h=gs.hands?.[sid]?.[hk]||[];
      // isActive: hand1→splitHandIndex===0, hand2→splitHandIndex===1
      const hkIdx=hk==='hand1'?0:1;
      const isActive=hkIdx===(gs.splitHandIndex?.[sid]||0);
      let col=wrap.querySelector(`.split-col[data-hk="${hk}"]`);
      if(!col){col=document.createElement('div');col.dataset.hk=hk;wrap.appendChild(col);const sp=document.createElement('div');sp.className='score-display split-score';sp.id=`score-${sid}-${hk}`;sp.innerHTML='<span class="bust-num"></span><span class="bust-icon">\ud83d\udca5</span>';sp.classList.add('hidden');const hd=document.createElement('div');hd.className='split-hand';hd.dataset.hk=hk;const ind=document.createElement('div');ind.className='split-indicator';col.appendChild(ind);col.appendChild(sp);col.appendChild(hd);}
      col.className=`split-col${isActive?' active-split-col':''}`;col.classList.toggle('active-turn-hand',hk==='hand1'?iHA_h1:iHA_h2);
      const hd=col.querySelector('.split-hand');if(hd){const ex=hd.querySelectorAll('.card').length;h.slice(ex).forEach(c=>{sfxCard();hd.appendChild(mkCard(c,true));});}
      const pill=col.querySelector('.split-score');
      if(pill){if(!(pill.classList.contains('busted')&&pill.classList.contains('show-icon'))){const stood=gs.stoodSeats?.includes(sid);const sv=scoreLabel(h,stood&&idx===(gs.splitHandIndex?.[sid]||0));animateScoreUpdate(pill,sv);if(h.length)pill.classList.remove('hidden');else pill.classList.add('hidden');if(score(h)>21){pill.classList.add('busted');setTimeout(()=>pill.classList.add('show-icon'),800);}else pill.classList.remove('busted','show-icon');}}
    });
    const seatEl=$('seat-'+sid);if(seatEl)ensureSplitBetCircle(seatEl,sid,gs);
  } else {
    const seatEl=$('seat-'+sid);if(seatEl)ensureSplitBetCircle(seatEl,sid,gs);
    el.classList.remove('split-mode');const hand=Array.isArray(gs.hands?.[sid])?gs.hands[sid]:[];const ex=el.querySelectorAll(':scope > .card').length;
    if(hand.length<ex){el.innerHTML='';hand.forEach(c=>el.appendChild(mkCard(c,false)));}
    else{hand.slice(ex).forEach(c=>{sfxCard();el.appendChild(mkCard(c,true));});}
    el.querySelector('.split-hands')?.remove();
  }
}
function animateScoreUpdate(pill,newVal){
  const bn=pill.querySelector('.bust-num');if(!bn)return;
  if(pill.classList.contains('busted'))return;
  const id=pill.id;
  const ovr=_scoreOverride[id];
  const strVal=String(newVal);
  if(ovr){
    _prevScores[id]=newVal; // always track latest
    // For hit/double: once value changes (card arrived), clear override and show new value
    if(ovr.text!=='−'&&ovr.baseVal!==undefined&&strVal!==String(ovr.baseVal)){
      delete _scoreOverride[id];
      pill._animTok=(pill._animTok||0)+1;
      const freshBn2=pill.querySelector('.bust-num');
      if(freshBn2){freshBn2.style.transition='none';freshBn2.style.opacity='1';freshBn2.textContent=strVal;}
    }
    return;
  }
  _prevScores[id]=newVal;
  // Just set the value directly — no hiding, no opacity tricks during gameplay
  bn.style.transition='none';bn.style.opacity='1';
  bn.textContent=strVal;
}
function renderScore(sid,gs){
  const el=$('score-'+sid);if(!el)return;
  if(gs.splitActive?.[sid]){el.classList.add('hidden');return;}
  const hand=Array.isArray(gs.hands?.[sid])?gs.hands[sid]:[];
  if(!hand.length){el.classList.add('hidden');return;}
  const stood=gs.stoodSeats?.includes(sid);
  if(isNaturalBJ(hand)&&!gs.splitActive?.[sid]){
    if(_prevScores[el.id]!=='BJ'){
      el.className='score-display bj-score';
      if(!el.querySelector('.bust-num')){el.innerHTML='<span class="bust-num"></span><span class="bust-icon">\ud83d\udca5</span>';}
      const bnBJ=el.querySelector('.bust-num');if(bnBJ){bnBJ.className='bust-num bj-text';bnBJ.style.transition='none';bnBJ.style.opacity='1';bnBJ.textContent='BJ';}
      el.classList.remove('hidden','busted','show-icon');_prevScores[el.id]='BJ';
    }return;
  }
  // If already showing bust icon, freeze and do not update
  if(el.classList.contains('busted')&&el.classList.contains('show-icon'))return;
  el.className='score-display';const newVal=scoreLabel(hand,stood);
  // Ensure inner structure exists (created once, never rebuilt)
  if(!el.querySelector('.bust-num')){el.innerHTML='<span class="bust-num"></span><span class="bust-icon">\ud83d\udca5</span>';}
  // Clear any bj-text styling without rebuilding
  const bjSpan=el.querySelector('.bj-text');if(bjSpan){bjSpan.className='bust-num';bjSpan.style.color='';}
  el.classList.remove('hidden');animateScoreUpdate(el,newVal);
  if(score(hand)>21){el.classList.add('busted');setTimeout(()=>el.classList.add('show-icon'),800);}else el.classList.remove('busted','show-icon');
}
function renderBust(sid,gs){if(!gs.bustSeats)return;if(Object.keys(gs.bustSeats).some(k=>k.startsWith(sid))&&!gs.splitActive?.[sid]){const el=$('score-'+sid);if(el){el.classList.add('busted');setTimeout(()=>el.classList.add('show-icon'),800);}}}
function renderBadges(sid,gs){
  const seatEl=$('seat-'+sid);if(!seatEl)return;
  seatEl.querySelectorAll('.result-badge').forEach(b=>b.remove());
  const badges=gs.badges?.[sid]||[],seen=new Set();
  for(const b of badges){if(seen.has(b.cls))continue;seen.add(b.cls);if(b.cls==='bj'&&gs.gameStatus==='game_over'&&gs.seatOwners?.[sid]===mySocketId&&!bjSoundedSeats.has(sid)){const bjPush=badges.some(x=>x.cls==='push');if(!bjPush)sfxWin();bjSoundedSeats.add(sid);}if(b.cls==='win'&&gs.gameStatus==='game_over'&&gs.seatOwners?.[sid]===mySocketId)sfxWin();if(b.cls==='lose'&&b.text==='Bust')sfxBust();}
  // No text labels — show winnings as extra chips on the main-bet circle
  const mc=seatEl.querySelector('.bet-circle.main-bet');if(!mc)return;
  mc.querySelectorAll('.circle-win-label').forEach(e=>e.remove());
  if(gs.gameStatus!=='game_over'||!badges.length)return;
  const hasBJ=badges.some(b=>b.cls==='bj'),hasWin=badges.some(b=>b.cls==='win'),hasPush=badges.some(b=>b.cls==='push');
  const main=gs.bets?.[sid]?.main||0;
  if(!main)return;
  // Calculate profit amount to show as extra chips
  let totalPayout=0,isGold=false;
  if(hasBJ&&hasPush){return;}                                // BJ vs dealer BJ = push, chips unchanged
  if(hasBJ){totalPayout=Math.floor(main*2.5);isGold=true;}  // BJ wins 3:2
  else if(hasWin){totalPayout=main*2;}                       // Win pays 2x total
  else if(hasPush){return;}                                  // Push: chips unchanged
  // else lose: nothing to show
  if(totalPayout<=0)return;
  // Replace the entire chip stack with the total payout amount
  mc.querySelectorAll('.chip-stack').forEach(e=>e.remove());
  renderPayoutChips(mc,totalPayout,isGold);
}

function renderPayoutChips(circle,amt,isGold){
  const denom=[10000,5000,2000,1000,500,200,100,50,25,10,5,2,1];
  const chips=[];let rem=amt;
  for(const d of denom){while(rem>=d&&chips.length<8){chips.push(d);rem-=d;}if(chips.length>=8)break;}
  const chipW=56,offsetY=4;
  const stack=document.createElement('div');stack.className='chip-stack win-chip-stack';
  chips.forEach((val,i)=>{
    let c1,c2;
    if(isGold){c1='#ffe066';c2='#c8900a';}
    else{const cols=CHIP_COLORS[val]||'#888,#444';[c1,c2]=cols.split(',');}
    const chip=document.createElement('div');chip.className='stacked-chip';
    chip.style.cssText=`width:${chipW}px;height:${chipW}px;background:radial-gradient(circle at 35% 35%,${c1},${c2});bottom:${4+i*offsetY}px;left:50%;transform:translateX(-50%);`;
    stack.appendChild(chip);
  });
  const topY=4+(chips.length-1)*offsetY;
  const lbl=document.createElement('div');lbl.className='chip-stack-amt';
  if(isGold)lbl.style.color='#ffd700';
  lbl.style.bottom=(topY+chipW/2-9)+'px';lbl.style.top='auto';
  lbl.textContent=fmt(amt);
  stack.appendChild(lbl);
  circle.appendChild(stack);
}

// ── Card Factory ───────────────────────────────────────────────
function mkCard(c,animate){
  const div=document.createElement('div');div.className='card'+(animate?' card-deal-anim':'');if(!animate)div.style.animation='none';
  const code=(c.value==='10'?'0':c.value)+c.suit;const url=`https://deckofcardsapi.com/static/img/${code}.png`;
  div.style.backgroundImage=`url(${url})`;div.style.backgroundSize='100% 100%';div.style.backgroundColor='#fff';
  const probe=new Image();probe.onerror=()=>{div.style.backgroundImage='none';div.style.display='flex';div.style.alignItems='center';div.style.justifyContent='center';div.style.fontSize='1rem';div.style.fontWeight='700';div.style.color=suitIsRed(c.suit)?'#c00':'#111';div.textContent=cardStr(c);};probe.src=url;
  return div;
}
function renderDealer(gs){
  const el=$('dealer-hand');if(!el)return;const hand=gs.hands?.dealer||[];const wasHidden=el.querySelector('.card-back');
  if(gs.dealerRevealed&&wasHidden){
    // Flip the hidden card with animation, then show face
    const holeSlot=wasHidden;
    sfxFlip();
    holeSlot.classList.add('card-flip-anim');
    setTimeout(()=>{
      el.innerHTML='';
      hand.forEach((c,i)=>{
        const card=mkCard(c,false);
        // The hole card (index 1) gets a subtle entrance
        if(i===1)card.classList.add('card-deal-anim');
        el.appendChild(card);
      });
    },300); // flip mid-point at 300ms
  }
  else if(!gs.dealerRevealed){const ex=el.querySelectorAll('.card,.card-back').length;if(hand.length<ex){el.innerHTML='';}else{hand.slice(ex).forEach((c,i)=>{if(ex+i===1){const b=document.createElement('div');b.className='card-back card-deal-anim';el.appendChild(b);}else el.appendChild(mkCard(c,true));});}}
  else{const ex=el.querySelectorAll('.card,.card-back').length;hand.slice(ex).forEach(c=>el.appendChild(mkCard(c,true)));}
  const sc=$('dealer-score');if(sc&&hand.length>0){
    const dh=gs.dealerRevealed?hand:[hand[0]],ds=score(dh);
    const dealerBJ=gs.dealerRevealed&&isNaturalBJ(hand);
    const label=dealerBJ?'BJ':String(ds);
    if(!sc.querySelector('.bust-num')){sc.innerHTML='<span class="bust-num"></span><span class="bust-icon">\ud83d\udca5</span>';}
    const bn=sc.querySelector('.bust-num');if(bn)bn.textContent=label;
    if(dealerBJ){sc.className='score-display bj-score';bn&&(bn.className='bust-num bj-text');}
    else{sc.className='score-display';bn&&(bn.className='bust-num');}
    sc.classList.remove('hidden');
    if(gs.dealerRevealed&&ds>21){sc.classList.add('busted');setTimeout(()=>sc.classList.add('show-icon'),800);}
    else sc.classList.remove('busted','show-icon');
  }else if(sc)sc.classList.add('hidden');
}

// ── Play Buttons ───────────────────────────────────────────────
function showPlayButtons(sid,handIdx){
  const gs=prevGs;if(!gs)return;
  const hand=gs.splitActive?.[sid]?gs.hands?.[sid]?.['hand'+(handIdx+1)]||[]:gs.hands?.[sid]||[];
  const isSplitAces=gs.splitFromAces?.[sid]===true;
  const betForHand = gs.splitActive?.[sid]
    ? (activeTurnHandIdx===0 ? gs.bets?.[sid]?.main : gs.splitBets?.[sid]||gs.bets?.[sid]?.main)||0
    : gs.bets?.[sid]?.main||0;
  const handKey = gs.splitActive?.[sid] ? 'hand'+(activeTurnHandIdx+1) : null;
  const alreadyDoubled = handKey ? (gs.doubledHands?.[sid]?.[handKey]||false) : (gs.doubled?.[sid]||false);
  const canDouble=hand.length===2&&myWallet>=betForHand&&!alreadyDoubled;
  const canSplit=hand.length===2&&!gs.splitActive?.[sid]&&cardNum(hand[0])===cardNum(hand[1])&&myWallet>=(gs.bets?.[sid]?.main||0);
  const dbl=$('btn-double'),spl=$('btn-split'),hit=$('btn-hit'),std=$('btn-stand');
  // Layout: double(left-flank) | hit | stand | split(right-flank)
  // Use CSS order to keep hit/stand always centered regardless of which flanks are visible
  if(dbl){dbl.classList.toggle('hidden',!canDouble||isSplitAces);dbl.style.order=(canDouble&&!isSplitAces)?'1':'0';}
  // Split aces: hide hit button entirely
  if(hit){hit.classList.toggle('hidden',isSplitAces);hit.style.order='2';
    // Show 2× on hit button icon when this seat has been doubled
    const isDoubled=gs.doubled?.[sid]===true;
    const icon=hit.querySelector('.cubic-icon');if(icon)icon.textContent=isDoubled?'2×':'+';
  }
  if(std)std.style.order='3';
  if(spl){spl.classList.toggle('hidden',!canSplit);spl.style.order=canSplit?'4':'0';}
  // Symmetry spacer: if double visible but split not (or vice versa), add invisible placeholder
  document.getElementById('pb-spacer-right')?.remove();
  document.getElementById('pb-spacer-left')?.remove();
  const pb=$('play-buttons');
  if(pb&&canDouble&&!canSplit){const sp=document.createElement('div');sp.id='pb-spacer-right';sp.style.cssText='width:86px;height:86px;order:4;flex-shrink:0;';pb.appendChild(sp);}
  if(pb&&canSplit&&!canDouble){const sp=document.createElement('div');sp.id='pb-spacer-left';sp.style.cssText='width:86px;height:86px;order:1;flex-shrink:0;';pb.prepend(sp);}
  ['btn-hit','btn-stand','btn-double','btn-split'].forEach(id=>{const b=$(id);if(b)b.disabled=false;});
  const pbEl=$('play-buttons');if(pbEl){pbEl.classList.remove('betting-hidden');pbEl.classList.remove('hidden');}actionPending=false;setTimeout(positionCountdownBorder,50);
}
function doAction(action){
  if(!activeTurnSid||actionPending)return;
  actionPending=true;
  _countdownGen++;_pendingCountdownSid=null;
  stopCountdown();
  ['btn-hit','btn-stand','btn-double','btn-split'].forEach(id=>{const b=$(id);if(b)b.disabled=true;});
  const pb=$('play-buttons');
  if(action==='hit'||action==='double')sfxHit();
  else if(action==='stand')sfxStand();
  if(action==='double')setTimeout(()=>sfxChipStack(3),120); // chips doubling
  if(action==='split')setTimeout(()=>sfxChipStack(4),150);  // chips splitting
  // Override the sind-N indicator with colored action symbol
  {
    const gs=prevGs;
    const sid=activeTurnSid;
    // Build override content based on action
    const SPLIT_SVG='<svg width="22" height="16" viewBox="0 0 28 20" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="10,4 2,10 10,16"/><polyline points="18,4 26,10 18,16"/></svg>';
    const overrideHTML=
      action==='hit'  ?'<span class="sind-action-sym sind-action-hit">+</span>':
      action==='stand'?'<span class="sind-action-sym sind-action-stand">−</span>':
      action==='double'?'<span class="sind-action-sym sind-action-double">2×</span>':
      action==='split' ?SPLIT_SVG:null;
    if(overrideHTML){
      const ind=$('sind-'+sid);
      if(ind&&!ind.classList.contains('sind-bust')){
        const tok=((_sindOverride[sid]?.tok)||0)+1;
        if(_sindOverride[sid]?.timer)clearTimeout(_sindOverride[sid].timer);
        const shownAt=Date.now();
        _sindOverride[sid]={tok,active:true,shownAt};
        // Save current class/html for restore
        const savedClass=ind.className;const savedHTML=ind.innerHTML;
        // Apply action style
        ind.className='seat-bottom-ind sind-action-overlay';
        ind.innerHTML=overrideHTML;
        // Restore after 1.5s MAX or when animateScoreUpdate fires — min 1s enforced
        const timer=setTimeout(()=>{
          if(_sindOverride[sid]?.tok!==tok)return;
          delete _sindOverride[sid];
          ind.className=savedClass;ind.innerHTML=savedHTML;
        },1500);
        _sindOverride[sid].timer=timer;
        _sindOverride[sid].restore=()=>{
          if(_sindOverride[sid]?.tok!==tok)return;
          const elapsed=Date.now()-(_sindOverride[sid].shownAt||0);
          const remaining=Math.max(0,1000-elapsed); // enforce 1s minimum
          if(remaining>0){
            setTimeout(()=>{
              if(_sindOverride[sid]?.tok!==tok)return;
              delete _sindOverride[sid];clearTimeout(timer);
              ind.className=savedClass;ind.innerHTML=savedHTML;
            },remaining);
          }else{
            delete _sindOverride[sid];clearTimeout(timer);
            ind.className=savedClass;ind.innerHTML=savedHTML;
          }
        };
      }
    }
  }
  // Fade out buttons over 1s
  if(pb){pb.style.transition='opacity 1s ease';pb.style.opacity='0';}
  // For hit: random 1-1.5s delay before card is dealt (feels more natural)
  const emitDelay=action==='hit'?(1000+Math.random()*500):300;
  setTimeout(()=>{
    if(pb){pb.classList.add('betting-hidden');pb.style.opacity='';pb.style.transition='';}
    socket.emit('action',{action,sid:activeTurnSid});
  },emitDelay);
}
$('btn-hit').addEventListener('click',()=>doAction('hit'));
$('btn-stand').addEventListener('click',()=>doAction('stand'));
$('btn-double').addEventListener('click',()=>doAction('double'));
$('btn-split').addEventListener('click',()=>doAction('split'));

// ── Chips ──────────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip=>{chip.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(c=>c.classList.remove('selected'));chip.classList.add('selected');selectedChip=parseInt(chip.dataset.value);sfxChip();});});
document.querySelector('.chip[data-value="100"]')?.classList.add('selected');
$('btn-deal').addEventListener('click',()=>{sfxDeal();socket.emit('deal');startDealCountdown();});
$('btn-undo').addEventListener('click',()=>{sfxClick();socket.emit('undoBet');});
$('btn-rebet').addEventListener('click',()=>{sfxChipStack(4);socket.emit('rebet');});
$('btn-2x').addEventListener('click',()=>{sfxChipStack(5);socket.emit('doubleBets');});
document.querySelectorAll('.leave-seat-btn').forEach(btn=>{btn.addEventListener('click',e=>{const sid=btn.closest('.seat')?.dataset.seat;if(sid){sfxClick();socket.emit('leaveSeat',{sid});}e.stopPropagation();});});

// ── Insurance per seat ─────────────────────────────────────────
function showInsuranceForSeat(sid,cost){
  stopCountdown();
  document.getElementById('ins-countdown-svg')?.remove();
  document.querySelectorAll('.seat.insurance-highlight').forEach(e=>e.classList.remove('insurance-highlight'));
  const seatEl=$('seat-'+sid);if(seatEl)seatEl.classList.add('insurance-highlight');
  const modal=$('insurance-modal');
  const canAfford=myWallet>=cost;
  const cantAffordNote=canAfford?'':`<div id="ins-cant-afford">\u20ac${cost} needed</div>`;
  const YES_SVG='<svg viewBox="0 0 40 46" fill="none" width="34" height="40"><path d="M20 2 L37 9 L37 24 C37 35 20 44 20 44 C20 44 3 35 3 24 L3 9 Z" fill="rgba(255,255,255,0.22)" stroke="rgba(255,255,255,0.8)" stroke-width="2"/><polyline points="12,24 18,31 29,18" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
  const NO_SVG='<svg viewBox="0 0 40 46" fill="none" width="34" height="40"><path d="M20 2 L37 9 L37 24 C37 35 20 44 20 44 C20 44 3 35 3 24 L3 9 Z" fill="rgba(255,255,255,0.22)" stroke="rgba(255,255,255,0.8)" stroke-width="2"/><line x1="14" y1="17" x2="26" y2="29" stroke="white" stroke-width="3" stroke-linecap="round"/><line x1="26" y1="17" x2="14" y2="29" stroke="white" stroke-width="3" stroke-linecap="round"/></svg>';
  modal.innerHTML=`<div id="insurance-label">Insurance? \u00b7 Seat ${sid} \u00b7 \u20ac${cost}</div>${cantAffordNote}<div class="ins-btn-row"><button class="ins-cubic ins-cubic-yes${canAfford?'':' ins-disabled'}" id="ins-yes-btn" ${canAfford?'':'disabled'}>${YES_SVG}<span class="ins-lbl">YES</span></button><button class="ins-cubic ins-cubic-no" id="ins-no-btn">${NO_SVG}<span class="ins-lbl">NO</span></button></div>`;
  function respond(insure){
    document.querySelectorAll('.seat.insurance-highlight').forEach(e=>e.classList.remove('insurance-highlight'));
    hide('insurance-modal');stopCountdown();document.getElementById('ins-countdown-svg')?.remove();
    socket.emit('insuranceResponse',{sid,insure});
  }
  if(canAfford){
    $('ins-yes-btn').addEventListener('click',()=>{sfxChipStack(2);respond(true);},{once:true});
  } else {
    // Can't afford — auto-decline after a short pause so server advances
    setTimeout(()=>respond(false),800);
  }
  $('ins-no-btn').addEventListener('click',()=>respond(false),{once:true});
  show('insurance-modal');
  // Countdown arc around insurance modal (green→red, auto-declines at 0)
  setTimeout(()=>{
    const m=$('insurance-modal');
    if(!m||m.classList.contains('hidden'))return;
    const rect=m.getBoundingClientRect();
    document.getElementById('ins-countdown-svg')?.remove();
    const pad=14,x=rect.left-pad,y=rect.top-pad;
    const w=rect.width+pad*2,h=rect.height+pad*2,rx=26,mx=w/2;
    const pathD=`M ${mx} 0 L ${rx} 0 Q 0 0 0 ${rx} L 0 ${h-rx} Q 0 ${h} ${rx} ${h} L ${w-rx} ${h} Q ${w} ${h} ${w} ${h-rx} L ${w} ${rx} Q ${w} 0 ${w-rx} 0 L ${mx} 0`;
    const perim=2*(w-2*rx)+2*(h-2*rx)+2*Math.PI*rx;
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.id='ins-countdown-svg';
    svg.style.cssText=`position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;pointer-events:none;z-index:201;overflow:visible;`;
    const track=document.createElementNS('http://www.w3.org/2000/svg','path');
    track.setAttribute('d',pathD);track.setAttribute('fill','none');
    track.setAttribute('stroke','rgba(255,255,255,0.12)');track.setAttribute('stroke-width','3.5');
    const line=document.createElementNS('http://www.w3.org/2000/svg','path');
    line.id='ins-cd-path';line.setAttribute('d',pathD);line.setAttribute('fill','none');
    line.setAttribute('stroke','#4caf50');line.setAttribute('stroke-width','3.5');
    line.setAttribute('stroke-linecap','round');line.setAttribute('stroke-linejoin','round');
    line.setAttribute('stroke-dasharray',String(perim));line.setAttribute('stroke-dashoffset','0');
    svg.appendChild(track);svg.appendChild(line);document.body.appendChild(svg);
    let insRaf=null;
    const start=performance.now(),dur=15000;
    function tick(now){
      const p=Math.min((now-start)/dur,1);
      line.setAttribute('stroke-dashoffset',String(perim*p));
      const r=Math.min(255,Math.round(p<0.5?p*2*255:255));
      const g=Math.max(0,Math.round(p<0.5?255:(1-(p-0.5)*2)*255));
      line.setAttribute('stroke',`rgb(${r},${g},30)`);
      if(p<1){insRaf=requestAnimationFrame(tick);}
      else{if(insRaf)cancelAnimationFrame(insRaf);svg.remove();respond(false);}
    }
    insRaf=requestAnimationFrame(tick);
    m._insRaf=insRaf;m._insSvg=svg;
  },100);
}

// ── Win Overlay ────────────────────────────────────────────────
function showWinOverlay(amount){if(winOverlayShown)return;winOverlayShown=true;sfxWin();sfxChipWin();document.querySelectorAll('.round-result-overlay').forEach(e=>e.remove());const ov=document.createElement('div');ov.className='round-result-overlay';ov.innerHTML=`<div class="rr-label">You Win!</div><div class="rr-amount">\u20ac${amount.toLocaleString()}</div>`;$('game-container').appendChild(ov);setTimeout(()=>ov.classList.add('rr-fadeout'),1800);setTimeout(()=>{ov.remove();winOverlayShown=false;},2600);}
const ip=$('table-info-panel');if(ip){ip.addEventListener('mouseenter',()=>$('table-payout-menu')?.classList.add('visible'));ip.addEventListener('mouseleave',()=>$('table-payout-menu')?.classList.remove('visible'));}
$('table-info-x')?.addEventListener('click',()=>{sfxClick();showLeaveConfirm();});

// ── History ────────────────────────────────────────────────────
$('btn-history')?.addEventListener('click',()=>{sfxClick();openHistoryPanel();});
function openHistoryPanel(){let panel=$('history-panel');if(!panel){panel=document.createElement('div');panel.id='history-panel';panel.innerHTML='<div class="history-header"><span class="history-title">HISTORY</span><button class="history-close" id="history-close">\u2715</button></div><div id="history-body"></div>';$('game-container').appendChild(panel);$('history-close').addEventListener('click',()=>panel.remove());}renderHistoryList($('history-body'));}
function renderHistoryList(container){const history=loadHistory();if(!history.length){container.innerHTML='<div class="history-empty">No rounds yet.</div>';return;}const byDay={};history.forEach(r=>{const d=r.time.slice(0,10);if(!byDay[d])byDay[d]=[];byDay[d].push(r);});const days=Object.keys(byDay).sort((a,b)=>b.localeCompare(a));container.innerHTML=days.map(day=>{const rounds=byDay[day],net=rounds.reduce((s,r)=>s+r.netCash,0);const dateStr=new Date(day+'T12:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});return`<div class="hist-day-row" data-day="${day}"><span class="hist-arrow">\u203a</span><span class="hist-date">${dateStr}</span><span class="hist-net ${net>=0?'hist-pos':'hist-neg'}">${net>=0?'+':''}\u20ac${Math.abs(net).toFixed(2)}</span></div><div class="hist-day-rounds hidden" id="hdr-${day.replace(/-/g,'_')}"></div>`;}).join('');container.querySelectorAll('.hist-day-row').forEach(row=>{row.addEventListener('click',()=>{const day=row.dataset.day,re=$(`hdr-${day.replace(/-/g,'_')}`);if(!re)return;re.classList.toggle('hidden');if(!re.classList.contains('hidden'))renderDayRounds(re,byDay[day]);});});}
function renderDayRounds(container,rounds){container.innerHTML=rounds.map(r=>{const t=new Date(r.time).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});const nc=r.netCash>=0?'hist-pos':'hist-neg';return`<div class="hist-round-row" data-id="${r.id}"><div class="hist-round-top"><span class="hist-round-table">${r.tableName}</span><span class="hist-round-net ${nc}">${r.netCash>=0?'+':''}\u20ac${Math.abs(r.netCash).toFixed(2)}</span></div><div class="hist-round-sub">${t} \u00b7 Room ${r.roomCode} \u00b7 Bet \u20ac${r.totalBet}</div></div>`;}).join('');container.querySelectorAll('.hist-round-row').forEach(row=>{row.addEventListener('click',()=>{const id=parseInt(row.dataset.id),entry=loadHistory().find(r=>r.id===id);if(entry)openRoundDetail(entry);});});}
function mkHistCard(c){const el=document.createElement('div');el.className='hd-card-img'+(suitIsRed(c.suit)?' red':'');el.innerHTML=`<span class="card-val">${c.value}</span><span class="card-suit">${{S:'\u2660',H:'\u2665',D:'\u2666',C:'\u2663'}[c.suit]||''}</span>`;return el;}
function openRoundDetail(entry){
  const panel=$('history-panel');if(!panel)return;
  const body=$('history-body');if(!body)return;
  const t=new Date(entry.time).toLocaleString('en-GB',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const nc=entry.netCash>=0?'hist-pos':'hist-neg';
  body.innerHTML='';
  // Back button
  const back=document.createElement('div');back.className='hist-detail-back-row';
  back.innerHTML='<button class="hist-detail-back" id="hd-back">\u2039 Back</button>';
  body.appendChild(back);
  // Meta
  const meta=document.createElement('div');meta.className='hist-detail-meta';
  meta.innerHTML=`<b>${entry.tableName}</b><br>${t} \u00b7 Room <b>${entry.roomCode}</b><br>Bet \u20ac${entry.totalBet} &nbsp; Net: <b class="${nc}">${entry.netCash>=0?'+':''}\u20ac${Math.abs(entry.netCash).toFixed(2)}</b>`;
  body.appendChild(meta);
  // Table seat map
  if(entry.seatMap){
    const mapDiv=document.createElement('div');mapDiv.className='hd-table-map';
    mapDiv.innerHTML='<div class="hd-table-map-title">Seats</div>';
    const row=document.createElement('div');row.className='hd-table-row';
    entry.seatMap.forEach(s=>{
      const dot=document.createElement('div');
      dot.className='hd-seat-dot'+(s.mine?' mine':s.taken?' taken':'');
      dot.textContent=s.n;
      row.appendChild(dot);
    });
    mapDiv.appendChild(row);
    body.appendChild(mapDiv);
  }
  // Dealer hand — above seats, cards centered
  const ds=document.createElement('div');ds.className='hd-dealer-row';
  const dScore=score(entry.dealerCards||[]);
  ds.innerHTML=`<span class="hd-section-label">Dealer${dScore>21?' \u00b7 Bust':dScore?' \u00b7 '+dScore:''}</span>`;
  const dealerRow=document.createElement('div');dealerRow.className='hd-cards-row hd-cards-centered';
  (entry.dealerCards||[]).forEach(c=>dealerRow.appendChild(mkHistCard(c)));
  ds.appendChild(dealerRow);body.appendChild(ds);
  // Seats
  const seatsDiv=document.createElement('div');seatsDiv.className='hd-seats';
  entry.seats.forEach(s=>{
    const sd=document.createElement('div');sd.className='hd-seat';
    sd.innerHTML=`<div class="hd-seat-label">Seat ${s.sid}</div>`;
    s.hands.forEach((h,hi)=>{
      const hd=document.createElement('div');hd.className='hd-hand';
      if(s.hands.length>1)hd.innerHTML=`<div class="hd-section-label">Hand ${hi+1}</div>`;
      const cr=document.createElement('div');cr.className='hd-cards-row';
      h.cards.forEach((c,ci)=>{
        const img=mkHistCard(c);
        const dec=h.decisions?.[ci];
        if(dec&&dec!=='stand'){
          const chip=document.createElement('span');
          chip.className='hd-move-chip '+(dec==='hit'?'hit-chip':dec==='double'?'double-chip':'bust-chip');
          chip.textContent=dec==='hit'?'+':dec==='double'?'2×':'✕';
          const wrap=document.createElement('div');wrap.style.cssText='display:flex;flex-direction:column;align-items:center;gap:1px;';
          wrap.appendChild(img);wrap.appendChild(chip);cr.appendChild(wrap);
        } else {
          cr.appendChild(img);
        }
      });
      // Show stand marker after cards if player stood (not busted)
      if(h.stood){const sc=document.createElement('span');sc.className='hd-move-chip stand-chip';sc.textContent='−';cr.appendChild(sc);}
      const rc=h.result?.toLowerCase().includes('win')?'res-win':h.result?.toLowerCase().includes('push')?'res-push':'res-lose';
      const resLabel=h.result?.toLowerCase().includes('win')?'Win':h.result?.toLowerCase().includes('push')?'Push':'Lose';
      hd.appendChild(cr);
      hd.innerHTML+=`<div class="hd-result ${rc}">${resLabel}</div>`;
      sd.appendChild(hd);
    });
    // Bets table
    const bd=document.createElement('div');bd.className='hd-bets-table';
    const fmtNet=(n)=>`<span class="${n>=0?'hist-pos':'hist-neg'}">${n>=0?'+':''}\u20ac${Math.abs(n)}</span>`;
    const pp=s.ppBet>0?`<div class="hd-bet-line"><span>PP</span><span>\u20ac${s.ppBet}</span>${fmtNet(s.ppNet)}</div>`:'';
    const sp2=s.spBet>0?`<div class="hd-bet-line"><span>21+3</span><span>\u20ac${s.spBet}</span>${fmtNet(s.spNet)}</div>`:'';
    bd.innerHTML=`<div class="hd-bet-line hd-bet-header"><span>Bet</span><span>Amount</span><span>Net</span></div><div class="hd-bet-line"><span>Main</span><span>\u20ac${s.mainBet}</span>${fmtNet(s.mainNet)}</div>${pp}${sp2}`;
    sd.appendChild(bd);seatsDiv.appendChild(sd);
  });
  body.appendChild(seatsDiv);
  $('hd-back').addEventListener('click',()=>renderHistoryList(body));
}
