// 在线歌音质徽标·按实际音质显示 CDP 实测（2026-09-21 W-1）：档位推导/探测调参/缓存/队列节流/徽标四态
// 用法：node _qualitybadge_test.js [port]，默认 9223（需已启动 electron 测试实例）
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
    const r = await ws.send({ method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } });
    if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result && r.result.value;
  }
  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (detail == null ? '' : detail)); };
  // ============ W-1 在线歌音质徽标：按实际音质显示 ============
  // 快照当前视图，测试结束后还原（避免污染后续套件）
  const SNAP = JSON.parse(await ev(`JSON.stringify({ view: __mp.state.view, grid: __mp.state.gridMode, src: __mp.state.onlineSrcFilter, flt: __mp.state.plFilter })`) || '{}');
  const waitIdle = async (limitMs) => {           // 探测单次最坏 20s 上游超时 + 8s 魔数探测
    const t0 = Date.now();
    while (Date.now() - t0 < limitMs) {
      if (!(await ev(`__mp.probing === true`))) return true;
      await sleep(500);
    }
    return false;
  };
  const SEED = (n) => ev(`(function(){
    const st = __mp.state, s = __mp.probeStats;
    s.rounds = 0; s.queued = 0; s.done = 0; s.failed = 0; s.cacheHit = 0; s.stopped = '';
    st.view = 'online'; st.onlineSrcFilter = 'all'; st.plFilter = ''; st.gridMode = 0;
    const arr = [];
    for (let i = 0; i < ${n}; i++) arr.push({ id: 'online:netease:__w1_q' + i + '__', online: true, source: 'netease', ref: '__w1_q' + i + '__', title: 'W1Q' + i, artist: 'x', level: 'master' });
    st.list = arr;
    return arr.length;
  })()`);

  // ---------- 1~3) 档位推导（与底栏共用同一函数） ----------
  const v1 = JSON.parse(await ev(`JSON.stringify({ t: typeof __mp.deriveRealLevel, hi: __mp.deriveRealLevel({bitrate:320000}), ma: __mp.deriveRealLevel({bitrate:3175000}), std: __mp.deriveRealLevel({bitrate:128000}) })`) || '{}');
  check('1 档位推导·就位 + bps 直判', v1.t === 'function' && v1.hi === 'high' && v1.ma === 'master' && v1.std === 'standard', JSON.stringify(v1));

  const v2 = JSON.parse(await ev(`JSON.stringify({ size: __mp.deriveRealLevel({bitrate:0,size:41360000,duration:200}), empty: __mp.deriveRealLevel({}) })`) || '{}');
  check('2 档位推导·size×8/dur 反推 + 无信息=null', v2.size === 'lossless' && v2.empty === null, '41360000B/200s=1654.4kbps→' + v2.size + '；空响应→' + v2.empty);

  const v3 = JSON.parse(await ev(`JSON.stringify({ flac: __mp.deriveRealLevel({type:'flac'}), hires: __mp.deriveRealLevel({level:'hires'}), jym: __mp.deriveRealLevel({level:'jymaster'}) })`) || '{}');
  check('3 档位推导·容器/level 名', v3.flac === 'lossless' && v3.hires === 'master' && v3.jym === 'master', JSON.stringify(v3));

  // ---------- 4~5) 调参 + 缓存 ----------
  const v4 = await ev(`JSON.stringify(__mp.probeConst)`);
  const j4 = JSON.parse(v4 || '{}');
  check('4 探测调参：键/TTL 30天/上限12/延迟300/间隔50/并发8/失败3/降档1@800',
    j4.cacheKey === 'mp_probed_q_v1' && j4.ttlMs === 30 * 24 * 3600 * 1000 && j4.maxRows === 12 && j4.debounceMs === 300
    && j4.gapMs === 50 && j4.concurrency === 8 && j4.failLimit === 3
    && j4.throttleConcurrency === 1 && j4.throttleGapMs === 800, v4);

  const v5 = await ev(`(function(){
    const s = { source:'netease', ref:'__w1_cache__' };
    const miss = __mp.probeCacheGet(s, 'master');
    __mp.probeCacheSet(s, 'master', 'lossless');
    const hit = __mp.probeCacheGet(s, 'master');
    const otherLv = __mp.probeCacheGet(s, 'standard');
    const lsRaw = (localStorage.getItem(__mp.PROBE_CACHE_KEY) || '').indexOf('__w1_cache__') >= 0;
    __mp.probeCache['netease:__w1_cache__:master'] = { v:'lossless', t: Date.now() - 31*24*3600*1000 };
    const expired = __mp.probeCacheGet(s, 'master');
    delete __mp.probeCache['netease:__w1_cache__:master'];
    localStorage.setItem(__mp.PROBE_CACHE_KEY, JSON.stringify(__mp.probeCache));
    return JSON.stringify({ miss, hit, otherLv, lsRaw, expired });
  })()`);
  const j5 = JSON.parse(v5 || '{}');
  check('5 缓存：未命中/写盘/档位隔离/31 天过期', j5.miss === null && j5.hit === 'lossless' && j5.otherLv === null && j5.lsRaw === true && j5.expired === null, v5);

  // ---------- 6) 延迟调度（300ms）+ 队列能回归空闲 ----------
  // 全程在页内完成：先等在跑的一轮收尾（否则会误读它的统计），再钉列表、再调度
  const v6 = await ev(`(async function(){
    const st = __mp.state, s = __mp.probeStats;
    const mk = () => [0, 1].map((i) => ({ id:'online:netease:__w1_q'+i+'__', online:true, source:'netease', ref:'__w1_q'+i+'__', title:'W1Q'+i, artist:'x', level:'master' }));
    st.view = 'online'; st.onlineSrcFilter = 'all'; st.plFilter = ''; st.gridMode = 0;
    st.list = mk();
    // 等"静默"：不只会话在跑，还可能有一轮被排到 300ms 后（probePending）——必须等到 rounds 在
    // 一个完整观察窗内不再变化，否则会误读别轮（应用自己的列表轮次）的 queued。
    await new Promise((r) => setTimeout(r, 1200));
    let prevRounds = -1;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 700));
      if (!__mp.probing && s.rounds === prevRounds) break;
      prevRounds = s.rounds;
    }
    st.list = mk();
    s.rounds = 0; s.queued = 0; s.done = 0; s.failed = 0; s.cacheHit = 0; s.stopped = '';
    // (a) 显式跑一轮读 queued：确定性（此时已静默，不会被别轮覆盖）
    await __mp.runQualityProbe();
    const q = s.queued;
    // (b) debounce：重置 rounds 后调度，200ms 内不起轮、~300ms 后起 1 轮
    s.rounds = 0;
    __mp.scheduleQualityProbe();
    const before = s.rounds;
    await new Promise((r) => setTimeout(r, 200));
    const mid = s.rounds;
    await new Promise((r) => setTimeout(r, 900));
    return JSON.stringify({ q: q, before: before, mid: mid, after: s.rounds,
      listLen: st.list.length, listOnline: st.list.filter((x) => x && x.online).length });
  })()`);
  const j6 = JSON.parse(v6 || '{}');
  const idle = await waitIdle(90000);
  check('6 延迟调度：200ms 内不起轮、300ms 后自动起 1 轮且队列可回归空闲',
    j6.q === 2 && j6.before === 0 && j6.mid === 0 && j6.after === 1 && idle === true, v6 + ' idle=' + idle);

  // ---------- 7~10) 队列机制（20 首伪造 ref：上游必失败） ----------
  await waitIdle(90000);
  await SEED(20);
  const v7 = await ev(`(async function(){
    const t0 = performance.now();
    await __mp.runQualityProbe();
    const ms = Math.round(performance.now() - t0);
    const s = __mp.probeStats;
    return JSON.stringify({ queued: s.queued, failed: s.failed, done: s.done, stopped: s.stopped, ms: ms, listed: __mp.state.list.length,
      roundCostMs: s.roundCostMs, bySrcKeys: Object.keys(s.bySrc || {}).sort().join(','), bySrc: s.bySrc, throttled: s.throttled });
  })()`);
  const j7 = JSON.parse(v7 || '{}');
  check('7 队列上限 ≤12 首 + 甲新字段就位（roundCostMs/bySrc/throttled）',
    j7.listed === 20 && j7.queued === 12 && typeof j7.roundCostMs === 'number' && j7.roundCostMs >= 0
    && j7.bySrcKeys === 'kugou,netease' && j7.throttled === 0, v7);
  check('8 连续失败 3 次即停整队（并发池下 failed ≥ 3）', j7.failed >= 3 && j7.done === 0 && j7.stopped === 'consecutive-fail-3',
    'failed=' + j7.failed + ' done=' + j7.done + ' stopped=' + j7.stopped + '（6 路在飞 → 收尾时可能略多于 3）');

  // 9) 丙：搜索结果交错（原地排序 + 引用不脱钩）
  const v9 = await ev(`(function(){
    const st = __mp.state;
    const mkS = (src, k) => ({ id: 'online:' + src + ':w3i' + k, online: true, source: src, ref: 'w3i' + k, title: src + k, artist: 'x', level: 'lossless' });
    st.view = 'online';
    st.searchResults = [];
    st.list = st.searchResults;                     // 与 onlineSearch 同构：list 与 searchResults 同一引用
    __mp.mergeSearchResults([1,2,3,4,5].map((k) => mkS('netease', k)));   // 先到：网易 5 首
    __mp.mergeSearchResults([1,2,3,4].map((k) => mkS('kugou', k)));       // 后到：酷狗 4 首
    const seq = st.searchResults.map((s) => s.source.charAt(0) + s.ref.replace('w3i', ''));
    return JSON.stringify({ seq: seq, sameRef: st.searchResults === st.list, len: st.searchResults.length });
  })()`);
  const j9 = JSON.parse(v9 || '{}');
  check('9 丙：搜索结果原地交错（n1,k1,n2,k2…）且 list 引用不脱钩',
    j9.seq.join(',') === 'n1,k1,n2,k2,n3,k3,n4,k4,n5' && j9.sameRef === true && j9.len === 9, v9);

  await waitIdle(90000);
  await SEED(5);   // 用 5 首（低于上限 12）才能看出"缓存命中不占名额"：期望 queued=4
  const v10 = await ev(`(async function(){
    const s = __mp.probeStats, st = __mp.state;
    const lv = s.level || 'lossless';
    s.rounds = 0; s.queued = 0; s.done = 0; s.failed = 0; s.cacheHit = 0; s.stopped = '';
    __mp.probeCacheSet(st.list[0], lv, 'high');
    await __mp.runQualityProbe();
    return JSON.stringify({ cacheHit: s.cacheHit, queued: s.queued, first: st.list[0].probedLevel, lv: lv, listed: st.list.length });
  })()`);
  const j10 = JSON.parse(v10 || '{}');
  check('10 缓存命中：回填 probedLevel 且不占队列名额', j10.cacheHit === 1 && j10.queued === 4 && j10.first === 'high', v10);

  // ---------- 11) 徽标（走真实 buildRow 渲染路径） ----------
  const v11 = await ev(`(async function(){
    const st = __mp.state;
    const A = { id:'online:netease:__w1_badgeA__', online:true, source:'netease', ref:'__w1_badgeA__', title:'W1徽标A', artist:'x', level:'master', probedLevel:'lossless' };
    const B = { id:'online:netease:__w1_badgeB__', online:true, source:'netease', ref:'__w1_badgeB__', title:'W1徽标B', artist:'x', level:'master', probedLevel:'standard', playedLevel:'high' };
    const C = { id:'online:netease:__w1_badgeC__', online:true, source:'netease', ref:'__w1_badgeC__', title:'W1徽标C', artist:'x', level:'master' };
    const L = { id:'local:__w1_badgeL__', online:false, source:'local', title:'W1徽标L', artist:'x', level:'master', container:'FLAC' };
    st.view = 'online'; st.onlineSrcFilter = 'all'; st.plFilter = ''; st.gridMode = 0;
    st.list = [A, B, C, L];
    await __mp.renderList();
    const slot = (id) => { const tr = document.querySelector('#songBody tr[data-id="' + CSS.escape(id) + '"]'); return tr ? tr.querySelector('.tag-slot.t3') : null; };
    const txt = (id) => { const s = slot(id); return s ? s.textContent : null; };
    const kids = (id) => { const s = slot(id); return s ? s.children.length : -1; };
    return JSON.stringify({ a: txt(A.id), b: txt(B.id), c: txt(C.id), cKids: kids(C.id), l: txt(L.id), lKids: kids(L.id), cOld: __mp.qualityForSong(C) });
  })()`);
  const j11 = JSON.parse(v11 || '{}');
  const badgeOk = j11.a === '无损' && j11.b === '高品' && j11.c === '' && j11.cKids === 0 && j11.l === '无损' && j11.lKids === 1;
  check('11 徽标四态：探测档/播放档优先/无确认留空/本地不受影响', badgeOk,
    'A(probed=lossless)="' + j11.a + '" B(played=high)="' + j11.b + '" C(未确认)="' + j11.c + '"（旧逻辑 qualityForSong(C)=' + j11.cOld + ' 本会显示"臻品"）L(本地FLAC)="' + j11.l + '"');

  // ---------- 收尾：还原视图 + 清测试缓存 ----------
  await ev(`(function(){
    try {
      Object.keys(__mp.probeCache).forEach((k) => { if (k.indexOf('__w1_') >= 0) delete __mp.probeCache[k]; });
      localStorage.setItem(__mp.PROBE_CACHE_KEY, JSON.stringify(__mp.probeCache));
      const st = __mp.state;
      st.view = ${JSON.stringify(SNAP.view)}; st.gridMode = ${JSON.stringify(SNAP.grid)};
      st.onlineSrcFilter = ${JSON.stringify(SNAP.src)}; st.plFilter = ${JSON.stringify(SNAP.flt)};
    } catch (e) {}
    return 'restored';
  })()`);
  await ev(`__mp.renderList()`);

  check('12 全程零异常', exceptions.length === 0, exceptions.length ? exceptions.slice(0, 3).join(' || ').slice(0, 300) : 'exceptions=0');

  const fails = results.filter((r) => !r.pass).length;
  console.log('QUALITYBADGE_TEST: ' + (results.length - fails) + '/' + results.length + ' PASS');
  try { ws.socket.end(); } catch (_) {}
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(3); });
