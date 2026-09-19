// mr-adapter.js —— 深空折韵 ↔ Mineradio 3D 歌词舞台 适配层（本文件是我们自己的代码）
// MR 模块文件原样 vendor 于 renderer/mr/（GPL-3.0，版权与来源见各文件头部与 mr/COPYING.md）。
// 本文件职责：
//   ① 补齐 MR 模块期望但未 vendor 的全局环境（工具函数从 04-visual-settings-persistence.js
//      原样照抄；uniforms/dotTexture 从 00-pointer-cover-particles.js 原样照抄所需子集）；
//   ② 把本播放器数据桥接进 MR 全局契约（audio / lyricsLines / 封面取色 / fx 开关）；
//   ③ 帧驱动（节拍/频段分析公式照搬 11-main-loop.js:357-540）+ 挂载/卸载生命周期。
'use strict';

// ---------- ① 环境补齐（在 MR 模块之前求值；原样照抄，勿改实现） ----------
var SKULL_PRESET_INDEX = 7;            // MR 00-core-stores.js:104；保持 fx.preset!==7 使骷髅分支恒假
var skullParticleGroup = null;         // MR 14:2087 守卫引用（骷髅不在移植范围）
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
function applyControlGlassChromaticOffset() {}
function normalizeControlGlassChromaticOffset(v) { return clampRange(Number(v) || 30, 30, 140); }
function applyCoverParticleResolution() {}
function sonicAudioNormalizeFx() {}
function wakeMainLoopFromBackground() {}
function syncWallpaperEngineCaptureFrameRate() { return Promise.resolve(); }
function applyFxPreset() {}
function refreshPresetGrid() {}
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
function mrAnalyzeFrame(now, dt) {
  var stepDt = MrStage.gates ? consumeFrameGate(MrStage.gates.audio, now, dt, 60, false, 'audio-analysis') : dt;
  if (stepDt <= 0) return;
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
    // realtimeBeat 引擎（03-beat）未移植 → 走 bassOnset 降级脉冲（MR 11-main-loop.js:448-451 原样）
    if (bassOnset > 0.075 && rb > 0.32 && energyOnset > 0.020) {
      beatPulse = Math.max(beatPulse, Math.min(0.12, bassOnset * 0.18));
    }
    beatPulse *= Math.pow(0.36, stepDt);
    function env(prev, next, attack, release) {
      var k = next > prev ? attack : release;
      return prev + (next - prev) * k;
    }
    smoothBass = env(smoothBass, Math.min(0.82, rb * 0.78 + re * 0.025), 0.28, 0.075);
    smoothMid = env(smoothMid, Math.min(0.68, rm * 0.64 + re * 0.025), 0.18, 0.060);
    smoothTreb = env(smoothTreb, Math.min(0.56, rt * 0.54), 0.18, 0.055);
    smoothEnergy = env(smoothEnergy, Math.min(0.72, re), 0.16, 0.055);
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
  uniforms.uBass.value = bass; uniforms.uMid.value = mid;
  uniforms.uTreble.value = treble; uniforms.uBeat.value = beatPulse;
  uniforms.uEnergy.value = audioEnergy;
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
  // 以下照搬 11-main-loop.js:575-600 的视觉每帧段
  updateParticlePointerFrame();
  uniforms.uVinylSpin.value = (uniforms.uVinylSpin.value + dt * (0.40 + smoothBass * 0.09) * (isFinite(fx.speed) ? Math.max(0.05, fx.speed) : 1)) % (Math.PI * 2);
  uniforms.uBurstAmt.value *= 0.90;
  if (typeof tickPresetTransition === 'function') tickPresetTransition(); // MR 11-main-loop.js:593 同款
  if (typeof updateBackgroundStarRiverState === 'function') updateBackgroundStarRiverState(dt, false);
  updateRipples(dt);
  updateFloatLayer(dt);
  updateCinema(dt); updateFreeCamera(dt); updateCamera();
  if (typeof applySkullCameraPose === 'function') applySkullCameraPose(dt);
  var stepDt = MrStage.gates ? consumeFrameGate(MrStage.gates.stageLyrics, now, dt, playing ? 45 : 24, false, 'stage-lyrics') : dt;
  if (stepDt > 0) updateStageLyrics3D(stepDt);
  if (MrStage.gates) {
    var lyrDt = consumeFrameGate(MrStage.gates.lyrics, now, dt, playing ? 45 : 24, false, 'lyrics-particles');
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
function mrSetLrc(lrc, wordSegs, translated) {
  if (!MrStage.booted) { // 挂载前调用（歌词先于舞台就绪）→ 缓存，boot/mount 时回放
    MrStage.pendingLrc = [lrc, wordSegs, translated];
    return 0;
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
        for (var k = 0; k < ch.length; k++) { // 消费归一化文本（空格串折叠为一个 ' '）
          if (np < text.length && text[np] === ch[k]) np++;
          else if (/\s/.test(ch[k]) && np < text.length && text[np] === ' ') np++;
          else if (ch[k] === ' ' && np < text.length && text[np] === ' ') np++;
          else { ok = false; break; }
        }
        if (!ok) break;
        words.push({ c0: c0, c1: np, t: t0, d: Math.max(0.08, t1 - t0) });
      }
      if (ok && words.length && np === text.length) { line.words = words; }
    }
    lines.push(line);
  }
  window.lyricsLines = lines;          // MR 模块按全局名逐次查找，直接整体替换即可
  lyricsHasNativeKaraoke = lines.some(function (l) { return l.words && l.words.length; });
  if (typeof stageLyrics !== 'undefined') { stageLyrics.currentIdx = -1; stageLyrics.currentText = ''; stageLyrics.current = null; stageLyrics.currentPayload = null; stageLyrics.currentDisplayKey = ''; }
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

async function mrMount(host) {
  MrStage.host = host;
  // 容器必须在 00-renderer-quality 注入执行前就位（它在加载时 getElementById('canvas-container')）
  if (!MrStage.container) {
    MrStage.container = document.createElement('div');
    MrStage.container.id = 'canvas-container';
    MrStage.container.style.cssText = 'position:absolute;inset:0;';
    host.appendChild(MrStage.container);
  }
  if (!MrStage.booted) {
    if (MrStage.booting) { await MrStage.booting; }
    else {
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
          if (MrStage.pendingLrc) { var pl = MrStage.pendingLrc; MrStage.pendingLrc = null; mrSetLrc(pl[0], pl[1], pl[2]); }
          resolve();
        };
        s.onerror = function () { reject(new Error('MR_BUNDLE_LOAD_FAILED')); };
        document.head.appendChild(s);
      }).catch(function (e) { MrStage.failed = true; MrStage.lastError = String(e && e.message || e); throw e; });
      await MrStage.booting;
    }
  }
  if (MrStage.failed) throw new Error('MR_BOOT_FAILED');
  if (!MrStage.gates && typeof createFrameGate === 'function') {
    MrStage.gates = {
      audio: createFrameGate('main.audio', 60),
      stageLyrics: createFrameGate('main.stageLyrics', 45),
      lyrics: createFrameGate('main.lyricsParticles', 45),
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
  mrResize();
  mrShelfActivate(); // 3D 歌单架：喂数据 + 激活（幂等；MR 里由 10-shell 启动链负责，此处适配层接管）
  mrShelfBindPointer(); // 补 MR 未 vendor 的 hover 揭示接线（点击/滚轮/键盘由 vendored 05/06 自带）
  if (!MrStage.raf) { MrStage.prevTime = performance.now(); MrStage.raf = requestAnimationFrame(mrFrame); }
  MrStage.mounted = true;
}

function mrUnmount() {
  MrStage.mounted = false;
  if (MrStage.raf) { cancelAnimationFrame(MrStage.raf); MrStage.raf = 0; }
  // 卸载歌词 mesh 与星河（MR 自带的分批释放队列 disposeLyricMesh/disposeLyricStarRiver）
  try {
    if (typeof stageLyrics !== 'undefined') {
      if (stageLyrics.current && typeof disposeLyricMesh === 'function') { disposeLyricMesh(stageLyrics.current); stageLyrics.current = null; }
      for (var i = 0; i < stageLyrics.outgoing.length; i++) disposeLyricMesh && disposeLyricMesh(stageLyrics.outgoing[i]);
      stageLyrics.outgoing.length = 0;
      if (stageLyrics.starRiver && typeof disposeLyricStarRiver === 'function') disposeLyricStarRiver();
    }
  } catch { /* 卸载幂等 */ }
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
  setAudio: function (el) { MrStage.audioEl = el; window.audio = el; },
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
