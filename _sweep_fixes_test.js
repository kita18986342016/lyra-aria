// 抓虫修复全量验证（P0-1/P1-1/P1-2/P1-3/P1-4/P1-5/P2-1/P2-3 + 卡拉OK Bug#1）
// 用法：node _sweep_fixes_test.js [port=9224]
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
  _raw(op, payload) {
    const mask = crypto.randomBytes(4), len = payload.length;
    let h;
    if (len < 126) h = Buffer.from([0x80 | op, 0x80 | len]);
    else { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    try { this.socket.write(Buffer.concat([h, mask, masked])); } catch (_) {}
  }
  onMessage(fn) { this.listeners.push(fn); }
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
  const port = process.argv[2] || '9224';
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

  // 挂载
  await ev(`(function(){ if(window.LyricStage3D && !LyricStage3D.active()){ var cb=document.getElementById('stStage3d'); cb.checked=true; cb.dispatchEvent(new Event('change')); } return 1; })()`);
  let active = false;
  for (let i = 0; i < 40 && !active; i++) { await sleep(500); active = await ev(`!!(window.LyricStage3D && LyricStage3D.active())`); }
  check('舞台挂载', active);

  // P0-1: WE 模态有样式且初始不可见
  const mod = await ev(`(function(){
    var m = document.getElementById('wallpaper-engine-modal');
    if (!m) return { missing: true };
    var cs = getComputedStyle(m);
    return { cls: m.className, display: cs.display, position: cs.position, bg: cs.background.slice(0, 30), zIndex: cs.zIndex,
      hitCenter: (function(){ var el = document.elementFromPoint(innerWidth/2, innerHeight*0.35); return el ? (el.id || el.className || el.tagName) : 'none'; })() };
  })()`);
  check('P0-1 WE模态默认不可见且有样式', !mod.missing && (mod.display === 'none' || mod.cls.indexOf('show') < 0) && mod.position === 'fixed', JSON.stringify(mod));

  // P0-1b: 打开/关闭
  const openClose = await ev(`(function(){
    openWallpaperEngineLibrary();
    var m = document.getElementById('wallpaper-engine-modal');
    var opened = m.classList.contains('show');
    closeWallpaperEngineLibrary();
    var closed = !m.classList.contains('show');
    return { opened: opened, closed: closed };
  })()`);
  check('P0-1b WE模态可开可关', openClose.opened && openClose.closed, JSON.stringify(openClose));

  // P2-3: Esc 关模态不退舞台
  await ev(`openWallpaperEngineLibrary(); document.getElementById('wallpaper-engine-modal').classList.add('show'); 1`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}))`);
  await sleep(200);
  const esc = await ev(`({ modalOpen: document.getElementById('wallpaper-engine-modal').classList.contains('show'), stageOn: !!(window.LyricStage3D && LyricStage3D.active()) })`);
  check('P2-3 Esc只关模态不退舞台', !esc.modalOpen && esc.stageOn, JSON.stringify(esc));

  // P1-3: tab 栏 6 个全部可见
  const tabs = await ev(`(function(){
    var bar = document.getElementById('fx-panel-tabs');
    if (!bar) return { missing: true };
    return { scrollW: bar.scrollWidth, clientW: bar.clientWidth, count: bar.querySelectorAll('button').length };
  })()`);
  check('P1-3 tab栏不溢出', !tabs.missing && tabs.scrollW <= tabs.clientW + 2 && tabs.count === 6, JSON.stringify(tabs));

  // P1-4（2026-09-20 更新）：控制台 1:1 复刻 MR——#fx-fab 右下圆钮在位、点击开面板（peek 同步加类）、
  // 面板圆角浮动不占满侧栏；旧"抽屉+DIY 按钮显隐"形态已废弃
  const fab = await ev(`(function(){
    var f = document.getElementById('fx-fab');
    if (!f) return { err: 'no fx-fab' };
    var fr = f.getBoundingClientRect();
    var round = getComputedStyle(f).borderRadius;
    var p = document.getElementById('fx-panel');
    var wasPeek = p.classList.contains('peek') || p.classList.contains('show');
    if (typeof toggleFxPanel === 'function') toggleFxPanel(true);
    var opened = p.classList.contains('peek') || p.classList.contains('show');
    var panelRound = getComputedStyle(p).borderRadius;
    var pr = p.getBoundingClientRect();
    var panelNotFullHeight = pr.height < innerHeight * 0.95;
    // 注意：right 有 .55s 过渡（peek 刚加类时 rect 在动画中间）→ 用不随动画变化的宽度断言"浮动卡不占满"
    var panelFloatWidth = pr.width >= 400 && pr.width <= 460;
    if (!wasPeek && typeof toggleFxPanel === 'function') toggleFxPanel(false);
    return { fabVisible: fr.width > 40 && fr.height > 40, fabRound: round, opened: opened,
      panelRound: panelRound, panelNotFullHeight: panelNotFullHeight, panelFloatWidth: panelFloatWidth };
  })()`);
  check('P1-4 控制台=MR 浮动圆角卡+右下圆钮', fab.fabVisible === true && parseFloat(fab.fabRound) >= 20 && fab.opened === true && parseFloat(fab.panelRound) >= 12 && fab.panelNotFullHeight === true && fab.panelFloatWidth === true, JSON.stringify(fab));

  // P1-5: stBar/stWinCtrl 不在抽屉内
  const loc = await ev(`({
    stBarParent: document.getElementById('stBar') ? document.getElementById('stBar').parentElement.id : 'missing',
    stWinParent: document.getElementById('stWinCtrl') ? document.getElementById('stWinCtrl').parentElement.id : 'missing',
    fxPanelCount: document.querySelectorAll('#fx-panel').length
  })`);
  check('P1-5 播放条/窗口键在抽屉外', loc.stBarParent !== 'mrFxDrawer' && loc.stWinParent !== 'mrFxDrawer' && loc.fxPanelCount === 1, JSON.stringify(loc));

  // P1-2: 浮空粒子层真开关（先确保初始为关，再开）
  const fl = await ev(`(function(){
    if (fx.floatLayer) toggleFx('floatLayer');
    var before = fx.floatLayer;
    toggleFx('floatLayer');
    return { before: before, after: fx.floatLayer, groupCreated: !!floatGroup };
  })()`);
  check('P1-2 浮空粒子层真生效', fl.before === false && fl.after === true && fl.groupCreated, JSON.stringify(fl));

  // P1-1: getDesktopWindowApi 已定义（导入 JSON 不再抛错）
  const gapi = await ev(`({ fn: typeof getDesktopWindowApi, val: !!getDesktopWindowApi() })`);
  check('P1-1 getDesktopWindowApi 就位', gapi.fn === 'function' && gapi.val === true, JSON.stringify(gapi));

  // 卡拉OK Bug#1: 英文行首带空格 token
  const en = await ev(`(function(){
    var segs = [{ t: 1, chars: [{ ch: ' hello ', t: 1 }, { ch: 'world', t: 1.3 }] }];
    var lrc = [{ t: 1, text: 'hello world' }];
    mrSetLrc(lrc, segs, null);
    var line = (window.lyricsLines || [])[0];
    mrSetLrc([{ t: 1, text: '恢复' }], null, null);
    return { hasWords: !!(line && line.words && line.words.length === 2), words: line && line.words };
  })()`);
  check('卡拉OK英文行逐字恢复', en.hasWords === true, JSON.stringify(en.words));

  check('全程零异常', exceptions.length === 0, exceptions.slice(0, 2).join('||').slice(0, 200));
  const fails = results.filter((x) => !x).length;
  console.log('SUMMARY: ' + (results.length - fails) + '/' + results.length + ' PASS');
  try { ws.socket.end(); } catch (_) {}
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(3); });
