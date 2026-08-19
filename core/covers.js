// 在线封面获取（网易云 → QQ 音乐），串行节流 + 磁盘缓存
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

// 封面缓存目录跟随用户数据目录（普适化）：userData/covers，每台机器/每个用户各自独立
function coverDir() {
  return path.join(store.getDataDir() || '', 'covers');
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
let queue = Promise.resolve();
let lastReq = 0;
const failCache = new Set(); // 内存失败标记，避免重复请求

// id 可能是超长路径编码 → 用 SHA1 前 32 位做文件名（避免超过 255 字符限制）
function coverFile(id) {
  return path.join(coverDir(), crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 32) + '.jpg');
}

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: Object.assign({ 'User-Agent': UA, Referer: 'https://music.163.com/' }, headers),
      timeout: 8000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return request(res.headers.location, headers).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[（(].*?[)）]/g, '');
}

async function netease(title, artist) {
  for (const query of [(artist ? artist + ' ' : '') + title, title]) {
    try {
      const q = encodeURIComponent(query);
      const body = await request(`https://music.163.com/api/search/get/web?s=${q}&type=1&limit=5&offset=0`);
      const j = JSON.parse(body.toString('utf8'));
      const songs = j.result && j.result.songs;
      if (!songs || !songs.length) continue;
      const hit = songs.find((s) => norm(s.name) === norm(title)) || songs[0];
      if (!hit || !hit.id) continue;
      // 搜索接口不返回 picUrl → 用歌曲详情 API 拿专辑封面
      const dbody = await request(`https://music.163.com/api/song/detail?id=${hit.id}&ids=%5B${hit.id}%5D`);
      const dj = JSON.parse(dbody.toString('utf8'));
      const s = dj.songs && dj.songs[0];
      if (s && s.album && s.album.picUrl) return s.album.picUrl + '?param=800y800';
    } catch (e) { /* 该查询失败，尝试下一种 */ }
  }
  return null;
}

async function qq(title, artist) {
  for (const query of [(artist ? artist + ' ' : '') + title, title]) {
    try {
      const q = encodeURIComponent(query);
      const body = await request(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${q}&format=json&n=10`, { Referer: 'https://y.qq.com/' });
      const j = JSON.parse(body.toString('utf8'));
      const list = j.data && j.data.song && j.data.song.list;
      if (!list || !list.length) continue;
      // 新版字段是 songname；优先精确匹配且有封面，否则任意有封面的结果
      const nm = norm(title);
      const hit = list.find((s) => norm(s.songname || s.name) === nm && s.albummid)
        || list.find((s) => norm(s.songname || s.name) === nm)
        || list.find((s) => s.albummid);
      if (hit && hit.albummid) return `https://y.gtimg.cn/music/photo_new/T002R800x800M000${hit.albummid}.jpg`;
    } catch (e) { /* 该查询失败，尝试下一种 */ }
  }
  return null;
}

// 获取封面（串行队列节流，磁盘缓存 <id>.jpg）；opts.force 忽略失败标记（限流恢复后重试）
async function getCover(song, opts = {}) {
  if (!song || !song.path) return null;
  const file = coverFile(song.id);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (!opts.force && failCache.has(song.id)) return null;
  const run = async () => {
    const wait = Math.max(0, 450 - (Date.now() - lastReq));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReq = Date.now();
    try {
      let url = await netease(song.title, song.artist);
      if (!url) url = await qq(song.title, song.artist);
      if (!url) { failCache.add(song.id); return null; }
      const buf = await request(url);
      if (buf.length < 200) { failCache.add(song.id); return null; }
      fs.mkdirSync(coverDir(), { recursive: true });
      fs.writeFileSync(file, buf);
      return buf;
    } catch (e) { failCache.add(song.id); console.error('[covers]', song.title, '失败:', e.message); return null; }
  };
  const p = queue.then(run);
  queue = p.catch(() => {});
  return p;
}

module.exports = { getCover, coverDir, qq, netease, request };
