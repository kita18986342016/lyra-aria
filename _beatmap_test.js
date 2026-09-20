// B-1 离线节拍分析链 常驻回归：map 全链（分析→D盘缓存→token→map 源消费）
// 用法：node _beatmap_test.js [port=9223]
// 前置：隔离测试实例（DSH_TEST_INSTANCE=1 DSH_TEST_SLOT=1）+ 测试曲（脚本自动注入）
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TEST_MP3 = 'D:/Music/Downloads/LBI利比 - 跳楼机.mp3';
const DATA_ROOT = 'D:/MusicPlayerData';

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP_TIMEOUT')); } }, 120000);
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
  await ws.send({ method: 'Log.enable' }).catch(() => {});
  const exceptions = [];
  const consoleLines = [];
  ws.onMessage((m) => {
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; exceptions.push((d.exception && d.exception.description) || d.text); }
    if (m.method === 'Runtime.consoleAPICalled') {
      consoleLines.push((m.params.args || []).map((a) => a.value != null ? String(a.value) : (a.description || '')).join(' '));
    }
  });
  async function ev(expression) {
    const r = await ws.send({ method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } });
    if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result && r.result.value;
  }
  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (detail == null ? '' : JSON.stringify(detail).slice(0, 240))); };

  // ---------- 0) 主进程 beatmap 端点（流服务器固定 30000 起，隔离实例无争用） ----------
  const api = await ev(`(async function(){
    var base = 'http://127.0.0.1:30000';
    var st = await (await fetch(base + '/api/beatmap/cache/status?t=' + Date.now())).json();
    var key = '__selftest__/beatmap-' + Date.now();
    var map = { v:1, cameraBeats:[[1,0.7,0.8,0.7,0.6,0.2,0.1,0,7,0.6,0.1,0]], pulseBeats:[], duration:10, tempoSource:'music-tempo', visualBeatCount:1 };
    var wr = await (await fetch(base + '/api/beatmap/cache', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key:key, mode:'mr', provider:'local', title:'selftest', artist:'selftest', map:map }) })).json();
    var rd = await (await fetch(base + '/api/beatmap/cache?key=' + encodeURIComponent(key))).json();
    return { status: st, write: wr, read: { hit: rd.hit, mapOk: !!(rd.map && rd.map.cameraBeats && rd.map.cameraBeats.length === 1) } };
  })()`);
  check('0-1 /api/beatmap/cache/status enabled(disk)', api && api.status && api.status.enabled === true && api.status.mode === 'disk', api && api.status);
  check('0-2 POST 写入 ok', api && api.write && api.write.ok === true, api && api.write && api.write.key);
  check('0-3 GET 回读 hit', api && api.read && api.read.hit === true && api.read.mapOk === true, api && api.read);
  if (api && api.status && api.status.dir) {
    const dirExists = fs.existsSync(api.status.dir);
    check('0-4 缓存目录真实存在（D 盘）', dirExists && /^D:/i.test(api.status.dir), api.status.dir);
  }

  // ---------- 1) 挂舞台 + 注入测试曲 ----------
  const mounted = await ev(`(function(){
    if (window.LyricStage3D && LyricStage3D.active()) return 'already';
    if (window.LyricStage3D && LyricStage3D.failed()) LyricStage3D.resetFailed();
    var cb = document.getElementById('stStage3d'); if (!cb) return 'no-checkbox';
    cb.checked = true; cb.dispatchEvent(new Event('change')); return 'triggered';
  })()`);
  let active = mounted === 'already';
  for (let i = 0; i < 40 && !active; i++) { await sleep(500); active = await ev(`!!(window.LyricStage3D && LyricStage3D.active())`); }
  check('1-1 3D 舞台挂载', active, 'trigger=' + mounted);

  // ---------- 1b) bundle 函数与依赖桩就位（须舞台挂载后——bundle 懒加载） ----------
  const env = await ev(`({
    sba: typeof scheduleBeatAnalysis,
    bmsk: typeof beatMapSongKey,
    rbdc: typeof readBeatDiskCache,
    wbdc: typeof writeBeatDiskCache,
    amtw: typeof analyzeMusicTempoInWorker,
    apiJson: typeof apiJson,
    pack: typeof packLocalBeatMap,
    unpack: typeof unpackLocalBeatMap,
    spk: typeof songProviderKey,
    chip: typeof showBeatChip,
    tempoGlobal: typeof window.MusicTempo
  })`);
  check('1b-1 节拍链函数全部就位', ['sba','bmsk','rbdc','wbdc','amtw','apiJson','pack','unpack','spk','chip'].every(k => env[k] === 'function'), env);
  check('1b-2 music-tempo script 预载生效', env.tempoGlobal === 'function', { tempoGlobal: env.tempoGlobal });

  const songId = 'local:selftest-' + (global.__b1run = (global.__b1run || Date.now()));
  await ev(`(async function(){
    var st = window.__mp.state;
    st.queue = [{ id:${JSON.stringify(songId)}, title:'B1自测曲', artist:'本地', path:${JSON.stringify(TEST_MP3)}, online:false, localKey:${JSON.stringify(TEST_MP3)}, duration:201711 }];
    st.queueIndex = 0;
    await window.__mp.playList(st.queue, 0, 0, true, true, true);
    return 'ok';
  })()`);
  let playing = false;
  for (let i = 0; i < 30; i++) { await sleep(500); playing = await ev(`!!(window.audio && !window.audio.paused && window.audio.currentTime > 0.5)`); if (playing) break; }
  check('2-2 测试曲播放中', playing, { srcOk: await ev(`!!(window.audio && window.audio.src)`) });

  // ---------- 3) 分析全链：token bump → currentBeatMap 非空 → map 源消费 ----------
  const t0 = await ev(`beatMapToken`);
  const hooked = await ev(`({ key: mrBeatHookSongId || null, timer: !!beatAnalysisTimer, token: beatMapToken })`);
  check('3-1 换歌 hook 触发（token bump + 分析排队）', hooked.key && hooked.timer === true && hooked.token >= t0, hooked);
  let mapOk = null;
  for (let i = 0; i < 100; i++) { // 最多 100s：整曲 3.9 万文件 fetch+decode+worker 分析
    await sleep(1000);
    mapOk = await ev(`({ has: !!currentBeatMap, cam: currentBeatMap && currentBeatMap.cameraBeats ? currentBeatMap.cameraBeats.length : 0, src: currentBeatMap && currentBeatMap.tempoSource, busy: beatMapBusy })`);
    if (mapOk && mapOk.has && mapOk.cam >= 4) break;
  }
  check('3-2 currentBeatMap 产出（cameraBeats≥4）', mapOk && mapOk.has === true && mapOk.cam >= 4, mapOk);
  const readyForCam = await ev(`(currentBeatMap && currentBeatMap.cameraBeats && currentBeatMap.cameraBeats.length >= 4)`);
  check('3-3 beatMapReadyForCamera 条件满足', !!readyForCam, readyForCam ? '≥4 cameraBeats' : 'cameraBeats 不足');
  const stats = await ev(`({ map: beatCam.stats.map, live: beatCam.stats.live, idx: beatCam.nextIdx, cam: currentBeatMap.cameraBeats.length, t: audio.currentTime })`);
  // map 游标在 apply 时对齐到当前播放点，拍点须等播放推进过去才计数 → 轮询最多 40s
  let statsOk = stats.map > 0;
  for (let i = 0; !statsOk && i < 40; i++) {
    await sleep(1000);
    const s2 = await ev(`beatCam.stats.map`);
    statsOk = s2 > 0;
    if (statsOk) stats.map = s2;
  }
  check('3-4 拍点走 map 源（stats.map>0）', statsOk, stats);

  // ---------- 4) D 盘缓存命中（重播验证）：先 bump 内存缓存与 token 强制走磁盘 ----------
  await ev(`(async function(){
    // 等 writeBeatDiskCache 落地（handoff 里异步写）
    var st = await (await fetch('http://127.0.0.1:30000/api/beatmap/cache?key=' + encodeURIComponent(mrBeatHookSongId))).json();
    return st.hit;
  })()`).then(async (hitDisk) => {
    check('4-1 分析结果已写 D 盘缓存', hitDisk === true, { key: await ev(`mrBeatHookSongId`), hitDisk });
  });
  const cleared = await ev(`(function(){ delete beatMapCache[mrBeatHookSongId]; currentBeatMap = null; beatMapToken++; var t = beatMapToken; scheduleBeatAnalysis(mrBeatHookSongId, audio.src, t, window.__mp.state.queue[0]); return t; })()`);
  let hitLog = false, mapAgain = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    hitLog = consoleLines.some((l) => /D盘节拍缓存命中/.test(l));
    mapAgain = await ev(`!!(currentBeatMap && currentBeatMap.cameraBeats && currentBeatMap.cameraBeats.length >= 4)`);
    if (hitLog && mapAgain) break;
  }
  check('4-2 清内存重播 → 日志出现「D盘节拍缓存命中」', hitLog, { hitLog, mapAgain });
  check('4-3 磁盘 map 回读重建 cameraBeats', mapAgain, mapAgain);

  // ---------- 5) 换歌 token 守卫：A→B 连切，旧分析结果不得污染新歌 ----------
  const before = await ev(`({ token: beatMapToken, key: mrBeatHookSongId })`);
  await ev(`(async function(){
    var st = window.__mp.state;
    st.queue = [
      { id:'${songId}', title:'B1自测曲', artist:'本地', path:${JSON.stringify(TEST_MP3)}, online:false, localKey:${JSON.stringify(TEST_MP3)}, duration:201711 },
      { id:'local:selftestB', title:'B1自测曲B', artist:'本地', path:${JSON.stringify(TEST_MP3)}, online:false, localKey:'fileB-never-analyzed', duration:201711 }
    ];
    await window.__mp.playList(st.queue, 1, 0, true, true, true);
    return 1;
  })()`);
  // playing 事件驱动：等 hook 消费新歌
  let tokenTest = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    tokenTest = await ev(`({ beforeToken: ${before.token}, afterToken: beatMapToken, beforeKey: ${JSON.stringify(before.key)}, newKey: mrBeatHookSongId, oldMapGone: !(currentBeatMap && currentBeatMap === beatMapCache[${JSON.stringify(before.key)}]) })`);
    if (tokenTest.newKey !== before.key) break;
  }
  check('5-1 换歌 bump token 且 key 切换', tokenTest && tokenTest.afterToken > tokenTest.beforeToken && tokenTest.newKey !== tokenTest.beforeKey, tokenTest);
  let afterB = null;
  for (let i = 0; i < 45; i++) { // B 的分析链：1.6s 延迟 + minPlayback 1.2s + 解码/缓存回读 → 轮询最多 45s
    afterB = await ev(`({ curKey: mrBeatHookSongId, curMap: !!currentBeatMap && beatMapCache[mrBeatHookSongId] === currentBeatMap, cam: currentBeatMap ? currentBeatMap.cameraBeats.length : 0 })`);
    if (afterB.curMap) break;
    await sleep(1000);
  }
  check('5-2 新歌 map 归属正确（无旧 map 残留）', afterB && afterB.curMap === true && afterB.cam >= 4, afterB);

  // ---------- 6) 异常与收敛 ----------
  await sleep(2000);
  const finalEx = exceptions.filter((e) => !/favicon/i.test(e));
  check('6-1 全程零未捕获异常', finalEx.length === 0, finalEx.length ? finalEx[0].split('\n')[0] : 0);

  // ---------- 7) 恢复环境：卸载舞台、停播 ----------
  await ev(`(function(){ try { var cb = document.getElementById('stStage3d'); if (cb && cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change')); } } catch(e){} return 1; })()`);
  await sleep(800);

  const fails = results.filter((r) => !r.pass);
  console.log('---');
  console.log(fails.length ? `BEATMAP_TEST: ${results.length - fails.length}/${results.length} PASS` : `BEATMAP_TEST: ${results.length}/${results.length} ALL PASS`);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error('BEATMAP_TEST_FATAL', e); process.exit(1); });
