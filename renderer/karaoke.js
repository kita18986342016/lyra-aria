// v1.4.2 卡拉OK扫色共享算法（借鉴 Mineradio getLyricLineProgress/karaokeWordRanges 思想，GPL-3.0）
// 四个出口共用：主窗歌词面板 / 详情页 / 桌面歌词悬浮窗 /（将来的 3D 舞台）。
// 核心思想：把"当前时刻"换算成整行像素空间里的一个连续进度（0..1），
//   有逐字数据 → 每字时间段在"该字的像素宽度区间"内线性推进，字间隙停住（与实际演唱对齐）；
//   无逐字数据 → 整行 smoothstep 平滑扫过（中段快两端慢，体面降级而非按字数硬分）。
// 渲染层各自拿这个进度上色（DOM 渐变 / 将来 shader），算法只算数字。
'use strict';
(function () {
  const Karaoke = {};

  // smoothstep：LRC 降级扫描的缓动（MR 同款 prog*prog*(3-2*prog)）
  Karaoke.smoothstep = function (x) {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
  };

  // 离屏测量：把逐字序列换算成像素区间。
  // chars: [{ch, t}]（t=该字开始唱的绝对秒）；font 与真实渲染一致才有意义。
  // 返回 { ranges: [{ch, t, tEnd, px0, px1}], totalPx }；tEnd = 下一字开始（末字=行尾），单位秒。
  Karaoke.buildWordRanges = function (chars, lineT, lineDur, font, measureEl) {
    const list = Array.isArray(chars) ? chars.filter((c) => c && (c.ch || c.ch === ' ')) : [];
    const nextT = lineT + Math.max(0.15, lineDur);
    const saved = measureEl.textContent;
    if (font) measureEl.style.font = font;
    const ranges = [];
    let acc = 0;
    let prevText = '';
    let prevW = 0;
    measureEl.textContent = '';
    for (const c of list) {
      const ch = String(c.ch == null ? '' : c.ch);
      const text = prevText + ch;
      measureEl.textContent = text;
      const w = measureEl.getBoundingClientRect().width;
      const cw = Math.max(0, w - prevW);
      const t0 = Math.max(Number(c.t) || lineT, lineT);
      ranges.push({ ch, t: t0, tEnd: t0, px0: acc, px1: acc + cw });
      acc += cw;
      prevText = text;
      prevW = w;
    }
    measureEl.textContent = saved;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const nt = i < ranges.length - 1 ? ranges[i + 1].t : nextT;
      r.tEnd = Math.min(Math.max(nt, r.t + 0.06), nextT + 0.5); // 末字允许拖到行尾后 0.5s（拖腔）
    }
    return { ranges, totalPx: acc };
  };

  // 逐字模式：绝对时刻 tAbs(秒) → 整行像素进度（0..1）。
  // 每字时间段内线性推进；字间隙停在上一个字的末尾（MR 同款 lastP 语义）。
  Karaoke.wordFrontPx = function (built, tAbs) {
    if (!built || !built.ranges.length || built.totalPx <= 0) return null;
    let lastP = 0;
    for (const r of built.ranges) {
      if (tAbs < r.t) break;                          // 还没唱到这个字 → 停在上一字末尾
      if (tAbs < r.tEnd) {                            // 正在唱这个字 → 区间内线性
        const local = (tAbs - r.t) / Math.max(0.06, r.tEnd - r.t);
        return Math.min(1, (r.px0 + (r.px1 - r.px0) * local) / built.totalPx);
      }
      lastP = r.px1 / built.totalPx;                  // 这个字已唱完
    }
    return Math.min(1, lastP);
  };

  // 无逐字：整行 smoothstep 扫（含 20ms 提前量，MR 同款）
  Karaoke.lineProgress = function (tAbs, lineT, lineDur) {
    return Karaoke.smoothstep((tAbs + 0.02 - lineT) / Math.max(0.75, lineDur));
  };

  window.LyricKaraoke = Karaoke;
})();
