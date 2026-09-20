// 真实输入链验证：用 CDP Input 域（受信任事件，走浏览器真实命中测试）验证拖转，
// 与 _cam_cdp_test.js 的合成 dispatchEvent（绕过命中测试）互补。
// 用法：node _cam_cdp_input_test.js [port]（默认 9223；实例需 DSH_TEST_INSTANCE=1 隔离启动或独立环境）
const http = require('http');
const crypto = require('crypto');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class MiniWS {
  constructor(url) { this.url = url; }
  connect() {
    return new Promise((resolve, reject) => {
      const key = Buffer.from(crypto.randomBytes(16)).toString('base64');
      const u = new URL(this.url);
      const req = http.request({
        host: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
      });
      req.on('upgrade', (res, socket) => {
        this.socket = socket; this.buffer = Buffer.alloc(0); this.nextId = 0;
        this.pending = new Map(); this.listeners = [];
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', () => {});
        resolve(this);
      });
      req.on('error', reject);
      req.end();
    });
  }
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      if (this.buffer.length < offset + len) return;
      const payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);
      if (opcode === 0x8) { this.closed = true; try { this.socket.end(); } catch (_) {} return; }
      if (opcode === 0x9) { this._sendRaw(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else {
        for (const fn of this.listeners) { try { fn(msg); } catch (_) {} }
      }
    }
  }
  _sendRaw(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    try { this.socket.write(Buffer.concat([header, mask, masked])); } catch (_) {}
  }
  send(obj) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._sendRaw(0x1, Buffer.from(JSON.stringify({ ...obj, id }), 'utf8'));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP_TIMEOUT')); } }, 60000);
    });
  }
  onMessage(fn) { this.listeners.push(fn); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const port = process.argv[2] || 9223;
  const targets = await httpGetJson('http://127.0.0.1:' + port + '/json');
  const page = targets.find((t) => t.type === 'page' && /index\.html$/.test(t.url));
  if (!page) { console.error('MAIN_WINDOW_NOT_FOUND'); process.exit(2); }
  const ws = new MiniWS(page.webSocketDebuggerUrl);
  await ws.connect();
  await ws.send({ method: 'Runtime.enable' });
  const exceptions = [];
  ws.onMessage((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push((d.exception && d.exception.description) || d.text);
    }
  });
  async function ev(expression) {
    const r = await ws.send({ method: 'Runtime.evaluate', params: { expression, returnByValue: true } });
    if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result && r.result.value;
  }
  async function input(type, x, y, opts) {
    await ws.send({ method: 'Input.dispatchMouseEvent', params: Object.assign({ type, x: Math.round(x), y: Math.round(y), button: 'left' }, opts || {}) });
  }
  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (detail == null ? '' : detail)); };

  // 挂载舞台
  await ev(`(function(){
    if (window.LyricStage3D && LyricStage3D.active()) return 'already';
    if (window.LyricStage3D && LyricStage3D.failed()) LyricStage3D.resetFailed();
    var cb = document.getElementById('stStage3d');
    if (!cb) return 'no-checkbox';
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    return 'triggered';
  })()`);
  let active = false;
  for (let i = 0; i < 40 && !active; i++) { await sleep(500); active = await ev(`!!(window.LyricStage3D && LyricStage3D.active())`); }
  check('3D 舞台挂载', active, '');

  // 命中测试身份：真实点击位置的最顶层元素是谁
  const hit = await ev(`(function(){
    const pts = [[innerWidth*0.5, innerHeight*0.38],[innerWidth*0.5, innerHeight*0.6],[innerWidth*0.3, innerHeight*0.5],[innerWidth*0.7, innerHeight*0.3]];
    return pts.map(([x,y]) => {
      const el = document.elementFromPoint(x, y);
      const path = [];
      let n = el; for (let i=0;i<4&&n;i++){ path.push(n.id ? '#'+n.id : (n.className&&typeof n.className==='string' ? '.'+n.className.split(' ')[0] : n.tagName)); n = n.parentElement; }
      return { x: Math.round(x), y: Math.round(y), tag: el && el.tagName, isCanvas: el === (window.renderer && renderer.domElement), path: path.join('<') };
    });
  })()`);
  for (const h of hit) console.log('  HIT', h.x + ',' + h.y, '->', h.isCanvas ? 'CANVAS' : (h.tag + ' | ' + h.path));
  check('命中测试落在 canvas', hit.every((h) => h.isCanvas), '');

  // 真实输入拖转
  const rot0 = await ev(`particles.rotation.y`);
  const cw = await ev(`innerWidth`), ch = await ev(`innerHeight`);
  const sx = Math.round(cw * 0.5), sy = Math.round(ch * 0.38);
  await input('mouseMoved', sx, sy, { buttons: 0 });          // 先移入
  await input('mousePressed', sx, sy, { buttons: 1, clickCount: 1 });
  await sleep(80);
  const pressState = await ev(`({ rotating: orbit.rotating, trust: null })`);
  check('真实按下 → rotating=true', pressState.rotating === true, '');

  for (let round = 0; round < 3; round++) {
    for (let i = 1; i <= 12; i++) {
      await input('mouseMoved', sx + (round * 12 + i) * 14, sy, { buttons: 1 });
    }
    await sleep(50);
  }
  await sleep(350);
  const rot1 = await ev(`({ rotY: particles.rotation.y, spin: typeof particleSpin !== 'undefined' ? particleSpin.vy : null })`);
  const dRot = Math.abs(rot1.rotY - rot0);
  check('真实拖动 → 视觉组转动', dRot > 0.08, 'Δ=' + dRot.toFixed(3) + ' rad（' + (dRot / Math.PI * 180).toFixed(0) + '°）惯性vy=' + rot1.spin);

  await input('mouseReleased', sx + 500, sy, { buttons: 0, clickCount: 1 });
  const up = await ev(`orbit.rotating`);
  check('真实松开 → rotating=false', up === false, '');

  check('全程零异常', exceptions.length === 0, exceptions.slice(0, 2).join('||').slice(0, 200));
  const fails = results.filter((r) => !r.pass).length;
  console.log('SUMMARY: ' + (results.length - fails) + '/' + results.length + ' PASS');
  try { ws.socket.end(); } catch (_) {}
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(3); });
