// 波点音乐（酷我曲库）官方接口模块 —— 第四音源
// 版权方：北京酷我科技（bd-api.kuwo.cn / search.kuwo.cn / mlyric.kuwo.cn 均为酷我官方域名）
// 能力：
//   搜索   search.kuwo.cn/r.s（vipver=1 才返回完整索引；免费歌/付费歌并存，含 PAY 锁定标记）
//   播放   playbasic 320k 免登录（免费歌直接完整版；付费歌 code=20018）
//          → 20018 时若配置了波点 uid/token：走 App 同款 checkRight+audioUrl（kuwotest 签名）解锁部分歌
//          → 仍失败：按歌名搜同歌可播 rid（PAY=8913032/16515324）再走 playbasic
//          → 兜底 antiserver 128k
//   歌词   mlyric.kuwo.cn f=bodian（免登录，base64 LRC）
// 凭据（uid/token）只存主进程：setState 注入；渲染层永远拿不到
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const state = { uid: '', token: '', devId: '' };
function setState(s) {
  state.uid = (s && s.uid) || '';
  state.token = (s && s.token) || '';
  state.devId = (s && s.devId) || '';
}
function getState() { return { uid: state.uid, token: state.token, devId: state.devId }; }

// 通用 GET（自动尝试 utf8 解码）
function get(url, headers, timeout = 20000) {
  return new Promise((resolve) => {
    let mod;
    try { mod = /^https:/.test(url) ? https : http; } catch { mod = http; }
    const req = mod.get(url, { headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        // 搜索接口偶发 GBK：尝试重新解码
        if (/[\uFFFD]/.test(body)) {
          try { body = Buffer.concat(chunks).toString('gbk'); } catch { /* 保持 utf8 */ }
        }
        resolve({ ok: res.statusCode === 200, status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: '', message: e.message }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, status: 0, body: '', message: '请求超时' }); });
  });
}
// POST JSON
function post(url, bodyStr, headers, timeout = 20000) {
  return new Promise((resolve) => {
    const data = Buffer.from(bodyStr || '', 'utf8');
    const req = https.request(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length }, headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: '', message: e.message }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, status: 0, body: '', message: '请求超时' }); });
    req.write(data);
    req.end();
  });
}

// ---------- 搜索 ----------
// r.s 返回 JS 对象字面量（单引号，非 JSON），用 Function 求值；必须带 vipver=1 才有完整索引
async function search(query, limit) {
  const lmt = Number.isFinite(Number(limit)) ? Math.min(50, Math.max(1, Math.round(Number(limit)))) : 20;
  const url = 'http://search.kuwo.cn/r.s?all=' + encodeURIComponent(String(query || '').trim()) +
    '&ft=music&client=kt&itemset=web_2013&pn=0&rn=' + lmt + '&rformat=json&encoding=utf8&vipver=1';
  const r = await get(url, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
  if (!r.ok) return { ok: false, reason: (r.message || '搜索请求失败') };
  let j = null;
  try { j = new Function('return (' + r.body + ')')(); } catch { j = null; }
  const list = (j && Array.isArray(j.abslist)) ? j.abslist : [];
  if (!list.length) return { ok: false, reason: '未搜索到结果' };
  const out = [];
  // 酷我返回的名称常带 HTML 实体（&nbsp; 等），先解码再入列（否则歌名匹配永远失败）
  const decodeHtml = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  for (const it of list) {
    const rid = String(it.MUSICRID || '').replace(/^MUSIC_/, '');
    const name = decodeHtml(it.NAME || '').trim();
    if (!rid || !name) continue;
    // 排除 11 秒试听片段（PAY=16711935：提示「当前歌只在酷我手机版播放」，会暴露音源）
    if (Number(it.PAY) === 16711935) continue;
    // 过滤非原版标记（伴奏/翻唱/Live/现场/Remix 等）——严格排除，避免混入"加了其他音频"的版本
    if (/\b(伴奏|纯音乐|DJ|KTV|Live|现场|演唱会|翻唱|Remix|串烧|慢摇|铃声|Instrumental|Mashup|音乐剧|电影原声)\b/i.test(name)) continue;
    out.push({
      id: rid,                       // 纯数字 musicId
      name,
      artists: String(decodeHtml(it.ARTIST) || '').split('&').map((x) => x.trim()).filter(Boolean),
      album: decodeHtml(it.ALBUM || ''),
      duration: Math.round(Number(it.DURATION) || 0), // 秒
      picUrl: it.hts_MVPIC || it.MVPIC || it.PIC ||
        (it.web_albumpic_short ? 'https://img1.kuwo.cn/star/albumcover/' + it.web_albumpic_short : '') ||
        (it.web_artistpic_short ? 'https://img1.kuwo.cn/star/albumcover/' + it.web_artistpic_short : ''),
      pay: Number(it.PAY) || 0,      // 16711935=锁定(11s试听)；8913032/16515324/0=可完整播放
      payplay: (Number(it.PAY) === 16711935) ? 1 : 0
    });
  }
  if (!out.length) return { ok: false, reason: '搜索无有效结果' };
  return { ok: true, data: out };
}

// ---------- 播放 ----------
// 酷我 3.9.0 阿里渠道通道(UNM 同源,实测):只带 br+musicId 参数 + plat:ar 头 →
//   免费歌可直接拿 2000kflac(无损 flac)或 320kmp3;付费歌 20018
async function playAdFree(musicId, br) {
  const ts = String(Date.now());
  const pathname = '/api/play/music/v2/audioUrl';
  const str = 'http://bd-api.kuwo.cn' + pathname + '?&br=' + (br || '2000kflac') + '&musicId=' + encodeURIComponent(musicId) + '&timestamp=' + ts;
  const filtered = str.substring(str.indexOf('?') + 1).replace(/[^a-zA-Z0-9]/g, '').split('').sort().join('');
  const sign = crypto.createHash('md5').update('kuwotest' + filtered + pathname).digest('hex');
  const url = str + '&sign=' + sign;
  const hdr = {
    'User-Agent': 'Dart/2.19 (dart:io)',
    'plat': 'ar', 'channel': 'aliopen',
    'devid': String(Math.floor(Math.random() * 1e11)),
    'ver': '3.9.0',
    'Host': 'bd-api.kuwo.cn',
    'qimei36': '1e9970cbcdc20a031dee9f37100017e1840e',
    'X-Forwarded-For': '1.0.1.114'
  };
  const r = await get(url, hdr);
  let j = null;
  try { j = JSON.parse(r.body); } catch { j = null; }
  if (j && j.code === 200 && j.data && (j.data.audioHttpsUrl || j.data.audioUrl)) {
    return { ok: true, url: j.data.audioHttpsUrl || j.data.audioUrl, bitrate: j.data.bitrate, duration: j.data.duration, size: j.data.size, format: j.data.format, via: 'adfree' };
  }
  return { ok: false, code: j && j.code, reason: (j && j.msg) || '播放地址获取失败' };
}

// playbasic 免登录 320k：免费歌直接完整；付费歌 20018
async function playBasic(musicId, format, br) {
  const url = 'https://bd-api.kuwo.cn/api/playbasic/music/v2/audioUrl?musicId=' + encodeURIComponent(musicId) +
    '&format=' + (format || 'mp3') + '&br=' + (br || '320kmp3') + '&uid=&sid=&token=';
  const hdr = {
    'Origin': 'https://h5app.kuwo.cn',
    'Referer': 'https://h5app.kuwo.cn/m/bodian/playMusic.html',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 BoDianMusic',
    'plat': 'h5'
  };
  const r = await get(url, hdr);
  let j = null;
  try { j = JSON.parse(r.body); } catch { j = null; }
  if (j && j.code === 200 && j.data && (j.data.audioHttpsUrl || j.data.audioUrl)) {
    return { ok: true, url: j.data.audioHttpsUrl || j.data.audioUrl, bitrate: j.data.bitrate, duration: j.data.duration, size: j.data.size };
  }
  return { ok: false, code: j && j.code, reason: (j && j.msg) || '播放接口异常' };
}

// App 同款签名：md5("kuwotest" + 排序后字母数字(k=v 全部参数含空值, 不 URL 解码) + pathname)
function appSign(params, pathname) {
  const qs = Object.entries(params).map(([k, v]) => k + '=' + v).join('&');
  const sorted = qs.replace(/[^a-zA-Z0-9]/g, '').split('').sort().join('');
  return crypto.createHash('md5').update('kuwotest' + sorted + pathname).digest('hex');
}
function buildSignedUrl(base, pathname, params) {
  const p = Object.assign({}, params, { timestamp: String(Date.now()) });
  const sign = appSign(p, pathname);
  const qs = Object.entries(p).map(([k, v]) => k + '=' + v).concat('sign=' + sign).join('&');
  return base + pathname + '?' + qs;
}
// App 链路（登录态 + 签名）：checkRight → audioUrl；部分付费歌可解锁（3198090 类）
async function playAppLink(musicId) {
  if (!state.uid || !state.token) return { ok: false, needLogin: true, reason: '未配置账号' };
  const devId = state.devId || '64927edd3d271abc292a31f853e105b1';
  const base = 'https://bd-api.kuwo.cn';
  const head = { 'Host': 'bd-api.kuwo.cn', 'User-Agent': 'Dart/2.19 (dart:io)', 'plat': 'win', 'channel': 'W1', 'devid': devId, 'ver': '1.1.7' };
  const cr = buildSignedUrl(base, '/api/play/music/v2/checkRight', { uid: state.uid, token: state.token, musicId, freeSign: '' });
  const r1 = await get(cr, head);
  // audioUrl 用新 timestamp（App 模式：checkRight 后 100ms 级）
  const au = buildSignedUrl(base, '/api/play/music/v2/audioUrl', { uid: state.uid, token: state.token, devId, musicId, format: 'ogg', br: '300kogg', freeSign: '' });
  const r2 = await get(au, head);
  let j = null;
  try { j = JSON.parse(r2.body); } catch { j = null; }
  if (j && j.code === 200 && j.data && (j.data.audioHttpsUrl || j.data.audioUrl)) {
    return { ok: true, url: j.data.audioHttpsUrl || j.data.audioUrl, bitrate: j.data.bitrate, duration: j.data.duration, size: j.data.size, via: 'app' };
  }
  return { ok: false, code: j && j.code, reason: (j && j.msg) || '播放地址获取失败' };
}

// antiserver 128k 兜底
async function playAntiServer(musicId) {
  const url = 'https://antiserver.kuwo.cn/anti.s?type=convert_url3&rid=MUSIC_' + encodeURIComponent(musicId) +
    '&format=mp3&response=url';
  const r = await get(url, { 'User-Agent': 'Mozilla/5.0' });
  try {
    const j = JSON.parse(r.body);
    if (j && j.url) return { ok: true, url: j.url, bitrate: 128, via: 'anti' };
  } catch { /* 非 JSON 兜底正则 */ }
  const m = r.body.match(/https?:\/\/[^\s"']+/);
  if (m) return { ok: true, url: m[0], bitrate: 128, via: 'anti' };
  return { ok: false, reason: '未找到可播放版本' };
}

// 统一播放入口：无损通道(免费歌 flac) → playbasic 320k → 付费歌(有账号先试解锁) → 同歌可播 rid → antiserver 兜底
async function resolveUrl(musicId, songName, artist) {
  if (!musicId) return { ok: false, reason: '参数错误' };
  const id = String(musicId).replace(/^MUSIC_/, '');
  // 1) 酷我 3.9.0 广告通道：免费歌可直接拿无损 flac(2000kflac)
  const rA = await playAdFree(id, '2000kflac');
  if (rA.ok && rA.format === 'flac') return { ok: true, url: rA.url, bitrate: rA.bitrate || 2000, duration: rA.duration, size: rA.size, via: rA.via, format: rA.format };
  // 2) playbasic 320k（免登录，免费歌完整）
  const rB = await playBasic(id, 'mp3', '320kmp3');
  if (rB.ok && (rB.bitrate || 0) >= 320) return { ok: true, url: rB.url, bitrate: rB.bitrate || 320, duration: rB.duration, size: rB.size, via: 'basic' };
  if (rB.ok) return { ok: true, url: rB.url, bitrate: rB.bitrate || 128, duration: rB.duration, size: rB.size, via: 'basic' }; // 免费歌 128 完整
  if (rA.ok) return { ok: true, url: rA.url, bitrate: rA.bitrate || 128, duration: rA.duration, size: rA.size, via: rA.via, format: rA.format }; // 广告通道 128 兜底
  if (rB.code !== 20018) return rB; // 其他错误（网络/下线）直接返回
  // 2) 付费歌：有波点账号 → App 链路解锁
  if (state.uid && state.token) {
    const rA3 = await playAppLink(id);
    if (rA3.ok) return rA3;
  }
  // 3) 付费歌：同歌可播 rid 换源（按歌名搜，PAY=8913032/16515324 优先）
  const q = ((songName || '') + ' ' + (Array.isArray(artist) ? artist[0] || '' : String(artist || ''))).trim();
  if (q) {
    const s = await search(q, 20);
    if (s.ok && Array.isArray(s.data)) {
      const want = String(songName || '').trim().toLowerCase().replace(/\s+/g, '');
      const arts = (Array.isArray(artist) ? artist : String(artist || '').split('、')).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      // 先挑同歌可播 rid
      for (const it of s.data) {
        if (it.payplay) continue;
        const n = String(it.name || '').trim().toLowerCase().replace(/\s+/g, '');
        if (want && n !== want) continue;
        if (arts.length && !arts.some((a) => it.artists.some((x) => x.toLowerCase().includes(a) || a.includes(x.toLowerCase())))) continue;
        if (it.duration < 100) continue;
        // 该 rid 优先无损通道（免费 rid 可能给 flac），失败再 playbasic 320k，最后 App 链路（有账号时）
        const rA2 = await playAdFree(it.id, '2000kflac');
        if (rA2.ok) return { ok: true, url: rA2.url, bitrate: rA2.bitrate || 2000, duration: rA2.duration, size: rA2.size, via: 'alt-rid', format: rA2.format };
        const rr = await playBasic(it.id, 'mp3', '320kmp3');
        if (rr.ok) return { ok: true, url: rr.url, bitrate: rr.bitrate || 320, duration: rr.duration, size: rr.size, via: 'alt-rid' };
        if (state.uid && state.token) {
          const ra = await playAppLink(it.id);
          if (ra.ok) return ra;
        }
      }
    }
  }
  // 4) antiserver 128k 兜底
  const rA4 = await playAntiServer(id);
  if (rA4.ok) return rA4;
  return { ok: false, reason: '未找到该歌曲的可播放版本' };
}

// ---------- 歌词 ----------
// mlyric f=bodian：q = base64("type=lyric&req=2&lrcx=1&rid=<num>&songname=<urlenc>&artist=<urlenc>&corp=kuwo&fromchannel=bodian")
async function lyrics(musicId, songName, artist) {
  const id = String(musicId || '').replace(/^MUSIC_/, '');
  if (!id) return { ok: false, reason: '参数错误' };
  const payload = 'type=lyric&req=2&lrcx=1&rid=' + id +
    '&songname=' + encodeURIComponent(String(songName || '')) +
    '&artist=' + encodeURIComponent(String(artist || '')) +
    '&corp=kuwo&fromchannel=bodian';
  const q = Buffer.from(payload, 'utf8').toString('base64');
  const url = 'http://mlyric.kuwo.cn/mobi.s?f=bodian&q=' + encodeURIComponent(q) + '&uid=0&token=137acd3e6d0276020741da2ef35a316b';
  const r = await get(url, { 'User-Agent': 'Mozilla/5.0' });
  let j = null;
  try { j = JSON.parse(r.body); } catch { j = null; }
  if (!j || j.code !== 200 || !j.data || !j.data.content) return { ok: false, reason: '歌词获取失败' };
  let lrc = '';
  try { lrc = Buffer.from(j.data.content, 'base64').toString('utf8'); } catch { lrc = ''; }
  if (!lrc.trim()) return { ok: false, reason: '歌词为空' };
  // 取 [offset] 之前的 LRC 主体（content 可能带卡拉OK时间轴，LRC 部分以 [ti:] 或 [00: 开头）
  const firstLine = lrc.split('\n').find((x) => /^\[\d{2}:\d{2}/.test(x));
  if (firstLine) lrc = lrc.slice(lrc.indexOf(firstLine));
  return { ok: true, lyrics: { original: lrc, translated: '' } };
}

// ---------- 歌单（QQ 绑定同步，source=5）----------
// 波点账号自建歌单列表：QQ 绑定后自动同步「QQ音乐收藏的歌曲」等原曲歌单
async function userPlaylists() {
  const pathname = '/api/service/playlist/userCreate';
  const params = { userId: state.uid || '-1', uid: state.uid || '-1', token: state.token || '' };
  const url = buildSignedUrl('https://bd-api.kuwo.cn', pathname, params);
  const head = { 'User-Agent': 'Dart/2.19 (dart:io)', 'plat': 'win', 'channel': 'W1', 'devid': state.devId || '64927edd3d271abc292a31f853e105b1', 'ver': '1.1.7' };
  const r = await get(url, head);
  let j = null;
  try { j = JSON.parse(r.body); } catch { j = null; }
  const list = (j && j.data && Array.isArray(j.data.playLists)) ? j.data.playLists : [];
  if (!list.length) return { ok: false, reason: (j && j.msg) || '未找到可导入的歌单' };
  const out = list.map((p) => ({
    id: String(p.id || ''),
    name: String(p.name || '未命名歌单'),
    musicCount: Number(p.musicCount) || 0,
    picUrl: p.pic || '',
    desc: String(p.description || '')
  })).filter((p) => p.id);
  return { ok: true, data: out };
}

// 歌单歌曲（source=5，分页全量）：返回原曲 rid（QQ 绑定同步的曲目，免费歌直接可播）
async function playlistMusic(pid) {
  const pathname = '/api/service/playlist/' + String(pid).replace(/[^\d]/g, '') + '/musicList';
  const head = { 'User-Agent': 'Dart/2.19 (dart:io)', 'plat': 'win', 'channel': 'W1', 'devid': state.devId || '64927edd3d271abc292a31f853e105b1', 'ver': '1.1.7' };
  const all = [];
  let pn = 1, total = null, name = '', pic = '', desc = '';
  while (true) {
    const params = { source: '5', pn: String(pn), rn: '100', uid: state.uid || '-1', token: state.token || '' };
    const url = buildSignedUrl('https://bd-api.kuwo.cn', pathname, params);
    const r = await get(url, head);
    let j = null;
    try { j = JSON.parse(r.body); } catch { j = null; }
    if (!j || j.code !== 200 || !j.data) return { ok: false, reason: (j && j.msg) || '歌单歌曲获取失败' };
    const d = j.data;
    const list = Array.isArray(d.list) ? d.list : [];
    if (!name) name = String(d.name || '');
    if (!pic) pic = String(d.picUrl || d.pic || (list[0] && list[0].albumPic) || '');
    if (!desc) desc = String(d.description || '');
    if (total === null) total = Number(d.total) || 0;
    for (const s of list) {
      if (!s || !s.id) continue;
      const payInfo = s.payInfo || {};
      const fee = payInfo.feeType || {};
      const payplay = (Number(payInfo.paytype) > 0 || Number(fee.song) > 0 || Number(s.tpay) > 0) ? 1 : 0;
      all.push({
        id: String(s.id),
        name: String(s.name || s.songName || ''),
        artists: Array.isArray(s.artists) ? s.artists.map((a) => a && (a.name || String(a))).filter(Boolean) : (s.artist ? String(s.artist).split(/[&\/]/).map((x) => x.trim()).filter(Boolean) : []),
        album: String(s.album || ''),
        duration: Math.round(Number(s.duration) || 0),
        picUrl: s.albumPic || '',
        payplay
      });
    }
    if (list.length < 100 || all.length >= total || pn >= 20) break;
    pn++;
  }
  if (!all.length) return { ok: false, reason: '歌单内没有歌曲' };
  return { ok: true, data: { name, picUrl: pic, desc, total: total || all.length, songs: all } };
}

module.exports = { setState, getState, search, resolveUrl, lyrics, userPlaylists, playlistMusic, _appSign: appSign, _buildSignedUrl: buildSignedUrl };
