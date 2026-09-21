// 桌面歌词锁定钮专项（2026-09-20 圆钮+悬停气泡改版）：真 Input 事件驱动 :hover + 点击解锁链。
// 与 _cam_cdp_input_test.js 同思路：CDP Input 域=受信任事件（真实命中测试），合成 dispatchEvent 测不了 CSS :hover。
// 用法：node _lockbar_test.js [port]（默认 9223；实例需 DSH_TEST_INSTANCE=1 隔离启动）
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
  const page = targets.find((t) => t.type === 'page' && /lyric-win\.html$/.test(t.url));
  if (!page) { console.error('LYRIC_WINDOW_NOT_FOUND'); process.exit(2); }
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
  const forceHover = () => ev(`document.body.classList.add('hover')`); // 主进程轮询只对真实光标发 hoverui，测试里强制进入悬停显形态

  // ① 结构与样式：button 在前（气泡靠 #unlockBtn:hover ~ 兄弟选择器）、白底圆钮、气泡 pointer-events:none
  // 先把鼠标移到远处：CDP 连接断了但渲染进程的 hover 状态跨连接残留，不重置会污染首项断言
  await input('mouseMoved', 4, 140, { buttons: 0 });
  await sleep(120);
  forceHover(); await sleep(120);
  const st = await ev(`(function(){
    const bar = document.getElementById('lockbar');
    const btn = document.getElementById('unlockBtn');
    const hint = document.getElementById('lockHint');
    const bs = getComputedStyle(btn), hs = getComputedStyle(hint);
    return {
      btnFirst: bar.firstElementChild === btn && hint.previousElementSibling === btn,
      circle: bs.borderRadius === '50%' || bs.borderRadius === '14px',
      whiteBg: bs.backgroundColor.indexOf('255') >= 0,
      barVisible: getComputedStyle(bar).display !== 'none',
      hintHidden: hs.display === 'none',
      hintNoPointer: hs.pointerEvents === 'none',
      locked: document.body.classList.contains('locked'),
    };
  })()`);
  check('结构：按钮在前、气泡在后', st && st.btnFirst === true, JSON.stringify(st));
  check('样式：白底圆形独立钮（无胶囊壳）', st && st.circle && st.whiteBg && st.barVisible, '');
  check('气泡默认隐藏 + pointer-events:none', st && st.hintHidden && st.hintNoPointer, '');

  // ② 锁定态：真 Input 悬停到钮上 → 气泡出现 + 文案随状态
  const rect = await ev(`(function(){ const r = document.getElementById('unlockBtn').getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width }; })()`);
  check('按钮几何合理（28px 圆）', rect && rect.w >= 26 && rect.w <= 32, 'w=' + rect.w);
  await input('mouseMoved', 10, rect.y + 60, { buttons: 0 }); // 先移到远处再移入，确保 hover 状态真实切换
  await sleep(60);
  await input('mouseMoved', rect.x, rect.y, { buttons: 0 });
  await sleep(120);
  const hov1 = await ev(`({ shown: getComputedStyle(document.getElementById('lockHint')).display, text: document.getElementById('lockHint').textContent })`);
  check('锁定态：悬停钮 → 气泡显示', hov1 && hov1.shown === 'block', JSON.stringify(hov1));
  check('锁定态：气泡文案=点击解锁', hov1 && /点击解锁/.test(hov1.text), hov1.text);
  await input('mouseMoved', 10, rect.y + 60, { buttons: 0 });
  await sleep(120);
  const hov2 = await ev(`getComputedStyle(document.getElementById('lockHint')).display`);
  check('移开按钮 → 气泡收起', hov2 === 'none', 'display=' + hov2);

  // ③ 点击解锁链（真 Input click）：锁定→解锁，图标/文案/窗口态全切
  await input('mouseMoved', rect.x, rect.y, { buttons: 0 });
  await sleep(80);
  await input('mousePressed', rect.x, rect.y, { buttons: 1, clickCount: 1 });
  await sleep(40);
  await input('mouseReleased', rect.x, rect.y, { buttons: 0, clickCount: 1 });
  await sleep(500); // 等 applyConfig + 窗口高度回收
  const un = await ev(`(function(){
    return {
      locked: document.body.classList.contains('locked'),
      text: document.getElementById('lockHint').textContent,
      openLock: document.getElementById('unlockBtn').innerHTML.indexOf('9.9-1') >= 0, // ICON_UNLOCK 开锁弧线特征（ICON_LOCK 是 '10 0v4'）
    };
  })()`);
  check('点击 → 解锁（body.locked 移除）', un && un.locked === false, JSON.stringify(un));
  check('解锁态：文案/图标切换', un && un.text === '重新锁定' && un.openLock === true, '');
  await sleep(150);
  const hov3 = await ev(`getComputedStyle(document.getElementById('lockHint')).display`);
  check('解锁态：悬停钮气泡仍在（重新锁定）', hov3 === 'block', 'display=' + hov3);

  // ④ 点击恢复锁定（测试实例配置还原）
  forceHover();
  await input('mouseMoved', rect.x, rect.y, { buttons: 0 });
  await sleep(80);
  await input('mousePressed', rect.x, rect.y, { buttons: 1, clickCount: 1 });
  await sleep(40);
  await input('mouseReleased', rect.x, rect.y, { buttons: 0, clickCount: 1 });
  await sleep(500);
  const re = await ev(`({ locked: document.body.classList.contains('locked'), text: document.getElementById('lockHint').textContent })`);
  check('再点 → 恢复锁定 + 文案还原', re && re.locked === true && /点击解锁/.test(re.text), JSON.stringify(re));

  check('全程零异常', exceptions.length === 0, exceptions.slice(0, 2).join('||').slice(0, 200));
  const fails = results.filter((r) => !r.pass).length;
  console.log('SUMMARY: ' + (results.length - fails) + '/' + results.length + ' PASS');
  try { ws.socket.end(); } catch (_) {}
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(3); });
