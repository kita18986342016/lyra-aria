// 曲库扫描 + 元数据读取（music-metadata）
const fs = require('fs');
const path = require('path');
const { parseFile } = require('music-metadata');

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

async function readMeta(file) {
  const fb = fromFilename(file);
  try {
    const mm = await parseFile(file, { duration: true });
    const c = mm.common;
    return {
      title: c.title || fb.title,
      artist: c.artist || fb.artist,
      album: c.album || '',
      duration: Math.round(mm.format.duration || 0),
      hasCover: !!(c.picture && c.picture.length),
      hasLyrics: !!(c.lyrics && c.lyrics.length)
    };
  } catch {
    return {
      title: fb.title,
      artist: fb.artist,
      album: '',
      duration: 0,
      hasCover: false,
      hasLyrics: false
    };
  }
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
        hasCover: meta.hasCover,
        hasLyrics: meta.hasLyrics
      });
      if (onProgress) onProgress(i + 1, files.length, dir);
    }
  }
  return songs;
}

module.exports = { scanLibrary, listAudioFiles, AUDIO_EXTS };
