// Minimal CDP client over raw WebSocket (no deps)
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 10086);
const mode = process.argv[2] || 'list';

function httpJson(path) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 8000 }, r => {
      let b = '';
      r.setEncoding('utf8');
      r.on('data', d => b += d);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error('bad json: ' + b.slice(0, 300))); } });
    });
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
    req.on('error', rej);
  });
}

class WS {
  constructor(port, path) {
    this.port = port; this.path = path; this.buf = Buffer.alloc(0);
    this.frag = []; this.waiters = new Map(); this.id = 0; this.ready = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = net.connect(this.port, '127.0.0.1', () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: 127.0.0.1:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let handshook = false;
      this.sock.on('data', d => {
        if (!handshook) {
          this.buf = Buffer.concat([this.buf, d]);
          const idx = this.buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = this.buf.slice(0, idx).toString();
          if (!/101/.test(head)) return reject(new Error('handshake failed: ' + head.slice(0, 100)));
          this.buf = this.buf.slice(idx + 4);
          handshook = true; this.ready = true; resolve();
          this._drain();
          return;
        }
        this.buf = Buffer.concat([this.buf, d]);
        this._drain();
      });
      this.sock.on('error', reject);
    });
  }
  _drain() {
    while (true) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (op === 0x8) { this.sock.end(); return; }
      if (op === 0x9) { this._frame(0xA, payload); continue; }
      if (op === 0x0) this.frag.push(payload);
      else this.frag = [payload];
      if (fin) {
        const data = Buffer.concat(this.frag); this.frag = [];
        try {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.id && this.waiters.has(msg.id)) { this.waiters.get(msg.id)(msg); this.waiters.delete(msg.id); }
        } catch (e) {}
      }
    }
  }
  _frame(op, payload) {
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.from([0x80 | op, 0x80 | len]); }
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  send(obj, timeoutMs = 180000) {
    const id = ++this.id;
    const data = Buffer.from(JSON.stringify({ id, ...obj }), 'utf8');
    const CH = 60000;
    for (let i = 0; i < data.length; i += CH) {
      const chunk = data.slice(i, i + CH);
      const op = i === 0 ? 0x1 : 0x0;
      const last = i + CH >= data.length;
      const len = chunk.length;
      let head;
      if (len < 126) head = Buffer.from([(last ? 0x80 : 0) | op, 0x80 | len]);
      else if (len < 65536) { head = Buffer.alloc(4); head[0] = (last ? 0x80 : 0) | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
      else { head = Buffer.alloc(10); head[0] = (last ? 0x80 : 0) | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
      const mask = crypto.randomBytes(4);
      const masked = Buffer.alloc(len);
      for (let k = 0; k < len; k++) masked[k] = chunk[k] ^ mask[k % 4];
      this.sock.write(Buffer.concat([head, mask, masked]));
    }
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiters.delete(id); rej(new Error('timeout')); }, timeoutMs);
      this.waiters.set(id, m => { clearTimeout(t); res(m); });
    });
  }
  close() { try { this.sock.end(); } catch (e) {} }
}

async function main() {
  if (mode === 'list') {
    const list = await httpJson('/json/list');
    console.log(JSON.stringify(list.map(x => ({ id: x.id, title: x.title, url: x.url })), null, 2));
    return;
  }
  const list = await httpJson('/json/list');
  if (!list.length) throw new Error('no page');
  const page = list[0];
  const ws = new WS(PORT, new URL(page.webSocketDebuggerUrl).pathname);
  await ws.connect();
  const ev = async (expr, awaitPromise = true) => {
    const r = await ws.send({ method: 'Runtime.evaluate', params: { expression: expr, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true, userGesture: true } });
    if (r.error) throw new Error(JSON.stringify(r.error));
    const res = r.result;
    if (res.exceptionDetails) return { exception: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
    return res.result?.value;
  };
  if (mode === 'eval') {
    const out = await ev(process.argv[3]);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } else if (mode === 'file') {
    const code = fs.readFileSync(process.argv[3], 'utf8');
    const out = await ev(code);
    console.log(JSON.stringify(out, null, 2));
  }
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
