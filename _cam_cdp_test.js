// 镜头交互 CDP 实测（2026-09-19 还原度对齐一期）：拖转 360°/惯性/快捷键/零异常/光标隐藏
// 用法：node _cam_cdp_test.js（需已启动 electron . --remote-debugging-port=9222）
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
  const targets = await httpGetJson('http://127.0.0.1:' + (process.argv[2] || '9222') + '/json');
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
  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (detail == null ? '' : detail)); };

  // 0) 确保 3D 舞台挂载（bundle 在 mount 时才注入；开启开关并等 boot）
  const mounted = await ev(`(function(){
    if (window.LyricStage3D && LyricStage3D.active()) return 'already';
    if (window.LyricStage3D && LyricStage3D.failed()) LyricStage3D.resetFailed();
    var cb = document.getElementById('stStage3d');
    if (!cb) return 'no-checkbox';
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    return 'triggered';
  })()`);
  let active = mounted === 'already';
  if (!active && mounted === 'triggered') {
    for (let i = 0; i < 40 && !active; i++) {
      await sleep(500);
      active = await ev(`!!(window.LyricStage3D && LyricStage3D.active())`);
    }
  }
  check('3D 舞台挂载', active, 'trigger=' + mounted + ' active=' + active + (active ? '' : '（若 failed，查 LyricStage3D.failed 与 bootErrors）'));

  // 0b) 环境函数就位（mount 后 bundle 才执行）
  const env = await ev(`({
    upd: typeof updateControlsAutoHideFromPointer,
    down: typeof idleGuidePointerDown,
    up: typeof idleGuidePointerUp,
    toast: typeof showToast,
    cursor: typeof revealCursorForActivity,
    peek: typeof setPeek,
    orbit: typeof orbit !== 'undefined' && !!orbit,
    renderer: typeof renderer !== 'undefined' && !!renderer && !!renderer.domElement,
    bottomBar: !!document.getElementById('bottom-bar'),
  })`);
  check('环境函数', env.upd === 'function' && env.down === 'function' && env.up === 'function' && env.toast === 'function' && env.cursor === 'function' && env.peek === 'function', JSON.stringify(env));

  // 1) mousemove 洪泛：不再抛 ReferenceError
  await ev(`(function(){ for (let i=0;i<20;i++) window.dispatchEvent(new MouseEvent('mousemove',{clientX:100+i*4,clientY:200,buttons:0})); return true; })()`);
  await sleep(300);
  check('mousemove 零异常', exceptions.length === 0, 'exceptions=' + exceptions.length + (exceptions[0] ? ' first=' + exceptions[0].split('\n')[0] : ''));

  // 2) 拖转：mousedown → rotating=true → theta 变化 → mouseup
  const before = await ev(`(function(){
    const x = Math.round(innerWidth*0.5), y = Math.round(innerHeight*0.38);
    renderer.domElement.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:y,button:0,buttons:1}));
    return { rotating: orbit.rotating, theta: orbit.theta, w: innerWidth, h: innerHeight };
  })()`);
  check('mousedown → orbit.rotating=true', before.rotating === true, 'theta0=' + before.theta);

  for (let round = 0; round < 3; round++) {
    await ev(`(function(){
      const y = Math.round(innerHeight*0.38);
      for (let i=0;i<24;i++) window.dispatchEvent(new MouseEvent('mousemove',{clientX:${before.w * 0.5}+i*18,clientY:y,buttons:1}));
      return true;
    })()`);
    await sleep(60);
  }
  await sleep(400); // 等 rAF 把 gestureRotation 阻尼积分进 particles.rotation
  const during = await ev(`({ rotY: particles.rotation.y, rotX: particles.rotation.x, spinVx: (typeof particleSpin!=='undefined'?particleSpin.vx:null), spinVy: (typeof particleSpin!=='undefined'?particleSpin.vy:null) })`);
  const dRot = Math.abs(during.rotY);
  check('拖转改变视觉组方位', dRot > 0.08, 'particles.rotation.y=' + during.rotY.toFixed(3) + ' rad（' + (dRot / Math.PI * 180).toFixed(0) + '°）');
  check('粒子惯性甩动获得速度', during.spinVx !== null && (Math.abs(during.spinVx) > 0.0001 || Math.abs(during.spinVy) > 0.0001), 'vx=' + during.spinVx + ' vy=' + during.spinVy);

  await ev(`window.dispatchEvent(new MouseEvent('mouseup',{clientX:${before.w * 0.5}+600,clientY:${Math.round(before.h * 0.38)},buttons:0}))`);
  const after = await ev(`({ rotating: orbit.rotating })`);
  check('mouseup → rotating=false', after.rotating === false, '');

  // 3) K 回正（MR 设计：自由镜头态→平滑回正 toast；普通态→orbit 回正 toast；locked 有持久化，二选一即正确）
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyK',key:'k',bubbles:true,cancelable:true}))`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyK',key:'k',bubbles:true}))`);
  await sleep(300);
  const k1 = await ev(`({ locked: orbit.centerLocked, toast: (document.getElementById('toast')||{}).textContent })`);
  const kOk = k1.locked === true || k1.toast === '自由镜头正在平滑回正' || k1.toast === '视角回正';
  check('K 回正生效', kOk, 'centerLocked=' + k1.locked + ' toast="' + k1.toast + '"');

  // 4) R 自由镜头开/关
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyR',key:'r',bubbles:true}))`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyR',key:'r',bubbles:true}))`);
  const fcOn = await ev(`freeCamera.active`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyR',key:'r',bubbles:true}))`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyR',key:'r',bubbles:true}))`);
  const fcOff = await ev(`freeCamera.active`);
  check('R 自由镜头开/关', fcOn === true && fcOff === false, 'active on=' + fcOn + ' off=' + fcOff);

  // 5) 光标 idle 自动隐藏（2.5s 无活动后 body.cursor-hidden）
  await ev(`window.dispatchEvent(new MouseEvent('mousemove',{clientX:300,clientY:300}))`);
  await sleep(3000);
  const cur = await ev(`document.body.classList.contains('cursor-hidden')`);
  check('光标 idle 自动隐藏', cur === true, 'cursor-hidden=' + cur);

  check('全程零异常', exceptions.length === 0, exceptions.length ? exceptions.slice(0, 3).join(' || ').slice(0, 300) : 'exceptions=0');

  const fails = results.filter((r) => !r.pass).length;
  console.log('SUMMARY: ' + (results.length - fails) + '/' + results.length + ' PASS');
  try { ws.socket.end(); } catch (_) {}
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(3); });
