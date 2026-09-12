// 网易云官方 API 客户端（登录态增强链路，独立于 LeiZ 代理）
// 来源：revincx/NeteaseCloudMusicApi（weapi 加密）+ 登录与推荐接口调研.md
// 职责：扫码/密码登录、每日推荐、推荐歌单、歌单全量（trackIds → song/detail 分批）
// 凭据由主进程管理（loginState 对象），渲染层不接触 cookie
const crypto = require('crypto');
const https = require('https');

const BASE = 'https://music.163.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REFERER = 'https://music.163.com/';

// ---------- weapi 加密常量（revincx util/crypto.js 全文核对）----------
const AES_KEY = '0CoJUm6Qyw8W8jud'; // presetKey 16B
const AES_IV = '0102030405060708';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ3
7BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvakl
V8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44o
ncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
// eapi（song/url 等用）
const EAPI_KEY = 'e82ckenh8dichen8';
const EAPI_MSG_PREFIX = 'nobody';
const EAPI_MSG_SUFFIX = 'md5forencrypt';
const EAPI_URL_SUFFIX = '-36cd479b6b5-';

function aesEncrypt(text, key, iv = AES_IV) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
}
function rsaEncrypt(secret) {
  // reverse(secret) → RSA_NO_PADDING（补零至 128 字节）→ hex
  const rev = Buffer.from(String(secret).split('').reverse().join(''), 'utf8');
  const padded = Buffer.concat([Buffer.alloc(128 - rev.length), rev]);
  const enc = crypto.publicEncrypt({ key: RSA_PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded);
  return enc.toString('hex');
}
// weapi：text/csrf_token → {params, encSecKey}
function weapi(object) {
  const text = JSON.stringify(object);
  const secret = Array.from({ length: 16 }, () => BASE62[Math.floor(Math.random() * 62)]).join('');
  const params = aesEncrypt(aesEncrypt(text, AES_KEY).toString('base64'), secret).toString('base64');
  return { params, encSecKey: rsaEncrypt(secret) };
}
// eapi：url + text → {params}
function eapi(url, object) {
  const text = JSON.stringify(object);
  const message = EAPI_MSG_PREFIX + url + EAPI_MSG_SUFFIX + text + EAPI_MSG_SUFFIX;
  const digest = crypto.createHash('md5').update(message).digest('hex');
  const data = url + EAPI_URL_SUFFIX + text + EAPI_URL_SUFFIX + digest;
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY), null);
  return { params: Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]).toString('hex').toUpperCase() };
}

// ---------- HTTP ----------
// 网易云老接口的 message/msg 字段是 GBK 编码(UTF-8 解析会乱码,如 8860「请确认是否本人账户」):
// 用原始 Buffer 同时做 UTF-8 / GBK 解码,取 message 含登录相关关键词更多的一版
const MSG_KEYS = ['验证码', '账户', '账号', '登录', '密码', '频繁', '过期', '错误', '成功', '安全', '风险', '本人', '操作', '失败', '网络', '绑定'];
function pickMsg(u, g) {
  if (!u || !g) return u || g;
  const score = (s) => MSG_KEYS.reduce((n, k) => n + (String(s).includes(k) ? 1 : 0), 0);
  const uu = u.message || u.msg, gg = g.message || g.msg;
  if (typeof gg === 'string' && typeof uu === 'string' && score(gg) > score(uu)) return g;
  return u;
}
function post(pathname, form, opts = {}) {
  return new Promise((resolve) => {
    const body = Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const req = https.request(BASE + pathname, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Referer': REFERER,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': opts.cookie || '',
        ...(opts.headers || {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const raw = buf.toString('utf8');
        let j = null, gj = null;
        try { j = JSON.parse(raw); } catch { /* 非 JSON */ }
        try { gj = JSON.parse(new TextDecoder('gbk').decode(buf)); } catch { /* 非 JSON */ }
        j = pickMsg(j, gj);
        resolve({ status: res.statusCode, json: j, raw, cookie: (res.headers['set-cookie'] || []).join('; ') });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: 'ERR ' + e.message, cookie: '' }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, json: null, raw: 'ERR 超时', cookie: '' }); });
    req.write(body);
    req.end();
  });
}
// 带 weapi 加密调官方接口
async function weapiPost(url, data, cookie) {
  const enc = weapi(data);
  return post(url, { params: enc.params, encSecKey: enc.encSecKey }, { cookie });
}
// 带 eapi 加密调接口
async function eapiPost(url, data, cookie) {
  const enc = eapi(url, data);
  return post(url, { params: enc.params }, { cookie });
}

// ---------- 登录状态 ----------
let loginState = { cookie: '', csrf: '', account: null }; // 主进程注入持久化
function setState(s) { loginState = s || { cookie: '', csrf: '', account: null }; }
function getState() { return loginState; }
// 客户端环境 cookie(仿官方 PC 客户端):缺少 os/osver/appver/channel/deviceId 等环境标识会被网易云安全风控拦截(8821 安全环境风险)
const ENV = (() => {
  const rndHex = (n) => { let o = ''; const H = '0123456789ABCDEF'; for (let i = 0; i < n; i++) o += H[Math.floor(Math.random() * 16)]; return o; };
  const rndLower = (n) => { let o = ''; const L = 'abcdefghijklmnopqrstuvwxyz0123456789'; for (let i = 0; i < n; i++) o += L[Math.floor(Math.random() * L.length)]; return o; };
  return {
    deviceId: rndHex(52), WNMCID: rndLower(6) + '.' + Date.now() + '.01.0', NMTID: '00O' + rndHex(38),
    os: 'pc', osver: 'Microsoft-Windows-10-Professional-build-19045-64bit', appver: '3.1.17.204416', channel: 'netease', WEVNSM: '1.0.0'
  };
})();
function cookieFor() {
  let c = loginState.cookie || '';
  const add = [];
  [['os', ENV.os], ['osver', ENV.osver], ['appver', ENV.appver], ['channel', ENV.channel], ['deviceId', ENV.deviceId], ['WNMCID', ENV.WNMCID], ['WEVNSM', ENV.WEVNSM], ['NMTID', ENV.NMTID]].forEach(([k, v]) => {
    if (!new RegExp('(^|;\\s*)' + k + '=').test(c)) add.push(k + '=' + v);
  });
  if (add.length) c = (c ? c + '; ' : '') + add.join('; ');
  if (loginState.csrf && !/__csrf=/.test(c)) c += '; __csrf=' + loginState.csrf;
  return c;
}
// Set-Cookie 清洗:只保留 name=value,丢弃 Max-Age/Expires/Path/Domain 等属性(否则污染 Cookie 头导致会话识别失败 → 验证码 8860)
function cleanSetCookie(c) {
  return String(c || '').split(';').map((s) => s.trim()).filter((s) => /^[^=;]+\=[^=;]+$/.test(s) && !/^(Max-Age|Expires|Path|Domain|HttpOnly|Secure|SameSite|Priority)/i.test(s)).join('; ');
}

// ---------- 扫码登录 ----------
// 匿名注册：扫码/登录前需要有效会话（revincx 部署均有此步），失败不阻塞后续
async function anonimous() {
  const r = await weapiPost('/api/register/anonimous', {}, cookieFor());
  const j = r.json || {};
  if (Number(j.code) !== 200 || !r.cookie) return { ok: false, code: j.code, msg: j.msg || j.message };
  const c = cleanSetCookie(r.cookie);
  if (c && !/MUSIC_A=/.test(c)) { /* 匿名 cookie 名可能为 MUSIC_A，保留原样 */ }
  loginState.cookie = c;
  return { ok: true, cookie: c };
}
async function qrCreate() {
  // weapi 路径 + type 3(手机扫码新版;type1 会被视为旧客户端)
  const r = await weapiPost('/weapi/login/qrcode/unikey', { type: 3 }, cookieFor());
  const unikey = (r.json && r.json.unikey) || (r.json && r.json.data && r.json.data.unikey);
  return { ok: !!unikey, unikey, qrurl: unikey ? `https://music.163.com/login?codekey=${unikey}` : '', msg: r.json && (r.json.msg || r.json.message) };
}
async function qrCheck(unikey) {
  // code: 800 过期 / 801 等待 / 802 已扫待确认 / 803 成功
  const r = await weapiPost('/weapi/login/qrcode/client/login', { key: unikey, type: 3 }, cookieFor());
  const j = r.json || {};
  const code = Number(j.code);
  if (code === 803) {
    // 成功：cookie 在响应 Set-Cookie（旧版）；新版可能 noCookie 只在 body
    const sc = cleanSetCookie(r.cookie || (j.cookie || ''));
    loginState.cookie = sc;
    const m = /__csrf=([^;]+)/.exec(sc);
    if (m) loginState.csrf = m[1];
    return { ok: true, code, cookie: sc };
  }
  return { ok: false, code, msg: j.msg || j.message };
}

// ---------- 密码登录（邮箱，weapi）----------
async function loginByEmail(email, password) {
  const md5pwd = crypto.createHash('md5').update(String(password), 'utf8').digest('hex');
  const r = await weapiPost('/weapi/login', {
    username: email, password: md5pwd, rememberLogin: 'true'
  }, cookieFor());
  const j = r.json || {};
  if (Number(j.code) !== 200) return { ok: false, code: j.code, msg: j.msg || (j.code === 502 ? '账号或密码错误' : '登录失败') };
  // cookie 覆写 os=ios（官方客户端行为）
  let c = cleanSetCookie(r.cookie);
  if (!/os=/.test(c)) c = (c ? c + '; ' : '') + 'os=ios; appver=8.7.01';
  loginState.cookie = c;
  const m = /__csrf=([^;]+)/.exec(c);
  if (m) loginState.csrf = m[1];
  loginState.account = (j.profile && j.profile.nickname) || null;
  return { ok: true, cookie: c, nickname: loginState.account };
}
// ---------- 手机号 + 密码 ----------
async function loginByCellphone(phone, password, countrycode = '86') {
  const md5pwd = crypto.createHash('md5').update(String(password), 'utf8').digest('hex');
  const r = await weapiPost('/weapi/login/cellphone', {
    phone: String(phone), countrycode, password: md5pwd, rememberLogin: 'true'
  }, cookieFor());
  const j = r.json || {};
  if (Number(j.code) !== 200) return { ok: false, code: j.code, msg: j.msg || (j.code === 502 ? '账号或密码错误' : '登录失败') };
  let c = r.cookie;
  if (!/os=/.test(c)) c = (c ? c + '; ' : '') + 'os=ios; appver=8.7.01';
  loginState.cookie = c;
  const m = /__csrf=([^;]+)/.exec(c);
  if (m) loginState.csrf = m[1];
  loginState.account = (j.profile && j.profile.nickname) || null;
  return { ok: true, cookie: c, nickname: loginState.account };
}

// ---------- 手机号 + 验证码登录 ----------
// 发送验证码（sms）——验证码绑定本次匿名会话，必须保存 Set-Cookie 供 login 复用；validate 为人机验证结果（-462 后重试携带）
async function captchaSend(phone, countrycode = '86', validate = '') {
  const data = { cellphone: String(phone), ctcode: countrycode };
  if (validate) data.validate = validate;
  const r = await weapiPost('/weapi/sms/captcha/sent', data, cookieFor());
  const j = r.json || {};
  if (Number(j.code) !== 200) {
    if (Number(j.code) === -462) {
      const d = j.data || {};
      return { ok: false, code: -462, msg: '需要完成安全验证', verify: d, raw: r.raw };
    }
    return { ok: false, code: j.code, msg: j.msg || j.message || '验证码发送失败' };
  }
  if (r.cookie) loginState.cookie = cleanSetCookie(r.cookie); // 匿名会话（验证码与会话绑定，login 必须携带同一 cookie）
  return { ok: true };
}
// 验证码登录(validate 为人机验证滑块结果,-462 后由前端弹窗取得)
async function captchaLogin(phone, captcha, countrycode = '86', validate = '') {
  const data = {
    phone: String(phone), countrycode, captcha: String(captcha), rememberLogin: 'true'
  };
  if (validate) data.validate = validate;
  const r = await weapiPost('/weapi/login/cellphone', data, cookieFor());
  const j = r.json || {};
  if (Number(j.code) !== 200) {
    // -462 需要人机验证(易盾/云盾):返回 verify 数据供前端弹窗完成滑块后重试
    if (Number(j.code) === -462) {
      const d = j.data || {};
      return { ok: false, code: -462, msg: '需要完成安全验证', verify: d, raw: r.raw };
    }
    return { ok: false, code: j.code, msg: j.msg || (j.code === 502 ? '验证码错误或已过期' : '登录失败') };
  }
  let c = cleanSetCookie(r.cookie);
  if (!/os=/.test(c)) c = (c ? c + '; ' : '') + 'os=ios; appver=8.7.01';
  loginState.cookie = c;
  const m = /__csrf=([^;]+)/.exec(c);
  if (m) loginState.csrf = m[1];
  loginState.account = (j.profile && j.profile.nickname) || null;
  return { ok: true, cookie: c, nickname: loginState.account };
}

// ---------- 登录态检查 ----------
async function accountInfo() {
  const r = await weapiPost('/weapi/w/nuser/account/get', {}, cookieFor());
  const j = r.json || {};
  if (Number(j.code) !== 200 || !j.account) return { ok: false };
  return { ok: true, nickname: j.profile && j.profile.nickname, avatar: j.profile && j.profile.avatarUrl };
}

// ---------- 推荐 ----------
// 每日推荐歌曲（需登录）
// 游客态每日推荐：明文公开端点，无需登录（返回通用推荐；登录态同端点自动个性化但走 weapi 链路）
async function guestDaily() {
  const r = await post('/api/v3/discovery/recommend/songs', {}, { cookie: 'NMTID=00O7' });
  const j = r.json || {};
  const list = (j.data && j.data.dailySongs) || [];
  return {
    ok: j.code === 200 && list.length > 0, code: j.code, guest: true,
    songs: list.map((s) => ({
      id: String(s.id), name: s.name, artist: (s.ar || []).map((a) => a.name).join(' / '),
      album: s.al && s.al.name, picUrl: s.al && s.al.picUrl, duration: s.dt,
      reason: s.recommendReason || ''
    }))
  };
}
async function recommendSongs() {
  const r = await weapiPost('/api/v3/discovery/recommend/songs', {}, cookieFor());
  const list = (r.json && r.json.data && r.json.data.dailySongs) || [];
  return {
    ok: r.json && Number(r.json.code) === 200, code: r.json && r.json.code,
    songs: list.map((s) => ({
      id: String(s.id), name: s.name, artist: (s.ar || []).map((a) => a.name).join(' / '),
      album: s.al && s.al.name, picUrl: s.al && s.al.picUrl, duration: s.dt, mv: s.mv
    }))
  };
}
// 每日推荐歌单（需登录）
async function recommendResources() {
  const r = await weapiPost('/weapi/v1/discovery/recommend/resource', {}, cookieFor());
  const list = (r.json && r.json.data && r.json.data.recommend) || [];
  return {
    ok: r.json && Number(r.json.code) === 200, code: r.json && r.json.code,
    playlists: list.map((p) => ({
      id: String(p.id), name: p.name, picUrl: p.picUrl, copywriter: p.copywriter,
      playCount: p.playCount, creator: p.creator && p.creator.nickname
    }))
  };
}
// 个性推荐歌单（匿名可）
async function personalizedPlaylists(limit = 30) {
  const r = await weapiPost('/weapi/personalized/playlist', { limit, total: true, n: 1000 }, cookieFor());
  const list = (r.json && r.json.result) || [];
  return {
    ok: r.json && Number(r.json.code) === 200, code: r.json && r.json.code,
    playlists: list.map((p) => ({
      id: String(p.id), name: p.name, picUrl: p.picUrl, copywriter: p.copywriter,
      playCount: p.playCount, creator: p.creator && p.creator.nickname
    }))
  };
}

// ---------- 歌单全量（trackIds → song/detail 分批）----------
// 我的歌单列表（需登录）
async function myPlaylists() {
  const r = await weapiPost('/weapi/playlist/mine', {}, cookieFor());
  const list = (r.json && r.json.playlist) || [];
  return {
    ok: r.json && Number(r.json.code) === 200, code: r.json && r.json.code,
    playlists: list.map((p) => ({
      id: String(p.id), name: p.name, picUrl: p.coverImgUrl, playCount: p.playCount,
      trackCount: p.trackCount, creator: p.creator && p.creator.nickname
    }))
  };
}
async function playlistDetail(id) {
  // crypto:'api'（非 weapi）——revincx 用 plain POST 表单 id/n/s
  const r = await post('/api/v6/playlist/detail', { id: String(id), n: '100000', s: '8' }, { cookie: cookieFor() });
  const pl = r.json && r.json.playlist;
  return { ok: !!pl, trackIds: (pl && pl.trackIds || []).map((t) => String(t.id)), name: pl && pl.name, cover: pl && pl.coverImgUrl, desc: pl && pl.description };
}
async function songDetail(ids) {
  // /api/v3/song/detail：c='[{"id":..}]'（crypto api 明文表单）
  const c = JSON.stringify(ids.map((id) => ({ id: Number(id) })));
  const r = await post('/api/v3/song/detail', { c }, { cookie: cookieFor() });
  const songs = (r.json && r.json.songs) || [];
  return songs.map((s) => ({
    id: String(s.id), name: s.name, artist: (s.ar || []).map((a) => a.name).join(' / '),
    album: s.al && s.al.name, picUrl: s.al && s.al.picUrl, duration: s.dt
  }));
}
// 歌单全量：detail.trackIds → 分批 song/detail（400/批）→ 拼接
async function playlistSongsAll(id, onProgress) {
  const d = await playlistDetail(id);
  if (!d.ok) return { ok: false, reason: '歌单获取失败' };
  const all = [];
  const CHUNK = 400;
  for (let i = 0; i < d.trackIds.length; i += CHUNK) {
    const chunk = d.trackIds.slice(i, i + CHUNK);
    try {
      const songs = await songDetail(chunk);
      all.push(...songs);
    } catch { /* 单批失败继续 */ }
    if (onProgress) onProgress(all.length, d.trackIds.length);
  }
  return { ok: true, name: d.name, cover: d.cover, desc: d.desc, songs: all, total: d.trackIds.length };
}

// ---------- 播放 URL（eapi）----------
async function songUrl(id, level = 'lossless') {
  const r = await eapiPost('/eapi/song/enhance/player/url/v1', {
    ids: `[${id}]`, level, encodeType: 'flac'
  }, cookieFor());
  const d = r.json && r.json.data && r.json.data[0];
  return { ok: !!(d && d.url), url: d && d.url, code: d && d.code, freeTrial: !!(d && d.freeTrialInfo) };
}

module.exports = {
  setState, getState,
  anonimous, qrCreate, qrCheck, loginByEmail, loginByCellphone, captchaSend, captchaLogin, accountInfo,
  guestDaily, recommendSongs, recommendResources, personalizedPlaylists, myPlaylists,
  playlistSongsAll, playlistDetail, songUrl
};