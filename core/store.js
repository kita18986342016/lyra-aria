// 轻量 JSON 持久化存储（曲库索引/歌单/收藏/历史）
// v2：目录自建、损坏回退 .bak、保存失败容错
// v5：数据目录可配置（普适化）——启动时由 main.js 注入 app.getPath('userData')
// v6：本地多账号——账号级文件（歌单/收藏/历史/凭据/同步）写入 accounts/<id>/ 子目录；
//     设备级文件（accounts-registry.json / current-account.json / library / config / covers）留在根目录。
const fs = require('fs');
const path = require('path');

let DATA_DIR = null; // 未设置时 load/save 直接返回 fallback/数据（极端兜底）
let ACCOUNT_ID = null; // 当前本地账号 id；设置后账号级文件重定向到 accounts/<id>/
const ACCOUNT_FILES = new Set([
  'online-playlists.json', 'favorites.json', 'history.json', 'playlists.json', 'pl-order.json',
  'local-account.json', 'accounts.json', 'sync.json', 'sync-tomb.json', 'sync-devices.json',
  'bili-credentials.json', 'bili-credentials.backup.json'
]);
function setAccount(id) { ACCOUNT_ID = id || null; }
function getAccount() { return ACCOUNT_ID; }
function resolve(name) { return (ACCOUNT_ID && ACCOUNT_FILES.has(name)) ? ('accounts/' + ACCOUNT_ID + '/' + name) : name; }

function ensureDir() {
  if (!DATA_DIR) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function setDataDir(dir) {
  if (typeof dir !== 'string' || !dir) return DATA_DIR;
  DATA_DIR = dir;
  ensureDir();
  return DATA_DIR;
}

function getDataDir() {
  return DATA_DIR;
}

function load(name, fallback) {
  if (!DATA_DIR) return fallback;
  const file = path.join(DATA_DIR, resolve(name));
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    try {
      return JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    } catch {
      return fallback;
    }
  }
}

function save(name, data) {
  if (!DATA_DIR) return data;
  const file = path.join(DATA_DIR, resolve(name));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      let good = false;
      try { JSON.parse(fs.readFileSync(file, 'utf8')); good = true; } catch { /* 坏档 */ }
      if (good) fs.copyFileSync(file, file + '.bak');
    }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[store] 保存失败:', name, err.message);
  }
  return data;
}

module.exports = { load, save, getDataDir, setDataDir, ensureDir, setAccount, getAccount };
