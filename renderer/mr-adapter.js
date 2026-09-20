// mr-adapter.js —— 深空折韵 ↔ Mineradio 3D 歌词舞台 适配层（本文件是我们自己的代码）
// MR 模块文件原样 vendor 于 renderer/mr/（GPL-3.0，版权与来源见各文件头部与 mr/COPYING.md）。
// 本文件职责：
//   ① 补齐 MR 模块期望但未 vendor 的全局环境（工具函数从 04-visual-settings-persistence.js
//      原样照抄；uniforms/dotTexture 从 00-pointer-cover-particles.js 原样照抄所需子集）；
//   ② 把本播放器数据桥接进 MR 全局契约（audio / lyricsLines / 封面取色 / fx 开关）；
//   ③ 帧驱动（节拍/频段分析公式照搬 11-main-loop.js:357-540）+ 挂载/卸载生命周期。
'use strict';

// ---------- ① 环境补齐（在 MR 模块之前求值；原样照抄，勿改实现） ----------
var SKULL_PRESET_INDEX = 7;            // 占位：bundle 载入时被 02-visual/01-float-skull:120 的真实声明（=6）覆盖。
                                       // 旧注释"恒假"已失效——安魂卡（preset 6）实际会激活骷髅分支，
                                       // 2026-09-20 顺势补全其驱动链+资产（dsh-mediapipe:// 通道），见 mrFrame 骷髅段。
var skullParticleGroup = null;         // MR 14:2087 守卫引用；bundle 02-visual/01:147 载入时接管
var shelfManager = null;               // bundle 顶层 `shelfManager = makeShelfManager()` 载入时接管（04-shelf/01）
// 3D 歌单架全局契约：userPlaylists / playQueue / currentIdx / myPodcastCollections / playlistCoverCache
// 均由 bundle 00-core-stores 顶层声明（var），适配层的 mrShelfSync* 只写这些全局，不再重复 var（避免二次赋值清空）。
// 适配层为 shelf 补的"函数"全局（songCoverSrc / hasAnyPlatformLogin / loadPlaylistIntoQueueById 等，
// 原属未 vendor 的 MR 播放/歌词模块）见文件末「④ 3D 歌单架数据桥」段。
var skullBeatFlash = 0;                // MR 14:2064 骷髅预设专用，恒 0

var shelfDetailOpen = false;           // MR 14:2089 守卫引用
var clamp01 = function (v) { return Math.max(0, Math.min(1, v)); };
var clampRange = function (v, min, max) { return Math.max(min, Math.min(max, v)); };
var rgbToHsl = function (r, g, b) {          // MR 04-visual-settings-persistence.js:2-15
  r /= 255; g /= 255; b /= 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h, s: s, l: l };
};
var hslToRgb = function (h, s, l) {          // MR 04-visual-settings-persistence.js:16-35
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  var r, g, b;
  if (s === 0) r = g = b = l;
  else {
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
};
var rgbCss = function (c, a) {               // MR 04-visual-settings-persistence.js:36-39
  if (a == null) return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
};
var normalizeHexColor = function (value, fallback) {  // MR 04:967-974
  var hex = String(value || '').trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    hex = '#' + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2) + hex.charAt(3) + hex.charAt(3);
  }
  fallback = /^#[0-9a-f]{6}$/i.test(String(fallback || '')) ? String(fallback).toLowerCase() : '#a9b8c8';
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : fallback;
};
var normalizeLyricTextureClarity = function (v) {      // MR 04:54（尾部分支照原样补全）
  var value = Number(v);
  if (!isFinite(value)) value = Number(typeof fxDefaults !== 'undefined' && fxDefaults.lyricTextureClarity) || 1;
  if (Math.abs(value - 1.25) < 0.001) return 2;
  if (Math.abs(value - 1.5) < 0.001) return 4;
  return clampRange(Math.round(value), 1, 4);
};
// 全局 uniforms 子集（MR 00-pointer-cover-particles.js:326-364 中歌词链触碰的字段：
// uTime/uPixel/uBass/uBeat/uEnergy，统计见移植记录；封面纹理族字段属于未移植的粒子模块）


// 偏好读取函数瘦身版：原函数在 MR 05-playback/00,01,02,06 与 03-beat/03（依赖其设置 UI 助手体系，
// 不在本移植范围），此处仅保留默认空值契约——本播放器不消费这些 MR 偏好（键名与 MR 相同以避免误读用户旧数据）
function readCustomCoverMap() { try { return JSON.parse(localStorage.getItem('mineradio-custom-covers') || '{}') || {}; } catch { return {}; } }
function readCustomLyricMap() { try { return JSON.parse(localStorage.getItem('mineradio-custom-lyrics-v1') || '{}') || {}; } catch { return {}; } }
function readCustomLyricPrefs() { try { return JSON.parse(localStorage.getItem('mineradio-custom-lyric-prefs-v1') || '{}') || {}; } catch { return {}; } }
function readCustomLyricFonts() { try { return JSON.parse(localStorage.getItem('mineradio-custom-lyric-fonts-v1') || '[]') || []; } catch { return []; } }
function readLocalBeatMapCache() { try { return JSON.parse(localStorage.getItem('mineradio-local-beatmaps-v1') || '{}') || {}; } catch { return {}; } }
function readLocalBeatPrefs() { try { return JSON.parse(localStorage.getItem('mineradio-local-beatmap-prefs-v1') || '{}') || {}; } catch { return {}; } }
function readPlaybackQualityPreference() { return { netease: 'hires', qq: 'lossless', kugou: 'lossless', qishui: 'standard', spotify: 'standard' }; }
function getProviderPlaybackQuality() { return 'lossless'; }
function readAudioOutputDevicePreference() { return ''; }
function readAudioOutputMirrorPreference() { return []; }
function readAudioInputBridgePreference() { return { enabled: false, deviceId: '' }; }
function loadListenStatsState() { return { history: [], songs: {}, artists: {}, updatedAt: 0 }; }
function readSavedLyricLayout() { return {}; }   // bundle 内 04-persistence 的真实现会在加载时覆盖本桩（提升机制）
function readHotkeySettings() { return {}; }     // MR 07-fx/06-hotkeys.js:9；快捷键不移植
// 未移植子系统对应的面板助手桩（依赖歌单架/预设档案/设置 UI 的部分，DOM 不存在即无操作）
function bindHotkeySettings() {}
function bindAudioOutputControls() {}
function buildPresetGrid() {}
function renderUserFxArchives() {}
function liftFxFloatingPopups() {}
function relabelFxPanelControls() {}
function organizeFxPanel() {}
function showToast(msg) { try { console.log('[MR 视觉]', msg); } catch { /* 忽略 */ } }
function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; } // MR 05-playback/00-api-quality-output.js:20 原文
// 以下函数属于未移植子系统（背景媒体/封面粒子/sonic 声波地/Wallpaper Engine/浮窗管理/主循环唤醒），
// bundle 内无定义，按无操作桩补齐——它们在设置链路里只影响未移植层
function repositionFxFloatingPanels() {}
function updateCustomBackgroundControls() {}
// applyControlGlassChromaticOffset/normalizeControlGlassChromaticOffset 空桩已删（B-b：
// bundle vendor 05-playback/15 后由声明提升接管真身；bundle 未加载时无人调用这两个函数）
function applyCoverParticleResolution() {}
function sonicAudioNormalizeFx() {}
function wakeMainLoopFromBackground() {}
function syncWallpaperEngineCaptureFrameRate() { return Promise.resolve(); }
function applyFxPreset() {}
function refreshPresetGrid() {}
// —— 镜头交互链环境补齐（2026-09-19 还原度对齐一期，vendor 01-scene/04 + 09-idle 后按需补）——
// MR 10-shell/02-peek-panels-upload.js:2-3 原值；bundle 02-visual/00:4228 裸引用，缺失即抛
var PEEK_HIDE_DELAY = 170;
var PLAYLIST_PANEL_HIDE_DELAY = 72;
var peekTimers = { search: null, pl: null, fx: null }; // MR 10-shell/02 顶部声明；bundle toggleFxPanel 读 peekTimers.fx
function setPeek(el, on, key) {           // MR 10-shell/02:71 瘦身版（去掉搜索玻璃/歌单架深依赖分支，DSH 无对应 DOM）
  if (!el) return;
  if (on) {
    if (peekTimers[key]) { clearTimeout(peekTimers[key]); peekTimers[key] = null; }
    if (key === 'fx') el.classList.remove('closing');
    el.classList.add('peek');
    if (key === 'fx') {
      var fab = document.getElementById('fx-fab');
      if (fab) fab.classList.add('active');
    }
  } else {
    if (peekTimers[key]) clearTimeout(peekTimers[key]);
    peekTimers[key] = setTimeout(function () {
      el.classList.remove('peek');
      if (key === 'fx') {
        var fabOff = document.getElementById('fx-fab');
        if (fabOff && !el.classList.contains('show')) fabOff.classList.remove('active');
      }
      peekTimers[key] = null;
    }, key === 'pl' ? PLAYLIST_PANEL_HIDE_DELAY : PEEK_HIDE_DELAY);
  }
}
function closeUploadTip(manual) {         // MR 10-shell/02:128 瘦身：#upload-tip 不存在即无操作
  if (manual) { try { localStorage.setItem('mineradio-upload-tip-seen', '1'); } catch (e) { /* 忽略 */ } }
  var tip = document.getElementById('upload-tip');
  if (tip) tip.classList.remove('show');
}
function closeMiniQueue() {               // MR 06-lyrics/01:256；DSH 无迷你队列子系统
  miniQueueOpen = false;
}
function setHomeControlsLocked(locked) {  // MR 05-playback/04-home-empty-wallpaper.js:50 瘦身：#bottom-bar 不存在即无操作
  document.body.classList.toggle('home-controls-locked', !!locked);
}
// —— 拖转 360° 的旋转积分子集（抽自 MR 10-shell/00-gesture-control.js:5-90；2026-09-19 还原度对齐一期）——
// MR 拖动旋转的是视觉组（particles/bloom/float/backCover 的 rotation ← gestureRotation 阻尼跟随 + particleSpin 惯性），
// 不改 orbit.theta。手势/摄像头子系统（:96 起的手部识别、捏合、HUD）不移植，只抽鼠标拖转所需子集。
var particleSpin = { vx: 0, vy: 0, damping: 0.90 };      // MR 00-gesture-control.js:13 原文
var gestureRotation = { x: 0, y: 0 };                    // MR 00-gesture-control.js:15 原文
var PARTICLE_POINTER_SPIN_X = 0.0032;                    // MR 00-gesture-control.js:39-43 原值
var PARTICLE_POINTER_SPIN_Y = 0.0034;
var PARTICLE_SPIN_MAX = 6.2;
function clampParticleSpinVelocity(v) {                  // MR 00-gesture-control.js:45-48 原文
  if (!isFinite(v)) return 0;
  return Math.max(-PARTICLE_SPIN_MAX, Math.min(PARTICLE_SPIN_MAX, v));
}
function applyParticleSpinDrag(dx, dy, dt) {             // MR 00-gesture-control.js:50-59 原文
  var rx = dy * PARTICLE_POINTER_SPIN_X;
  var ry = dx * PARTICLE_POINTER_SPIN_Y;
  gestureRotation.x += rx;
  gestureRotation.y += ry;
  if (dt > 0) {
    particleSpin.vx = clampParticleSpinVelocity(rx / dt * 0.46);
    particleSpin.vy = clampParticleSpinVelocity(ry / dt * 0.46);
  }
}
function resetParticleRotationTarget(syncVisual) {       // MR 00-gesture-control.js:61-72 原文
  gestureRotation.x = 0;
  gestureRotation.y = 0;
  particleSpin.vx = 0;
  particleSpin.vy = 0;
  if (syncVisual && particles) {
    particles.rotation.set(0, 0, 0);
    if (bloomParticles) bloomParticles.rotation.set(0, 0, 0);
    if (floatGroup) floatGroup.rotation.set(0, 0, 0);
    if (backCoverGroup) backCoverGroup.rotation.set(0, 0, 0);
  }
}
function rebaseParticleRotationAxis(axis) {              // MR 00-gesture-control.js:74-85 原文
  var limit = Math.PI * 10;
  if (Math.abs(gestureRotation[axis]) < limit) return;
  var offset = Math.round(gestureRotation[axis] / (Math.PI * 2)) * Math.PI * 2;
  gestureRotation[axis] -= offset;
  if (particles) particles.rotation[axis] -= offset;
  if (bloomParticles) bloomParticles.rotation[axis] -= offset;
  if (floatGroup) floatGroup.rotation[axis] -= offset;
  if (backCoverGroup) backCoverGroup.rotation[axis] -= offset;
  if (skullParticleGroup) skullParticleGroup.rotation[axis] -= offset;
  if (stageLyrics.group) stageLyrics.group.rotation[axis] -= offset;
}
function rebaseParticleRotationIfNeeded() {              // MR 00-gesture-control.js:87-90 原文
  rebaseParticleRotationAxis('x');
  rebaseParticleRotationAxis('y');
}
function tickGestureRotation(dt) {                       // MR 00-gesture-control.js:759-770 瘦身：去掉手势捏合/手部 HUD 段（未移植）
  if (Math.abs(particleSpin.vx) > 0.0001 || Math.abs(particleSpin.vy) > 0.0001) {
    var rx = particleSpin.vx * dt;
    var ry = particleSpin.vy * dt;
    gestureRotation.x += rx;
    gestureRotation.y += ry;
    rebaseParticleRotationIfNeeded();
  }
  particleSpin.vx *= Math.pow(particleSpin.damping, dt * 60);
  particleSpin.vy *= Math.pow(particleSpin.damping, dt * 60);
  if (Math.abs(particleSpin.vx) < 0.01) particleSpin.vx = 0;
  if (Math.abs(particleSpin.vy) < 0.01) particleSpin.vy = 0;
}
function updateUiAccentControls() {} // 界面高亮色（我们有自己的 accent 体系，不接 MR 的）
function updateHomeAccentControls() {}
function updateHomeIconControls() {}
function updateVisualIconControls() {}
function updateIconAccentControls() {}
function updateBgMediaControls() {}
function updateWallpaperEngineControls() {}
function updatePerformanceControls() {}
function updateDesktopLyricsControls() {}
function updateVisualTintControls() {}
function updateBgColorControls() {}
// 封面 URL 助手（05-playback/01-cover-custom-map.js 原样；coverProxySrc 适配：本项目无 /api/cover 代理，
// http(s) 远端封面直接用原 URL——粒子纹理无需 CORS，仅取色读像素走本地封面 dataURL 路径）
function isInlineCoverSrc(src) {
  return typeof src === 'string' && (
    /^data:image\//i.test(src) ||
    /^blob:/i.test(src) ||
    /^mineradio-local:\/\/cover\//i.test(src));
}
function isProxyableCoverUrl(url) { return /^https?:\/\//i.test(String(url || '')); }
function coverProxySrc(url, cacheBust) {
  // 本地流服务器新增 /api/cover 端点（等价 MR server.js 同名能力）；端口从当前音频 src 提取
  if (!isProxyableCoverUrl(url)) return '';
  var m = /127\.0\.0\.1:(\d+)/.exec((window.audio && window.audio.src) || '');
  var port = m ? m[1] : '30000';
  return 'http://127.0.0.1:' + port + '/api/cover?url=' + encodeURIComponent(url) + (cacheBust ? '&v=' + Date.now() : '');
}
function coverUrlWithSize(url, size) { return url || ''; }
function bindColorLabPicker() {} // ColorLab 弹窗（未复制其 HTML），色轮预设网格已由 buildLyricColorControls 构建
function syncFxUniforms() {}     // 封面粒子 uniforms 同步（未移植层）；歌词键直接读 fx，不受影响
function bindColorLabRows() {}   // ColorLab 行绑定（同上，弹窗 HTML 未复制）
function pushDesktopLyricsState() {} // 桌面歌词窗 fx 同步（我们的桌面歌词窗是独立 DOM 实现，不需要此推送）
function normalizePerformanceBackgroundMode(v) { return 'auto'; } // MR 04:57-63；深底模式不移植，恒 auto
function normalizePerformanceQuality(v) {          // MR 04-visual-settings-persistence.js:66-69 原文
  var value = String(v || '');
  return /^(eco|balanced|high|ultra)$/.test(value) ? value : (typeof fxDefaults !== 'undefined' ? fxDefaults.performanceQuality : 'eco');
}
function isNoLyricText(text) {                     // MR 06-lyrics/00-lyrics-fetch-parse.js:365-372 原文
  var compact = String(text || '').replace(/\s+/g, '').replace(/[，,。.!！?？、~～]/g, '');
  return !compact ||
    compact === '纯音乐请欣赏' ||
    compact === '暂无歌词' ||
    compact === '暂无歌词敬请期待' ||
    compact === '此歌曲为没有填词的纯音乐请您欣赏';
}
function normalizeLyricTranslationText(text) {     // MR 06-lyrics/00-lyrics-fetch-parse.js:427-431 原文
  text = normalizeStageLyricText(text);
  if (!text || isNoLyricText(text)) return '';
  return text;
}

// ---------- ②/③ 适配层主体 ----------
var MrStage = {
  booted: false, booting: null, mounted: false, failed: false,
  host: null, container: null, raf: 0, prevTime: 0, lastResizeW: 0, lastResizeH: 0,
  audioEl: null, graphReady: false, graphBoundSrcScheme: '',
  gates: null, bootErrors: [],
};
// 合并脚本执行期错误捕获（parse/exec 错误走 window error 事件，不会进 booting promise）
window.addEventListener('error', function (e) {
  MrStage.bootErrors.push(String((e && e.message) || e) + ' @' + (e && e.filename || '?').split('/').pop() + ':' + (e && e.lineno || '?'));
});

var MR_SCRIPTS = null; // 文件清单移至 scripts/build-mr-bundle.js（生成 mr/mr-bundle.js）

// 关键机制（MR index-loader.js 同款）：所有模块拼成单个脚本执行，跨文件的 function 声明提升，
// 00-core-stores 顶层的 read* 调用才能命中 02-preferences-ui-modes.js 等后置文件的函数。
// 拼接结果预生成为 renderer/mr/mr-bundle.js（scripts/build-mr-bundle.js 生成；改 MR 源文件后重跑）。

// 音频图：照搬 MR 05-playback/08-audio-graph-controls.js initAudio 的结构（双分析器 fft2048，
// smoothing 0.58/0.10，gain→destination）。crossOrigin 按源切换：本地流代理=anonymous（服务端已带
// ACAO:*），本地文件=null（file 同源），其他 http=anonymous（CORS 不通则加载失败走既有换源兜底，
// 避免 CORS 污染导致的静音）。
function mrSyncCrossOrigin() {
  var a = MrStage.audioEl;
  if (!a || !a.src) return;
  var want = a.src.indexOf('file:') === 0 ? null : 'anonymous';
  if ((a.crossOrigin || null) !== want) {
    var t = a.currentTime, playing = !a.paused;
    try {
      if (want === null) a.removeAttribute('crossorigin'); else a.crossOrigin = want;
      var tmp = a.src;
      a.src = ''; a.src = tmp;
      if (t > 0.05) { try { a.currentTime = t; } catch { /* seek 稍后可播 */ } }
      if (playing) { var p = a.play(); if (p && p.catch) p.catch(function () {}); }
    } catch { /* 忽略 */ }
  }
}
function mrEnsureAudioGraph() {
  if (MrStage.graphReady || !MrStage.audioEl) return;
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    mrSyncCrossOrigin();
    audioCtx = new AC();
    source = audioCtx.createMediaElementSource(MrStage.audioEl);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE; analyser.smoothingTimeConstant = 0.58;
    beatAnalyser = audioCtx.createAnalyser();
    beatAnalyser.fftSize = BEAT_FFT_SIZE; beatAnalyser.smoothingTimeConstant = 0.10;
    source.connect(analyser); source.connect(beatAnalyser);
    gainNode = audioCtx.createGain();
    analyser.connect(gainNode); gainNode.connect(audioCtx.destination);
    // beatAnalyser 只读分析，不连 destination（连了会声音加倍；MR 08-audio-graph-controls.js 同样不连）
    MrStage.graphReady = true;
  } catch (e) {
    // 绑定失败（极少见）→ 不重试；舞台照常渲染，uBass/uBeat 恒 0
    MrStage.graphReady = false;
    analyser = null; beatAnalyser = null;
  }
}

// 节拍/频段分析：公式与常量照搬 MR 11-main-loop.js:357-540（帧门控 60fps 同款）
var mrAudioPrev = 0;
var mrSonicAudioFrame = null;   // 音频监视器快照（MR 11-main-loop.js:358 sonicAudioFrame），供电影镜头增强/音域回响预设消费
function mrAnalyzeFrame(now, dt) {
  var stepDt = MrStage.gates ? consumeFrameGate(MrStage.gates.audio, now, dt, 60, false, 'audio-analysis') : dt;
  if (stepDt <= 0) return;
  // MR 11-main-loop.js:358-360 原样：先取上一帧监视器快照（本帧电影镜头增强用），本帧推进见下方 stepSonicAudioMonitor
  var sonicAudioFrame = (fx.sonicAudioMonitorEnabled !== false && typeof getSonicAudioMonitorSnapshot === 'function')
    ? getSonicAudioMonitorSnapshot().frame : null;
  mrSonicAudioFrame = sonicAudioFrame;
  if (analyser && MrStage.audioEl && !MrStage.audioEl.paused) {
    if (audioCtx && audioCtx.state === 'suspended') { audioCtx.resume().catch(function () {}); }
    analyser.getByteFrequencyData(frequencyData);
    analyser.getByteTimeDomainData(timeDomainData);
    var len = frequencyData.length;
    var bKick = 0, mInst = 0, tHigh = 0, voc = 0, rms = 0;
    var rmsCount = 0;
    for (var j = 0; j < timeDomainData.length; j++) {
      var tv = (timeDomainData[j] - 128) / 128;
      rms += tv * tv; rmsCount++;
    }
    rms = Math.sqrt(rms / Math.max(1, rmsCount));
    var analysisSampleRate = (audioCtx && audioCtx.sampleRate) || 44100;
    var analysisFftSize = (analyser && analyser.fftSize) || len * 2;
    if (typeof beatBandRms === 'function') {
      var subKick = beatBandRms(frequencyData, analysisSampleRate, analysisFftSize, 38, 74);
      var kickCore = beatBandRms(frequencyData, analysisSampleRate, analysisFftSize, 52, 165);
      var kickBody = beatBandRms(frequencyData, analysisSampleRate, analysisFftSize, 165, 420);
      bKick = Math.min(1, kickCore * 0.86 + subKick * 0.42 + kickBody * 0.10);
      voc = beatBandRms(frequencyData, analysisSampleRate, analysisFftSize, 420, 2600);
      mInst = beatBandRms(frequencyData, analysisSampleRate, analysisFftSize, 2600, 6200);
      tHigh = beatBandRms(frequencyData, analysisSampleRate, analysisFftSize, 6200, Math.min(16000, analysisSampleRate / 2));
    }
    bassPeak = Math.max(bassPeak * 0.994, bKick, 0.030);
    midPeak = Math.max(midPeak * 0.993, mInst, 0.026);
    treblePeak = Math.max(treblePeak * 0.992, tHigh, 0.018);
    energyPeak = Math.max(energyPeak * 0.995, rms, 0.030);
    var rb = Math.min(1, Math.pow(bKick / Math.max(0.038, bassPeak * 0.66), 0.78));
    var rm = Math.min(1, Math.pow(mInst / Math.max(0.025, midPeak * 0.70), 0.86));
    var rt = Math.min(1, Math.pow(tHigh / Math.max(0.020, treblePeak * 0.74), 0.92));
    var re = Math.min(1, Math.pow(rms / Math.max(0.034, energyPeak * 0.68), 0.82));
    var bassOnset = Math.max(0, rb - smoothBass);
    var energyOnset = Math.max(0, re - prevEnergy);
    prevEnergy = prevEnergy * 0.88 + re * 0.12;
    // 实时节拍引擎 + 节拍相机（照抄 MR 11-main-loop.js:408-453；sonic 分支不涉及）。
    // 此前只走 bassOnset 降级脉冲（beatPulse 上限 0.12，MR 可到 0.76），beatCam 五项 kick 恒 0
    // —— 歌词 beatGlow/溢光位移/星河 uBeat/glitch 等全部"跟鼓点"效果因此大幅弱化（2026-09-19 审计#2）。
    var realtimeBeat = processRealtimeBeatEngine(stepDt);
    if (realtimeBeat && realtimeBeat.hit) {
      var dj = djMode.active;
      var djMapCoversCurrentTime = !dj || !currentDjBeatMap || !currentDjBeatMap.partialUntilSec || !audio || (audio.currentTime || 0) <= currentDjBeatMap.partialUntilSec - 1.25;
      var djBeatMapReadyForCamera = dj && currentDjBeatMap && currentDjBeatMap.cameraBeats && currentDjBeatMap.cameraBeats.length >= 4 && djMapCoversCurrentTime;
      var beatMapReadyForCamera = dj ? djBeatMapReadyForCamera : (currentBeatMap && currentBeatMap.cameraBeats && currentBeatMap.cameraBeats.length >= 4);
      var waitingForBeatMap = dj ? !djBeatMapReadyForCamera : (!beatMapReadyForCamera && (!!beatMapBusy || !!beatAnalysisTimer || ((audio && audio.currentTime) || 0) < 18));
      var liveKickFrame = dj
        ? (realtimeBeat.low > 0.42 && rb > 0.32 && bassOnset > 0.040 && energyOnset > 0.006 && (realtimeBeat.lowDominance || 0) > 0.72)
        : (realtimeBeat.low > 0.42 && rb > 0.34 && bassOnset > 0.048 && energyOnset > 0.008);
      var liveStrongHit = dj
        ? (realtimeBeat.confidence > 0.52 && realtimeBeat.strength > 0.48 && realtimeBeat.score > 0.42 && liveKickFrame)
        : (realtimeBeat.confidence > 0.62 && realtimeBeat.strength > 0.54 && realtimeBeat.score > 0.44 && liveKickFrame);
      var liveTempoHit = dj
        ? (realtimeBeat.tempoAssist && realtimeBeat.confidence > 0.50 && realtimeBeat.strength > 0.46 && realtimeBeat.low > 0.40 && (liveKickFrame || bassOnset > 0.034))
        : (realtimeBeat.tempoAssist && realtimeBeat.confidence > 0.62 && realtimeBeat.strength > 0.50 && realtimeBeat.low > 0.40 && bassOnset > 0.036);
      var liveFallbackOk = dj
        ? (liveStrongHit || liveTempoHit)
        : (waitingForBeatMap
          ? (liveStrongHit || liveTempoHit)
          : (realtimeBeat.confidence > 0.68 && realtimeBeat.strength > 0.62 && realtimeBeat.low > 0.44 && (liveKickFrame || realtimeBeat.score > 0.52)));
      if (!beatMapReadyForCamera && liveFallbackOk) {
        scheduleBeatCamera({
          time: realtimeBeat.time, strength: realtimeBeat.strength, confidence: realtimeBeat.confidence,
          low: realtimeBeat.low, body: realtimeBeat.body, snap: realtimeBeat.snap, mass: realtimeBeat.mass,
          sharpness: realtimeBeat.sharpness, combo: realtimeBeat.combo,
          impact: clamp01(realtimeBeat.strength * 0.46 + realtimeBeat.confidence * 0.20 + realtimeBeat.low * 0.28),
          preview: waitingForBeatMap, primary: true, dj: dj
        }, 'live');
      }
      if (!beatMapReadyForCamera && liveFallbackOk) {
        var previewPulseScale = waitingForBeatMap && !dj ? 0.68 : 1;
        var rtPulse = Math.min(dj ? 0.42 : (waitingForBeatMap ? 0.56 : 0.76), realtimeBeat.strength * (realtimeBeat.tempoAssist ? (dj ? 0.54 : 0.76) : (dj ? 0.62 : 0.84)) * previewPulseScale);
        if (rtPulse > beatPulse + 0.09) beatOnsetFlag = true;
        beatPulse = Math.max(beatPulse, rtPulse);
      }
    } else if (bassOnset > 0.075 && rb > 0.32 && energyOnset > 0.020) {
      beatPulse = Math.max(beatPulse, Math.min(0.12, bassOnset * 0.18));
    }
    beatPulse *= Math.pow(0.36, stepDt);
    // beatmap 补位驱动（MR 11-main-loop.js:455-466 原样）
    tickPodcastDjBeatMap();
    tickBeatMap();
    if (scheduledBeatFlag) { beatOnsetFlag = true; scheduledBeatFlag = false; }
    if (scheduledBeatPulse > beatPulse) beatPulse = scheduledBeatPulse;
    scheduledBeatPulse *= Math.pow(0.32, stepDt);
    // 音频监视器推进（MR 11-main-loop.js:467-477 原样）：本帧快照覆盖开头读到的上一帧值，
    // 供电影镜头增强与音域回响预设消费（审计 B-2 修复；fx.sonicAudioMonitorEnabled 开关自此真实生效）。
    if (typeof stepSonicAudioMonitor === 'function') {
      var sonicMonitorFrame = stepSonicAudioMonitor(frequencyData, stepDt, {
        fx: fx,
        playing: true,
        beat: beatPulse,
        sampleRate: analysisSampleRate,
        fftSize: analysisFftSize,
        currentTime: audio ? (audio.currentTime || 0) : 0
      });
      if (fx.sonicAudioMonitorEnabled !== false) { sonicAudioFrame = sonicMonitorFrame; mrSonicAudioFrame = sonicAudioFrame; }
    }
    function env(prev, next, attack, release) {
      var k = next > prev ? attack : release;
      return prev + (next - prev) * k;
    }
    smoothBass = env(smoothBass, Math.min(0.82, rb * 0.78 + re * 0.025), 0.28, 0.075);
    smoothMid = env(smoothMid, Math.min(0.68, rm * 0.64 + re * 0.025), 0.18, 0.060);
    smoothTreb = env(smoothTreb, Math.min(0.56, rt * 0.54), 0.18, 0.055);
    smoothEnergy = env(smoothEnergy, Math.min(0.72, re), 0.16, 0.055);
    // 电影镜头随音乐动态（照抄 MR 11-main-loop.js:493-505；sonic 增强分支已驱动，见上 stepSonicAudioMonitor）
    // 此前 updateCinemaDynamics/TrackProfile 零调用 → 镜头对副歌/低音无反应（2026-09-19 审计#4）
    var cinemaProfileSample = { energy: re, low: rb, vocal: voc, melody: rm, lowOnset: bassOnset, energyOnset: energyOnset };
    // 电影镜头 sonic 增强（MR 11-main-loop.js:490-503 原样）：subBass/kickFlux/kickOnset/triggerPulse 混入低频/能量样本
    if (sonicAudioFrame && sonicAudioFrame.sonicDetailed) {
      var sonicLowDrive = clamp01((Number(sonicAudioFrame.subBass) || 0) * 0.58
        + (Number(sonicAudioFrame.bass) || 0) * 0.78
        + (Number(sonicAudioFrame.lowMid) || 0) * 0.26
        + (Number(sonicAudioFrame.kickEnvelope) || 0) * 0.24);
      var sonicLowOnset = clampRange((Number(sonicAudioFrame.kickFlux) || 0) * 0.14
        + (Number(sonicAudioFrame.kickOnset) || 0) * 0.065
        + (Number(sonicAudioFrame.triggerPulse) || 0) * 0.085, 0, 0.18);
      var sonicEnergyDrive = clamp01((Number(sonicAudioFrame.energy) || 0) * 0.88 + sonicLowOnset * 0.74);
      cinemaProfileSample.energy = Math.max(cinemaProfileSample.energy, sonicEnergyDrive);
      cinemaProfileSample.low = Math.max(cinemaProfileSample.low, sonicLowDrive);
      cinemaProfileSample.lowOnset = Math.max(cinemaProfileSample.lowOnset, sonicLowOnset);
      cinemaProfileSample.energyOnset = Math.max(cinemaProfileSample.energyOnset, sonicLowOnset * 0.62);
    }
    updateCinemaDynamics(Math.max(re, cinemaProfileSample.energy * 0.92), Math.max(rb, cinemaProfileSample.low * 0.90));
    updateCinemaTrackProfile(cinemaProfileSample);
    // 歌词阳光溢光（MR 11-main-loop.js:507-523 原样）
    var sunEnergy = clamp01((smoothEnergy - 0.18) / 0.38);
    var sunVoice = clamp01((voc - 0.11) / 0.34);
    var sunMelody = clamp01((smoothMid - 0.16) / 0.27);
    var sunAir = clamp01((smoothTreb - 0.105) / 0.17);
    var sunRaw = clamp01(sunEnergy * 0.36 + sunVoice * 0.18 + sunMelody * 0.26 + sunAir * 0.20);
    sunRaw = sunRaw * sunRaw * (3 - 2 * sunRaw);
    lyricSunAvg += (sunRaw - lyricSunAvg) * 0.006;
    lyricSunPeak = Math.max(0.48, lyricSunPeak * 0.9985, sunRaw);
    var sunThreshold = Math.max(0.78, lyricSunAvg + 0.20, lyricSunPeak * 0.74);
    var sunGate = clamp01((sunRaw - sunThreshold) / Math.max(0.08, 1.0 - sunThreshold));
    sunGate = sunGate * sunGate * (3 - 2 * sunGate);
    lyricSunHold += (sunGate - lyricSunHold) * (sunGate > lyricSunHold ? 0.035 : 0.014);
    lyricSunTarget = lyricSunHold > 0.16 ? clamp01((lyricSunHold - 0.16) / 0.84) : 0;
    lyricSunEnergy += (lyricSunTarget - lyricSunEnergy) * (lyricSunTarget > lyricSunEnergy ? 0.075 : 0.030);
  } else {
    var idleDecay = Math.max(1, stepDt * 60); // MR 11-main-loop.js:527-541 停播衰减原样
    if (typeof stepSonicAudioMonitor === 'function') stepSonicAudioMonitor(null, stepDt, { fx: fx, playing: false }); // MR :525 同款：监视器停播衰减
    mrSonicAudioFrame = null;
    smoothBass *= Math.pow(0.91, idleDecay); smoothMid *= Math.pow(0.91, idleDecay);
    smoothTreb *= Math.pow(0.91, idleDecay); smoothEnergy *= Math.pow(0.91, idleDecay);
    beatPulse *= Math.pow(0.82, idleDecay);
    lyricSunTarget = 0;
    lyricSunHold *= Math.pow(0.90, idleDecay);
    lyricSunEnergy *= Math.pow(0.92, idleDecay);
    lyricSunAvg *= Math.pow(0.995, idleDecay);
    lyricSunPeak = Math.max(0.48, lyricSunPeak * Math.pow(0.997, idleDecay));
  }
  audioEnergy = Math.max(smoothEnergy, beatPulse * 0.30);
  bass = Math.min(0.90, smoothBass * 1.05 + beatPulse * 0.18) * fx.intensity;
  mid = Math.min(0.72, smoothMid * 1.12) * fx.intensity;
  treble = Math.min(0.62, smoothTreb * 1.20) * fx.intensity;
  // preset≥4 环形粒子音频公式（照抄 MR 11-main-loop.js:540-563；此前缺失 → 高档预设鼓点/频段响应弱于 MR，盘点 A5）
  if (fx.preset >= 4) {
    var wallpaperAudio = fx.preset === 5;
    var authoredParticles = fx.preset >= 9 && fx.preset <= 12;
    var ringBassGain = wallpaperAudio ? 1.10 : (authoredParticles ? 1.32 : 1.58);
    var ringMidGain = wallpaperAudio ? 1.16 : (authoredParticles ? 1.48 : 1.82);
    var ringTrebleGain = wallpaperAudio ? 1.34 : (authoredParticles ? 1.72 : 2.28);
    var ringBeatGain = wallpaperAudio ? 0.18 : (authoredParticles ? 0.31 : 0.42);
    var ringBass = smoothBass * ringBassGain + beatPulse * ringBeatGain - smoothMid * 0.16 - smoothTreb * 0.06;
    var ringMid = smoothMid * ringMidGain - smoothBass * 0.14 - smoothTreb * 0.07;
    var ringTreble = smoothTreb * ringTrebleGain - smoothMid * 0.10 - smoothBass * 0.05;
    bass = Math.pow(clamp01((ringBass - 0.050) / 0.58), 0.72) * fx.intensity;
    mid = Math.pow(clamp01((ringMid - 0.045) / 0.46), 0.78) * fx.intensity;
    treble = Math.pow(clamp01((ringTreble - 0.030) / 0.34), 0.84) * fx.intensity;
    if (wallpaperAudio) {
      bass = Math.min(bass, 0.46 * fx.intensity);
      mid = Math.min(mid, 0.40 * fx.intensity);
      treble = Math.min(treble, 0.36 * fx.intensity);
      beatPulse *= 0.34;
    } else if (authoredParticles) {
      bass = Math.min(bass, 0.72 * fx.intensity);
      mid = Math.min(mid, 0.62 * fx.intensity);
      treble = Math.min(treble, 0.58 * fx.intensity);
      beatPulse *= 0.72;
    }
  }
  uniforms.uBass.value = bass; uniforms.uMid.value = mid;
  uniforms.uTreble.value = treble; uniforms.uBeat.value = beatPulse;
  uniforms.uEnergy.value = audioEnergy;
}

// 骷髅层帧率目标（MR 11-main-loop.js:222-243,276-282 原样；依赖函数全部在 bundle：
// isRenderInteractionActive/normalizeForegroundFpsMode/estimatedDisplayRefreshHz/runtimePerfScale/isDeepBackgroundMode）
function mrMainLoopInteractionActive(now) {
  return (typeof isRenderInteractionActive === 'function') && isRenderInteractionActive(now);
}
function mrVisibleMotionFollowVsync(now) {
  if (isDeepBackgroundMode()) return false;
  var mode = (typeof normalizeForegroundFpsMode === 'function')
    ? normalizeForegroundFpsMode(fx && fx.foregroundFpsMode)
    : 'vsync';
  if (mode !== 'vsync') return false;
  if (typeof isProgressDragPreviewActive === 'function' && isProgressDragPreviewActive()) return true;
  if (mrMainLoopInteractionActive(now)) return true;
  return !!(playing && window.audio && !window.audio.paused);
}
function mrCapMainLoopFpsForBudget(fps, minFps) {
  var scale = (typeof runtimePerfScale === 'function') ? runtimePerfScale() : 1;
  var target = Math.round((Number(fps) || 60) * scale);
  var hz = (typeof estimatedDisplayRefreshHz === 'function') ? estimatedDisplayRefreshHz() : 60;
  return Math.max(minFps || 1, Math.max(1, Math.min(Number(target) || 60, Math.max(48, hz))));
}
function mrTargetSkullParticleFps(now) {
  if (isDeepBackgroundMode()) return 1;
  if (!fx || fx.preset !== SKULL_PRESET_INDEX) return 10;
  if (mrVisibleMotionFollowVsync(now)) return 0;
  if (mrMainLoopInteractionActive(now)) return mrCapMainLoopFpsForBudget(120, 72);
  return (playing && window.audio && !window.audio.paused) ? mrCapMainLoopFpsForBudget(60, 45) : 24;
}

// ① 首进 loading 显隐：挂载后、当前行层 mesh 未就绪且本曲有歌词 → 显示"正在点亮舞台…"，
// 行层分批构建完成（stageLyrics.current 非空）即自动隐藏。重进因 mesh 保留 current 常在 → 不闪。
function mrStageLoadingTick() {
  var el = document.getElementById('stage3dLoading');
  if (!el) return;
  var hasLyric = (typeof lyricsLines !== 'undefined' && lyricsLines && lyricsLines.length) ||
                 (typeof window !== 'undefined' && window.lyricsLines && window.lyricsLines.length);
  var ready = (typeof stageLyrics !== 'undefined' && stageLyrics && stageLyrics.current);
  el.classList.toggle('show', !!(MrStage.mounted && hasLyric && !ready));
}

// 帧驱动：调用顺序照搬 MR 11-main-loop.js animate()（:617-620 相机、:676-677 舞台歌词、:692 渲染）
function mrFrame(now) {
  MrStage.raf = requestAnimationFrame(mrFrame);
  var dt = Math.min((now - MrStage.prevTime) / 1000, 0.05);
  MrStage.prevTime = now;
  uniforms.uTime.value += dt;
  mrAnalyzeFrame(now, dt);
  // MR 全局契约：playing 标志（00-core-stores 声明），tickLyricsParticles 依赖
  playing = !!(MrStage.audioEl && !MrStage.audioEl.paused && !MrStage.audioEl.ended);
  mrShelfFrame(dt, now); // 3D 歌单架每帧驱动（update 内含节流 rebuild）+ 队列/歌单镜像刷新
  if (typeof maybeTrimRuntimeCaches === 'function') maybeTrimRuntimeCaches(now); // MR 11-main-loop 每帧调用（45s 节流在函数内）；此前零调用 → 歌词层缓存不回收（盘点 A4）
  // 以下照搬 11-main-loop.js:575-600 的视觉每帧段
  updateParticlePointerFrame();
  // 歌单架/内容盒鼠标视差阻尼（MR 11-main-loop.js:346-347 原样；此前无人推进 → pointerParallax 恒 0，审计 B-5）
  pointerParallax.x += (pointerTarget.x - pointerParallax.x) * 0.040;
  pointerParallax.y += (pointerTarget.y - pointerParallax.y) * 0.040;
  // 鼠标斥力 uniform（MR 11-main-loop.js:583-584 原样；此前缺失 → preset 0 的粒子鼠标互动层死亡，审计#3）
  uniforms.uMouseXY.value.set(mouseWorld.x, mouseWorld.y);
  uniforms.uMouseActive.value = mouseActive ? 1 : 0;
  uniforms.uVinylSpin.value = (uniforms.uVinylSpin.value + dt * (0.40 + smoothBass * 0.09) * (isFinite(fx.speed) ? Math.max(0.05, fx.speed) : 1)) % (Math.PI * 2);
  uniforms.uBurstAmt.value *= 0.90;
  if (typeof tickPresetTransition === 'function') tickPresetTransition(); // MR 11-main-loop.js:593 同款
  if (typeof updateBackgroundStarRiverState === 'function') updateBackgroundStarRiverState(dt, false);
  updateRipples(dt);
  updateFloatLayer(dt);
  updateCinema(dt); updateFreeCamera(dt); updateCamera();
  if (typeof applySkullCameraPose === 'function') applySkullCameraPose(dt);
  // 旋转 = 鼠标/手势拖动 + 惯性（照搬 MR 11-main-loop.js:623-647；headParallax 未移植则视作 0）
  tickGestureRotation(dt);
  var targetRotY = orbit.centerLocked ? 0 : (typeof headParallax !== 'undefined' && headParallax.active ? headParallax.x * 0.5 : 0) + gestureRotation.y;
  var targetRotX = orbit.centerLocked ? 0 : (typeof headParallax !== 'undefined' && headParallax.active ? -headParallax.y * 0.35 : 0) + gestureRotation.x;
  particles.rotation.y += (targetRotY - particles.rotation.y) * 0.055;
  particles.rotation.x += (targetRotX - particles.rotation.x) * 0.055;
  if (bloomParticles) bloomParticles.rotation.copy(particles.rotation);
  if (floatGroup) floatGroup.rotation.copy(particles.rotation);
  if (backCoverGroup) backCoverGroup.rotation.copy(particles.rotation);
  // 可见性段（照搬 MR 11-main-loop.js:623-632 原文；B-4：skull 门随骷髅闭环真实生效，
  // workshop 分支 MR 原文 window.MineradioSonicWorkshop && 守卫——B-a 2026-09-20 vendor 工坊后真实生效）
  var skullPresetActive = fx && fx.preset === SKULL_PRESET_INDEX;
  var workshopPresetActive = window.MineradioSonicWorkshop && MineradioSonicWorkshop.isActive(fx);
  var starRiverMutedNow = fx && (Number(fx.preset) === 5 || (typeof SONIC_PRESET_INDEX !== 'undefined' && Number(fx.preset) === SONIC_PRESET_INDEX)) && fx.backgroundStarRiver === false;
  particles.visible = !skullPresetActive && !workshopPresetActive && !starRiverMutedNow;
  if (bloomParticles) bloomParticles.visible = !skullPresetActive && !workshopPresetActive && !starRiverMutedNow && fx.bloom && fx.bloomStrength > 0.01;
  if (floatGroup) floatGroup.visible = !skullPresetActive && !workshopPresetActive;
  if (backCoverGroup) backCoverGroup.visible = !skullPresetActive && !workshopPresetActive;
  if (typeof uParticleDimEase === 'function') uParticleDimEase(dt); // 歌单架打开时背景粒子压暗（MR :587-590，盘点 A5）
  // 骷髅粒子层每帧驱动（MR 11-main-loop.js:647-650 原样 + 门控辅助 :222-282；B-4 骷髅闭环：
  // 安魂预设卡=preset 6，vendor 02-visual/01 自带完整实现，此前缺驱动与点云资产 → 半开漏坏状态）
  var mrSkullDt = MrStage.gates ? consumeFrameGate(MrStage.gates.skull, now, dt, mrTargetSkullParticleFps(now), false, 'skull-particles') : (fx && fx.preset === SKULL_PRESET_INDEX ? dt : 0);
  if (mrSkullDt > 0 && typeof updateSkullParticleLayer === 'function') updateSkullParticleLayer(mrSkullDt);
  // 音域回响（preset 7）每帧驱动（MR 11-main-loop.js:651-663 原样；此前零调用 → 预设卡"音域回响"空壳，审计 B-3）
  if (window.MineradioSonicTopography) {
    MineradioSonicTopography.update(dt, {
      scene: scene,
      fx: fx,
      time: uniforms.uTime.value,
      screenHeight: window.innerHeight,
      dpr: renderer.getPixelRatio ? renderer.getPixelRatio() : (window.devicePixelRatio || 1),
      visualRotation: particles && particles.rotation ? particles.rotation : null,
      visualRotationActive: !!(orbit && orbit.rotating),
      audio: mrSonicAudioFrame || { bass: bass, mid: mid, treble: treble, beat: beatPulse, energy: audioEnergy }
    });
  }
  // 音域回响·WE 工坊（preset 8）每帧驱动（MR 11-main-loop.js:666-673 原样；B-a 2026-09-20：
  // vendor sonic-workshop-preset.js 后 window.MineradioSonicWorkshop 就位，上方可见性段的
  // workshopPresetActive 守卫自此真实生效——工坊层激活时粒子组隐藏，与 MR 同语义）
  if (window.MineradioSonicWorkshop) {
    MineradioSonicWorkshop.update(dt, {
      scene: scene,
      fx: fx,
      time: uniforms.uTime.value,
      audio: { bass: bass, mid: mid, treble: treble, beat: beatPulse, energy: audioEnergy }
    });
  }
  var stepDt = MrStage.gates ? consumeFrameGate(MrStage.gates.stageLyrics, now, dt, playing ? 0 : 24 /* MR 播放时 vsync 全速（审计#5）；0=门控放行 */, false, 'stage-lyrics') : dt;
  if (stepDt > 0) updateStageLyrics3D(stepDt);
  mrStageLoadingTick(); // ① 首进行层就绪前显示"正在点亮舞台…"
  if (MrStage.gates) {
    var lyrDt = consumeFrameGate(MrStage.gates.lyrics, now, dt, playing ? 0 : 24, false, 'lyrics-particles');
    if (lyrDt > 0 && typeof tickLyricsParticles === 'function') tickLyricsParticles(); // MR 11-main-loop.js:608 同款驱动
  }
  renderer.render(scene, camera);
}

function mrResize() {
  if (!MrStage.mounted || !renderer) return;
  var w = MrStage.host.clientWidth, h = MrStage.host.clientHeight;
  if (!w || !h || (w === MrStage.lastResizeW && h === MrStage.lastResizeH)) return;
  MrStage.lastResizeW = w; MrStage.lastResizeH = h;
  renderer.setSize(w, h, false); // CSS 已 100%，只改绘制缓冲
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---------- 对外 API（供 app.js 调用） ----------

// 数据桥：我们的 lrc/逐字轴 → MR 全局 lyricsLines（契约见 14:2594-2647：
// line {t, text, translation, duration, words:[{c0,c1,t,d}], charCount}）
function lyricFallbackTextForSong(song) {      // MR 06-lyrics/00-lyrics-fetch-parse.js:258-266 适配版
  song = song || {};                           // （DSH 读 #pTitle/#pArtist；此函数缺失曾致前奏期每帧
  var title = String(song.name || song.title || '').trim(); // ReferenceError → 渲染掉到 ~15fps，审计#1 崩溃级）
  var artist = String(song.artist || '').trim();
  if (!title) { var tEl = document.getElementById('pTitle'); if (tEl) title = String(tEl.textContent || '').trim(); }
  if (!artist) { var aEl = document.getElementById('pArtist'); if (aEl) artist = String(aEl.textContent || '').trim(); }
  if (!title || title === '未播放') return '';
  return artist ? title + ' - ' + artist : title;
}
function mrLrcPayloadKey(lrc, wordSegs, translated) {
  // ①（2026-09-20 差异清单）同歌词短路键：行数+总字数+首尾行文本+逐字/翻译行数。
  // 重进舞台时 app.js 会用同一份 state.lrc 再调 setLrc，键相同 → 保留已建好的行层 mesh，秒显不再重建。
  var arr = Array.isArray(lrc) ? lrc : null;
  if (!arr || !arr.length) return '';
  var n = arr.length, chars = 0;
  for (var i = 0; i < n; i++) chars += String((arr[i] || {}).text || '').length;
  var f = String((arr[0] || {}).text || '').slice(0, 24);
  var l = String((arr[n - 1] || {}).text || '').slice(0, 24);
  return n + ':' + chars + ':' + f + ':' + l +
    (Array.isArray(wordSegs) ? ':w' + wordSegs.length : '') +
    (Array.isArray(translated) ? ':t' + translated.length : '');
}
function mrSetLrc(lrc, wordSegs, translated) {
  if (!MrStage.booted) { // 挂载前调用（歌词先于舞台就绪）→ 缓存，boot/mount 时回放
    MrStage.pendingLrc = [lrc, wordSegs, translated];
    return 0;
  }
  // ① 同歌词且已有行层 → 短路（重进舞台秒显；换歌 payload 必变，照常走失效重建链）
  var payloadKey = mrLrcPayloadKey(lrc, wordSegs, translated);
  if (payloadKey && payloadKey === MrStage.lastLrcKey &&
      typeof stageLyrics !== 'undefined' && stageLyrics && stageLyrics.current) {
    return (window.lyricsLines || []).length;
  }
  var lines = [];
  var arr = Array.isArray(lrc) ? lrc : [];
  for (var i = 0; i < arr.length; i++) {
    var src = arr[i] || {};
    var raw = String(src.text || '');
    var text = raw.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    var next = arr[i + 1];
    var line = { t: Number(src.t) || 0, text: text, charCount: text.length };
    line.duration = next ? Math.max(0.35, (Number(next.t) || 0) - line.t) : 4.8;
    if (translated && translated[i] && String(translated[i]).trim()) line.translation = String(translated[i]).trim();
    // 逐字轴：找 ±250ms 内的段（与 app.js currentLineWords 同匹配规则），换算成 MR words 契约
    var seg = null, bestD = 0.25;
    if (Array.isArray(wordSegs)) {
      for (var w = 0; w < wordSegs.length; w++) {
        var d = Math.abs((Number(wordSegs[w].t) || 0) - line.t);
        if (d < bestD) { bestD = d; seg = wordSegs[w]; }
      }
    }
    if (seg && Array.isArray(seg.chars) && seg.chars.length) {
      var words = [], ok = true, np = 0; // np=归一化文本游标
      for (var c = 0; c < seg.chars.length && ok; c++) {
        var ch = String(seg.chars[c].ch == null ? '' : seg.chars[c].ch);
        var t0 = Math.max(Number(seg.chars[c].t) || line.t, line.t);
        var t1 = c + 1 < seg.chars.length ? Math.max(Number(seg.chars[c + 1].t) || t0, t0) : line.t + line.duration;
        var c0 = np;
        var chSrc = (c === 0 && np === 0) ? ch.replace(/^\s+/, '') : ch; // 修复：酷我英文行首 token 带前导空格（'<0,300> hello'）→ 归一化文本无前导空格 → 整行 words 静默丢失（T-KARAOKE Bug#1）
        for (var k = 0; k < chSrc.length; k++) { // 消费归一化文本（空格串折叠为一个 ' '）
          if (np >= text.length && /\s/.test(chSrc[k])) continue; // 尾 token 尾部空白超出文本末尾：跳过不判失败
          if (np < text.length && text[np] === chSrc[k]) np++;
          else if (/\s/.test(chSrc[k]) && np < text.length && text[np] === ' ') np++;
          else if (chSrc[k] === ' ' && np < text.length && text[np] === ' ') np++;
          else { ok = false; break; }
        }
        if (!ok) break;
        words.push({ c0: c0, c1: np, t: t0, d: Math.max(0.08, t1 - t0) });
      }
      if (ok && words.length && np === text.length) { line.words = words; }
    }
    lines.push(line);
  }
  lines = lines.filter(function (line) { return line && String(line.text || '').trim(); });
  lines = lines.filter(function (line) { return !isNoLyricText(line.text); }); // MR withLyricFallbackForSong 原语义（06-lyrics/00:265）：剔除"纯音乐请欣赏"类占位行
  if (!lines.length) {
    // 无词/纯音乐兜底行（MR 06-lyrics/00:262-276 原语义；歌名歌手取自底部播放条）
    var fallbackText = lyricFallbackTextForSong(null);
    if (fallbackText) lines = [{ t: 0, text: fallbackText, duration: 9999, charCount: Math.max(1, fallbackText.length), fallback: true }];
  }
  window.lyricsLines = lines;          // MR 模块按全局名逐次查找，直接整体替换即可
  lyricsHasNativeKaraoke = lines.some(function (l) { return l.words && l.words.length; });
  // 原词状态填充（盘点 A2 收口）：bundle 的 applyOriginalLyricState 从 originalLyricsState 取数据，
  // 此前 mrSetLrc 只写 lyricsLines → 「原词」切换拿到空态。timingSource 按 words/兜底行推定（best-effort）
  if (typeof originalLyricsState !== 'undefined') {
    originalLyricsState.lines = lines;
    originalLyricsState.hasNativeKaraoke = lyricsHasNativeKaraoke;
    originalLyricsState.timingSource = lyricsHasNativeKaraoke ? 'yrc-word' : (lines.length === 1 && lines[0].fallback ? 'fallback' : 'lrc-line');
    originalLyricsState.translationLines = Array.isArray(translated) ? translated : [];
    originalLyricsState.translationSource = Array.isArray(translated) && translated.length ? 'lrc' : 'none';
  }
  // Bug#2（T-KARAOKE）：满扫色的活 mesh 先释放再置空（镜像 mrUnmount 的 dispose 语义）——
  // 否则 setLrc 时 current 被直接置 null → uProgress=1 的幽灵 mesh 脱离 rowLayers 管辖永久泄漏
  try {
    if (typeof stageLyrics !== 'undefined') {
      if (stageLyrics.current && typeof disposeLyricMesh === 'function') { disposeLyricMesh(stageLyrics.current); }
      for (var og = 0; og < stageLyrics.outgoing.length; og++) { if (typeof disposeLyricMesh === 'function') disposeLyricMesh(stageLyrics.outgoing[og]); }
      stageLyrics.outgoing.length = 0;
    }
  } catch (e) { /* 释放幂等 */ }
  if (typeof stageLyrics !== 'undefined') { stageLyrics.currentIdx = -1; stageLyrics.currentText = ''; stageLyrics.current = null; stageLyrics.currentPayload = null; stageLyrics.currentDisplayKey = ''; }
  // 换歌失效 + 预热（照抄 MR 06-lyrics/00:636-660 renderLyrics 原语义）。此前整段缺失：
  // invalidateStageLyricPayloadForNewLyrics 零调用 → stageLyricTrackCache 里旧歌行层不销毁，
  // 新旧歌词同时画在舞台上 = 用户实测"多首歌的歌词叠在一起"（2026-09-19 运行时实锤）
  var renderSignature = typeof stageLyricRenderSignatureForCurrentState === 'function' ? stageLyricRenderSignatureForCurrentState() : '';
  if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') invalidateStageLyricPayloadForNewLyrics('renderLyrics');
  if (typeof stageLyrics !== 'undefined' && stageLyrics && renderSignature) stageLyrics.renderSignature = renderSignature;
  if (typeof requestStageLyricWarmup === 'function') requestStageLyricWarmup('lyrics-ready', 900);
  if (typeof scheduleStageLyricPrewarm === 'function') scheduleStageLyricPrewarm('lyrics-ready', 32);
  if (typeof scheduleStageLyricSingleLineBootstrapPrewarm === 'function') scheduleStageLyricSingleLineBootstrapPrewarm('lyrics-ready', 44);
  if (typeof scheduleStageLyricFullTrackWarmup === 'function') scheduleStageLyricFullTrackWarmup('lyrics-ready-preload', 24);
  MrStage.lastLrcKey = payloadKey;
  return lines.length;
}

// 封面取色桥：封面图 → 96px canvas → MR 07 updateLyricPaletteFromCover（原函数）
// coverSrc 缺省时读播放条封面 #pCoverImg（updatePlayingUI 维护，在线/本地同源）
function mrRefreshPalette(coverSrc) {
  if (!bootedGuard() || typeof updateLyricPaletteFromCover !== 'function') return;
  var src = coverSrc || (document.getElementById('pCoverImg') || {}).src;
  if (!src) return;
  // 双通道：封面粒子管线（MR 03-beat/05 原函数）+ 歌词取色（MR 07 原函数）
  try {
    if (typeof loadCoverFromUrl === 'function') loadCoverFromUrl(src, { deferHeavy: true, timeout: 1700 });
    if (typeof applyCoverDataUrl === 'function' && src.indexOf('data:') === 0) applyCoverDataUrl(src, { deferHeavy: true });
  } catch { /* 粒子封面失败不影响歌词 */ }
  var img = new Image();
  img.onload = function () {
    try {
      var cv = document.createElement('canvas');
      cv.width = 96; cv.height = 96;
      cv.getContext('2d').drawImage(img, 0, 0, 96, 96);
      updateLyricPaletteFromCover(cv);
    } catch { /* 取色失败用默认色 */ }
  };
  img.src = src;
}
function bootedGuard() { return MrStage.booted; }

// ===== bundle 启动（2026-09-20 ①提速）：boot 与 mount 解耦。
// 旧行为：点进 3D 才开始注入 2.4MB bundle + 求值（数百 ms）→ 首进慢的主段之一。
// 新行为：mrPreboot 在页面空闲时于隐藏容器完成 boot（WebGL renderer/全局状态机就位），
// 用户点进舞台只剩 mesh 搬移 + 行层构建。mrMount await mrBoot()，先到先复用。
function mrBoot() {
  if (MrStage.booted) return Promise.resolve();
  if (MrStage.booting) return MrStage.booting;
  // 溢光默认升级迁移（2026-09-20 用户拍板 0.28→0.8）：fx 自动存档会覆盖 fxDefaults，
  // 老用户存档里存的就是旧默认 0.28 → 在 bundle 注入前把"恰好等于旧默认（=从未手动调过）"
  // 的值升到新默认；用户手动调过的其它值原样保留。必须在 bundle 求值前执行（读档在加载时）。
  // 两个存档键都要扫：autosave 缺失时 bundle 回退读 lyric-layout（bundle:7161）。
  try {
    ['mineradio-current-fx-autosave-v1', 'mineradio-lyric-layout-v1'].forEach(function (key) {
      var raw = localStorage.getItem(key);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && Number(o.lyricGlowStrength) === 0.28) {
        o.lyricGlowStrength = 0.8;
        localStorage.setItem(key, JSON.stringify(o));
      }
    });
  } catch (e) { /* 存档异常不拦启动 */ }
  // 容器必须在 00-renderer-quality 注入执行前就位（它在加载时 getElementById('canvas-container')）；
  // 预启动阶段先挂 body 外屏隐藏位，mount 时搬进 host。
  if (!MrStage.container) {
    MrStage.container = document.createElement('div');
    MrStage.container.id = 'canvas-container';
    MrStage.container.style.cssText = 'position:fixed;left:-32000px;top:0;width:4px;height:4px;overflow:hidden;pointer-events:none;';
    document.body.appendChild(MrStage.container);
  }
  MrStage.booting = new Promise(function (resolve, reject) {
    // CSP 纪律：index.html 是 default-src 'self'，禁止内联 script（合并文本用 .text 注入会被
    // 静默拦截——首测踩坑）。改为懒加载预拼接的真实 bundle 文件（机制与 MR 单合并脚本等价：
    // 单文件内函数提升跨段可用），'self' 放行。
    var s = document.createElement('script');
    s.src = new URL('mr/mr-bundle.js', location.href).href;
    MrStage.bootErrors.length = 0;
    s.onload = function () {
      if (MrStage.bootErrors.length) { reject(new Error('MR_BUNDLE_EXEC: ' + MrStage.bootErrors.slice(0, 3).join(' | '))); return; }
      MrStage.booted = true;
      // B-b：控制玻璃初始化（MR 原调用点在未 vendor 的 10-shell/05-startup-bindings.js:7；
      // bundle 函数此刻已就位。内部对 DSH 缺失 DOM 全有 if(el) 守卫，安全）
      try { initControlGlassSurface(); } catch (e) { console.warn('[MR 玻璃] initControlGlassSurface:', e && e.message); }
      // DSH 适配覆盖（2026-09-20 D-1/B-4 批次）：10-shell/04 入 bundle 后，其顶层 MR 原版
      // function getDesktopWindowApi（isDesktop 门控，见 10-shell/04:89 与 ref desktop/preload.js:4）
      // 会覆盖本文件的适配定义。原版门控面向 MR 桌面嵌入窗模式；DSH 主窗的 window.api =
      // 预加载桥（WE 17 项 + dsh-cache-* + dialog），导入 JSON（P1-1 实测项）与 WE 抽屉 probe
      // 都依赖它非空返回。10-shell/04 自身 WE 路径均有 typeof 方法守卫（缺 setWallpaperMode 时
      // 安全返回错误对象、fx.wallpaperMode 归 false），不受此覆盖影响。
      window.getDesktopWindowApi = function () { return window.api || null; };
      // 工作台 + 全部 fx 控件绑定（二期 3d；此前 bindFxPanel 无人调用 → fx 滑杆全为死控件）。
      // bundle 内函数此时已就位；个别控件缺失不应中断其余绑定，故 try/catch 兜底。
      // 2026-09-20：boot/mount 解耦后绑定提前到此处；设 fxBound 防 mrMount 二次绑定。
      try { if (typeof bindFxPanel === 'function') { bindFxPanel(); MrStage.fxBound = true; } } catch (e) { console.warn('[MR 视觉] bindFxPanel 部分失败:', e && e.message); }
      // 控制台 1:1 复刻 MR（2026-09-20 用户拍板）：DSH 无"简约/DIY"双模式概念（3D 舞台本身就是 DIY），
      // 置 diyPlayerMode=true 打开 toggleFxPanel 的 DIY 门；body.diy-mode 类在 DSH CSS 无副作用。
      try { if (typeof applyDiyMode === 'function') applyDiyMode(true, { save: false }); } catch (e) { console.warn('[MR 控制台] applyDiyMode:', e && e.message); }
      try { mrBindFxPeek(); } catch (e) { console.warn('[MR 控制台] peek 绑定失败:', e && e.message); }
      if (MrStage.pendingLrc) { var pl = MrStage.pendingLrc; MrStage.pendingLrc = null; mrSetLrc(pl[0], pl[1], pl[2]); }
      resolve();
    };
    s.onerror = function () { reject(new Error('MR_BUNDLE_LOAD_FAILED')); };
    document.head.appendChild(s);
  }).catch(function (e) {
    // 脚本没加载成功（file:// 下罕见）→ 允许 mount 时重试一次；
    // 脚本执行抛错（MR_BUNDLE_EXEC）→ 置 failed，不重跑 bundle（顶层监听器会重复绑定）
    if (/MR_BUNDLE_LOAD_FAILED/.test(String(e && e.message || e))) { MrStage.booting = null; }
    else { MrStage.failed = true; MrStage.lastError = String(e && e.message || e); }
    throw e;
  });
  return MrStage.booting;
}

// ① 空闲预启动：页面加载后延迟起 bundle（避开首屏渲染/登录检查），失败静默——
// 用户点进舞台时 mrMount→mrBoot 会再走一次真启动路径。
function mrPreboot() {
  if (MrStage.booted || MrStage.booting || MrStage.failed) return;
  try {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(function () { mrBoot().catch(function () { /* mount 时重试 */ }); }, { timeout: 8000 });
    } else {
      setTimeout(function () { mrBoot().catch(function () { }); }, 4000);
    }
  } catch (e) { /* 预启动尽力而为 */ }
}

// 控制台悬停 peek（MR 10-shell/02-peek-panels-upload.js:421-433 语义 1:1：右下角 fab 触发，
// 面板出现后按真实矩形+桥接区保留；移开 → setPeek(false) 170ms 自动收——这就是 MR 的"退出"方式，
// MR 面板本无关闭按钮）。DSH 未 vendor 02 文件，此处在适配层按原文复刻 fx 段。
function mrBindFxPeek() {
  if (MrStage.fxPeekBound) return;
  MrStage.fxPeekBound = true;
  var fab = document.getElementById('fx-fab');
  if (fab) fab.addEventListener('click', function () { if (typeof toggleFxPanel === 'function') toggleFxPanel(); });
  document.addEventListener('mousemove', function (e) {
    var fp = document.getElementById('fx-panel');
    if (!fp || typeof setPeek !== 'function' || typeof diyPlayerMode === 'undefined' || !diyPlayerMode) return;
    var ex = e.clientX, ey = e.clientY, W = innerWidth, H = innerHeight;
    var fpOn = fp.classList.contains('peek') || fp.classList.contains('show');
    var fpRect = fp.getBoundingClientRect();
    var fabEl = document.getElementById('fx-fab');
    var fabRect = fabEl ? fabEl.getBoundingClientRect() : { left: W, right: W, top: H, bottom: H };
    var inFxPanel = fpOn && ex >= fpRect.left - 24 && ex <= fpRect.right + 24 && ey >= fpRect.top - 24 && ey <= fpRect.bottom + 24;
    var inFxFab = ex >= fabRect.left - 18 && ex <= fabRect.right + 18 && ey >= fabRect.top - 18 && ey <= fabRect.bottom + 18;
    var inFxBridge = fpOn && ex >= Math.min(fpRect.left, fabRect.left) - 18 && ex <= W && ey >= fpRect.bottom - 10 && ey <= fabRect.bottom + 18;
    if (inFxFab || inFxPanel || inFxBridge) setPeek(fp, true, 'fx');
    else if (fpOn) setPeek(fp, false, 'fx');
  }, { passive: true });
}

async function mrMount(host) {
  MrStage.host = host;
  await mrBoot();
  if (MrStage.failed) throw new Error('MR_BOOT_FAILED');
  // 容器从预启动隐藏位搬进舞台 host（幂等：已在 host 则跳过）
  if (MrStage.container && MrStage.container.parentNode !== host) {
    host.appendChild(MrStage.container);
    MrStage.container.style.cssText = 'position:absolute;inset:0;';
  }
  if (!MrStage.gates && typeof createFrameGate === 'function') {
    MrStage.gates = {
      audio: createFrameGate('main.audio', 60),
      stageLyrics: createFrameGate('main.stageLyrics', 45),
      lyrics: createFrameGate('main.lyricsParticles', 45),
      skull: createFrameGate('main.skullParticles', 24), // MR 11:268 mainFrameGates.skullParticles（B-4 骷髅每帧驱动用）
    };
  }
  dotTexture = dotTexture || makeDotTexture();
  uniforms.uPixel.value = renderer.getPixelRatio();
  // fx 出厂即舞台形态；星河用户开关默认关（MR 04:93），这里按移植范围打开（星河属于歌词舞台效果的一部分）
  fx.lyricGlowParticles = true;
  // 全窗口沉浸式=MR 原生形态，相机锁定/lockFit 关（MR 出厂默认），歌词按 MR 全屏布局呈现
  fx.lyricCameraLock = false;
  // 歌词组根节点：MR 由封面粒子模块创建，这里由适配层直接创建（vendored 03-lyrics-star-river.js 同款函数）
  if (typeof createLyricsParticles === 'function' && stageLyrics && !stageLyrics.group) createLyricsParticles();
  // MR 视觉控制台绑定（DIY）：[id, fxKey] 滑条映射 + 分段按钮 + 歌词色轮，均为此前 vendor 的原函数
  if (typeof bindFxPanel === 'function' && !MrStage.fxBound) {
    try {
      bindFxPanel();
      if (typeof updateFxInputs === 'function') updateFxInputs(); // MR 滑条初值同步（05-fx-panel-performance.js:223）
      MrStage.fxBound = true;
    } catch (e) {
      MrStage.lastError = 'MR_FX_BIND: ' + String(e && e.message || e);
      console.error('[mr-adapter]', MrStage.lastError);
    }
  }
  mrEnsureAudioGraph(); // 双分析器（fft2048, smoothing 0.58/0.10）→ bass/beat 驱动星河与溢光
  mrBindBeatHooks(); // B-1：离线节拍分析链钩子（bundle 此刻已就位，beatMapToken 等可安全引用）
  mrResize();
  mrShelfActivate(); // 3D 歌单架：喂数据 + 激活（幂等；MR 里由 10-shell 启动链负责，此处适配层接管）
  mrShelfBindPointer(); // 补 MR 未 vendor 的 hover 揭示接线（点击/滚轮/键盘由 vendored 05/06 自带）
  if (!MrStage.raf) { MrStage.prevTime = performance.now(); MrStage.raf = requestAnimationFrame(mrFrame); }
  MrStage.mounted = true;
}

function mrUnmount() {
  MrStage.mounted = false;
  if (MrStage.raf) { cancelAnimationFrame(MrStage.raf); MrStage.raf = 0; }
  // ①（2026-09-20 差异清单）：退出舞台=暂停帧循环，**保留歌词行层 mesh 与 WebGL 上下文**。
  // 旧实现每次 unmount 都 disposeLyricMesh/disposeLyricStarRiver → 重进行层从零分批重建
  // （8 行实测 1.3s，整轨更多），正是用户"每次进 3D 都要卡好一会才有歌词"的根因；
  // 配合 mrSetLrc 同歌词短路，重进秒回。换歌时 mrSetLrc 全路径自带旧 mesh dispose（T-KARAOKE Bug#2
  // 语义在 setLrc 链里，不依赖 unmount 释放），无泄漏。
  // 星河保留（dispose 成本高、重建同样分批慢）；内存换体验，关窗即全释放。
}

// ---------- ④ 3D 歌单架数据桥（深空折韵：把 MR shelf 的消费契约接到本播放器 __mp/state） ----------
// MR shelf（04-shelf）原样 vendor 进 bundle，但它消费的一批"数据/播放"全局函数属于未移植的
// MR 播放/歌词模块（05-playback、06-lyrics、08-account 等）。这些函数在本 bundle 内只有调用、没有定义，
// 点击卡片/打开歌单/播放会在 shelf 里 ReferenceError。此段按 MR 的函数签名与返回结构，把它们接到
// 深空折韵的真实数据源（window.__mp.state：playlists 本地歌单 / onlinePlaylists 导入在线歌单 / songs 曲库）。
// 条目内部 id 约定：'pl:'+本地歌单id / 'opl:'+在线歌单id；provider 统一 'mineradio'
// （→ shelf 生成 playlistId='mineradio:pl:xxx'，open()/播放回流到 builtInPlaylistTracksPage / loadPlaylistIntoQueueById）。

function mrShelfState() {
  var mp = window.__mp;
  return (mp && mp.state) || null;
}
// 按条目内部 id（'pl:'/'opl:'）取回 DSH 真实歌曲对象数组（顺序稳定，playList/startSong 依赖原始字段）
function mrShelfSongs(entryId) {
  var s = mrShelfState();
  if (!s) return [];
  entryId = String(entryId || '');
  if (entryId.indexOf('opl:') === 0) {
    var ref = entryId.slice(4);
    var op = (s.onlinePlaylists || []).find(function (p) { return String(p.id) === ref; });
    return op ? (op.songs || []).filter(Boolean) : [];
  }
  if (entryId.indexOf('pl:') === 0) {
    var lid = entryId.slice(3);
    var lp = (s.playlists || []).find(function (p) { return String(p.id) === lid; });
    if (!lp) return [];
    return (lp.songIds || []).map(function (e) {
      return typeof e === 'string' ? (s.songs || []).find(function (x) { return x.id === e; }) : e;
    }).filter(Boolean);
  }
  return [];
}
// 歌曲对象 → shelf 展示用最小字段（name/artist/cover/id；本地歌封面异步取、此处留空由占位兜底）
function mrShelfTrackView(song) {
  return {
    id: song.id,
    name: song.title || song.name || '',
    artist: song.artist || (song.artists && String(song.artists)) || '',
    cover: song.picUrl || song.cover || '',
  };
}

// shelf 每帧/节流消费：刷新 userPlaylists（bundle 顶层已声明的 var，此处只填内容不重复声明）
function mrShelfRefreshPlaylists() {
  var s = mrShelfState();
  if (!s) return;
  var list = [];
  (s.playlists || []).forEach(function (pl) {
    if (!pl || !pl.id) return;
    var cnt = (pl.songIds || []).length;
    if (!cnt) return;
    var cover = pl.cover || '';
    list.push({ id: 'pl:' + pl.id, name: pl.name || '歌单', cover: cover, trackCount: cnt, provider: 'mineradio', subscribed: false, shelfPane: 'mine' });
  });
  (s.onlinePlaylists || []).forEach(function (pl) {
    if (!pl || pl.id == null) return;
    var songs = (pl.songs || []).filter(Boolean);
    if (!songs.length) return;
    var cover = pl.cover || '';
    if (!cover) { var firstCov = songs.find(function (x) { return x && x.picUrl; }); if (firstCov) cover = firstCov.picUrl; }
    list.push({ id: 'opl:' + pl.id, name: pl.name || '在线歌单', cover: cover, trackCount: songs.length, provider: 'mineradio', subscribed: false, shelfPane: pl.fav ? 'fav' : 'mine' });
  });
  userPlaylists = list;
  if (typeof playlistCatalogRevision !== 'undefined') playlistCatalogRevision += 1; // 触发 shelf pane 缓存失效
}

// shelf 激活：进入 3D 舞台时喂数据 + 打开歌单架（off→stage 兜底），挂载后调一次、之后定时刷新
var mrShelfActivated = false;
function mrShelfActivate() {
  try {
    mrShelfRefreshPlaylists();
    if (typeof fx !== 'undefined' && fx && fx.shelf === 'off') fx.shelf = 'stage'; // 舞台默认露出歌单架（MR 出厂 side 需右缘悬停，沉浸式里不直观）
    if (typeof shelfManager !== 'undefined' && shelfManager && typeof setShelfMode === 'function') {
      setShelfMode((fx && fx.shelf) || 'stage', { user: false });
      if (shelfManager.rebuild) shelfManager.rebuild(true);
    }
    mrShelfActivated = true;
  } catch (e) {
    console.warn('[mr-adapter] shelf activate failed:', e && e.message || e);
  }
}

// ---- 以下为 bundle 内 shelf 调用、但原属未 vendor 模块、由适配层补齐的全局函数 ----

function hasAnyPlatformLogin() { return true; } // DSH 无 MR 平台登录态；true 使 sig()/currentItems() 统一走歌单分支（播客集合恒空无副作用）
function builtInPlaylistApiAvailable() { return !!(window.__mp && window.__mp.state); }

function isTypingTarget(target) {
  try {
    if (!target) return false;
    var t = String(target.tagName || '').toUpperCase();
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || target.isContentEditable === true;
  } catch (_) { return false; }
}

function playShelfSelectTick() {} // MR 选中卡片音效（依赖其 UI sfx 音频图，未移植）——无操作，不影响交互

// 歌词无词回退文本（MR 06-lyrics/00:362 原文照抄；lyricFallbackTextForSong/currentLyricSong 已在 bundle 内定义）
function currentLyricFallbackText() {
  return lyricFallbackTextForSong(currentLyricSong() || {});
}

// fx 面板 WE 行按钮（7b22ce2 随 MR 面板 HTML 复制进来，onclick 指向 MR 未 vendor 的
// 07-fx/03-wallpaper-engine-library.js 抽屉 UI）。主进程能力本次已就绪（06c8ce1），
// 壁纸库抽屉 UI 未搬——此处先接成明确提示，避免点击静默 ReferenceError。
function openWallpaperEngineLibrary() {
  if (typeof showToast === 'function') showToast('Wallpaper Engine 壁纸库界面即将上线（主进程集成已就绪）');
}
function deactivateWallpaperEngineBackground() {}
function setWallpaperEngineVisualSetting() {}

function queueItemKey(song) {
  if (!song) return '';
  if (song.id != null && song.id !== '') return 'song:' + song.id;
  return String(song.name || song.title || '') + '|' + String(song.artist || '');
}

// shelf 内部读封面（原属 05-playback/01-cover-custom-map.js）：本地歌无即时 URL，返回在线直链或空
function songCoverSrc(song, size) {
  if (!song) return '';
  return String(song.cover || song.picUrl || song.customCover || '');
}
function hydrateCustomCover(song) { return song; } // 无自定义封面映射体系，原样返回

// contentList 打开某歌单时拉首批曲目（bundle: 03-content-list-manager open()/loadMore）。
// DSH 歌单曲目全量已在内存，一次给完、hasMore=false。
async function builtInPlaylistTracksPage(id, options) {
  var songs = mrShelfSongs(id);
  var tracks = songs.map(mrShelfTrackView);
  return {
    ok: true,
    playlist: { trackCount: tracks.length },
    tracks: tracks,
    total: tracks.length,
    nextOffset: tracks.length,
    hasMore: false,
  };
}

// 卡片/行点击 → 播放。id 形如 'mineradio:pl:xxx' / 'mineradio:opl:xxx'。
// 用 DSH 真实歌曲对象调 playList（保留 online/source/ref/path 等字段，播放链路完整），
// 忽略 shelf 传来的 seedTracks（那是展示字段快照，缺播放所需字段）。
async function loadPlaylistIntoQueueById(id, autoplay, title, opts) {
  opts = opts || {};
  var entryId = String(id || '');
  if (entryId.indexOf('mineradio:') === 0) entryId = entryId.slice(10);
  var mp = window.__mp;
  if (!mp || typeof mp.playList !== 'function') { if (typeof showToast === 'function') showToast('播放内核未就绪'); return false; }
  var s = mrShelfState();
  if (!s) return false;
  // row 播放：startIndex 索引在"可播放曲目"序列里；DSH 歌单曲目均可播放，直接用同一顺序的真实列表
  var realSongs = mrShelfSongs(entryId);
  if (!realSongs.length) { if (typeof showToast === 'function') showToast('歌单为空'); return false; }
  var start = Number(opts.startIndex);
  if (!Number.isFinite(start) || start < 0) start = 0;
  start = Math.min(realSongs.length - 1, Math.round(start));
  try {
    await mp.playList(realSongs.slice(), start, 0, autoplay !== false, true);
    if (typeof showToast === 'function') showToast('已在 3D 舞台播放：' + (title || '歌单'));
    return true;
  } catch (e) {
    console.warn('[mr-adapter] loadPlaylistIntoQueueById failed:', e && e.message || e);
    if (typeof showToast === 'function') showToast('歌单播放失败');
    return false;
  }
}

// shelf queue 分支/卡片 playQueue 动作：跳到当前队列某曲播放
async function playQueueAt(idx) {
  var mp = window.__mp;
  var s = mrShelfState();
  if (!mp || !s || typeof mp.playList !== 'function') return false;
  var q = (s.queue || []).slice();
  if (!q.length) return false;
  var i = Number(idx);
  if (!Number.isFinite(i) || i < 0) i = 0;
  i = Math.min(q.length - 1, Math.round(i));
  try { await mp.playList(q, i, 0, true, true); return true; } catch (e) { return false; }
}

// ===== B-1 离线节拍分析链接线（2026-09-20；bundle vendor 03-beat/00-tempo-worker-cache-prefetch） =====
// bundle 里 analyzeAudioBeats/beat-map-runtime 消费但从未 vendor 的依赖在此补齐（原属未 vendor 的
// 03-beat/03 本地节拍模态与 05-playback 播放链）。函数声明提升：本文件在 bundle 前加载，bundle 内
// 对 showBeatChip 等的裸调用按名解析到这些定义。

// 节拍 chip（MR 03-beat/03:1-7 原文的 DOM 桩化：DSH 无 #beat-chip 节点 → console 日志留痕，
// 「D盘节拍缓存命中」等关键事件因此对 CDP 断言可见）
function showBeatChip(text) { console.log('[MR 节拍] chip: ' + (text || '分析节奏…')); }
function hideBeatChip() {}

// 磁盘缓存编解码（MR 03-beat/03-local-beat-cache-modal.js:11-65 纯函数整段原样照抄；
// LOCAL_BEAT_COMBOS 在 bundle 00-core-stores:158 已 vendor）
function localBeatRound(v, scale) {
  v = Number(v);
  if (!isFinite(v)) return 0;
  scale = scale || 1000;
  return Math.round(v * scale) / scale;
}
function packLocalBeatEvent(ev) {
  if (typeof ev === 'number') return [localBeatRound(ev, 1000), 0.42, 0.72, 0.42, 0.62, 0.22, 0.16, 0, 7, 0.62, 0.12, 0];
  ev = ev || {};
  var comboIdx = Math.max(0, LOCAL_BEAT_COMBOS.indexOf(ev.combo || ''));
  var flags = 0;
  if (ev.primary !== false) flags |= 1;
  if (ev.camera !== false) flags |= 2;
  if (ev.pulse !== false) flags |= 4;
  if (ev.dj) flags |= 8;
  if (ev.grid) flags |= 16;
  if (ev.kickOnly) flags |= 32;
  return [
    localBeatRound(ev.time, 1000),
    localBeatRound(ev.strength == null ? 0.42 : ev.strength, 1000),
    localBeatRound(ev.confidence == null ? 0.72 : ev.confidence, 1000),
    localBeatRound(ev.impact == null ? (ev.strength == null ? 0.42 : ev.strength) : ev.impact, 1000),
    localBeatRound(ev.low == null ? 0.62 : ev.low, 1000),
    localBeatRound(ev.body == null ? 0.22 : ev.body, 1000),
    localBeatRound(ev.snap == null ? 0.16 : ev.snap, 1000),
    comboIdx,
    flags,
    localBeatRound(ev.mass == null ? 0.62 : ev.mass, 1000),
    localBeatRound(ev.sharpness == null ? 0.12 : ev.sharpness, 1000),
    localBeatRound(ev.step || 0, 1000)
  ];
}
function unpackLocalBeatEvent(row) {
  if (typeof row === 'number') return row;
  if (!Array.isArray(row)) return row;
  var flags = row[8] || 0;
  return {
    time: row[0] || 0,
    strength: row[1] == null ? 0.42 : row[1],
    confidence: row[2] == null ? 0.72 : row[2],
    impact: row[3] == null ? (row[1] || 0.42) : row[3],
    low: row[4] == null ? 0.62 : row[4],
    body: row[5] == null ? 0.22 : row[5],
    snap: row[6] == null ? 0.16 : row[6],
    combo: LOCAL_BEAT_COMBOS[row[7] || 0] || undefined,
    primary: !!(flags & 1),
    camera: !!(flags & 2),
    pulse: !!(flags & 4),
    dj: !!(flags & 8),
    grid: !!(flags & 16),
    kickOnly: !!(flags & 32),
    mass: row[9] == null ? 0.62 : row[9],
    sharpness: row[10] == null ? 0.12 : row[10],
    step: row[11] || 0
  };
}
function packLocalBeatMap(map) {
  if (!map) return null;
  var camera = (map.cameraBeats || map.beats || map.kicks || []).map(packLocalBeatEvent);
  var pulse = (map.pulseBeats || map.kicks || []).map(packLocalBeatEvent);
  return {
    v: 1,
    duration: localBeatRound(map.duration || 0, 1000),
    gridStep: localBeatRound(map.gridStep || 0, 1000),
    sectionSteps: (map.sectionSteps || []).map(function (v) { return localBeatRound(v, 1000); }),
    tempoSource: map.tempoSource || 'local',
    visualBeatCount: map.visualBeatCount || camera.length,
    analyzedAt: map.analyzedAt || Date.now(),
    partial: !!map.partial,
    partialUntilSec: map.partialUntilSec || 0,
    cameraBeats: camera,
    pulseBeats: pulse
  };
}
function unpackLocalBeatMap(stored) {
  if (!stored) return null;
  if (stored.v && stored.v !== 1 && stored.v !== 2) return stored;
  var camera = (stored.cameraBeats || []).map(unpackLocalBeatEvent);
  var pulse = (stored.pulseBeats || []).map(unpackLocalBeatEvent);
  return {
    kicks: camera.map(function (b) { return typeof b === 'number' ? b : b.time; }),
    beats: camera,
    pulseBeats: pulse,
    cameraBeats: camera,
    gridStep: stored.gridStep || 0,
    sectionSteps: stored.sectionSteps || [],
    tempoSource: stored.tempoSource || 'local',
    duration: stored.duration || 0,
    visualBeatCount: stored.visualBeatCount || camera.length,
    analyzedAt: stored.analyzedAt || Date.now(),
    partial: !!stored.partial,
    partialUntilSec: stored.partialUntilSec || 0
  };
}

// 音源/供应商助手（MR 05-playback/07-search.js:439-445 原文；07-search 不移植，但 00 的
// beatMapSongKey/prefetch 依赖它。DSH song.source ∈ netease/qq/kugou/qishui/bodian/bilibili/本地无；
// bodian/bilibili 未列入 MR 分支 → 归入默认分支（netease）语义：'song:'+id 稳定 key）
function songProviderKey(song) {
  if (song && (song.provider === 'spotify' || song.source === 'spotify' || song.type === 'spotify' || song.spotifyId || song.spotifyUri)) return 'spotify';
  if (song && (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq')) return 'qq';
  if (song && (song.provider === 'qishui' || song.source === 'qishui' || song.type === 'qishui')) return 'qishui';
  if (song && (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou' || song.hash || song.audioHash)) return 'kugou';
  return 'netease';
}
function normalizePlaybackQualityForProvider(value) { return String(value || 'hires'); }
function getPlaybackQualityForSong() { return 'lossless'; }
function hasProviderSvip() { return false; }
function playbackQualityCapValue() { return 'lossless'; }
function playbackQualityAboveCap() { return false; }

// MR 05-playback/00-api-quality-output.js:2-19 原文照抄（vendor 审计实锤缺口：bundle 00 调用但无定义）。
// DSH 适配 1 处：相对路径 '/api/...' 改指本地流服务器（http://127.0.0.1:<port>，端口提取照 coverProxySrc 模式）
function dshStreamApiBase() {
  var m = /127\.0\.0\.1:(\d+)/.exec((window.audio && window.audio.src) || '');
  return 'http://127.0.0.1:' + (m ? m[1] : '30000');
}
async function apiJson(url, opts) {
  opts = opts || {};
  var timeoutMs = Number(opts.timeoutMs) || 0;
  var fetchOpts = Object.assign({}, opts);
  delete fetchOpts.timeoutMs;
  if (typeof url === 'string' && url.charAt(0) === '/') url = dshStreamApiBase() + url; // [DSH 适配] file:// 页面相对路径无 origin
  var timer = null;
  if (timeoutMs && window.AbortController && !fetchOpts.signal) {
    var controller = new AbortController();
    fetchOpts.signal = controller.signal;
    timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  }
  try {
    var res = await fetch(url, fetchOpts);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// —— 分析触发接线（MR 在 05-playback/13 切歌链直调；DSH 播放链在 app.js IIFE 内不可见 →
// 适配层监听 audio 事件等价接线。playing 时 audio.src/dataset.songId 必已就绪，事件驱动零轮询）——
var mrBeatHookSongId = null;
function mrCurrentSongForBeat() {
  var st = window.__mp && window.__mp.state;
  if (!st) return null;
  var id = MrStage.audioEl && MrStage.audioEl.dataset ? MrStage.audioEl.dataset.songId : null;
  if (id == null || id === '') return null;
  var q = st.queue || [];
  for (var i = 0; i < q.length; i++) {
    if (q[i] && String(q[i].id) === String(id)) return q[i]; // 返回真实对象（含 source/ref/hash，beatMapSongKey 依赖）
  }
  return null;
}
function mrOnAudioPlaying() {
  if (typeof beatMapToken === 'undefined' || !MrStage.booted) return; // bundle 未载/舞台未挂 → 不驱动
  var a = MrStage.audioEl;
  if (!a || !a.src) return;
  var song = mrCurrentSongForBeat();
  if (!song) return;
  var key = (typeof beatMapSongKey === 'function' ? beatMapSongKey(song) : '') || ('song:' + song.id);
  if (mrBeatHookSongId === key && !a.seeking) return; // 同一首歌连续 playing 事件不重复分析
  var isNewSong = mrBeatHookSongId !== key;
  mrBeatHookSongId = key;
  if (isNewSong) {
    // MR 13:956/1346 语义：换歌失效旧 map + bump token（旧分析结果不得污染新歌）
    currentBeatMap = null;
    beatMapNextIdx = 0;
    if (typeof resetAudioVisualState === 'function') resetAudioVisualState();
    if (typeof resetBeatCameraSync === 'function') resetBeatCameraSync(a.currentTime || 0);
    beatMapToken++;
    var tok = beatMapToken;
    // 内存缓存命中（回到分析过的老歌）→ 直接应用（MR 13:1346 diskBeatMap 分支等价；
    // scheduleBeatAnalysis 自身对 beatMapCache[key] 存在时静默退出、不负责应用）
    var cachedMap = typeof beatMapCache !== 'undefined' ? beatMapCache[key] : null;
    if (cachedMap) {
      if (typeof applyBeatMapCacheForCurrent === 'function') applyBeatMapCacheForCurrent(key, cachedMap, tok, '内存节拍缓存命中:');
    } else {
      scheduleBeatAnalysis(key, a.src, tok, song);
    }
  } else {
    // 同曲 seek/暂停恢复：MR 13:1346 同款游标对齐（beatMap 消费游标跳到当前播放点）
    if (currentBeatMap && typeof syncBeatMapPlaybackCursor === 'function') syncBeatMapPlaybackCursor(a.currentTime || 0);
  }
}
function mrBindBeatHooks() { // 一次性绑到当前 audio 元素（mrMount boot 成功后 + DOMContentLoaded 兜底各调一次，幂等）
  var a = MrStage.audioEl;
  if (!a) return;
  if (a.__mrBeatBound) return;
  a.__mrBeatBound = true;
  a.addEventListener('playing', mrOnAudioPlaying);
  a.addEventListener('seeked', function () { // 手动 seek：token 保持（同一首歌不换 map）只对齐游标
    if (typeof beatMapToken === 'undefined' || !MrStage.booted || !currentBeatMap) return;
    if (typeof syncBeatMapPlaybackCursor === 'function') syncBeatMapPlaybackCursor(a.currentTime || 0);
  });
}
document.addEventListener('DOMContentLoaded', function () { mrBindBeatHooks(); });
// music-tempo 预载（2026-09-20 烟测：'self' 放行 script 标签；worker 路径用同目录文件独立加载）
(function preloadMusicTempo() {
  try {
    if (document.getElementById('mr-music-tempo-script')) return;
    var s = document.createElement('script');
    s.id = 'mr-music-tempo-script';
    s.src = new URL('mr/vendor/music-tempo.min.js', location.href).href;
    document.head.appendChild(s);
  } catch (e) { /* 加载失败时 bundle 内 ensureMusicTempo 动态兜底（同文件 fetch+间接 eval，烟测实测放行） */ }
})();

// ===== B-b 控制玻璃 SVG filter 注入（2026-09-20；MR index.html:1211-1301 原文搬运） =====
// 色差滑条（fx-glassaberration）与 style.css 已重抽的 SVG 玻璃增强层（:root --saved-*-glass-svg-filter
// + html.control-glass-svg-ok 规则族）都引用 #mineradio-control-glass-filter——此前 DSH 只抽 CSS 未注 SVG 本体。
// CSP 纪律：注入标记不带 style=""（定位需求由 style.css 追加的 .control-glass-filter-svg 规则承担）。
(function injectControlGlassSvg() {
  try {
    if (document.getElementById('control-glass-svg')) return;
    var holder = document.createElement('div');
    holder.innerHTML =
      '<svg id="control-glass-svg" class="control-glass-filter-svg" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><defs>' +
        '<filter id="mineradio-control-glass-filter" color-interpolation-filters="sRGB" x="-12%" y="-28%" width="124%" height="156%">' +
          '<feImage id="control-glass-map" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map"></feImage>' +
          '<feDisplacementMap in="SourceGraphic" in2="map" scale="180" xChannelSelector="R" yChannelSelector="B" result="dispRed"></feDisplacementMap>' +
          '<feOffset in="dispRed" dx="-90" dy="0" result="dispRedShifted"></feOffset>' +
          '<feMerge result="dispRedAligned"><feMergeNode in="SourceGraphic"></feMergeNode><feMergeNode in="dispRedShifted"></feMergeNode></feMerge>' +
          '<feColorMatrix in="dispRedAligned" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red"></feColorMatrix>' +
          '<feDisplacementMap in="SourceGraphic" in2="map" scale="170" xChannelSelector="R" yChannelSelector="B" result="dispGreen"></feDisplacementMap>' +
          '<feOffset in="dispGreen" dx="-90" dy="0" result="dispGreenShifted"></feOffset>' +
          '<feMerge result="dispGreenAligned"><feMergeNode in="SourceGraphic"></feMergeNode><feMergeNode in="dispGreenShifted"></feMergeNode></feMerge>' +
          '<feColorMatrix in="dispGreenAligned" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green"></feColorMatrix>' +
          '<feDisplacementMap in="SourceGraphic" in2="map" scale="160" xChannelSelector="R" yChannelSelector="B" result="dispBlue"></feDisplacementMap>' +
          '<feOffset in="dispBlue" dx="-90" dy="0" result="dispBlueShifted"></feOffset>' +
          '<feMerge result="dispBlueAligned"><feMergeNode in="SourceGraphic"></feMergeNode><feMergeNode in="dispBlueShifted"></feMergeNode></feMerge>' +
          '<feColorMatrix in="dispBlueAligned" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue"></feColorMatrix>' +
          '<feBlend in="red" in2="green" mode="screen" result="rg"></feBlend>' +
          '<feBlend in="rg" in2="blue" mode="screen" result="output"></feBlend>' +
          '<feGaussianBlur in="output" stdDeviation="0.5"></feGaussianBlur>' +
        '</filter>' +
      '</defs></svg>';
    // 顶层 body 直下（MR 同位）；.control-glass-filter-svg 绝对定位零尺寸，不影响布局
    document.body ? document.body.insertBefore(holder.firstElementChild, document.body.firstChild)
      : document.addEventListener('DOMContentLoaded', function () { document.body.insertBefore(holder.firstElementChild, document.body.firstChild); });
  } catch (e) {
    console.warn('[mr-adapter] 控制玻璃 SVG 注入失败:', e && e.message || e);
  }
})();

// shelf 悬停揭示 + hover 高亮驱动（原 MR 在 10-shell/02 用 window.mousemove 接线，未 vendor）。
// 点击/wheel/键盘监听 05-card-interactions/06-keyboard 已自带；此处仅补 hover 视觉。
var mrShelfPointerBound = false;
function mrShelfBindPointer() {
  if (mrShelfPointerBound) return;
  mrShelfPointerBound = true;
  window.addEventListener('mousemove', function (e) {
    if (!MrStage.mounted) return;
    try {
      if (typeof updateShelfHoverCueFromPointer === 'function') updateShelfHoverCueFromPointer(e);
      if (typeof updateShelfCardHoverSelection === 'function') updateShelfCardHoverSelection(e);
    } catch (_) { /* hover 视觉失败不影响点击 */ }
  }, { passive: true });
}

// 每帧驱动 shelf（bundle 的 shelfManager.update 内含 0.8s 节流 rebuild + 二级内容框 update），
// 并镜像播放队列到 playQueue/currentIdx（未 vendor 的 05-playback 原本喂这两个全局）。
// 歌单增删低频：每 3s 刷一次 userPlaylists（新增/删除歌单会改签名触发 rebuild）。
var mrShelfLastPlRefresh = 0;
function mrShelfFrame(dt, now) {
  try {
    if (typeof shelfManager === 'undefined' || !shelfManager || !shelfManager.update) return;
    var s = mrShelfState();
    if (s) {
      currentIdx = Number(s.queueIndex);
      if (!Number.isFinite(currentIdx)) currentIdx = -1;
      if (now - mrShelfLastPlRefresh > 3000) { // 歌单/队列镜像低频刷新（避免每帧 map 分配）
        mrShelfLastPlRefresh = now;
        mrShelfRefreshPlaylists();
        playQueue = (s.queue || []).map(mrShelfTrackView); // 覆盖 bundle 顶层 var playQueue
      }
    }
    shelfManager.update(dt);
  } catch (e) {
    if (!MrStage._shelfWarned) { MrStage._shelfWarned = true; console.warn('[mr-adapter] shelf frame:', e && e.message || e); }
  }
}

// 兼容一期接口名：app.js 的 syncStage3d 只用 mount/unmount/active/failed/resetFailed/markFailed/resize
window.LyricStage3D = {
  mount: mrMount,
  unmount: mrUnmount,
  setLrc: mrSetLrc,
  refreshPalette: mrRefreshPalette,
  setAudio: function (el) { MrStage.audioEl = el; window.audio = el; try { mrBindBeatHooks(); } catch (e) { /* B-1 钩子绑定失败不影响舞台 */ } },
  reveal: function () { // MR 05-playback/13:1152 同款：进入舞台时粒子渐入 + 封面装载
    if (typeof tweenParticleAlpha === 'function') tweenParticleAlpha(uniforms.uAlpha.value || 0, 1.0, 220);
    var img = document.getElementById('pCoverImg');
    if (img && img.src && typeof loadCoverFromUrl === 'function') loadCoverFromUrl(img.src, { deferHeavy: true });
  },
  active: function () { return MrStage.booted && MrStage.mounted; },
  failed: function () { return MrStage.failed; },
  markFailed: function () { MrStage.failed = true; },
  resetFailed: function () { MrStage.failed = false; },
  resize: mrResize,
  update: function () {}, // 一期遗留：3D 现自驱帧循环，无需外部喂数据
  show: function () {}, hide: function () {},
};

// ===== 缓存存储设置环境桥（二期 3a；MR 07-fx/08 模块引用 window.desktopWindow，本项目并入 window.api）=====
// 追加块（协调者协议：适配层只允许追加，不改既有行）。bundle 未加载时赋值也安全：模块在 bundle 内，加载后即用。
window.desktopWindow = window.desktopWindow || window.api;

// ===== 自定义封面键（三期 3e 前置；MR 05-playback/01-cover-custom-map.js:48-63 原文）=====
// bundle 06-lyrics 的 songCustomLyricKey 裸调此函数（bindFxPanel 激活后触发）；
// 所在模块不整文件 vendor（其 coverProxySrc/songCoverSrc 为 MR 同源相对路径实现，会破坏 DSH 封面代理适配）。
function songCustomCoverKey(song) {
  if (!song) return '';
  if (song.customCoverKey) return String(song.customCoverKey);
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
  if (song.provider === 'qishui' || song.source === 'qishui' || song.type === 'qishui') return 'qishui:' + (song.id || song.providerSongId || (song.name + '|' + song.artist));
  if (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou' || song.hash || song.audioHash) return 'kugou:' + (song.hash || song.fileHash || song.audioHash || song.id || (song.name + '|' + song.artist));
  if (song.localKey) return 'local:' + song.localKey;
  if (song.type === 'podcast' && song.programId) return 'podcast:' + song.programId;
  if (song.id != null && song.id !== '') return 'id:' + song.id;
  var title = String(song.name || song.title || '').trim();
  var artist = String(song.artist || '').trim();
  return (title || artist) ? ('meta:' + (title + '|' + artist).slice(0, 220)) : '';
}

// ===== WE 抽屉环境补齐（三期 3e）=====
// MR 07-fx/03-wallpaper-engine-library.js 已 vendor 进 renderer/mr/07-fx/（待协调者加入
// scripts/build-mr-bundle.js 清单并重建 bundle）。该模块在 MR 里依赖 index.html 静态 DOM；
// 深空折韵 index.html 只复制了 fx 面板 WE 行（值/恢复按钮/4 个调节滑杆），缺背景层与抽屉模态。
// 此处在 bundle 加载前按 MR index.html 原文注入等价节点——bundle 顶层 initializeWallpaperEngineLibrary()
// 载入即执行 bindWallpaperEngineLibraryEvents()，#wallpaper-engine-grid 缺席会导致卡片事件永不绑定，DOM 必须先就位。
// CSP 纪律：script-src 含 'unsafe-inline' → 注入标记里的 onclick/oninput 可用；style-src 'self' →
// 注入标记一律不带 style=""（层叠变量由模块经 CSSOM layer.style.setProperty 写入，不受限）。
(function injectWallpaperEngineDom() {
  try {
    // 1) 背景层 + 玻璃采样器（MR index.html:66-73 原文）。挂进 #stage3dOverlay 首部：
    //    overlay 自带不透明渐变底、z-index:220 形成独立层叠上下文；层放 overlay 内首个子元素，
    //    画序 = 渐变底 < WE 壁纸层 < #stage3dHost(3D canvas) < #mrFxDrawer(z-index:2)，与 MR 原生同序
    //    （MR: custom-bg < wallpaper-engine-layer < canvas-container < UI）。挂 body 直下会被
    //    #stage3dOverlay（z220 不透明）整体盖住，故 overlay 内部是唯一等价位置。
    if (!document.getElementById('wallpaper-engine-layer')) {
      var stageOverlay = document.getElementById('stage3dOverlay') || document.body;
      var bgLayers = document.createElement('div');
      bgLayers.innerHTML =
        '<div id="wallpaper-engine-layer" aria-hidden="true">' +
          '<img id="wallpaper-engine-image" alt="">' +
          '<canvas id="wallpaper-engine-freeze" aria-hidden="true"></canvas>' +
          '<video id="wallpaper-engine-video" muted loop playsinline preload="metadata"></video>' +
        '</div>' +
        '<div id="wallpaper-engine-glass-sampler" aria-hidden="true">' +
          '<video id="wallpaper-engine-glass-sampler-video" muted playsinline preload="none"></video>' +
        '</div>';
      var weLayer = bgLayers.firstElementChild;
      var weSampler = bgLayers.lastElementChild;
      stageOverlay.insertBefore(weLayer, stageOverlay.firstChild);
      stageOverlay.insertBefore(weSampler, weLayer.nextSibling);
    }
    // 2) 抽屉模态（MR index.html:1700-1742 原文，含详情抽屉；挂 body 尾部与 MR 同位）
    if (!document.getElementById('wallpaper-engine-modal')) {
      var modalWrap = document.createElement('div');
      modalWrap.innerHTML =
        '<div id="wallpaper-engine-modal" class="modal-mask" role="dialog" aria-modal="true" aria-labelledby="wallpaper-engine-modal-title" onclick="if(event.target===this)closeWallpaperEngineLibrary()">' +
          '<div class="modal wallpaper-engine-library-modal">' +
            '<div class="wallpaper-engine-library-head">' +
              '<div>' +
                '<div class="wallpaper-engine-kicker">LOCAL WALLPAPER LIBRARY</div>' +
                '<h2 id="wallpaper-engine-modal-title">Wallpaper Engine 壁纸导入</h2>' +
                '<p>只建立本地索引，不复制大型项目；Video 直接播放，Scene 项目与有效 PKGV 场景包由本机 Wallpaper Engine 原生引擎实时运行。</p>' +
              '</div>' +
              '<button class="wallpaper-engine-close" type="button" onclick="closeWallpaperEngineLibrary()" aria-label="关闭">×</button>' +
            '</div>' +
            '<div class="wallpaper-engine-toolbar">' +
              '<input id="wallpaper-engine-search" type="search" placeholder="搜索壁纸名称" autocomplete="off" oninput="scheduleWallpaperEngineLibraryRender()">' +
              '<button class="fx-mini-btn ghost" type="button" onclick="chooseWallpaperEngineProjectFile()">导入项目 / 场景包</button>' +
              '<button class="fx-mini-btn ghost" type="button" onclick="chooseWallpaperEngineDirectory()">导入目录</button>' +
              '<button class="fx-mini-btn ghost" type="button" onclick="refreshWallpaperEngineLibrary()">刷新识别</button>' +
              '<button class="fx-mini-btn ghost" type="button" onclick="restoreHiddenWallpaperEngineItems()">恢复隐藏</button>' +
            '</div>' +
            '<div id="wallpaper-engine-library-status" class="wallpaper-engine-library-status">等待识别本机 Wallpaper Engine 库</div>' +
            '<div id="wallpaper-engine-manual-roots" class="wallpaper-engine-manual-roots"></div>' +
            '<div id="wallpaper-engine-grid" class="wallpaper-engine-grid" aria-live="polite"></div>' +
            '<div id="wallpaper-engine-details-drawer" class="wallpaper-engine-details-drawer" aria-hidden="true" onclick="if(event.target===this)closeWallpaperEngineProjectDetails()">' +
              '<section class="wallpaper-engine-details-panel" aria-labelledby="wallpaper-engine-details-title">' +
                '<div class="wallpaper-engine-details-head">' +
                  '<div>' +
                    '<div class="wallpaper-engine-kicker">PROJECT PROPERTIES</div>' +
                    '<h3 id="wallpaper-engine-details-title">项目设置</h3>' +
                  '</div>' +
                  '<button class="wallpaper-engine-close" type="button" onclick="closeWallpaperEngineProjectDetails()" aria-label="关闭项目设置">×</button>' +
                '</div>' +
                '<p id="wallpaper-engine-details-summary" class="wallpaper-engine-details-summary"></p>' +
                '<div id="wallpaper-engine-details-properties" class="wallpaper-engine-details-properties"></div>' +
                '<div class="wallpaper-engine-details-actions">' +
                  '<button id="wallpaper-engine-details-we" class="fx-mini-btn" type="button" onclick="launchWallpaperEngineProjectDetails(\'we\')">在 WE 中打开设置（实验）</button>' +
                  '<button id="wallpaper-engine-details-workshop" class="fx-mini-btn ghost" type="button" onclick="launchWallpaperEngineProjectDetails(\'workshop\')">创意工坊详情</button>' +
                '</div>' +
                '<small class="wallpaper-engine-details-note">每次载入自动应用静音值（音量 0 / 静音开启 / 音频关闭）；Scene 包只处理缓存副本，原文件不变。其他视觉设置仍由 Wallpaper Engine 管理。</small>' +
              '</section>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modalWrap.firstElementChild);
    }
  } catch (e) {
    console.warn('[mr-adapter] WE 抽屉 DOM 注入失败:', e && e.message || e);
  }
})();

// 三空桩真身化：适配层中部 810-814 行的占位实现（不动既有行）在此重赋值覆盖。此处实现只为
// 「bundle 尚未加载」的窗口期兜底（fx 工作台在 3D 舞台内，正常路径 bundle 必已就位）；bundle 载入时
// 03-wallpaper-engine-library.js 的同名 function 声明会按提升机制再次覆盖本赋值，真身以 bundle 为准。
openWallpaperEngineLibrary = function () {
  if (typeof showToast === 'function') showToast('Wallpaper Engine 抽屉正在载入，请稍候再试');
};
deactivateWallpaperEngineBackground = function () {};
setWallpaperEngineVisualSetting = function () {};

// ===== 抓虫修复（2026-09-20）=====
function getDesktopWindowApi() { // MR desktop/preload.js 全局助手；bundle 07-fx/00:1339 裸调用（导入 JSON 按钮 P1-1）
  return window.api || null;
}
document.addEventListener('keydown', function (e) { // P2-3：WE 导入模态打开时 Esc 只关模态（捕获阶段先于 app.js 的退出舞台处理）
  if (e.key !== 'Escape') return;
  var m = document.getElementById('wallpaper-engine-modal');
  if (m && m.classList.contains('show') && typeof closeWallpaperEngineLibrary === 'function') {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeWallpaperEngineLibrary();
  }
}, true);

// ===== 盘点清单接线（2026-09-20 凌晨批次）=====
// A1：桌面歌词开关 → DSH 真实歌词窗（main.js lyricWinToggle 经 dsh-lyricwin-* IPC）；
//     MR 原版 applyDesktopLyricsState 属未 vendor 的 10-shell/04，此处按 DSH 等价物接线（真实开关，非桩）
function applyDesktopLyricsState(syncUi) {
  try {
    var on = typeof fx !== 'undefined' && !!(fx && fx.desktopLyrics);
    if (window.api && typeof window.api.lyricWinToggle === 'function') window.api.lyricWinToggle(on);
    var btn = document.getElementById('t-desktopLyrics');
    if (btn) btn.classList.toggle('on', on);
  } catch (e) { /* 忽略 */ }
}
function desktopInteractionHotkeyHint() { return ''; } // MR 07-fx/06 提示串；DSH 桌面模式走 WE 体系，无此热键
// A-②#8/#9：歌单架空歌单卡与详情行桥（原函数属未 vendor 的 06-lyrics/01、05-playback/10）
function togglePlaylistPanel(force) { // DSH 无右侧歌单面板（用 3D 架 + 自有面板），空歌单卡点击兜底不再炸
  if (typeof showToast === 'function') showToast('歌单管理请使用播放器面板');
}
function queueDetailSongNext(song) { // 详情行「下一首播放」→ DSH 真实队列（queuePlayNext 含随机模式处理）
  try {
    if (!(song && song.id != null && window.__mp && typeof window.__mp.queuePlayNext === 'function')) return false;
    var st = window.__mp.state || {};
    var q = st.queue || [];
    var local = null;
    for (var i = 0; i < q.length; i++) if (q[i] && q[i].id === song.id) { local = q[i]; break; }
    window.__mp.queuePlayNext(local || song);
    if (typeof showToast === 'function') showToast('已加入下一首播放');
    return true;
  } catch (e) { return false; }
}
function toggleLikeDetailSong(song) { // 详情行红心 → DSH 收藏（toggleFavorite IPC）；收藏/红心在 DSH 同体系
  try {
    if (!(song && song.id != null && window.api && typeof window.api.toggleFavorite === 'function')) return false;
    window.api.toggleFavorite(song.id, song.online ? song : undefined).then(function (list) {
      if (window.__mp && window.__mp.state) window.__mp.state.favorites = list || [];
      if (typeof showToast === 'function') showToast('收藏已更新');
    });
    return true;
  } catch (e) { return false; }
}
function collectDetailSong(song) { return toggleLikeDetailSong(song); } // 同上（MR 的收藏概念 DSH 并入收藏）
function ensureLoggedInForAction() { return true; } // DSH 本地优先无登录（08-account 不移植），动作直接放行
function showLoginModal() { if (typeof showToast === 'function') showToast('本地播放无需登录'); } // 休眠簇兜底

// uParticleDim 驱动（照抄 MR 11-main-loop.js:587-590 内联逻辑；盘点 A5）
function uParticleDimEase(dt) {
  if (!uniforms || !uniforms.uParticleDim) return;
  var sonicActiveEarly = (window.MineradioSonicTopography && MineradioSonicTopography.isActive && MineradioSonicTopography.isActive(fx))
    || (window.MineradioSonicWorkshop && MineradioSonicWorkshop.isActive && MineradioSonicWorkshop.isActive(fx));
  var skullBackdropDim = fx && fx.preset === SKULL_PRESET_INDEX ? 0.58 : (sonicActiveEarly ? 0.82 : 1);
  var shelfDimTarget = typeof shouldDimWallpaperForShelf === 'function' && shouldDimWallpaperForShelf() ? 0.48 : skullBackdropDim;
  var shelfDimEase = shelfDimTarget < uniforms.uParticleDim.value ? 0.18 : 0.10;
  uniforms.uParticleDim.value += (shelfDimTarget - uniforms.uParticleDim.value) * Math.min(1, shelfDimEase * Math.max(1, dt * 60));
}

// ===== 歌词源切换链补齐（盘点 A2 收口；W2 残卷由协调者完成）=====
// renderLyrics（06-lyrics/00-lyrics-fetch-parse.js:634-661 原文照抄）：bundle 的
// applyOriginalLyricState/applyCustomLyricState 裸调它；本质是失效+预热编排（非 DOM 渲染），
// 与 mrSetLrc 尾部同款序列——适配层提供后 bundle 状态机即闭环
function renderLyrics(options) {
  options = options || {};
  var renderSignature = typeof stageLyricRenderSignatureForCurrentState === 'function' ? stageLyricRenderSignatureForCurrentState() : '';
  if (options.preserveSame && typeof stageLyricCanPreserveSameRender === 'function' && stageLyricCanPreserveSameRender(renderSignature)) {
    if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume(options.reason || 'preserve-same-lyrics');
    return;
  }
  var fallbackTitleOnly = lyricsAreFallbackTitleOnly(lyricsLines);
  var warmupReason = fallbackTitleOnly ? 'renderLyrics-title' : 'renderLyrics';
  var restoreWarmup = typeof stageLyricRestoreWarmupSeconds === 'function' && stageLyricRestoreWarmupSeconds() != null;
  var prewarmReason = restoreWarmup ? 'startup-restore-lyrics' : warmupReason;
  if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') invalidateStageLyricPayloadForNewLyrics('renderLyrics');
  else if (typeof clearStageLyrics === 'function') clearStageLyrics();
  if (typeof stageLyrics !== 'undefined' && stageLyrics && renderSignature) stageLyrics.renderSignature = renderSignature;
  if (typeof requestStageLyricWarmup === 'function') requestStageLyricWarmup(prewarmReason, fallbackTitleOnly ? 120 : 900);
  if (restoreWarmup && typeof scheduleStageLyricRestorePrewarm === 'function') {
    scheduleStageLyricRestorePrewarm(prewarmReason, fallbackTitleOnly ? 40 : 16);
  } else if (typeof scheduleStageLyricPrewarm === 'function') {
    scheduleStageLyricPrewarm(warmupReason, fallbackTitleOnly ? 56 : 32);
  }
  if (!fallbackTitleOnly && typeof scheduleStageLyricSingleLineBootstrapPrewarm === 'function') {
    scheduleStageLyricSingleLineBootstrapPrewarm(prewarmReason, restoreWarmup ? 24 : 44);
  }
  if (!fallbackTitleOnly && typeof scheduleStageLyricFullTrackWarmup === 'function') {
    scheduleStageLyricFullTrackWarmup(restoreWarmup ? 'track-ready-fast' : 'lyrics-ready-preload', restoreWarmup ? 120 : 24);
  }
}
function toggleLyricsPanel(force) { // MR 06-lyrics/00:662-677 原文照抄（舞台「词」按钮；此前未 vendor → 点击即炸）
  if (typeof fx === 'undefined') { if (typeof showToast === 'function') showToast('开启 3D 舞台后可用歌词开关'); return; }
  if (force === false) fx.particleLyrics = false;
  else if (force === true) fx.particleLyrics = true;
  else fx.particleLyrics = !fx.particleLyrics;
  if (fx.particleLyrics) {
    if (typeof createLyricsParticles === 'function') createLyricsParticles();
    if (typeof requestStageLyricWarmup === 'function') requestStageLyricWarmup('toggleLyricsPanel', 150);
    if (typeof scheduleStageLyricPrewarm === 'function') scheduleStageLyricPrewarm('toggleLyricsPanel', 48);
    if (typeof scheduleStageLyricFullTrackWarmup === 'function') scheduleStageLyricFullTrackWarmup('track-ready', 220);
    if (typeof showToast === 'function') showToast('歌词已开启');
  } else {
    if (typeof clearStageLyrics === 'function') clearStageLyrics();
    if (typeof showToast === 'function') showToast('歌词已关闭');
  }
  if (typeof lyricsVisible !== 'undefined') lyricsVisible = fx.particleLyrics;
}

// ① 页面空闲时预启动 bundle（点进舞台只剩 mesh 搬移+行层构建；失败静默，mount 时重试）
try { mrPreboot(); } catch (e) { console.warn('[MR 预启动] 失败:', e && e.message); }
