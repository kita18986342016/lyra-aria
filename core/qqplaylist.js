// QQ 歌单导入（官方 musicu.fcg aiDissInfo，匿名分页全量）
// v1.4.2 起仅保留歌单拉取：搜索/播放/歌词等 QQ 音源能力已随 core/qq.js 移除，
// 拉到的曲目由调用方走 leiz 严格换源补齐（酷狗/网易云），不再保留 QQ 源曲目。
'use strict';
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const REF = 'https://y.qq.com/';

function qqPost(url, bodyObj) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      Referer: REF,
      'User-Agent': UA
    };
    const req = https.request(url, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { j = null; }
        resolve({ ok: res.statusCode === 200 && !!j, status: res.statusCode, json: j });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, message: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ ok: false, status: 0, message: '请求超时' }); });
    req.write(data);
    req.end();
  });
}

// 标准化歌曲（对齐 leiz 返回结构，duration 单位=秒）
function normSong(it) {
  const singer = Array.isArray(it.singer) ? it.singer.map((x) => (x && (x.name || x.title)) || '').filter(Boolean) : [];
  const albummid = it.albummid || (it.album && it.album.mid) || '';
  return {
    id: it.songmid || it.mid || '',
    name: it.songname || it.name || '',
    artists: singer,
    album: it.albumname || (it.album && it.album.name) || '',
    duration: Math.round(Number(it.interval) || 0),
    picUrl: albummid ? ('https://y.gtimg.cn/music/photo_new/T002R300x300M000' + albummid + '.jpg') : ''
  };
}

// 分页拉全量歌单，返回 { ok, name, picUrl, desc, songs }
async function playlistAll(disstid) {
  const id = String(disstid || '').trim();
  if (!/^\d{5,}$/.test(id)) return { ok: false, reason: '歌单 ID 无效' };
  const all = [];
  const seen = new Set();
  let name = '', picUrl = '', desc = '';
  const pageSize = 100;
  let begin = 0, hasMore = true;
  while (hasMore && begin < 5000) {
    const body = {
      comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
      req_0: {
        module: 'music.srfDissInfo.aiDissInfo',
        method: 'uniform_get_Dissinfo',
        param: { disstid: Number(id), enc_host_uin: '', tag: 0, userinfo: 1, song_begin: begin, song_num: pageSize }
      }
    };
    const r = await qqPost('https://u.y.qq.com/cgi-bin/musicu.fcg', body);
    const d = r.ok && r.json && r.json.req_0 && r.json.req_0.data;
    if (!d) return { ok: false, reason: '歌单获取失败' };
    if (!name && d.dirinfo) { name = d.dirinfo.title || ''; picUrl = d.dirinfo.pic || ''; desc = d.dirinfo.desc || ''; }
    const songs = Array.isArray(d.songlist) ? d.songlist : [];
    if (!songs.length) break;
    for (const it of songs) {
      const mid = it.mid || it.songmid;
      if (!mid || seen.has(mid)) continue;
      seen.add(mid);
      all.push(normSong(it));
    }
    hasMore = !!d.hasmore;
    if (all.length >= (d.total_song_num || 0) && d.total_song_num > 0) break;
    begin += pageSize;
  }
  // dirinfo.pic 常为空 → 用首曲专辑封面兜底
  const coverUrl = picUrl || (all.length && all[0].picUrl) || '';
  return { ok: all.length > 0, name, picUrl: coverUrl, desc, songs: all };
}

module.exports = { playlistAll };
