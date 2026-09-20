// 二期 3a+3d 快速验证：工作台 tab 生成 / fx 滑杆绑定生效 / 缓存面板真实数据
// 用法：node _ui_workspace_test.js [port=9223]
const http = require('http');
const crypto = require('crypto');
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
class MiniWS {
  constructor(url) { this.url = url; }
  connect() {
    return new Promise((resolve, reject) => {
      const key = Buffer.from(crypto.randomBytes(16)).toString('base64');
      const u = new URL(this.url);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
      req.on('upgrade', (res, socket) => {
        this.socket = socket; this.buffer = Buffer.alloc(0); this.nextId = 0; this.pending = new Map(); this.listeners = [];
        socket.on('data', (c) => this._onData(c)); socket.on('error', () => {});
        resolve(this);
      });
      req.on('error', reject); req.end();
    });
  }
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0], b1 = this.buffer[1], op = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); off = 10; }
      if (this.buffer.length < off + len) return;
      const p = this.buffer.subarray(off, off + len); this.buffer = this.buffer.subarray(off + len);
      if (op === 0x8) { this.closed = true; return; }
      if (op === 0x9) { this._raw(0xA, p); continue; }
      if (op === 0xA) continue;
      let m; try { m = JSON.parse(p.toString('utf8')); } catch (_) { continue; }
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
      else this.listeners.forEach((f) => { try { f(m); } catch (_) {} });
    }
  }
  onMessage(fn) { this.listeners.push(fn); }
  _raw(op, payload) {
    const mask = crypto.randomBytes(4), len = payload.length;
    let h;
    if (len < 126) h = Buffer.from([0x80 | op, 0x80 | len]);
    else { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    try { this.socket.write(Buffer.concat([h, mask, masked])); } catch (_) {}
  }
  send(obj) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._raw(0x1, Buffer.from(JSON.stringify({ ...obj, id })));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP_TIMEOUT')); } }, 60000);
    });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const port = process.argv[2] || '9223';
  const targets = await httpGetJson(`http://127.0.0.1:${port}/json`);
  const page = targets.find((t) => t.type === 'page' && /index\.html$/.test(t.url));
  if (!page) { console.error('MAIN_WINDOW_NOT_FOUND'); process.exit(2); }
  const ws = new MiniWS(page.webSocketDebuggerUrl);
  await ws.connect();
  await ws.send({ method: 'Runtime.enable' });
  const exceptions = [];
  ws.onMessage((m) => { if (m.method === 'Runtime.exceptionThrown') exceptions.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text); });
  const ev = async (expression) => {
    const r = await ws.send({ method: 'Runtime.evaluate', params: { expression, returnByValue: true } });
    if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text };
    return r.result && r.result.value;
  };
  const results = [];
  const check = (n, p, d) => { results.push(p); console.log((p ? 'PASS' : 'FAIL') + ' | ' + n + ' | ' + (d || '')); };

  await ev(`(function(){ if (window.LyricStage3D && !LyricStage3D.active()) { var cb=document.getElementById('stStage3d'); cb.checked=true; cb.dispatchEvent(new Event('change')); } return 1; })()`);
  let active = false;
  for (let i = 0; i < 40 && !active; i++) { await sleep(500); active = await ev(`!!(window.LyricStage3D && LyricStage3D.active())`); }
  check('舞台挂载(bundle 已加载)', active);

  const wsState = await ev(`({
    tabs: document.querySelectorAll('#fx-panel-tabs button').length,
    toolbar: !!document.getElementById('fx-console-toolbar'),
    search: !!document.getElementById('fx-console-search'),
    pages: document.querySelectorAll('[id^=fx-console-page-]').length,
    entries: (typeof fxConsoleRegistry !== 'undefined' ? fxConsoleRegistry.length : -1),
  })`);
  check('工作台 tab 条生成', wsState.tabs >= 4 && wsState.toolbar, JSON.stringify(wsState));

  const slider = await ev(`(function(){
    var el = document.getElementById('fx-intensity');
    if (!el) return { missing: true };
    var before = fx.intensity;
    el.value = '1.4';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { before: before, after: fx.intensity, out: el.nextElementSibling && el.nextElementSibling.textContent };
  })()`);
  check('fx 滑杆绑定生效', slider.after === 1.4 && slider.before !== 1.4, 'before=' + slider.before + ' after=' + slider.after);
  await ev(`(function(){ var el=document.getElementById('fx-intensity'); el.value=String(slider_before||''); function R(v){return v} fx.intensity = ${JSON.stringify(1)}; return 1; })()`).catch(() => {});
  await ev(`fx.intensity = 1; var el = document.getElementById('fx-intensity'); el.value='1'; el.dispatchEvent(new Event('input',{bubbles:true}));`);

  await sleep(600); // 缓存面板 setTimeout(450) 自动刷新
  const cache = await ev(`({
    root: (document.getElementById('cache-storage-root')||{}).textContent,
    total: (document.getElementById('cache-storage-total')||{}).textContent,
    lyrics: (document.getElementById('cache-storage-lyrics-size')||{}).textContent,
    chromium: (document.getElementById('cache-storage-chromium-size')||{}).textContent,
    wallpaper: (document.getElementById('cache-storage-wallpaper-size')||{}).textContent,
    note: (document.getElementById('cache-storage-note')||{}).textContent,
  })`);
  check('缓存面板显示真实数据', cache.root && cache.root !== '—' && /已占用/.test(cache.total || ''), JSON.stringify(cache));

  check('全程零异常', exceptions.length === 0, exceptions.slice(0, 2).join('||').slice(0, 200));
  const fails = results.filter((x) => !x).length;
  console.log('SUMMARY: ' + (results.length - fails) + '/' + results.length + ' PASS');
  try { ws.socket.end(); } catch (_) {}
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(3); });
