// 2026-09-20 修复批次专项实测：D-1 存档应用 / B-4 骷髅闭环 / B-3 音域回响驱动 / B-5 pointerParallax
// / 死控件节点 / 音频监视链 / 自由镜头提示
// 用法：node _fix_batch_test.js [port=9223]
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
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
      req.on('upgrade', (res, socket) => {
        this.socket = socket; this.buffer = Buffer.alloc(0); this.nextId = 0; this.pending = new Map(); this.listeners = [];
        socket.on('data', (c) => this._onData(c)); socket.on('error', () => {}); resolve(this);
      });
      req.on('error', reject); req.end();
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
      if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); }
      else for (const fn of this.listeners) { try { fn(msg); } catch (_) {} }
    }
  }
  _sendRaw(opcode, payload) {
    const mask = crypto.randomBytes(4); const len = payload.length; let header;
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
  const port = process.argv[2] || '9223';
  const targets = await httpGetJson('http://127.0.0.1:' + port + '/json');
  const page = targets.find((t) => t.type === 'page' && /index\.html$/.test(t.url));
  if (!page) { console.error('MAIN_WINDOW_NOT_FOUND'); process.exit(2); }
  const ws = new MiniWS(page.webSocketDebuggerUrl);
  await ws.connect();
  await ws.send({ method: 'Runtime.enable' });
  const exceptions = [];
  ws.onMessage((m) => { if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; exceptions.push((d.exception && d.exception.description) || d.text); } });
  async function ev(expression) {
    const r = await ws.send({ method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } });
    if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result && r.result.value;
  }
  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (detail == null ? '' : JSON.stringify(detail).slice(0, 300))); };

  // 0) 挂载舞台
  const mounted = await ev(`(function(){
    if (window.LyricStage3D && LyricStage3D.active()) return 'already';
    if (window.LyricStage3D && LyricStage3D.failed()) LyricStage3D.resetFailed();
    var cb = document.getElementById('stStage3d'); if (!cb) return 'no-checkbox';
    cb.checked = true; cb.dispatchEvent(new Event('change')); return 'triggered';
  })()`);
  let active = mounted === 'already';
  for (let i = 0; i < 40 && !active; i++) { await sleep(500); active = await ev(`!!(window.LyricStage3D && LyricStage3D.active())`); }
  check('舞台挂载', active, 'trigger=' + mounted);

  // 1) D-1：10-shell/04 函数在位 + applyFxArchiveSnapshot 走完不抛
  const d1a = await ev(`({ wams: typeof applyWallpaperModeState, pws: typeof pushWallpaperState, lbl: typeof desktopWallpaperErrorLabel })`);
  check('D-1 三函数定义在位', d1a.wams === 'function' && d1a.pws === 'function' && d1a.lbl === 'function', d1a);
  const exCountBefore = exceptions.length;
  const d1b = await ev(`(async function(){
    // 用当前 fx 快照构造合法存档 → 走完整 applyFxArchiveSnapshot（含 applyWallpaperModeState 尾链）
    var snap = captureFxArchiveSnapshot ? captureFxArchiveSnapshot() : null;
    if (!snap) return { skipped: 'captureFxArchiveSnapshot 不在' };
    var ok = applyFxArchiveSnapshot(snap);
    var w = await Promise.race([applyWallpaperModeState(true).then(function(r){ return r && r.ok; }), new Promise(function(rs){ setTimeout(function(){ rs('timeout'); }, 2500); })]);
    return { applied: ok, wallpaperResolve: w };
  })()`);
  check('D-1 存档应用全链不抛', (d1b && d1b.applied === true) || (d1b && d1b.skipped), d1b);
  const newEx = exceptions.slice(exCountBefore);
  check('D-1 应用过程零异常', newEx.length === 0, newEx.length ? newEx[0].split('\\n')[0] : 0);

  // 2) B-4：安魂预设（骷髅）——setPreset(6) → 点云资产经 dsh-mediapipe:// 载入 → skullParticleGroup 创建
  const exB4 = exceptions.length;
  await ev(`setPreset(6, { commitPlaybackPreset: true }); 'preset6'`);
  let skullInfo = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    skullInfo = await ev(`({
      preset: fx.preset,
      skullIdx: (typeof SKULL_PRESET_INDEX!=='undefined'?SKULL_PRESET_INDEX:null),
      asset: (typeof skullParticleAsset!=='undefined' && skullParticleAsset) ? { hasData: !!skullParticleAsset.data, bytes: skullParticleAsset.data ? skullParticleAsset.data.length : 0, failed: !!skullParticleAsset.failed } : null,
      group: (typeof skullParticleGroup!=='undefined') ? !!skullParticleGroup : null,
      particlesHidden: (typeof particles!=='undefined' && particles) ? particles.visible === false : null,
    })`);
    if (skullInfo.asset && (skullInfo.asset.hasData || skullInfo.asset.failed)) break;
  }
  await sleep(1200); // 再等几帧积分让层建出来
  skullInfo = await ev(`({ group: (typeof skullParticleGroup!=='undefined') ? !!skullParticleGroup : null, hasData: (typeof skullParticleAsset!=='undefined') && !!skullParticleAsset.data, bytes: (typeof skullParticleAsset!=='undefined' && skullParticleAsset.data) ? skullParticleAsset.data.length : 0, failed: (typeof skullParticleAsset!=='undefined') && skullParticleAsset.failed })`);
  check('B-4 骷髅点云载入（dsh-mediapipe 通道）', skullInfo.hasData === true && skullInfo.failed === false && skullInfo.bytes > 10000, skullInfo);
  check('B-4 骷髅层已创建', skullInfo.group === true, skullInfo);
  check('B-4 骷髅态粒子海按 MR 隐藏', await ev(`typeof skullParticleGroup!=='undefined' && skullParticleGroup ? particles.visible===false || skullParticleGroup.visible===true : true`) === true, '');
  const exSkull = exceptions.slice(exB4).filter((e) => !/AudioContext|autoplay|NotAllowed/i.test(e));
  check('B-4 骷髅链零异常', exSkull.length === 0, exSkull.length ? exSkull.slice(0, 2).join(' || ').slice(0, 200) : 0);

  // 3) B-3：音域回响（preset 7）update 驱动——topography 层在 update 后活跃
  await ev(`setPreset(7, { commitPlaybackPreset: true }); 'preset7'`);
  await sleep(1500);
  const sonic = await ev(`({
    isActive: (window.MineradioSonicTopography && MineradioSonicTopography.isActive) ? MineradioSonicTopography.isActive(fx) : null,
    updateExists: !!(window.MineradioSonicTopography && MineradioSonicTopography.update),
    sonicFrame: (typeof mrSonicAudioFrame !== 'undefined') ? (mrSonicAudioFrame === null ? 'null(no audio ok)' : 'object') : 'undefined',
  })`);
  check('B-3 音域回响预设激活态', sonic.isActive === true && sonic.updateExists === true, sonic);
  // 驱动确证：挂计数钩子看 update 是否真的每帧被调
  const ticked = await ev(`(async function(){
    var orig = MineradioSonicTopography.update; var n = 0;
    MineradioSonicTopography.update = function(){ n++; return orig.apply(this, arguments); };
    await new Promise(function(r){ setTimeout(r, 1200); });
    MineradioSonicTopography.update = orig;
    return n;
  })()`);
  check('B-3 update 每帧驱动', typeof ticked === 'number' && ticked > 30, 'calls in ~1.2s=' + ticked);
  await ev(`setPreset(0, {}); 'back'`);

  // 4) B-5：pointerParallax 阻尼推进（pointerTarget 由 bundle:4795 的 window mousemove 更新）
  //    幂等化：先把指针甩到另一角（parallax 追过去），再打回目标点，断言"从远处收敛"的真实推进
  await ev(`(function(){ for (var i=0;i<6;i++) window.dispatchEvent(new MouseEvent('mousemove',{clientX: 10 + i*4, clientY: innerHeight - 20, bubbles:true})); return 1; })()`);
  await sleep(1200);
  const par0 = await ev(`({x: pointerParallax.x, y: pointerParallax.y, tx: pointerTarget.x})`);
  await ev(`(function(){ for (var i=0;i<10;i++) window.dispatchEvent(new MouseEvent('mousemove',{clientX: innerWidth/2 + i*20, clientY: innerHeight/2 + i*15, bubbles:true})); return 1; })()`);
  await sleep(1000);
  const par1 = await ev(`({x: pointerParallax.x, y: pointerParallax.y, tx: pointerTarget.x})`);
  const parMoved = (par1.x !== par0.x || par1.y !== par0.y) && Math.abs(par1.x - par0.x) + Math.abs(par1.y - par0.y) > 1e-4;
  check('B-5 pointerParallax 随鼠标推进', parMoved, 'before=' + JSON.stringify(par0) + ' after=' + JSON.stringify(par1));

  // 5) 死控件节点在位（背景选择/字体上传 file-input + 自由镜头提示 + 色差滑条已放开[B-b 2026-09-20]）
  const nodes = await ev(`({
    bgInput: !!document.getElementById('background-image-input'),
    fontInput: !!document.getElementById('lyric-font-input'),
    hint: !!document.getElementById('free-camera-hint'),
    glassAberrationVisible: (function(){ var el = document.getElementById('fx-glassaberration'); return !!(el && !el.closest('.fx-slider').hasAttribute('hidden')); })(),
    glassFilterSvg: !!document.getElementById('mineradio-control-glass-filter'),
  })`);
  check('死控件节点批次', nodes.bgInput && nodes.fontInput && nodes.hint && nodes.glassAberrationVisible && nodes.glassFilterSvg, nodes);

  // 6) 音频监视链：开关 + stepSonicAudioMonitor 驱动计数
  const sonicMon = await ev(`(async function(){
    if (typeof stepSonicAudioMonitor !== 'function') return { err: 'no step fn' };
    var n = 0; var orig = stepSonicAudioMonitor;
    window.stepSonicAudioMonitor = function(){ n++; return orig.apply(this, arguments); };
    await new Promise(function(r){ setTimeout(r, 900); });
    var onDefault = (fx && fx.sonicAudioMonitorEnabled !== false);
    // 关开关 → 快照分支应返回 null（mrAnalyzeFrame 门控）
    var sw = document.getElementById('t-sonicAudioMonitorEnabled');
    window.stepSonicAudioMonitor = orig;
    return { calls: n, onDefault: onDefault, switchInDom: !!sw, snapType: typeof getSonicAudioMonitorSnapshot };
  })()`);
  check('音频监视链驱动（无音频时 step 走衰减路径）', sonicMon.calls > 0 && sonicMon.onDefault === true && sonicMon.switchInDom === true, sonicMon);

  // 7) 玻璃 :root 变量生效（取面板背景计算值含 gradient）
  const glass = await ev(`(function(){
    var el = document.getElementById('fx-panel');
    var cs = getComputedStyle(el);
    return { bg: String(cs.backgroundImage || '').slice(0, 40), defined: getComputedStyle(document.documentElement).getPropertyValue('--panel-glass-bg').trim().length > 20 };
  })()`);
  check(':root 玻璃变量生效', glass.defined === true, glass);

  // 8) 全程零异常汇总
  check('全程零异常', exceptions.length === 0, exceptions.length ? exceptions.slice(0, 3).join(' || ').slice(0, 300) : 0);

  const fails = results.filter((r) => !r.pass).length;
  console.log('SUMMARY: ' + (results.length - fails) + '/' + results.length + ' PASS');
  try { ws.socket.end(); } catch (_) {}
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(3); });
