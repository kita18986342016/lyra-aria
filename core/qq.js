// QQ 音乐官方接口模块(纯官方,无第三方 API)
// 搜索: c.y.qq.com/soso/fcgi-bin/search_for_qq_cp(匿名可用,含 payplay)
// 歌单: u.y.qq.com/cgi-bin/musicu.fcg → music.srfDissInfo.aiDissInfo(song_begin/song_num 分页,匿名可用)
// 歌词: c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new(匿名可用,直接返回 LRC)
// 播放: u.y.qq.com/cgi-bin/musicu.fcg → vkey.GetVkeyServer(必须带登录 Cookie,免费歌返回 purl,会员歌为空)
// 凭据(cookie)只存主进程:setState 注入;渲染层永远拿不到
'use strict';
const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const REF = 'https://y.qq.com/';

let qqState = { cookie: '', uin: '' };

function setState(s) {
  qqState = {
    cookie: (s && s.cookie) || '',
    uin: (s && s.uin) || ''
  };
}
function getState() { return { cookie: qqState.cookie, uin: qqState.uin }; }
// 从 cookie 里提取 uin(纯数字 QQ 号)
function parseUin(cookie) {
  const m = String(cookie || '').match(/(?:^|;\s*)uin=(\d+)/);
  return m ? m[1] : '';
}

// GET 通用(json/jsonp 自动解包)
function qqGet(url, withCookie) {
  return new Promise((resolve) => {
    const mod = /^https:/.test(url) ? https : http;
    const headers = { Referer: REF, 'User-Agent': UA };
    if (withCookie && qqState.cookie) headers.Cookie = qqState.cookie;
    const req = mod.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        // jsonp 解包
        const m = body.match(/^[^(]*\((.*)\)\s*;?\s*$/s);
        if (m) body = m[1];
        let j = null;
        try { j = JSON.parse(body); } catch { j = null; }
        resolve({ ok: res.statusCode === 200 && !!j, status: res.statusCode, json: j, raw: body });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, message: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ ok: false, status: 0, message: '请求超时' }); });
  });
}
// POST 通用
function qqPost(url, bodyObj) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      Referer: REF,
      'User-Agent': UA
    };
    if (qqState.cookie) headers.Cookie = qqState.cookie;
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

// 标准化歌曲(对齐 leiz 返回结构,duration 单位=秒)
function normSong(it, extra) {
  const singer = Array.isArray(it.singer) ? it.singer.map((x) => (x && (x.name || x.title)) || '').filter(Boolean) : [];
  const albummid = it.albummid || (it.album && it.album.mid) || '';
  return Object.assign({
    id: it.songmid || it.mid || '',
    name: it.songname || it.name || '',
    artists: singer,
    album: it.albumname || (it.album && it.album.name) || '',
    albummid,
    duration: Math.round(Number(it.interval) || 0), // 秒
    picUrl: albummid ? ('https://y.gtimg.cn/music/photo_new/T002R300x300M000' + albummid + '.jpg') : '',
    payplay: (it.pay && it.pay.payplay) || (it.pay && it.pay.pay_play) || 0
  }, extra || {});
}

// ---------- 搜索(官方 search_for_qq_cp)----------
// 只返回免费歌(payplay=0);n 取大一点保证过滤后有货;返回 {ok, data, filtered}
async function search(query, limit) {
  const lmt = Number.isFinite(Number(limit)) ? Math.min(30, Math.max(1, Math.round(Number(limit)))) : 10;
  // 请求条数:免费歌通常占一部分,取 limit*3 至少 10,上限 30
  const n = Math.min(30, Math.max(10, lmt * 3));
  const url = 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&platform=yqq&hostUin=0&needNewCode=0&catZhida=0&w=' +
    encodeURIComponent(String(query || '').trim()) + '&n=' + n;
  const r = await qqGet(url, false);
  if (!r.ok || !r.json || !r.json.data || !r.json.data.song) {
    return { ok: false, reason: (r.message || 'QQ搜索无结果或接口异常') };
  }
  const list = Array.isArray(r.json.data.song.list) ? r.json.data.song.list : [];
  const free = [];
  let filtered = 0;
  for (const it of list) {
    const pay = (it.pay && it.pay.payplay) || 0;
    if (pay !== 0) { filtered++; continue; }
    const s = normSong(it);
    if (!s.id || !s.name) continue;
    s.source = 'qq';
    free.push(s);
    if (free.length >= lmt) break;
  }
  if (!free.length) return { ok: false, reason: 'QQ 未找到可播放的歌曲' };
  return { ok: true, data: free, filtered };
}

// ---------- 歌单(官方 musicu.fcg aiDissInfo,分页全量)----------
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
      const s = normSong(it);
      s.source = 'qq';
      s.payplay = (it.pay && it.pay.pay_play) || 0; // 0=免费 1=会员
      all.push(s);
    }
    hasMore = !!d.hasmore;
    if (all.length >= (d.total_song_num || 0) && d.total_song_num > 0) break;
    begin += pageSize;
  }
  // dirinfo.pic 常为空 → 用首曲专辑封面兜底
  const coverUrl = picUrl || (all.length && all[0].picUrl) || '';
  return { ok: all.length > 0, name, picUrl: coverUrl, desc, songs: all };
}

// ---------- 歌词(官方 fcg_query_lyric_new,匿名可用)----------
async function lyrics(songmid) {
  if (!songmid) return { ok: false, reason: '参数错误' };
  const url = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + encodeURIComponent(songmid) +
    '&format=json&nobase64=1&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0';
  const r = await qqGet(url, false);
  const j = r.json;
  if (!r.ok || !j || j.retcode !== 0) return { ok: false, reason: 'QQ歌词获取失败' };
  return {
    ok: true,
    lyrics: {
      original: j.lyric || '',
      translated: j.trans || ''
    }
  };
}

// ---------- 播放直链(官方 vkey.GetVkeyServer,必须带登录 Cookie)----------
// 免费歌 → purl 有值;会员歌/未登录 → purl 空
async function resolveUrl(songmid) {
  if (!songmid) return { ok: false, reason: '参数错误' };
  if (!qqState.cookie) return { ok: false, needLogin: true, reason: '未配置 QQ 登录态：请在设置→音源→QQ 登录态粘贴 y.qq.com 的 Cookie' };
  const uin = qqState.uin || '0';
  // 优先 M800(320k),失败退回 M500(128k):一次请求两个 filename,vkey 按序返回
  const filenames = ['M800' + songmid + songmid + '.mp3', 'M500' + songmid + songmid + '.mp3'];
  const guid = String(Math.floor(Math.random() * 9000000000) + 1000000000);
  const body = {
    comm: { uin: Number(uin) || 0, format: 'json', ct: 24, cv: 0 },
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        filename: filenames,
        guid,
        songmid: [songmid],
        songtype: [0],
        uin: String(uin),
        loginflag: 1,
        platform: '20'
      }
    }
  };
  const r = await qqPost('https://u.y.qq.com/cgi-bin/musicu.fcg', body);
  const d = r.ok && r.json && r.json.req_0 && r.json.req_0.data;
  const infos = (d && Array.isArray(d.midurlinfo)) ? d.midurlinfo : [];
  const sip = (d && Array.isArray(d.sip) && d.sip[0]) ? d.sip[0] : '';
  let url = null;
  for (const info of infos) {
    if (info && info.purl) { url = (sip || 'https://isure.stream.qqmusic.qq.com/') + info.purl; break; }
  }
  if (!url) return { ok: false, reason: '该歌曲暂不可播放（QQ 免费歌曲可正常播放）' };
  const lower = url.toLowerCase();
  let ext = '.mp3';
  if (/\.(flac|m4a|mp3|aac)$/.test(lower)) ext = '.' + lower.match(/\.(flac|m4a|mp3|aac)$/)[1];
  return { ok: true, url, ext };
}

module.exports = { setState, getState, parseUin, search, playlistAll, lyrics, resolveUrl };
