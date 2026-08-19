// 酷狗歌单 songlist.json 导入 + 与本地文件匹配（缺歌过滤）
const fs = require('fs');
const path = require('path');

// 解码 HTML 实体（songlist 里 raw 含 &#039; &amp; 等）
function decodeHtml(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// 归一化：小写、去括号内容、去空格差异（用于宽松匹配）
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[（）]/g, '')
    .replace(/[~～、,，.。!！?？:：;；"'']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function baseName(song) {
  return path.basename(song.path, path.extname(song.path));
}

// 精确匹配：解码后 raw === 文件名
function exactMatch(song, songs) {
  const raw = decodeHtml((song.raw || '').trim());
  if (!raw) return null;
  return songs.find((s) => baseName(s) === raw) || null;
}

// 归一化匹配：去括号/标点后相等，或互相包含
function normalizedMatch(song, songs) {
  const raw = normalize(decodeHtml(song.raw || ''));
  const title = normalize(song.title || '');
  if (!raw && !title) return null;
  for (const s of songs) {
    const bn = normalize(baseName(s));
    if (raw && bn === raw) return s;
    if (raw && bn && (bn.includes(raw) || raw.includes(bn))) return s;
    if (title && bn && bn.includes(title)) return s;
  }
  return null;
}

// 导入 songlist.json：返回匹配上的 songId 列表 + 缺失名单
function importSonglist(file, songs) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: 'songlist.json 读取失败' };
  }
  const matched = [];
  const missing = [];
  for (const s of data.songs || []) {
    const m = exactMatch(s, songs) || normalizedMatch(s, songs);
    if (m) matched.push(m.id);
    else missing.push(s.raw || s.title || '?');
  }
  return { ok: true, matched, missing, total: (data.songs || []).length };
}

module.exports = { importSonglist };
