const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static('public'));

const rooms = {};
const RN = { jia: '嘉', ray: 'Ray', xiaoli: '小笠', caroline: '卡洛琳' };

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 5; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

function newRoom(code) {
  return {
    code, players: {}, phase: 'LOBBY',
    jiaTarget: null, carolineTarget: null, carolineAnnounce: 'silent',
    jiaStatements: {}, otherStatements: {}, testimonySubmitted: {},
    rayQ: { done: false, round: null, isPublic: false, answer: null, skipped: false },
    carolineInv: { done: false, target: null, response: null, awaiting: false, skipped: false },
    xiaoliPerception: false,
    accusations: {}, results: null, log: []
  };
}

function roleOf(room, sid) { return room.players[sid]?.role; }

function sidOf(room, role) {
  for (const [s, p] of Object.entries(room.players)) if (p.role === role) return s;
  return null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* 获取嘉的所有关系对象（可能0/1/2个） */
function getJiaPartners(room) {
  const p = [];
  if (room.jiaTarget) p.push(room.jiaTarget);
  if (room.carolineTarget === 'jia' && room.jiaTarget !== 'caroline') p.push('caroline');
  return p;
}

function pubState(room) {
  const ps = {};
  for (const [s, p] of Object.entries(room.players))
    ps[s] = { role: p.role, ready: p.ready };
  return { code: room.code, phase: room.phase, players: ps, count: Object.keys(ps).length, log: room.log };
}

function pubTestimony(room, round) {
  const r = {};
  if (room.jiaStatements[round]) r.jia = room.jiaStatements[round].text;
  if (room.otherStatements[round])
    for (const [role, text] of Object.entries(room.otherStatements[round])) r[role] = text;
  return r;
}

function addLog(room, msg) {
  room.log.push({ time: Date.now(), msg });
  io.to(room.code).emit('log', msg);
}

/* ====== 胜负判定 ====== */
function resolve(room) {
  const partners = getJiaPartners(room);
  const isVirgin = partners.length === 0;
  const correctSet = isVirgin ? ['virgin'] : partners;

  /* 统计非嘉玩家对「嘉和谁发生了关系」的投票 */
  const votes = {};
  for (const [role, acc] of Object.entries(room.accusations)) {
    if (role === 'jia') continue;
    const a = acc.jiaPartner;
    if (!votes[a]) votes[a] = [];
    votes[a].push(role);
  }

  /* 检查哪些正确答案获得了 2+ 票（嘉相关关系被发现） */
  let jiaFound = false;
  const foundAnswers = {};
  for (const ans of correctSet) {
    if (votes[ans] && votes[ans].length >= 2) {
      jiaFound = true;
      foundAnswers[ans] = true;
    }
  }

  /* 卡洛琳关系被发现：排除卡洛琳和她的对象后，1人及以上正确指认 */
  let carolineFound = false;
  const ct = room.carolineTarget;
  if (ct) {
    for (const [role, acc] of Object.entries(room.accusations)) {
      if (role === 'caroline' || role === ct) continue;
      if (acc.carolinePartner === ct) { carolineFound = true; break; }
    }
  }

  const pr = {};

  /* === 嘉的胜负 === */
  pr.jia = jiaFound ? 'lose' : 'win';
  if (ct === 'jia' && carolineFound) pr.jia = 'lose';

  /* === 卡洛琳的胜负【悲剧的女主角】 === */
  if (ct === 'jia') {
    pr.caroline = carolineFound ? 'win' : 'lose';
  } else if (ct === 'xiaoli') {
    pr.caroline = carolineFound ? 'lose' : 'win';
  } else if (ct === 'ray') {
    pr.caroline = carolineFound ? 'win' : 'lose';
  }

  /* === Ray 的胜负 === */
  const jiaChoseRay = room.jiaTarget === 'ray';
  const carolineChoseRay = ct === 'ray';

  if (jiaChoseRay && carolineChoseRay) {
    const jiaRayFound = !!foundAnswers['ray'];
    pr.ray = (jiaRayFound || carolineFound) ? 'lose' : 'win';
  } else if (jiaChoseRay) {
    const jiaRayFound = !!foundAnswers['ray'];
    pr.ray = jiaRayFound ? 'lose' : 'win';
  } else if (carolineChoseRay) {
    pr.ray = carolineFound ? 'lose' : 'win';
  } else {
    const rayCorrect = correctSet.includes(room.accusations.ray?.jiaPartner);
    pr.ray = rayCorrect ? 'win' : 'lose';
  }

  /* === 小笠的胜负 === */
  const jiaChoseXiaoli = room.jiaTarget === 'xiaoli';
  const carolineChoseXiaoli = ct === 'xiaoli';

  if (jiaChoseXiaoli && carolineChoseXiaoli) {
    const jiaXiaoliFound = !!foundAnswers['xiaoli'];
    pr.xiaoli = (jiaXiaoliFound || carolineFound) ? 'lose' : 'win';
  } else if (jiaChoseXiaoli) {
    const jiaXiaoliFound = !!foundAnswers['xiaoli'];
    pr.xiaoli = jiaXiaoliFound ? 'lose' : 'win';
  } else if (carolineChoseXiaoli) {
    pr.xiaoli = carolineFound ? 'lose' : 'win';
  } else {
    const xiaoliCorrect = correctSet.includes(room.accusations.xiaoli?.jiaPartner);
    pr.xiaoli = xiaoliCorrect ? 'win' : 'lose';
  }

  return {
    jiaPartners: partners, isVirgin, carolineTarget: ct,
    jiaFound, carolineFound,
    accusations: room.accusations, playerResults: pr,
    jiaStatementsDetail: room.jiaStatements
  };
}

/* ====== 证言推进 ====== */
function advanceTestimony(room) {
  const cur = parseInt(room.phase.split('_')[1]);
  room.testimonySubmitted = {};
  if (cur < 3) {
    room.phase = `TESTIMONY_${cur + 1}`;
    addLog(room, `--- 第 ${cur + 1} 轮证言开始 ---`);
    io.to(room.code).emit('phaseChange', room.phase);
    io.to(room.code).emit('roomUpdate', pubState(room));
  } else {
    const truths = [1, 2, 3].filter(r => room.jiaStatements[r]?.isTrue);
    if (truths.length === 0 && room.jiaStatements[1]) room.jiaStatements[1].isTrue = true;
    room.phase = 'ABILITY';
    addLog(room, '--- 技能阶段 ---');
    io.to(room.code).emit('phaseChange', room.phase);
    io.to(room.code).emit('roomUpdate', pubState(room));
  }
}

function checkAbilityDone(room) {
  if (room.rayQ.done && room.carolineInv.done) {
    room.phase = 'ACCUSATION';
    addLog(room, '--- 指认阶段 ---');
    io.to(room.code).emit('phaseChange', room.phase);
    io.to(room.code).emit('roomUpdate', pubState(room));
  }
}

/* ====== Socket 事件 ====== */
io.on('connection', (socket) => {
  let myRoom = null;

  socket.on('create', (cb) => {
    const code = genCode();
    rooms[code] = newRoom(code);
    rooms[code].players[socket.id] = { role: null, ready: false };
    myRoom = code;
    socket.join(code);
    cb({ ok: true, code });
    io.to(code).emit('roomUpdate', pubState(rooms[code]));
  });

  socket.on('join', (code, cb) => {
    const c = (code || '').toUpperCase();
    const room = rooms[c];
    if (!room) return cb({ ok: false, err: '房间不存在' });
    if (Object.keys(room.players).length >= 4) return cb({ ok: false, err: '房间已满（4人）' });
    if (room.phase !== 'LOBBY') return cb({ ok: false, err: '游戏已开始' });
    room.players[socket.id] = { role: null, ready: false };
    myRoom = c;
    socket.join(c);
    cb({ ok: true, code: c });
    addLog(room, '一位玩家加入了房间');
    io.to(c).emit('roomUpdate', pubState(room));
  });

  socket.on('pickRole', (role, cb) => {
    const room = rooms[myRoom]; if (!room) return;
    for (const [s, p] of Object.entries(room.players))
      if (s !== socket.id && p.role === role) return cb({ ok: false, err: '该角色已被选择' });
    room.players[socket.id].role = role;
    cb({ ok: true });
    io.to(myRoom).emit('roomUpdate', pubState(room));
  });

  socket.on('randomRoles', (cb) => {
    const room = rooms[myRoom]; if (!room) return;
    const sids = Object.keys(room.players);
    if (sids.length !== 4) return cb({ ok: false, err: '需要4人才能随机分配' });
    const shuffled = shuffle(['jia', 'ray', 'xiaoli', 'caroline']);
    sids.forEach((sid, i) => {
      room.players[sid].role = shuffled[i];
      room.players[sid].ready = false;
    });
    cb({ ok: true });
    addLog(room, '角色已随机分配！');
    io.to(myRoom).emit('roomUpdate', pubState(room));
    sids.forEach(sid => {
      io.to(sid).emit('roleAssigned', room.players[sid].role);
    });
  });

  socket.on('ready', () => {
    const room = rooms[myRoom]; if (!room) return;
    room.players[socket.id].ready = true;
    const ps = Object.values(room.players);
    if (ps.length === 4 && ps.every(p => p.ready && p.role)) {
      const roles = ps.map(p => p.role).sort();
      if (JSON.stringify(roles) === '["caroline","jia","ray","xiaoli"]') {
        room.phase = 'JIA_CHOOSE';
        addLog(room, '=== 游戏开始！嘉正在选择… ===');
        io.to(myRoom).emit('phaseChange', room.phase);
      }
    }
    io.to(myRoom).emit('roomUpdate', pubState(room));
  });

  socket.on('cancelReady', () => {
    const room = rooms[myRoom]; if (!room) return;
    room.players[socket.id].ready = false;
    io.to(myRoom).emit('roomUpdate', pubState(room));
  });

  socket.on('jiaChoose', (target) => {
    const room = rooms[myRoom];
    if (!room || room.phase !== 'JIA_CHOOSE' || roleOf(room, socket.id) !== 'jia') return;
    room.jiaTarget = target || null;
    room.phase = 'CAROLINE_CHOOSE';
    addLog(room, '嘉已做出选择。卡洛琳正在选择…');
    io.to(myRoom).emit('phaseChange', room.phase);
    io.to(myRoom).emit('roomUpdate', pubState(room));
  });

  socket.on('carolineChoose', ({ target, announce }) => {
    const room = rooms[myRoom];
    if (!room || room.phase !== 'CAROLINE_CHOOSE' || roleOf(room, socket.id) !== 'caroline') return;
    room.carolineTarget = target;
    room.carolineAnnounce = announce || 'silent';
    room.xiaoliPerception = (room.jiaTarget === 'xiaoli') || (target === 'xiaoli');
    const xSid = sidOf(room, 'xiaoli');
    if (xSid) io.to(xSid).emit('perception', room.xiaoliPerception);
    if (announce === 'public') {
      addLog(room, `卡洛琳公开宣布：她选择了与 ${RN[target]} 发生关系`);
    } else if (announce === 'partner') {
      const pSid = sidOf(room, target);
      if (pSid) io.to(pSid).emit('carolinePrivateMsg', '卡洛琳私下告诉你：她选择了你');
      addLog(room, '卡洛琳已做出选择（未公开）');
    } else {
      addLog(room, '卡洛琳已做出选择（保持沉默）');
    }
    room.phase = 'TESTIMONY_1';
    room.testimonySubmitted = {};
    addLog(room, '--- 第 1 轮证言开始 ---');
    io.to(myRoom).emit('phaseChange', room.phase);
    io.to(myRoom).emit('roomUpdate', pubState(room));
  });

  socket.on('testimony', ({ text, isTrue }) => {
    const room = rooms[myRoom];
    if (!room || !room.phase.startsWith('TESTIMONY_')) return;
    const round = parseInt(room.phase.split('_')[1]);
    const role = roleOf(room, socket.id);
    if (!role || room.testimonySubmitted[role]) return;
    if (role === 'jia') {
      room.jiaStatements[round] = { text, isTrue: !!isTrue };
    } else {
      if (!room.otherStatements[round]) room.otherStatements[round] = {};
      room.otherStatements[round][role] = text || '（沉默）';
    }
    room.testimonySubmitted[role] = true;
    addLog(room, `${RN[role]} 发言了`);
    io.to(myRoom).emit('testimonyData', { round, data: pubTestimony(room, round), submitted: Object.keys(room.testimonySubmitted) });
    if (Object.keys(room.testimonySubmitted).length >= 4) advanceTestimony(room);
  });

  socket.on('skip', () => {
    const room = rooms[myRoom];
    if (!room || !room.phase.startsWith('TESTIMONY_')) return;
    const round = parseInt(room.phase.split('_')[1]);
    const role = roleOf(room, socket.id);
    if (!role || role === 'jia' || room.testimonySubmitted[role]) return;
    if (!room.otherStatements[round]) room.otherStatements[round] = {};
    room.otherStatements[round][role] = '（沉默）';
    room.testimonySubmitted[role] = true;
    addLog(room, `${RN[role]} 选择沉默`);
    io.to(myRoom).emit('testimonyData', { round, data: pubTestimony(room, round), submitted: Object.keys(room.testimonySubmitted) });
    if (Object.keys(room.testimonySubmitted).length >= 4) advanceTestimony(room);
  });

  socket.on('rayQuestion', ({ round, isPublic }) => {
    const room = rooms[myRoom];
    if (!room || room.phase !== 'ABILITY' || roleOf(room, socket.id) !== 'ray' || room.rayQ.done) return;
    room.rayQ = { done: true, round, isPublic, answer: !!room.jiaStatements[round]?.isTrue, skipped: false };
    if (isPublic) {
      addLog(room, `Ray 公开质问：嘉第 ${round} 轮证言是否为真？答案：${room.rayQ.answer ? '真话' : '假话'}`);
      io.to(myRoom).emit('rayQResult', { round, answer: room.rayQ.answer, isPublic: true });
    } else {
      addLog(room, 'Ray 使用了秘密质问');
      io.to(socket.id).emit('rayQResult', { round, answer: room.rayQ.answer, isPublic: false });
      socket.to(myRoom).emit('rayQUsed', { isPublic: false });
    }
    checkAbilityDone(room);
  });

  socket.on('raySkip', () => {
    const room = rooms[myRoom];
    if (!room || room.phase !== 'ABILITY' || roleOf(room, socket.id) !== 'ray' || room.rayQ.done) return;
    room.rayQ.done = true; room.rayQ.skipped = true;
    addLog(room, 'Ray 放弃了质问权');
    io.to(myRoom).emit('rayQUsed', { skipped: true });
    checkAbilityDone(room);
  });

  socket.on('carolineInvestigate', (target) => {
    const room = rooms[myRoom];
    if (!room || room.phase !== 'ABILITY' || roleOf(room, socket.id) !== 'caroline' || room.carolineInv.done) return;
    if (target !== 'ray' && target !== 'xiaoli') return;
    room.carolineInv.target = target;
    room.carolineInv.awaiting = true;
    addLog(room, '卡洛琳正在秘密调查…');
    const tSid = sidOf(room, target);
    if (tSid) io.to(tSid).emit('carolineAsk');
  });

  socket.on('carolineReply', (answer) => {
    const room = rooms[myRoom];
    if (!room || room.phase !== 'ABILITY' || !room.carolineInv.awaiting) return;
    if (roleOf(room, socket.id) !== room.carolineInv.target) return;
    room.carolineInv.done = true;
    room.carolineInv.response = !!answer;
    room.carolineInv.awaiting = false;
    const cSid = sidOf(room, 'caroline');
    io.to(cSid).emit('carolineInvResult', { target: room.carolineInv.target, answer: !!answer });
    addLog(room, '调查回应已完成');
    checkAbilityDone(room);
  });

  socket.on('carolineSkipInv', () => {
    const room = rooms[myRoom];
    if (!room || room.phase !== 'ABILITY' || roleOf(room, socket.id) !== 'caroline' || room.carolineInv.done) return;
    room.carolineInv.done = true; room.carolineInv.skipped = true;
    addLog(room, '卡洛琳放弃了调查权');
    checkAbilityDone(room);
  });

  socket.on('accuse', (data) => {
    const room = rooms[myRoom];
    if (!room || room.phase !== 'ACCUSATION') return;
    const role = roleOf(room, socket.id);
    room.accusations[role] = { jiaPartner: data.jiaPartner, carolinePartner: data.carolinePartner || null };
    addLog(room, `${RN[role]} 已提交指认`);
    io.to(myRoom).emit('accuseCount', Object.keys(room.accusations).length);
    if (Object.keys(room.accusations).length >= 4) {
      room.phase = 'RESULT';
      room.results = resolve(room);
      addLog(room, '=== 游戏结束！===');
      io.to(myRoom).emit('phaseChange', room.phase);
      io.to(myRoom).emit('gameResult', room.results);
    }
  });

  socket.on('restart', () => {
    const room = rooms[myRoom]; if (!room) return;
    const saved = {};
    for (const [s] of Object.entries(room.players)) saved[s] = { role: null, ready: false };
    const fresh = newRoom(room.code);
    fresh.players = saved;
    rooms[myRoom] = fresh;
    io.to(myRoom).emit('phaseChange', 'LOBBY');
    io.to(myRoom).emit('roomUpdate', pubState(fresh));
    addLog(fresh, '房间已重置，可以重新开始');
  });

  socket.on('disconnect', () => {
    if (myRoom && rooms[myRoom]) {
      const room = rooms[myRoom];
      delete room.players[socket.id];
      if (Object.keys(room.players).length === 0) delete rooms[myRoom];
      else {
        addLog(room, '一位玩家断开了连接');
        io.to(myRoom).emit('roomUpdate', pubState(room));
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`牢嘉杀服务器运行于 http://localhost:${PORT}`));