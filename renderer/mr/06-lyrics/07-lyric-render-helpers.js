// 07-lyric-render-helpers.js —— 歌词解析/兜底纯函数（盘点 A2：歌词源切换链缺失件）
// 来源：Mineradio 2.2.0 public/js/modules/06-lyrics/00-lyrics-fetch-parse.js（GPL-3.0）。
// 逐函数原文照抄，未改动任何逻辑；每函数头部标注 ref 文件行号。
//
// 抽取清单（ref 00-lyrics-fetch-parse.js 行号 → 本文件函数）：
//   :1-5      hasUsableLyricLines
//   :267-272  withLyricFallbackForSong
//   :373-375  withLyricFallback（薄包装，一并抽）
//   :376-379  lyricsAreFallbackTitleOnly
//   :380-384  lyricTagTimeToSeconds
//   :385-395  finalizeLyricLineDurations
//   :396-426  parseLyricText
//
// 外部依赖核对（bundle 已有全局 / 适配层已有，均就位）：
//   isNoLyricText            → renderer/mr-adapter.js:256（原 00:365-372 原文）
//   lyricFallbackTextForSong → renderer/mr-adapter.js:554（原 00:258-266 DSH 适配版，读 #pTitle/#pArtist）
//   currentLyricSong         → mr-bundle.js:32610
// 其余依赖（Array/Number/Math/parseInt/isFinite/String）为语言内建。无缺失依赖，无需缓抽。
//
// 未抽取（状态函数，不在本文件；由协调者在适配层桥接）：
//   renderLyrics（00:634-661）、toggleLyricsPanel（00:662-677）、
//   applyOriginalLyricsState / applyCustomLyricState（mr-bundle.js 已有：32723 / 32746）。
//
// 装载：与 06-lyric-timing-offset.js 同路——由协调者把 '06-lyrics/07-lyric-render-helpers.js'
//   加入 scripts/build-mr-bundle.js 的 FILES 后重建 mr-bundle.js（本文件无顶层副作用，
//   在清单中的位置不影响运行：全部为 function 声明，跨文件提升后由 bundle 调用点解析）。

// 00-lyrics-fetch-parse.js:1-5 原文
function hasUsableLyricLines(lines) {
  return (Array.isArray(lines) ? lines : []).some(function (line) {
    return line && !line.fallback && !isNoLyricText(line.text);
  });
}

// 00-lyrics-fetch-parse.js:267-272 原文
function withLyricFallbackForSong(song, lines) {
  lines = Array.isArray(lines) ? lines.filter(function (line) { return line && String(line.text || '').trim(); }) : [];
  if (lines.length && !lines.every(function (line) { return isNoLyricText(line.text); })) return lines;
  var text = lyricFallbackTextForSong(song);
  return text ? [{ t: 0, text: text, duration: 9999, charCount: Math.max(1, text.length), fallback: true }] : [];
}

// 00-lyrics-fetch-parse.js:373-375 原文
function withLyricFallback(lines) {
  return withLyricFallbackForSong(currentLyricSong(), lines);
}

// 00-lyrics-fetch-parse.js:376-379 原文
function lyricsAreFallbackTitleOnly(lines) {
  lines = Array.isArray(lines) ? lines.filter(function (line) { return line && String(line.text || '').trim(); }) : [];
  return lines.length === 1 && !!lines[0].fallback;
}

// 00-lyrics-fetch-parse.js:380-384 原文
function lyricTagTimeToSeconds(min, sec, frac) {
  var t = (parseInt(min, 10) || 0) * 60 + (parseInt(sec, 10) || 0);
  if (frac) t += (parseInt(frac, 10) || 0) / Math.pow(10, Math.min(3, frac.length));
  return t;
}

// 00-lyrics-fetch-parse.js:385-395 原文
function finalizeLyricLineDurations(lines) {
  lines.sort(function (a, b) { return a.t - b.t; });
  for (var i = 0; i < lines.length; i++) {
    var next = lines[i + 1];
    var inferred = next && next.t > lines[i].t ? next.t - lines[i].t : 4.8;
    if (!isFinite(lines[i].duration) || lines[i].duration <= 0) lines[i].duration = inferred;
    lines[i].duration = Math.max(0.45, Math.min(12, lines[i].duration));
    lines[i].charCount = Math.max(1, lines[i].charCount || String(lines[i].text || '').length);
  }
  return lines;
}

// 00-lyrics-fetch-parse.js:396-426 原文
function parseLyricText(text) {
  var lines = [], reg = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
  text.split(/\r?\n/).forEach(function (line) {
    var tags = [], times = [], m;
    reg.lastIndex = 0;
    while ((m = reg.exec(line))) {
      var t = lyricTagTimeToSeconds(m[1], m[2], m[3]);
      times.push(t);
      tags.push({ t: t, index: m.index, end: reg.lastIndex });
    }
    if (!times.length) return;
    var hasInterleavedText = false;
    for (var i = 0; i < tags.length - 1; i++) {
      if (line.slice(tags[i].end, tags[i + 1].index).trim()) {
        hasInterleavedText = true;
        break;
      }
    }
    if (hasInterleavedText) {
      for (var si = 0; si < tags.length; si++) {
        var segment = line.slice(tags[si].end, si + 1 < tags.length ? tags[si + 1].index : line.length).trim();
        if (segment) lines.push({ t: tags[si].t, text: segment, source: 'lrc' });
      }
      return;
    }
    var txt = line.replace(reg, '').trim();
    if (!txt) return;
    times.forEach(function (t) { lines.push({ t: t, text: txt, source: 'lrc' }); });
  });
  return finalizeLyricLineDurations(lines);
}
