// 酷狗官方 API 客户端（登录态增强链路，独立于 LeiZ 代理）
// 来源：MakcRe/KuGouMusicApi 开源协议调研 + 登录与推荐接口调研.md
// 职责：扫码登录、每日推荐、主页推荐歌单；播放/歌单拉取复用现有 main.js 链路
const crypto = require('crypto');
const https = require('https');

// ---------- 常量（与 main.js fetchKugouCollectAll 同源）----------
const KG_APPID = 1005;
const KG_CLIENTVER = 20489;
const KG_SALT = 'OIlwieks28dk2k092lksi2UIkp';          // android 签名盐
const KG_WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'; // web 签名盐（扫码用）
const KG_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
const KG_EXTRA_HEADERS = { 'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': 1, 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F' };
const X_ROUTER = { everyday: 'everydayrec.service.kugou.com', special: 'specialrec.service.kugou.com', persnfm: 'persnfm.service.kugou.com', login: 'login.user.kugou.com', cloudlist: 'cloudlist.service.kugou.com', pubsongs: 'pubsongs.kugou.com' };

let loginState = { token: '', userid: '', mid: '', dfid: '', vipType: '', vipToken: '', dev: '', account: '' };
function setState(s) { loginState = s || { token: '', userid: '', mid: '', dfid: '', vipType: '', vipToken: '', dev: '', account: '' }; }
function getState() { return loginState; }

function kgGuidV4() {
  const e = () => ((65536 * (1 + Math.random())) | 0).toString(16).substring(1);
  return `${e()}${e()}-${e()}-${e()}-${e()}${e()}${e()}`;
}
// 与 MakcRe calculateMid 一致：MD5(guid) 按 16 进制数转十进制（左高右低）
function kgMid(guid) {
  const digest = crypto.createHash('md5').update(guid, 'utf8').digest('hex');
  let acc = 0n, base = 1n;
  for (let i = digest.length - 1; i >= 0; i--) { acc += BigInt(parseInt(digest.charAt(i), 16)) * base; base *= 16n; }
  return acc.toString();
}
// dev 设备标识：10 位大写字母数字（serverDev = randomString(10).toUpperCase()）
const KG_DEV_POOL = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function kgDev() {
  let out = '';
  for (let i = 0; i < 10; i++) out += KG_DEV_POOL[Math.floor(Math.random() * KG_DEV_POOL.length)];
  return out;
}
// 模块初始化：固定设备 mid（GUID→calculateMid）与 dev，与酷狗源码同构
((function initDevice() {
  try {
    const guid = kgGuidV4();
    loginState.mid = loginState.mid || kgMid(guid);
    loginState.dev = loginState.dev || kgDev();
  } catch { /* 极端兜底：mid 留空由下游重试 */ }
})());
function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }
// android 签名：MD5(盐 + 排序key=value串 + body + 盐)（参数值对象 JSON.stringify）
function signAndroid(params, body = '') {
  const ps = Object.keys(params).sort()
    .map((k) => k + '=' + (typeof params[k] === 'object' ? JSON.stringify(params[k]) : params[k]))
    .join('');
  return md5(KG_SALT + ps + (body || '') + KG_SALT);
}
// web 签名：MD5(盐 + key=value串排序后 + 盐)（无 body，扫码用；注意：对「k=v」字符串排序，非按 key）
function signWeb(params) {
  const ps = Object.keys(params).map((k) => k + '=' + params[k]).sort().join('');
  return md5(KG_WEB_SALT + ps + KG_WEB_SALT);
}
// 播放 URL 的 key：MD5(hash + 57ae12eb... + appid + mid + userid)
function signKey(hash, mid, userid) {
  return md5(hash + '57ae12eb6890223e355ccfcb74edf70d' + KG_APPID + (mid || '') + (userid || ''));
}
// 参数密钥签名（signParamsKey）：MD5(appid + 盐 + clientver + data)——用于 body 内 key 字段
function signParamsKey(data) {
  return md5(`${KG_APPID}${KG_SALT}${KG_CLIENTVER}${data}`);
}

// 统一请求：android 签名 POST（gateway.kugou.com）
// TLS：个别 CDN 子域（如 specialrec.service.kugou.com）证书不含该子域名 → 以 *.kugou.com 域名结尾的放行（其余保持严格校验）
function kugouTlsOk(hostname) {
  return hostname === 'kugou.com' || hostname.endsWith('.kugou.com');
}
function kugouPost(host, path, params, bodyData, extraHeaders = {}) {
  return new Promise((resolve) => {
    const body = typeof bodyData === 'object' ? JSON.stringify(bodyData) : String(bodyData || '');
    const sign = signAndroid(params, body);
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const url = `https://${host}${path}?${qs}&signature=${sign}`;
    const req = https.request(url, {
      method: 'POST',
      checkServerIdentity: (hostname, cert) => (kugouTlsOk(hostname) ? undefined : require('tls').checkServerIdentity(hostname, cert)),
      headers: {
        'User-Agent': KG_UA,
        'Content-Type': 'application/json;charset=UTF-8',
        // 设备标识头（MakcRe request.js 同构）：验证码/登录等接口按 mid 绑定设备，缺了会被拒
        dfid: params.dfid || '-',
        mid: params.mid || '',
        clienttime: params.clienttime,
        ...KG_EXTRA_HEADERS,
        ...(loginState.token ? { 'KG-Token': loginState.token } : {}),
        ...extraHeaders
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(raw); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j, raw, cookie: (res.headers['set-cookie'] || []).join('; ') });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: 'ERR ' + e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, json: null, raw: 'ERR 超时' }); });
    req.write(body);
    req.end();
  });
}
// web 签名 GET（扫码接口）
function kugouWebGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', 'Referer': 'https://login-user.kugou.com/' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(raw); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j, raw });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: 'ERR ' + e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, json: null, raw: 'ERR 超时' }); });
  });
}

// ---------- 扫码登录 ----------
// 默认参数注入（与 MakcRe request.js 一致：dfid/mid/uuid/appid/clientver/clienttime；web 签名同样带）
function defaultParams(over = {}) {
  return Object.assign({
    dfid: loginState.dfid || '-',
    mid: loginState.mid,
    uuid: '-',
    appid: KG_APPID,
    clientver: KG_CLIENTVER,
    clienttime: Math.floor(Date.now() / 1000)
  }, over);
}
async function qrCreate() {
  // 源码 login_qr_key.js：appid 参数覆盖为 1001（非 web 类型），qrcode_txt 带 appid 前缀
  const params = defaultParams({
    appid: 1001,
    type: 1,
    plat: 4,
    qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${KG_APPID}&`,
    srcappid: 2919
  });
  params.signature = signWeb(params);
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const r = await kugouWebGet(`https://login-user.kugou.com/v2/qrcode?${qs}`);
  const key = r.json && r.json.data && r.json.data.qrcode;
  return { ok: !!key, key, qrurl: key ? `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}` : '', raw: r.raw.slice(0, 200) };
}
async function qrCheck(key) {
  // data.status: 0=过期 1=等待 2=待确认 4=成功（token/userid）
  const params = defaultParams({
    appid: 1005, plat: 4, srcappid: 2919, qrcode: key, dev: loginState.dev || 0
  });
  params.signature = signWeb(params);
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const r = await kugouWebGet(`https://login-user.kugou.com/v2/get_userinfo_qrcode?${qs}`);
  const d = r.json && r.json.data;
  const status = Number(d && d.status);
  if (status === 4) {
    loginState.token = d.token || '';
    loginState.userid = String(d.userid || '');
    loginState.vipType = d.vip_type || '';
    loginState.vipToken = d.vip_token || '';
    loginState.account = d.user_name || loginState.account || '';
    return { ok: true, status, token: loginState.token, userid: loginState.userid, nickname: d.user_name || '' };
  }
  const MAP = { 0: '二维码过期', 1: '等待扫码', 2: '已扫码待确认' };
  return { ok: false, status, msg: MAP[status] || ('未知状态 ' + status), raw: r.raw.slice(0, 150) };
}

// ---------- 推荐 ----------
// 每日推荐歌曲（需登录态；带 token/userid）
async function recommendSongs() {
  const params = {
    appid: KG_APPID, clienttime: Math.floor(Date.now() / 1000), mid: loginState.mid,
    platform: 'android', userid: loginState.userid, dfid: loginState.dfid
  };
  const r = await kugouPost(X_ROUTER.everyday, '/everyday_song_recommend', params, {});
  const list = (r.json && r.json.data) || [];
  return {
    ok: r.json && Number(r.json.status) === 1, status: r.json && r.json.status,
    songs: list.map((s) => ({
      hash: s.hash, name: s.filename || s.songname || '', artist: s.singername || '',
      album: s.album_name || '', cover: (s.cover || '').replace('{size}', '400'),
      duration: s.duration || 0
    }))
  };
}
// 主页推荐歌单（top_playlist.js：specialrec.service.kugou.com/v2/special_recommend）
// 注意：body 内 key = signParamsKey(clienttime)，android 签名覆盖整个 body；params 为默认注入
async function recommendPlaylists(categoryid = 0, page = 1, pagesize = 30) {
  const dateTime = Math.floor(Date.now() / 1000).toString();
  const body = {
    appid: KG_APPID,
    mid: loginState.mid,
    clientver: KG_CLIENTVER,
    platform: 'android',
    clienttime: dateTime,
    userid: loginState.userid || 0,
    module_id: 1,
    page,
    pagesize,
    key: signParamsKey(dateTime),
    special_recommend: {
      withtag: 1, withsong: 1, sort: 1, ugc: 1, is_selected: 0, withrecommend: 1, area_code: 1, categoryid
    },
    req_multi: 1,
    retrun_min: 5,
    return_special_falg: 1
  };
  const r = await kugouPost(X_ROUTER.special, '/v2/special_recommend', defaultParams(), body);
  let list = (r.json && r.json.data && (r.json.data.special_list || r.json.data.info)) || [];
  if (!Array.isArray(list)) list = []; // 偶发响应结构异常时兜底，避免 map 崩溃
  return {
    ok: r.json && Number(r.json.status) === 1, status: r.json && r.json.status, raw: (r.raw || '').slice(0, 200),
    hasNext: !!(r.json && r.json.data && r.json.data.has_next),
    playlists: list.map((p) => ({
      gcid: p.global_collection_id, name: p.specialname || p.name || '',
      img: (p.imgurl || p.flexible_cover || p.img || '').replace('{size}', '400').replace(/^http:/, 'https:'),
      count: p.collectcount || p.list_init || 0, creator: p.nickname || '', desc: p.intro || ''
    }))
  };
}

// ---------- 手机验证码登录（官方接口：login.user.kugou.com / loginserviceretry.kugou.com） ----------
// 来源：MakcRe/KuGouMusicApi 的 captcha_sent.js + login_cellphone.js（标准版 appid=1005/clientver=20489）
// 加密：AES-256-CBC(参数密钥为 md5(随机16字符) 前 32 hex 字符的 UTF8 字节) + RSA-1024 原始模幂(左补零)
const KG_RSA_PEM = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB\n-----END PUBLIC KEY-----';
let kgRsa = null; // { n: BigInt, e: BigInt }
function kgParseRsa() {
  if (kgRsa) return kgRsa;
  const der = Buffer.from(KG_RSA_PEM.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  const read = (buf, off) => {
    const tag = buf[off];
    let len = buf[off + 1], lenBytes = 0;
    if (len & 0x80) { lenBytes = len & 0x7f; len = 0; for (let i = 0; i < lenBytes; i++) len = len * 256 + buf[off + 2 + i]; }
    return { tag, start: off + 2 + lenBytes, end: off + 2 + lenBytes + len };
  };
  let t = read(der, 0);              // SEQUENCE
  let alg = read(der, t.start);      // AlgorithmIdentifier
  let bits = read(der, alg.end);     // BIT STRING
  let rsa = read(der, bits.start + 1); // 跳过 unused bits 计数
  let ni = read(der, rsa.start);     // INTEGER n（可能有前导 00）
  let ei = read(der, ni.end);        // INTEGER e
  let nb = der.slice(ni.start, ni.end);
  if (nb[0] === 0) nb = nb.slice(1);
  kgRsa = { n: BigInt('0x' + nb.toString('hex')), e: BigInt('0x' + der.slice(ei.start, ei.end).toString('hex')) };
  return kgRsa;
}
// RSA-1024 原始模幂（无 padding，明文左对齐补零到 128 字节）→ 256 位大写 hex
// 注意：必须左对齐（MakcRe crypto.js padded.set(buffer) 从头填充）；右对齐会让服务端从头解析失败 → 20006
// BigInt 无 modPow，用二进制指数展开（e=65537 固定，循环次数 = e 的位数）
function kgRsaEncrypt(str) {
  const { n, e } = kgParseRsa();
  const buf = Buffer.from(String(str), 'utf8');
  const padded = Buffer.alloc(128);
  if (buf.length > 128) throw new Error('RSA 明文超长');
  buf.copy(padded, 0);
  const m = BigInt('0x' + padded.toString('hex'));
  let result = 1n, base = m % n, exp = e;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % n;
    exp >>= 1n;
    if (exp > 0n) base = (base * base) % n;
  }
  return result.toString(16).padStart(256, '0').toUpperCase();
}
// AES-256-CBC：key=md5(tempKey) 前 32 个 hex 字符的 UTF8 字节；iv=key 后 16 个字符
function kgAesEncrypt(data, tempKey) {
  const keyHex = md5(tempKey);
  const key = Buffer.from(keyHex, 'utf8');
  const iv = Buffer.from(keyHex.substring(16), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(String(data), 'utf8'), cipher.final()]).toString('hex');
}
function kgAesDecrypt(hex, tempKey) {
  const keyHex = md5(tempKey);
  const key = Buffer.from(keyHex, 'utf8');
  const iv = Buffer.from(keyHex.substring(16), 'utf8');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8');
}
function kgRand16() {
  let out = '';
  const pool = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i++) out += pool[Math.floor(Math.random() * pool.length)];
  return out;
}
// 发送短信验证码（businessid=5 通用业务；plat=3；无需登录态）
async function captchaSend(mobile) {
  const body = { businessid: 5, mobile: String(mobile || ''), plat: 3 };
  const r = await kugouPost('login.user.kugou.com', '/v7/send_mobile_code', defaultParams(), body);
  const ok = r.json && Number(r.json.status) === 1;
  return { ok, reason: ok ? '' : (r.json && r.json.error_msg) || '验证码发送失败', count: r.json && r.json.data && r.json.data.count };
}
// 验证码登录：AES(RSA(AES密钥)) 包裹 mobile+code → /v7/login_by_verifycode
async function captchaLogin(mobile, code) {
  const dateTime = Date.now();
  const aesKey = kgRand16();
  const encrypt = kgAesEncrypt(JSON.stringify({ mobile: String(mobile || ''), code: String(code || '') }), aesKey);
  const m = String(mobile || '');
  const dataMap = {
    plat: 1,
    support_multi: 1,
    t1: 0,
    t2: 0,
    clienttime_ms: dateTime,
    mobile: m.length >= 11 ? m.substring(0, 2) + '*****' + m.substring(10, 11) : m, // 11 位脱敏：13*****0（MakcRe 同构；传完整号会被服务端拒绝）
    key: signParamsKey(dateTime),
    pk: kgRsaEncrypt(JSON.stringify({ clienttime_ms: dateTime, key: aesKey })),
    params: encrypt,
    t3: 'MCwwLDAsMCwwLDAsMCwwLDA='
  };
  const r = await kugouPost('loginserviceretry.kugou.com', '/v7/login_by_verifycode', defaultParams(), dataMap, {
    'support-calm': '1',
    'User-Agent': 'Android16-1070-11440-130-0-LOGIN-wifi'
  });
  if (r.json && Number(r.json.status) === 1) {
    let d = r.json.data || {};
    try {
      if (d.secu_params) {
        const t = kgAesDecrypt(d.secu_params, aesKey);
        let tj = null;
        try { tj = JSON.parse(t); } catch { /* 非 JSON */ }
        d = Object.assign({}, d, tj || { token: t });
      }
    } catch { /* 解密失败不致命 */ }
    loginState.token = d.token || loginState.token || '';
    loginState.userid = String(d.userid || loginState.userid || '');
    loginState.vipType = d.vip_type || loginState.vipType || '';
    loginState.vipToken = d.vip_token || loginState.vipToken || '';
    loginState.account = d.nickname || d.user_name || loginState.account || '';
    const nickname = d.nickname || d.user_name || '';
    return { ok: !!loginState.token, token: loginState.token, userid: loginState.userid, nickname, vipType: loginState.vipType };
  }
  return { ok: false, reason: (r.json && (r.json.error_msg || r.json.msg)) || '登录失败（验证码错误或已过期）', code: r.json && r.json.error_code, raw: (r.raw || '').slice(0, 120) };
}

// 用户自建歌单列表（cloudlist /v7/get_all_list；android 签名，需登录态 userid+token；MakcRe user_playlist 同构）
async function myPlaylists(page = 1, pagesize = 100) {
  const s = loginState;
  if (!(s.token && s.userid)) return { ok: false, reason: '未登录' };
  const body = { userid: Number(s.userid), token: s.token, total_ver: 979, type: 2, page, pagesize };
  const params = defaultParams({ plat: 1, userid: Number(s.userid), token: s.token });
  const r = await kugouPost(X_ROUTER.cloudlist, '/v7/get_all_list', params, body);
  const j = r.json;
  const d = j && (j.data || j);
  const list = d && (d.list || d.info || d.lists || d.special);
  if (!Array.isArray(list)) return { ok: false, reason: '歌单列表获取失败' + (j && j.error_code ? '（' + j.error_code + '）' : '') };
  return {
    ok: true,
    playlists: list.map((p) => ({
      id: String(p.gcid || p.global_collection_id || p.specialid || p.id || ''),
      name: p.name || p.list_name || '',
      picUrl: p.imgurl || p.img || p.pic || '',
      trackCount: Number(p.count || p.music_count || p.track_count || 0),
      creator: ''
    })).filter((x) => x.id)
  };
}
module.exports = { setState, getState, kgMid, kgGuidV4, signAndroid, signKey, signParamsKey, qrCreate, qrCheck, recommendSongs, recommendPlaylists, myPlaylists, captchaSend, captchaLogin };