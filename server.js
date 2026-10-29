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

const PORT = process.env.PORT || 8080;
const MAX_HP = 100;

/* ================= 静态文件服务 ================= */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
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
const players = new Map();   // id -> {conn,name,team,hp,alive,kills,deaths,x,y,z}

function send(conn, obj) { try { conn.send(JSON.stringify(obj)); } catch (e) { } }
function broadcast(obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const [id, p] of players) if (id !== exceptId && !p.conn.closed) { try { p.conn.send(s); } catch (e) { } }
}
function roster() {
  return [...players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, hp: p.hp, alive: p.alive, kills: p.kills, deaths: p.deaths }));
}
function pickTeam() {
  let a = 0, b = 0;
  for (const p of players.values()) (p.team === 0 ? a++ : b++);
  return a <= b ? 0 : 1;
}
function scoreList() {
  return roster().sort((x, y) => y.kills - x.kills || x.deaths - y.deaths);
}

function handleConn(conn) {
  let me = null;
  conn.on('message', data => {
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch (e) { return; }
    if (!me && m.t !== 'join') return;

    switch (m.t) {
      case 'join': {
        const id = nextId++;
        me = {
          id, conn, name: String(m.name || ('玩家' + id)).slice(0, 12),
          team: (m.team === 0 || m.team === 1) ? m.team : pickTeam(),
          hp: MAX_HP, alive: true, kills: 0, deaths: 0, x: 0, y: 0, z: 0
        };
        players.set(id, me);
        send(conn, { t: 'welcome', id, team: me.team, players: roster(), scores: scoreList(), time: Date.now() });
        broadcast({ t: 'join', p: { id, name: me.name, team: me.team, hp: MAX_HP, alive: true, kills: 0, deaths: 0 } }, id);
        broadcast({ t: 'scores', list: scoreList() });
        break;
      }
      case 's': {
        me.x = m.p[0]; me.y = m.p[1]; me.z = m.p[2];
        broadcast({ t: 's', id: me.id, p: m.p, ry: m.ry, rx: m.rx, wep: m.wep, mv: m.mv, alive: m.alive }, me.id);
        break;
      }
      case 'shoot':
        broadcast({ t: 'shoot', id: me.id, o: m.o, d: m.d, wep: m.wep }, me.id);
        break;
      case 'hit': {
        const target = players.get(m.id);
        if (!target || !target.alive || !me.alive) break;
        const dmg = Math.max(1, Math.min(200, Math.round(m.dmg)));
        target.hp -= dmg;
        send(target.conn, { t: 'dmg', by: me.id, dmg, hp: Math.max(0, target.hp), weapon: m.wep, head: !!m.head, from: [me.x, me.y, me.z] });
        send(conn, { t: 'hitc', id: target.id, dmg, head: !!m.head, kill: target.hp <= 0 });
        if (target.hp <= 0) {
          target.hp = 0; target.alive = false; target.deaths++; me.kills++;
          broadcast({ t: 'kill', by: me.id, victim: target.id, weapon: m.wep, head: !!m.head });
          broadcast({ t: 'scores', list: scoreList() });
        }
        break;
      }
      case 'respawn': {
        me.hp = MAX_HP; me.alive = true;
        broadcast({ t: 'respawn', id: me.id }, me.id);
        broadcast({ t: 'scores', list: scoreList() });
        break;
      }
      case 'chat':
        broadcast({ t: 'chat', id: me.id, name: me.name, msg: String(m.msg).slice(0, 80) });
        break;
      case 'ping':
        send(conn, { t: 'pong', ts: m.ts });
        break;
    }
  });

  conn.on('close', () => {
    if (me && players.get(me.id) === me) {
      players.delete(me.id);
      broadcast({ t: 'leave', id: me.id });
      broadcast({ t: 'scores', list: scoreList() });
    }
  });
}

/* 每秒广播一次比分（用于计时/战绩板） */
setInterval(() => {
  if (players.size) broadcast({ t: 'scores', list: scoreList(), time: Date.now() });
}, 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  火线对决 · LAN 对战服务器已启动');
  console.log('==============================================');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        console.log('  联机地址:  http://' + ni.address + ':' + PORT);
      }
    }
  }
  console.log('  本机地址:  http://localhost:' + PORT);
  console.log('  局域网玩家在浏览器输入上面的联机地址即可加入');
  console.log('==============================================');
});