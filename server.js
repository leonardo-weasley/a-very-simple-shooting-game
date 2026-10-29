#!/usr/bin/env node
/**
 * 火线对决 · LAN 对战服务器
 * 零依赖（内置极简 WebSocket 实现），Node.js 14+ 即可运行
 * 用法：  node server.js        然后浏览器打开 http://<本机IP>:8080
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const MAX_HP = 100;
const MATCH_DURATION = (Number(process.env.MATCH_MINUTES) || 20) * 60; // 默认 20 分钟（1200 秒）

/* 人数上限：支持命令行 `node server.js 12` / `--max=12` 或环境变量 `MAX_PLAYERS=12` */
function parseInitialMaxPlayers() {
  const arg = process.argv.slice(2).find(a => /^(--max=|\d+$)/.test(a));
  const raw = arg ? (arg.startsWith('--max=') ? arg.slice(6) : arg) : process.env.MAX_PLAYERS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(2, Math.min(32, n)) : 10;
}
let maxPlayers = parseInitialMaxPlayers();

function clampMaxPlayers(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return maxPlayers;
  return Math.max(2, Math.min(32, v));
}

function getLanAddresses() {
  const real = [], fallback = [];
  const nets = os.networkInterfaces();
  const virtualRe = /vethernet|wsl|hyper-v|vmware|vbox|virtualbox|docker|tap|tun|loopback|hamachi|zerotier|tailscale/i;
  for (const name of Object.keys(nets)) {
    const isVirt = virtualRe.test(name);
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) {
        (isVirt ? fallback : real).push(ni.address);
      }
    }
  }
  const all = real.length ? real : fallback;
  all.sort((a, b) => (a.startsWith('192.168.') ? -1 : 1) - (b.startsWith('192.168.') ? -1 : 1));
  return all;
}

function isLocalSocket(reqOrSocket) {
  const addr = (reqOrSocket.socket ? reqOrSocket.socket.remoteAddress : reqOrSocket.remoteAddress) || '';
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return true;
  const clean = addr.replace(/^::ffff:/, '');
  return getLanAddresses().includes(clean);
}

/* ================= 静态文件 & 房间信息接口 ================= */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function teamCounts() {
  let a = 0, b = 0;
  for (const p of players.values()) (p.team === 0 ? a++ : b++);
  return [a, b];
}

function roomSummary(req) {
  const ips = getLanAddresses();
  const urls = ips.map(ip => 'http://' + ip + ':' + PORT);
  return {
    port: PORT,
    maxPlayers,
    count: players.size,
    teams: teamCounts(),
    lanUrls: urls,
    primaryUrl: urls[0] || ('http://localhost:' + PORT),
    isHost: req ? isLocalSocket(req) : false,
    players: roster()
  };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/api/info' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(roomSummary(req)));
    return;
  }
  if (p === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { if (body.length < 4096) body += c; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (data.maxPlayers !== undefined) {
          maxPlayers = clampMaxPlayers(data.maxPlayers);
          broadcast({ t: 'room', maxPlayers, count: players.size, teams: teamCounts() });
          broadcast({ t: 'scores', list: scoreList(), maxPlayers, count: players.size });
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(roomSummary(req)));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Bad Request' }));
      }
    });
    return;
  }

  if (p === '/') p = '/index.html';
  const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(__dirname, safe);
  if (!file.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ================= 极简 WebSocket 实现 ================= */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.h = {};
    this.frag = null;
    this.closed = false;
    socket.on('data', d => this._data(d));
    socket.on('close', () => this._close());
    socket.on('error', () => this._close());
    socket.setNoDelay(true);
  }
  on(ev, fn) { this.h[ev] = fn; return this; }
  _emit(ev, a) { if (this.h[ev]) this.h[ev](a); }
  _close() { if (this.closed) return; this.closed = true; this._emit('close'); }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const f = this._frame();
      if (!f) break;
      this._frameIn(f);
    }
  }
  _frame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const mlen = masked ? 4 : 0;
    if (b.length < off + mlen + len) return null;
    let payload = b.subarray(off + mlen, off + mlen + len);
    if (masked) {
      const mask = b.subarray(off, off + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    this.buf = b.subarray(off + mlen + len);
    return { fin, opcode, payload };
  }
  _frameIn(f) {
    if (f.opcode === 0x8) { this.close(); return; }
    if (f.opcode === 0x9) { this._send(0xA, f.payload); return; }
    if (f.opcode === 0xA) return;
    if (f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0) {
      this.frag = this.frag ? Buffer.concat([this.frag, f.payload]) : f.payload;
      if (f.fin) { const d = this.frag; this.frag = null; this._emit('message', d); }
    }
  }
  send(str) { this._send(0x1, Buffer.from(str, 'utf8')); }
  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { }
  }
  close() {
    if (!this.closed) { try { this._send(0x8, Buffer.alloc(0)); } catch (e) { } }
    try { this.socket.end(); } catch (e) { }
    this._close();
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  handleConn(new WSConn(socket));
});

/* ================= 游戏逻辑 ================= */
let nextId = 1;
const players = new Map();   // id -> {conn,name,team,hp,alive,kills,deaths,x,y,z,ry,rx,wep,mv,crouch,lastSeen}
let matchStartTime = null;   // 当前对局开始时间戳(ms)
let matchOver = false;

function getElapsedSeconds() {
  if (!matchStartTime) return 0;
  return Math.min(MATCH_DURATION, Math.max(0, Math.floor((Date.now() - matchStartTime) / 1000)));
}
function teamKills() {
  let k0 = 0, k1 = 0;
  for (const p of players.values()) {
    if (p.team === 0) k0 += p.kills || 0;
    else k1 += p.kills || 0;
  }
  return [k0, k1];
}
function resetMatch() {
  matchStartTime = players.size ? Date.now() : null;
  matchOver = false;
  for (const p of players.values()) {
    p.hp = MAX_HP; p.alive = true; p.kills = 0; p.deaths = 0;
    p.x = p.team === 0 ? -38 : 38; p.y = 0; p.z = 0;
  }
}

function send(conn, obj) { try { conn.send(JSON.stringify(obj)); } catch (e) { } }
function broadcast(obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const [id, p] of players) if (id !== exceptId && !p.conn.closed) { try { p.conn.send(s); } catch (e) { } }
}
function serializePlayer(p) {
  return {
    id: p.id, name: p.name, team: p.team, hp: p.hp, alive: p.alive,
    kills: p.kills, deaths: p.deaths,
    x: p.x, y: p.y, z: p.z, ry: p.ry, rx: p.rx, wep: p.wep, mv: p.mv, crouch: p.crouch
  };
}
function roster() {
  return [...players.values()].map(serializePlayer);
}
function pickTeam(preferred) {
  /* 一旦玩家选择了指定阵营（0 或 1），严格锁定为该阵营，不再被自动平衡篡改；仅当选择“自动分配”时按人数平衡 */
  if (preferred === 0 || preferred === 1) return preferred;
  const [a, b] = teamCounts();
  return a <= b ? 0 : 1;
}
function uniqueName(raw, id) {
  const base = String(raw || ('战士' + id)).trim().slice(0, 12) || ('战士' + id);
  const taken = new Set([...players.values()].map(p => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 99; i++) {
    const cand = (base.slice(0, 9) + '#' + i);
    if (!taken.has(cand)) return cand;
  }
  return base;
}
function scoreList() {
  return roster().sort((x, y) => y.kills - x.kills || x.deaths - y.deaths);
}

function handleConn(conn) {
  let me = null;
  conn.on('message', data => {
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch (e) { return; }
    if (me) me.lastSeen = Date.now();
    if (!me && m.t !== 'join') return;

    switch (m.t) {
      case 'join': {
        if (me) break;
        if (players.size >= maxPlayers) {
          send(conn, { t: 'reject', reason: '房间人数已满（' + players.size + '/' + maxPlayers + '），请稍后再试或调大上限' });
          setTimeout(() => conn.close(), 80);
          break;
        }
        const id = nextId++;
        const pref = (m.team === 0 || m.team === 1) ? m.team : -1;
        const team = pickTeam(pref);
        const spawnX = team === 0 ? -38 : 38;
        const spawnYaw = team === 0 ? -Math.PI / 2 : Math.PI / 2;
        if (m.maxPlayers !== undefined && players.size === 0) {
          maxPlayers = clampMaxPlayers(m.maxPlayers);
        }
        if (!matchStartTime || matchOver) {
          matchStartTime = Date.now();
          matchOver = false;
        }
        me = {
          id, conn, name: uniqueName(m.name, id),
          team,
          hp: MAX_HP, alive: true, kills: 0, deaths: 0,
          x: spawnX, y: 0, z: 0, ry: spawnYaw, rx: 0, wep: 'ak47', mv: 0, crouch: 0,
          lastSeen: Date.now()
        };
        players.set(id, me);
        const ips = getLanAddresses();
        send(conn, {
          t: 'welcome', id, name: me.name, team: me.team,
          maxPlayers, count: players.size,
          elapsed: getElapsedSeconds(), duration: MATCH_DURATION,
          lanUrls: ips.map(ip => 'http://' + ip + ':' + PORT),
          players: roster(), scores: scoreList(), time: Date.now()
        });
        broadcast({ t: 'join', p: serializePlayer(me) }, id);
        broadcast({ t: 'room', maxPlayers, count: players.size, teams: teamCounts() });
        broadcast({ t: 'scores', list: scoreList(), maxPlayers, count: players.size, elapsed: getElapsedSeconds(), duration: MATCH_DURATION });
        break;
      }
      case 's': {
        if (matchOver) break;
        if (Array.isArray(m.p) && m.p.length >= 3) {
          me.x = +m.p[0] || 0; me.y = +m.p[1] || 0; me.z = +m.p[2] || 0;
        }
        me.ry = +m.ry || 0; me.rx = +m.rx || 0;
        me.wep = m.wep || me.wep; me.mv = m.mv ? 1 : 0; me.crouch = m.crouch ? 1 : 0;
        broadcast({
          t: 's', id: me.id, p: [me.x, me.y, me.z],
          ry: me.ry, rx: me.rx, wep: me.wep, mv: me.mv, crouch: me.crouch, alive: me.alive
        }, me.id);
        break;
      }
      case 'shoot':
        if (!matchOver) broadcast({ t: 'shoot', id: me.id, o: m.o, d: m.d, wep: m.wep }, me.id);
        break;
      case 'hit': {
        if (matchOver) break;
        const target = players.get(m.id);
        if (!target || !target.alive || !me.alive || target.team === me.team) break;
        const dmg = Math.max(1, Math.min(200, Math.round(m.dmg)));
        target.hp -= dmg;
        send(target.conn, { t: 'dmg', by: me.id, dmg, hp: Math.max(0, target.hp), weapon: m.wep, head: !!m.head, from: [me.x, me.y, me.z] });
        send(conn, { t: 'hitc', id: target.id, dmg, head: !!m.head, kill: target.hp <= 0 });
        if (target.hp <= 0) {
          target.hp = 0; target.alive = false; target.deaths++; me.kills++;
          broadcast({ t: 'kill', by: me.id, victim: target.id, weapon: m.wep, head: !!m.head });
          broadcast({ t: 'scores', list: scoreList(), maxPlayers, count: players.size, elapsed: getElapsedSeconds(), duration: MATCH_DURATION });
        }
        break;
      }
      case 'respawn': {
        if (matchOver) break;
        me.hp = MAX_HP; me.alive = true;
        if (Array.isArray(m.p) && m.p.length >= 3) {
          me.x = +m.p[0] || 0; me.y = +m.p[1] || 0; me.z = +m.p[2] || 0;
        }
        broadcast({ t: 'respawn', id: me.id, p: [me.x, me.y, me.z] }, me.id);
        broadcast({ t: 'scores', list: scoreList(), maxPlayers, count: players.size, elapsed: getElapsedSeconds(), duration: MATCH_DURATION });
        break;
      }
      case 'restart': {
        if (matchOver) {
          resetMatch();
          broadcast({ t: 'restart', elapsed: 0, duration: MATCH_DURATION, list: scoreList() });
        }
        break;
      }
      case 'config': {
        if (m.maxPlayers !== undefined) {
          maxPlayers = clampMaxPlayers(m.maxPlayers);
          broadcast({ t: 'room', maxPlayers, count: players.size, teams: teamCounts(), by: me.name });
          broadcast({ t: 'scores', list: scoreList(), maxPlayers, count: players.size });
        }
        break;
      }
      case 'chat': {
        const raw = String(m.msg || '').trim().slice(0, 80);
        if (!raw) break;
        const match = raw.match(/^\/max\s+(\d+)$/i);
        if (match) {
          maxPlayers = clampMaxPlayers(match[1]);
          broadcast({ t: 'room', maxPlayers, count: players.size, teams: teamCounts(), by: me.name });
          broadcast({ t: 'chat', id: 0, name: '系统', sys: true, msg: me.name + ' 将房间人数上限调整为 ' + maxPlayers + ' 人' });
          break;
        }
        broadcast({ t: 'chat', id: me.id, name: me.name, team: me.team, msg: raw });
        break;
      }
      case 'ping':
        send(conn, { t: 'pong', ts: m.ts });
        break;
    }
  });

  conn.on('close', () => {
    if (me && players.get(me.id) === me) {
      players.delete(me.id);
      broadcast({ t: 'leave', id: me.id, name: me.name });
      broadcast({ t: 'room', maxPlayers, count: players.size, teams: teamCounts() });
      broadcast({ t: 'scores', list: scoreList(), maxPlayers, count: players.size });
    }
  });
}

/* 每秒广播一次比分（用于计时/战绩板）、检查 20 分钟对局结束，并清理断线僵尸连接 */
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of players) {
    if (p.conn.closed || (now - p.lastSeen > 25000)) {
      p.conn.close();
      players.delete(id);
      broadcast({ t: 'leave', id, name: p.name });
    }
  }
  if (!players.size) {
    matchStartTime = null;
    matchOver = false;
    return;
  }
  const elapsed = getElapsedSeconds();
  if (!matchOver && elapsed >= MATCH_DURATION) {
    matchOver = true;
    const [k0, k1] = teamKills();
    const winner = k0 > k1 ? 0 : (k1 > k0 ? 1 : -1);
    broadcast({
      t: 'gameover',
      winner,
      teamKills: [k0, k1],
      list: scoreList(),
      elapsed: MATCH_DURATION,
      duration: MATCH_DURATION
    });
  }
  broadcast({ t: 'scores', list: scoreList(), maxPlayers, count: players.size, elapsed, duration: MATCH_DURATION, time: now });
}, 1000);

/* 控制台可随时输入数字或 `max 12` 调整最大人数 */
if (process.stdin && process.stdin.on) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    const line = String(chunk || '').trim();
    const m = line.match(/^(?:max\s+)?(\d+)$/i);
    if (m) {
      maxPlayers = clampMaxPlayers(m[1]);
      console.log('  [配置] 房间最大人数已更新为: ' + maxPlayers + ' 人');
      broadcast({ t: 'room', maxPlayers, count: players.size, teams: teamCounts(), by: '服务器' });
    }
  });
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLanAddresses()[0] || 'localhost';
  console.log('==============================================');
  console.log('  火线对决 · LAN 对战服务器已启动');
  console.log('  游戏入口:  http://' + ip + ':' + PORT);
  console.log('  最大人数:  ' + maxPlayers + ' 人（控制台输入 "max 12" 或网页端可直接修改）');
  console.log('==============================================');
});