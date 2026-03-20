// =============================================================
// server.js — Multiplayer Room Server
// Handles: rooms, players, socket events, broadcasting.
// All game logic lives in ./server/game.js
// =============================================================
'use strict';
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { randomInt } = require('crypto');
const path       = require('path');

const {
  makeGs, buildDeck,
  isNaturalBJ, score, cardNum,
  dealTo, initHandsForSeats, rtlOrder,
  resolveSideBets, buildInsuranceQueue,
  markPlayerBJBadges, payInsurance, resolveMain, resetForNewRound,
  delay,
} = require('./server/game');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const DEAL_LAB_ENABLED = process.env.DEAL_LAB === 'true';

app.use(express.static(path.join(__dirname, 'client')));
app.use(express.json());

app.get('/api/rooms', (_req, res) => {
  const list = Object.values(rooms)
    .filter(r => r.isPublic)
    .map(r => ({
      code:           r.code,
      name:           r.roomName || 'Table',
      players:        Object.keys(r.players).length,
      maxPlayers:     5,
      seatsOpen:      5 - Object.keys(r.players).length,
      hasPassword:    !!r.password,
      startingBalance: r.startingBalance || 5000,
      hostName:       Object.values(r.players).find(p => p.isHost)?.name || '?',
      gameStatus:     r.gs.gameStatus,
    }));
  res.json(list);
});

const rooms = {};
const ALPHANUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let c;
  do { c = Array.from({length:6}, () => ALPHANUM[randomInt(0, ALPHANUM.length)]).join(''); }
  while (rooms[c]);
  return c;
}

function broadcast(code) {
  const room = rooms[code]; if (!room) return;
  const players = {};
  for (const [sid, p] of Object.entries(room.players))
    players[sid] = { name: p.name, wallet: p.wallet, totalBet: p.totalBet, isHost: p.isHost };
  io.to(code).emit('stateUpdate', { gs: room.gs, players, code, hostId: room.hostId });
}

function startBetTimer(code) {
  const room = rooms[code];
  if (!room || room.betTimerTimeout || !room.gs.betTimerEnabled) return;
  room.betTimerSecsLeft = 15;
  room.betTimerTimeout = setInterval(() => {
    const hasBets = room.gs.activeSeats.some(sid => (room.gs.bets[sid]?.main||0) > 0);
    if (!hasBets) { clearInterval(room.betTimerTimeout); room.betTimerTimeout=null; io.to(code).emit('timerCancel'); return; }
    room.betTimerSecsLeft--;
    io.to(code).emit('timerTick', room.betTimerSecsLeft);
    if (room.betTimerSecsLeft <= 0) { clearInterval(room.betTimerTimeout); room.betTimerTimeout=null; startDeal(code); }
  }, 1000);
}
function cancelBetTimer(code) {
  const room = rooms[code]; if (!room) return;
  if (room.betTimerTimeout) { clearInterval(room.betTimerTimeout); room.betTimerTimeout=null; }
  io.to(code).emit('timerCancel');
}

function offerInsurance(code) {
  const room = rooms[code]; const { gs } = room;
  gs.insurancePhase = true; gs.insuranceResponses = {};
  if (gs.activeSeats.length===1 && isNaturalBJ(gs.hands[gs.activeSeats[0]])) {
    gs.insurancePhase=false; broadcast(code); checkBJ(code); return;
  }
  gs.insuranceQueue = buildInsuranceQueue(gs); gs.insuranceQueueIndex=0;
  broadcast(code); advanceInsuranceQueue(code);
}
function advanceInsuranceQueue(code) {
  const room = rooms[code]; const { gs } = room;
  if (!gs.insuranceQueue || gs.insuranceQueueIndex >= gs.insuranceQueue.length) {
    gs.insurancePhase=false; broadcast(code); checkBJ(code); return;
  }
  const { sid, ownerId } = gs.insuranceQueue[gs.insuranceQueueIndex];
  const cost = Math.floor((gs.bets[sid]?.main||0)/2);
  const owner = room.players[ownerId];
  if (!owner || owner.wallet < cost) { gs.insuranceQueueIndex++; advanceInsuranceQueue(code); return; }
  gs.insuranceCurrentSid = sid; broadcast(code);
  io.to(ownerId).emit('insuranceOfferSeat', { sid, cost });
  const _qIdx = gs.insuranceQueueIndex;
  setTimeout(() => {
    if (!rooms[code]||!rooms[code].gs.insurancePhase) return;
    if (rooms[code].gs.insuranceQueueIndex !== _qIdx) return;
    rooms[code].gs.insuranceQueueIndex++; advanceInsuranceQueue(code);
  }, 20000);
}

async function checkBJ(code) {
  const room = rooms[code]; const { gs, players } = room;
  const dBJ = isNaturalBJ(gs.hands.dealer);
  if (dBJ) { gs.dealerRevealed=true; broadcast(code); await delay(1400); markPlayerBJBadges(gs); payInsurance(gs,players); doResolveMain(code,true); return; }
  markPlayerBJBadges(gs); broadcast(code); gs.gameStatus='playing'; gs.currentSeatIndex=0; advancePlay(code);
}
function advancePlay(code) {
  const room = rooms[code]; const { gs } = room; const rtl = rtlOrder(gs);
  while (gs.currentSeatIndex < rtl.length) {
    const sid = rtl[gs.currentSeatIndex];
    if (!(gs.badges[sid]||[]).some(b=>b.cls==='bj')) break;
    gs.currentSeatIndex++;
  }
  if (gs.currentSeatIndex >= rtl.length) { dealerTurn(code); return; }
  const sid = rtl[gs.currentSeatIndex];
  gs.gameStatus='playing';
  io.to(code).emit('yourTurn', { sid, handIdx:gs.splitHandIndex[sid]||0, ownerId:gs.seatOwners[sid] });
  broadcast(code);
}
function playerBust(code, sid) {
  const room = rooms[code]; const { gs } = room;
  const hk = gs.splitActive[sid] ? 'hand'+(gs.splitHandIndex[sid]+1) : null;
  const bustHand = hk ? gs.hands[sid][hk] : gs.hands[sid];
  if (!gs.bustSeats) gs.bustSeats={};
  gs.bustSeats[sid+(hk?'_'+hk:'')] = score(bustHand);
  broadcast(code);
  setTimeout(() => {
    if (!rooms[code]) return;
    if (gs.splitActive[sid] && gs.splitHandIndex[sid]===0) { gs.splitHandIndex[sid]=1; broadcast(code); io.to(code).emit('yourTurn',{sid,handIdx:1,ownerId:gs.seatOwners[sid]}); }
    else { gs.currentSeatIndex++; advancePlay(code); }
  }, 1200);
}
function dealerTurn(code) {
  const room = rooms[code]; const { gs } = room;
  gs.gameStatus='dealer_turn'; broadcast(code);
  setTimeout(() => {
    if (!rooms[code]) return;
    gs.dealerRevealed=true; broadcast(code);
    function dealerStep() {
      if (!rooms[code]) return;
      if (score(gs.hands.dealer) < 17) { dealTo(gs,'dealer'); broadcast(code); setTimeout(dealerStep,700); }
      else { doResolveMain(code, isNaturalBJ(gs.hands.dealer)); }
    }
    setTimeout(dealerStep, 800);
  }, 2500);
}
function doResolveMain(code, dealerBJ) {
  const room = rooms[code]; const { gs, players } = room;
  const totalWon = resolveMain(gs, players, dealerBJ);
  gs.gameStatus='game_over'; gs.grandTotal=totalWon+gs.roundSideBetWon;
  broadcast(code); setTimeout(()=>newRound(code), 4000);
}
function newRound(code) {
  const room = rooms[code]; if (!room) return;
  const { gs } = room;
  const byPlayer = {};
  for (const entry of gs.betHistory) {
    if (!byPlayer[entry.socketId]) byPlayer[entry.socketId]=[];
    byPlayer[entry.socketId].push({ sid:entry.sid, type:entry.type, amt:entry.amt });
  }
  resetForNewRound(gs, byPlayer);
  for (const p of Object.values(room.players)) p.totalBet=0;
  broadcast(code);
}
function advanceSeat(code, sid) {
  const room = rooms[code]; if (!room) return; const { gs } = room;
  if (gs.splitActive[sid] && gs.splitHandIndex[sid]===0) { gs.splitHandIndex[sid]=1; broadcast(code); io.to(code).emit('yourTurn',{sid,handIdx:1,ownerId:gs.seatOwners[sid]}); return; }
  if (!gs.stoodSeats.includes(sid)) gs.stoodSeats.push(sid);
  gs.currentSeatIndex++; advancePlay(code);
}
async function startDeal(code) {
  cancelBetTimer(code);
  const room = rooms[code]; const { gs } = room;
  if (gs.activeSeats.length===0) return;
  gs.gameStatus='dealing'; gs.roundLock=true; gs.deck=buildDeck();
  initHandsForSeats(gs);
  if (gs.dealLabEnabled && room.forcedConfig) gs.forcedCards=JSON.parse(JSON.stringify(room.forcedConfig));
  gs.sideBetWins={}; gs.badges={}; gs.bustSeats={}; gs.grandTotal=null;
  gs.dealerRevealed=false; gs.insurancePhase=false; gs.insuranceResponses=null; gs.insurance={}; gs.insuredSeats=[];
  const rtl=rtlOrder(gs);
  for (const sid of rtl) { dealTo(gs,sid); broadcast(code); await delay(300); }
  dealTo(gs,'dealer'); broadcast(code); await delay(300);
  for (const sid of rtl) { dealTo(gs,sid); broadcast(code); await delay(300); }
  dealTo(gs,'dealer'); broadcast(code); await delay(500);
  gs.roundLock=false; resolveSideBets(gs, room.players); broadcast(code); await delay(200);
  const upCard=gs.hands.dealer[0];
  if (upCard && upCard.value==='A') { offerInsurance(code); return; }
  checkBJ(code);
}
function assignNewHost(code) {
  const room = rooms[code]; if (!room||!Object.keys(room.players).length) return;
  const ids = Object.keys(room.players);
  const newHostId = ids.reduce((best,id) => room.players[id].joinOrder<room.players[best].joinOrder?id:best, ids[0]);
  room.hostId=newHostId;
  for (const [id,p] of Object.entries(room.players)) p.isHost=(id===newHostId);
  io.to(code).emit('hostChanged',{hostId:newHostId}); broadcast(code);
}
function _freeSeat(gs, socketId) {
  for (const [sid,ownerId] of Object.entries(gs.seatOwners)) {
    if (ownerId===socketId) { delete gs.seatOwners[sid]; gs.activeSeats=gs.activeSeats.filter(s=>s!==sid); gs.bets[sid]={main:0,pp:0,sp:0}; }
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, token, roomName, isPublic, password, startingBalance }) => {
    const code=makeCode(); const bal=Math.max(100,Math.min(1000000,parseInt(startingBalance)||5000));
    const rName=(roomName||'').trim().slice(0,32)||(isPublic?'Public Table':'Private Table');
    rooms[code]={ code, gs:makeGs(), players:{}, betTimerTimeout:null, hostId:socket.id, joinCounter:0, banList:new Set(), isPublic:!!isPublic, roomName:rName, password:password?String(password).slice(0,32):null, startingBalance:bal };
    rooms[code].gs.gameStatus='betting'; rooms[code].gs.deck=buildDeck();
    rooms[code].players[socket.id]={ name, wallet:bal, totalBet:0, isHost:true, joinOrder:0 };
    socket.join(code); socket.data.code=code; socket.data.name=name; socket.data.token=token||socket.id;
    socket.emit('roomJoined',{code,socketId:socket.id,isHost:true,roomName:rName,isPublic:!!isPublic}); broadcast(code);
  });

  socket.on('joinRoom', ({ code, name, token, password }) => {
    const room=rooms[code];
    if (!room) { socket.emit('roomError','Room not found'); return; }
    if (Object.keys(room.players).length>=5) { socket.emit('roomError','Room is full'); return; }
    if (room.password && room.password!==String(password||'')) { socket.emit('roomError','Wrong password'); return; }
    const playerToken=token||socket.id;
    if (room.banList?.has(playerToken)) { socket.emit('banned'); return; }
    socket.data.token=playerToken; room.joinCounter=(room.joinCounter||0)+1;
    room.players[socket.id]={ name, wallet:room.startingBalance||5000, totalBet:0, isHost:false, joinOrder:room.joinCounter };
    socket.join(code); socket.data.code=code; socket.data.name=name;
    socket.emit('roomJoined',{code,socketId:socket.id,isHost:false,roomName:room.roomName,isPublic:room.isPublic});
    broadcast(code); io.to(socket.id).emit('autoLaunch');
  });

  socket.on('kickPlayer', ({ targetId }) => {
    const code=socket.data.code; const room=rooms[code];
    if (!room||room.hostId!==socket.id||!['betting','idle'].includes(room.gs.gameStatus)||targetId===socket.id||!room.players[targetId]) return;
    _freeSeat(room.gs,targetId); delete room.players[targetId]; io.to(targetId).emit('kicked'); broadcast(code);
  });

  socket.on('banPlayer', ({ targetId }) => {
    const code=socket.data.code; const room=rooms[code];
    if (!room||room.hostId!==socket.id||!['betting','idle'].includes(room.gs.gameStatus)||targetId===socket.id||!room.players[targetId]) return;
    const tSock=[...io.sockets.sockets.values()].find(s=>s.id===targetId);
    room.banList.add(tSock?.data?.token||targetId); _freeSeat(room.gs,targetId); delete room.players[targetId];
    io.to(targetId).emit('banned'); broadcast(code);
  });

  socket.on('changeName', ({ name }) => {
    const room=rooms[socket.data.code]; if (!room||!name) return;
    const player=room.players[socket.id];
    if (player) { player.name=name; socket.data.name=name; broadcast(socket.data.code); }
  });

  socket.on('startGame', () => {
    const room=rooms[socket.data.code]; if (!room||room.hostId!==socket.id) return;
    io.to(socket.data.code).emit('gameLaunched');
  });

  socket.on('claimSeat', ({ sid }) => {
    const code=socket.data.code; const room=rooms[code]; if (!room) return;
    const { gs, players }=room;
    if (!['betting','idle'].includes(gs.gameStatus)||gs.seatOwners[sid]) return;
    gs.seatOwners[sid]=socket.id;
    const player=players[socket.id];
    const existing=Object.entries(gs.seatOwners).filter(([s,id])=>id===socket.id&&s!==sid).map(([s])=>s);
    if (existing.length>0&&player) {
      const src=existing[0];
      for (const type of ['main','pp','sp']) {
        const amt=gs.bets[src]?.[type]||0;
        if (amt>0&&player.wallet>=amt) { gs.bets[sid][type]=amt; player.wallet-=amt; player.totalBet+=amt; gs.betHistory.push({socketId:socket.id,sid,type,amt,groupId:'mirror_'+Date.now()}); }
      }
      if ((gs.bets[sid].main||0)>0&&!gs.activeSeats.includes(sid)) gs.activeSeats.push(sid);
    }
    broadcast(code);
  });

  socket.on('leaveSeat', ({ sid }) => {
    const code=socket.data.code; const room=rooms[code]; if (!room) return;
    const { gs, players }=room;
    if (gs.seatOwners[sid]!==socket.id) return;
    const player=players[socket.id];
    if (player) { const refund=gs.bets[sid].main+gs.bets[sid].pp+gs.bets[sid].sp; player.wallet+=refund; player.totalBet=Math.max(0,player.totalBet-refund); }
    gs.bets[sid]={main:0,pp:0,sp:0}; delete gs.seatOwners[sid];
    gs.activeSeats=gs.activeSeats.filter(s=>s!==sid);
    gs.betHistory=gs.betHistory.filter(e=>!(e.sid===sid&&e.socketId===socket.id));
    broadcast(code);
  });

  socket.on('placeBet', ({ sid, type, amt }) => {
    const code=socket.data.code; const room=rooms[code]; if (!room) return;
    const { gs, players }=room;
    if (!['betting','idle'].includes(gs.gameStatus)||gs.betsLocked||gs.seatOwners[sid]!==socket.id) return;
    const player=players[socket.id]; if (!player||player.wallet<amt) return;
    const maxBet=type==='main'?10000:2000; const cur=gs.bets[sid][type]||0; if (cur>=maxBet) return;
    const allowed=Math.min(amt,maxBet-cur);
    player.wallet-=allowed; player.totalBet+=allowed; gs.bets[sid][type]+=allowed; gs.gameStatus='betting';
    if (type==='main'&&!gs.activeSeats.includes(sid)) gs.activeSeats.push(sid);
    const groupId='grp_'+Date.now()+'_'+randomInt(0,1000000);
    gs.betHistory.push({socketId:socket.id,sid,type,amt:allowed,groupId});
    const mySeats=Object.entries(gs.seatOwners).filter(([s,id])=>id===socket.id&&s!==sid).map(([s])=>s);
    for (const other of mySeats) {
      const oCur=gs.bets[other][type]||0; const oMax=type==='main'?10000:2000;
      if ((type==='main'||gs.bets[other].main>0)&&oCur<oMax&&player.wallet>=allowed) {
        player.wallet-=allowed; player.totalBet+=allowed; gs.bets[other][type]+=allowed;
        if (type==='main'&&!gs.activeSeats.includes(other)) gs.activeSeats.push(other);
        gs.betHistory.push({socketId:socket.id,sid:other,type,amt:allowed,groupId});
      }
    }
    broadcast(code); if (!room.betTimerTimeout) startBetTimer(code);
    socket.to(code).emit('betPlaced',{sid,type,amt:allowed});
  });

  socket.on('undoBet', () => {
    const code=socket.data.code; const room=rooms[code]; if (!room||room.gs.betsLocked) return;
    const { gs, players }=room; const player=players[socket.id]; if (!player) return;
    const mine=gs.betHistory.filter(e=>e.socketId===socket.id); if (!mine.length) return;
    const lastGroup=mine[mine.length-1].groupId;
    for (const e of gs.betHistory.filter(e=>e.groupId===lastGroup)) {
      gs.bets[e.sid][e.type]=Math.max(0,gs.bets[e.sid][e.type]-e.amt); player.wallet+=e.amt; player.totalBet=Math.max(0,player.totalBet-e.amt);
      if (gs.bets[e.sid].main===0) gs.activeSeats=gs.activeSeats.filter(s=>s!==e.sid);
    }
    gs.betHistory=gs.betHistory.filter(e=>e.groupId!==lastGroup); broadcast(code);
  });

  socket.on('clearBets', () => {
    const code=socket.data.code; const room=rooms[code]; if (!room||room.gs.betsLocked) return;
    const { gs, players }=room; const player=players[socket.id]; if (!player) return;
    for (const e of gs.betHistory.filter(e=>e.socketId===socket.id)) {
      gs.bets[e.sid][e.type]=Math.max(0,gs.bets[e.sid][e.type]-e.amt); player.wallet+=e.amt; player.totalBet=Math.max(0,player.totalBet-e.amt);
    }
    gs.betHistory=gs.betHistory.filter(e=>e.socketId!==socket.id);
    for (const sid of [...gs.activeSeats]) if (gs.bets[sid].main===0) gs.activeSeats=gs.activeSeats.filter(s=>s!==sid);
    broadcast(code);
  });

  socket.on('rebet', () => {
    const code=socket.data.code; const room=rooms[code]; if (!room||room.gs.betsLocked) return;
    const { gs, players }=room; const player=players[socket.id]; if (!player) return;
    for (const e of gs.lastRoundBets[socket.id]||[]) {
      const maxBet=e.type==='main'?10000:2000; const cur=gs.bets[e.sid][e.type]||0;
      if (cur>=maxBet||player.wallet<e.amt) continue;
      const allowed=Math.min(e.amt,maxBet-cur); player.wallet-=allowed; player.totalBet+=allowed; gs.bets[e.sid][e.type]+=allowed;
      if (e.type==='main'&&!gs.activeSeats.includes(e.sid)) gs.activeSeats.push(e.sid);
      gs.betHistory.push({socketId:socket.id,sid:e.sid,type:e.type,amt:allowed,groupId:'rebet_'+Date.now()});
    }
    broadcast(code); if (gs.activeSeats.length>0&&!room.betTimerTimeout) startBetTimer(code);
  });

  socket.on('doubleBets', () => {
    const code=socket.data.code; const room=rooms[code]; if (!room||room.gs.betsLocked) return;
    const { gs, players }=room; const player=players[socket.id]; if (!player) return;
    for (const e of [...gs.betHistory.filter(e=>e.socketId===socket.id)]) {
      const maxBet=e.type==='main'?10000:2000; const cur=gs.bets[e.sid][e.type]; const add=Math.min(e.amt,maxBet-cur);
      if (player.wallet<add||add<=0) continue;
      player.wallet-=add; player.totalBet+=add; gs.bets[e.sid][e.type]+=add;
      gs.betHistory.push({socketId:socket.id,sid:e.sid,type:e.type,amt:add,groupId:'2x_'+Date.now()});
    }
    broadcast(code);
  });

  socket.on('deal', () => {
    const code=socket.data.code; const room=rooms[code]; if (!room||room.gs.gameStatus!=='betting') return;
    const { gs }=room; if (gs.activeSeats.length===0) return;
    const playersWithBets=new Set(gs.activeSeats.map(sid=>gs.seatOwners[sid]).filter(Boolean));
    if (!playersWithBets.has(socket.id)) return;
    if (!gs.betsLocked) { gs.betsLocked=true; cancelBetTimer(code); broadcast(code); }
    if (!gs.readyPlayers.includes(socket.id)) gs.readyPlayers.push(socket.id);
    io.to(code).emit('dealVote',{ready:gs.readyPlayers.length,needed:playersWithBets.size,readyIds:gs.readyPlayers});
    if ([...playersWithBets].every(id=>gs.readyPlayers.includes(id))) startDeal(code);
  });

  socket.on('action', ({ action, sid }) => {
    const code=socket.data.code; const room=rooms[code];
    if (!room||room.gs.gameStatus!=='playing') return;
    const { gs, players }=room;
    if (gs.roundLock) return;
    const rtl=rtlOrder(gs);
    if (rtl[gs.currentSeatIndex]!==sid||gs.seatOwners[sid]!==socket.id) return;
    const player=players[socket.id];
    socket.to(code).emit('playerAction',{sid,action});

    if (action==='hit') {
      if (gs.splitActive[sid]&&gs.splitFromAces[sid]) return;
      if (gs.dealLabEnabled&&gs.forcedCards?.nextHit?.[sid]) { gs.deck.push(gs.forcedCards.nextHit[sid]); delete gs.forcedCards.nextHit[sid]; if (!Object.keys(gs.forcedCards.nextHit).length) delete gs.forcedCards.nextHit; }
      dealTo(gs,sid); const hand=gs.splitActive[sid]?gs.hands[sid]['hand'+(gs.splitHandIndex[sid]+1)]:gs.hands[sid]; const sc=score(hand);
      broadcast(code);
      if (sc>21) { playerBust(code,sid); return; }
      if (sc===21) { advanceSeat(code,sid); return; }
      io.to(code).emit('yourTurn',{sid,handIdx:gs.splitHandIndex[sid]||0,ownerId:gs.seatOwners[sid]});
    } else if (action==='stand') {
      advanceSeat(code,sid);
    } else if (action==='double') {
      if (gs.splitActive[sid]) {
        const hk='hand'+(gs.splitHandIndex[sid]+1); const betAmt=hk==='hand1'?gs.bets[sid].main:(gs.splitBets[sid]||gs.bets[sid].main);
        if (player&&player.wallet>=betAmt&&!gs.doubledHands[sid][hk]) {
          player.wallet-=betAmt; player.totalBet+=betAmt;
          if (hk==='hand1') gs.bets[sid].main*=2; else gs.splitBets[sid]=(gs.splitBets[sid]||gs.bets[sid].main/2)*2;
          gs.doubledHands[sid][hk]=true; dealTo(gs,sid); broadcast(code); advanceSeat(code,sid);
        }
      } else if (player&&player.wallet>=gs.bets[sid].main) {
        player.wallet-=gs.bets[sid].main; player.totalBet+=gs.bets[sid].main; gs.bets[sid].main*=2; gs.doubled[sid]=true;
        dealTo(gs,sid); broadcast(code); advanceSeat(code,sid);
      }
    } else if (action==='split') {
      const hand=gs.hands[sid]; if (!Array.isArray(hand)||hand.length!==2) return;
      if (cardNum(hand[0])!==cardNum(hand[1])) return;
      const splitBet=gs.bets[sid].main; if (!player||player.wallet<splitBet) return;
      player.wallet-=splitBet; player.totalBet+=splitBet; gs.splitBets[sid]=splitBet; gs.splitFromAces[sid]=(hand[0].value==='A');
      const n1=gs.deck.pop(), n2=gs.deck.pop();
      gs.hands[sid]={hand1:[hand[0]],hand2:[hand[1]]}; gs.splitActive[sid]=true; gs.splitHandIndex[sid]=0; gs.splitAnimStep[sid]=0; gs.roundLock=true;
      broadcast(code);
      setTimeout(()=>{
        if (!rooms[code]) return; if (n1) gs.hands[sid].hand1.push(n1); gs.splitAnimStep[sid]=1; broadcast(code);
        setTimeout(()=>{
          if (!rooms[code]) return; if (n2) gs.hands[sid].hand2.push(n2); gs.splitAnimStep[sid]=2; gs.roundLock=false; broadcast(code);
          if (gs.splitFromAces[sid]) { gs.splitHandIndex[sid]=1; broadcast(code); setTimeout(()=>{ if(rooms[code]) advanceSeat(code,sid); },300); }
          else if (score(gs.hands[sid].hand1)===21) { gs.splitHandIndex[sid]=1; broadcast(code); io.to(code).emit('yourTurn',{sid,handIdx:1,ownerId:gs.seatOwners[sid]}); }
          else { io.to(code).emit('yourTurn',{sid,handIdx:0,ownerId:gs.seatOwners[sid]}); }
        }, 400);
      }, 400);
    }
  });

  socket.on('insuranceResponse', ({ sid, insure }) => {
    const code=socket.data.code; const room=rooms[code];
    if (!room||!room.gs.insurancePhase||room.gs.roundLock) return;
    const { gs, players }=room;
    if (gs.insuranceCurrentSid!==sid||gs.seatOwners[sid]!==socket.id) return;
    const player=players[socket.id];
    if (insure) { const cost=Math.floor(gs.bets[sid].main/2); if (player&&player.wallet>=cost) { player.wallet-=cost; player.totalBet+=cost; gs.insurance[sid]=cost; if (!gs.insuredSeats) gs.insuredSeats=[]; if (!gs.insuredSeats.includes(sid)) gs.insuredSeats.push(sid); } }
    gs.insuranceQueueIndex++; advanceInsuranceQueue(code);
  });

  socket.on('setBetTimerEnabled', ({ enabled }) => {
    const code=socket.data.code; const room=rooms[code]; if (!room||room.hostId!==socket.id) return;
    room.gs.betTimerEnabled=!!enabled;
    if (!enabled&&room.betTimerTimeout) { clearInterval(room.betTimerTimeout); room.betTimerTimeout=null; io.to(code).emit('timerCancel'); }
    broadcast(code);
  });

  socket.on('dealLabToggle', ({ on }) => {
    if (!DEAL_LAB_ENABLED) return;
    const room=rooms[socket.data.code]; if (!room||room.hostId!==socket.id) return;
    room.gs.dealLabEnabled=!!on; room.gs.isTrainingMode=!!on; broadcast(socket.data.code);
  });

  socket.on('forceDeck', (forced) => {
    if (!DEAL_LAB_ENABLED) return;
    const room=rooms[socket.data.code]; if (!room||room.hostId!==socket.id) return;
    room.forcedConfig=JSON.parse(JSON.stringify(forced)); room.gs.forcedCards=JSON.parse(JSON.stringify(forced));
  });

  socket.on('disconnect', () => {
    const code=socket.data.code; if (!code||!rooms[code]) return;
    const room=rooms[code]; delete room.players[socket.id]; _freeSeat(room.gs,socket.id);
    if (!Object.keys(room.players).length) { if (room.betTimerTimeout) clearInterval(room.betTimerTimeout); delete rooms[code]; }
    else {
      if (room.hostId===socket.id) assignNewHost(code);
      if (room.gs.insurancePhase&&room.gs.insuranceCurrentSid) {
        const wasInsurer=room.gs.insuranceQueue?.[room.gs.insuranceQueueIndex]?.ownerId===socket.id;
        if (wasInsurer) { room.gs.insuranceQueueIndex++; advanceInsuranceQueue(code); return; }
      }
      broadcast(code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Blackjack server on :${PORT}`));
