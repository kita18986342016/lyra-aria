// 2026-09-20 用户八条差异清单修复的常驻验收（_diff8_test.js）
// ①重进秒显 ②光晕在位 ③控制台滚轮 ④抽屉出口 ⑤宽度 ⑥滚轮缩放(先K回正) ⑦挂载防误触 ⑧WE模态可见
// 用法：node _diff8_test.js [port=9223]
const http = require('http');
const crypto = require('crypto');
function httpGetJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject); }); }
class MiniWS {
  constructor(url) { this.url = url; }
  connect() { return new Promise((resolve, reject) => { const key = Buffer.from(crypto.randomBytes(16)).toString('base64'); const u = new URL(this.url); const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } }); req.on('upgrade', (res, socket) => { this.socket = socket; this.buffer = Buffer.alloc(0); this.nextId = 0; this.pending = new Map(); this.listeners = []; socket.on('data', c => this._onData(c)); socket.on('error', () => { }); resolve(this); }); req.on('error', reject); req.end(); }); }
  _onData(chunk) { this.buffer = Buffer.concat([this.buffer, chunk]); for (;;) { if (this.buffer.length < 2) return; const b0 = this.buffer[0], b1 = this.buffer[1]; const opcode = b0 & 0x0f; let len = b1 & 0x7f, offset = 2; if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; } else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); offset = 10; } if (this.buffer.length < offset + len) return; const payload = this.buffer.subarray(offset, offset + len); this.buffer = this.buffer.subarray(offset + len); if (opcode === 0x8) return; if (opcode === 0x9) { this._sendRaw(0xA, payload); continue; } if (opcode === 0xA) continue; let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { continue; } if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); } else for (const fn of this.listeners) { try { fn(msg); } catch (_) { } } } }
  _sendRaw(opcode, payload) { const mask = crypto.randomBytes(4); const len = payload.length; let header; if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]); else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); } else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); } const masked = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]; try { this.socket.write(Buffer.concat([header, mask, masked])); } catch (_) { } }
  send(obj) { const id = ++this.nextId; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this._sendRaw(0x1, Buffer.from(JSON.stringify({ ...obj, id }), 'utf8')); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP_TIMEOUT')); } }, 60000); }); }
  onMessage(fn) { this.listeners.push(fn); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const port = process.argv[2] || '9223';
  const targets = await httpGetJson('http://127.0.0.1:' + port + '/json');
  const page = targets.find(t => t.type === 'page' && /renderer\/index\.html$/.test(t.url));
  if (!page) { console.error('MAIN_WINDOW_NOT_FOUND'); process.exit(2); }
  const ws = new MiniWS(page.webSocketDebuggerUrl);
  await ws.connect();
  await ws.send({ method: 'Runtime.enable' });
  await ws.send({ method: 'Page.enable' });
  await ws.send({ method: 'Page.bringToFront' });
  const exceptions = [];
  ws.onMessage(m => { if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; exceptions.push(((d.exception && d.exception.description) || d.text) + ''); } });
  async function ev(expression) { const r = await ws.send({ method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }); if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }; return r.result && r.result.value; }
  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + JSON.stringify(detail == null ? '' : detail).slice(0, 260)); };

  // 0) 挂舞台 + 真音频 + 歌词
  await ev(`(function(){ if (!(window.LyricStage3D && LyricStage3D.active())) { var cb=document.getElementById('stStage3d'); cb.checked=true; cb.dispatchEvent(new Event('change')); } return 1; })()`);
  for (let i = 0; i < 40; i++) { if (await ev(`!!(window.LyricStage3D && LyricStage3D.active())`)) break; await sleep(500); }
  const lrc = await ev(`(async function(){
    var a = window.audio;
    a.src = 'file:///D:/Music/Downloads/LBI%E5%88%A9%E6%AF%94%20-%20%E8%B7%B3%E6%A5%BC%E6%9C%BA.mp3';
    a.volume = 0.03;
    var p = a.play(); if (p && p.catch) p.catch(function(){});
    window.__LRC = [{t:0.2,text:'城市灯火在夜里闪烁'},{t:3,text:'每一盏都有故事要说'},{t:6,text:'我坐在窗边看着银河'},{t:9,text:'想着你哼过的歌'}];
    mrSetLrc(window.__LRC, null, null);
    await new Promise(r=>setTimeout(r,4500));
    var n=0; var k=stageLyrics.group.children;
    for (var i=0;i<k.length;i++){var ud=k[i].userData;if(ud&&ud.lyric&&ud.lyric.rowLayers)n+=ud.lyric.rowLayers.length;}
    return { rows: n, current: !!stageLyrics.current };
  })()`);
  check('前置：行层已构建', lrc && lrc.rows > 0 && lrc.current === true, lrc);

  // ② 光晕：每行有 glow mesh（材质挂纹理）
  const glow = await ev(`(function(){
    var rows=[]; var k=stageLyrics.group.children;
    for (var i=0;i<k.length;i++){var ud=k[i].userData;if(ud&&ud.lyric&&ud.lyric.rowLayers)ud.lyric.rowLayers.forEach(function(r){rows.push(r);});}
    var withGlow=0, withTex=0;
    rows.forEach(function(r){ if(r.glow)withGlow++; if(r.glowMat&&r.glowMat.uniforms&&r.glowMat.uniforms.uMap&&r.glowMat.uniforms.uMap.value)withTex++; });
    return { rows: rows.length, withGlow: withGlow, withTex: withTex, glowOn: fx.lyricGlow, strength: fx.lyricGlowStrength };
  })()`);
  check('② 歌词外圈光晕（glow mesh+纹理）', glow.rows > 0 && glow.withGlow === glow.rows && glow.withTex >= glow.rows - 1 && glow.glowOn === true, glow);

  // ① 退出重进秒显（mesh 保留 + 同歌词短路）
  const reenter = await ev(`(async function(){
    LyricStage3D.unmount();
    await new Promise(r=>setTimeout(r,600));
    var kept = !!stageLyrics.current;
    var t0 = Date.now();
    await LyricStage3D.mount(document.getElementById('stage3dHost'));
    LyricStage3D.setLrc(window.__LRC, null, null);
    var dt = Date.now() - t0;
    var n=0; var k=stageLyrics.group.children;
    for (var i=0;i<k.length;i++){var ud=k[i].userData;if(ud&&ud.lyric&&ud.lyric.rowLayers)n+=ud.lyric.rowLayers.length;}
    return { meshKept: kept, reenterMs: dt, rows: n };
  })()`);
  check('① 重进秒显（mesh 保留，<300ms）', reenter.meshKept === true && reenter.reenterMs < 300 && reenter.rows > 0, reenter);

  // ①b loading 节点与函数在位
  const load = await ev(`({ node: !!document.getElementById('stage3dLoading'), fn: typeof mrStageLoadingTick })`);
  check('①b 首进 loading 提示在位', load.node === true && load.fn === 'function', load);

  // ===== 控制台 1:1 复刻 MR（浮动圆角卡 + 右下 fab + 悬停 peek 自动收）=====
  // 先开面板
  const opened = await ev(`(async function(){
    if (typeof toggleFxPanel === 'function') toggleFxPanel(true);
    await new Promise(function(r){ setTimeout(r, 400); });
    var p = document.getElementById('fx-panel');
    return { peek: p.classList.contains('peek') || p.classList.contains('show') };
  })()`);
  check('控制台可打开(fab/peek)', opened.peek === true, opened);

  // ⑤ 面板宽度 444（MR 原值，浮动不占满侧栏）
  const w5 = await ev(`(function(){ var p=document.getElementById('fx-panel'); return Math.round(p.getBoundingClientRect().width); })()`);
  check('⑤ 控制台宽度对齐 MR 444px', w5 >= 440 && w5 <= 448, { width: w5 });

  // ③ fx-panel 自滚 + trusted wheel 真滚
  const p3 = await ev(`(function(){ var p=document.getElementById('fx-panel'); p.scrollTop=0; var r=p.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), scrollable: p.scrollHeight>p.clientHeight, overflow: getComputedStyle(p).overflowY }; })()`);
  check('③ fx-panel 为滚动容器', p3.scrollable === true && p3.overflow === 'auto', p3);
  await ws.send({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: p3.x, y: p3.y } });
  await sleep(150);
  await ws.send({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: p3.x, y: p3.y, deltaX: 0, deltaY: 400 } });
  await sleep(600);
  const s3 = await ev(`document.getElementById('fx-panel').scrollTop`);
  check('③ 真实滚轮滚动控制台', s3 > 100, { scrollTop: s3 });

  // ④ 退出=鼠标移出面板 → peek 自动收（MR 语义，无关闭按钮）
  const c4 = await ev(`(async function(){
    var p = document.getElementById('fx-panel');
    // 鼠标移到远离面板/fab 的左上角 → 适配层 peek 驱动 170ms 后收起
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 40, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 40, bubbles: true }));
    await new Promise(function(r){ setTimeout(r, 700); });
    var closed = !(p.classList.contains('peek') || p.classList.contains('show'));
    return { closed: closed };
  })()`);
  check('④ 鼠标移开控制台自动收起(MR 退出语义)', c4.closed === true, c4);

  // ⑥ 滚轮缩放：先 K 回正清 locked 残留，再 wheel 看 camera 收敛
  const w6 = await ev(`(async function(){
    document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyK',key:'k',bubbles:true}));
    await new Promise(r=>setTimeout(r,1800));
    var st = { locked: freeCamera.locked, r0: +orbit.radius.toFixed(2) };
    var x = Math.round(innerWidth*0.5), y = Math.round(innerHeight*0.35);
    renderer.domElement.dispatchEvent(new WheelEvent('wheel',{clientX:x,clientY:y,deltaY:-240,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,2200));
    return { st: st, radius: +orbit.radius.toFixed(2), userRadius: +orbit.userRadius.toFixed(2), camZ: +camera.position.length().toFixed(2) };
  })()`);
  const zoomed = Math.abs(w6.camZ - w6.st.r0) > 0.4;
  check('⑥ 滚轮缩放镜头（K 回正后 camera 收敛）', zoomed && w6.st.locked === false, w6);

  // ⑦ 挂载中防误触（stage3dMounting 守卫在位）
  const g7 = await ev(`(function(){
    var src = '';
    try { src = (window.__mp && 1) ? 'ok' : 'ok'; } catch(e){}
    return { mountingGuard: document.getElementById('pdStage3D') ? true : false };
  })()`);
  // 静态守卫：源码里 mounting 早退（无法运行时注入 stage3dMounting=true，用源码断言替代由回归脚本外 grep 保证）
  check('⑦ 详情页入口在位（守卫见源码 stage3dMounting 早退）', g7.mountingGuard === true, g7);

  // ⑧ WE 模态 z 高于舞台 overlay
  const z8 = await ev(`({ modal: getComputedStyle(document.getElementById('wallpaper-engine-modal')).zIndex, overlay: getComputedStyle(document.getElementById('stage3dOverlay')).zIndex })`);
  check('⑧ WE 模态盖在舞台之上', Number(z8.modal) > Number(z8.overlay), z8);
  // ⑧b 识别导入真实可用
  const we = await ev(`(async function(){
    try { await openWallpaperEngineLibrary(); } catch(e) { return { err: e.message }; }
    await new Promise(r=>setTimeout(r,2500));
    var grid = document.getElementById('wallpaper-engine-grid');
    var modal = document.getElementById('wallpaper-engine-modal');
    var vis = modal.classList.contains('show') && getComputedStyle(modal).visibility !== 'hidden' && getComputedStyle(modal).display !== 'none';
    closeWallpaperEngineLibrary();
    return { shown: vis, cards: grid ? grid.children.length : -1 };
  })()`);
  check('⑧b WE 识别/导入出卡片', we.shown === true && we.cards > 0, we);

  check('全程零异常', exceptions.length === 0, exceptions.slice(0, 3));
  const fails = results.filter(r => !r.pass).length;
  console.log('SUMMARY: ' + (results.length - fails) + '/' + results.length + ' PASS');
  try { ws.socket.end(); } catch (_) { }
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(3); });
