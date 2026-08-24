// 曲库扫描 + 元数据读取（music-metadata）
const fs = require('fs');
const path = require('path');
const { parseFile } = require('music-metadata');

// 扫描器版本：解析逻辑变更（如 .mp3 伪装 FLAC 兜底）后 +1，旧 library.json 缓存自动失效重扫
const SCAN_VERSION = 2;

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.aac', '.opus']);

function listAudioFiles(dir) {
  const out = [];
  (function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  })(dir);
  return out;
}

// 从文件名解析 "艺术家 - 歌名"（标签缺失时的 fallback）
function fromFilename(file) {
  const base = path.basename(file, path.extname(file));
  const idx = base.indexOf(' - ');
  if (idx > 0) {
    return { title: base.slice(idx + 3).trim(), artist: base.slice(0, idx).trim() };
  }
  return { title: base, artist: '未知艺术家' };
}

// 跳过 ID3v2 标签（v2.2/2.3/2.4），返回音频起始偏移；无标签返回 0
function id3Skip(buf) {
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    let off = 10 + size;
    if (buf[3] === 4 && off + 10 <= buf.length && buf[off] === 0x33 && buf[off + 1] === 0x44 && buf[off + 2] === 0x49) off += 10; // v2.4 尾部标志
    return off;
  }
  return 0;
}

// 内容嗅探兜底：music-metadata 对「ID3 + .mp3 伪装 FLAC」（酷狗下载产物）解析崩溃——
// 报成 ADTS/MPEG-2、bitrate 上亿、duration<1s（把一帧当整个文件）。
// 跳 ID3 后见 fLaC 魔数 → 解析 FLAC STREAMINFO（规范固定布局）：duration=totalSamples/sampleRate
function flacFallback(file) {
  try {
    const st = fs.statSync(file);
    const head = Buffer.alloc(Math.min(1 << 20, st.size)); // 前 1MB 足够（ID3 最大 ~461KB + STREAMINFO）
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const audioStart = id3Skip(head);
    if (audioStart + 42 > head.length) return null;
    if (head[audioStart] !== 0x66 || head[audioStart + 1] !== 0x4c || head[audioStart + 2] !== 0x61 || head[audioStart + 3] !== 0x43) return null;
    const blockLen = ((head[audioStart + 5] & 0x7f) << 16) | (head[audioStart + 6] << 8) | head[audioStart + 7];
    if (blockLen !== 34) return null; // STREAMINFO 块长固定 34
    const s = audioStart + 8;
    const sampleRate = (head[s + 10] << 12) | (head[s + 11] << 4) | (head[s + 12] >> 4); // 20-bit
    const totalSamples = ((head[s + 13] & 0x0f) * 0x100000000) + (head[s + 14] << 24) + (head[s + 15] << 16) + (head[s + 16] << 8) + head[s + 17]; // 36-bit
    if (!(sampleRate > 0 && totalSamples > 0)) return null;
    const duration = totalSamples / sampleRate;
    if (!(duration >= 1 && duration <= 10800)) return null; // 1s ~ 3h
    const audioBytes = st.size - audioStart;
    return { duration: Math.round(duration), bitrate: Math.round(audioBytes * 8 / duration) };
  } catch {
    return null;
  }
}

async function readMeta(file) {
  const fb = fromFilename(file);
  let mm = null;
  try {
    mm = await parseFile(file, { duration: true });
  } catch {
    mm = null;
  }
  if (mm) {
    const c = mm.common;
    const f = mm.format || {};
    const meta = {
      title: c.title || fb.title,
      artist: c.artist || fb.artist,
      album: c.album || '',
      duration: Math.round(f.duration || 0),
      bitrate: Math.round(f.bitrate || 0),       // 音质标签来源（bps）
      container: String(f.container || '').toUpperCase(), // FLAC/MPEG/...（无损判定）
      hasCover: !!(c.picture && c.picture.length),
      hasLyrics: !!(c.lyrics && c.lyrics.length)
    };
    // 合理性校验：bitrate 8kbps~10Mbps、duration 1s~3h 之外视为解析错误 → 内容嗅探兜底
    if (!(meta.bitrate >= 8000 && meta.bitrate <= 10000000) || !(meta.duration >= 1 && meta.duration <= 10800)) {
      const fb2 = flacFallback(file);
      if (fb2) {
        meta.duration = fb2.duration;
        meta.bitrate = fb2.bitrate;
        meta.container = 'FLAC'; // 实际内容为 FLAC（伪装 .mp3），无损判定正确
      }
    }
    return meta;
  }
  const fb2 = flacFallback(file);
  if (fb2) {
    return {
      title: fb.title,
      artist: fb.artist,
      album: '',
      duration: fb2.duration,
      bitrate: fb2.bitrate,
      container: 'FLAC',
      hasCover: false,
      hasLyrics: false
    };
  }
  return {
    title: fb.title,
    artist: fb.artist,
    album: '',
    duration: 0,
    bitrate: 0,
    container: '',
    hasCover: false,
    hasLyrics: false
  };
}

// 扫描多个目录，返回歌曲数组（id = 路径 base64url，稳定不变）
async function scanLibrary(dirs, onProgress) {
  const songs = [];
  const seen = new Set(); // 按绝对路径去重：父目录+子目录同时收录时同一文件只算一次
  for (const dir of dirs) {
    const files = listAudioFiles(dir);
    for (let i = 0; i < files.length; i++) {
      if (seen.has(files[i])) continue;
      seen.add(files[i]);
      const meta = await readMeta(files[i]);
      songs.push({
        id: Buffer.from(files[i]).toString('base64url'),
        path: files[i],
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        duration: meta.duration,
        bitrate: meta.bitrate,
        container: meta.container,
        hasCover: meta.hasCover,
        hasLyrics: meta.hasLyrics
      });
      if (onProgress) onProgress(i + 1, files.length, dir);
    }
  }
  return songs;
}

module.exports = { scanLibrary, listAudioFiles, AUDIO_EXTS, SCAN_VERSION };
