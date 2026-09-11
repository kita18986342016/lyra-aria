// core/sync-server.js — 局域网同步 HTTP 服务（主进程内，不受渲染层 CSP/CORS 限制）
// 协议：GET /ping → {ok,name}；POST /sync（头 X-Sync-Code）body {bundle} → {ok,bundle:merged}
'use strict';
const http = require('http');
const os = require('os');
const dgram = require('dgram');

const DISC_PORT = 41230;
let discSock = null;

let srv = null;
const cfg = { port: 8790, code: '', identity: '', handlers: null };

// 首选网卡探测：UDP connect 只做路由查询不发包，connect 后 address() 即系统访问 target 时
// 会用的本机出口 IP。直接取 os.networkInterfaces() 第一个，在装了 Radmin VPN/Hamachi/VMware
// 等虚拟网卡的机器上会命中虚拟网段（如 Radmin 26.x），手机在真实 WiFi 上连不到 → 必须探测
let primaryIP = '';
function probeIP(target, cb) {
  const s = dgram.createSocket('udp4');
  let done = false;
  const finish = (ip) => { if (done) return; done = true; try { s.close(); } catch (e) {} cb(ip || ''); };
  try {
    s.on('error', () => finish(''));
    s.connect(target || '8.8.8.8', 53, () => { try { const a = s.address(); finish((a && a.address) || ''); } catch (e) { finish(''); } });
    setTimeout(() => finish(''), 500);
  } catch (e) { finish(''); }
}
function lanIPv4() {
  try {
    const ifs = os.networkInterfaces();
    const out = [];
    for (const name of Object.keys(ifs)) for (const it of (ifs[name] || [])) {
      if ((it.family === 'IPv4' || it.family === 4) && !it.internal) out.push(it.address);
    }
    if (!out.length) return primaryIP || '';
    // 枚举兜底排序：优先 RFC1918 私网段（10.x/192.168.x/172.16-31.x）；Radmin 26.x、Hamachi 25.x 等虚拟段排后
    const score = (ip) => (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : 1);
    out.sort((a, b) => score(a) - score(b));
    return (primaryIP && out.indexOf(primaryIP) >= 0) ? primaryIP : out[0];
  } catch { return primaryIP || ''; }
}
// 异步首选地址：先探测默认路由出口，失败退回枚举；target 传客户端 IP 可精确算出「到该客户端走哪块网卡」
function bestIPv4(target, cb) {
  probeIP(target || '8.8.8.8', (ip) => {
    if (ip) { primaryIP = ip; cb(ip); } else cb(lanIPv4());
  });
}

function readBody(req, cb) {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 30 * 1024 * 1024) { req.destroy(); cb('请求体过大'); } });
  req.on('end', () => cb(null, d));
  req.on('error', () => cb('读取失败'));
}

function start({ port = 8790, code = '', identity = '', handlers } = {}) {
  stop();
  cfg.port = port; cfg.code = String(code || ''); cfg.identity = String(identity || ''); cfg.handlers = handlers;
  srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Code');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    const u = (req.url || '').split('?')[0];
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (u === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, name: '深空折韵', identity: cfg.identity, port: cfg.port })); return; }
    if (u === '/sync' && req.method === 'POST') {
      const codeOk = cfg.code && String(req.headers['x-sync-code'] || '') === String(cfg.code);
      // 已绑定设备令牌（一键允许/配对码首次成功后签发）→ 静默同步，不再弹窗
      const tokenHdr = String(req.headers['x-sync-token'] || '');
      const hasToken = !!tokenHdr;
      const tokenOk = hasToken && !!(cfg.handlers && cfg.handlers.verifyToken) && cfg.handlers.verifyToken(tokenHdr);
      readBody(req, (err, body) => {
        if (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: err })); return; }
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: String((e && e.message) || e) })); return; }
        const bundle = parsed && parsed.bundle;
        const respond = (status, obj) => { try { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch (e) { /* 已断开 */ } };
        const doSync = (issue) => {
          try {
            const merged = cfg.handlers && cfg.handlers.onSync ? cfg.handlers.onSync(bundle) : null;
            const out = { ok: true, bundle: merged, identity: cfg.identity };
            if (issue && cfg.handlers && cfg.handlers.issueToken) out.token = cfg.handlers.issueToken((bundle && bundle.device) || 'device');
            respond(200, out);
          }
          catch (e) { respond(500, { ok: false, reason: String((e && e.message) || e) }); }
        };
        if (tokenOk) { doSync(false); return; } // 绑定设备静默同步
        // 配对码正确 → 同步并签发令牌（首次绑定）
        if (codeOk) { doSync(true); return; }
        // 带了令牌但已失效（被 PC 清除/换绑）→ 直接 403 让设备降级重新配对，绝不弹窗骚扰
        if (hasToken) { respond(403, { ok: false, reason: '设备令牌已失效，请在手机端重新配对' }); return; }
        // 一键允许：交给主进程弹窗确认（返回 Promise<{ok,bundle|reason,status}>）
        if (cfg.handlers && cfg.handlers.onRequest) {
          const meta = { ip: String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''), device: (bundle && bundle.device) || 'device' };
          Promise.resolve(cfg.handlers.onRequest(bundle, meta)).then((r) => {
            if (r && r.ok) { // 一键允许 = 批准并绑定：回发令牌，之后该设备免弹窗免码静默同步
              const out = { ok: true, bundle: r.bundle, identity: cfg.identity };
              if (cfg.handlers && cfg.handlers.issueToken) out.token = cfg.handlers.issueToken(meta.device || 'device');
              respond(200, out);
            }
            else respond((r && r.status) || 403, { ok: false, reason: (r && r.reason) || '电脑端已拒绝' });
          }).catch((e) => respond(500, { ok: false, reason: String((e && e.message) || e) }));
          return;
        }
        res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: '配对码错误' }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  srv.on('error', () => { srv = null; });
  srv.listen(cfg.port, '0.0.0.0');
  startDiscovery();
  bestIPv4('8.8.8.8', () => {}); // 预热首选网卡探测（UI 展示与发现应答兜底用）
  return true;
}

function startDiscovery() {
  try {
    stopDiscovery();
    discSock = dgram.createSocket('udp4');
    discSock.on('message', (msg, rinfo) => {
      if (String(msg).indexOf('DSH_SYNC_PING') < 0) return;
      // 应答 IP 按「到该客户端的出口网卡」精确选择：WiFi 上的手机得到 WiFi IP，
      // Radmin 网络里的设备得到 Radmin IP——多网卡机器两端都能扫到
      bestIPv4(rinfo.address, (ip) => {
        try {
          const reply = Buffer.from(JSON.stringify({ name: '深空折韵', ip: ip || lanIPv4(), port: cfg.port, identity: cfg.identity }));
          discSock.send(reply, rinfo.port, rinfo.address);
        } catch (e) { /* 忽略 */ }
      });
    });
    discSock.on('error', () => { discSock = null; });
    discSock.bind(DISC_PORT, '0.0.0.0');
  } catch (e) { discSock = null; }
}
function stopDiscovery() { try { if (discSock) discSock.close(); } catch (e) {} discSock = null; }

function stop() { try { if (srv) srv.close(); } catch (e) {} srv = null; stopDiscovery(); }
function running() { return !!srv; }

module.exports = { start, stop, running, lanIPv4, bestIPv4, DISC_PORT };
