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

function lanIPv4() {
  try {
    // 真实出口地址 = 与默认路由网关同网段的网卡地址。按「第一个非内部 IPv4」取会把
    // VMware/Hyper-V 虚拟网卡（VMnet 常为 192.168.x.1）排最前 → 设置页/UDP 应答给出
    // 设备根本连不通的假地址（2026-09-11 实际事故：手机被导向 VMnet1 地址连不上）。
    const ifs = os.networkInterfaces();
    const cands = [];
    for (const name of Object.keys(ifs)) for (const it of (ifs[name] || [])) {
      if ((it.family === 'IPv4' || it.family === 4) && !it.internal) cands.push({ name, address: it.address });
    }
    if (!cands.length) return '';
    const gw = defaultGatewayIp(); // 可能为空（无外网时）
    if (gw) {
      const seg = gw.split('.').slice(0, 3).join('.');
      const same = cands.find((c) => c.address.startsWith(seg + '.'));
      if (same) return same.address; // 与网关同网段 → 就是真上网网卡
    }
    // 兜底排序：真实物理常见前缀（192.168/10.）优先于虚拟网段；再退回第一个
    const phys = cands.find((c) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.address));
    return (phys || cands[0]).address;
  } catch { return ''; }
}
let _gwCache = { at: 0, ip: '' };
function defaultGatewayIp() {
  if (Date.now() - _gwCache.at < 30000) return _gwCache.ip; // 30s 缓存，避免频繁 exec
  try {
    const out = require('child_process').execSync('route print -4 0.0.0.0', { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    // route print 输出里 0.0.0.0 行：网络目标 0.0.0.0 网掩码 0.0.0.0 网关 …（取活动路由的网关列）
    const m = out.split(/\r?\n/).find((l) => /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}\.){3}\d{1,3}/.test(l));
    const ip = m ? (m.trim().split(/\s+/)[2] || '') : '';
    _gwCache = { at: Date.now(), ip };
    return ip;
  } catch { _gwCache = { at: Date.now(), ip: '' }; return ''; }
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
  return true;
}

function startDiscovery() {
  try {
    stopDiscovery();
    discSock = dgram.createSocket('udp4');
    discSock.on('message', (msg, rinfo) => {
      try {
        if (String(msg).indexOf('DSH_SYNC_PING') < 0) return;
        const reply = Buffer.from(JSON.stringify({ name: '深空折韵', ip: lanIPv4(), port: cfg.port, identity: cfg.identity }));
        discSock.send(reply, rinfo.port, rinfo.address);
      } catch (e) { /* 忽略 */ }
    });
    discSock.on('error', () => { discSock = null; });
    discSock.bind(DISC_PORT, '0.0.0.0');
  } catch (e) { discSock = null; }
}
function stopDiscovery() { try { if (discSock) discSock.close(); } catch (e) {} discSock = null; }

function stop() { try { if (srv) srv.close(); } catch (e) {} srv = null; stopDiscovery(); }
function running() { return !!srv; }

module.exports = { start, stop, running, lanIPv4, DISC_PORT };
