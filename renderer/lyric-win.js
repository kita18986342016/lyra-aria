// 歌词悬浮窗逻辑（v4：锁定悬停可解锁/可锁定，解锁后可操控，窗口大小不变）
(() => {
  const $ = (sel) => document.querySelector(sel);
  const ICON_UNLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
  const ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  // 播放模式图标（与主窗一致）：列表循环 / 单曲循环 / 随机播放
  const ICON_MODE_ORDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
  const ICON_MODE_REPEAT_ONE = ICON_MODE_ORDER + '<span class="mode-one">1</span>';
  const ICON_MODE_SHUFFLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>';
  const MODE_ICONS = { order: ICON_MODE_ORDER, 'repeat-one': ICON_MODE_REPEAT_ONE, shuffle: ICON_MODE_SHUFFLE };
  const MODE_TITLES = { order: '列表循环', 'repeat-one': '单曲循环', shuffle: '随机播放' };
  let cfg = { fontSize: 26, color: '#bcfb89', color2: '#4deaff', bgOpacity: 0.55, mode: 'desktop', locked: false, playMode: 'order', stroke: true };
  let playing = false;   // 播放中？
  let curTime = 0;       // 当前音频时间（由播放状态同步 + rAF 推算）
  let lineT = 0;         // 当前行开始时间
  let dur = 3;           // 当前行时长
  let duration = 0;      // 歌曲总时长
  let rafId = null;
  // 全量歌词（自主滚动）：行定位/切换在本地，不依赖主窗 rAF/事件（主窗被遮挡/最小化时仍滚动）
  let lrcLines = [];     // [{t, text}]
  let lineIdx = -1;      // 当前行索引
  let wordSegs = [];     // 逐字时间轴 [{t(秒), chars:[{ch,t(秒)}]}]（在线歌词逐字卡拉OK）
  let curWord = null;    // 当前行命中的逐字段 {t, chars, dur}

  function escW(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // 渲染当前行：有逐字时间 → 逐字 span（--p 归一化）；无 → 纯文本单渐变
  // 两句显示：当前句（左对齐）+ 下一句（右下角右对齐预告）；超长句 → 只显示当前句（body.single 换行完整显示）
  function renderLineText(idx) {
    curWord = null;
    const line = lrcLines[idx];
    if (!line) {
      $('#text').textContent = '';
      $('#linePrev').textContent = '';
      $('#lineNext').textContent = '';
      document.body.classList.remove('single');
      syncWinHeight();
      return;
    }
    const text = line.text || '';
    const nextLine = lrcLines[idx + 1];
    const nextText = nextLine ? (nextLine.text || '') : '';
    // 动态阈值：按当前字号算单行能容纳的字数（840 宽 - 边距）→ "短句"必定放得下，不会裁出半个字
    const perLine = Math.max(14, Math.floor(760 / cfg.fontSize));
    const longLine = text.length > perLine || nextText.length > perLine;
    $('#linePrev').textContent = '';
    $('#lineNext').textContent = longLine ? '' : nextText;
    document.body.classList.toggle('single', longLine);
    let best = null, bestD = 0.25;
    for (const w of wordSegs) {
      const d = Math.abs(w.t - line.t);
      if (d < bestD) { bestD = d; best = w; }
    }
    if (best && best.chars && best.chars.length) {
      const dur = Math.max(0.15, (lrcLines[idx + 1] ? lrcLines[idx + 1].t - line.t : 3));
      curWord = { t: line.t, chars: best.chars, dur };
      $('#text').innerHTML = best.chars.map((c, i) => {
        const s0 = Math.min(1, Math.max(0, (c.t - line.t) / dur));
        const s1 = i < best.chars.length - 1 ? Math.min(1, Math.max(0, (best.chars[i + 1].t - line.t) / dur)) : 1;
        return `<span class="w" data-s0="${s0.toFixed(4)}" data-s1="${Math.max(s0 + 0.001, s1).toFixed(4)}">${escW(c.ch || ' ')}</span>`;
      }).join('');
    } else {
      // 无逐字时间轴：统一拆词/拆字均匀卡拉OK（中文逐字、英文按词）——短句也拆，
      // 每字颜色由 applyWordProgress 插值（唱过=蓝，未唱=绿），不依赖 background-clip（Electron 43 下不可靠）
      const dur = Math.max(0.15, (lrcLines[idx + 1] ? lrcLines[idx + 1].t - line.t : 3));
      const segs = text.match(/[\u4e00-\u9fff]|[a-zA-Z0-9']+|\s+|./g) || [text];
      const units = [];
      for (const s of segs) {
        if (/^[\u4e00-\u9fff]$/.test(s)) units.push(s);
        else if (s.trim() === '') units.push(' ');
        else if (units.length && /^[\u4e00-\u9fff]$/.test(units[units.length - 1])) units.push(s);
        else if (units.length) units[units.length - 1] += s;
        else units.push(s); // 首个非中文单元
      }
      const n = Math.max(1, units.length);
      curWord = { t: line.t, chars: units.map((ch, i) => ({ ch, t: line.t + (i / n) * dur })), dur };
      $('#text').innerHTML = units.map((ch, i) => {
        const s0 = i / n, s1 = (i + 1) / n;
        return `<span class="w" data-s0="${s0.toFixed(4)}" data-s1="${Math.max(s0 + 0.001, s1).toFixed(4)}">${escW(ch || ' ')}</span>`;
      }).join('');
    }
    // 半字防线：动态阈值是按字号估算的，字体渲染宽度若有差异导致溢出，
    // 立刻切换行模式（single）完整显示，绝不裁出半个字
    requestAnimationFrame(() => {
      const t = $('#text');
      if (t.scrollWidth > t.clientWidth + 2 && !document.body.classList.contains('single')) {
        document.body.classList.add('single');
        $('#lineNext').textContent = '';
        syncWinHeight();
      }
    });
    syncWinHeight();
  }
  // 自适应窗口高度：内容（当前句+下一句）多高窗口就多高，顶部贴齐（taskbar 模式不调整）
  let winHTimer = null;
  function syncWinHeight() {
    if (cfg.mode === 'taskbar') return;
    clearTimeout(winHTimer);
    winHTimer = setTimeout(() => {
      const textH = ($('#lyricWrap') ? $('#lyricWrap').scrollHeight : 0);
      const nextH = $('#lineNext') && $('#lineNext').textContent ? Math.ceil(cfg.fontSize * 1.5) : 0;
      // 顶部 inset 6 + 内容 + 下一句(底部 12) + 底部边距 6 + 解锁工具条预留 34
      const h = Math.max(108, Math.ceil(textH) + 12 + nextH + 40);
      if (window.api && window.api.setLyricWinHeight) window.api.setLyricWinHeight(Math.min(h, 900));
    }, 40);
  }
  // 逐字卡拉OK：每字颜色插值（未唱=绿 → 唱过=蓝，平滑过渡）——直接设 color，不依赖 background-clip
  function hexToRgb(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
    if (!m) return [188, 251, 137];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function applyWordProgress(p) {
    const spans = $('#text').querySelectorAll(':scope > .w');
    const lc = hexToRgb(cfg.color || '#bcfb89');
    const lc2 = hexToRgb(cfg.color2 || '#4deaff');
    spans.forEach((sp) => {
      const s0 = parseFloat(sp.dataset.s0) || 0;
      const s1 = parseFloat(sp.dataset.s1) || 1;
      const t = s1 > s0 ? Math.min(1, Math.max(0, (p - s0) / (s1 - s0))) : 0;
      const r = Math.round(lc[0] + (lc2[0] - lc[0]) * t);
      const g = Math.round(lc[1] + (lc2[1] - lc[1]) * t);
      const b = Math.round(lc[2] + (lc2[2] - lc[2]) * t);
      sp.style.color = `rgb(${r},${g},${b})`;
    });
  }

  function applyConfig(c) {
    cfg = { ...cfg, ...c };
    // 锁定/解锁表现本质一样：同字号、同位置、同卡拉OK双色（未唱=配置色，已唱=亮蓝）
    // 区别仅在交互：锁定=穿透+透明无框（白框/按钮隐藏，悬停出解锁按钮）；解锁=白框+控制条
    $('#text').style.fontSize = cfg.fontSize + 'px';
    $('#lineNext').style.fontSize = cfg.fontSize + 'px'; // 下一句与当前句同字号
    const a = Math.max(0, Math.min(1, cfg.bgOpacity));
    $('#stage').style.setProperty('--stage-a', a);
    // 整窗透明度（设置-桌面歌词-窗口透明度，30-100%）
    const op = cfg.opacity == null ? 1 : Math.max(0.3, Math.min(1, cfg.opacity));
    document.body.style.opacity = String(op);
    $('#text').style.setProperty('--lc', cfg.color);
    $('#text').style.setProperty('--lc2', cfg.color2 || '#4deaff');
    $('#lineNext').style.setProperty('--lc', cfg.color);
    document.body.classList.toggle('taskbar', cfg.mode === 'taskbar');
    document.body.classList.toggle('locked', !!cfg.locked);
    document.body.classList.toggle('stroke', cfg.stroke !== false); // 描边/阴影（默认开）
    // 顶部工具条图标随状态切换（图标=当前状态）：锁定态=锁形（点击解除）；解锁态=开锁形（点击锁定）
    $('#unlockBtn').innerHTML = cfg.locked ? ICON_LOCK : ICON_UNLOCK;
    $('#unlockBtn').title = cfg.locked ? '解除锁定' : '重新锁定';
    // 右下角播放模式按钮（列表循环/单曲循环/随机）
    const m = cfg.playMode || 'order';
    $('#cMode').innerHTML = MODE_ICONS[m] || ICON_MODE_ORDER;
    $('#cMode').title = MODE_TITLES[m] || '播放模式';
    syncWinHeight();
  }

  function calcP() {
    if (dur <= 0) return 1;
    return (curTime - lineT) / dur;
  }
  function applyProgress(p, caller) {
    window.__lyrDbg.lastApply = { p: +p.toFixed(3), curTime: +curTime.toFixed(3), lineT: +lineT.toFixed(3), dur: +dur.toFixed(3), caller: caller || '?' };
    const pc = Math.min(1, Math.max(0, p));
    if (curWord) { applyWordProgress(pc); return; }
    // 无逐字 span 时（占位等）直接整行颜色：播放过 → 蓝
    const t = Math.min(1, Math.max(0, pc));
    const lc = hexToRgb(cfg.color || '#bcfb89'), lc2 = hexToRgb(cfg.color2 || '#4deaff');
    $('#text').style.color = `rgb(${Math.round(lc[0] + (lc2[0] - lc[0]) * t)},${Math.round(lc[1] + (lc2[1] - lc[1]) * t)},${Math.round(lc[2] + (lc2[2] - lc[2]) * t)})`;
  }
  function updateBar() {
    if (duration > 0) {
      $('#cProgress').value = Math.round((curTime / duration) * 1000);
      $('#cCur').textContent = fmt(curTime);
      $('#cDur').textContent = fmt(duration);
    }
  }
  function fmt(t) {
    t = Math.max(0, Math.floor(t));
    const m = Math.floor(t / 60), s = t % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function setLine(payload) {
    const line = payload && payload.line ? payload.line.trim() : '';
    if (line) {
      // 自主模式（有全量歌词）：行定位由本地 locateLine 主导，主窗推送仅用于同步 lineT/dur
      if (lrcLines.length) {
        const idx = lrcLines.findIndex((l) => Math.abs((l.t || 0) - (payload.lineT || 0)) < 0.05);
        if (idx >= 0) {
          lineIdx = idx;
          lineT = lrcLines[idx].t;
          dur = (lrcLines[idx + 1] ? lrcLines[idx + 1].t - lineT : 3);
          renderLineText(idx);
          // 防御：恢复播放瞬间 curTime 可能仍是 0（音频时间未就绪），calcP 变负会
          // 把渐变 clamp 成全紫——负值不应用，等 onPlayState/心跳校正 curTime 后自然恢复
          const p = calcP();
          if (p >= 0) applyProgress(p, 'setLine');
        }
        return;
      }
      $('#text').textContent = line;
      lineT = payload.lineT || 0;
      dur = payload.dur && payload.dur > 0 ? payload.dur : 3;
      const p2 = calcP();
      if (p2 >= 0) applyProgress(p2, 'setLine');
      syncWinHeight();
    } else if (payload && payload.title) {
      $('#text').textContent = `♪ ${payload.title}${payload.artist ? ' - ' + payload.artist : ''}`;
      $('#linePrev').textContent = '';
      $('#lineNext').textContent = '';
      curWord = null;
      lineT = 0;
      dur = 3;
      applyProgress(1, 'placeholder');
      syncWinHeight();
    }
  }

  // 自主滚动：按当前时间定位歌词行（本地，主窗行切换节流不影响）
  function locateLine() {
    let idx = -1;
    for (let i = lrcLines.length - 1; i >= 0; i--) {
      if (lrcLines[i].t <= curTime + 0.12) { idx = i; break; } // 提前 0.12s 切行
    }
    if (idx !== lineIdx) {
      lineIdx = idx;
      if (idx >= 0) {
        lineT = lrcLines[idx].t;
        dur = (lrcLines[idx + 1] ? lrcLines[idx + 1].t - lineT : 3);
        renderLineText(idx);
      } else {
        lineT = 0; dur = 3;
        $('#text').textContent = '';
        $('#linePrev').textContent = '';
        $('#lineNext').textContent = '';
        syncWinHeight();
      }
      applyProgress(calcP(), 'calcP')
    }
  }

  function onPlayState(st) {
    if (!st.playing) lastDeltaMs = Math.round((curTime - (st.audioTime || 0)) * 1000); // 重置前偏差
    window.__lyrDbg.lastOnPlay = { playing: !!st.playing, audioTime: st.audioTime, curTime, lineT, dur, lrcLen: lrcLines.length, lineIdx };
    const wasPlaying = playing;
    playing = !!st.playing;
    const t = st.audioTime || 0;
    // 播放恢复瞬间保护：
    // 1) audioTime=0（Electron 恢复播放瞬间 currentTime 读 0）且已有有效进度 → 保留本地 curTime；
    // 2) audioTime 陈旧回退 >3s（主窗最小化时 lastAudioTime 滞后）且 lrcLines 非空 → 保留本地 curTime。
    //    seek（playing 不变）不触发保护，正常跟随回退。
    const resumeMoment = !wasPlaying && playing;
    if (resumeMoment && lrcLines.length && curTime > 0 && (t === 0 || curTime - t > 3)) {
      // 保留本地 curTime，等待 2s 心跳用真实时间校正
    } else if (t !== 0 || curTime <= 0 || !lrcLines.length) {
      curTime = t;
    }
    lastTs = 0; // rAF 时间基准重置（暂停期间 ts 停走，恢复时避免 dt 跳变）
    if (st.duration) duration = st.duration;
    $('#cIconPlay').classList.toggle('hidden', playing);
    $('#cIconPause').classList.toggle('hidden', !playing);
    if (lrcLines.length) locateLine(); // 时间校正后重新定位当前行
    updateBar();
    if (playing) {
      if (!rafId) rafLoop();
    } else {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      // 无条件用当前时间冻结渐变（酷狗式"暂停即停"：任何暂停信号到达都精确停在当前帧位置，
      // 即使 rafId 已为 null 也重算一次，避免 DOM 停在旧值）
      applyProgress(calcP(), 'pause');
    }
  }

  // rAF 真实帧间隔推进（不用固定 1/60）：显示器帧率波动/掉帧时 curTime 与音频时间零漂移，
  // 暂停/心跳校正时渐变位置不跳变（用户反馈"暂停停住的位置与暂停前不一致"的根因）
  let lastTs = 0;
  let lastDeltaMs = 0; // 调试：暂停时本地 curTime 与主窗 audioTime 的偏差
  window.__lyrDbg = { get deltaMs() { return lastDeltaMs; }, lastOnPlay: null, calc: null };
  // 调试钩子：calc() 返回 (curTime,lineT,dur,calcP) 实况
  Object.defineProperty(window.__lyrDbg, 'calc', { get() { return JSON.stringify({ curTime: +curTime.toFixed(3), lineT: +lineT.toFixed(3), dur: +dur.toFixed(3), p: +calcP().toFixed(3), playing, rafOn: !!rafId, lrcLen: lrcLines.length, lineIdx }); } });
  function rafLoop(ts) {
    rafId = requestAnimationFrame(rafLoop);
    if (!lastTs) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    curTime += dt;
    if (lrcLines.length) {
      locateLine();               // 自主行切换（精确到行边界）
      applyProgress(calcP(), 'calcP')     // 卡拉OK渐变
    } else {
      applyProgress(1, 'placeholder')           // 占位（无歌词）：固定全唱色
    }
    updateBar();
  }

  window.api.onLyricWinConfig((c) => applyConfig(c));
  window.api.onLyricWinLine((p) => setLine(p));
  window.api.onLyricWinLrc((d) => {
    const lines = (d && Array.isArray(d.lines)) ? d.lines : [];
    wordSegs = (d && Array.isArray(d.words)) ? d.words : [];
    if (!lines.length) { curTime = 0; curWord = null; } // 切歌清空：时间归零（等待新歌 play state/全量）
    lrcLines = lines;
    lineIdx = -1;
    if (lrcLines.length) {
      locateLine();
    } else {
      lineT = 0; dur = 3;
    }
  });
  window.api.onLyricPlayState((s) => onPlayState(s));

  // 悬停 → 显示工具条（锁定时）；移开隐藏
  // 穿透状态由主进程轮询判定（仅解锁按钮附近解除穿透），renderer 只负责工具条显示
  window.api.onLyricWinHoverUI((on) => document.body.classList.toggle('hover', !!on));
  document.addEventListener('mousemove', () => document.body.classList.add('hover'));
  document.addEventListener('mouseleave', () => document.body.classList.remove('hover'));

  // 解锁后手动拖动（实体感）：实时夹回，窗口被屏幕边缘挡住、不能出屏
  // 用 Pointer Events + setPointerCapture：鼠标移出窗口仍持续追踪（模拟系统拖动）
  let dragging = false, lastX = 0, lastY = 0;
  $('#stage').addEventListener('pointerdown', (e) => {
    if (document.body.classList.contains('locked')) return; // 锁定穿透不拖
    if (e.target.closest('#ctrlbar') || e.target.closest('#lockbar')) return; // 按钮不触发拖动
    dragging = true;
    lastX = e.screenX; lastY = e.screenY;
    try { e.target.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  });
  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lastX, dy = e.screenY - lastY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return; // 异常事件防御
    lastX = e.screenX; lastY = e.screenY;
    window.api.lyricWinDrag(dx, dy);
  });
  document.addEventListener('pointerup', () => { dragging = false; });

  // 顶部工具条按钮：随状态切换（锁定态=解除锁定；解锁态=重新锁定）
  $('#unlockBtn').addEventListener('click', () => {
    window.api.setLyricWin({ locked: !cfg.locked });
  });

  // 迷你控制条（解锁后）：上一首 / 播放暂停 / 下一首 / 进度跳转 / 播放模式
  $('#cPrev').addEventListener('click', () => window.api.lyricWinControl('prev'));
  $('#cPlay').addEventListener('click', () => window.api.lyricWinControl('play'));
  $('#cNext').addEventListener('click', () => window.api.lyricWinControl('next'));
  $('#cMode').addEventListener('click', () => window.api.lyricWinControl('mode'));
  $('#cProgress').addEventListener('input', (e) => {
    if (!duration) return;
    const p = +e.target.value / 1000;
    curTime = p * duration;
    updateBar();
    window.api.lyricWinControl({ seek: p });
  });

  // 播放模式变化（主窗/歌词窗任一侧切换都同步图标）
  window.api.onLyricWinMode((m) => {
    if (cfg.mode === m) return;
    cfg.mode = m;
    $('#cMode').innerHTML = MODE_ICONS[m] || ICON_MODE_ORDER;
    $('#cMode').title = MODE_TITLES[m] || '播放模式';
  });
})();

