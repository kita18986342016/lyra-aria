// music-tempo 分析 worker（DSH 适配新增，非 MR 原文件——MR 的 worker 是 blob 内联代码，
// 但本项目 CSP default-src 'self' 拦 blob: worker（2026-09-20 烟测实锤），改为真实文件 worker）。
// 消息协议与 MR 03-beat/00-tempo-worker-cache-prefetch.js getMusicTempoWorkerUrl 内联代码完全一致：
// 收 { mono:Float32Array.buffer, sampleRate }，回 { ok, tempo, beats } / { ok:false, error }。
// importScripts 用相对路径（worker 脚本同源目录，'self' 放行；MR 原版 scriptUrl/file:// 绝对路径必死）。
self.onmessage = function (e) {
  var d = e.data || {};
  try {
    importScripts('music-tempo.min.js');
    var C = self.MusicTempo || (typeof MusicTempo !== 'undefined' ? MusicTempo : null);
    if (!C) throw new Error('MusicTempo unavailable');
    var mono = new Float32Array(d.mono);
    var mt = new C(mono, { bufferSize: 2048, hopSize: Math.max(128, Math.round(d.sampleRate * 0.010)), timeStep: 0.010, minBeatInterval: 0.36, maxBeatInterval: 0.95, expiryTime: 8 });
    self.postMessage({ ok: true, tempo: mt.tempo || 0, beats: mt.beats || [] });
  } catch (err) {
    self.postMessage({ ok: false, error: (err && err.message) || String(err) });
  }
};
