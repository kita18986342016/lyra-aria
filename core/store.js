// 轻量 JSON 持久化存储（曲库索引/歌单/收藏/历史）
// v2：目录自建、损坏回退 .bak、保存失败容错
// v5：数据目录可配置（普适化）——启动时由 main.js 注入 app.getPath('userData')，
//     每台机器/每个系统用户各自独立（歌单/歌曲/下载完全私有）；旧版本（v1.2.8 以前写死
//     D:\MusicPlayerData）由 main.js 的 migrateLegacyData() 一次性迁移到新位置
const fs = require('fs');
const path = require('path');

let DATA_DIR = null; // 未设置时 load/save 直接返回 fallback/数据（极端兜底）

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
  const file = path.join(DATA_DIR, name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 主文件损坏时回退 .bak
    try {
      return JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    } catch {
      return fallback;
    }
  }
}

function save(name, data) {
  if (!DATA_DIR) return data;
  ensureDir();
  const file = path.join(DATA_DIR, name);
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[store] 保存失败:', name, err.message);
  }
  return data;
}

module.exports = { load, save, getDataDir, setDataDir, ensureDir };
