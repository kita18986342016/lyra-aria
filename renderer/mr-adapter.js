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
var shelfManager = null;               // MR 14:2100 守卫引用（3D 歌单架不移植）
var skullBeatFlash = 0;                // MR 14:2064 骷髅预设专用，恒 0
var particles = null, bloomParticles = null, floatGroup = null, backCoverGroup = null;
// MR 14:11453 守卫引用：封面粒子组（未移植模块），falsy → 歌词布局走世界原点分支（MR 同款兜底）
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
var uniforms = {
  uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
  uBeat: { value: 0 }, uEnergy: { value: 0 }, uPixel: { value: 1 },
};
var dotTexture = null;                 // THREE 加载后由 makeDotTexture 创建（MR 00:197-210 原样）
function makeDotTexture() {            // MR 00-pointer-cover-particles.js:197-210 原样照抄
  var cv = document.createElement('canvas'); cv.width = cv.height = 64;
  var ctx = cv.getContext('2d');
  var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  g.addColorStop(0.00, 'rgba(255,255,255,0.96)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.78)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.22)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  var tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  return tex;
}

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

// 兼容一期接口名：app.js 的 syncStage3d 只用 mount/unmount/active/failed/resetFailed/markFailed/resize
window.LyricStage3D = {
  mount: mrMount,
  unmount: mrUnmount,
  setLrc: mrSetLrc,
  refreshPalette: mrRefreshPalette,
  setAudio: function (el) { MrStage.audioEl = el; window.audio = el; },
  active: function () { return MrStage.booted && MrStage.mounted; },
  failed: function () { return MrStage.failed; },
  markFailed: function () { MrStage.failed = true; },
  resetFailed: function () { MrStage.failed = false; },
  resize: mrResize,
  update: function () {}, // 一期遗留：3D 现自驱帧循环，无需外部喂数据
  show: function () {}, hide: function () {},
};
