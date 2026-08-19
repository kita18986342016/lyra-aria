// 深空折韵 渲染层逻辑（v2）
(() => {
  const $ = (sel) => document.querySelector(sel);

  // 调试钩子（CDP 自动化验证用，可安全保留）
  window.__mp = {
    get audio() { return audio; },
    get state() { return state; },
    get lrc() { return state.lrc; },
    get lastLyricIdx() { return lastLyricIdx; },
    get rafId() { return rafId; }
  };

  const state = {
    songs: [],
    dirs: [],
    playlists: [],
    favorites: [],
    history: [],
    view: 'library',          // 'library' | 'playlist:<id>' | 'favorites' | 'history'
    list: [],                 // 当前视图显示列表（song 对象）
    queue: [],                // 播放队列（与视图无关）
    queueIndex: -1,           // 当前播放下标
    mode: 'order',            // order | repeat-one | shuffle
    shuffleOrder: [],         // 随机模式：当前队列的随机播放顺序（下标数组，无重复直到播完一轮）
    shufflePos: -1,           // 随机模式：shuffleOrder 中的当前位置
    filter: '',
    volume: 0.8,
    lrc: null,                // 当前歌词行
    playingId: null,
    loadSeq: 0,               // 异步竞态守卫
    errStreak: 0,
    selectedId: null,
    scanning: false,
    rate: 1.0,                    // 播放倍速
    gridMode: 0,                  // 视图模式：0=列表 1=歌曲墙 2=专辑墙
    sleepIdx: 0,                  // 睡眠定时分钟数（0=无，30/60/自定义 1-360）——默认无
    fadePending: false,           // 切歌待淡入标记
    plainLrc: null,               // 无时间戳纯文本歌词（原样显示，不跟随滚动）
    searchMode: 'local',          // 'local' 本地过滤 | 'online' 在线搜索（网易云/酷狗）
    editMode: false,              // 侧栏编辑模式：开启后歌单可直接按住拖拽排序（不开启=长按400ms）
    onlineQuery: '',              // 当前在线搜索词（用于结果栏显示）
    onlinePlaylists: [],          // 导入的在线歌单 [{id, name, source, cover, desc, songs:[]}]
    wordSegs: null,               // 逐字时间轴 [{t, chars:[{ch,t}]}]（在线歌词，逐字卡拉OK用）
    translatedLrc: null           // 翻译歌词行（在线歌词 translated 字段）
  };

  const coverCache = new Map();
  const audio = new Audio();
  audio.preload = 'metadata';

  // ---------- SVG 图标（统一线性风格） ----------
  const I = (paths, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;
  const ICONS = {
    note: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`,
    noteLine: I('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
    playHint: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
    heart: I('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>'),
    heartFill: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
    repeat: I('<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
    repeatOne: I('<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>') + `<span class="mode-one">1</span>`,
    shuffle: I('<path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>'),
    list: I('<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'),
    globe: I('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
    download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
    warn: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
    folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
  };
  const MODE_ICONS = { order: ICONS.repeat, 'repeat-one': ICONS.repeatOne, shuffle: ICONS.shuffle };
  const MODE_TITLES = { order: '列表循环', 'repeat-one': '单曲循环', shuffle: '随机播放' };

  // ---------- 工具 ----------
  const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---------- 倍速播放 ----------
  const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  function cycleRate() {
    const i = RATES.indexOf(state.rate);
    state.rate = RATES[(i + 1) % RATES.length];
    audio.playbackRate = state.rate;
    updateRateBtn();
    try { localStorage.setItem('mp_rate', String(state.rate)); } catch { /* 忽略 */ }
    toast(`播放速度 ${state.rate}x`);
  }
  function updateRateBtn() {
    const v = state.rate;
    const txt = (v % 1 === 0) ? v.toFixed(0) : String(v).replace(/0+$/, '').replace(/\.$/, '');
    $('#btnRate').textContent = txt + 'x';
  }

  // ---------- 睡眠定时（设置面板：关/30/60/自定义，上限 360 分钟，到时暂停） ----------
  let sleepTimer = null, sleepEnd = 0;
  function setSleepMode(mins) { // mins: 0=关, 1-360 分钟
    mins = Math.max(0, Math.min(360, Math.round(Number(mins) || 0)));
    state.sleepIdx = mins;
    try { localStorage.setItem('mp_sleep', String(mins)); } catch { /* 忽略 */ }
    clearSleep();
    if (mins === 0) { updateSleepUi(); return; }
    sleepEnd = Date.now() + mins * 60000;
    sleepTimer = setTimeout(() => {
      audio.pause();
      clearSleep();
      toast('睡眠定时到，已暂停播放');
    }, mins * 60000);
    updateSleepUi();
    toast(`睡眠定时 ${mins} 分钟`);
  }
  function clearSleep() {
    clearTimeout(sleepTimer); sleepTimer = null; sleepEnd = 0;
    updateSleepUi();
  }
  function updateSleepUi() {
    const modeBtns = document.querySelectorAll('#stSleepModes .st-mode');
    const isCustom = state.sleepIdx !== 0 && state.sleepIdx !== 30 && state.sleepIdx !== 60;
    modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.sleep === 'custom' ? isCustom : +b.dataset.sleep === state.sleepIdx));
    if (isCustom) $('#stSleepCustom').value = state.sleepIdx;
    const tip = $('#stSleepTip');
    if (sleepTimer && sleepEnd) {
      const mins = Math.max(1, Math.ceil((sleepEnd - Date.now()) / 60000));
      tip.textContent = '睡眠定时进行中，剩余约 ' + mins + ' 分钟，到点自动暂停播放。';
    } else {
      tip.textContent = '到点后自动暂停播放。';
    }
  }

  // ---------- 淡入淡出（切歌平滑过渡） ----------
  let fadeTimer = null;
  let fadeResolve = null; // 进行中的 fadeOut Promise 的 resolve（pause/error 中断时解除挂起）
  // 时长 ms 淡出；传 cb（旧调用 fadeOut(fn)）则完成时调用，否则返回 Promise（平滑切歌 await 用）
  function fadeOut(ms = 220, cb = null) {
    if (typeof ms === 'function') { cb = ms; ms = 220; }
    if (audio.paused || !audio.currentSrc || audio.volume <= 0.01) {
      if (cb) cb();
      return cb ? undefined : Promise.resolve();
    }
    const start = audio.volume, t0 = performance.now();
    clearInterval(fadeTimer);
    return new Promise((resolve) => {
      fadeResolve = resolve;
      fadeTimer = setInterval(() => {
        const p = (performance.now() - t0) / ms;
        if (p >= 1) {
          clearInterval(fadeTimer);
          fadeResolve = null;
          audio.volume = 0;
          if (cb) cb();
          resolve();
        } else audio.volume = Math.max(0, start * (1 - p));
      }, 16);
    });
  }
  function fadeIn() {
    clearInterval(fadeTimer);
    fadeResolve = null;
    const target = state.volume, t0 = performance.now();
    fadeTimer = setInterval(() => {
      const p = (performance.now() - t0) / 380;
      if (p >= 1) { clearInterval(fadeTimer); audio.volume = target; }
      else audio.volume = Math.max(0, target * p);
    }, 16);
  }
  // 手动切歌（上一首/下一首）：先淡出再切
  function nextOrPrev(fn) {
    if (audio.paused || !audio.currentSrc) { fn(); return; }
    fadeOut(fn);
  }

  // ---------- 数据加载 ----------
  async function init() {
    const cfg = await window.api.getConfig();
    // 版本号运行时读取（设置 footer + 软件更新区，发版不用改页面）
    try {
      const info = await window.api.appInfo();
      if (info && info.version) {
        const v = 'v' + info.version;
        const about = document.querySelector('.st-about');
        if (about) about.textContent = v + ' · Lyra Aria © 2026';
        const stUpdVer = $('#stUpdVer');
        if (stUpdVer) stUpdVer.textContent = v;
      }
    } catch { /* 忽略 */ }
    state.volume = cfg.volume ?? 0.8;
    state.mode = cfg.mode || 'order';
    audio.volume = state.volume; // 启动即同步实际音量
    // 恢复本地偏好（倍速 / 视图模式：0=列表 1=歌曲墙 2=专辑墙）
    try {
      const r = parseFloat(localStorage.getItem('mp_rate'));
      if (RATES.includes(r)) state.rate = r;
      const gm = parseInt(localStorage.getItem('mp_grid') || '0', 10);
      state.gridMode = (gm === 1 || gm === 2) ? gm : 0;
    } catch { /* 忽略 */ }
    audio.playbackRate = state.rate;
    updateRateBtn();
    updateViewSwitch();
    $('#pVol').value = Math.round(state.volume * 100);
    updateModeBtn();
    // 背景模糊氛围（用户可调，0-60px 步进 0.5；0=封面清晰铺满）
    const bgb = cfg.bgBlur != null ? cfg.bgBlur : 0;
    document.documentElement.style.setProperty('--bg-blur', bgb + 'px');
    $('#bgBlurRange').value = bgb;
    $('#bgBlurVal').textContent = (Math.round(bgb * 10) / 10).toFixed(1);
    // 设置面板：恢复本地偏好（音量/字号/睡眠/关闭行为/启动恢复）
    try {
      $('#stVolRange').value = Math.round(state.volume * 100);
      $('#stVolVal').textContent = Math.round(state.volume * 100) + '%';
      let fs = parseInt(localStorage.getItem('mp_fs'), 10);
      if (!(fs >= 11 && fs <= 20)) fs = 17; // 默认 17（与用户常用档一致；无存档/非法值时生效）
      document.documentElement.style.setProperty('--lyric-fs', fs + 'px');
      reSegmentActiveLyrics();
      $('#stFs').value = fs;
      $('#stFsVal').textContent = fs;
      const sleepIdx = parseInt(localStorage.getItem('mp_sleep'), 10);
      if (sleepIdx === 0) { state.sleepIdx = 0; updateSleepUi(); }
      else if (sleepIdx > 0 && sleepIdx <= 360) setSleepMode(sleepIdx); // 重启后若定时未到点则恢复
      const close = localStorage.getItem('mp_close');
      if (close === 'tray' || close === 'exit') {
        document.querySelectorAll('#stCloseModes .st-mode').forEach((x) => x.classList.toggle('active', x.dataset.close === close));
        window.api.setCloseBehavior(close);
      } else {
        document.querySelectorAll('#stCloseModes .st-mode').forEach((x) => x.classList.toggle('active', x.dataset.close === 'tray'));
      }
      $('#stResume').checked = localStorage.getItem('mp_resume') !== '0';
      // 桌面歌词字号/透明度（config.lyricWin 持久化）
      const lc = await window.api.getLyricWin();
      if (lc) {
        $('#stLyrFs').value = Math.min(36, Math.max(14, lc.fontSize || 26));
        $('#stLyrFsVal').textContent = $('#stLyrFs').value;
        const op = Math.round((lc.bgOpacity ?? 0.55) * 100);
        $('#stLyrOp').value = Math.min(100, Math.max(30, op));
        $('#stLyrOpVal').textContent = $('#stLyrOp').value + '%';
        if (/^#[0-9a-fA-F]{6}$/.test(lc.color2 || '')) $('#stLyrColor2').value = lc.color2;
        if (/^#[0-9a-fA-F]{6}$/.test(lc.color || '')) $('#stLyrColor').value = lc.color;
        if (!lc.enabled) $('#stLyric').checked = false;
      }
      // 下载目录（config.downloadsDir 持久化；未设置时默认 音乐目录\Downloads）
      const dlDir = await window.api.dlDir();
      if (dlDir) $('#stDlDir').value = dlDir;
      // 同名覆盖开关（config.downloadOverwrite）
      const dlOv = await window.api.dlOverwrite();
      if (dlOv != null) $('#stDlOverwrite').checked = !!dlOv;
    } catch (err) { /* 设置恢复失败不影响启动 */ }
    // 睡眠档位 UI 同步（关/进行中）
    updateSleepUi();

    window.api.onScanProgress((p) => {
      $('#scanText').textContent = `正在扫描曲库… ${p.done}/${p.total}`;
      $('#scanFill').style.width = p.total ? Math.round((p.done / p.total) * 100) + '%' : '0';
    });
    window.api.onFlush(() => savePlaybackState());
    window.api.onCoversDone(() => renderList()); // 后台封面批量完成 → 重渲染表格（缓存命中即时显示）
    window.api.onThumbView((show) => {
      $('#thumbView').classList.toggle('show', show);
      if (show) updateThumbView();
    });    window.api.onLyricsProgress((p) => {
      if (fillState.active) {
        const b = $('#btnFillAll');
        if (b) b.textContent = `正在获取歌词… ${p.done}/${p.total}`;
      }
    });

    const lib = await window.api.getLibrary();
    state.songs = lib.songs;
    state.dirs = lib.dirs;
    state.playlists = await window.api.getPlaylists();
    state.favorites = await window.api.getFavorites();
    state.history = await window.api.getHistory();
    // 在线歌单本地持久化：恢复「收藏」或「已下载」的歌单（未收藏且未下载的会话内即失）
    state.onlinePlaylists = (await window.api.getOpls().catch(() => [])).filter((p) => p && (p.fav || p.downloaded));
    state.plOrder = await window.api.getPlOrder().catch(() => []); // 我的歌单显示顺序（长按拖拽）

    renderNav();
    renderDirs();
    setView('library');
    checkResume();
  }

  // ---------- 自动恢复上次播放（无确认条：加载到上次进度，保持暂停） ----------
  async function checkResume() {
    let resume = true;
    try { resume = localStorage.getItem('mp_resume') !== '0'; } catch { /* 忽略 */ }
    if (!resume) return;
    const st = await window.api.getState();
    if (!st || !st.songId) return;
    const idx = state.songs.findIndex((s) => s.id === st.songId);
    if (idx < 0) return;
    playList(state.songs, idx, st.position || 0, false);
  }

  function savePlaybackState() {
    const s = currentSong();
    if (s) {
      window.api.saveState({ songId: s.id, position: audio.currentTime || 0, mode: state.mode });
    }
  }

  // 在线歌单本地持久化：只存「收藏」或「已下载（一键下载全部）」的歌单（用户数据目录 online-playlists.json）；
  // 未收藏且未下载的只在本次会话有效，重启即清除
  function saveOpls() {
    window.api.saveOpls(state.onlinePlaylists.filter((p) => p.fav || p.downloaded)).catch(() => {});
  }

  // 收藏条目：字符串=本地歌曲 id；对象=在线收藏的歌曲（含 source/ref 可恢复播放）
  const favKey = (f) => (typeof f === 'string' ? f : f && f.id);
  function isFav(id) { return state.favorites.some((f) => favKey(f) === id); }
  function favToSong(f) { return typeof f === 'string' ? state.songs.find((s) => s.id === f) : f; }

  // ---------- 导航 ----------
  function renderNav() {
    // 分组：最近听过（折叠行）/ 我的歌单（自建歌单 + 收藏或已下载的在线歌单，带下载状态标记）/ 临时歌单（未收藏未下载）
    const recentWrap = $('#navPlRecent');
    const myWrap = $('#navPlMine');
    const tempWrap = $('#navPlTemp');
    const recentFold = $('#recentFold');
    const recentCount = $('#recentCount');
    const myTitle = $('#myPlTitle');
    const tempTitle = $('#tempPlTitle');
    const XSvg = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;

    // 在线歌单行：图标 + 名字 + 来源徽章 + 下载状态标记 + 收藏星（常显，名字旁）+ ×（最右）
    // showDl=true 时显示 未下载/已下载 标记（仅"我的歌单"里已保存的在线歌单）
    const makeOplRow = (pl, showDl) => {
      const row = el('div', 'nav-item');
      row.dataset.view = 'opl:' + pl.id;
      const inner = el('div', 'playlist-row');
      const ic = el('span');
      ic.innerHTML = ICONS.globe;
      const name = el('span', 'name', pl.name);
      name.title = pl.name;
      inner.append(ic, name);
      if (showDl) {
        const db = el('span', 'dl-badge ' + (pl.downloaded ? 'ok' : 'no'), pl.downloaded ? '✓' : '未');
        db.title = pl.downloaded ? '已下载到本地' : '未下载';
        inner.appendChild(db);
      }
      const fav = el('button', 'del opl-fav');
      fav.classList.toggle('on', !!pl.fav);
      fav.innerHTML = pl.fav ? ICONS.heartFill : ICONS.heart;
      fav.title = pl.fav ? '取消收藏（歌单仍保留）' : '收藏歌单（移入我的歌单并保存到本地）';
      fav.addEventListener('click', (e) => {
        e.stopPropagation();
        pl.fav = !pl.fav;
        saveOpls();
        renderNav();
      });
      inner.appendChild(fav);
      const del = el('button', 'del');
      del.innerHTML = XSvg;
      del.title = '移除歌单';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        state.onlinePlaylists = state.onlinePlaylists.filter((x) => x.id !== pl.id);
        saveOpls();
        renderNav();
        if (state.view === 'opl:' + pl.id) setView('library');
      });
      inner.appendChild(del);
      row.appendChild(inner);
      row.addEventListener('click', () => setView('opl:' + pl.id));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); showPlaylistMenu(e.clientX, e.clientY, 'opl', pl); });
      return row;
    };

    // 本地歌单行：列表图标 + 名字 + ×（系统歌单无删除键）
    const makeLocalRow = (pl) => {
      const row = el('div', 'nav-item');
      row.dataset.view = 'playlist:' + pl.id;
      const inner = el('div', 'playlist-row');
      const ic = el('span');
      ic.innerHTML = ICONS.list;
      const name = el('span', 'name', pl.name);
      name.title = pl.name;
      inner.append(ic, name);
      if (!pl.system) {
        const del = el('button', 'del');
        del.innerHTML = XSvg;
        del.title = '删除歌单';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`删除歌单「${pl.name}」？`)) return;
          state.playlists = state.playlists.filter((x) => x.id !== pl.id);
          await window.api.savePlaylists(state.playlists);
          renderNav();
          if (state.view === 'playlist:' + pl.id) setView('library');
        });
        inner.appendChild(del);
      }
      row.appendChild(inner);
      row.addEventListener('click', () => setView('playlist:' + pl.id));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); showPlaylistMenu(e.clientX, e.clientY, 'local', pl); });
      return row;
    };

    // —— 最近听过：有播放记录的歌单，最多 5 个（折叠行，默认收起）——
    const recent = [
      ...state.playlists.map((pl) => ({ kind: 'local', pl })),
      ...state.onlinePlaylists.map((pl) => ({ kind: 'opl', pl })),
    ].filter((x) => x.pl.lastPlayedAt).sort((a, b) => b.pl.lastPlayedAt - a.pl.lastPlayedAt).slice(0, 5);
    recentWrap.innerHTML = '';
    recent.forEach(({ kind, pl }) => {
      const row = el('div', 'nav-item');
      row.dataset.view = kind === 'opl' ? 'opl:' + pl.id : 'playlist:' + pl.id;
      const inner = el('div', 'playlist-row');
      const ic = el('span');
      ic.innerHTML = kind === 'opl' ? ICONS.globe : ICONS.list;
      inner.append(ic, el('span', null, pl.name));
      row.appendChild(inner);
      row.addEventListener('click', () => setView(row.dataset.view));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const target = kind === 'opl'
          ? state.onlinePlaylists.find((p) => 'opl:' + p.id === row.dataset.view)
          : state.playlists.find((p) => 'playlist:' + p.id === row.dataset.view);
        if (target) showPlaylistMenu(e.clientX, e.clientY, kind, target);
      });
      recentWrap.appendChild(row);
    });
    if (recentFold) recentFold.classList.toggle('hidden', !recent.length);
    if (recentCount) recentCount.textContent = recent.length;

    // —— 我的歌单：用户自建歌单（含系统歌单）+ 收藏/已下载的在线歌单（带下载状态标记，不重复出现）——
    // 显示顺序由 plOrder（长按拖拽排序）控制；未列入的歌单按自然顺序追加（本地在前，已保存在线在后）
    const savedOpls = state.onlinePlaylists.filter((p) => p.fav || p.downloaded);
    const mine = [
      ...state.playlists.map((p) => ({ kind: 'local', key: 'playlist:' + p.id, pl: p })),
      ...savedOpls.map((p) => ({ kind: 'opl', key: 'opl:' + p.id, pl: p })),
    ];
    const order = state.plOrder || [];
    mine.sort((a, b) => {
      const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });
    myWrap.innerHTML = '';
    mine.forEach(({ kind, pl }) => {
      const row = kind === 'local' ? makeLocalRow(pl) : makeOplRow(pl, true);
      myWrap.appendChild(row);
      bindPlaylistDrag(row, kind, pl); // 需先入 DOM（container = parentElement）
    });
    // 新建歌单 + 导入歌单：并排一行（框更好看、统一入口）
    const addRow = el('div', 'nav-add-row');
    const btnNew = el('button', 'nav-add-btn', '＋ 新建歌单');
    btnNew.id = 'btnNewPlaylist';
    btnNew.addEventListener('click', openCreatePlaylist);
    const ibtn = el('button', 'nav-add-btn', '导入歌单');
    ibtn.id = 'btnImportOpl';
    ibtn.addEventListener('click', importOnlinePlaylist);
    addRow.append(btnNew, ibtn);
    myWrap.appendChild(addRow);
    if (myTitle) myTitle.classList.toggle('hidden', !myWrap.querySelectorAll('.nav-item').length);

    // —— 临时歌单：未收藏且未下载（仅本次会话）——
    tempWrap.innerHTML = '';
    const temps = state.onlinePlaylists.filter((p) => !p.fav && !p.downloaded);
    temps.forEach((pl) => tempWrap.appendChild(makeOplRow(pl, false)));
    if (tempTitle) tempTitle.classList.toggle('hidden', !temps.length);

    $('#countLib').textContent = state.songs.length;
    $('#countFav').textContent = state.favorites.length;

    document.querySelectorAll('#nav .nav-item[data-view]').forEach((n) => {
      n.classList.remove('active');
      if (n.dataset.view === state.view) n.classList.add('active');
    });
  }

  function renderDirs() {
    const wrap = $('#navDirs');
    wrap.innerHTML = '';
    state.dirs.forEach((d) => {
      // 曲库目录 = 绑定固定文件夹的歌单：可点击查看、右键菜单、拖拽排序
      const view = 'dir:' + encodeURIComponent(d);
      const row = el('div', 'nav-item');
      row.dataset.view = view;
      const inner = el('div', 'playlist-row');
      const ic = el('span');
      ic.innerHTML = ICONS.folder;
      const name = el('span', 'name', d.replace(/\\$/, '').split('\\').pop() || d);
      name.title = d;
      inner.append(ic, name);
      row.appendChild(inner);
      row.addEventListener('click', () => setView(view));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); showDirMenu(e.clientX, e.clientY, d); });
      wrap.appendChild(row);
      bindPlaylistDrag(row, 'dir', d); // 曲库目录同样支持拖拽排序（编辑模式/长按 400ms）
    });
    // 组底部入口：添加文件夹（刷新曲库在顶栏；设置-曲库维护可浏览/移除目录）
    const btnAdd = el('button', 'nav-add-btn', '＋ 添加文件夹');
    btnAdd.id = 'btnAddDirSide';
    btnAdd.addEventListener('click', doAddDir);
    wrap.appendChild(btnAdd);
  }

  // 设置-曲库维护：曲库歌单名表（每个目录 = 侧栏「曲库目录」的一个歌单）
  // 行尾文件夹图标打开对应目录；「移除」= 不再收录该文件夹（其歌曲从曲库消失）
  function renderStDirList() {
    const wrap = $('#stDirList');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.dirs.length) {
      wrap.appendChild(el('div', 'st-dir-empty', '还没有添加曲库文件夹（点侧栏「＋ 添加文件夹」或顶栏刷新旁边的按钮）'));
      return;
    }
    state.dirs.forEach((d) => {
      const row = el('div', 'st-dirrow');
      const nm = el('span', 'st-dirname', d.replace(/\\$/, '').split('\\').pop() || d);
      nm.title = d;
      const dirKey = d.toLowerCase();
      const cnt = state.songs.filter((s) => (s.path || '').toLowerCase().startsWith(dirKey)).length;
      const c = el('span', 'st-dircount', cnt + ' 首');
      const btns = el('span', 'st-diractions');
      const rm = el('button', 'st-act', '移除');
      rm.title = '不再收录该文件夹（其歌曲将从曲库移除）';
      rm.addEventListener('click', async () => {
        if (!confirm(`不再收录「${d}」？\n该文件夹的歌曲将从曲库移除。`)) return;
        const r = await window.api.removeDir(d);
        state.songs = r.songs;
        state.dirs = r.dirs;
        renderDirs();
        renderStDirList();
        if (state.view === 'library') setView('library');
      });
      const open = el('button', 'st-act st-act-open');
      open.innerHTML = ICONS.folder;
      open.title = '打开文件夹';
      open.addEventListener('click', () => window.api.openPath(d));
      btns.append(rm, open);
      row.append(nm, c, btns);
      wrap.appendChild(row);
    });
  }

  // 刷新曲库 / 添加文件夹（顶栏小图标 + 侧边栏曲库目录组底部入口共用）
  async function doRescan() {
    $('#scanBar').classList.remove('hidden');
    $('#scanFill').style.width = '0';
    $('#scanText').textContent = '正在扫描曲库…';
    const r = await window.api.rescan();
    $('#scanBar').classList.add('hidden');
    state.songs = r.songs;
    state.dirs = r.dirs;
    renderDirs();
    setView(state.view);
    toast(`曲库刷新完成（${r.songs.length} 首）`);
  }
  async function doAddDir() {
    const r = await window.api.addDir();
    state.songs = r.songs;
    state.dirs = r.dirs;
    renderDirs();
    if (state.view === 'library') setView('library');
  }

  // ---------- 我的歌单：拖拽排序（虚线指示落点） ----------
  // 编辑模式开启：按下即拖（无长按等待）；关闭：长按 400ms 进入拖拽（抖动 12px 内不取消）
  let dragGhost = null;        // {row, kind, pl, container, ind, idx, moved}
  let suppressRowClick = false;
  const DRAG_HOLD_MS = 400;    // 非编辑模式：按住多久进入拖拽
  function bindPlaylistDrag(row, kind, pl) {
    const container = row.parentElement;
    let timer = null, sx = 0, sy = 0;
    const cancel = () => { clearTimeout(timer); timer = null; };
    row.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return; // 点删除/收藏等按钮不触发拖拽
      sx = e.clientX; sy = e.clientY;
      cancel();
      if (state.editMode) {
        // 编辑模式：按下立即进入拖拽
        if (!document.body.contains(row) || dragGhost) return;
        startDrag(row, kind, pl, container);
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        if (!document.body.contains(row) || dragGhost) return;
        startDrag(row, kind, pl, container);
      }, DRAG_HOLD_MS);
    });
    row.addEventListener('mousemove', (e) => {
      if (!timer) return;
      if (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12) cancel(); // 提前移动过大＝普通点击/滚动
    });
    row.addEventListener('mouseup', cancel);
    // 捕获阶段拦截：拖拽结束后的 mouseup 会触发一次 click，不能让它打开歌单；编辑模式下点击行也不打开歌单
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return; // 行内按钮（删除/收藏）正常响应
      if (suppressRowClick || state.editMode) { suppressRowClick = false; e.stopPropagation(); e.preventDefault(); }
    }, true);
  }
  function startDrag(row, kind, pl, container) {
    const ind = el('div', 'drop-indicator');
    container.appendChild(ind);
    row.classList.add('dragging');
    // 浮动幽灵行：克隆外观跟随鼠标（不响应事件，仅视觉）
    const rect = row.getBoundingClientRect();
    const ghost = row.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('dragging'); // 克隆时原行已带 dragging(半透明)，幽灵要完全不透明
    ghost.style.width = rect.width + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    document.body.appendChild(ghost);
    dragGhost = { row, kind, pl, container, ind, idx: null, moved: false, ghost };
    const move = (e) => {
      if (!dragGhost) return;
      dragGhost.moved = true;
      // 幽灵行跟随鼠标（光标在行右上附近，避免遮挡虚线落点）
      ghost.style.left = (e.clientX + 12) + 'px';
      ghost.style.top = (e.clientY - rect.height / 2) + 'px';
      const rows = Array.from(container.querySelectorAll('.nav-item')).filter((r) => r !== row);
      // 宽松落点判定：行很矮，用"行中点"当边界要拖得很远才触发。
      // 改为方向感知——向下拖：光标越过某行顶部 6px 即插到它前面；向上拖：越过某行底部 6px 即插到它前面。
      const srcR = row.getBoundingClientRect();
      const movingDown = e.clientY > srcR.top + srcR.height / 2; // 光标在源行中点下方 = 正在向下拖
      let idx = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const rc = rows[i].getBoundingClientRect();
        const b = movingDown ? rc.top + 6 : rc.bottom - 6;
        if (e.clientY < b) { idx = i; break; }
      }
      dragGhost.idx = idx;
      if (idx < rows.length) ind.style.top = (rows[idx].offsetTop - 2) + 'px';
      else if (rows.length) ind.style.top = (rows[rows.length - 1].offsetTop + rows[rows.length - 1].offsetHeight + 2) + 'px';
      ind.style.display = 'block';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!dragGhost) return;
      const dg = dragGhost;
      dragGhost = null;
      dg.ind.remove();
      dg.ghost.remove(); // 移除浮动幽灵
      dg.row.classList.remove('dragging');
      if (dg.moved && dg.idx != null) {
        suppressRowClick = true;
        applyReorder(dg.kind, dg.pl, dg.idx);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
  async function applyReorder(kind, pl, idx) {
    if (kind === 'dir') {
      // 曲库目录拖拽排序：重排 config.dirs 并持久化（只改顺序，不影响扫描结果）
      const from = state.dirs.indexOf(pl);
      if (from < 0) return;
      const arr = state.dirs.slice();
      const [item] = arr.splice(from, 1);
      arr.splice(Math.max(0, Math.min(idx, arr.length)), 0, item);
      state.dirs = await window.api.setDirOrder(arr);
      renderDirs();
      renderNav(); // 刷新 active 高亮
      return;
    }
    // 我的歌单显示顺序 = plOrder（跨本地/在线统一排序）；拖拽后把新顺序落盘 pl-order.json
    const savedOpls = state.onlinePlaylists.filter((p) => p.fav || p.downloaded);
    const mine = [
      ...state.playlists.map((p) => ({ kind: 'local', key: 'playlist:' + p.id, pl: p })),
      ...savedOpls.map((p) => ({ kind: 'opl', key: 'opl:' + p.id, pl: p })),
    ];
    const order = (state.plOrder || []).slice();
    mine.sort((a, b) => {
      const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });
    const from = mine.findIndex((m) => m.key === (kind === 'opl' ? 'opl:' + pl.id : 'playlist:' + pl.id));
    if (from < 0) return;
    const [item] = mine.splice(from, 1);
    mine.splice(Math.max(0, Math.min(idx, mine.length)), 0, item);
    state.plOrder = mine.map((m) => m.key);
    await window.api.savePlOrder(state.plOrder);
    renderNav();
  }

  function setView(view) {
    state.view = view;
    let title = '曲库', list = state.songs;
    if (view.startsWith('playlist:')) {
      const pl = state.playlists.find((x) => 'playlist:' + x.id === view);
      if (!pl) return setView('library');
      title = pl.name;
      // 歌单条目可为本地歌曲 id（字符串）或在线歌曲对象（收藏/加入歌单的在线歌）
      list = pl.songIds.map((e) => typeof e === 'string' ? state.songs.find((s) => s.id === e) : e).filter(Boolean);
    } else if (view.startsWith('opl:')) {
      const pl = state.onlinePlaylists.find((x) => 'opl:' + x.id === view);
      if (!pl) return setView('library');
      title = pl.name;
      list = pl.songs;
      $('#onlineBar').classList.remove('hidden');
      $('#btnOnlineClose').classList.remove('hidden');
      $('#onlineBarText').textContent = `在线歌单「${pl.name}」· ${pl.source === 'netease' ? '网易云' : '酷狗'} · ${pl.songs.length} 首` + (pl.desc ? ` — ${pl.desc}` : '');
      // 「一键下载全部」按钮：在线歌单视图才显示，进入即绑定（收藏的持久化歌单重启后同样可用）
      const dlAll = $('#oplDlAll');
      if (dlAll) { dlAll.classList.remove('hidden'); dlAll.onclick = () => downloadBatch(list); }
    } else if (view.startsWith('album:')) {
      // 专辑钻取：从本地曲库按 专辑+歌手 分组定位
      const key = decodeURIComponent(view.slice('album:'.length));
      const g = buildAlbumMap(state.songs).get(key);
      if (!g) return setView('library');
      title = g.album + (g.artist ? ` — ${g.artist}` : '');
      list = g.songs;
      $('#onlineBar').classList.remove('hidden');
      $('#btnOnlineClose').classList.remove('hidden');
      $('#onlineBarText').textContent = `专辑「${g.album}」· ${g.songs.length} 首${g.artist ? ' · ' + g.artist : ''}（点击 ✕ 返回曲库）`;
    } else if (view.startsWith('dir:')) {
      // 曲库目录钻取：按路径前缀过滤本地曲库
      const dir = decodeURIComponent(view.slice('dir:'.length));
      const dk = dir.toLowerCase();
      list = state.songs.filter((s) => (s.path || '').toLowerCase().startsWith(dk));
      title = dir.replace(/\\$/, '').split('\\').pop() || dir;
    } else if (view === 'favorites') {
      title = '收藏';
      // 收藏条目：字符串=本地歌曲 id；对象=在线收藏的歌曲（重启后可恢复播放）
      list = state.favorites.map(favToSong).filter(Boolean);
    } else if (view === 'history') {
      title = '最近播放';
      const ids = state.history.map((h) => h.id);
      list = ids.map((id) => state.songs.find((s) => s.id === id)).filter(Boolean);
    }
    if (state.view !== 'online' && !state.view.startsWith('opl:') && !state.view.startsWith('album:')) {
      $('#onlineBar').classList.add('hidden');
    }
    // 「一键下载全部」只在在线歌单视图显示
    const dlAll2 = $('#oplDlAll');
    if (dlAll2) dlAll2.classList.toggle('hidden', !view.startsWith('opl:'));
    $('#viewTitleText').textContent = title;
    // 曲库/歌单/专辑/收藏/最近播放视图：主窗口上方标题右侧显示歌曲数量
    const vc = $('#viewCount');
    const countable = view === 'library' || view.startsWith('playlist:') || view.startsWith('opl:') || view.startsWith('album:') || view.startsWith('dir:') || view === 'favorites' || view === 'history';
    if (vc) {
      if (countable && list.length) { vc.textContent = list.length + ' 首'; vc.classList.remove('hidden'); }
      else vc.classList.add('hidden');
    }
    // 「全部播放」按钮：曲库/收藏/最近播放/歌单/专辑等所有主窗视图都显示（在线搜索结果的 visibleList 同样可播）
    const pab = $('#viewPlayAll');
    if (pab) pab.classList.remove('hidden');
    updateSearchPlaceholder(); // 搜索框占位符随视图变化（歌单内搜索提示）
    state.list = list;
    renderNav();
    renderList();
  }

  // 搜索框占位符：在线模式提示在线搜索；本地模式按当前视图提示"歌单内搜索"等
  function updateSearchPlaceholder() {
    const inp = $('#search');
    if (!inp) return;
    if (state.searchMode === 'online') { inp.placeholder = '在线搜索网易云 / 酷狗，回车搜索…'; return; }
    const v = state.view || 'library';
    let ph = '搜索歌曲 / 艺术家 / 专辑…';
    if (v.startsWith('playlist:')) {
      const pl = state.playlists.find((x) => 'playlist:' + x.id === v);
      if (pl) ph = `在歌单「${pl.name}」中搜索…`;
    } else if (v.startsWith('opl:')) {
      const pl = state.onlinePlaylists.find((x) => 'opl:' + x.id === v);
      if (pl) ph = `在歌单「${pl.name}」中搜索…`;
    } else if (v.startsWith('dir:')) {
      const d = decodeURIComponent(v.slice('dir:'.length));
      ph = `在「${d.replace(/\\$/, '').split('\\').pop() || d}」中搜索…`;
    } else if (v === 'favorites') ph = '在收藏中搜索…';
    else if (v === 'history') ph = '在最近播放中搜索…';
    inp.placeholder = ph;
  }

  // ---------- 列表渲染 ----------
  function visibleList() {
    if (state.view === 'online') return state.list;
    const q = state.filter.trim().toLowerCase();
    if (!q) return state.list;
    return state.list.filter((s) =>
      (s.title || '').toLowerCase().includes(q) ||
      (s.artist || '').toLowerCase().includes(q) ||
      (s.album || '').toLowerCase().includes(q)
    );
  }

  // ---------- 在线搜索（网易云/酷狗，LeiZ）----------
  const SRC_NAMES = { netease: '网易云', kugou: '酷狗' };
  async function onlineSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    state.onlineQuery = q;
    $('#btnOnlineClose').classList.remove('hidden');
    $('#onlineBar').classList.remove('hidden');
    $('#onlineBarText').textContent = `在线搜索「${q}」…`;
    // 在线搜索结果视图没有"一键下载全部"（只有在线歌单有）
    const dlAll3 = $('#oplDlAll');
    if (dlAll3) dlAll3.classList.add('hidden');
    // 两家并行搜，但各自 10s 封顶：某一家卡住/超时不拖垮整体（LeiZ 服务端最坏能到 20s）
    const withTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
    const np = withTimeout(window.api.leizSearch('netease', q).catch(() => null), 10000);
    const kp = withTimeout(window.api.leizSearch('kugou', q).catch(() => null), 10000);
    $('#onlineBarText').textContent = `在线搜索「${q}」…（网易云）`;
    const n = await np;
    $('#onlineBarText').textContent = `在线搜索「${q}」…（网易云 ${n && n.ok ? '✓' : '✗'}，酷狗…）`;
    const k = await kp;
    const list = [];
    if (n && n.ok && Array.isArray(n.data)) {
      for (const it of n.data) {
        if (!it || !it.id) continue;
        list.push({
          id: 'online:netease:' + it.id,
          online: true, source: 'netease', ref: String(it.id),
          title: it.name || '', artist: it.artists || '', album: it.album || '',
          duration: it.duration || 0, picUrl: it.picUrl || '', level: 'lossless'
        });
      }
    }
    if (k && k.ok && Array.isArray(k.data)) {
      for (const it of k.data) {
        if (!it || !it.hash) continue;
        list.push({
          id: 'online:kugou:' + it.hash,
          online: true, source: 'kugou', ref: (it.shareUrl && /^https?:\/\//.test(it.shareUrl)) ? it.shareUrl : String(it.hash),
          title: it.name || '', artist: it.artists || '', album: it.album || '',
          duration: it.duration || 0, picUrl: it.picUrl || '', level: '128'
        });
      }
    }
    state.view = 'online';
    state.list = list;
    $('#onlineBarText').textContent = `在线搜索「${q}」：${list.length} 条结果（网易云 ${(n && n.ok && n.data ? n.data.length : 0)} / 酷狗 ${(k && k.ok && k.data ? k.data.length : 0)}）`;
    renderNav();
    renderList();
    if (!list.length) toast('在线搜索无结果，换个关键词试试');
  }

  function closeOnline() {
    state.view = 'library';
    state.list = state.songs;
    state.onlineQuery = '';
    $('#onlineBar').classList.add('hidden');
    renderNav();
    renderList();
  }

  // ---------- 歌单一键导入（网易云/酷狗链接或 id，LeiZ）----------
  // Electron 里 window.prompt 被禁用（点击无反应），改用应用内输入面板
  function importOnlinePlaylist() {
    $('#oplImportOverlay').classList.remove('hidden');
    $('#oplImportInput').value = '';
    $('#oplImportInput').focus();
  }
  function closeOplImport() {
    $('#oplImportOverlay').classList.add('hidden');
  }
  async function doImportOnlinePlaylist(raw) {
    if (!raw || !raw.trim()) { toast('请输入歌单链接或 ID'); return; }
    const s = raw.trim();
    // 酷狗分享链接（t1.kugou.com 短链 / share 页）：没有标准歌单 ID，直接从分享页提取歌曲列表
    if (/t1\.kugou\.com|kugou\.com\/share|wwwapi\.kugou\.com/i.test(s)) {
      toast('正在解析酷狗分享链接…');
      const r = await window.api.leizShare(s).catch(() => null);
      if (!r || !r.ok || !r.songs || !r.songs.length) {
        toast('分享解析失败：' + ((r && r.reason) || '网络异常'));
        return;
      }
      const songs = r.songs;
      const pl = { id: 'k:share:' + Date.now(), name: `酷狗分享歌单（${songs.length} 首）`, source: 'kugou', cover: '', desc: '来自酷狗分享链接', songs };
      state.onlinePlaylists.unshift(pl); // 未收藏 → 仅会话内，重启清除；点星收藏后才落盘
      closeOplImport();
      toast(`歌单导入成功：${pl.name}`);
      setView('opl:' + pl.id); // setView 会绑定一键下载全部按钮
      return;
    }
    let source, ref;
    if (/163cn\.tv|music\.163\.com|netease/i.test(s)) {
      source = 'netease';
      const m = s.match(/playlist\?(?:[^#]*&)?id=(\d+)/) || s.match(/playlist\/(\d+)/) || s.match(/^(\d{5,15})$/) || s.match(/id=(\d+)/);
      ref = m ? m[1] : s;
    } else if (/kugou\.com|gcid_/i.test(s)) {
      source = 'kugou';
      const mp = s.match(/plist\/list\/(\d+)/);
      ref = mp ? mp[1] : s;
      if (/songlist\/gcid_|gcid_/.test(s) && !mp) {
        toast('酷狗 gcid 歌单链接暂无法解析（服务商上游故障）。\n请用酷狗客户端「分享→复制链接」得到的 m.kugou.com/plist/list/数字 链接，或直接粘贴歌单数字 ID。');
        return;
      }
    } else if (/^\d{5,15}$/.test(s)) {
      source = 'netease'; ref = s;
    } else {
      toast('无法识别歌单链接（支持网易云 / 酷狗）');
      return;
    }
    toast('正在导入歌单…');
    const r = await window.api.leizPlaylist(source, ref).catch(() => null);
    if (!r || !r.ok || !r.data) {
      toast(`歌单导入失败：${(r && r.reason) || '网络异常或链接无效'}`);
      return;
    }
    const d = r.data;
    const songs = [];
    const rawSongs = Array.isArray(d.songs) ? d.songs : [];
    for (const it of rawSongs) {
      if (!it) continue;
      const songRef = source === 'netease' ? String(it.id || '') : String(it.hash || it.id || '');
      if (!songRef) continue;
      songs.push({
        id: 'online:' + source + ':' + songRef,
        online: true, source, ref: songRef,
        title: it.name || '', artist: it.artists || '', album: it.album || '',
        duration: it.duration || 0, picUrl: it.picUrl || '', level: source === 'netease' ? 'lossless' : '128'
      });
    }
    if (!songs.length) {
      toast('歌单为空或解析失败');
      return;
    }
    const pl = {
      id: (source === 'netease' ? 'n' : 'k') + ':' + (source === 'netease' ? ref : (ref.match(/gcid_(\w+)/) || [null, ref])[1]),
      name: d.name || '在线歌单', source, cover: d.cover || '', desc: d.desc || '', songs
    };
    const dup = state.onlinePlaylists.findIndex((x) => x.id === pl.id);
    if (dup >= 0) state.onlinePlaylists.splice(dup, 1);
    state.onlinePlaylists.unshift(pl); // 未收藏 → 仅会话内，重启清除；点星收藏后才落盘
    closeOplImport();
    toast(`歌单导入成功：${pl.name}（${songs.length} 首）`);
    setView('opl:' + pl.id); // setView 会绑定一键下载全部按钮
  }

  const EMPTY_TEXT = {
    library: '曲库是空的 — 点右上角「＋ 添加文件夹」',
    favorites: '还没有收藏 — 点击歌曲行的心形即可收藏',
    history: '暂无播放记录',
    playlist: '该歌单还没有歌曲 — 在曲库里右键歌曲加入',
    online: '在线搜索无结果 — 换个关键词试试'
  };

  function currentPlaylistId() {
    return state.view.startsWith('playlist:') ? state.view.slice('playlist:'.length) : null;
  }

  async function renderList() {
    // 视图模式：0=列表 1=歌曲墙 2=专辑墙（专辑钻取视图 'album:...' 时始终显示歌曲列表）
    if (state.gridMode === 1 && visibleList().length) return renderGrid();
    if (state.gridMode === 2 && visibleList().length && !state.view.startsWith('album:')) return renderAlbumGrid();
    $('#gridBody').classList.add('hidden');
    $('#tableWrap').classList.remove('hidden');
    const tbody = $('#songBody');
    tbody.innerHTML = '';
    const vis = visibleList();

    if (vis.length === 0) {
      $('#empty').classList.remove('hidden');
      const q = state.filter.trim();
      const plId = currentPlaylistId();
      $('#empty').textContent = q
        ? `未找到与「${q}」匹配的歌曲`
        : (plId ? EMPTY_TEXT.playlist : (state.view.startsWith('dir:') ? '该目录下没有歌曲' : (EMPTY_TEXT[state.view] || EMPTY_TEXT.library)));
      return;
    }
    $('#empty').classList.add('hidden');

    const frag = document.createDocumentFragment();
    const isPlaylistView = !!currentPlaylistId();
    vis.forEach((song) => {
      const tr = el('tr');
      tr.dataset.id = song.id;
      if (isPlaylistView) tr.draggable = true; // 歌单视图可拖拽排序
      const isPlaying = currentSong() && currentSong().id === song.id;
      if (isPlaying) tr.classList.add('playing');
      if (state.selectedId === song.id) tr.classList.add('selected');
      if (song.missing) tr.classList.add('missing');

      const tdCover = el('td', 'c-cover');
      const cover = el('span', 's-cover');
      if (song.online && song.picUrl) {
        const img = el('img');
        img.src = song.picUrl;
        cover.appendChild(img);
      } else if (song.online) {
        // 在线歌曲无封面信息（如酷狗分享页只有 album_id）→ 占位 + 后台按 album_id 拉取专辑封面
        cover.innerHTML = ICONS.note;
        cover.dataset.id = song.id;
        const hint = el('span', 'play-hint');
        hint.innerHTML = ICONS.playHint;
        cover.appendChild(hint);
        loadOnlineCover(song).then((src) => {
          if (!src) return;
          const cell = document.querySelector(`#songBody tr[data-id="${CSS.escape(song.id)}"] .s-cover`);
          if (cell && !cell.querySelector('img')) {
            cell.innerHTML = '';
            const img = el('img');
            img.src = src;
            cell.appendChild(img);
          }
        });
      } else {
        // 已缓存的封面同步渲染（避免重渲染后封面"闪没"）；否则音符/动画条占位，observer 懒加载
        const cachedCover = coverCache.get(song.id);
        if (cachedCover) {
          const img = el('img');
          img.src = cachedCover;
          cover.appendChild(img);
        } else {
          cover.innerHTML = (isPlaying && !song.hasCover)
            ? '<span class="playing-bars"><i></i><i></i><i></i></span>'
            : ICONS.note;
          cover.dataset.id = song.id;
          const hint = el('span', 'play-hint');
          hint.innerHTML = ICONS.playHint;
          cover.appendChild(hint);
          coverObserver.observe(cover);
        }
      }
      tdCover.appendChild(cover);
      // 单击音符列 = 立即播放该歌
      cover.addEventListener('click', (e) => {
        e.stopPropagation();
        playList(vis, vis.indexOf(song), 0, true, true);
      });

      const tdTitle = el('td', 'c-title');
      const tTxt = el('span', 's-title');
      tTxt.textContent = song.missing ? song.title + '（文件丢失）' : song.title;
      tdTitle.appendChild(tTxt);
      // 在线/本地标签：标题右侧固定列宽（所有行同一竖线）
      tdTitle.appendChild(el('span', 'song-tag ' + (song.online ? 'online' : 'local'), song.online ? '在线' : '本地'));

      const tdArtist = el('td', 'c-artist', song.artist || '—');
      const tdAlbum = el('td', 'c-album');
      const albumTxt = el('span', null, song.album || '—');
      tdAlbum.appendChild(albumTxt);
      if (song.online) {
        const badge = el('span', 'src-badge', SRC_NAMES[song.source] || '在线');
        tdAlbum.appendChild(badge);
      }
      const tdDur = el('td', 'c-dur', song.duration ? fmtTime(song.duration) : '—');

      // 下载列：独立一列，放在收藏心左边 → 所有行的下载按钮横坐标对齐（不再紧跟歌名）
      const tdDl = el('td', 'c-dl');
      if (song.online) {
        const dl = el('button', 'dl-btn');
        dl.innerHTML = dlBtnInner(song.id);
        dl.title = '下载到本地';
        dl.addEventListener('click', (e) => { e.stopPropagation(); downloadOne(song); });
        tdDl.appendChild(dl);
      }

      const tdFav = el('td', 'c-fav');
      {
        const fav = el('button', 'fav-btn');
        const favOn = isFav(song.id);
        fav.classList.toggle('on', favOn);
        fav.innerHTML = favOn ? ICONS.heartFill : ICONS.heart;
        fav.title = song.online ? (favOn ? '取消收藏（在线）' : '收藏（在线歌曲，保存在本地）') : (favOn ? '取消收藏' : '收藏');
        fav.addEventListener('click', async (e) => {
          e.stopPropagation();
          // 在线歌曲收藏：传完整歌曲对象（主进程存对象，重启可恢复播放）
          state.favorites = await window.api.toggleFavorite(song.id, song.online ? song : undefined);
          const on = isFav(song.id);
          fav.innerHTML = on ? ICONS.heartFill : ICONS.heart;
          fav.classList.toggle('on', on);
          $('#countFav').textContent = state.favorites.length;
          if (state.view === 'favorites') renderList();
        });
        tdFav.appendChild(fav);
      }

      tr.append(tdCover, tdTitle, tdArtist, tdAlbum, tdDur, tdDl, tdFav);
      tr.addEventListener('dblclick', () => playList(vis, vis.indexOf(song), 0, true, true));
      tr.addEventListener('click', () => {
        document.querySelectorAll('#songBody tr.selected').forEach((r) => r.classList.remove('selected'));
        tr.classList.add('selected');
        state.selectedId = song.id;
      });
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, song);
      });
      tr.tabIndex = 0;
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') playList(vis, vis.indexOf(song), 0, true, true);
      });
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  // ---------- 封面墙（网格视图，酷狗式） ----------
  const gridObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const cover = en.target;
      const id = cover.dataset.id;
      if (id && !coverCache.has(id)) {
        getCover(id).then((src) => {
          if (!src) { coverCache.set(id, null); return; }
          cover.innerHTML = '';
          const img = el('img');
          img.src = src;
          cover.appendChild(img);
        });
      }
      gridObserver.unobserve(cover);
    }
  }, { rootMargin: '150px' });

  function renderGrid() {
    const wrap = $('#gridBody');
    wrap.innerHTML = '';
    wrap.classList.remove('hidden');
    $('#tableWrap').classList.add('hidden');
    $('#empty').classList.add('hidden');
    const vis = visibleList();
    const frag = document.createDocumentFragment();
    vis.forEach((song, idx) => {
      const card = el('div', 'grid-card');
      card.dataset.id = song.id;
      const cover = el('div', 'gc-cover');
      const cached = coverCache.get(song.id);
      if (cached) {
        const img = el('img');
        img.src = cached;
        cover.appendChild(img);
      } else if (song.online) {
        // 在线歌曲无封面 → 后台按 album_id 拉取（酷狗专辑封面）
        cover.innerHTML = ICONS.note;
        cover.dataset.id = song.id;
        loadOnlineCover(song).then((src) => {
          if (!src) return;
          const cell = document.querySelector(`#gridBody .grid-card[data-id="${CSS.escape(song.id)}"] .gc-cover`);
          if (cell && !cell.querySelector('img')) {
            cell.innerHTML = '';
            const img = el('img');
            img.src = src;
            cell.appendChild(img);
          }
        });
      } else {
        cover.innerHTML = ICONS.note;
        cover.dataset.id = song.id;
        gridObserver.observe(cover);
      }
      const isPlaying = currentSong() && currentSong().id === song.id;
      if (isPlaying) {
        cover.classList.add('playing');
        const bars = el('span', 'gc-bars');
        bars.innerHTML = '<i></i><i></i><i></i>';
        cover.appendChild(bars);
      }
      const title = el('div', 'gc-title', song.missing ? song.title + '（文件丢失）' : song.title);
      const sub = el('div', 'gc-sub', song.artist || '');
      card.append(cover, title, sub);
      card.addEventListener('click', () => playList(vis, idx, 0, true, true));
      frag.appendChild(card);
    });
    wrap.appendChild(frag);
  }

  // ---------- 专辑墙（按专辑分组，一张封面=一张专辑；点击钻取专辑歌曲） ----------
  const ALBUM_UNKNOWN = '未知专辑';
  let albumMapCache = null; // key: album+'\u0000'+artist → {album, artist, songs:[]}
  function buildAlbumMap(songs) {
    if (albumMapCache && albumMapCache.src === songs) return albumMapCache.map;
    const map = new Map();
    for (const s of songs) {
      if (s.online) continue; // 在线搜索结果不入专辑墙（无专辑字段价值）
      const album = (s.album && s.album.trim()) || ALBUM_UNKNOWN;
      const key = album + '\u0000' + (s.artist || '');
      let g = map.get(key);
      if (!g) { g = { album, artist: s.artist || '', songs: [] }; map.set(key, g); }
      g.songs.push(s);
    }
    albumMapCache = { src: songs, map };
    return map;
  }
  function renderAlbumGrid() {
    const wrap = $('#gridBody');
    wrap.innerHTML = '';
    wrap.classList.remove('hidden');
    $('#tableWrap').classList.add('hidden');
    $('#empty').classList.add('hidden');
    const vis = visibleList();
    const map = buildAlbumMap(vis);
    const groups = [...map.values()].sort((a, b) => b.songs.length - a.songs.length || a.album.localeCompare(b.album, 'zh'));
    const frag = document.createDocumentFragment();
    groups.forEach((g) => {
      const card = el('div', 'grid-card album-card');
      const cover = el('div', 'gc-cover');
      // 封面取专辑内第一首的封面（懒加载）
      const first = g.songs.find((s) => s.id && !s.missing) || g.songs[0];
      const cached = first ? coverCache.get(first.id) : null;
      if (cached) {
        const img = el('img');
        img.src = cached;
        cover.appendChild(img);
      } else if (first) {
        cover.innerHTML = ICONS.note;
        cover.dataset.id = first.id;
        gridObserver.observe(cover);
      } else {
        cover.innerHTML = ICONS.note;
      }
      // 播放中徽标：专辑内任一歌在播
      const cur = currentSong();
      if (cur && g.songs.some((s) => s.id === cur.id)) {
        cover.classList.add('playing');
        const bars = el('span', 'gc-bars');
        bars.innerHTML = '<i></i><i></i><i></i>';
        cover.appendChild(bars);
      }
      const count = el('span', 'gc-count', g.songs.length + '首');
      cover.appendChild(count);
      const title = el('div', 'gc-title', g.album);
      const sub = el('div', 'gc-sub', g.artist || (g.album === ALBUM_UNKNOWN ? '' : '未知歌手'));
      card.append(cover, title, sub);
      card.addEventListener('click', () => setView('album:' + encodeURIComponent(g.album + '\u0000' + g.artist)));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        playList(g.songs.slice(), 0, 0, true, true); // 右键=整张专辑开始播放
      });
      frag.appendChild(card);
    });
    wrap.appendChild(frag);
  }

  // 列表 ↔ 歌曲墙 ↔ 专辑墙 循环切换
  const GRID_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  const ALBUM_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 1 9-9"/><path d="M12 12a3 3 0 1 1 3 3"/><circle cx="15.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/></svg>';
  const VIEW_TITLES = ['列表视图', '歌曲封面墙', '专辑视图'];
  function updateViewSwitch() {
    const m = state.gridMode;
    $('#viewSwitch').innerHTML = m === 0 ? GRID_ICON : (m === 1 ? ALBUM_ICON : ICONS.list);
    $('#viewSwitch').title = VIEW_TITLES[(m + 1) % 3]; // 提示点击后切到哪个
  }
  function toggleGrid() {
    state.gridMode = (state.gridMode + 1) % 3;
    try { localStorage.setItem('mp_grid', String(state.gridMode)); } catch { /* 忽略 */ }
    updateViewSwitch();
    renderList();
  }

  // 封面懒加载（进入视口才请求）
  const coverObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const cover = en.target;
      const id = cover.dataset.id;
      if (id && !coverCache.has(id)) {
        getCover(id).then((src) => {
          if (!src) { coverCache.set(id, null); return; }
          const img = el('img');
          img.src = src;
          cover.textContent = '';
          cover.appendChild(img);
        });
      }
      coverObserver.unobserve(cover);
    }
  }, { rootMargin: '100px' });

  function currentSong() {
    return state.queue[state.queueIndex] || null;
  }

  // ---------- 播放核心（队列与视图解耦） ----------
  // 加载并播放单曲：play 被拒（数据未就绪）→ 等 canplay 自动补播，保证一次点击即响
  // autoPlay=false 时仅加载（恢复上次进度用），保持暂停
  function startSong(song, seekTo, autoPlay = true) {
    state.playingId = song.id;
    // 在线歌曲：主进程解析直链（网易云 id / 酷狗 hash 或分享链接）
    if (song.online) {
      audio.dataset.songId = song.id;
      (async () => {
        const r = await window.api.leizResolve(song.source, song.ref, song.level || 'lossless').catch(() => null);
        if (state.playingId !== song.id) return;
        if (r && r.ok && r.data && r.data.url) {
          audio.src = r.data.url;
          if (seekTo) audio.addEventListener('loadedmetadata', () => { audio.currentTime = seekTo; }, { once: true });
          if (autoPlay) {
            const p = audio.play();
            if (p && p.catch) p.catch(() => {
              audio.addEventListener('canplay', () => {
                if (state.playingId === song.id && audio.paused) audio.play().catch(() => {});
              }, { once: true });
            });
          }
        } else {
          toast(`在线歌曲解析失败：${(r && r.reason) || '网络异常'}`);
          if (autoPlay) state.errStreak++;
        }
      })();
      return;
    }
    window.api.toFileUrl(song.path).then((url) => {
      if (state.playingId !== song.id) return; // 竞态守卫
      audio.dataset.songId = song.id;
      audio.src = url;
      if (seekTo) {
        audio.addEventListener('loadedmetadata', () => { audio.currentTime = seekTo; }, { once: true });
      }
      if (!autoPlay) return; // 加载不播放（恢复模式）
      const p = audio.play();
      if (p && p.catch) p.catch(() => {
        audio.addEventListener('canplay', () => {
          if (state.playingId === song.id && audio.paused) audio.play().catch(() => {});
        }, { once: true });
      });
    });
  }

  // 最近歌单：播放时记录当前视图所属歌单的 lastPlayedAt（本地歌单与在线歌单都记）
  function markPlaylistPlayed() {
    const v = state.view;
    if (v.startsWith('playlist:')) {
      const pl = state.playlists.find((x) => 'playlist:' + x.id === v);
      if (pl) { pl.lastPlayedAt = Date.now(); window.api.savePlaylists(state.playlists).catch(() => {}); renderNav(); }
    } else if (v.startsWith('opl:')) {
      const pl = state.onlinePlaylists.find((x) => 'opl:' + x.id === v);
      if (pl) { pl.lastPlayedAt = Date.now(); saveOpls(); renderNav(); }
    }
  }

  // fromUser=true：用户主动点歌 → 自动进入大封面播放页（酷狗式：前台缩略图 = 封面）
  // keepShuffle=true：playNext/playPrev 内部调用，不重建随机顺序（保持"播完一轮"语义）
  async function playList(list, idx, seekTo, autoPlay = true, fromUser = false, keepShuffle = false) {
    if (!list || !list.length) { toast('请先选择歌曲'); return; }
    const song = list[idx];
    if (!song) return;
    markPlaylistPlayed(); // 记录"最近听过"的歌单（仅当从歌单视图播放时生效）
    // 平滑切歌：用户主动点别的歌（列表/歌单/专辑/队列跳播）→ 旧歌快速淡出（150ms）再切，避免硬切
    // 自动连播（ended→playNext）时 audio 已 ended（paused=true）自动跳过；手动上一首/下一首由 nextOrPrev 先行淡出
    if (autoPlay && fromUser && !state._switching && !audio.paused && audio.currentSrc && currentSong() && currentSong().id !== song.id) {
      state._switching = true;
      await fadeOut(150);
      state._switching = false;
    }
    state.queue = list.slice();
    state.queueIndex = idx;
    if (state.mode === 'shuffle' && !keepShuffle) rebuildShuffle(); // 新会话（用户点歌/恢复）→ 重排随机顺序
    state.selectedId = song.id;
    state.errStreak = 0;
    state._tailFaded = false; // 新歌：结尾淡出标志复位
    lastAudioTime = 0; // 切歌：时间基准归零（新歌从 0 开始，防旧值干扰）
    if (autoPlay) {
      state.fadePending = true;   // 切歌/开始播放 → 淡入
      audio.volume = 0;
      audio.playbackRate = state.rate; // 保持倍速
    }
    startSong(song, seekTo, autoPlay);
    updatePlayingUI(song);
    renderList(); // 刷新表格行播放状态（修复切歌后旧行残留播放图标）
    thumbCoverKey = null; // 切歌 → 缩略图封面重新获取
    window.api.sendTitle(song.missing ? song.title + '（文件丢失）' : song.title); // 窗口标题 = 歌曲名（任务栏缩略图上方文字）

    window.api.sendLyricLine({ line: '', title: song.title, artist: song.artist });
    window.api.addHistory(song.id);
    if (song.online) loadOnlineLyrics(song); else loadLyrics(song.id);
    setupMediaSession(song);
    savePlaybackState();
    // SMTC 任务栏音符按钮：更新标题/歌手/封面（首次调用自动初始化）
    // 切歌（autoPlay）时 audio 尚未进入播放态，直接按即将播放上报
    window.api.smtcUpdate({ title: song.title, artist: song.artist || '', playing: autoPlay ? true : !audio.paused, coverId: song.id, enabled: true });
    // 已在封面页时切歌同步更新（不自动跳页——酷狗点歌停留列表）
    if (!$('#pageDetail').classList.contains('hidden')) showDetail();
    updateQueueUI(); // 队列徽标/面板同步（queueIndex/queue 已变）
  }

  function playById(id, seekTo) {
    const idx = state.songs.findIndex((s) => s.id === id);
    if (idx >= 0) playList(state.songs, idx, seekTo);
  }

  function updatePlayingUI(song) {
    $('#pTitle').textContent = song.missing ? song.title + '（文件丢失）' : song.title;
    $('#pArtist').textContent = song.artist || '';
    const pimg = $('#pCoverImg');
    const pnote = $('#pCover > svg');
    if (!song.missing) {
      // 在线歌曲：直接使用在线封面 picUrl
      if (song.online) {
        if (song.picUrl) {
          pimg.src = song.picUrl; pimg.classList.remove('hidden'); pnote.style.display = 'none';
          const bgImg = $('#appBgImg');
          if (bgImg.src !== song.picUrl) bgImg.src = song.picUrl;
          $('#appBg').classList.remove('hidden');
          sendThumbDIB(song.picUrl, !audio.paused);
        } else {
          pimg.classList.add('hidden'); pnote.style.display = '';
          $('#appBg').classList.add('hidden');
        }
      } else {
        // 无论 ID3 是否内嵌封面都请求（在线封面兜底）→ 播放条封面与缩略图同一张图
        getCover(song.id).then((src) => {
          if (state.playingId !== song.id) return;
          if (src) { pimg.src = src; pimg.classList.remove('hidden'); pnote.style.display = 'none'; }
          else { pimg.classList.add('hidden'); pnote.style.display = ''; }
          // 方案二：窗口背景同步封面（封面铺满，DWM 缩略图捕获窗口内容 = 封面）
          const bgImg = $('#appBgImg');
          if (src) { if (bgImg.src !== src) bgImg.src = src; $('#appBg').classList.remove('hidden'); }
          else { $('#appBg').classList.add('hidden'); }
          sendThumbDIB(src, !audio.paused); // 预生成封面 DIB → 任务栏缩略图注入（0x0323 响应，含播放状态）
        });
      }
    } else {
      pimg.classList.add('hidden');
      pnote.style.display = '';
      $('#appBg').classList.add('hidden');
    }
    document.querySelectorAll('#songBody tr.playing').forEach((r) => r.classList.remove('playing'));
    const row = document.querySelector(`#songBody tr[data-id="${CSS.escape(song.id)}"]`);
    if (row) row.classList.add('playing');
  }

  // 封面图 → 32bpp 预乘 ARGB DIB 数据 → 主进程（任务栏缩略图原生注入）
  // playing=false 时叠加"暂停"遮罩+播放图标（缩略图与主界面播放状态同步——修复此前暂停不同步）
  function sendThumbDIB(src, playing) {
    if (!src) return;
    try {
      const img = new Image();
      img.src = src;
      img.onload = () => {
        try {
          const SIZE = 320;
          const canvas = document.createElement('canvas');
          canvas.width = SIZE; canvas.height = SIZE;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, SIZE, SIZE);
          if (playing) {
            // 播放中：底部进度条（静态快照，位置占 1/3）
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.fillRect(0, SIZE - 8, SIZE, 8);
            ctx.fillStyle = 'rgba(255,255,255,0.95)';
            ctx.fillRect(0, SIZE - 8, SIZE * 0.33, 8);
          } else {
            // 暂停：半透明遮罩 + 白色播放三角（与主界面暂停状态同步）
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(0, 0, SIZE, SIZE);
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.moveTo(SIZE * 0.42, SIZE * 0.36);
            ctx.lineTo(SIZE * 0.42, SIZE * 0.64);
            ctx.lineTo(SIZE * 0.64, SIZE * 0.5);
            ctx.closePath();
            ctx.fill();
          }
          const d = ctx.getImageData(0, 0, SIZE, SIZE).data;
          const out = new Uint8ClampedArray(SIZE * SIZE * 4);
          for (let i = 0; i < d.length; i += 4) {
            const a = d[i + 3];
            out[i] = (d[i] * a / 255) | 0;       // R 预乘
            out[i + 1] = (d[i + 1] * a / 255) | 0; // G
            out[i + 2] = (d[i + 2] * a / 255) | 0; // B
            out[i + 3] = a;                        // A 原值
          }
          window.api.sendThumbDIB(out.buffer, SIZE, SIZE);
        } catch (e) { /* 封面转换失败忽略 */ }
      };
    } catch (e) { /* 忽略 */ }
  }

  // 随机模式：重建无重复随机顺序（Fisher-Yates），当前播放曲目固定在第 0 位
  // （这样"下一首"永远先播完一轮里的其他歌，播完一轮后重排，不会立即重复）
  function rebuildShuffle() {
    const n = state.queue.length;
    const cur = state.queueIndex;
    // 剩余列表 = 除当前歌外的全部下标
    const rest = [];
    for (let i = 0; i < n; i++) if (i !== cur) rest.push(i);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    state.shuffleOrder = [cur, ...rest]; // [当前, 其他全部去重随机]
    state.shufflePos = 0;
  }

  function playNext() {
    if (!state.queue.length) return;
    if (state.mode === 'shuffle') {
      if (state.queue.length === 1) return;
      // 走无重复随机顺序；一轮播完 → 重排（当前曲目放最前，下一首必为其他歌）
      state.shufflePos++;
      if (state.shufflePos >= state.shuffleOrder.length) {
        rebuildShuffle();
        state.shufflePos = 0;
        state.shufflePos++; // 跳过自己
      }
      let n = state.shuffleOrder[state.shufflePos];
      // 修复：重建顺序后必须重新取下标（旧 n 可能是 undefined/当前歌 → 卡住或重复播自己）
      if (n === undefined || n === state.queueIndex) {
        rebuildShuffle();
        state.shufflePos = 1;
        n = state.shuffleOrder[state.shufflePos];
      }
      if (n === undefined) n = state.queueIndex >= 0 ? state.queueIndex : 0; // 极端兜底
      playList(state.queue, n, 0, true, false, true);
      return;
    }
    const next = (state.queueIndex + 1) % state.queue.length;
    playList(state.queue, next);
  }

  function playPrev() {
    if (!state.queue.length) return;
    if (state.mode === 'shuffle') {
      // 随机模式：退回随机顺序的上一个（有历史感，不再是顺序退格）
      state.shufflePos = Math.max(0, state.shufflePos - 1);
      const n = state.shuffleOrder[state.shufflePos];
      if (n === undefined) { rebuildShuffle(); state.shufflePos = 0; }
      playList(state.queue, state.shuffleOrder[state.shufflePos] ?? state.queueIndex, 0, true, false, true);
      return;
    }
    const prev = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
    playList(state.queue, prev);
  }

  // ---------- 播放队列（下一首播放 / 加入队列 / 面板拖拽）----------
  // 下一首播放：插到当前歌之后（未在播放 → 直接播放该歌）
  function queuePlayNext(song) {
    if (!song) return;
    if (state.queueIndex < 0 || !state.queue.length) {
      playList([song], 0, 0, true, true);
      toast(`正在播放：${song.title}`);
      return;
    }
    if (state.mode === 'shuffle') {
      // 随机模式：新歌加入队尾，重排为 [当前, 新歌, 其余去重随机]
      const newIdx = state.queue.length;
      state.queue.push(song);
      const rest = [];
      for (let i = 0; i < newIdx; i++) if (i !== state.queueIndex) rest.push(i);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      state.shuffleOrder = [state.queueIndex, newIdx, ...rest];
      state.shufflePos = 0;
    } else {
      state.queue.splice(state.queueIndex + 1, 0, song);
    }
    updateQueueUI();
    toast(`已加入队列：${song.title}`);
  }

  // 添加到队列末尾
  function queueAppend(song) {
    if (!song) return;
    if (!state.queue.length) state.queue = [];
    state.queue.push(song);
    if (state.mode === 'shuffle' && state.shuffleOrder.length) {
      // 随机模式：按 id 去重后追加到本轮末尾（保持一轮无重复）
      const newIdx = state.queue.length - 1;
      state.shuffleOrder = state.shuffleOrder.filter((i) => state.queue[i] && state.queue[i].id !== song.id);
      state.shuffleOrder.push(newIdx);
    } else if (state.mode === 'shuffle') {
      rebuildShuffle();
      state.shuffleOrder.push(state.queue.length - 1);
    }
    updateQueueUI();
    toast(`已添加到队列：${song.title}`);
  }

  // 从队列移除（仅允许移除"即将播放"的项）
  function queueRemoveAt(idx) {
    if (idx < 0 || idx >= state.queue.length || idx === state.queueIndex) return;
    state.queue.splice(idx, 1);
    if (state.mode === 'shuffle' && state.shuffleOrder.length) {
      state.shuffleOrder = state.shuffleOrder.filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i));
      state.shufflePos = Math.min(state.shufflePos, Math.max(0, state.shuffleOrder.length - 1));
      if (state.queueIndex > idx) state.queueIndex--;
    } else if (state.queueIndex > idx) {
      state.queueIndex--;
    }
    updateQueueUI();
  }

  // 拖拽重排（from → to，均在"即将播放"区内）
  function queueMove(from, to) {
    if (from === to || from < 0 || to < 0 || from >= state.queue.length || to >= state.queue.length) return;
    const [item] = state.queue.splice(from, 1);
    state.queue.splice(to, 0, item);
    if (state.mode === 'shuffle') {
      // 重排后重建随机顺序（当前歌固定首位，其余重新洗牌）
      rebuildShuffle();
    }
    updateQueueUI();
  }

  function updateQueueUI() {
    renderQueue();
    const upcoming = state.queueIndex >= 0 ? Math.max(0, state.queue.length - state.queueIndex - 1) : state.queue.length;
    const badge = $('#queueBadge');
    if (upcoming > 0) { badge.textContent = upcoming > 99 ? '99+' : upcoming; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
    $('#queueCount').textContent = upcoming ? `（${upcoming} 首待播）` : '';
    if (!upcoming) $('#queueCount').textContent = '';
  }

  function renderQueue() {
    const wrap = $('#queueList');
    wrap.innerHTML = '';
    if (!state.queue.length) {
      wrap.appendChild(el('div', 'q-hint', '队列为空 — 在歌曲上右键「下一首播放」或「添加到队列」'));
      return;
    }
    const frag = document.createDocumentFragment();
    state.queue.forEach((song, idx) => {
      const row = el('div', 'q-row');
      if (idx === state.queueIndex) row.classList.add('current');
      const cover = el('span', 'q-cover');
      if (song.online && song.picUrl) {
        const img = el('img'); img.src = song.picUrl; cover.appendChild(img);
      } else {
        const cached = coverCache.get(song.id);
        if (cached) { const img = el('img'); img.src = cached; cover.appendChild(img); }
        else cover.innerHTML = ICONS.note;
      }
      const meta = el('div', 'q-meta');
      const t = el('div', 'q-title', song.title || '未知歌曲');
      const sub = el('div', 'q-sub');
      sub.textContent = (song.artist || '未知艺术家') + (song.online ? ` · ${SRC_NAMES[song.source] || song.source}` : '');
      meta.append(t, sub);
      row.appendChild(cover);
      row.appendChild(meta);
      if (idx === state.queueIndex) {
        row.appendChild(el('span', 'q-now', '♪ 正在播放'));
      } else {
        row.draggable = true;
        row.dataset.qidx = idx;
        const rm = el('button', 'q-rm');
        rm.title = '移出队列';
        rm.innerHTML = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
        rm.addEventListener('click', (e) => { e.stopPropagation(); queueRemoveAt(idx); });
        row.appendChild(rm);
        // HTML5 拖拽排序
        row.addEventListener('dragstart', (e) => {
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(idx));
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          row.classList.add('drag-over');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          row.classList.remove('drag-over');
          const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          const to = idx;
          document.querySelectorAll('#queueList .q-row.dragging').forEach((r) => r.classList.remove('dragging'));
          if (!isNaN(from) && from !== to && from !== state.queueIndex && to !== state.queueIndex) queueMove(from, to);
        });
      }
      row.addEventListener('click', () => playList(state.queue, idx, 0, true, true, true));
      frag.appendChild(row);
    });
    wrap.appendChild(frag);
  }

  function togglePlay() {
    if (!state.queue.length) {
      if (state.list.length) { playList(state.list, 0, 0, true, true); return; }
      toast('曲库为空，请先添加音乐文件夹');
      return;
    }
    const s = currentSong();
    // 播放键对应当前曲目但 src 未就绪/不匹配 → 重新加载播放（一次即响）
    if (s && audio.dataset.songId !== s.id) { startSong(s); return; }
    if (audio.paused) {
      const p = audio.play();
      if (p && p.catch) p.catch(() => {
        setTimeout(() => { if (audio.paused && currentSong()) audio.play().catch(() => {}); }, 250);
      });
    } else {
      audio.pause();
    }
  }

  function cycleMode() {
    const order = ['order', 'repeat-one', 'shuffle'];
    state.mode = order[(order.indexOf(state.mode) + 1) % order.length];
    if (state.mode === 'shuffle' && state.queue.length) rebuildShuffle();
    window.api.setMode(state.mode);
    updateModeBtn();
    toast({ order: '列表循环', 'repeat-one': '单曲循环', shuffle: '随机播放' }[state.mode]);
  }

  function updateModeBtn() {
    $('#btnMode').innerHTML = MODE_ICONS[state.mode] || ICONS.repeat;
    $('#btnMode').title = MODE_TITLES[state.mode] || '列表循环';
  }

  // ---------- 系统媒体会话 ----------
  function setupMediaSession(song) {
    if (!('mediaSession' in navigator)) return;
    const meta = { title: song.title, artist: song.artist || '', album: song.album || '' };
    try { navigator.mediaSession.metadata = new MediaMetadata(meta); } catch { /* 忽略 */ }
    // 酷狗式：任务栏媒体浮出（Win11 SMTC 音符图标）显示专辑封面 → artwork 必须提供
    getCover(song.id).then((src) => {
      if (!src || state.playingId !== song.id) return;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ ...meta, artwork: [{ src, sizes: '512x512' }] });
      } catch { /* 忽略 */ }
    });
  }

  function bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => audio.play().catch(() => {}));
      ms.setActionHandler('pause', () => audio.pause());
      ms.setActionHandler('previoustrack', playPrev);
      ms.setActionHandler('nexttrack', playNext);
      ms.setActionHandler('seekto', (d) => {
        if (d.seekTime != null && audio.duration) audio.currentTime = d.seekTime;
      });
    } catch { /* 忽略 */ }
  }

  // ---------- 封面（懒加载缓存） ----------
  function getCover(id) {
    if (coverCache.has(id)) return Promise.resolve(coverCache.get(id));
    return window.api.getCover(id).then((c) => {
      if (!c) { coverCache.set(id, null); return null; }
      const src = `data:${c.mime};base64,${c.data}`;
      if (coverCache.size > 200) {
        const first = coverCache.keys().next().value;
        coverCache.delete(first);
      }
      coverCache.set(id, src);
      return src;
    }).catch(() => null);
  }

  // 在线歌曲封面：无 picUrl 时按 album_id/hash 向主进程拉取（酷狗专辑封面），结果缓存并回填 picUrl
  async function loadOnlineCover(song) {
    if (!song || !song.online) return null;
    if (coverCache.has(song.id)) return coverCache.get(song.id);
    const url = await window.api.kugouCover({ albumId: song.album, hash: song.ref }).catch(() => null);
    if (!url) { coverCache.set(song.id, null); return null; }
    coverCache.set(song.id, url);
    song.picUrl = url;
    return url;
  }

  // ---------- 歌词 ----------
  // 歌词元信息行（作词/作曲/编曲等 + 英文 Written by 等）——下载的歌词常带，显示时过滤掉
  const META_RE = /^(词|曲|作词|作曲|编曲|制作人|监制|制作|混音|混录|录音|母带|词曲|原唱|翻唱|和声|吉他|贝斯|鼓手|键盘|弦乐|OP|SP|出品|发行|企划|统筹|文案|封面|设计|版权|Written by|Composer|Lyrics by|Written-By|Music by)\s*[:：]/i;

  function parseLrc(text) {
    const lines = [];
    const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    for (const raw of text.split(/\r?\n/)) {
      const matches = [...raw.matchAll(re)];
      if (!matches.length) continue;
      const lyric = raw.replace(re, '').trim();
      if (!lyric || META_RE.test(lyric)) continue;
      for (const m of matches) {
        const min = +m[1], sec = +m[2];
        const fracStr = m[3] || '0';
        // 一位小数 [mm:ss.5]=0.5s、两位 [mm:ss.55]=0.55s、三位 [mm:ss.555]=0.555s（原实现 1 位误当 2 位，偏移 0.45s）
        const frac = fracStr.length === 1 ? +fracStr / 10 : (fracStr.length === 2 ? +fracStr / 100 : +fracStr / 1000);
        lines.push({ t: min * 60 + sec + frac, text: lyric });
      }
    }
    lines.sort((a, b) => a.t - b.t);
    return lines;
  }

  async function loadLyrics(id) {
    const my = ++state.loadSeq;
    state.lrc = null;
    state.plainLrc = null;
    $('#lyricBox').innerHTML = '';
    // 通知歌词窗清空（切歌过渡期显示占位）
    window.api.sendLyricLrc({ lines: [] });
    const res = await window.api.getLyrics(id).catch(() => null);
    if (my !== state.loadSeq || state.playingId !== id) return; // 竞态守卫
    if (res) {
      renderLyricText(res);
      return;
    }
    // 无本地歌词 → 自动在线获取（静默后台）
    const panelOpen = !$('#lyricPanel').classList.contains('hidden');
    if (panelOpen) {
      $('#lyricBox').appendChild(el('div', 'lyric-plain', '（正在获取歌词…）'));
    }
    const got = await window.api.fetchLyrics(id).catch(() => null);
    if (my !== state.loadSeq || state.playingId !== id) return;
    if (got && got.ok) {
      const res2 = await window.api.getLyrics(id).catch(() => null);
      if (my !== state.loadSeq) return;
      if (res2) renderLyricText(res2);
      else if (panelOpen) showNoLyrics();
    } else if (panelOpen) {
      showNoLyrics(got && got.reason ? `（未能获取歌词：${got.reason}）` : null);
    }
  }

  // 在线歌曲歌词：LeiZ 歌词接口（original 含 LRC + 网易云逐字 JSON 行，翻译/罗马音可选）
  async function loadOnlineLyrics(song) {
    const my = ++state.loadSeq;
    state.lrc = null;
    state.plainLrc = null;
    $('#lyricBox').innerHTML = '';
    window.api.sendLyricLrc({ lines: [] });
    const r = await window.api.leizLyrics(song.source, song.ref, song.level || 'lossless').catch(() => null);
    if (my !== state.loadSeq || state.playingId !== song.id) return;
    const ly = r && r.ok && r.data ? r.data.lyrics : null;
    if (!ly || !ly.original) {
      showNoLyrics('（在线歌词获取失败）');
      return;
    }
    // original 可能混含网易云逐字 JSON 行（{"t":ms,"c":[{"tx":"字"}]}），parseLrc 只取 [mm:ss] 行
    const lines = parseLrc(String(ly.original));
    // 逐字时间轴：网易云 JSON 行 → 行级分段 [{t, chars:[{ch,t}]}]；酷狗 KRC wordByWord 另行解析
    const wordSegs = ly.wordByWord ? parseKrcWord(String(ly.wordByWord)) : parseNeteaseWordLines(String(ly.original));
    state.lrc = lines;
    state.wordSegs = wordSegs && wordSegs.length ? wordSegs : null;
    state.translatedLrc = ly.translated ? parseLrc(String(ly.translated)) : null;
    if (lines.length) {
      renderLyrics();
    } else if (ly.original) {
      state.plainLrc = String(ly.original);
      $('#lyricBox').innerHTML = '';
      $('#lyricBox').appendChild(el('div', 'lyric-plain', state.plainLrc));
    } else {
      showNoLyrics('（在线歌词为空）');
    }
  }

  // 网易云逐字 JSON 行：{"t":毫秒,"c":[{"tx":"字","t":毫秒?}]} → 行分段 [{t(秒), chars:[{ch,t(秒)}]}]
  function parseNeteaseWordLines(text) {
    const segs = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const m = raw.match(/^\{"t":(\d+),"c":(\[.*\])}$/);
      if (!m) continue;
      try {
        const chars = JSON.parse(m[2]);
        const joined = chars.map((c) => c.tx || '').join('').trim();
        if (!joined || META_RE.test(joined)) continue; // 跳过作词/作曲等元数据行
        const items = [];
        let base = +m[1] / 1000; // 毫秒 → 秒
        let prevT = base;
        for (const c of chars) {
          const ch = (c.tx || '').replace(/\s+/g, ' ') || ' ';
          const ct = c.t !== undefined ? +c.t / 1000 : base;
          items.push({ ch, t: Math.max(prevT, ct) }); // 单调递增，防止零宽段
          base = ct;
          prevT = Math.max(prevT, ct);
        }
        if (items.length) segs.push({ t: +m[1] / 1000, chars: items });
      } catch { /* 忽略坏行 */ }
    }
    return segs;
  }

  // 酷狗 KRC 逐字时间轴：[起始毫秒,持续毫秒]<字偏移毫秒,字持续毫秒>字 → [{t(秒), chars:[{ch,t(秒)}]}]
  function parseKrcWord(text) {
    const segs = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const tm = raw.match(/^\[(\d+),(\d+)\]([\s\S]*)$/);
      if (!tm) continue;
      const t0 = (+tm[1]) / 1000; // KRC 时间戳单位 = 毫秒
      const chars = [];
      const cre = /<(\d+),(\d+)(?:,\d+)?>([^<]*)/g; // <偏移,时长[,音量]>字
      let m;
      while ((m = cre.exec(tm[3])) !== null) {
        chars.push({ ch: (m[3].replace(/\s+/g, ' ') || ' '), t: t0 + (+m[1]) / 1000 });
      }
      if (chars.length) segs.push({ t: t0, chars });
    }
    return segs;
  }

  function renderLyricText(res) {
    const lines = parseLrc(res.text);
    if (lines.length) {
      state.lrc = lines;
      state.translatedLrc = null; // 本地歌词无翻译
      renderLyrics();
    } else {
      // 无时间戳纯文本歌词：原样显示（无时间轴无法跟随播放滚动），并供详情页同步展示
      state.plainLrc = res.text;
      state.translatedLrc = null;
      $('#lyricBox').innerHTML = '';
      $('#lyricBox').appendChild(el('div', 'lyric-plain', res.text));
      if (!$('#pageDetail').classList.contains('hidden')) renderDetailLyrics();
    }
  }

  // 歌词空态：提示 + 一键补齐按钮
  function showNoLyrics(note) {
    const box = $('#lyricBox');
    box.innerHTML = '';
    box.appendChild(el('div', 'lyric-plain', note || '（未能获取歌词）'));
    const btn = el('button', 'fill-btn', '🔄 一键补齐全部歌词');
    btn.id = 'btnFillAll';
    btn.addEventListener('click', fillAllLyrics);
    box.appendChild(btn);
  }

  const fillState = { active: false };

  async function fillAllLyrics() {
    if (fillState.active) return;
    fillState.active = true;
    const btn = $('#btnFillAll');
    if (btn) { btn.disabled = true; btn.textContent = '正在获取歌词…'; }
    const stats = await window.api.fillAllLyrics().catch(() => null);
    fillState.active = false;
    if (stats) {
      toast(`歌词补齐完成：成功 ${stats.ok} 首${stats.fail ? '，失败 ' + stats.fail + ' 首' : ''}${stats.skipped ? '，跳过 ' + stats.skipped : ''}`);
    } else {
      toast('歌词补齐失败（网络异常）');
    }
    // 刷新当前歌曲歌词
    const s = currentSong();
    if (s && s.id) loadLyrics(s.id);
  }

  // 歌词翻译开关（localStorage mp_lyrtrans，默认开：有翻译就显示双语）
  function lyrTransOn() {
    return (localStorage.getItem('mp_lyrtrans') || '1') === '1';
  }
  // 找原文第 i 行对应的翻译行（时间 ±0.35s 匹配）
  function transForLine(i) {
    if (!state.translatedLrc || !state.lrc || !state.lrc[i]) return null;
    const t = state.lrc[i].t;
    for (const tr of state.translatedLrc) {
      if (Math.abs(tr.t - t) < 0.35) return tr.text || null;
    }
    return null;
  }
  function renderLyrics() {
    const box = $('#lyricBox');
    box.innerHTML = '';
    const els = [];
    state.lrc.forEach((l, i) => {
      const d = el('div', 'lyric-line');
      d.appendChild(el('div', 'lrc-main', l.text || ' '));
      if (lyrTransOn()) {
        const tr = transForLine(i);
        if (tr) d.appendChild(el('div', 'lrc-trans', tr));
      }
      els.push(d);
      box.appendChild(d);
    });
    state.lrcEls = els;
    lastLyricIdx = -1;
    // 全量歌词下发歌词窗（自主滚动：行定位在歌词窗本地，主窗 rAF/事件被遮挡/最小化节流也不影响）
    window.api.sendLyricLrc({ lines: state.lrc, words: state.wordSegs });
    sendLyricLine();
    updateLyricHighlight(); // 立即定位当前行（暂停/面板未打开时 rAF 不跑，这里主动刷新）
    // 详情页歌词同步（自动进入封面页时歌词异步加载完成 → 重渲染）
    if (!$('#pageDetail').classList.contains('hidden')) renderDetailLyrics();
  }

  let lastLyricIdx = -1;
  let rafId = null;
  let lastLyricPushTs = 0; // 酷狗式高频时间推送节流（~60/s）

  // 行切换：高亮 + 悬浮窗推送（仅在行变化时执行）
  function switchLyricLine(idx) {
    lastLyricIdx = idx;
    const s = currentSong();
    const line = idx >= 0 && state.lrc ? (state.lrc[idx].text || '') : '';
    const lineT = idx >= 0 && state.lrc ? state.lrc[idx].t : 0;
    const dur = (idx >= 0 && state.lrc && state.lrc[idx + 1]) ? state.lrc[idx + 1].t - state.lrc[idx].t : 3;
    window.api.sendLyricLine({ line, lineT, dur, title: s ? s.title : '', artist: s ? s.artist : '' });
    if ($('#lyricPanel').classList.contains('hidden') || !state.lrc) return;
    const els = state.lrcEls || [];
    for (let i = 0; i < els.length; i++) els[i].classList.toggle('active', i === idx);
    if (idx >= 0 && els[idx]) {
      const box = $('#lyricBox');
      const target = els[idx].offsetTop - box.clientHeight / 2 + els[idx].clientHeight / 2;
      box.scrollTop = Math.max(0, target); // 唱K式：当前句居中（直接赋值，比 scrollTo 更可靠）
    }
  }

  // ---------- 卡拉OK分段：长句折行时逐行填充（第一行填满 → 第二行）；有逐字时间轴时按字精确填充 ----------
  let __segMeter = null;
  function ensureSegMeter(font) {
    if (!__segMeter) {
      __segMeter = document.createElement('span');
      __segMeter.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:nowrap;';
      document.body.appendChild(__segMeter);
    }
    __segMeter.style.font = font; // 与当前行同字体 → 测宽即真实渲染宽度
  }
  function escHtmlSeg(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // 当前行的逐字时间（有则用，无则 null → 走像素折行模式）
  function currentLineWords(idx) {
    if (!state.wordSegs || !state.wordSegs.length || !state.lrc || idx < 0 || idx >= state.lrc.length) return null;
    const t = state.lrc[idx].t;
    let best = null, bestD = 0.25; // ±250ms 内找最接近的逐字段
    for (const w of state.wordSegs) {
      const d = Math.abs(w.t - t);
      if (d < bestD) { bestD = d; best = w; }
    }
    if (!best) return null;
    const next = state.lrc[idx + 1];
    return { t, chars: best.chars, dur: Math.max(0.15, (next ? next.t : t + 3) - t) };
  }
  // 按容器可视宽度把当前行文字切成 1..N 段（每段=一个可视行），段边界按真实像素累计
  function segmentLine(el, p, words) {
    if (words && words.chars && words.chars.length) {
      // 逐字模式：每个字一段，s0/s1 = 归一化时间（0..1），跨行自然折行、按字依次填充
      const dur = words.dur;
      const items = words.chars.map((c, i) => {
        const s0 = Math.min(1, Math.max(0, (c.t - words.t) / dur));
        const s1 = i < words.chars.length - 1 ? Math.min(1, Math.max(0, (words.chars[i + 1].t - words.t) / dur)) : 1;
        return { t: c.ch || ' ', s0, s1: Math.max(s0 + 0.001, s1) };
      });
      el.dataset.segTotal = '1'; // 归一化时间域
      el.dataset.segMode = 'word';
      el.innerHTML = items.map((it) =>
        `<span class="line-seg" data-s0="${it.s0.toFixed(4)}" data-s1="${it.s1.toFixed(4)}">${escHtmlSeg(it.t)}</span>`
      ).join('');
      applyKaraokeP(el, p, words);
      return;
    }
    const text = el.textContent || '';
    if (!text.trim()) { el.innerHTML = ''; el.dataset.segTotal = '0'; el.dataset.segMode = 'px'; return; }
    const cs = getComputedStyle(el);
    const contentW = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    ensureSegMeter(cs.font);
    const chars = [...text];
    const items = [];
    let cur = '', curPx = 0, startPx = 0;
    const flush = () => {
      if (cur) { items.push({ t: cur, s0: startPx, s1: startPx + curPx }); startPx += curPx; cur = ''; curPx = 0; }
    };
    for (const ch of chars) {
      __segMeter.textContent = cur + ch;
      if (cur && __segMeter.offsetWidth > contentW) {
        // 优先在空格处断行（英文词保持完整），否则逐字断（CJK 随处可断）
        const sp = cur.lastIndexOf(' ');
        if (sp > 0) {
          const head = cur.slice(0, sp);
          __segMeter.textContent = head;
          const hw = __segMeter.offsetWidth;
          items.push({ t: head, s0: startPx, s1: startPx + hw });
          startPx += hw;
          cur = cur.slice(sp + 1);
        } else {
          flush();
        }
      }
      cur += ch;
      __segMeter.textContent = cur;
      curPx = __segMeter.offsetWidth;
    }
    flush();
    const totalPx = items.reduce((a, it) => a + (it.s1 - it.s0), 0);
    el.dataset.segTotal = String(totalPx);
    el.dataset.segMode = 'px';
    el.innerHTML = items.map((it) =>
      `<span class="line-seg" data-s0="${it.s0.toFixed(1)}" data-s1="${it.s1.toFixed(1)}">${escHtmlSeg(it.t)}</span>`
    ).join('');
    applyKaraokeP(el, p, words);
  }
  // 每帧：更新当前行（或各段）的渐变进度；未切段的首次调用时惰性切段
  // el = 行容器（.lyric-line / .d-lyric）；卡拉OK目标 = 内部 .lrc-main/.d-main（译文行不参与渐变）
  function applyKaraokeP(el, p, words) {
    const target = (el.querySelector && el.querySelector('.lrc-main, .d-main')) || el;
    target.dataset.lastP = String(p);
    const segs = target.querySelectorAll(':scope > .line-seg');
    if (segs.length) {
      const total = parseFloat(target.dataset.segTotal) || 1;
      const consumed = p * total;
      segs.forEach((seg) => {
        const s0 = parseFloat(seg.dataset.s0) || 0;
        const s1 = parseFloat(seg.dataset.s1) || 1;
        const sp = s1 > s0 ? Math.min(1, Math.max(0, (consumed - s0) / (s1 - s0))) : 0;
        seg.style.setProperty('--p', sp.toFixed(3));
      });
    } else if (!target._segged) {
      target._segged = true;
      target._lastWords = words || null; // 切段快照（timer/重切沿用同一定时数据）
      segmentLine(target, p, words);
      // 详情页字号有 0.2s 过渡：过渡完成后再切一次段，保证段边界准确
      clearTimeout(target._segTimer);
      target._segTimer = setTimeout(() => {
        if (target.closest && target.closest('.lyric-line, .d-lyric') && target.closest('.lyric-line, .d-lyric').classList.contains('active')) {
          target._segged = false;
          segmentLine(target, parseFloat(target.dataset.lastP) || 0, target._lastWords);
        }
      }, 450);
    } else {
      target.style.setProperty('--p', p.toFixed(3)); // 兜底（空行等）
    }
  }
  // 窗口尺寸/字号变化后重新切段（面板/详情当前行）
  function reSegmentActiveLyrics() {
    const panelEl = document.querySelector('#lyricBox .lyric-line.active .lrc-main');
    if (panelEl) { panelEl._segged = false; segmentLine(panelEl, parseFloat(panelEl.dataset.lastP) || 0, panelEl._lastWords); }
    const detailEl = document.querySelector('#pdLyrics .d-lyric.active .d-main');
    if (detailEl) { detailEl._segged = false; segmentLine(detailEl, parseFloat(detailEl.dataset.lastP) || 0, detailEl._lastWords); }
  }
  window.addEventListener('resize', reSegmentActiveLyrics);

  // rAF 每帧驱动：行切换检测 + 卡拉OK进度渐变（60fps 无延迟）
  // 滚动形态：唱K式——切句时当前句跳到居中（上下句可见），不做持续上移（用户确认）
  function updateLyricHighlight() {
    const t = audio.currentTime || lastAudioTime; // 恢复播放瞬间 currentTime 可能读 0 → 用最后已知时间兜底
    let idx = -1;
    if (state.lrc) {
      for (let i = state.lrc.length - 1; i >= 0; i--) {
        if (state.lrc[i].t <= t + 0.12) { idx = i; break; } // 提前 0.12s 切行（原 0.3s 会导致每句开头卡拉OK渐变从 0 瞬跳——Hermes 观察项）
      }
    }
    if (idx !== lastLyricIdx) switchLyricLine(idx);
    // 卡拉OK：当前行文字从左到右填充变色（已唱/未唱实时区分——桌面歌词同款第二层）
    const els = state.lrcEls;
    if (state.lrc && idx >= 0 && els && els[idx] && !$('#lyricPanel').classList.contains('hidden')) {
      const line = state.lrc[idx];
      const next = state.lrc[idx + 1];
      const dur = next ? next.t - line.t : 3;
      const p = Math.min(1, Math.max(0, (t - line.t) / dur));
      applyKaraokeP(els[idx], p, currentLineWords(idx));
    }
  }

  function karaokeLoop() {
    rafId = requestAnimationFrame(karaokeLoop);
    updateLyricHighlight();
    // 歌曲结尾淡出：剩余 ≤ 0.4s 时一次性平滑收尾（自动连播不突兀，酷狗式）
    if (!audio.paused && audio.duration > 1 && !state._tailFaded && (audio.duration - (audio.currentTime || lastAudioTime)) <= 0.4 && audio.volume > 0.01) {
      state._tailFaded = true;
      const start = audio.volume, t0 = performance.now();
      clearInterval(fadeTimer);
      fadeTimer = setInterval(() => {
        const p = (performance.now() - t0) / 300;
        if (p >= 1) { clearInterval(fadeTimer); audio.volume = 0; }
        else audio.volume = Math.max(0, start * (1 - p));
      }, 16);
    }
    if (!$('#thumbView').classList.contains('hidden')) updateThumbView(); // 缩略图封面同步
    if (!$('#pageDetail').classList.contains('hidden')) updateDetailLyric(); // 详情页歌词实时滚动
    // 酷狗式高频时间推送：每帧把真实音频时间推给歌词窗（节流 ~60/s，防最小化时 rAF 加速导致的 IPC 洪泛）。
    // 主窗已 setBackgroundThrottling(false)，最小化/遮挡时 rAF 照常运行 → 歌词窗始终拿到最新时间，
    // 暂停时本循环被 cancel → 推送停止 → 歌词窗冻结在最后位置（暂停即停，酷狗同款体验）
    const now = performance.now();
    if (now - lastLyricPushTs >= 16) {
      lastLyricPushTs = now;
      window.api.sendLyricPlayState({ playing: true, audioTime: audio.currentTime || lastAudioTime, duration: audio.duration || 0 });
    }
  }

  // ---------- 缩略图模式（最小化时：任务栏 hover 缩略图 = 播放条封面同一张图） ----------
  function updateThumbView() {
    const s = currentSong();
    if (!s) return;
    $('#tvTitle').textContent = s.title;
    $('#tvArtist').textContent = s.artist || '';
    const pimg = $('#pCoverImg');
    const tvImg = $('#tvCoverImg');
    const tvNote = $('#tvCoverNote');
    const tvBg = $('#tvBg');
    if (pimg.src && !pimg.classList.contains('hidden')) {
      // 与播放条封面同一张图（同源数据，不再单独请求）
      tvImg.src = pimg.src;
      tvImg.classList.remove('hidden');
      tvNote.classList.add('hidden');
      tvBg.src = pimg.src;
      tvBg.classList.remove('hidden');
    } else {
      tvImg.classList.add('hidden');
      tvNote.classList.remove('hidden');
      tvBg.classList.add('hidden');
    }
    updateThumbControls();
  }

  // 缩略图封面页的进度 + 播放按钮状态
  function updateThumbControls() {
    $('#tvCur').textContent = fmtTime(audio.currentTime);
    $('#tvDur').textContent = audio.duration ? fmtTime(audio.duration) : '0:00';
    $('#tvFill').style.width = (audio.duration ? Math.min(100, (audio.currentTime / audio.duration) * 100) : 0) + '%';
    const playing = !audio.paused;
    $('#tvIconPlay').classList.toggle('hidden', playing);
    $('#tvIconPause').classList.toggle('hidden', !playing);
  }

  // ---------- 歌曲详情页（整页切换，酷狗式：点封面进入，返回回主界面） ----------
  let detailLyricIdx = -1;
  function showDetail() {
    const s = currentSong();
    if (!s) return;
    $('#pdTitle').textContent = s.missing ? s.title + '（文件丢失）' : s.title;
    $('#pdArtist').textContent = s.artist || '';
    const img = $('#pdCoverImg');
    const note = $('#pdCover .pd-note');
    img.classList.add('hidden');
    note.classList.remove('hidden');
    getCover(s.id).then((src) => {
      if (src && state.playingId === s.id) { img.src = src; img.classList.remove('hidden'); note.classList.add('hidden'); }
    });
    renderDetailLyrics();
    $('#main').classList.add('hidden');
    $('#topbar').classList.add('hidden'); // 详情页不显示顶栏（搜索行）
    $('#pProgress').classList.add('hidden'); // 底部进度条隐藏，进度条显示在详情页内（封面下方）
    $('#pageDetail').classList.remove('hidden');
  }
  function backDetail() {
    $('#pageDetail').classList.add('hidden');
    $('#main').classList.remove('hidden');
    $('#topbar').classList.remove('hidden');
    $('#pProgress').classList.remove('hidden');
  }
  function renderDetailLyrics() {
    const box = $('#pdLyrics');
    box.innerHTML = '';
    if (state.lrc && state.lrc.length) {
      state.lrc.forEach((l, i) => {
        const div = el('div', 'd-lyric');
        div.appendChild(el('div', 'd-main', l.text || ' '));
        if (lyrTransOn()) {
          const tr = transForLine(i);
          if (tr) div.appendChild(el('div', 'd-trans', tr));
        }
        div.addEventListener('click', () => { // 点击歌词行 → 歌曲跳转到该行
          if (audio.duration) {
            audio.currentTime = l.t;
            updateLyricHighlight();
            window.api.sendLyricPlayState({ playing: !audio.paused, audioTime: audio.currentTime, duration: audio.duration || 0 });
          }
        });
        box.appendChild(div);
      });
    } else if (state.plainLrc) {
      // 无时间戳纯文本歌词：详情页整段展示（可滚动查看，无时间轴不跟随播放）
      box.appendChild(el('div', 'lyric-plain', state.plainLrc));
    } else {
      box.appendChild(el('div', 'd-lyric missing', '暂无歌词'));
    }
    detailLyricIdx = -1;
    updateDetailLyric(true);
  }
  // 详情页歌词实时滚动高亮（rAF 驱动，与主面板同步）
  // 滚动形态：唱K式——切句时当前句跳到居中；当前句卡拉OK渐变每帧更新（已唱/未唱实时区分）
  function updateDetailLyric(force) {
    const page = $('#pageDetail');
    if (page.classList.contains('hidden')) return;
    const lrc = state.lrc;
    const els = page.querySelectorAll('#pdLyrics .d-lyric');
    if (!lrc || !els.length) return;
    const t = audio.currentTime || lastAudioTime; // currentTime 可能读 0 → 兜底
    let idx = -1;
    for (let i = lrc.length - 1; i >= 0; i--) {
      if (lrc[i].t <= t + 0.12) { idx = i; break; } // 提前 0.12s 切行
    }
    if (idx !== detailLyricIdx) {
      detailLyricIdx = idx;
      for (let i = 0; i < els.length; i++) els[i].classList.toggle('active', i === idx);
      if (idx >= 0) {
        const box = $('#pdLyrics');
        box.scrollTop = Math.max(0, els[idx].offsetTop - box.clientHeight / 2 + els[idx].clientHeight / 2); // 唱K式：当前句居中
      }
    }
    if (idx >= 0) {
      // 第二层：当前行卡拉OK渐变（已唱/未唱实时区分，桌面歌词同款）
      const line = lrc[idx];
      const next = lrc[idx + 1];
      const dur = next ? next.t - line.t : 3;
      const p = Math.min(1, Math.max(0, (t - line.t) / dur));
      applyKaraokeP(els[idx], p, currentLineWords(idx));
    }
  }

  // 向歌词悬浮窗推送当前行（切歌时显示歌名）
  function sendLyricLine() {
    const s = currentSong();
    const cur = audio.currentTime || lastAudioTime; // currentTime 可能读 0 → 兜底
    let line = '', lineT = 0, dur = 3;
    if (state.lrc && cur != null) {
      for (let i = state.lrc.length - 1; i >= 0; i--) {
        if (state.lrc[i].t <= cur + 0.3) {
          line = state.lrc[i].text || '';
          lineT = state.lrc[i].t;
          const next = state.lrc[i + 1];
          dur = next ? next.t - lineT : 3;
          break;
        }
      }
    }
    window.api.sendLyricLine({ line, lineT, dur, title: s ? s.title : '', artist: s ? s.artist : '' });
  }

  // ---------- 右键菜单 ----------
  function showContextMenu(x, y, song) {
    const menu = $('#contextMenu');
    menu.innerHTML = '';
    const items = [];
    if (song.online) {
      // 在线歌曲：播放/队列 + 可收藏（存本地）/加入歌单（存对象条目）
      items.push({ label: '播放', fn: () => { const vis = visibleList(); const i = vis.findIndex((s) => s.id === song.id); if (i >= 0) playList(vis, i, 0, true, true); } });
      items.push({ label: '下一首播放', fn: () => queuePlayNext(song) });
      items.push({ label: '添加到队列', fn: () => queueAppend(song) });
      items.push({ label: '下载到本地', fn: () => downloadOne(song) });
      items.push({ sep: true });
      items.push({ label: isFav(song.id) ? '取消收藏' : '收藏', fn: async () => {
        state.favorites = await window.api.toggleFavorite(song.id, song);
        $('#countFav').textContent = state.favorites.length;
        renderList();
      } });
      items.push({ label: '加入歌单…', fn: () => addToPlaylist(song) });
      // 未下载但在歌单里的在线歌曲：支持「删除歌曲」（从歌单移除；下载了就是本地歌，走删除文件）
      const curPlId = currentPlaylistId();
      if (curPlId) {
        const pl = state.playlists.find((p) => p.id === curPlId);
        if (pl && pl.songIds.some((e) => (typeof e === 'string' ? e : e && e.id) === song.id)) {
          items.push({ label: '删除歌曲', fn: async () => {
            pl.songIds = pl.songIds.filter((e) => (typeof e === 'string' ? e : e && e.id) !== song.id);
            await window.api.savePlaylists(state.playlists);
            setView(state.view);
            toast('已从歌单删除');
          } });
        }
      } else if (state.view.startsWith('opl:')) {
        const pl = state.onlinePlaylists.find((x) => 'opl:' + x.id === state.view);
        if (pl && pl.songs.some((s) => s && s.id === song.id)) {
          items.push({ label: '删除歌曲', fn: () => {
            pl.songs = pl.songs.filter((s) => s && s.id !== song.id);
            saveOpls();
            setView(state.view);
            toast('已从歌单删除');
          } });
        }
      }
      items.push({ sep: true });
      items.push({ label: `来源：${SRC_NAMES[song.source] || song.source}`, fn: () => {} });
      items.push({ label: '复制歌名', fn: () => { try { navigator.clipboard.writeText(song.title + ' - ' + (song.artist || '')); toast('已复制'); } catch {} } });
      for (const it of items) {
        if (it.sep) { menu.appendChild(el('div', 'cm-sep')); continue; }
        const item = el('div', 'cm-item', it.label);
        item.addEventListener('click', () => { hideContextMenu(); it.fn(); });
        menu.appendChild(item);
      }
      menu.classList.remove('hidden');
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
      menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
      return;
    }
    items.push({ label: '播放', fn: () => { const vis = visibleList(); const i = vis.findIndex((s) => s.id === song.id); if (i >= 0) playList(vis, i, 0, true, true); } });
    items.push({ label: '下一首播放', fn: () => queuePlayNext(song) });
    items.push({ label: '添加到队列', fn: () => queueAppend(song) });
    items.push({ label: isFav(song.id) ? '取消收藏' : '收藏', fn: async () => {
      state.favorites = await window.api.toggleFavorite(song.id);
      $('#countFav').textContent = state.favorites.length;
      renderList();
    } });
    items.push({ label: '加入歌单…', fn: () => addToPlaylist(song.id) });
    const plId = currentPlaylistId();
    if (plId) {
      const pl = state.playlists.find((p) => p.id === plId);
      if (pl && !pl.system) {
        items.push({ label: '从该歌单移除', fn: async () => {
          // 条目可为本地 id（字符串）或在线歌曲对象
          pl.songIds = pl.songIds.filter((e) => (typeof e === 'string' ? e : e && e.id) !== song.id);
          await window.api.savePlaylists(state.playlists);
          setView(state.view);
        } });
      }
    }
    items.push({ sep: true });
    items.push({ label: '编辑标签…', fn: () => openTagEditor(song) });
    items.push({ label: '在文件夹中显示', fn: () => window.api.revealSong(song.id) });
    items.push({ sep: true });
    items.push({ label: '删除歌曲（删除文件）', fn: async () => {
      if (!confirm(`确定删除「${song.title}」？\n文件将从磁盘删除，无法恢复。\n${song.path}`)) return;
      const r = await window.api.deleteSong(song.id);
      if (!r || !r.ok) { toast(r && r.reason ? '删除失败：' + r.reason : '删除失败'); return; }
      state.songs = r.songs;
      setView(state.view);
      toast(`已删除：${song.title}`);
    } });

    for (const it of items) {
      if (it.sep) { menu.appendChild(el('div', 'cm-sep')); continue; }
      const item = el('div', 'cm-item', it.label);
      item.addEventListener('click', () => { hideContextMenu(); it.fn(); });
      menu.appendChild(item);
    }
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
  }

  function hideContextMenu() {
    $('#contextMenu').classList.add('hidden');
  }

  // ---------- 侧边栏歌单右键菜单：播放 / 重命名 / 收藏·下载 / 删除·移除 ----------
  function showPlaylistMenu(x, y, kind, pl) {
    hideContextMenu();
    const menu = $('#contextMenu');
    menu.innerHTML = '';
    const items = [];
    // 播放歌单（本地歌单条目可为本地 id 或在线歌曲对象；在线歌单直接播 songs）
    items.push({ label: '播放歌单', fn: () => {
      const list = kind === 'opl'
        ? (pl.songs || [])
        : (pl.songIds || []).map((e) => typeof e === 'string' ? state.songs.find((s) => s.id === e) : e).filter(Boolean);
      if (!list.length) { toast('歌单是空的'); return; }
      playList(list, 0, 0, true, true);
    } });
    items.push({ sep: true });
    items.push({ label: '重命名', fn: () => openRenamePlaylist(kind, pl) });
    if (kind === 'opl') {
      items.push({ label: pl.fav ? '取消收藏' : '收藏歌单', fn: () => {
        pl.fav = !pl.fav;
        saveOpls();
        renderNav();
      } });
      items.push({ label: '一键下载全部', fn: () => {
        const list = (pl.songs || []).filter((s) => s && s.online);
        if (!list.length) { toast('歌单没有可下载的歌曲'); return; }
        downloadBatch(list);
      } });
      items.push({ sep: true });
      items.push({ label: '移除歌单', fn: () => {
        state.onlinePlaylists = state.onlinePlaylists.filter((x) => x.id !== pl.id);
        saveOpls();
        renderNav();
        if (state.view === 'opl:' + pl.id) setView('library');
      } });
    } else if (!pl.system) {
      items.push({ sep: true });
      items.push({ label: '删除歌单', fn: () => {
        if (!confirm(`删除歌单「${pl.name}」？`)) return;
        state.playlists = state.playlists.filter((x) => x.id !== pl.id);
        window.api.savePlaylists(state.playlists);
        renderNav();
        if (state.view === 'playlist:' + pl.id) setView('library');
      } });
    }
    for (const it of items) {
      if (it.sep) { menu.appendChild(el('div', 'cm-sep')); continue; }
      const item = el('div', 'cm-item', it.label);
      item.addEventListener('click', () => { hideContextMenu(); it.fn(); });
      menu.appendChild(item);
    }
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
  }
  // 侧边栏曲库目录右键菜单：播放目录 / 打开文件夹 / 从曲库移除
  function showDirMenu(x, y, dir) {
    hideContextMenu();
    const menu = $('#contextMenu');
    menu.innerHTML = '';
    const items = [];
    items.push({ label: '播放目录', fn: () => {
      const dk = dir.toLowerCase();
      const list = state.songs.filter((s) => (s.path || '').toLowerCase().startsWith(dk));
      if (!list.length) { toast('该目录下没有歌曲'); return; }
      playList(list, 0, 0, true, true);
    } });
    items.push({ sep: true });
    items.push({ label: '打开文件夹', fn: () => window.api.openPath(dir) });
    items.push({ label: '从曲库移除', fn: async () => {
      if (!confirm(`从曲库移除「${dir}」？\n该文件夹的歌曲将从曲库移除（文件保留在磁盘）。`)) return;
      const r = await window.api.removeDir(dir);
      state.songs = r.songs;
      state.dirs = r.dirs;
      renderDirs();
      if (state.view === 'dir:' + encodeURIComponent(dir)) setView('library');
    } });
    for (const it of items) {
      if (it.sep) { menu.appendChild(el('div', 'cm-sep')); continue; }
      const item = el('div', 'cm-item', it.label);
      item.addEventListener('click', () => { hideContextMenu(); it.fn(); });
      menu.appendChild(item);
    }
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
  }

  // 「重命名歌单」：Electron 禁 window.prompt → 复用选择面板的"重命名"模式
  let plPickRenameTarget = null; // {kind:'local'|'opl', pl}
  function openRenamePlaylist(kind, pl) {
    hideContextMenu();
    plPickMode = 'rename';
    plPickRenameTarget = { kind, pl };
    $('#plPickList').classList.add('hidden');
    $('#plPickHead').textContent = '重命名歌单';
    $('#plPickTip').textContent = '输入新名称，回车或点「确定」：';
    $('#plPickAdd').textContent = '确定';
    $('#plPickInput').value = pl.name || '';
    $('#plPickOverlay').classList.remove('hidden');
    $('#plPickInput').focus();
    $('#plPickInput').select();
  }

  // ---------- 标签编辑（ID3，mp3 写入） ----------
  let tagEditSong = null;       // 正在编辑的 song 对象
  let tagNewPicture = null;     // 新封面 {data(mime), base64} | null = 移除
  let tagHasPicture = false;    // 当前是否有封面（区分"未动"与"移除"）
  async function openTagEditor(song) {
    const r = await window.api.readTag(song.id);
    if (!r || !r.ok) { toast((r && r.reason) || '读取标签失败'); return; }
    tagEditSong = song;
    tagNewPicture = undefined; // 未改动
    tagHasPicture = !!r.picture;
    $('#tagTitle').value = r.title || '';
    $('#tagArtist').value = r.artist || '';
    $('#tagAlbum').value = r.album || '';
    renderTagCover(r.picture ? `data:${r.picture.mime};base64,${r.picture.data}` : null);
    $('#tagOverlay').classList.remove('hidden');
    $('#tagTitle').focus();
  }
  function renderTagCover(src) {
    const img = $('#tagCoverImg'), note = $('#tagCoverNote');
    if (src) {
      img.src = src;
      img.classList.remove('hidden');
      note.classList.add('hidden');
    } else {
      img.classList.add('hidden');
      img.src = '';
      note.classList.remove('hidden');
    }
  }
  function closeTagEditor() {
    $('#tagOverlay').classList.add('hidden');
    tagEditSong = null;
  }
  async function saveTagEditor() {
    if (!tagEditSong) return;
    const title = $('#tagTitle').value.trim();
    const artist = $('#tagArtist').value.trim();
    const album = $('#tagAlbum').value.trim();
    const patch = { title, artist, album };
    if (tagNewPicture !== undefined) {
      // null = 移除封面；有数据 = 新封面
      if (tagNewPicture === null) patch.picture = null;
      else patch.picture = { data: tagNewPicture.base64, mime: tagNewPicture.mime };
    }
    const r = await window.api.writeTag(tagEditSong.id, patch);
    if (!r || !r.ok) { toast((r && r.reason) || '保存失败'); return; }
    // 同步本地状态（曲库/队列/当前播放）
    const upd = r.song;
    for (const arr of [state.songs, state.queue, state.list]) {
      const s = arr && arr.find((x) => x.id === upd.id);
      if (s) { s.title = upd.title; s.artist = upd.artist; s.album = upd.album; s.hasCover = upd.hasCover; }
    }
    coverCache.delete(upd.id); // 封面变了 → 重新取
    closeTagEditor();
    renderList();
    if (currentSong() && currentSong().id === upd.id) updatePlayingUI(currentSong());
    toast('标签已保存');
  }
  function bindTagEditor() {
    $('#tagClose').addEventListener('click', closeTagEditor);
    $('#tagCancel').addEventListener('click', closeTagEditor);
    $('#tagSave').addEventListener('click', saveTagEditor);
    $('#tagCoverPick').addEventListener('click', () => $('#tagCoverFile').click());
    $('#tagCoverFile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { toast('封面图片请小于 2MB'); return; }
      const rd = new FileReader();
      rd.onload = () => {
        tagNewPicture = { mime: (f.type || 'image/jpeg').split(';')[0], base64: String(rd.result).split(',')[1] };
        renderTagCover(rd.result);
        tagHasPicture = true;
      };
      rd.readAsDataURL(f);
    });
    $('#tagCoverClear').addEventListener('click', () => {
      if (!tagHasPicture) return;
      tagNewPicture = null;
      renderTagCover(null);
      tagHasPicture = false;
    });
    $('#tagOverlay').addEventListener('click', (e) => { if (e.target === $('#tagOverlay')) closeTagEditor(); });
  }

  // ---------- 在线歌曲下载 ----------
  const dlTasks = new Map(); // song.id -> {taskId, pct(0..100), status}
  const batchDlTasks = new Set(); // 「一键下载全部」发起的 taskId（仅这些下载完成才触发"自动移入本地歌单"）
  // 下载完成 → 自动入库：防抖合并同一批下载，只触发一次；目录新增时提示
  let dlSyncTimer = null;
  function syncDlDirToLibrary() {
    if (dlSyncTimer) return;
    dlSyncTimer = setTimeout(async () => {
      dlSyncTimer = null;
      try {
        const r = await window.api.ensureDlDir();
        if (!r || !r.songs) return;
        const songsChanged = r.songs.length !== state.songs.length || r.dirs.length !== state.dirs.length;
        state.songs = r.songs;
        state.dirs = r.dirs;
        renderDirs();
        if (r.added) toast(`下载目录已自动加入曲库（${r.songs.length} 首）`);
        else if (songsChanged && state.view === 'library') setView('library');
      } catch { /* 自动入库失败不打扰播放 */ }
    }, 900);
  }
  let dlPanelOpen = false;
  let dlFabDismissed = false; // 用户点过 FAB 的叉号：全部完成后保持隐藏，直到下一次下载任务出现
  // 行内下载按钮状态图标
  function dlBtnInner(id) {
    const t = dlTasks.get(id);
    if (!t || t.status === 'done') {
      return t && t.status === 'done'
        ? `<span class="dl-state ok" title="已下载">${ICONS.check}</span>`
        : `<span class="dl-ico">${ICONS.download}</span>`;
    }
    if (t.status === 'error') return `<span class="dl-state err" title="下载失败：${t.reason || ''}，点击重试">${ICONS.warn}</span>`;
    if (t.status === 'cancelled') return `<span class="dl-ico">${ICONS.download}</span>`;
    // 下载中/排队/解析：百分比或转圈
    return `<span class="dl-state run" title="下载中 ${t.pct}%">${t.pct > 0 ? t.pct + '%' : '…'}</span>`;
  }
  function updateDlBtn(id) {
    const btn = document.querySelector(`#songBody tr[data-id="${CSS.escape(id)}"] .dl-btn`);
    if (btn) btn.innerHTML = dlBtnInner(id);
    updateDlFab();
  }
  function updateDlFab() {
    const tasks = [...dlTasks.values()];
    const active = tasks.filter((t) => ['queued', 'resolving', 'downloading', 'cover', 'tagging'].includes(t.status));
    const done = tasks.filter((t) => t.status === 'done').length;
    const err = tasks.filter((t) => t.status === 'error').length;
    const fab = $('#dlFab');
    const badge = $('#dlFab .dl-fab-badge');
    if (!tasks.length) { dlFabDismissed = false; fab.classList.add('hidden'); return; }
    // 全部完成/无活动任务：若用户叉掉过则保持隐藏，直到新下载任务出现
    if (!active.length && dlFabDismissed) { fab.classList.add('hidden'); return; }
    fab.classList.remove('hidden');
    // 无活动任务时显示悬停叉号（可收起）
    fab.classList.toggle('can-close', !active.length);
    if (active.length) {
      const avg = active.reduce((s, t) => s + (t.pct || 0), 0) / active.length;
      badge.textContent = `${active.length} 个下载中 · ${Math.round(avg)}%`;
    } else {
      badge.textContent = done ? `全部完成（${done} 首${err ? '，' + err + ' 个失败' : ''}）` : '';
    }
    renderDlPanel(); // 始终重渲染面板（移除最后一行/清空任务时也要刷新）
  }
  function renderDlPanel() {
    const list = $('#dlList');
    if (!list) return;
    const tasks = [...dlTasks.entries()];
    if (!tasks.length) { list.innerHTML = '<div class="dl-empty">暂无下载任务</div>'; return; }
    list.innerHTML = '';
    tasks.forEach(([key, t]) => {
      const row = el('div', 'dl-task');
      const name = el('div', 'dl-task-name', t.title ? (t.artist ? `${t.title} - ${t.artist}` : t.title) : '未知歌曲');
      name.title = t.title || '';
      const barWrap = el('div', 'dl-task-bar');
      const bar = el('div', 'dl-task-fill');
      bar.style.width = (t.status === 'done' ? 100 : t.status === 'error' ? 100 : (t.pct || 0)) + '%';
      const cls = t.status === 'done' ? 'ok' : (t.status === 'error' ? 'err' : '');
      if (cls) bar.classList.add(cls); // 空 token 会抛异常（classList.add('') 非法）
      barWrap.appendChild(bar);
      const st = el('span', 'dl-task-st', dlStatusText(t));
      const cancel = el('button', 'dl-task-cancel');
      cancel.innerHTML = ICONS.close; // SVG 图标必须用 innerHTML（el() 的 textContent 会显示成源码）
      const terminal = ['done', 'error', 'cancelled'].includes(t.status);
      cancel.title = terminal ? '移除' : '取消';
      cancel.addEventListener('click', () => {
        if (terminal) {
          // 已完成/失败/取消：直接移除该行（含测试/历史遗留的匿名任务）
          dlTasks.delete(key);
          updateDlFab();
        } else {
          window.api.dlCancel(t.taskId);
        }
      });
      row.append(name, barWrap, st, cancel);
      list.appendChild(row);
    });
  }
  function dlStatusText(t) {
    switch (t.status) {
      case 'queued': return '排队中';
      case 'resolving': return '解析地址…';
      case 'downloading': return (t.pct || 0) + '%';
      case 'cover': return '下载封面…';
      case 'tagging': return '写入标签…';
      case 'done': return '✓ 完成';
      case 'error': return '失败';
      case 'cancelled': return '已取消';
      default: return '';
    }
  }
  // 登记下载任务（歌曲 id → taskId）：resolving 事件可能先于 dlStart/dlBatch 的 IPC 响应到达，
  // 已建 'task:dlN' 匿名条目 → 升级为真实条目（否则队列会同时出现两个任务）
  function setDlTask(song, taskId) {
    let anon = null;
    for (const [id, t] of dlTasks) {
      if (id.startsWith('task:') && t.taskId === taskId) { anon = [id, t]; break; }
    }
    if (anon) {
      dlTasks.delete(anon[0]);
      dlTasks.set(song.id, { ...anon[1], taskId, title: song.title, artist: song.artist || '' });
    } else {
      dlTasks.set(song.id, { taskId, pct: 0, status: 'queued', title: song.title, artist: song.artist || '' });
    }
  }
  async function downloadOne(song) {
    if (!song || !song.online) { toast('仅在线歌曲可下载'); return; }
    if (dlTasks.has(song.id) && ['queued', 'resolving', 'downloading', 'cover', 'tagging'].includes(dlTasks.get(song.id).status)) {
      toast('该歌曲已在下载中'); return;
    }
    const r = await window.api.dlStart({ source: song.source, ref: song.ref, title: song.title, artist: song.artist || '', album: song.album || '', picUrl: song.picUrl || '', duration: song.duration || 0 });
    if (!r || !r.ok) { toast(r && r.reason ? '下载失败：' + r.reason : '下载失败'); return; }
    setDlTask(song, r.taskId);
    updateDlBtn(song.id);
    toast(`已开始下载：${song.title}`);
  }
  function downloadBatch(songs) {
    const list = (songs || []).filter((s) => s && s.online);
    if (!list.length) { toast('没有可下载的在线歌曲'); return; }
    window.api.dlBatch(list.map((s) => ({ source: s.source, ref: s.ref, title: s.title, artist: s.artist || '', album: s.album || '', picUrl: s.picUrl || '', duration: s.duration || 0 }))).then((res) => {
      if (res && res.ok) {
        // 按返回的 taskId 顺序精确映射到歌曲（避免同标题行污染）
        (res.ids || []).forEach((taskId, i) => {
          const s = list[i];
          if (s) {
            batchDlTasks.add(taskId); // 仅「一键下载全部」的任务：完成后触发歌单自动移入本地歌单
            if (!dlTasks.has(s.id)) setDlTask(s, taskId);
          }
        });
        toast(`已加入下载队列：${res.count} 首`);
        updateDlFab();
      } else {
        toast('批量下载失败');
      }
    });
  }
  function bindDownload() {
    window.api.onDlProgress((p) => {
      // 精确匹配：遍历 dlTasks 找 taskId 相同的任务（dlStart/dlBatch 已建立 song.id→taskId 映射）
      let sid = null;
      for (const [id, t] of dlTasks) {
        if (id.startsWith('task:') || id.startsWith('queued')) continue; // 匿名占位键不参与匹配
        if (t.taskId === p.taskId) { sid = id; break; }
      }
      if (!sid) {
        // 找不到归属行（测试/历史等非界面发起的下载）：登记到匿名键，用事件自带标题（不再显示"未知歌曲"）
        sid = 'task:' + p.taskId;
        dlTasks.set(sid, { taskId: p.taskId, pct: 0, status: p.status, title: p.title || '' });
      } else {
        // 匹配到真实行后，清理同 taskId 的旧匿名条目（防御旧时序残留）
        for (const [id, t] of dlTasks) { if (id.startsWith('task:') && t.taskId === p.taskId) dlTasks.delete(id); }
      }
      const t = dlTasks.get(sid);
      t.status = p.status; t.pct = p.pct || 0;
      if (p.title) t.title = p.title; // 事件带标题时补全歌曲信息（面板显示用）
      if (p.path) t.path = p.path;
      if (p.reason) t.reason = p.reason;
      updateDlBtn(sid);
      if (p.status === 'done') {
        toast(`下载完成：${p.title}`);
        syncDlDirToLibrary(); // 下载完成 → 自动把下载目录纳入曲库（已纳入则仅刷新），下载的歌直接出现在曲库
        // 「一键下载全部」的任务完成 → 歌单自动标记为"已下载"，本地歌单组出现该歌单入口；
        // 原在线歌单不删除、不移除（收藏的仍留在在线歌单）
        if (sid && !sid.startsWith('task:') && batchDlTasks.has(p.taskId)) {
          batchDlTasks.delete(p.taskId);
          let moved = false;
          state.onlinePlaylists.forEach((pl) => {
            if (pl.songs && pl.songs.some((s) => s.id === sid) && !pl.downloaded) {
              pl.downloaded = true;
              pl.downloadedAt = Date.now();
              moved = true;
            }
          });
          if (moved) { saveOpls(); renderNav(); }
        }
      }
      if (p.status === 'error') toast(`下载失败：${p.title}（${p.reason || ''}）`);
    });
    $('#dlFab').addEventListener('click', () => {
      dlPanelOpen = !dlPanelOpen;
      $('#dlPanel').classList.toggle('hidden', !dlPanelOpen);
      $('#dlFab').classList.toggle('open', dlPanelOpen);
      if (dlPanelOpen) renderDlPanel();
    });
    $('#dlFab .dl-fab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dlFabDismissed = true;
      $('#dlFab').classList.add('hidden');
      dlPanelOpen = false;
      $('#dlPanel').classList.add('hidden');
    });
    $('#dlPanelClose').addEventListener('click', () => {
      dlPanelOpen = false;
      $('#dlPanel').classList.add('hidden');
      $('#dlFab').classList.remove('open');
    });
  }
  // ---------- 曲库维护：重复歌曲清理 ----------
  let dupeGroups = []; // [[{checked, song:{id,title,artist,size}}]]
  function fmtSize(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return Math.round(n / 1024) + ' KB';
  }
  async function openDupeDialog() {
    $('#dupeOverlay').classList.remove('hidden');
    $('#dupeBody').innerHTML = '<div class="dupe-loading">正在比对文件内容（按大小+MD5）…</div>';
    $('#dupeDelete').disabled = true;
    $('#dupeSummary').textContent = '';
    dupeGroups = [];
    const groups = await window.api.findDupes();
    if (!groups.length) {
      $('#dupeBody').innerHTML = '<div class="dupe-empty">没有发现重复歌曲 🎉</div>';
      return;
    }
    dupeGroups = groups.map((g) => g.map((s) => ({ checked: true, song: s })));
    renderDupeList();
  }
  function renderDupeList() {
    const body = $('#dupeBody');
    body.innerHTML = '';
    let delCount = 0;
    dupeGroups.forEach((g, gi) => {
      const box = el('div', 'dupe-group');
      const head = el('div', 'dupe-group-title', `重复组 ${gi + 1}（${g.length} 份 · ${fmtSize(g[0].song.size)}）`);
      box.appendChild(head);
      g.forEach((it, i) => {
        const row = el('label', 'dupe-row' + (i === 0 ? ' keep' : ''));
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = i !== 0 && it.checked; // 默认保留第一份
        cb.addEventListener('change', () => { it.checked = cb.checked; updateDupeSummary(); });
        if (i === 0) { cb.disabled = true; cb.checked = true; }
        const info = el('span', 'dupe-info', `${it.song.title}${it.song.artist ? ' — ' + it.song.artist : ''}`);
        info.title = it.song.path;
        const tag = el('span', 'dupe-tag', i === 0 ? '保留' : (it.checked ? '将删除' : ''));
        row.append(cb, info, tag);
        box.appendChild(row);
      });
      body.appendChild(box);
    });
    updateDupeSummary();
  }
  function updateDupeSummary() {
    let n = 0;
    dupeGroups.forEach((g) => g.forEach((it, i) => { if (i !== 0 && it.checked) n++; })); // 第 0 份固定保留
    $('#dupeSummary').textContent = `将删除 ${n} 个重复文件（移入回收站）`;
    $('#dupeDelete').disabled = n === 0;
  }
  async function doDeleteDupes() {
    const ids = [];
    dupeGroups.forEach((g) => g.forEach((it, i) => { if (i !== 0 && it.checked) ids.push(it.song.id); }));
    if (!ids.length) return;
    $('#dupeDelete').disabled = true;
    const r = await window.api.removeSongs(ids);
    if (!r || !r.ok) { toast('删除失败'); return; }
    // 本地状态同步剔除
    const gone = new Set(ids);
    state.songs = state.songs.filter((s) => !gone.has(s.id));
    state.queue = state.queue.filter((s) => !gone.has(s.id));
    state.favorites = state.favorites.filter((id) => !gone.has(id));
    closeDupeDialog();
    setView(state.view); // 重渲染当前视图
    toast(`已删除 ${r.removed} 个重复文件${r.failed.length ? '，' + r.failed.length + ' 个失败' : ''}`);
  }
  function closeDupeDialog() {
    $('#dupeOverlay').classList.add('hidden');
  }
  function bindDupeDialog() {
    $('#stFindDupes').addEventListener('click', openDupeDialog);
    $('#dupeClose').addEventListener('click', closeDupeDialog);
    $('#dupeCancel').addEventListener('click', closeDupeDialog);
    $('#dupeDelete').addEventListener('click', doDeleteDupes);
    $('#dupeOverlay').addEventListener('click', (e) => { if (e.target === $('#dupeOverlay')) closeDupeDialog(); });
  }

  let plPickEntry = null; // 待加入歌单的条目（本地 id 字符串 或 在线歌曲对象）
  let plPickMode = 'add'; // 'add'=加入歌单 | 'create'=仅新建歌单 | 'rename'=重命名歌单
  function closePlPick() {
    $('#plPickOverlay').classList.add('hidden');
    plPickEntry = null;
    plPickMode = 'add';
    plPickRenameTarget = null;
  }
  function openAddToPlaylist(entry) {
    plPickMode = 'add';
    plPickEntry = entry;
    plPickRenameTarget = null;
    const list = $('#plPickList');
    list.classList.remove('hidden');
    list.innerHTML = '';
    $('#plPickHead').textContent = '加入歌单';
    $('#plPickTip').textContent = '选择歌单，或在下方输入新歌单名称：';
    $('#plPickAdd').textContent = '新建并加入';
    if (!state.playlists.length) {
      list.appendChild(el('div', 'pl-pick-empty', '还没有歌单 — 在下方输入名称新建一个'));
    }
    state.playlists.forEach((pl) => {
      const row = el('div', 'pl-pick-item');
      row.textContent = `${pl.name}（${pl.songIds.length} 首）`;
      row.addEventListener('click', async () => {
        if (pl.songIds.length >= 500) { toast(`歌单「${pl.name}」已达上限 500 首`); return; }
        state.playlists = await window.api.addSongsToPlaylist(pl.id, [entry]);
        closePlPick();
        renderNav();
        toast(`已加入歌单「${pl.name}」`);
      });
      list.appendChild(row);
    });
    $('#plPickInput').value = '';
    $('#plPickOverlay').classList.remove('hidden');
    $('#plPickInput').focus();
  }
  async function addToPlaylist(entry) {
    // entry：本地歌曲 id（字符串）或在线歌曲对象；Electron 禁 window.prompt → 用应用内选择面板
    openAddToPlaylist(entry);
  }
  // 「＋ 新建歌单」：Electron 禁 window.prompt，复用选择面板的"仅新建"模式
  function openCreatePlaylist() {
    plPickMode = 'create';
    plPickEntry = null;
    plPickRenameTarget = null;
    $('#plPickList').classList.add('hidden');
    $('#plPickHead').textContent = '新建歌单';
    $('#plPickTip').textContent = '输入新歌单名称，回车或点「创建」：';
    $('#plPickAdd').textContent = '创建';
    $('#plPickInput').value = '';
    $('#plPickOverlay').classList.remove('hidden');
    $('#plPickInput').focus();
  }

  // ---------- 歌词悬浮窗设置区 ----------
  function updateLsMode(mode) {
    $('#lsMode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  }
  function updateLsColorSel(color) {
    $('#lsColors').querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.c === color));
  }
  async function setupLyricSettings() {
    const lc = await window.api.getLyricWin();
    if (!lc) return;
    $('#lsToggle').checked = !!lc.enabled;
    $('#lsFont').value = lc.fontSize;
    $('#lsColor').value = lc.color;
    $('#lsOpacity').value = Math.round(lc.bgOpacity * 100);
    $('#lsLock').checked = !!lc.locked;
    $('#lsStroke').checked = lc.stroke !== false;
    updateLsMode(lc.mode);
    updateLsColorSel(lc.color);
    const set = (patch) => window.api.setLyricWin(patch).then((c) => {
      updateLsMode(c.mode);
      updateLsColorSel(c.color);
    });
    $('#lsToggle').addEventListener('change', (e) => set({ enabled: e.target.checked }));
    $('#lsMode').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => set({ mode: b.dataset.mode })));
    $('#lsFont').addEventListener('input', (e) => set({ fontSize: +e.target.value }));
    $('#lsColors').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => set({ color: b.dataset.c })));
    $('#lsColor').addEventListener('input', (e) => set({ color: e.target.value }));
    $('#lsOpacity').addEventListener('input', (e) => set({ bgOpacity: +e.target.value / 100 }));
    $('#lsLock').addEventListener('change', (e) => set({ locked: e.target.checked }));
    $('#lsStroke').addEventListener('change', (e) => set({ stroke: e.target.checked }));
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    // 歌单分组折叠（最近听过 / 本地 / 在线 / 临时）：状态存 localStorage，标题点击展开/收起
    const foldGet = (key, def) => { try { const v = localStorage.getItem(key); return v === null ? def : v === '1'; } catch { return def; } };
    const bindFold = (titleSel, bodySel, chevId, key, def) => {
      const t = document.querySelector(titleSel);
      const body = document.querySelector(bodySel);
      const c = document.getElementById(chevId);
      if (!t || !body) return;
      const apply = () => {
        const open = foldGet(key, def);
        body.classList.toggle('hidden', !open);
        if (c) c.style.transform = open ? 'rotate(90deg)' : '';
      };
      apply();
      t.addEventListener('click', () => {
        const open = foldGet(key, def);
        try { localStorage.setItem(key, open ? '0' : '1'); } catch {}
        apply();
      });
    };
    bindFold('#recentFold', '#navPlRecent', 'recentChevron', 'mp_fold_recent', false);  // 最近听过：默认收起
    bindFold('#myPlTitle', '#navPlMine', 'myPlChev', 'mp_fold_mine', true);
    bindFold('#tempPlTitle', '#navPlTemp', 'tempPlChev', 'mp_fold_temp', true);
    bindFold('#dirsTitle', '#navDirs', 'dirsChev', 'mp_fold_dirs', true);

    // 搜索（本地过滤 / 在线搜索切换）
    const updateSearchUI = () => {
      const on = state.searchMode === 'online';
      $('#btnSearchMode').textContent = on ? '在线' : '本地'; // 显示当前模式（之前显示的是切换目标，容易误解）
      $('#btnSearchMode').classList.toggle('active', on);
      updateSearchPlaceholder(); // 占位符随模式+当前视图变化（歌单内搜索提示）
    };
    updateSearchUI(); // 启动即同步按钮文字（当前模式），避免停留在 HTML 默认"在线"
    $('#btnSearchMode').addEventListener('click', () => {
      state.searchMode = state.searchMode === 'online' ? 'local' : 'online';
      updateSearchUI();
      if (state.searchMode === 'local') {
        state.filter = $('#search').value; // 保留的输入框内容同步为本地过滤词，立即生效
        renderList();
        if (state.view === 'online') closeOnline();
      }
      $('#search').focus();
    });
    let searchTimer = null;
    $('#search').addEventListener('input', (e) => {
      if (state.searchMode === 'online') return; // 在线模式回车才触发
      state.filter = e.target.value;
      $('#searchClear').classList.toggle('hidden', !e.target.value);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderList(), 150);
    });
    $('#search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (state.searchMode === 'online') { onlineSearch(e.target.value); return; }
        // 本地模式回车 = 触发本地过滤（显示匹配结果），而不是直接播放
        state.filter = e.target.value;
        renderList();
      }
    });
    $('#searchClear').addEventListener('click', () => {
      $('#search').value = '';
      state.filter = '';
      $('#searchClear').classList.add('hidden');
      renderList();
      $('#search').focus();
    });
    $('#btnOnlineClose').addEventListener('click', closeOnline);
    // 导入歌单面板
    $('#oplImportOk').addEventListener('click', () => doImportOnlinePlaylist($('#oplImportInput').value));
    $('#oplImportCancel').addEventListener('click', closeOplImport);
    $('#oplImportClose').addEventListener('click', closeOplImport);
    $('#oplImportOverlay').addEventListener('click', (e) => { if (e.target === $('#oplImportOverlay')) closeOplImport(); });
    $('#oplImportInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doImportOnlinePlaylist(e.target.value); });

    // 加入歌单面板
    $('#plPickClose').addEventListener('click', closePlPick);
    $('#plPickCancel').addEventListener('click', closePlPick);
    $('#plPickOverlay').addEventListener('click', (e) => { if (e.target === $('#plPickOverlay')) closePlPick(); });
    $('#plPickAdd').addEventListener('click', async () => {
      const n = ($('#plPickInput').value || '').trim();
      if (!n) { toast('请输入歌单名称'); return; }
      // 重命名歌单：本地（playlists.json）或在线（online-playlists.json）
      if (plPickMode === 'rename') {
        const t = plPickRenameTarget;
        if (!t) { closePlPick(); return; }
        if (t.kind === 'local') {
          if (state.playlists.some((p) => p !== t.pl && p.name === n)) { toast('已有同名歌单'); return; }
          t.pl.name = n;
          await window.api.savePlaylists(state.playlists);
        } else {
          t.pl.name = n;
          saveOpls();
        }
        closePlPick();
        renderNav();
        if (state.view === (t.kind === 'local' ? 'playlist:' + t.pl.id : 'opl:' + t.pl.id)) setView(state.view);
        toast(`已重命名为「${n}」`);
        return;
      }
      const wasCreate = plPickMode === 'create';
      let pl = state.playlists.find((p) => p.name === n);
      if (!pl) {
        // 新歌单先落盘，否则 addSongsToPlaylist 从文件读旧列表找不到它
        pl = { id: 'p' + Date.now(), name: n, songIds: [] };
        state.playlists.push(pl);
        state.playlists = await window.api.savePlaylists(state.playlists);
      }
      if (plPickEntry != null) {
        state.playlists = await window.api.addSongsToPlaylist(pl.id, [plPickEntry]);
      }
      closePlPick();
      renderNav();
      toast(wasCreate ? `已创建歌单「${n}」` : `已加入歌单「${n}」`);
    });
    $('#plPickInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#plPickAdd').click(); });

    // 刷新 / 添加（顶栏小图标；侧边栏曲库目录组底部入口的事件在 renderDirs 里绑定）
    $('#btnRescan').addEventListener('click', doRescan);

    // 导航
    document.querySelectorAll('#nav .nav-item[data-view="library"], #nav .nav-item[data-view="favorites"], #nav .nav-item[data-view="history"]')
      .forEach((n) => n.addEventListener('click', () => setView(n.dataset.view)));

    // 侧栏编辑模式：开启后歌单可直接按住拖拽排序（不开启=长按 400ms）
    const btnEditMode = $('#btnEditMode');
    const applyEditMode = (on) => {
      state.editMode = on;
      btnEditMode.classList.toggle('on', on);
      document.getElementById('nav').classList.toggle('edit-mode', on);
      try { localStorage.setItem('mp_edit_mode', on ? '1' : '0'); } catch { /* 忽略 */ }
    };
    btnEditMode.addEventListener('click', () => {
      applyEditMode(!state.editMode);
      toast(state.editMode ? '编辑模式已开启：按住歌单即可拖动排序' : '编辑模式已关闭');
    });
    { let em = false; try { em = localStorage.getItem('mp_edit_mode') === '1'; } catch { /* 忽略 */ } applyEditMode(em); }

    // 设置面板（居中模态小窗 + 左侧分类侧栏）
    const stSideBtns = document.querySelectorAll('.st-side-item');
    const stSections = document.querySelectorAll('.st-section');
    const showSettingsSection = (sec) => {
      stSideBtns.forEach((b) => b.classList.toggle('active', b.dataset.sec === sec));
      stSections.forEach((s) => s.classList.toggle('active', s.dataset.sec === sec));
      if (sec === 'library') renderStDirList();
      try { localStorage.setItem('mp_set_sec', sec); } catch { /* 忽略 */ }
    };
    const toggleSettings = (show) => {
      $('#settingsOverlay').classList.toggle('hidden', !show);
      if (show) {
        $('#settingsPanel').classList.remove('hidden');
        let sec = 'general';
        try { sec = localStorage.getItem('mp_set_sec') || 'general'; } catch { /* 忽略 */ }
        if (!document.querySelector('.st-side-item[data-sec="' + sec + '"]')) sec = 'general';
        showSettingsSection(sec);
      }
    };
    $('#btnSettings').addEventListener('click', () => toggleSettings($('#settingsOverlay').classList.contains('hidden')));
    $('#stClose').addEventListener('click', () => toggleSettings(false));
    $('#settingsOverlay').addEventListener('click', (e) => { if (e.target === $('#settingsOverlay')) toggleSettings(false); });
    stSideBtns.forEach((b) => b.addEventListener('click', () => showSettingsSection(b.dataset.sec)));
    // 歌单主窗「全部播放」：播放当前可见列表（含歌单内搜索过滤结果）
    $('#viewPlayAll').addEventListener('click', () => {
      const vis = visibleList();
      if (!vis.length) { toast('歌单是空的'); return; }
      playList(vis, 0, 0, true, true);
    });
    $('#bgBlurRange').addEventListener('input', (e) => {
      const v = +e.target.value;
      document.documentElement.style.setProperty('--bg-blur', v + 'px');
      $('#bgBlurVal').textContent = (Math.round(v * 10) / 10).toFixed(1);
      clearTimeout(window.__bgBlurTimer);
      window.__bgBlurTimer = setTimeout(() => window.api.setBgBlur(v), 300);
    });
    document.querySelectorAll('#settingsPanel .st-mode').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#settingsPanel .st-mode').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      window.api.setMode(b.dataset.mode);
      state.mode = b.dataset.mode;
      if (state.mode === 'shuffle' && state.queue.length) rebuildShuffle();
      updateModeBtn();
    }));
    $('#stAutoLaunch').addEventListener('change', (e) => window.api.setAutoLaunch(e.target.checked));
    $('#stLyric').addEventListener('change', (e) => window.api.setLyricWin({ enabled: e.target.checked }));
    // 睡眠定时（设置面板：关/30/60/自定义，上限 360 分钟）
    const applySleep = (b) => {
      document.querySelectorAll('#stSleepModes .st-mode').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      if (b.dataset.sleep === 'custom') setSleepMode($('#stSleepCustom').value);
      else setSleepMode(+b.dataset.sleep);
    };
    document.querySelectorAll('#stSleepModes .st-mode').forEach((b) => b.addEventListener('click', () => applySleep(b)));
    $('#stSleepCustom').addEventListener('change', (e) => {
      const v = Math.max(1, Math.min(360, Math.round(Number(e.target.value) || 0)));
      e.target.value = v;
      if (v > 0) setSleepMode(v);
    });
    // 关闭窗口行为（托盘/退出）
    document.querySelectorAll('#stCloseModes .st-mode').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#stCloseModes .st-mode').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      try { localStorage.setItem('mp_close', b.dataset.close); } catch { /* 忽略 */ }
      window.api.setCloseBehavior(b.dataset.close);
    }));
    // 启动恢复播放
    $('#stResume').addEventListener('change', (e) => {
      try { localStorage.setItem('mp_resume', e.target.checked ? '1' : '0'); } catch { /* 忽略 */ }
    });
    // 桌面歌词字号
    $('#stLyrFs').addEventListener('input', (e) => {
      const v = +e.target.value;
      $('#stLyrFsVal').textContent = v;
      clearTimeout(window.__lyrFsTimer);
      window.__lyrFsTimer = setTimeout(() => window.api.setLyricWin({ fontSize: v }), 200);
    });
    // 桌面歌词透明度
    $('#stLyrOp').addEventListener('input', (e) => {
      const v = +e.target.value;
      $('#stLyrOpVal').textContent = v + '%';
      clearTimeout(window.__lyrOpTimer);
      window.__lyrOpTimer = setTimeout(() => window.api.setLyricWin({ bgOpacity: v / 100 }), 200);
    });
    // 桌面歌词颜色（已唱/未唱，独立可调）
    $('#stLyrColor2').addEventListener('input', (e) => window.api.setLyricWin({ color2: e.target.value }));
    $('#stLyrColor').addEventListener('input', (e) => window.api.setLyricWin({ color: e.target.value }));
    // 歌词字号（面板/详情）
    $('#stFs').addEventListener('input', (e) => {
      const v = +e.target.value;
      $('#stFsVal').textContent = v;
      document.documentElement.style.setProperty('--lyric-fs', v + 'px');
      reSegmentActiveLyrics();
      try { localStorage.setItem('mp_fs', String(v)); } catch { /* 忽略 */ }
    });
    // 歌词翻译开关（双语显示）
    $('#stLyrTrans').checked = lyrTransOn();
    $('#stLyrTrans').addEventListener('change', (e) => {
      try { localStorage.setItem('mp_lyrtrans', e.target.checked ? '1' : '0'); } catch { /* 忽略 */ }
      if (state.lrc && state.lrc.length) {
        renderLyrics();
        if (!$('#pageDetail').classList.contains('hidden')) renderDetailLyrics();
      }
    });
    // 下载目录保存（回车/失焦）
    const saveDlDir = () => {
      const v = ($('#stDlDir').value || '').trim();
      if (!v) { $('#stDlDir').value = ''; $('#stDlDir').placeholder = '留空 = 音乐目录\\Downloads'; return; }
      window.api.dlDir(v).then((dir) => { if (dir) $('#stDlDir').value = dir; toast('下载目录已更新'); });
    };
    $('#stDlDir').addEventListener('change', saveDlDir);
    $('#stDlDir').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveDlDir(); } });
    // 下载目录「浏览…」：原生文件夹选择框
    $('#stDlDirPick').addEventListener('click', async () => {
      const dir = await window.api.pickDlDir();
      if (dir) { $('#stDlDir').value = dir; toast('下载目录已更新'); }
    });
    $('#stDlOverwrite').addEventListener('change', async (e) => {
      const v = await window.api.dlOverwrite(e.target.checked);
      if (v != null) toast(v ? '已开启：下载将替换已有同名文件' : '已关闭：重名文件自动加序号');
    });
    // ---------- 自动更新：检查 / 下载 / 重启安装 ----------
    let updState = 'idle'; // idle | checking | available | downloading | downloaded
    const updBtn = $('#stUpdCheck');
    const updStatus = $('#stUpdStatus');
    const updSetStatus = (txt) => { if (updStatus) updStatus.textContent = txt; };
    const updRenderBtn = () => {
      if (!updBtn) return;
      updBtn.classList.remove('primary');
      updBtn.disabled = false;
      if (updState === 'available') { updBtn.textContent = '下载更新'; updBtn.classList.add('primary'); }
      else if (updState === 'downloading') { updBtn.textContent = '下载中…'; updBtn.disabled = true; }
      else if (updState === 'downloaded') { updBtn.textContent = '重启安装'; updBtn.classList.add('primary'); }
      else updBtn.textContent = '检查更新';
    };
    if (updBtn) {
      updBtn.addEventListener('click', async () => {
        if (updState === 'available') {
          updState = 'downloading'; updRenderBtn(); updSetStatus('正在下载新版本…');
          const r = await window.api.updateDownload();
          if (!r || !r.ok) { updState = 'idle'; updRenderBtn(); updSetStatus('下载失败：' + ((r && r.reason) || '未知错误')); }
          return;
        }
        if (updState === 'downloaded') { window.api.updateInstall(); return; }
        updState = 'checking'; updRenderBtn(); updSetStatus('正在检查更新…');
        const r = await window.api.updateCheck();
        if (!r || !r.ok) { updState = 'idle'; updRenderBtn(); updSetStatus('检查失败：' + ((r && r.reason) || '未知错误')); }
      });
      window.api.onUpdateEvent((d) => {
        if (!d || !d.type) return;
        if (d.type === 'available') {
          updState = 'available'; updRenderBtn();
          const ver = (d.data && d.data.version) || '';
          updSetStatus('发现新版本 v' + ver + ' — 点击「下载更新」');
          toast('发现新版本 v' + ver + '，可到 设置 → 软件更新 下载');
        } else if (d.type === 'not-available') {
          updState = 'idle'; updRenderBtn(); updSetStatus('已是最新版本');
        } else if (d.type === 'downloaded') {
          updState = 'downloaded'; updRenderBtn(); updSetStatus('更新已下载完成 — 点击「重启安装」立即生效');
        } else if (d.type === 'progress') {
          updSetStatus('下载中… ' + ((d.data && d.data.percent) || 0) + '%');
        } else if (d.type === 'error') {
          updState = 'idle'; updRenderBtn(); updSetStatus('更新出错：' + ((d.data && d.data.message) || '未知错误'));
        }
      });
    }
    // 默认音量（与播放条音量条联动）
    $('#stVolRange').addEventListener('input', (e) => {
      const v = +e.target.value;
      $('#stVolVal').textContent = v + '%';
      state.volume = v / 100;
      audio.volume = state.volume;
      $('#pVol').value = v;
      clearTimeout(volTimer);
      volTimer = setTimeout(() => window.api.setVolume(state.volume), 300);
    });
    document.addEventListener('click', (e) => {
      if (!$('#settingsOverlay').classList.contains('hidden') && e.target === $('#settingsOverlay')) {
        toggleSettings(false);
      }
    });

    // 播放控制
    $('#btnPrev').addEventListener('click', () => nextOrPrev(playPrev));
    $('#btnNext').addEventListener('click', () => nextOrPrev(playNext));
    $('#btnPlay').addEventListener('click', togglePlay);
    $('#btnMode').addEventListener('click', cycleMode);
    $('#btnRate').addEventListener('click', cycleRate);
    $('#viewSwitch').addEventListener('click', toggleGrid);

    // 缩略图封面页控制（后台时窗口内可直接操作）
    $('#tvPrev').addEventListener('click', () => nextOrPrev(playPrev));
    $('#tvNext').addEventListener('click', () => nextOrPrev(playNext));
    $('#tvPlay').addEventListener('click', togglePlay);

    // 进度条（点击/拖动跳转）——主播放条 + 详情页进度条联动
    const seekRange = (e) => {
      if (audio.duration) audio.currentTime = (+e.target.value / 1000) * audio.duration;
      updateLyricHighlight();
      window.api.sendLyricPlayState({ playing: !audio.paused, audioTime: audio.currentTime, duration: audio.duration || 0 });
    };
    $('#pRange').addEventListener('input', seekRange);
    $('#pdRange').addEventListener('input', seekRange);

    // 音量（实时生效 + 防抖落盘）
    let volTimer = null;
    $('#pVol').addEventListener('input', (e) => {
      state.volume = +e.target.value / 100;
      audio.volume = state.volume;
      clearTimeout(volTimer);
      volTimer = setTimeout(() => window.api.setVolume(state.volume), 300);
    });

    // audio 事件
    let lastSmtcPos = -1;
    let lastAudioTime = 0; // 最后已知音频时间（timeupdate 更新；恢复播放瞬间 currentTime 可能读 0 时兜底）
    // metadata 时长可能与实际解码时长不符（如 VBR/尾部数据）→ 播放后统一校正显示
    audio.addEventListener('loadedmetadata', () => {
      if (!audio.duration) return;
      const dur = fmtTime(audio.duration);
      $('#pDur').textContent = dur;
      $('#pdDur').textContent = dur;
      $('#tvDur').textContent = dur;
      const row = document.querySelector('#songBody tr.playing, #songBody tr.active');
      if (row) {
        const c = row.querySelector('.c-dur');
        if (c) c.textContent = dur; // 列表行时长同步实际解码时长（与桌面歌词一致）
      }
      // 歌词窗时长校正（切歌瞬间 play 事件的 duration 可能为 0，此处补发正确时长）
      window.api.sendLyricPlayState({ playing: !audio.paused, audioTime: audio.currentTime || lastAudioTime, duration: audio.duration });
    });
    audio.addEventListener('timeupdate', () => {
      lastAudioTime = audio.currentTime; // 最后已知时间（恢复播放瞬间 currentTime 可能读 0 时兜底）
      $('#pCur').textContent = fmtTime(audio.currentTime);
      $('#pdCur').textContent = fmtTime(audio.currentTime);
      if (audio.duration) {
        const v = Math.round((audio.currentTime / audio.duration) * 1000);
        $('#pRange').value = v;
        $('#pdRange').value = v;
        $('#pDur').textContent = fmtTime(audio.duration);
        $('#pdDur').textContent = fmtTime(audio.duration);
      }
      if (!$('#thumbView').classList.contains('hidden')) updateThumbControls(); // 缩略图页进度同步
      // SMTC 进度（Win11 媒体浮出进度条）——节流约 1 秒
      try {
        if (audio.currentTime - lastSmtcPos >= 1 || audio.currentTime < lastSmtcPos) {
          lastSmtcPos = audio.currentTime;
          window.api.smtcUpdate({ position: audio.currentTime, duration: audio.duration || 0 });
        }
      } catch { /* 忽略 */ }
      // 歌词更新：rAF 驱动（kalaokeLoop），此处 timeupdate 兜底行切换——
      // 主窗被遮挡/最小化时 rAF 会冻结（backgroundThrottling 只管后台页），
      // 行切换停止 → 歌词窗卡旧行全蓝；timeupdate 由音频驱动不被节流，保证行推进
      updateLyricHighlight();
      if (!$('#pageDetail').classList.contains('hidden')) updateDetailLyric(); // 详情页同兜底（此前只靠 rAF → 遮挡时渐变/行切换停住）
    });
    audio.addEventListener('play', () => {
      $('#iconPlay').classList.add('hidden');
      $('#iconPause').classList.remove('hidden');
      if (!rafId) karaokeLoop();
      window.api.sendLyricPlayState({ playing: true, audioTime: audio.currentTime || lastAudioTime, duration: audio.duration || 0 });
      window.api.sendThumbState(true);
      try { navigator.mediaSession.playbackState = 'playing'; } catch { /* 忽略 */ }
      window.api.smtcUpdate({ playing: true });
      const pi0 = $('#pCoverImg');
      if (pi0.src && !pi0.classList.contains('hidden')) sendThumbDIB(pi0.src, true); // 缩略图同步播放状态
      // 封面旋转（酷狗式唱片）
      $('#pCoverImg').classList.add('spinning');
      $('#pdCoverImg').classList.add('spinning');
      updateThumbControls();
    });
    audio.addEventListener('pause', () => {
      $('#iconPlay').classList.remove('hidden');
      $('#iconPause').classList.add('hidden');
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      window.api.sendLyricPlayState({ playing: false, audioTime: audio.currentTime || lastAudioTime, duration: audio.duration || 0 });
      window.api.sendThumbState(false);
      try { navigator.mediaSession.playbackState = 'paused'; } catch { /* 忽略 */ }
      window.api.smtcUpdate({ playing: false });
      const pi1 = $('#pCoverImg');
      if (pi1.src && !pi1.classList.contains('hidden')) sendThumbDIB(pi1.src, false); // 缩略图同步暂停状态
      $('#pCoverImg').classList.remove('spinning');
      $('#pdCoverImg').classList.remove('spinning');
      // 暂停时恢复音量（淡入淡出状态清理）
      state.fadePending = false;
      clearInterval(fadeTimer);
      if (fadeResolve) { const r = fadeResolve; fadeResolve = null; r(); } // 中断挂起的淡出（防切歌卡死）
      audio.volume = state.volume;
      updateThumbControls();
    });
    audio.addEventListener('playing', () => {
      state.errStreak = 0;
      if (state.fadePending) { state.fadePending = false; fadeIn(); } // 切歌淡入
    });
    audio.addEventListener('ended', () => {
      savePlaybackState();
      if (state.mode === 'repeat-one') {
        state.fadePending = true; // 单曲循环：收尾已淡出 → 重播淡入
        audio.volume = 0;
        audio.currentTime = 0;
        audio.play().catch(() => {});
      } else {
        playNext();
      }
    });
    audio.addEventListener('error', () => {
      // 淡入中断兜底：error 时若 volume 停在 0（切歌淡入失败），立即恢复用户音量，避免无声卡死
      audio.volume = state.volume;
      state.fadePending = false;
      if (fadeResolve) { const r = fadeResolve; fadeResolve = null; r(); }
      const s = currentSong();
      if (s) {
        s.missing = true;
        toast(`无法播放「${s.title}」：文件缺失或已损坏`);
        updatePlayingUI(s);
        renderList();
      }
      state.errStreak++;
      if (state.errStreak >= 3 || state.errStreak >= Math.max(1, state.queue.length)) {
        state.errStreak = 0;
        toast('连续播放失败，已停止');
        return;
      }
      if (state.queue.length) playNext();
    });

    // 歌词窗心跳同步（0.2s）：主窗最小化/后台时 rAF 与 timeupdate 可能被节流，
    // 心跳用 audio.currentTime 直读持续校正歌词窗 curTime/duration；同时保持 lastAudioTime 新鲜
    // （主窗已 setBackgroundThrottling(false)，后台定时器不被节流，0.2s 间隔真实生效）
    setInterval(() => {
      if (audio.currentTime) lastAudioTime = audio.currentTime;
      window.api.sendLyricPlayState({ playing: !audio.paused, audioTime: lastAudioTime, duration: audio.duration || 0 });
    }, 200);

    // 歌曲详情页：点击播放条封面整页进入，返回按钮/Esc 回主界面
    $('#pCover').addEventListener('click', showDetail);
    // 复制歌词（详情页左下角）
    $('#pdCopyLyric').addEventListener('click', async () => {
      const s = currentSong();
      if (!s) return;
      const text = (state.lrc && state.lrc.length ? state.lrc.map((l) => l.text).filter(Boolean).join('\n') : '暂无歌词');
      const head = `${s.title}${s.artist ? ' - ' + s.artist : ''}\n\n`;
      try {
        await navigator.clipboard.writeText(head + text);
        toast('歌词已复制');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = head + text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast('歌词已复制');
      }
    });
    $('#pdBack').addEventListener('click', backDetail);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#pageDetail').classList.contains('hidden')) backDetail();
    });

    // 歌词面板
    $('#btnLyric').addEventListener('click', () => {
      const panel = $('#lyricPanel');
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) {
        lastLyricIdx = -1;
        const s = currentSong();
        if (!state.lrc && s) loadLyrics(s.id);
        updateLyricHighlight();
      }
    });
    $('#btnCloseLyric').addEventListener('click', () => $('#lyricPanel').classList.add('hidden'));

    // 播放队列面板
    $('#btnQueue').addEventListener('click', () => {
      const panel = $('#queuePanel');
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) renderQueue();
    });
    $('#btnCloseQueue').addEventListener('click', () => $('#queuePanel').classList.add('hidden'));

    // 右键菜单关闭
    document.addEventListener('click', hideContextMenu);
    window.addEventListener('blur', hideContextMenu);

    // 托盘/全局快捷键
    window.api.onMedia((action) => {
      if (action === 'toggle') togglePlay();
      else if (action === 'next') nextOrPrev(playNext);
      else if (action === 'prev') nextOrPrev(playPrev);
    });

    // 任务栏音符按钮点击（SMTC：播放/暂停/下一首/上一首）
    window.api.onSmtcControl((action) => {
      if (action === 'play') { if (audio.paused) togglePlay(); }
      else if (action === 'pause') { if (!audio.paused) togglePlay(); }
      else if (action === 'next') nextOrPrev(playNext);
      else if (action === 'prev') nextOrPrev(playPrev);
    });

    // 桌面歌词迷你模式控制（解锁后：上一首/播放暂停/下一首/进度跳转/播放模式）
    window.api.onPlayerControl((action) => {
      if (action === 'prev') nextOrPrev(playPrev);
      else if (action === 'next') nextOrPrev(playNext);
      else if (action === 'play') togglePlay();
      else if (typeof action === 'object' && action.mode) {
        // 歌词窗右下角切换播放模式 → 主窗同步
        if (state.mode !== action.mode) {
          state.mode = action.mode;
          if (state.mode === 'shuffle' && state.queue.length) rebuildShuffle();
          updateModeBtn();
          window.api.setMode(state.mode);
        }
      }
      else if (typeof action === 'object' && action.seek != null && audio.duration) {
        audio.currentTime = action.seek * audio.duration;
        updateLyricHighlight();
        window.api.sendLyricPlayState({ playing: !audio.paused, audioTime: audio.currentTime, duration: audio.duration });
      }
    });

    // 歌单内拖拽排序（酷狗式；仅歌单视图）
    let dragId = null;
    $('#songBody').addEventListener('dragstart', (e) => {
      const tr = e.target.closest('tr');
      if (!tr || !currentPlaylistId()) { e.preventDefault(); return; }
      dragId = tr.dataset.id;
      tr.classList.add('drag-src');
      e.dataTransfer.effectAllowed = 'move';
    });
    $('#songBody').addEventListener('dragover', (e) => {
      if (!dragId || !currentPlaylistId()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('#songBody tr.drag-over').forEach((r) => r.classList.remove('drag-over'));
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.id !== dragId) tr.classList.add('drag-over');
    });
    $('#songBody').addEventListener('dragleave', (e) => {
      const tr = e.target.closest('tr');
      if (tr) tr.classList.remove('drag-over');
    });
    $('#songBody').addEventListener('drop', (e) => {
      const tr = e.target.closest('tr');
      if (!dragId || !tr || !currentPlaylistId() || tr.dataset.id === dragId) return;
      e.preventDefault();
      document.querySelectorAll('#songBody tr.drag-src, #songBody tr.drag-over').forEach((r) => r.classList.remove('drag-src', 'drag-over'));
      const pl = state.playlists.find((x) => 'playlist:' + x.id === currentPlaylistId());
      if (!pl) return;
      const from = pl.songIds.indexOf(dragId);
      const to = pl.songIds.indexOf(tr.dataset.id);
      if (from < 0 || to < 0) return;
      pl.songIds.splice(from, 1);
      pl.songIds.splice(to, 0, dragId);
      window.api.savePlaylists(state.playlists);
      renderList();
    });
    $('#songBody').addEventListener('dragend', () => {
      dragId = null;
      document.querySelectorAll('#songBody tr.drag-src, #songBody tr.drag-over').forEach((r) => r.classList.remove('drag-src', 'drag-over'));
    });

    // 睡眠定时剩余时间刷新
    setInterval(updateSleepUi, 30000);

    // 卡拉OK渐变实时推进兜底：rAF 被节流/遮挡时（timeupdate ~250ms 粒度不够平滑），
    // 100ms 定时器保证当前句"已唱/未唱"渐变持续更新（面板 + 详情页）
    setInterval(() => {
      if (audio.paused) return;
      updateLyricHighlight();
      if (!$('#pageDetail').classList.contains('hidden')) updateDetailLyric();
    }, 100);

    // 周期保存播放状态
    setInterval(savePlaybackState, 5000);

    // 调试钩子（CDP 排查用）：暴露歌词/滚动/时间实况
    window.__dbg = {
      get lrc() { return state.lrc ? state.lrc.map((l) => ({ t: +l.t.toFixed(2), text: (l.text || '').slice(0, 14) })) : null; },
      get plainLrc() { return state.plainLrc ? state.plainLrc.slice(0, 60) : null; },
      get lastLyricIdx() { return lastLyricIdx; },
      get curTime() { return +(audio.currentTime || lastAudioTime).toFixed(2); },
      get paused() { return audio.paused; },
      get karaokeRunning() { return rafId !== null; },
      get panelHidden() { return $('#lyricPanel').classList.contains('hidden'); },
      get detailHidden() { return $('#pageDetail').classList.contains('hidden'); },
      get boxScroll() { const b = $('#lyricBox'); return Math.round(b.scrollTop) + '/' + (b.scrollHeight - b.clientHeight); },
      get pdScroll() { const b = $('#pdLyrics'); return Math.round(b.scrollTop) + '/' + (b.scrollHeight - b.clientHeight); },
      // 目标值（Hermes 验证协议）：当前行居中位置，用于量化"滚动是否到位"
      get boxTarget() {
        const els = state.lrcEls || []; const i = lastLyricIdx;
        if (i < 0 || !els[i]) return -1;
        const b = $('#lyricBox');
        return Math.max(0, Math.round(els[i].offsetTop - b.clientHeight / 2 + els[i].clientHeight / 2));
      },
      get pdTarget() {
        const els = document.querySelectorAll('#pdLyrics .d-lyric'); const i = detailLyricIdx;
        if (i < 0 || !els[i]) return -1;
        const b = $('#pdLyrics');
        return Math.max(0, Math.round(els[i].offsetTop - b.clientHeight / 2 + els[i].clientHeight / 2));
      }
    };
  }

  // ---------- 启动 ----------
  bindMediaSession();
  bindEvents();
  bindTagEditor();
  bindDupeDialog();
  bindDownload();
  setupLyricSettings();
  init();
})();
