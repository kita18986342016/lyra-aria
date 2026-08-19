// 在线歌词获取（多源自动切换）：网易云 → QQ音乐 → lrclib
// 搜索 → 下载 LRC → 落盘到歌曲同目录
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const BASE_HEADERS = { 'User-Agent': UA };

async function getJSON(url, timeout = 8000, extraHeaders = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { ...BASE_HEADERS, ...extraHeaders }, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// 归一化：小写、去括号/标点/空格（歌名模糊匹配）
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[（）]/g, '')
    .replace(/[~～、,，.。!！?？:：;；"'']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 改编版标记：歌名带这些标记时，搜索结果必须带相同标记（防止 DJ 版/现场版错配原版歌词）
const VARIANT_TAGS = ['dj', 'live', '现场', 'remix', '伴奏', '钢琴版', '吉他版', '纯音乐', '翻唱', 'cover'];
function variantOk(a, b) {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  for (const t of VARIANT_TAGS) {
    if (la.includes(t) !== lb.includes(t)) return false;
  }
  return true;
}

// 从搜索结果里挑最匹配的：先精确相等，再变体一致 + 包含
function pickHit(items, want, getName) {
  let hit = items.find((x) => normalize(getName(x)) === want);
  if (hit) return hit;
  hit = items.find((x) => {
    const n = normalize(getName(x));
    return n && variantOk(want, n) && (n.includes(want) || want.includes(n));
  });
  return hit;
}

// ---------- 源 1：网易云 ----------
async function neteaseFetch(song) {
  const q = encodeURIComponent(`${song.artist} ${song.title}`);
  const data = await getJSON(`https://music.163.com/api/search/get/web?s=${q}&type=1&limit=5`,
    8000, { Referer: 'https://music.163.com' });
  const songs = (data && data.result && data.result.songs) || [];
  if (!songs.length) return null;
  const hit = pickHit(songs, normalize(song.title), (s) => s.name);
  if (!hit) return null;
  const ld = await getJSON(`https://music.163.com/api/song/lyric?id=${hit.id}&lv=1&kv=1&tv=-1`,
    8000, { Referer: 'https://music.163.com' });
  const lyric = ld && ld.lrc && ld.lrc.lyric;
  return (lyric && lyric.trim()) || null;
}

// ---------- 源 2：QQ 音乐 ----------
async function qqFetch(song) {
  const q = encodeURIComponent(`${song.artist} ${song.title}`);
  const data = await getJSON(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${q}&format=json&n=10`,
    8000, { Referer: 'https://y.qq.com' });
  const list = data && data.data && data.data.song && data.data.song.list;
  if (!list || !list.length) return null;
  const hit = pickHit(list, normalize(song.title), (s) => s.songname);
  if (!hit) return null;
  const ld = await getJSON(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${hit.songmid}&format=json&nobase64=0`,
    8000, { Referer: 'https://y.qq.com' });
  if (!ld || !ld.lyric) return null;
  return Buffer.from(ld.lyric, 'base64').toString('utf8').trim() || null;
}

// ---------- 源 3：lrclib（国际库，免费无限流） ----------
async function lrclibFetch(song) {
  const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(song.title)}&artist_name=${encodeURIComponent(song.artist)}`;
  const data = await getJSON(url, 8000);
  if (!Array.isArray(data) || !data.length) return null;
  const hit = pickHit(data, normalize(song.title), (x) => x.trackName);
  if (!hit) return null;
  return (hit.syncedLyrics || '').trim() || null;
}

// ---------- 主流程 ----------
function lrcPathFor(song) {
  return path.join(path.dirname(song.path), path.basename(song.path, path.extname(song.path)) + '.lrc');
}

function hasLocalLrc(song) {
  try { return fs.statSync(lrcPathFor(song)).size > 0; } catch { return false; }
}

// 单首歌：已有 .lrc 直接用；否则三源依次尝试并落盘
async function ensureLyrics(song) {
  if (hasLocalLrc(song)) return { ok: true, source: 'lrc', cached: true };
  const sources = [
    ['网易云', neteaseFetch],
    ['QQ音乐', qqFetch],
    ['lrclib', lrclibFetch]
  ];
  for (const [name, fn] of sources) {
    try {
      const text = await fn(song);
      if (text) {
        fs.writeFileSync(lrcPathFor(song), text, 'utf8');
        return { ok: true, source: 'lrc', name };
      }
    } catch (e) {
      // 单源网络失败 → 继续下一源
    }
  }
  return { ok: false, reason: '多源均未找到' };
}

// 批量补齐：慢速串行防限流，失败重试 1 次，连续失败熔断暂停
async function fillAll(songs, onProgress, concurrency = 1, delayMs = 1200) {
  let ok = 0, fail = 0, skipped = 0;
  const targets = songs.filter((s) => !hasLocalLrc(s));
  let next = 0;
  let failStreak = 0;
  const worker = async () => {
    while (next < targets.length) {
      const i = next++;
      const song = targets[i];
      let r = await ensureLyrics(song);
      if (!r.ok) {
        await new Promise((res) => setTimeout(res, 3000));
        r = await ensureLyrics(song);
      }
      if (r.ok && !r.cached) { ok++; failStreak = 0; }
      else if (r.ok && r.cached) skipped++;
      else { fail++; failStreak++; }
      if (onProgress) onProgress(i + 1, targets.length, ok, fail);
      if (failStreak >= 5) {
        failStreak = 0;
        await new Promise((res) => setTimeout(res, 10000));
      }
      if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
    }
  };
  const n = Math.min(concurrency, Math.max(1, targets.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { ok, fail, skipped, total: targets.length };
}

module.exports = { ensureLyrics, fillAll, lrcPathFor, hasLocalLrc, normalize };
