// 深空折韵 主进程（v2：单实例/IPC 校验/调和/缓存/媒体会话支持）
const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, dialog, nativeImage, shell, session, screen, safeStorage, protocol, desktopCapturer, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { parseFile } = require('music-metadata');
const NodeID3 = require('node-id3');
const crypto = require('crypto');
const { scanLibrary, SCAN_VERSION } = require('./core/scanner');
const store = require('./core/store');
const { importSonglist } = require('./core/songlist');
const lyrics = require('./core/lyrics');
const covers = require('./core/covers');
// ===== Wallpaper Engine 集成（Ported from Mineradio 2.2.0, GPL-3.0, desktop/main.js + desktop/wallpaper-engine-*.js）=====
const { WallpaperEngineLibrary, registerWallpaperEngineScheme } = require('./desktop/wallpaper-engine-library');
const { WallpaperEngineRuntime } = require('./desktop/wallpaper-engine-runtime');
const { FullDesktopModeRuntime } = require('./desktop/full-desktop-mode-runtime');
const { nativeWindowHandleDecimal } = require('./desktop/wallpaper-mode-runtime');
// 特权协议必须在 app ready 前注册（mineradio-wallpaper:// = WE 壁纸封面/预览媒体流，带 token 鉴权）
registerWallpaperEngineScheme(protocol);
// 特权协议必须在 app ready 前注册（dsh-mediapipe:// = 手势识别 MediaPipe 本地资产，Ported from
// Mineradio 2.2.0 手势子系统的本地化配套；DSH 页面为 file:，renderer 的 fetch/XHR 无法取 file:
// 子资源（Chromium 限制），wasm/tflite/binarypb/.data 必须经专用只读协议；handler 见 app.whenReady）
protocol.registerSchemesAsPrivileged([{
  scheme: 'dsh-mediapipe',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

// Windows 任务栏/通知归属：不设 AppUserModelID 时任务栏右键菜单显示 "Electron"，
// 设为与 build.appId 一致的应用 ID（配合安装版快捷方式可正确显示「深空折韵」）
if (process.platform === 'win32') app.setAppUserModelId('com.lyraaria.musicplayer');
// 自动更新（electron-updater，GitHub Release 源；开发模式/未配置发布源时静默降级）
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false; // 先通知用户，再手动下载
  autoUpdater.autoInstallOnAppQuit = true;
} catch { autoUpdater = null; }

// 数据盘探测（ready 前执行）：用户偏好数据放 D 盘（D:\MusicPlayerData，系统盘 C 不占用、
// 重装系统不丢）；D 盘可用就用它；不可用（无 D 盘/不可写）时回退系统用户数据目录
// %APPDATA%\<应用名>——别人机器上自动落到他们自己的用户目录，数据完全私有隔离
function probeDataRoot() {
  const legacy = 'D:\\MusicPlayerData';
  try {
    fs.mkdirSync(legacy, { recursive: true });
    const probe = path.join(legacy, '.probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return legacy;
  } catch {
    return null; // D 盘不可用
  }
}
const DATA_ROOT = probeDataRoot() || null;
if (DATA_ROOT) {
  // 与旧版一致：Electron/Chromium 运行时缓存（Cache/GPUCache/Local Storage 等）也放 D 盘（须在 app ready 前）
  app.setPath('userData', path.join(DATA_ROOT, 'userdata'));
}
// 隔离测试实例（DSH_TEST_INSTANCE=1）：换 userData → 单实例锁、Local Storage 与正式实例互不干扰，
// 供自动化 CDP 测试与正式实例并行运行（数据目录同样隔离，见 main() 内 store.setDataDir）。
// DSH_TEST_SLOT=2/3/... 可再开多个互不冲突的隔离实例（userData 后缀不同，锁互不干扰）
if (process.env.DSH_TEST_INSTANCE) {
  app.setPath('userData', app.getPath('userData') + '-test' + (process.env.DSH_TEST_SLOT || ''));
}
// 数据根（模块级引用）：main() 里 store.setDataDir() 之后即为最终数据目录（D 盘或 %APPDATA%）
function dataRoot() {
  return store.getDataDir() || app.getPath('userData');
}
// 账号级文件路径：有当前账号时归入 accounts/<id>/ 子目录（与 store 的账号作用域一致）
function accScopedPath(name) {
  const a = store.getAccount();
  return path.join(dataRoot(), a ? ('accounts/' + a) : '', name);
}
// AppUserModelID：与 SMTC 会话/任务栏图标关联（Win11 媒体浮出需应用身份匹配）
app.setAppUserModelId('com.lyraaria.musicplayer');
// 启用 Chromium 系统媒体会话集成：Win11 任务栏全局媒体浮出（Edge 同款机制）依赖
// GlobalMediaControls/MediaSessionService 特性——Electron 默认可能禁用（此前 hover 无浮出的关键疑点）
try { app.commandLine.appendSwitch('enable-features', 'GlobalMediaControls,MediaSessionService'); } catch {}

// 缩略图调试日志开关：生产默认关闭（环境变量 DSH_THUMB_LOG=1 可开）；_thumb.log 不再无限增长
const THUMB_DEBUG = !!process.env.DSH_THUMB_LOG;
const _origAppendFileSync = fs.appendFileSync.bind(fs);
fs.appendFileSync = (f, ...rest) => {
  if (!THUMB_DEBUG && String(f).includes('_thumb.log')) return;
  return _origAppendFileSync(f, ...rest);
};

// ===== W-13 A：退出/生命周期取证日志（落盘）=====
// 为什么必须落盘：打包成 GUI 后 stdout 无终端，退出相关告警此前只走 console.warn = 写进黑洞 ——
// 这正是 2026-09-24「无窗僵尸进程」抓不到真凶的直接原因（见 报告/DSH/W-12施工报告 与 W-13 单）。
// 文件名刻意不用 _thumb.log（上面那段猴子补丁会在非 DSH_THUMB_LOG 时静默丢弃含该名的写入）。
// 大小上限 512KB，超限轮换一次到 _shutdown.1.log（避免 _thumb.log 当年的无限增长）。
// 生产默认开启（不靠环境变量），否则永远抓不到。
const SHUTDOWN_LOG_MAX = 512 * 1024;
function shutLog(tag, extra) {
  try {
    const p = path.join(dataRoot(), '_shutdown.log');
    try { if (fs.statSync(p).size > SHUTDOWN_LOG_MAX) fs.renameSync(p, path.join(dataRoot(), '_shutdown.1.log')); } catch { /* 首次写入或轮换失败：忽略 */ }
    fs.appendFileSync(p, '[' + new Date().toISOString() + '] pid=' + process.pid + ' ' + tag + (extra === undefined ? '' : ' ' + extra) + '\n', 'utf8');
  } catch { /* 日志失败绝不影响主流程 */ }
}

// ---- 任务栏缩略图：封面原生注入（Hermes 方案：HAS_ICONIC_BITMAP + WM_DWMSENDICONICTHUMBNAIL 0x0323 响应式）----
// DwmSetIconicThumbnail 是响应式 API：只能在收到 0x0323 消息的处理器里调用（主动调恒 E_INVALIDARG——已实测）
// 位图必须是 32bpp DIB（CreateDIBSection + SetDIBits 填充，全 Buffer 传参——koffi void** 输出不可靠）
let iconicThumb = null; // { koffi, DwmSetWindowAttribute, DwmSetIconicThumbnail, CreateDIBSection, CreateCompatibleDC, SetDIBits, DeleteDC, DeleteObject }
let thumbDIB = null; // 渲染层预生成的封面 DIB：{ buf: Buffer, w, h }（32bpp 预乘 RGBA）
let defaultThumbDIB = null; // 无封面时的兜底深色图（保证"任何情况下缩略图都有图"）
function ensureDefaultThumbDIB() {
  if (defaultThumbDIB) return defaultThumbDIB;
  try {
    const SIZE = 320;
    const buf = Buffer.alloc(SIZE * SIZE * 4);
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = 0x1e; buf[i + 1] = 0x22; buf[i + 2] = 0x2e; buf[i + 3] = 255; // 深蓝灰
    }
    defaultThumbDIB = { buf, w: SIZE, h: SIZE };
  } catch {}
  return defaultThumbDIB;
}
try {
  const koffi = require('koffi');
  const dwm = koffi.load('dwmapi.dll');
  const gdi = koffi.load('gdi32.dll');
  iconicThumb = {
    koffi,
    DwmSetWindowAttribute: dwm.func('int DwmSetWindowAttribute(void*, int, void*, int)'),
    DwmGetWindowAttribute: dwm.func('int DwmGetWindowAttribute(void*, int, void*, int)'),
    DwmSetIconicThumbnail: dwm.func('int DwmSetIconicThumbnail(void*, void*, unsigned int)'),
    DwmSetIconicLivePreviewBitmap: dwm.func('int DwmSetIconicLivePreviewBitmap(void*, void*, void*, unsigned int)'),
    DwmInvalidateIconicBitmaps: dwm.func('int DwmInvalidateIconicBitmaps(void*)'),
    CreateDIBSection: gdi.func('void* CreateDIBSection(void*, void*, unsigned int, void*, void*, unsigned int)'),
    CreateCompatibleDC: gdi.func('void* CreateCompatibleDC(void*)'),
    SetDIBits: gdi.func('int SetDIBits(void*, void*, unsigned int, unsigned int, void*, void*, unsigned int)'),
    DeleteDC: gdi.func('int DeleteDC(void*)'),
    DeleteObject: gdi.func('int DeleteObject(void*)')
  };
} catch (e) { console.error('[播放器] 缩略图原生注入不可用:', e.message); }

// ===== 缓存存储设置（Ported from Mineradio 2.2.0, GPL-3.0, desktop/main.js:280-461 + 4136-4165）=====
// 差异说明：本项目不改重 Chromium sessionData/缓存路径（避免老用户登录态迁移丢失），
// 歌词/节拍行指向缓存根下预留目录（当前未写入，占用如实显示）；WE 行指向本项目 WE 运行时真实缓存。
const DSH_CACHE_SETTINGS_FILE = 'cache-settings.json';
let dshCacheSettings = null;
function dshDefaultCacheRootPath() {
  // 数据根在 D 盘（见 probeDataRoot）；缓存根默认跟数据根同盘同父，D 盘不可用则退回 userData
  const dataDir = store.getDataDir();
  if (dataDir && /^[A-Za-z]:\\/.test(dataDir)) return path.join(dataDir, 'cache');
  return path.join(app.getPath('userData'), 'cache');
}
function dshNormalizeCacheRootPath(value) {
  const fallback = dshDefaultCacheRootPath();
  const candidate = String(value || '').trim();
  if (!candidate) return fallback;
  try { return path.resolve(candidate); } catch (_) { return fallback; }
}
function dshNormalizeCacheSettings(value) {
  const rootPath = dshNormalizeCacheRootPath(value && value.rootPath);
  return {
    version: 1,
    rootPath,
    lyricsPath: path.join(rootPath, 'lyrics'),
    chromiumPath: app.getPath('sessionData'),
    beatmapsPath: path.join(rootPath, 'beatmaps'),
    nativePath: path.join(rootPath, 'native-helper-temp'),
  };
}
function dshReadCacheSettings() {
  try {
    const file = path.join(app.getPath('userData'), DSH_CACHE_SETTINGS_FILE);
    const parsed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    return dshNormalizeCacheSettings(parsed);
  } catch (error) {
    console.warn('[CacheSettings] read failed:', error.message);
    return dshNormalizeCacheSettings(null);
  }
}
function dshWriteCacheSettings(settings) {
  const normalized = dshNormalizeCacheSettings(settings);
  const file = path.join(app.getPath('userData'), DSH_CACHE_SETTINGS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tempFile, file);
  return normalized;
}
function dshEnsureCacheDirectories(settings) {
  // 目录不可达（U 盘拔出/网络盘休眠）不得阻止启动：保持用户保存值，运行期回退 userData 下的稳定目录
  const normalized = dshNormalizeCacheSettings(settings);
  try {
    for (const dir of [normalized.lyricsPath, normalized.beatmapsPath, normalized.nativePath]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return normalized;
  } catch (error) {
    const fallback = dshNormalizeCacheSettings({ rootPath: path.join(app.getPath('userData'), 'cache-fallback') });
    console.warn('[CacheSettings] cache root unavailable, using startup fallback:', error.message);
    for (const dir of [fallback.lyricsPath, fallback.beatmapsPath, fallback.nativePath]) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* 忽略 */ }
    }
    return fallback;
  }
}
async function dshDirectoryUsageBytes(directory) {
  let total = 0;
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) return walk(entryPath);
        if (entry.isFile()) {
          const stat = await fs.promises.stat(entryPath);
          total += Math.max(0, Number(stat.size) || 0);
        }
      } catch (_) { }
    }));
  }
  await walk(directory);
  return total;
}
async function dshCacheSettingsSnapshot() {
  const settings = dshNormalizeCacheSettings(dshCacheSettings || dshReadCacheSettings());
  // WE 静音场景包缓存：与 desktop/wallpaper-engine-runtime.js:1614-1618 的 nativeTempPath 推导保持一致
  const weNativeTemp = process.env.MINERADIO_NATIVE_TEMP_DIR
    || path.join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), 'Mineradio', 'native-helper-temp');
  const wallpaperEnginePath = path.join(weNativeTemp, 'wallpaper-engine-muted-package-cache');
  const [lyricsBytes, chromiumBytes, beatmapsBytes, wallpaperEngineBytes, userDataBytes] = await Promise.all([
    dshDirectoryUsageBytes(settings.lyricsPath),
    dshDirectoryUsageBytes(app.getPath('sessionData')),
    dshDirectoryUsageBytes(settings.beatmapsPath),
    dshDirectoryUsageBytes(wallpaperEnginePath),
    dshDirectoryUsageBytes(app.getPath('userData')),
  ]);
  return {
    ok: true,
    settings: {
      rootPath: settings.rootPath,
      lyricsPath: settings.lyricsPath,
      chromiumPath: settings.chromiumPath,
      activeChromiumPath: settings.chromiumPath,
      beatmapsPath: settings.beatmapsPath,
      activeBeatmapsPath: settings.beatmapsPath,
      nativePath: settings.nativePath,
      activeNativePath: weNativeTemp,
      wallpaperEnginePath,
      activeWallpaperEnginePath: wallpaperEnginePath,
      userDataPath: app.getPath('userData'),
      restartRequired: false,
    },
    usage: {
      lyricsBytes,
      chromiumBytes,
      beatmapsBytes,
      wallpaperEngineBytes,
      userDataBytes,
      totalManagedBytes: lyricsBytes + chromiumBytes + beatmapsBytes + wallpaperEngineBytes,
    },
  };
}

// ===== SMTC 任务栏音符按钮（酷狗式媒体控件）=====
// 原理：Windows 桌面进程无法直接激活 SystemMediaTransportControls（E_NOTIMPL），
// 但 Windows.Media.Playback.MediaPlayer 可激活且自带 SMTC（IMediaPlayer2::get_SystemMediaTransportControls），
// 用 koffi 手动调 COM：MediaPlayer → QI(IMediaPlayer2) → get_SMTC → DisplayUpdater → MusicProperties
let smtc = null; // { smtcPtr, duPtr, mpPtr, putTitle, putArtist, putStatus, update, winCreateString, winDeleteString }
let smtcCbTypeReady = false; // SmtcPressedCb 命名回调类型只注册一次
function smtcGuidBuf(hex) {
  const p = hex.replace(/-/g, '');
  const b = Buffer.from(p, 'hex');
  const out = Buffer.alloc(16);
  out[0] = b[3]; out[1] = b[2]; out[2] = b[1]; out[3] = b[0];
  out[4] = b[5]; out[5] = b[4];
  out[6] = b[7]; out[7] = b[6];
  for (let i = 0; i < 8; i++) out[8 + i] = b[8 + i];
  return out;
}
function smtcInit() {
  if (smtc) return true;
  try {
    const koffi = require('koffi');
    // 命名回调类型（koffi v2 无 types 映射参数，用命名类型 + <Name> 引用；仅注册一次）
    if (!smtcCbTypeReady) {
      koffi.proto('__stdcall', 'SmtcPressedCb', 'void', ['void *', 'void *']);
      smtcCbTypeReady = true;
    }
    const combase = koffi.load('combase.dll');
    const winCreateString = combase.func('long __stdcall WindowsCreateString(const char16_t *sourceString, uint32_t length, _Out_ void **string)');
    const roActivate = combase.func('long __stdcall RoActivateInstance(void *activatableClassId, _Out_ void **instance)');
    const winDeleteString = combase.func('void __stdcall WindowsDeleteString(void *string)');
    const fn = (addr, sig) => koffi.decode(koffi.decode(addr, 'void*'), koffi.proto(sig));
    // ===== 方式一（优先）：ISystemMediaTransportControlsInterop::GetForWindow 全局会话 =====
    // 桌面应用官方方式（RoGetActivationFactory + Interop），支持 SMTC2/Timeline（MediaPlayer 会话不支持）——
    // Timeline 是 Win11 任务栏媒体浮出（大封面+进度条）的关键数据
    let smtcPtr = null;
    let usingGFW = false;
    try {
      const smtcCls = 'Windows.Media.SystemMediaTransportControls';
      let sh = [null];
      winCreateString(smtcCls, smtcCls.length, sh);
      const roGetFactory = combase.func('long __stdcall RoGetActivationFactory(void *activatableClassId, void *iid, _Out_ void **factory)');
      let fac = [null];
      let fhr = roGetFactory(sh[0], smtcGuidBuf('ddb0472d-c911-4a1f-86d9-dc3d71a95f5a'), fac); // ISystemMediaTransportControlsInterop
      winDeleteString(sh[0]);
      if ((fhr >>> 0) === 0 && fac[0]) {
        const wins0 = require('electron').BrowserWindow.getAllWindows();
        if (wins0.length) {
          const getForWindow = fn(koffi.decode(fac[0], 'void*') + 6n * 8n, 'long __stdcall (void*, void*, void*, _Out_ void **)');
          let sp = [null];
          const ghr = getForWindow(fac[0], wins0[0].getNativeWindowHandle().readBigUInt64LE(0), smtcGuidBuf('99fa3ff4-1742-42a6-902e-087d41f965ec'), sp); // ISystemMediaTransportControls
          if ((ghr >>> 0) === 0 && sp[0]) { smtcPtr = sp; usingGFW = true; }
        }
      }
    } catch {}
    // MediaPlayer 实例（状态真值：真实播放/暂停联动；GetForWindow 会话自身无播放器）
    const cls = 'Windows.Media.Playback.MediaPlayer';
    let hs = [null];
    let hr = winCreateString(cls, cls.length, hs);
    let inst = [null];
    hr = roActivate(hs[0], inst);
    if ((hr >>> 0) !== 0 || !inst[0]) { winDeleteString(hs[0]); return false; }
    winDeleteString(hs[0]);
    const objVt = koffi.decode(inst[0], 'void*');
    if (!usingGFW) {
      // 回退：MediaPlayer 自带 SMTC 会话（方式二）
      const qi = fn(objVt, 'long __stdcall (void*, void*, _Out_ void **)');
      let mp2 = [null];
      hr = qi(inst[0], smtcGuidBuf('3c841218-2123-4fc5-9082-2f883f77bdf5'), mp2); // IMediaPlayer2
      if ((hr >>> 0) !== 0 || !mp2[0]) return false;
      const getSMTC = fn(koffi.decode(mp2[0], 'void*') + 6n * 8n, 'long __stdcall (void*, _Out_ void **)');
      smtcPtr = [null];
      hr = getSMTC(mp2[0], smtcPtr);
      if ((hr >>> 0) !== 0 || !smtcPtr[0]) return false;
    }
    const svt = koffi.decode(smtcPtr[0], 'void*');
    const putIsEnabled = fn(svt + 11n * 8n, 'long __stdcall (void*, long)');
    const putIsPlay = fn(svt + 13n * 8n, 'long __stdcall (void*, long)');
    const putIsPause = fn(svt + 17n * 8n, 'long __stdcall (void*, long)');
    const putIsNext = fn(svt + 27n * 8n, 'long __stdcall (void*, long)');
    const putIsPrev = fn(svt + 25n * 8n, 'long __stdcall (void*, long)');
    const putStatus = fn(svt + 7n * 8n, 'long __stdcall (void*, long)');
    const getDU = fn(svt + 8n * 8n, 'long __stdcall (void*, _Out_ void **)');
    putIsEnabled(smtcPtr[0], 1); putIsPlay(smtcPtr[0], 1); putIsPause(smtcPtr[0], 1); putIsNext(smtcPtr[0], 1); putIsPrev(smtcPtr[0], 1);
    let du = [null];
    hr = getDU(smtcPtr[0], du);
    if ((hr >>> 0) !== 0 || !du[0]) return false;
    // 注：按钮点击回调（add_ButtonPressed）已移除——koffi 调 COM 事件注册在 Electron 43 下原生崩溃
    // （任务栏缩略图预览按钮走另一套 ThumbBar 机制，一直正常；SMTC 卡片按钮点击暂不响应）
    const dvt = koffi.decode(du[0], 'void*');
    const putType = fn(dvt + 7n * 8n, 'long __stdcall (void*, long)');
    const getMP = fn(dvt + 12n * 8n, 'long __stdcall (void*, _Out_ void **)');
    const update = fn(dvt + 17n * 8n, 'long __stdcall (void*)');
    putType(du[0], 1); // MediaPlaybackType.Music
    let mp = [null];
    hr = getMP(du[0], mp);
    if ((hr >>> 0) !== 0 || !mp[0]) return false;
    const mvt = koffi.decode(mp[0], 'void*');
    const putTitle = fn(mvt + 7n * 8n, 'long __stdcall (void*, void*)'); // HSTRING
    const putArtist = fn(mvt + 11n * 8n, 'long __stdcall (void*, void*)');
    // MediaPlayer 播放控制（播静音音源让 GSMTC 状态显示真实播放状态）
    const putIsLooping = fn(objVt + 16n * 8n, 'long __stdcall (void*, long)');
    const putVolume = fn(objVt + 23n * 8n, 'long __stdcall (void*, double)');
    const playMP = fn(objVt + 45n * 8n, 'long __stdcall (void*)');
    const pauseMP = fn(objVt + 46n * 8n, 'long __stdcall (void*)');
    const setUri = fn(objVt + 47n * 8n, 'long __stdcall (void*, void*)');
    smtc = { smtcPtr: smtcPtr[0], duPtr: du[0], mpPtr: mp[0], mpInst: inst[0], putTitle, putArtist, putStatus, update, winCreateString, winDeleteString, putIsLooping, putVolume, playMP, pauseMP, setUri,
      tlProps: null, putStart: null, putEnd: null, putMinSeek: null, putMaxSeek: null, putPos: null, updateTimeline: null, smtc2Ptr: null };
    // TimelineProperties：Win11 任务栏媒体浮出（酷狗式封面浮出）的进度条数据——浮出出现的重要条件
    try {
      const cls2 = 'Windows.Media.SystemMediaTransportControlsTimelineProperties';
      let th = [null];
      winCreateString(cls2, cls2.length, th);
      let tlp = [null];
      let hr2 = roActivate(th[0], tlp);
      winDeleteString(th[0]);
      if ((hr2 >>> 0) === 0 && tlp[0]) {
        const tv = koffi.decode(tlp[0], 'void*');
        const putStart = fn(tv + 7n * 8n, 'long __stdcall (void*, long long)');   // TimeSpan（100ns 单位，8 字节值传递）
        const putEnd = fn(tv + 9n * 8n, 'long __stdcall (void*, long long)');
        const putMinSeek = fn(tv + 11n * 8n, 'long __stdcall (void*, long long)');
        const putMaxSeek = fn(tv + 13n * 8n, 'long __stdcall (void*, long long)');
        const putPos = fn(tv + 15n * 8n, 'long __stdcall (void*, long long)');
        let smtc2 = [null];
        const qiSm = fn(svt, 'long __stdcall (void*, void*, _Out_ void **)'); // 通用 QueryInterface（svt 首槽）
        const hr3 = qiSm(smtcPtr[0], smtcGuidBuf('ea98d2f6-7f3c-4af2-a586-72889808efb1'), smtc2); // ISystemMediaTransportControls2
        if ((hr3 >>> 0) === 0 && smtc2[0]) {
          const updateTimeline = fn(koffi.decode(smtc2[0], 'void*') + 12n * 8n, 'long __stdcall (void*, void*)'); // UpdateTimelineProperties
          smtc.tlProps = tlp[0]; smtc.putStart = putStart; smtc.putEnd = putEnd; smtc.putMinSeek = putMinSeek; smtc.putMaxSeek = putMaxSeek; smtc.putPos = putPos;
          smtc.updateTimeline = updateTimeline; smtc.smtc2Ptr = smtc2[0];
          console.log('[播放器] SMTC Timeline 已初始化（媒体浮出进度数据）');
        } else { console.log('[播放器] SMTC2 QI 失败: ' + (hr3 >>> 0).toString(16)); }
      } else { console.log('[播放器] TimelineProperties 激活失败: ' + (hr2 >>> 0).toString(16)); }
    } catch (e) { console.error('[播放器] SMTC Timeline 失败:', e.message); }
    // 播静音音源（循环、音量 0）→ GSMTC 状态可正确显示 playing/paused
    try {
      ensureSmtcHttp();
      const roGetFactory = combase.func('long __stdcall RoGetActivationFactory(void *activatableClassId, void *iid, _Out_ void **factory)');
      let uh = [null];
      const uriStr = 'http://127.0.0.1:18080/silence.wav';
      winCreateString('Windows.Foundation.Uri', 'Windows.Foundation.Uri'.length, uh);
      let ufac = [null];
      let uhr = roGetFactory(uh[0], smtcGuidBuf('44a9796f-723e-4fdf-a218-033e75b0c084'), ufac); // IUriRuntimeClassFactory
      winDeleteString(uh[0]);
      if ((uhr >>> 0) === 0 && ufac[0]) {
        const createUri = fn(koffi.decode(ufac[0], 'void*') + 6n * 8n, 'long __stdcall (void*, void*, _Out_ void **)');
        uh = [null];
        winCreateString(uriStr, uriStr.length, uh);
        let uri = [null];
        uhr = createUri(ufac[0], uh[0], uri);
        winDeleteString(uh[0]);
        if ((uhr >>> 0) === 0 && uri[0]) {
          const setUriHr = setUri(inst[0], uri[0]);
          putIsLooping(inst[0], 1);
          putVolume(inst[0], 0.1); // 音量 0.1：静音 wav 实际无声，但系统判定有音频输出（媒体浮出/系统媒体判定依赖此）
          // 延迟播放：源加载完成后再 Play（立即 Play 在加载中会失效）
          setTimeout(() => {
            try {
              playMP(inst[0]);
              putStatus(smtcPtr[0], 3); // MediaPlaybackStatus.Playing = 3
              const getState = fn(objVt + 12n * 8n, 'long __stdcall (void*, _Out_ long *)');
              let st = [0];
              getState(inst[0], st);
              // 读回 SMTC 状态确认 put 是否生效/被覆盖
              const getPS = fn(svt + 6n * 8n, 'long __stdcall (void*, _Out_ long *)');
              let ps = [0];
              getPS(smtcPtr[0], ps);
              console.log('[播放器] SMTC 静音源: setUri=' + (setUriHr >>> 0).toString(16) + ' MP状态=' + st[0] + ' SMTC状态=' + ps[0]);
            } catch (e) { console.error('[播放器] SMTC 静音源播放失败:', e.message); }
          }, 2000);
          console.log('[播放器] SMTC 静音源已启动（状态可同步）');
        }
      }
    } catch (e) { console.error('[播放器] SMTC 静音源启动失败:', e.message); }
    update(du[0]);
    console.log('[播放器] SMTC 音符按钮已注册');
    return true;
  } catch (e) {
    console.error('[播放器] SMTC 初始化失败:', e.message);
    return false;
  }
}
function smtcSet(info) {
  if (!smtc || !info) return;
  try {
    let hs = [null];
    if (info.title) {
      smtc.winCreateString(info.title, info.title.length, hs);
      smtc.putTitle(smtc.mpPtr, hs[0]);
      smtc.winDeleteString(hs[0]);
    }
    hs = [null];
    if (info.artist) {
      smtc.winCreateString(info.artist, info.artist.length, hs);
      smtc.putArtist(smtc.mpPtr, hs[0]);
      smtc.winDeleteString(hs[0]);
    }
    if (typeof info.playing === 'boolean') {
      smtc.putStatus(smtc.smtcPtr, info.playing ? 3 : 4); // MediaPlaybackStatus: Playing=3 Paused=4
      try { if (info.playing) smtc.playMP(smtc.mpInst); else smtc.pauseMP(smtc.mpInst); } catch {}
    }
    // 进度（媒体浮出进度条：Win11 任务栏媒体浮出的关键数据——实时更新）
    if ((info.position !== undefined || info.duration) && smtc.putEnd && smtc.tlProps) {
      try {
        const d = Math.round((info.duration || 0) * 1e7); // TimeSpan = 100ns 单位
        const p = Math.round((info.position || 0) * 1e7);
        smtc.putStart(smtc.tlProps, 0);
        smtc.putEnd(smtc.tlProps, d);
        smtc.putMinSeek(smtc.tlProps, 0);
        smtc.putMaxSeek(smtc.tlProps, d);
        smtc.putPos(smtc.tlProps, p);
        smtc.updateTimeline(smtc.smtc2Ptr, smtc.tlProps);
      } catch {}
    }
    smtc.update(smtc.duPtr);
    // 封面（异步设置；同一首歌只设一次）
    const coverName = smtcCoverName(info.coverId);
    if (coverName && coverName !== smtc.lastCover) {
      smtc.lastCover = coverName;
      smtcSetCover(coverName);
    }
  } catch (e) {}
}
// 根据歌曲 id 找封面文件名（sha1(id)前32位.jpg）
function smtcCoverName(id) {
  if (!id) return null;
  try {
    const name = crypto.createHash('sha1').update(id).digest('hex').slice(0, 32) + '.jpg';
    return fs.existsSync(path.join(dataRoot(), 'covers', name)) ? name : null;
  } catch { return null; }
}
// 本地 http 封面服务（CreateFromUri 只支持 http/https；file:// 不可靠）
let smtcHttpSrv = null;
let silenceWavBuf = null;
function smtcSilenceWav() {
  if (silenceWavBuf) return silenceWavBuf;
  const sr = 16000, bits = 16, ch = 1, secs = 60; // 1 分钟 16kHz 16bit 单声道（循环播放）
  const blockAlign = ch * (bits / 8), byteRate = sr * blockAlign;
  const dataSize = sr * secs * blockAlign;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(byteRate, 28); b.writeUInt16LE(blockAlign, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36); b.writeUInt32LE(dataSize, 40);
  // 低能量正弦波（振幅 100/32767 ≈ -50dB）：人耳几乎听不到，但系统音频会话判定"有真实输出"
  // （全 0 静音会让 Win11 判定无音频输出 → 任务栏媒体浮出不出现——这是之前媒体浮出失败的关键疑点）
  for (let i = 0; i < dataSize / 2; i++) {
    b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / sr) * 100), 44 + i * 2);
  }
  silenceWavBuf = b;
  return b;
}
function ensureSmtcHttp() {
  if (smtcHttpSrv) return true;
  try {
    const http = require('http');
    const base = path.join(dataRoot(), 'covers');
    smtcHttpSrv = http.createServer((req, res) => {
      try {
        const name = decodeURIComponent((req.url || '').replace(/^\//, ''));
        if (name === 'silence.wav') {
          const buf = smtcSilenceWav();
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length });
          res.end(buf);
          return;
        }
        if (!/^[0-9a-f]{32}\.jpg$/i.test(name)) { res.writeHead(403); res.end(); return; }
        const buf = fs.readFileSync(base + '\\' + name);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
        res.end(buf);
      } catch { res.writeHead(404); res.end(); }
    });
    smtcHttpSrv.on('error', () => { /* 端口被占（如多实例）时静默放弃 SMTC 封面服务，不让未捕获 error 崩主进程 */ });
    smtcHttpSrv.listen(18080, '127.0.0.1');
    return true;
  } catch { return false; }
}
// SMTC 封面：Uri(http://127.0.0.1:18080/封面) → RandomAccessStreamReference.CreateFromUri → put_Thumbnail（全同步，无 WinRT 异步）
let smtcCoverBusy = false;
function smtcSetCover(coverName) {
  if (smtcCoverBusy || !smtc) return;
  if (!ensureSmtcHttp()) return;
  smtcCoverBusy = true;
  try {
    const koffi = require('koffi');
    const combase = koffi.load('combase.dll');
    const winCreateString = combase.func('long __stdcall WindowsCreateString(const char16_t *sourceString, uint32_t length, _Out_ void **string)');
    const roGetFactory = combase.func('long __stdcall RoGetActivationFactory(void *activatableClassId, void *iid, _Out_ void **factory)');
    const winDeleteString = combase.func('void __stdcall WindowsDeleteString(void *string)');
    const fn = (addr, sig) => koffi.decode(koffi.decode(addr, 'void*'), koffi.proto(sig));

    // 1) Uri
    const uriStr = 'http://127.0.0.1:18080/' + coverName;
    let hs = [null];
    winCreateString('Windows.Foundation.Uri', 'Windows.Foundation.Uri'.length, hs);
    let fac = [null];
    let hr = roGetFactory(hs[0], smtcGuidBuf('44a9796f-723e-4fdf-a218-033e75b0c084'), fac); // IUriRuntimeClassFactory
    winDeleteString(hs[0]);
    if ((hr >>> 0) !== 0 || !fac[0]) { smtcCoverBusy = false; return; }
    const createUri = fn(koffi.decode(fac[0], 'void*') + 6n * 8n, 'long __stdcall (void*, void*, _Out_ void **)');
    hs = [null];
    winCreateString(uriStr, uriStr.length, hs);
    let uri = [null];
    hr = createUri(fac[0], hs[0], uri);
    winDeleteString(hs[0]);
    if ((hr >>> 0) !== 0 || !uri[0]) { smtcCoverBusy = false; return; }
    // 2) RandomAccessStreamReference.CreateFromUri(uri) —— vtable[7]
    hs = [null];
    winCreateString('Windows.Storage.Streams.RandomAccessStreamReference', 'Windows.Storage.Streams.RandomAccessStreamReference'.length, hs);
    fac = [null];
    hr = roGetFactory(hs[0], smtcGuidBuf('857309dc-3fbf-4e7d-986f-ef3b1a07a964'), fac); // IRandomAccessStreamReferenceStatics
    winDeleteString(hs[0]);
    if ((hr >>> 0) !== 0 || !fac[0]) { smtcCoverBusy = false; return; }
    const createFromUri = fn(koffi.decode(fac[0], 'void*') + 7n * 8n, 'long __stdcall (void*, void*, _Out_ void **)');
    let stream = [null];
    hr = createFromUri(fac[0], uri[0], stream);
    if ((hr >>> 0) !== 0 || !stream[0]) { smtcCoverBusy = false; return; }
    // 3) put_Thumbnail（vtable[11]）+ Update
    const duVt = koffi.decode(smtc.duPtr, 'void*');
    const putThumb = fn(duVt + 11n * 8n, 'long __stdcall (void*, void*)');
    hr = putThumb(smtc.duPtr, stream[0]);
    if ((hr >>> 0) === 0) smtc.update(smtc.duPtr);
  } catch (e) {}
  smtcCoverBusy = false;
}


// 从封面 DIB 创建 32bpp HBITMAP（RGBA→BGRA 交换，自顶向下）
function createThumbBitmap(tw, th) {
  if (!iconicThumb || !thumbDIB) return null;
  try {
    const scaled = scaleDIB(thumbDIB, tw, th); // 等比缩放到目标尺寸
    if (!scaled) return null;
    const bmi = Buffer.alloc(44);
    bmi.writeUInt32LE(40, 0); bmi.writeInt32LE(tw, 4); bmi.writeInt32LE(-th, 8); // 自顶向下
    bmi.writeUInt16LE(1, 12); bmi.writeUInt16LE(32, 14);
    const hbm = iconicThumb.CreateDIBSection(iconicThumb.koffi.null, bmi, 0, iconicThumb.koffi.null, iconicThumb.koffi.null, 0);
    if (!hbm || hbm === iconicThumb.koffi.null) return null;
    const hdc = iconicThumb.CreateCompatibleDC(iconicThumb.koffi.null);
    // 渲染层给的是预乘 RGBA；SetDIBits 32bpp 是 BGRA 顺序 → 交换 R/B
    const bgra = Buffer.alloc(scaled.length);
    for (let i = 0; i < scaled.length; i += 4) {
      bgra[i] = scaled[i + 2];
      bgra[i + 1] = scaled[i + 1];
      bgra[i + 2] = scaled[i];
      bgra[i + 3] = scaled[i + 3];
    }
    iconicThumb.SetDIBits(hdc, hbm, 0, th, bgra, bmi, 0);
    iconicThumb.DeleteDC(hdc);
    return hbm;
  } catch (err) { console.error('[播放器] 封面 HBITMAP 创建失败:', err.message); return null; }
}

function injectIconicThumbnail(tw, th, winRef) {
  if (!iconicThumb || !thumbDIB || !winRef || winRef.isDestroyed() || tw <= 0 || th <= 0) return false;
  try {
    const hwndBig = winRef.getNativeWindowHandle().readBigUInt64LE(0);
    const hbm = createThumbBitmap(tw, th);
    if (!hbm) return false;
    const hr = iconicThumb.DwmSetIconicThumbnail(hwndBig, hbm, 0);
    iconicThumb.DeleteObject(hbm);
    try { fs.appendFileSync(path.join(dataRoot(), '_thumb.log'), `[${new Date().toLocaleTimeString()}] 注入 ${tw}x${th} hr=0x${(hr >>> 0).toString(16)} ${hr === 0 ? '✅' : ''}\n`); } catch {}
    return hr === 0;
  } catch (err) { console.error('[播放器] 缩略图注入失败:', err.message); return false; }
}

// 0x0324（WM_DWMSENDICONICLIVEPREVIEWBITMAP）：前台 hover 任务栏缩略图/Aero Peek 时 DWM 请求"实时预览位图"——
// 这才是酷狗"窗口内容不变、缩略图显示封面"的手法（0x0323 只覆盖最小化/后台；前台 live preview 走 0x0324）
function injectLivePreview(winRef) {
  if (!iconicThumb || !winRef || winRef.isDestroyed()) return false;
  try {
    if (!thumbDIB) thumbDIB = ensureDefaultThumbDIB();
    if (!thumbDIB) return false;
    const hwndBig = winRef.getNativeWindowHandle().readBigUInt64LE(0);
    const hbm = createThumbBitmap(320, 320);
    if (!hbm) return false;
    const hr = iconicThumb.DwmSetIconicLivePreviewBitmap(hwndBig, hbm, iconicThumb.koffi.null, 0); // pptClient=NULL 居中
    iconicThumb.DeleteObject(hbm);
    try { fs.appendFileSync(path.join(dataRoot(), '_thumb.log'), `[${new Date().toLocaleTimeString()}] 0x0324 实时预览注入 hr=0x${(hr >>> 0).toString(16)} ${hr === 0 ? '✅' : ''}\n`); } catch {}
    return hr === 0;
  } catch (err) { console.error('[播放器] 实时预览注入失败:', err.message); return false; }
}

// 最近邻缩放预乘 ARGB DIB 到目标尺寸（DWM 建议尺寸；超出会 E_INVALIDARG）
function scaleDIB(src, tw, th) {
  const { buf, w, h } = src;
  if (tw <= 0 || th <= 0) return null;
  if (w === tw && h === th) return buf;
  // 等比缩放：封面 1:1 完整放进 tw×th（居中），四周深色补边——避免被 DWM 建议尺寸（约 16:9）拉伸变形（BUG-E 修复）
  const scale = Math.min(tw / w, th / h);
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const ox = Math.floor((tw - cw) / 2);
  const oy = Math.floor((th - ch) / 2);
  const out = Buffer.alloc(tw * th * 4);
  for (let i = 0; i < tw * th * 4; i += 4) {
    out[i] = 16; out[i + 1] = 16; out[i + 2] = 18; out[i + 3] = 255; // 深色 letterbox
  }
  for (let y = 0; y < ch; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / ch));
    const siBase = sy * w * 4;
    const diBase = (oy + y) * tw * 4 + ox * 4;
    for (let x = 0; x < cw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / cw));
      const si = siBase + sx * 4;
      const di = diBase + x * 4;
      out[di] = buf[si];
      out[di + 1] = buf[si + 1];
      out[di + 2] = buf[si + 2];
      out[di + 3] = buf[si + 3];
    }
  }
  return out;
}

if (!app.requestSingleInstanceLock()) {
  shutLog('quit-request', 'single-instance-lock-failed'); // W-13 A：本进程就是"双击没反应"里被拒的那次
  app.quit();
} else {
  main();
}

// 旧版本数据在 D:\MusicPlayerData：当最终数据根不是 D 盘（D 盘不可用）且目标无数据时，
// 一次性迁移过去。幂等：目标已有数据或已迁移过则跳过；迁移后旧目录保留（安全，不删源）。
function migrateLegacyData() {
  const dest = store.getDataDir();
  const OLD = 'D:\\MusicPlayerData';
  // W-14 A：不只"等于 OLD"要跳过，"位于 OLD 之内"也必须跳过 —— 测试实例的 userData
  // （…\userdata-test<slot>，见文件头 :63-65）就落在 OLD 里面。原判据只判相等，
  // 于是测试实例启动时会遍历 OLD 并把兄弟目录（含其它 userdata-test*）当"旧数据"递归复制进
  // 自己的 dataDir：实测单次 904 MB，历史最高 27 GB（约 53 GB 是副本）。
  if (!dest) return;
  const destAbs = path.resolve(dest);
  const oldAbs = path.resolve(OLD);
  if (destAbs === oldAbs || destAbs.startsWith(oldAbs + path.sep)) return; // D 盘即目标/落在 OLD 内：旧数据原位可用，无需迁移
  try {
    if (!fs.existsSync(OLD)) return;
    if (fs.existsSync(path.join(dest, 'config.json')) || fs.existsSync(path.join(dest, '.migrated'))) return;
    for (const entry of fs.readdirSync(OLD)) {
      // W-14 B：前缀判断（不只精确 'userdata'）—— 测试实例的 userData 目录名形如 userdata-test<slot>，
      // 原实现只排除精确的 'userdata'，导致它们被当成"旧数据"整份复制。前缀判断同时覆盖未来的
      // userdata-* 变体，无需同步维护白名单。
      if (entry.startsWith('userdata') || entry === '_thumb.log') continue; // Electron 运行时数据/调试日志/测试实例目录不迁移
      const src = path.join(OLD, entry);
      const dst = path.join(dest, entry);
      try {
        if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
        else fs.copyFileSync(src, dst);
      } catch { /* 单个失败不影响整体 */ }
    }
    // 酷狗歌单映射文件（旧版在 D:\Music\songlist.json）一并迁移
    try {
      if (!fs.existsSync(path.join(dest, 'songlist.json')) && fs.existsSync('D:\\Music\\songlist.json')) {
        fs.copyFileSync('D:\\Music\\songlist.json', path.join(dest, 'songlist.json'));
      }
    } catch { /* 忽略 */ }
    fs.writeFileSync(path.join(dest, '.migrated'), new Date().toISOString());
    console.log('[迁移] 旧数据已从', OLD, '迁移到', dest);
  } catch (err) {
    console.error('[迁移] 失败:', err.message);
  }
}

function main() {
  // 数据根：D 盘可用 → D:\MusicPlayerData（用户偏好，旧数据原位可用）；否则系统用户数据目录
  store.setDataDir(process.env.DSH_TEST_INSTANCE ? app.getPath('userData') : (DATA_ROOT || app.getPath('userData')));
  // W-14 C：测试实例（DSH_TEST_INSTANCE）的 dataDir 就在 OLD 之内，本就无"从旧目录迁移"的语义，直接跳过。
  // 注意：这**只**跳过测试实例；正式实例在「D 盘不可用」时的降级迁移必须照旧执行（下方 else 分支不变）。
  if (!process.env.DSH_TEST_INSTANCE) {
    migrateLegacyData(); // D 盘不可用且旧数据残留时兜底迁移
  }
  shutLog('app-start', 'version=' + app.getVersion() + ' packaged=' + app.isPackaged + ' electron=' + process.versions.electron + ' dataRoot=' + dataRoot()); // W-13 A
  // ===== 本地多账号：数据按 accounts/<id>/ 隔离；设置/外观(config)为设备级 =====
  const ACC_REG_FILE = () => path.join(dataRoot(), 'accounts-registry.json');
  const ACC_CUR_FILE = () => path.join(dataRoot(), 'current-account.json');
  const ACC_SCOPED_FILES = ['online-playlists.json', 'favorites.json', 'history.json', 'playlists.json', 'pl-order.json', 'local-account.json', 'accounts.json', 'sync.json', 'sync-tomb.json', 'sync-devices.json', 'recent-pls.json', 'bili-credentials.json', 'bili-credentials.backup.json'];
  function accReadReg() { try { return JSON.parse(fs.readFileSync(ACC_REG_FILE(), 'utf8')); } catch { return []; } }
  function accWriteReg(l) { try { fs.mkdirSync(path.dirname(ACC_REG_FILE()), { recursive: true }); fs.writeFileSync(ACC_REG_FILE(), JSON.stringify(l, null, 2)); } catch (e) {} }
  function accReadCur() { try { return JSON.parse(fs.readFileSync(ACC_CUR_FILE(), 'utf8')); } catch { return null; } }
  function accWriteCur(id) { try { fs.writeFileSync(ACC_CUR_FILE(), JSON.stringify(id)); } catch (e) {} }
  function accNewId() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function accBoot() {
    let reg = accReadReg(); let cur = accReadCur();
    if (!reg.length) {
      const id = accNewId();
      let legacyName = ''; try { const la = JSON.parse(fs.readFileSync(path.join(dataRoot(), 'local-account.json'), 'utf8')); legacyName = la.name || ''; } catch (e) {}
      fs.mkdirSync(path.join(dataRoot(), 'accounts', id), { recursive: true });
      for (const f of ACC_SCOPED_FILES) { const src = path.join(dataRoot(), f); if (fs.existsSync(src)) { try { fs.renameSync(src, path.join(dataRoot(), 'accounts', id, f)); } catch (e) {} } const b = src + '.bak'; if (fs.existsSync(b)) { try { fs.renameSync(b, path.join(dataRoot(), 'accounts', id, f + '.bak')); } catch (e) {} } }
      reg = [{ id, name: legacyName || '我的账号', avatar: '', createdAt: Date.now() }]; cur = id;
      accWriteReg(reg); accWriteCur(cur);
    }
    if (!cur || !reg.some((a) => a.id === cur)) { cur = reg[0].id; accWriteCur(cur); }
    store.setAccount(cur);
  }
  accBoot();
  function accNotify() { try { if (win && !win.isDestroyed()) win.webContents.send('account:changed'); } catch (e) {} }
  function accFlushCurrent() { const reg = accReadReg(); const cur = accReadCur(); const a = reg.find((x) => x.id === cur); if (!a) return; try { const la = localAccRead(); a.name = la.name || a.name; a.avatar = la.avatar || a.avatar; accWriteReg(reg); } catch (e) {} }
  function accSwitch(id) { const reg = accReadReg(); if (!reg.some((a) => a.id === id)) return { ok: false }; accFlushCurrent(); store.setAccount(id); accWriteCur(id); try { loadAccounts(); } catch (e) {} try { biliClient = null; } catch (e) {} try { syncReloadForAccount(); } catch (e) {} accNotify(); return { ok: true }; }
  function accCreate(name) { const reg = accReadReg(); accFlushCurrent(); const id = accNewId(); reg.push({ id, name: String(name || '').trim().slice(0, 24) || ('账号' + (reg.length + 1)), avatar: '', createdAt: Date.now() }); accWriteReg(reg); try { fs.mkdirSync(path.join(dataRoot(), 'accounts', id), { recursive: true }); } catch (e) {} store.setAccount(id); accWriteCur(id); try { loadAccounts(); } catch (e) {} try { biliClient = null; } catch (e) {} accNotify(); return { ok: true, id }; }
  function accDelete(id) { let reg = accReadReg(); if (reg.length <= 1) return { ok: false, reason: '至少保留一个账号' }; const wasCur = accReadCur() === id; reg = reg.filter((a) => a.id !== id); accWriteReg(reg); try { fs.rmSync(path.join(dataRoot(), 'accounts', id), { recursive: true, force: true }); } catch (e) {} if (wasCur) { store.setAccount(reg[0].id); accWriteCur(reg[0].id); try { loadAccounts(); } catch (e) {} try { biliClient = null; } catch (e) {} } accNotify(); return { ok: true }; }
  ipcMain.handle('accounts:list', (e) => { if (!isTrusted(e)) return { ok: false }; return { ok: true, accounts: accReadReg(), current: accReadCur() }; });
  ipcMain.handle('accounts:switch', (e, id) => { if (!isTrusted(e)) return { ok: false }; return accSwitch(id); });
  ipcMain.handle('accounts:create', (e, name) => { if (!isTrusted(e)) return { ok: false }; return accCreate(name); });
  ipcMain.handle('accounts:delete', (e, id) => { if (!isTrusted(e)) return { ok: false }; return accDelete(id); });

  // 默认不预置任何曲库目录：首次启动由用户自行添加自己的音乐文件夹（曲库为空时界面有引导）
  const DEFAULT_DIRS = [];
  // 酷狗歌单映射文件：位于数据根（别人放一份同名文件也能用；不存在则跳过）
  const SONGLIST_FILE = path.join(dataRoot(), 'songlist.json');
  // 桌面歌词默认 = 用户当前美学（#17 默认值迁移 v2）：字号 28、柔光、bgOpacity 0.3、锁定、描边开、字体默认
  const LYRIC_DEFAULTS = { enabled: true, mode: 'desktop', fontSize: 28, color: '#bcfb89', color2: '#4deaff', bgOpacity: 0.3, opacity: 1, locked: true, pos: null, sweepStyle: 'soft', lyricFont: 'default', lockedSize: { width: 840, height: 160 }, stroke: true };

  // ======================================================================
  // Wallpaper Engine 集成编排段（Ported from Mineradio 2.2.0, GPL-3.0，
  // 来源 desktop/main.js 182-210 全局段 + 809-1418 + 1530-1763 + 4168-4560 IPC 段）
  // 与 MR 原文的差异（均为两应用环境差异）：
  //  ① mainWindow 由 createWindow 与本应用主窗 win 同步；
  //  ② isLocalAppUrl：DSH 主窗经 loadFile(file://) 加载，判定 file: 协议即可（MR 判本地服务器端口）；
  //  ③ MR「全屏沉浸桌面模式」用户功能（enable/disable/Esc/托盘恢复）未移植，FullDesktopModeRuntime
  //    仅作 WE 协同状态源（恒 disabled，协同分支自然不触发），beforePassive 传不可达 no-op；
  //  ④ 手势摄像头（gesture camera）权限段：初版未移植，现已补移植（授权签发 + media 放行 +
  //    IPC + preload 端点，见 isTrustedGestureCamera* / 'mineradio-gesture-camera-request-permission'）；
  //  ⑤ MAIN_WINDOW_BACKGROUND_THROTTLING 固定 false：DSH 后台保持渲染（任务栏封面缩略图实时），
  //    不能被 WE 宿主恢复路径改回节流；
  //  ⑥ 托盘重建（createOrUpdateTray）/sendWindowState 为 MR 专属，未移植。
  // ======================================================================
  const LOCAL_APP_PERMISSION_ALLOWLIST = new Set(['speaker-selection', 'pointerLock', 'pointer-lock']);
  // MR 为 system-memory.probeProcessElevation（PowerShell IsTokenElevated），此处最小等价实现：
  // 判定当前进程是否提权——提权时 WE 控制进程须走桌面 shell broker 以普通权限拉起
  let weElevationCache = null;
  function probeProcessElevationForWE() {
    if (weElevationCache !== null) return Promise.resolve(weElevationCache);
    if (process.platform !== 'win32') return Promise.resolve(false);
    return new Promise((resolve) => {
      require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
        { windowsHide: true, timeout: 10000 }, (error, stdout) => {
          weElevationCache = error ? false : String(stdout || '').trim() === 'True';
          resolve(weElevationCache);
        });
    });
  }
  function startupDelay(delayMs) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs) || 0))); }
  function isLocalAppUrl(value) {
    try {
      const u = new URL(String(value || ''));
      return u.protocol === 'file:' && (!u.hostname || u.hostname === 'localhost');
    } catch (e) {
      return false;
    }
  }

  let wallpaperEngineCaptureSourceId = '';
  let wallpaperEngineCaptureGrant = null;
  let gestureCameraPermissionGrant = null; // 手势摄像头一次性授权（Ported from Mineradio desktop/main.js:184）
  let wallpaperEngineCaptureOperation = 0;
  let wallpaperEngineCapturePreparationOperation = 0;
  let wallpaperEngineGlassCaptureOperation = 0;
  let wallpaperEngineHostBoundsRestartTimer = null;
  let wallpaperEngineHostBoundsRestartPending = false;
  let wallpaperEngineHostBoundsStopPromise = null;
  let wallpaperEngineHostBoundsOperation = 0;
  let wallpaperEngineHostBoundsFollowupReason = '';
  let wallpaperEngineHostVisibilitySuspended = false;
  let wallpaperEngineHostVisibilityResumePending = false;
  let wallpaperEngineHostVisibilityResumeTimer = null;
  let wallpaperEngineHostVisibilityOperation = 0;
  let wallpaperEngineHostVisibilityStopPromise = null;
  let wallpaperEngineHostVisibilityResidentMinimized = false;
  let fullDesktopModeHostVisibilityTransitionDepth = 0;
  let wallpaperEngineDesktopIconLayeringQueue = Promise.resolve(true);
  let windowFullscreenActive = false;
  let htmlFullscreenActive = false;
  const WALLPAPER_ENGINE_CAPTURE_GRANT_MS = 12000;
  const GESTURE_CAMERA_PERMISSION_GRANT_MS = 45000; // Ported from Mineradio desktop/main.js:209
  const WALLPAPER_ENGINE_CAPTURE_PREPARE_TIMEOUT_MS = 9000;
  const WALLPAPER_ENGINE_MAX_CAPTURE_FPS = 240;
  const WALLPAPER_ENGINE_HOST_RESUME_TIMEOUT_MS = 30000;
  const MAIN_WINDOW_BACKGROUND_THROTTLING = false; // 差异⑤：DSH 后台保持渲染

  const WE_NATIVE_TEMP_PATH = path.join(dataRoot(), 'we-native');
  fs.mkdirSync(WE_NATIVE_TEMP_PATH, { recursive: true });
  const wallpaperEngineLibrary = new WallpaperEngineLibrary({ userDataPath: dataRoot() });
  const wallpaperEngineRuntime = new WallpaperEngineRuntime({
    library: wallpaperEngineLibrary,
    desktopCapturer,
    hostElevationProbe: probeProcessElevationForWE,
    nativeTempPath: WE_NATIVE_TEMP_PATH,
  });
  const fullDesktopModeRuntime = new FullDesktopModeRuntime({
    screen,
    platform: process.platform,
    execFileImpl: require('child_process').execFile,
    nativeTempPath: WE_NATIVE_TEMP_PATH,
    // 差异③：DSH 无全屏沉浸桌面模式入口，beforePassive 不可达；reconcile 仅在 enabled 时才被触达
    beforePassive: () => Promise.resolve({ ok: false, error: 'FULL_DESKTOP_MODE_NOT_AVAILABLE' }),
    requestReconcile: (reason) => fullDesktopModeRuntime.reconcile(reason),
    onStatus: (status) => broadcastDesktopWallpaperStatus(status),
  });

  function isTrustedWallpaperEngineIpc(event) {
    return !!(event && win && !win.isDestroyed() && event.sender === win.webContents); // 差异①：主窗限定（不含歌词窗）
  }

  // ===== 手势摄像头权限链（Ported from Mineradio 2.2.0, GPL-3.0, desktop/main.js:747-807 + 4989-4993；
  //       即前述差异④的补移植）=====
  // 链路：渲染层经 preload 的 requestGestureCameraPermission() 发起 IPC → 此处签发 45s 一次性授权 →
  // session 权限处理器（configureLocalAppPermissions 的 media 分支）凭授权对 video 采集放行。
  // MR 原文的 isTrustedMainWindowIpc / isTrustedMainDocumentUrl 在 DSH 分别对应
  // isTrustedWallpaperEngineIpc（差异①主窗限定）与 isLocalAppUrl（差异②file: 协议）。
  function clearGestureCameraPermissionGrant() {
    gestureCameraPermissionGrant = null;
  }

  function isTrustedGestureCameraDocumentUrl(value) {
    // MR 原文（desktop/main.js:747-756）判本地服务器端口 + 路径 '/' 或 '/index.html'；
    // DSH 主窗为 file: 文档，pathname 是 '/D:/.../renderer/index.html' 形态，故等价改为 file: + index.html 结尾。
    try {
      const u = new URL(String(value || ''));
      if (!isLocalAppUrl(u.href)) return false;
      const pathname = path.posix.normalize(u.pathname || '/');
      return pathname === '/' || /\/index\.html$/i.test(pathname);
    } catch (_) {
      return false;
    }
  }

  function createGestureCameraPermissionGrant(event) {
    if (!isTrustedWallpaperEngineIpc(event)) return null; // MR 原文 isTrustedMainWindowIpc（差异①）
    if (event.senderFrame && event.senderFrame.parent) return null; // MR 原文：仅主框架文档可签发
    const sourceUrl = event.senderFrame && event.senderFrame.url || event.sender.getURL();
    gestureCameraPermissionGrant = {
      webContentsId: event.sender.id,
      origin: sourceUrl,
      expiresAt: Date.now() + GESTURE_CAMERA_PERMISSION_GRANT_MS,
    };
    return gestureCameraPermissionGrant;
  }

  function isTrustedGestureCameraMediaPermission(webContents, origin, details) {
    const grant = gestureCameraPermissionGrant;
    if (!grant || Date.now() > grant.expiresAt) {
      clearGestureCameraPermissionGrant();
      return false;
    }
    try {
      if (!webContents || webContents.isDestroyed() || webContents.id !== grant.webContentsId) return false;
      if (!mainWindow || mainWindow.isDestroyed() || webContents !== mainWindow.webContents) return false;
      if (!isTrustedGestureCameraDocumentUrl(origin) || !isTrustedGestureCameraDocumentUrl(grant.origin)) return false;
      if (details && details.isMainFrame === false) return false;
      const mediaType = String(details && details.mediaType || '').toLowerCase();
      const mediaTypes = details && Array.isArray(details.mediaTypes)
        ? details.mediaTypes.map((value) => String(value || '').toLowerCase()).filter(Boolean)
        : [];
      if (mediaType.includes('audio') || mediaTypes.some((value) => value.includes('audio'))) return false;
      if (mediaType && !mediaType.includes('video')) return false;
      if (mediaTypes.length && !mediaTypes.every((value) => value.includes('video'))) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function broadcastDesktopWallpaperStatus(status) {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('mineradio-wallpaper-runtime-state', {
      ...(status || fullDesktopModeRuntime.getStatus('broadcast')),
      recoveryTrayAvailable: false, // 差异⑥：DSH 无恢复托盘
      escapeShortcutRegistered: false,
    });
  }

  function wallpaperEngineProvidesDesktopBackdrop() {
    const status = wallpaperEngineRuntime.getStatus();
    return !!(status && status.active === true
      && status.captureMode === 'dwm-thumbnail'
      && status.dwmSurfaceReady === true
      && status.dwmSurfaceActive === true
      && Number(status.dwmSurfaceWindowId) > 0);
  }

  // ===== W-5：WE 壁纸会话的任务栏守卫 =====
  // 背景：WE 源窗（A = wallpaper64.exe 的 WPEOverlappedWallpaper）与 DWM 宿主（B = powershell.exe 的
  // MineradioWeDwmSurfaceHost）都是**无 owner 的正常顶层窗口**，按 Windows 判据必然各占一个任务栏按钮；
  // 宿主 C# 里唯一的摘除手段（ITaskbarList::DeleteTab）是一次性的，会被它 60ms 跟随定时器里的
  // SetWindowPos(..., SWP_SHOWWINDOW) 重新加回。这里复用歌词窗那套已验证的 koffi ex-style 补丁：
  // 只加 WS_EX_TOOLWINDOW、剥 WS_EX_APPWINDOW；不改 owner、不改 ShowInTaskbar、不动窗口样式类别
  // （实测 P4：B 剥 APPW 后 getSources 仍命中 → WGC 捕获零影响）。
  // 两个句柄都取自运行时状态（sourceId / dwmSurfaceWindowId），不改 desktop/ 下任何 vendor 文件。
  let wallpaperTaskbarGuardTimer = null;
  // W-8 C（可观测性）：守卫静默失效过一次（0a 的 getTitle 缺参被 catch 吞掉 → 白名单恒空 → 每个 hwnd 都跳过），
  // 事后只能等用户发现任务栏多图标。这里把"读标题失败 / 白名单未命中 / 实际动手"做成只读计数，
  // 失败额外报一次日志。**只加观测，不改守卫行为**。
  const wallpaperTaskbarGuardStats = {
    rounds: 0, hwnds: 0, patched: 0, titleMissing: 0, whitelistMiss: 0,
    lastTitle: '', warned: false,
  };
  function wallpaperTaskbarHwnds() {
    try {
      const status = wallpaperEngineRuntime.getStatus();
      if (!status || status.active !== true) return [];
      const out = [];
      const m = String(status.sourceId || '').match(/^window:(\d+):/);
      const sourceHwnd = m ? Number(m[1]) : 0;
      if (sourceHwnd > 0) out.push(sourceHwnd);
      const surfaceHwnd = Math.max(0, Number(status.dwmSurfaceWindowId) || 0);
      if (surfaceHwnd > 0) out.push(surfaceHwnd);
      return out;
    } catch (_) { return []; }
  }
  function reassertWallpaperTaskbarHidden() {
    const hwnds = wallpaperTaskbarHwnds();
    if (!hwnds.length) { stopWallpaperTaskbarGuard(); return false; } // 会话已结束 → 顺手收掉定时器，不留悬挂
    // W-6 0a 安全校验：动手前先读窗口标题，必须以 Mineradio 开头
    // （A = Mineradio Wallpaper <hash>、B = Mineradio WE DWM Surface）。
    // 标题读不到或不匹配 → 跳过且不报错，绝不越权改无关窗口的样式。
    // 校验放在守卫里，不进 patchTaskbarHiddenFromHwnd（歌词窗 hwnd 是自己的窗口，不走这条）。
    wallpaperTaskbarGuardStats.rounds += 1;
    wallpaperTaskbarGuardStats.hwnds = hwnds.length;
    for (const hwnd of hwnds) {
      let title = '';
      try {
        if (taskbarHider.getTitle) {
          // GetWindowTextA(hwnd, lpString, nMaxCount)：必须给输出缓冲与长度，否则 koffi 调用抛错
          const buf = Buffer.alloc(256);
          const n = taskbarHider.getTitle(hwnd, buf, 255);
          title = n > 0 ? buf.toString('binary', 0, n) : '';
        }
      } catch (_) { title = ''; }
      if (!title) {
        wallpaperTaskbarGuardStats.titleMissing += 1;
        if (!wallpaperTaskbarGuardStats.warned) {
          wallpaperTaskbarGuardStats.warned = true;
          console.warn('[w5-guard] 读窗口标题失败（getTitle 不可用或调用出错）→ 守卫会跳过所有 hwnd，任务栏图标不会被隐藏');
        }
        continue;
      }
      if (!/^Mineradio/.test(title)) {
        wallpaperTaskbarGuardStats.whitelistMiss += 1;
        if (!wallpaperTaskbarGuardStats.warned) {
          wallpaperTaskbarGuardStats.warned = true;
          console.warn('[w5-guard] 标题未命中白名单（需以 Mineradio 开头），跳过：' + String(title).slice(0, 60));
        }
        continue;
      }
      wallpaperTaskbarGuardStats.lastTitle = String(title).slice(0, 60);
      if (patchTaskbarHiddenFromHwnd(hwnd)) wallpaperTaskbarGuardStats.patched += 1;
    }
    return true;
  }
  function startWallpaperTaskbarGuard() {
    reassertWallpaperTaskbarHidden();                                  // ① 会话 ready：立即打一次
    if (wallpaperTaskbarGuardTimer) return;
    wallpaperTaskbarGuardTimer = setInterval(reassertWallpaperTaskbarHidden, 1000); // ② 周期 1s 重申
  }
  function stopWallpaperTaskbarGuard() {
    if (wallpaperTaskbarGuardTimer) { clearInterval(wallpaperTaskbarGuardTimer); wallpaperTaskbarGuardTimer = null; }
  }
  // ===== W-9 热修：守卫监督器（主进程自主触发，不依赖任何渲染层 IPC）=====
  // 原触发源（runtime-status IPC handler）在生产里是**死代码**：全渲染层对
  // getWallpaperEngineRuntimeStatus 的调用是 0 次（只有测试脚本会调）；而冷启动的壁纸自动恢复走
  // win.on('show') → resumeWallpaperEngineForVisibleHost()，同样不经过守卫的任何触发点
  // ⇒ 守卫永不启动，任务栏仍是 3 个图标（装机版公告里那句"已修"当时是假的）。
  // 这里让主进程每 2s 自查一次会话状态：活跃 → 确保守卫在跑（reassert 会按需补 patch），
  // 不活跃 → 收守卫。**无条件常驻**，不依赖任何外部调用；应用退出时随进程结束（will-quit 顺手清一次）。
  let wallpaperTaskbarSupervisorTimer = setInterval(() => {
    try {
      if (wallpaperEngineRuntime.getStatus().active === true) startWallpaperTaskbarGuard();
      else stopWallpaperTaskbarGuard();
    } catch (_) { /* 监督器绝不能因为一次读取失败而中断 */ }
  }, 2000);

  function clearWallpaperEngineCaptureGrant(sessionId = '') {
    const expectedSessionId = String(sessionId || '');
    if (expectedSessionId && !wallpaperEngineCaptureGrant) return false;
    if (expectedSessionId && wallpaperEngineCaptureGrant.sessionId !== expectedSessionId) return false;
    if (!wallpaperEngineCaptureGrant) return false;
    if (wallpaperEngineCaptureGrant && wallpaperEngineCapturePreparationOperation === wallpaperEngineCaptureGrant.operation) {
      wallpaperEngineCapturePreparationOperation = 0;
    }
    wallpaperEngineCaptureGrant = null;
    wallpaperEngineCaptureSourceId = '';
    return true;
  }

  function createWallpaperEngineCaptureGrant(result, operation, options = {}) {
    const sessionId = String(result && result.sessionId || '');
    const sourceId = String(result && result.sourceId || '');
    if (!/^[a-f0-9]{24}$/i.test(sessionId) || !sourceId) {
      clearWallpaperEngineCaptureGrant();
      return null;
    }
    wallpaperEngineCaptureSourceId = sourceId;
    wallpaperEngineCaptureGrant = {
      sessionId,
      sourceId,
      operation: Number(operation) || 0,
      kind: options.kind === 'dwm-glass' ? 'dwm-glass' : 'scene',
      captureSource: options.captureSource || null,
      expiresAt: Date.now() + WALLPAPER_ENGINE_CAPTURE_GRANT_MS,
      requestStarted: false,
    };
    return wallpaperEngineCaptureGrant;
  }

  function getWallpaperEngineCaptureGrant() {
    const grant = wallpaperEngineCaptureGrant;
    if (!grant) return null;
    const active = wallpaperEngineRuntime.getStatus();
    if (Date.now() > grant.expiresAt || !active || !active.active || active.sessionId !== grant.sessionId) {
      clearWallpaperEngineCaptureGrant(grant.sessionId);
      return null;
    }
    return grant;
  }

  function isTrustedWallpaperEngineDisplayCapturePermission(webContents, origin, details) {
    try {
      if (!webContents || !mainWindow || mainWindow.isDestroyed() || webContents !== mainWindow.webContents || webContents.isDestroyed()) return false;
      if (!isLocalAppUrl(origin)) return false;
      if (details && details.isMainFrame === false) return false;
      const grant = getWallpaperEngineCaptureGrant();
      return !!grant && wallpaperEngineCaptureSourceId === grant.sourceId;
    } catch (_) {
      return false;
    }
  }

  function isTrustedWallpaperEnginePreparationMediaPermission(webContents, origin, details) {
    const grant = getWallpaperEngineCaptureGrant();
    if (!grant || wallpaperEngineCapturePreparationOperation !== grant.operation) return false;
    const mediaType = String(details && details.mediaType || '').toLowerCase();
    const mediaTypes = details && Array.isArray(details.mediaTypes)
      ? details.mediaTypes.map((value) => String(value || '').toLowerCase()).filter(Boolean)
      : [];
    if (mediaType.includes('audio') || mediaTypes.some((value) => value.includes('audio'))) return false;
    if (mediaType && !mediaType.includes('video')) return false;
    if (mediaTypes.length && !mediaTypes.every((value) => value.includes('video'))) return false;
    return isTrustedWallpaperEngineDisplayCapturePermission(webContents, origin, details);
  }

  async function prepareWallpaperEngineRendererCapture(sessionId, fps) {
    if (!mainWindow || mainWindow.isDestroyed() || !/^[a-f0-9]{24}$/i.test(String(sessionId || ''))) {
      return { ok: false, error: 'WALLPAPER_CAPTURE_RENDERER_UNAVAILABLE' };
    }
    const safeSessionId = String(sessionId);
    const safeFps = Math.max(24, Math.min(WALLPAPER_ENGINE_MAX_CAPTURE_FPS, Number(fps) || 60));
    const grant = getWallpaperEngineCaptureGrant();
    if (!grant || grant.sessionId !== safeSessionId) return { ok: false, error: 'WALLPAPER_CAPTURE_GRANT_MISSING' };
    const safeSourceId = /^window:\d+:\d+$/.test(String(grant.sourceId || '')) ? String(grant.sourceId) : '';
    if (!safeSourceId) return { ok: false, error: 'WALLPAPER_CAPTURE_SOURCE_INVALID' };
    const script = `(() => {
    const prepare = window.__mineradioPrepareWallpaperEngineCapture;
    if (typeof prepare !== 'function') return { ok: false, error: 'WALLPAPER_CAPTURE_PREPARE_HANDLER_MISSING' };
    return Promise.resolve(prepare(${JSON.stringify(safeSessionId)}, ${safeFps}, ${JSON.stringify(safeSourceId)}))
      .then((value) => value && typeof value === 'object' ? value : { ok: false, error: 'WALLPAPER_CAPTURE_PREPARE_RESULT_INVALID' })
      .catch((error) => ({ ok: false, error: String(error && (error.message || error.name) || error || 'WALLPAPER_CAPTURE_PREPARE_FAILED').slice(0, 500) }));
  })()`;
    let timeout;
    try {
      wallpaperEngineCapturePreparationOperation = grant.operation;
      const result = await Promise.race([
        mainWindow.webContents.executeJavaScript(script, true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve({ ok: false, error: 'WALLPAPER_CAPTURE_PREPARE_TIMEOUT' }), WALLPAPER_ENGINE_CAPTURE_PREPARE_TIMEOUT_MS);
        }),
      ]);
      return result && typeof result === 'object'
        ? { ok: result.ok === true, error: String(result.error || '').slice(0, 500) }
        : { ok: false, error: 'WALLPAPER_CAPTURE_PREPARE_RESULT_INVALID' };
    } catch (error) {
      return { ok: false, error: String(error && (error.message || error.name) || error || 'WALLPAPER_CAPTURE_PREPARE_FAILED').slice(0, 500) };
    } finally {
      if (wallpaperEngineCapturePreparationOperation === grant.operation) wallpaperEngineCapturePreparationOperation = 0;
      if (timeout) clearTimeout(timeout);
    }
  }

  async function prepareWallpaperEngineRendererGlassCapture(sessionId, fps, sourceId) {
    if (!mainWindow || mainWindow.isDestroyed() || !/^[a-f0-9]{24}$/i.test(String(sessionId || ''))) {
      return { ok: false, error: 'WALLPAPER_GLASS_CAPTURE_RENDERER_UNAVAILABLE' };
    }
    const safeSessionId = String(sessionId);
    const safeFps = Math.max(24, Math.min(60, Number(fps) || 60));
    const safeSourceId = /^window:\d+:\d+$/.test(String(sourceId || '')) ? String(sourceId) : '';
    const grant = getWallpaperEngineCaptureGrant();
    if (!grant || grant.kind !== 'dwm-glass' || grant.sessionId !== safeSessionId
      || grant.sourceId !== safeSourceId) {
      return { ok: false, error: 'WALLPAPER_GLASS_CAPTURE_GRANT_MISSING' };
    }
    const script = `(() => {
    const prepare = window.__mineradioPrepareWallpaperEngineGlassCapture;
    if (typeof prepare !== 'function') return { ok: false, error: 'WALLPAPER_GLASS_CAPTURE_PREPARE_HANDLER_MISSING' };
    return Promise.resolve(prepare(${JSON.stringify(safeSessionId)}, ${safeFps}, ${JSON.stringify(safeSourceId)}))
      .then((value) => value && typeof value === 'object' ? value : { ok: false, error: 'WALLPAPER_GLASS_CAPTURE_PREPARE_RESULT_INVALID' })
      .catch((error) => ({ ok: false, error: String(error && (error.message || error.name) || error || 'WALLPAPER_GLASS_CAPTURE_PREPARE_FAILED').slice(0, 500) }));
  })()`;
    let timeout;
    try {
      wallpaperEngineCapturePreparationOperation = grant.operation;
      const result = await Promise.race([
        mainWindow.webContents.executeJavaScript(script, true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve({ ok: false, error: 'WALLPAPER_GLASS_CAPTURE_PREPARE_TIMEOUT' }), WALLPAPER_ENGINE_CAPTURE_PREPARE_TIMEOUT_MS);
        }),
      ]);
      return result && typeof result === 'object'
        ? { ok: result.ok === true, error: String(result.error || '').slice(0, 500) }
        : { ok: false, error: 'WALLPAPER_GLASS_CAPTURE_PREPARE_RESULT_INVALID' };
    } catch (error) {
      return { ok: false, error: String(error && (error.message || error.name) || error || 'WALLPAPER_GLASS_CAPTURE_PREPARE_FAILED').slice(0, 500) };
    } finally {
      if (wallpaperEngineCapturePreparationOperation === grant.operation) wallpaperEngineCapturePreparationOperation = 0;
      if (timeout) clearTimeout(timeout);
    }
  }

  async function prepareWallpaperEngineRendererHostBoundsFrame(sessionId, reason = 'bounds-changed') {
    if (!mainWindow || mainWindow.isDestroyed() || !/^[a-f0-9]{24}$/i.test(String(sessionId || ''))) {
      return { ok: false, frozen: false, error: 'WALLPAPER_BOUNDS_FREEZE_RENDERER_UNAVAILABLE' };
    }
    const safeSessionId = String(sessionId);
    const safeReason = String(reason || 'bounds-changed').slice(0, 80);
    const script = `(() => {
    const prepare = window.__mineradioPrepareWallpaperEngineHostBoundsChange;
    if (typeof prepare !== 'function') return { ok: false, frozen: false, error: 'WALLPAPER_BOUNDS_FREEZE_HANDLER_MISSING' };
    try {
      const value = prepare(${JSON.stringify(safeSessionId)}, ${JSON.stringify(safeReason)});
      return value && typeof value === 'object'
        ? value
        : { ok: false, frozen: false, error: 'WALLPAPER_BOUNDS_FREEZE_RESULT_INVALID' };
    } catch (error) {
      return { ok: false, frozen: false, error: String(error && (error.message || error.name) || error || 'WALLPAPER_BOUNDS_FREEZE_FAILED').slice(0, 500) };
    }
  })()`;
    try {
      // Do not race executeJavaScript with a timeout. A timed-out renderer script
      // cannot be cancelled and may run later, freeze the new frame, and clear the
      // live capture after main has already abandoned the restart. This promise is
      // asynchronous and does not block Electron's main loop; renderer teardown
      // rejects it during crash/navigation cleanup.
      const result = await mainWindow.webContents.executeJavaScript(script, true);
      return result && typeof result === 'object'
        ? { ok: result.ok === true, frozen: result.frozen === true, error: String(result.error || '').slice(0, 500) }
        : { ok: false, frozen: false, error: 'WALLPAPER_BOUNDS_FREEZE_RESULT_INVALID' };
    } catch (error) {
      return { ok: false, frozen: false, error: String(error && (error.message || error.name) || error || 'WALLPAPER_BOUNDS_FREEZE_FAILED').slice(0, 500) };
    }
  }

  async function prepareWallpaperEngineRendererDesktopPreview(sessionId, reason = 'full-desktop-passive') {
    const safeSessionId = String(sessionId || '');
    const safeReason = String(reason || 'full-desktop-passive').slice(0, 80);
    if (!mainWindow || mainWindow.isDestroyed()
      || (safeSessionId && !/^[a-f0-9]{24}$/i.test(safeSessionId))) {
      return { ok: false, preview: false, error: 'WALLPAPER_DESKTOP_PREVIEW_RENDERER_UNAVAILABLE' };
    }
    const script = `(() => {
    const prepare = window.__mineradioPrepareWallpaperEngineDesktopPreview;
    if (typeof prepare !== 'function') {
      return { ok: false, preview: false, error: 'WALLPAPER_DESKTOP_PREVIEW_HANDLER_MISSING' };
    }
    return Promise.resolve(prepare(${JSON.stringify(safeSessionId)}, ${JSON.stringify(safeReason)}))
      .then((value) => value && typeof value === 'object'
        ? value
        : { ok: false, preview: false, error: 'WALLPAPER_DESKTOP_PREVIEW_RESULT_INVALID' })
      .catch((error) => ({
        ok: false,
        preview: false,
        error: String(error && (error.message || error.name) || error || 'WALLPAPER_DESKTOP_PREVIEW_FAILED').slice(0, 500)
      }));
  })()`;
    try {
      const result = await mainWindow.webContents.executeJavaScript(script, true);
      return result && typeof result === 'object'
        ? {
          ok: result.ok === true,
          preview: result.preview === true,
          selectedEngine: result.selectedEngine === true,
          skipped: result.skipped === true,
          error: String(result.error || '').slice(0, 500),
        }
        : { ok: false, preview: false, error: 'WALLPAPER_DESKTOP_PREVIEW_RESULT_INVALID' };
    } catch (error) {
      return {
        ok: false,
        preview: false,
        error: String(error && (error.message || error.name) || error || 'WALLPAPER_DESKTOP_PREVIEW_FAILED').slice(0, 500),
      };
    }
  }

  function waitForWallpaperEngineHelperExit(child, timeoutMs = 2200) {
    if (!child || child.exitCode !== null || child.signalCode != null) return Promise.resolve(true);
    if (typeof child.once !== 'function') return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (typeof child.removeListener === 'function') {
          child.removeListener('exit', onExit);
          child.removeListener('close', onExit);
        }
        resolve(exited === true);
      };
      const onExit = () => finish(true);
      child.once('exit', onExit);
      child.once('close', onExit);
      timer = setTimeout(() => finish(false), Math.max(600, Number(timeoutMs) || 2200));
    });
  }

  function cancelWallpaperEngineHostBoundsRestart() {
    if (wallpaperEngineHostBoundsRestartTimer) {
      clearTimeout(wallpaperEngineHostBoundsRestartTimer);
      wallpaperEngineHostBoundsRestartTimer = null;
    }
    wallpaperEngineHostBoundsRestartPending = false;
    wallpaperEngineHostBoundsStopPromise = null;
    wallpaperEngineHostBoundsFollowupReason = '';
    wallpaperEngineHostBoundsOperation += 1;
  }

  function stopWallpaperEngineRuntimeForRenderer(reason = '') {
    wallpaperEngineCaptureOperation += 1;
    cancelWallpaperEngineHostBoundsRestart();
    clearWallpaperEngineCaptureGrant();
    return wallpaperEngineRuntime.stop().catch((error) => {
      console.warn('[Wallpaper Engine] renderer cleanup failed:', reason || 'renderer-reset', error && error.message || error);
      return { ok: false, stopped: false, error: String(error && (error.message || error.name) || error || 'WALLPAPER_ENGINE_STOP_FAILED') };
    });
  }

  function setMainWindowBackgroundThrottling(targetWin, enabled) {
    if (!targetWin || targetWin.isDestroyed() || !targetWin.webContents || targetWin.webContents.isDestroyed()) return;
    try {
      targetWin.webContents.setBackgroundThrottling(enabled === true);
    } catch (_) { }
  }

  function finishWallpaperEngineVisibleHostResume(targetWin) {
    wallpaperEngineHostVisibilityResumePending = false;
    if (wallpaperEngineHostVisibilityResumeTimer) {
      clearTimeout(wallpaperEngineHostVisibilityResumeTimer);
      wallpaperEngineHostVisibilityResumeTimer = null;
    }
    const desktopMode = fullDesktopModeRuntime.getStatus('wallpaper-engine-resume-finished');
    setMainWindowBackgroundThrottling(targetWin, desktopMode.enabled === true ? false : MAIN_WINDOW_BACKGROUND_THROTTLING);
  }

  function suspendWallpaperEngineForHiddenHost(targetWin, reason = 'hidden') {
    if (!targetWin || targetWin.isDestroyed()) return Promise.resolve({ ok: true, stopped: false });
    const normalizedReason = String(reason || 'hidden').toLowerCase();
    const runtimeStatus = wallpaperEngineRuntime.getStatus();
    if (/^minimi[sz]e(?:d)?$/.test(normalizedReason)
      && runtimeStatus
      && runtimeStatus.active === true
      && runtimeStatus.captureMode === 'dwm-thumbnail'
      && runtimeStatus.dwmSurfaceReady === true) {
      // The DWM helper is an independent native surface and can remain resident
      // while Chromium is minimized. Stopping it here discards Scene state and
      // forces a visible reload on restore.
      wallpaperEngineHostVisibilityResidentMinimized = true;
      finishWallpaperEngineVisibleHostResume(targetWin);
      cancelWallpaperEngineHostBoundsRestart();
      return Promise.resolve({
        ok: true,
        stopped: false,
        preserved: true,
        sessionId: String(runtimeStatus.sessionId || ''),
      });
    }
    wallpaperEngineHostVisibilityResidentMinimized = false;
    if (wallpaperEngineHostVisibilitySuspended) {
      return wallpaperEngineHostVisibilityStopPromise || Promise.resolve({ ok: true, stopped: true });
    }
    wallpaperEngineHostVisibilitySuspended = true;
    wallpaperEngineHostVisibilityOperation += 1;
    finishWallpaperEngineVisibleHostResume(targetWin);
    cancelWallpaperEngineHostBoundsRestart();
    try {
      targetWin.webContents.send('mineradio-wallpaper-engine-host-bounds-changed', {
        phase: 'prepare',
        reason: String(reason || 'hidden'),
      });
    } catch (_) { }
    wallpaperEngineHostVisibilityStopPromise = stopWallpaperEngineRuntimeForRenderer(`host-${reason || 'hidden'}`);
    return wallpaperEngineHostVisibilityStopPromise;
  }

  function resumeWallpaperEngineForVisibleHost(targetWin, reason = 'visible') {
    const desktopMode = fullDesktopModeRuntime.getStatus('wallpaper-engine-visible-host');
    if (app.isQuitting || (desktopMode.enabled === true
      && (desktopMode.interactive !== true || desktopMode.phase !== 'interactive'))) return;
    if (!wallpaperEngineHostVisibilitySuspended) {
      if (!wallpaperEngineHostVisibilityResidentMinimized) return;
      wallpaperEngineHostVisibilityResidentMinimized = false;
      const residentStatus = wallpaperEngineRuntime.getStatus();
      if (!residentStatus || residentStatus.active !== true || residentStatus.captureMode !== 'dwm-thumbnail') return;
      setMainWindowBackgroundThrottling(targetWin, false);
      syncWallpaperEngineDesktopIconLayering(`resident-${reason || 'visible'}`).catch(() => false);
      const notifyResident = () => {
        if (!targetWin || targetWin.isDestroyed() || !targetWin.isVisible() || targetWin.isMinimized()) return;
        try {
          targetWin.webContents.send('mineradio-wallpaper-engine-host-bounds-changed', {
            phase: 'resident',
            reason: String(reason || 'visible'),
            sessionId: String(residentStatus.sessionId || ''),
            forceVisibleHost: true,
          });
        } catch (_) { }
      };
      setTimeout(notifyResident, 80);
      setTimeout(notifyResident, 420);
      setTimeout(() => finishWallpaperEngineVisibleHostResume(targetWin), 900);
      return;
    }
    wallpaperEngineHostVisibilitySuspended = false;
    wallpaperEngineHostVisibilityResumePending = true;
    const visibilityOperation = ++wallpaperEngineHostVisibilityOperation;
    const forceVisibleHost = /^full-desktop-/i.test(String(reason || ''));
    // Electron's background-throttling switch also controls Page Visibility.
    // Temporarily disabling it makes a newly shown tray/minimized window visible
    // to Chromium before we ask the renderer to create the WE capture stream.
    setMainWindowBackgroundThrottling(targetWin, false);
    if (wallpaperEngineHostVisibilityResumeTimer) clearTimeout(wallpaperEngineHostVisibilityResumeTimer);
    wallpaperEngineHostVisibilityResumeTimer = setTimeout(() => {
      finishWallpaperEngineVisibleHostResume(targetWin);
    }, WALLPAPER_ENGINE_HOST_RESUME_TIMEOUT_MS);
    const notifyRestart = () => {
      if (wallpaperEngineHostVisibilityOperation !== visibilityOperation
        || wallpaperEngineHostVisibilitySuspended
        || !targetWin
        || targetWin.isDestroyed()
        || !targetWin.isVisible()
        || targetWin.isMinimized()) return;
      try {
        targetWin.webContents.send('mineradio-wallpaper-engine-host-bounds-changed', {
          phase: 'restart',
          reason: String(reason || 'visible'),
          forceVisibleHost,
        });
      } catch (_) { }
    };
    const stopped = wallpaperEngineHostVisibilityStopPromise;
    Promise.resolve(stopped).catch(() => null).finally(() => {
      if (wallpaperEngineHostVisibilityStopPromise === stopped) wallpaperEngineHostVisibilityStopPromise = null;
      if (wallpaperEngineHostVisibilityOperation !== visibilityOperation || wallpaperEngineHostVisibilitySuspended) return;
      setTimeout(notifyRestart, 80);
      setTimeout(notifyRestart, 420);
      setTimeout(notifyRestart, 1100);
    });
  }

  function fullDesktopIconLayeringDesired(reason = '') {
    const status = fullDesktopModeRuntime.getStatus(reason || 'dwm-icon-layering');
    return status.enabled === true
      && status.interactive === true
      && status.coexisting === true
      && status.iconShapeActive === true;
  }

  function syncWallpaperEngineDesktopIconLayering(reason = 'desktop-state', desiredOverride) {
    const operation = async () => {
      const desired = typeof desiredOverride === 'boolean'
        ? desiredOverride
        : fullDesktopIconLayeringDesired(`${reason}-queued`);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const active = wallpaperEngineRuntime.getStatus();
        if (!active || active.active !== true || !active.sessionId
          || active.captureMode !== 'dwm-thumbnail') return true;
        try {
          const updated = await wallpaperEngineRuntime.updateDwmDesktopIconLayering(active.sessionId, desired);
          if (updated === true) return true;
        } catch (error) {
          console.warn('[FullDesktopMode] DWM desktop-icon layering sync failed:', reason, error && error.message || error);
        }
        if (attempt < 3) await startupDelay(70 + attempt * 55);
      }
      console.warn('[FullDesktopMode] DWM desktop-icon layering was not acknowledged:', reason, desired);
      return false;
    };
    wallpaperEngineDesktopIconLayeringQueue = wallpaperEngineDesktopIconLayeringQueue.then(operation, operation);
    return wallpaperEngineDesktopIconLayeringQueue;
  }

  function scheduleWallpaperEngineHostBoundsRestart(targetWin, reason = 'bounds-changed') {
    if (!targetWin || targetWin.isDestroyed()) return;
    const status = wallpaperEngineRuntime.getStatus();
    // The DWM surface helper follows the authoritative host HWND and resizes the
    // source in place. Restarting the Scene here would discard native parallax
    // state and reintroduce the old capture-only lifecycle on every drag.
    if (status && status.active === true && status.captureMode === 'dwm-thumbnail') return;
    if (!wallpaperEngineHostBoundsRestartPending && (!status || status.active !== true)) return;
    let job = wallpaperEngineHostBoundsStopPromise;
    if (job && job.started === true) {
      // A second movement after the settled restart began is handled once the new
      // capture ACK arrives. Continuous native dragging never reaches this branch
      // because the real debounce below is reset on every move/resize event.
      wallpaperEngineHostBoundsFollowupReason = String(reason || 'bounds-changed').slice(0, 80);
      return;
    }
    if (!job) {
      wallpaperEngineHostBoundsRestartPending = true;
      job = {
        boundsOperation: ++wallpaperEngineHostBoundsOperation,
        captureOperation: 0,
        sessionId: String(status && status.sessionId || ''),
        reason: String(reason || 'bounds-changed').slice(0, 80),
        started: false,
        promise: null,
      };
      wallpaperEngineHostBoundsStopPromise = job;
    } else {
      job.reason = String(reason || job.reason || 'bounds-changed').slice(0, 80);
    }
    if (wallpaperEngineHostBoundsRestartTimer) clearTimeout(wallpaperEngineHostBoundsRestartTimer);
    wallpaperEngineHostBoundsRestartTimer = setTimeout(() => {
      wallpaperEngineHostBoundsRestartTimer = null;
      if (wallpaperEngineHostBoundsStopPromise !== job || job.started === true) return;
      const currentBeforePrepare = wallpaperEngineRuntime.getStatus();
      if (!currentBeforePrepare || currentBeforePrepare.active !== true
        || String(currentBeforePrepare.sessionId || '') !== job.sessionId) {
        wallpaperEngineHostBoundsStopPromise = null;
        wallpaperEngineHostBoundsRestartPending = false;
        return;
      }
      job.started = true;
      job.captureOperation = ++wallpaperEngineCaptureOperation;
      clearWallpaperEngineCaptureGrant();
      job.promise = prepareWallpaperEngineRendererHostBoundsFrame(job.sessionId, job.reason)
        .then(async (prepared) => {
          const current = wallpaperEngineRuntime.getStatus();
          const stale = wallpaperEngineHostBoundsStopPromise !== job
            || wallpaperEngineHostBoundsOperation !== job.boundsOperation
            || wallpaperEngineCaptureOperation !== job.captureOperation
            || wallpaperEngineHostVisibilitySuspended
            || targetWin.isDestroyed()
            || !current
            || current.active !== true
            || String(current.sessionId || '') !== job.sessionId;
          if (stale) {
            return {
              ok: false,
              stale: true,
              frozen: !!(prepared && prepared.frozen === true),
              stopped: false,
            };
          }
          // Never tear down the live source unless the renderer preserved a real
          // frame. Once frozen, however, always release the renderer by starting a
          // fresh session even if the old native HWND refuses its first close.
          if (!prepared || prepared.ok !== true || prepared.frozen !== true) {
            return {
              ok: false,
              frozen: false,
              stopped: false,
              error: String(prepared && prepared.error || 'WALLPAPER_BOUNDS_FREEZE_UNAVAILABLE'),
            };
          }
          try {
            const stopped = await wallpaperEngineRuntime.stop(job.sessionId);
            return { ok: true, frozen: true, stopped: !!(stopped && stopped.stopped), result: stopped };
          } catch (error) {
            return {
              ok: false,
              frozen: true,
              stopped: false,
              error: String(error && (error.message || error.name) || error || 'WALLPAPER_BOUNDS_RUNTIME_STOP_FAILED'),
            };
          }
        });
      Promise.resolve(job.promise).then((result) => {
        const ownsCurrentJob = wallpaperEngineHostBoundsStopPromise === job;
        const operationCurrent = wallpaperEngineHostBoundsOperation === job.boundsOperation
          && wallpaperEngineCaptureOperation === job.captureOperation;
        if (ownsCurrentJob) {
          wallpaperEngineHostBoundsStopPromise = null;
          wallpaperEngineHostBoundsRestartPending = false;
        }
        if (!result || result.frozen !== true) return;
        // A renderer freeze can complete after another operation cancelled and
        // detached this job. The freeze itself is not cancellable, so its late
        // completion must still receive a visible-host recovery signal; otherwise
        // the renderer can remain permanently stuck on the preserved frame.
        const recoveryOnly = !ownsCurrentJob || !operationCurrent || result.stale === true;
        setTimeout(() => {
          if (wallpaperEngineHostVisibilitySuspended
            || targetWin.isDestroyed()
            || !targetWin.isVisible()
            || targetWin.isMinimized()) return;
          if (!recoveryOnly && (wallpaperEngineHostBoundsOperation !== job.boundsOperation
            || wallpaperEngineCaptureOperation !== job.captureOperation)) return;
          try {
            targetWin.webContents.send('mineradio-wallpaper-engine-host-bounds-changed', {
              phase: 'restart',
              reason: recoveryOnly ? 'bounds-stale-recovery' : job.reason,
              forceVisibleHost: true,
            });
          } catch (_) { }
        }, 90);
      }).catch(() => {
        if (wallpaperEngineHostBoundsStopPromise === job) {
          wallpaperEngineHostBoundsStopPromise = null;
          wallpaperEngineHostBoundsRestartPending = false;
        }
      });
    }, 260);
  }

  function wallpaperEngineTargetFps(display, requestedFps) {
    const displayFrequency = Math.max(24, Math.min(
      WALLPAPER_ENGINE_MAX_CAPTURE_FPS,
      Math.round(Number(display && display.displayFrequency) || 60)
    ));
    const requested = Number(requestedFps);
    if (!Number.isFinite(requested) || requested <= 0) return displayFrequency;
    return Math.max(24, Math.min(displayFrequency, WALLPAPER_ENGINE_MAX_CAPTURE_FPS, Math.round(requested)));
  }

  function wallpaperEngineHostCornerRadius(targetWin) {
    if (!targetWin || targetWin.isDestroyed() || targetWin.isMaximized() || targetWin.isFullScreen()
      || windowFullscreenActive || htmlFullscreenActive) return 0;
    const bounds = targetWin.getContentBounds();
    const display = screen.getDisplayMatching(bounds);
    const scaleFactor = Math.max(1, Number(display && display.scaleFactor) || 1);
    return Math.max(0, Math.round(34 * scaleFactor));
  }

  function wallpaperEnginePhysicalContentBounds(targetWin, fallback = {}) {
    const bounds = targetWin && !targetWin.isDestroyed()
      ? targetWin.getContentBounds()
      : {
        x: Number(fallback.x) || 0,
        y: Number(fallback.y) || 0,
        width: Number(fallback.width) || 1280,
        height: Number(fallback.height) || 720,
      };
    const display = screen.getDisplayMatching(bounds);
    const scaleFactor = Math.max(1, Number(display && display.scaleFactor) || 1);
    if (targetWin && !targetWin.isDestroyed() && typeof screen.dipToScreenRect === 'function') {
      try {
        const physicalRect = screen.dipToScreenRect(targetWin, bounds);
        if (physicalRect && Number(physicalRect.width) > 0 && Number(physicalRect.height) > 0) {
          return {
            bounds,
            display,
            scaleFactor,
            x: Math.round(Number(physicalRect.x) || 0),
            y: Math.round(Number(physicalRect.y) || 0),
            width: Math.max(1, Math.round(Number(physicalRect.width) || 1)),
            height: Math.max(1, Math.round(Number(physicalRect.height) || 1)),
          };
        }
      } catch (_) { }
    }
    const dipOrigin = { x: Number(bounds.x) || 0, y: Number(bounds.y) || 0 };
    const dipEnd = {
      x: dipOrigin.x + Math.max(1, Number(bounds.width) || Number(fallback.width) || 1280),
      y: dipOrigin.y + Math.max(1, Number(bounds.height) || Number(fallback.height) || 720),
    };
    const physicalOrigin = typeof screen.dipToScreenPoint === 'function'
      ? screen.dipToScreenPoint(dipOrigin)
      : { x: Math.round(dipOrigin.x * scaleFactor), y: Math.round(dipOrigin.y * scaleFactor) };
    const physicalEnd = typeof screen.dipToScreenPoint === 'function'
      ? screen.dipToScreenPoint(dipEnd)
      : { x: Math.round(dipEnd.x * scaleFactor), y: Math.round(dipEnd.y * scaleFactor) };
    return {
      bounds,
      display,
      scaleFactor,
      x: Number.isFinite(Number(physicalOrigin.x)) ? Number(physicalOrigin.x) : 0,
      y: Number.isFinite(Number(physicalOrigin.y)) ? Number(physicalOrigin.y) : 0,
      width: Math.max(1, Math.abs(Math.round(Number(physicalEnd.x) - Number(physicalOrigin.x))) || Math.round((Number(bounds.width) || 1280) * scaleFactor)),
      height: Math.max(1, Math.abs(Math.round(Number(physicalEnd.y) - Number(physicalOrigin.y))) || Math.round((Number(bounds.height) || 720) * scaleFactor)),
    };
  }

  // WE 相关会话权限（Ported from Mineradio desktop/main.js:1654-1763；media 分支含手势摄像头授权补移植）。
  // display-capture/media 仅在一次性捕获授权（grant）有效时放行；其余权限走本地应用白名单。
  function configureLocalAppPermissions() {
    const ses = session.defaultSession;
    if (!ses || ses._wePermissionsConfigured) return;
    ses._wePermissionsConfigured = true;
    ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      const origin = requestingOrigin || (details && details.requestingUrl) || (webContents && webContents.getURL && webContents.getURL()) || '';
      if (permission === 'display-capture') return isTrustedWallpaperEngineDisplayCapturePermission(webContents, origin, details);
      if (permission === 'media') return isTrustedWallpaperEnginePreparationMediaPermission(webContents, origin, details)
        || isTrustedGestureCameraMediaPermission(webContents, origin, details); // 手势摄像头（MR desktop/main.js:1661-1662）
      return LOCAL_APP_PERMISSION_ALLOWLIST.has(permission) && isLocalAppUrl(origin);
    });
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const origin = (details && (details.requestingUrl || details.securityOrigin)) || (webContents && webContents.getURL && webContents.getURL()) || '';
      if (permission === 'display-capture') {
        callback(isTrustedWallpaperEngineDisplayCapturePermission(webContents, origin, details));
        return;
      }
      if (permission === 'media') {
        callback(isTrustedWallpaperEnginePreparationMediaPermission(webContents, origin, details)
          || isTrustedGestureCameraMediaPermission(webContents, origin, details)); // 手势摄像头（MR desktop/main.js:1671-1674）
        return;
      }
      callback(LOCAL_APP_PERMISSION_ALLOWLIST.has(permission) && isLocalAppUrl(origin));
    });
    ses.setDisplayMediaRequestHandler((request, callback) => {
      let replied = false;
      const reply = (value) => {
        if (replied) return;
        replied = true;
        callback(value || {});
      };
      Promise.resolve().then(async () => {
        const frame = request && request.frame;
        const trustedFrame = !!(frame
          && mainWindow
          && !mainWindow.isDestroyed()
          && frame === mainWindow.webContents.mainFrame
          && !frame.parent
          && isLocalAppUrl(request.securityOrigin));
        const grant = getWallpaperEngineCaptureGrant();
        if (!trustedFrame || !request.videoRequested || request.audioRequested || !grant || grant.requestStarted) {
          reply({});
          return;
        }
        grant.requestStarted = true;
        if (grant.kind === 'dwm-glass') {
          const current = wallpaperEngineRuntime.getStatus();
          const source = grant.captureSource;
          const sourceMatch = /^window:(\d+):\d+$/.exec(String(source && source.id || ''));
          if (wallpaperEngineCaptureGrant !== grant
            || !current
            || current.active !== true
            || current.sessionId !== grant.sessionId
            || current.dwmGlassSurfaceReady !== true
            || current.dwmGlassSurfaceActive !== true
            || !sourceMatch
            || Number(sourceMatch[1]) !== Number(current.dwmGlassSurfaceWindowId)
            || String(source && source.name || '') !== 'Mineradio WE DWM Surface') {
            reply({});
            return;
          }
          reply({ video: source });
          return;
        }
        let refreshed = typeof wallpaperEngineRuntime.refreshActiveSource === 'function'
          ? await wallpaperEngineRuntime.refreshActiveSource(grant.sessionId, {
            timeoutMs: 1600,
            pollIntervalMs: 80,
            includeSource: true,
          })
          : wallpaperEngineRuntime.getStatus();
        let source = refreshed && refreshed.captureSource;
        if (wallpaperEngineCaptureGrant !== grant
          || !refreshed
          || refreshed.sessionId !== grant.sessionId
          || !refreshed.sourceId
          || !source
          || String(source.id || '') !== String(refreshed.sourceId)) {
          reply({});
          return;
        }
        if (refreshed.sourceWindowAligned !== true || String(refreshed.sourceId) !== String(grant.sourceId || '')) {
          await wallpaperEngineRuntime.embedActiveWindow(grant.sessionId, {
            hostWindowId: nativeWindowHandleDecimal(mainWindow),
            hostExecutable: process.execPath,
            cornerRadius: wallpaperEngineHostCornerRadius(mainWindow),
            desktopIconLayering: fullDesktopIconLayeringDesired('wallpaper-engine-source-refresh'),
          });
          refreshed = await wallpaperEngineRuntime.refreshActiveSource(grant.sessionId, {
            timeoutMs: 1600,
            pollIntervalMs: 80,
            includeSource: true,
          });
          source = refreshed && refreshed.captureSource;
        }
        if (wallpaperEngineCaptureGrant !== grant
          || !refreshed
          || refreshed.sessionId !== grant.sessionId
          || refreshed.sourceWindowAligned !== true
          || !source
          || String(source.id || '') !== String(refreshed.sourceId || '')) {
          reply({});
          return;
        }
        grant.sourceId = String(refreshed.sourceId);
        wallpaperEngineCaptureSourceId = grant.sourceId;
        reply({ video: source });
      }).catch(() => reply({}));
    }, { useSystemPicker: false });
  }

  // ===== 缓存存储设置 IPC（Ported from Mineradio 2.2.0, GPL-3.0, desktop/main.js:4136-4165 + 4881-4888）=====
  ipcMain.handle('dsh-cache-get-settings', async () => {
    try { return await dshCacheSettingsSnapshot(); }
    catch (error) { return { ok: false, error: error.message || 'CACHE_SETTINGS_READ_FAILED' }; }
  });
  ipcMain.handle('dsh-cache-choose-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择缓存目录',
      defaultPath: dshCacheSettings ? dshCacheSettings.rootPath : dshDefaultCacheRootPath(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: true, canceled: true };
    return { ok: true, canceled: false, rootPath: dshNormalizeCacheRootPath(result.filePaths[0]) };
  });
  ipcMain.handle('dsh-cache-set-settings', async (_event, payload = {}) => {
    try {
      const nextRoot = dshNormalizeCacheRootPath(payload.rootPath);
      fs.mkdirSync(nextRoot, { recursive: true });
      fs.accessSync(nextRoot, fs.constants.W_OK);
      dshCacheSettings = dshEnsureCacheDirectories(dshWriteCacheSettings({ rootPath: nextRoot }));
      const snapshot = await dshCacheSettingsSnapshot();
      return snapshot;
    } catch (error) {
      return { ok: false, error: error.message || 'CACHE_SETTINGS_WRITE_FAILED' };
    }
  });
  ipcMain.handle('dsh-restart-app', async () => {
    try {
      app.relaunch();
      app.exit(0); // 与 MR 同款硬重启（desktop/main.js:4881-4888）；WE 壁纸进程由其自身的看护逻辑处理
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || 'RESTART_FAILED' };
    }
  });

  // ===== 手势摄像头权限 IPC（Ported from Mineradio 2.2.0, GPL-3.0, desktop/main.js:4989-4993，桥名原样保留）=====
  // 渲染层开摄像头前先经此签发 45s 一次性授权（gestureCameraPermissionGrant），
  // 随后 getUserMedia 触发的 media 权限请求由 configureLocalAppPermissions 凭该授权放行。
  ipcMain.handle('mineradio-gesture-camera-request-permission', async (event) => {
    const grant = createGestureCameraPermissionGrant(event);
    if (!grant) return { ok: false, error: 'GESTURE_CAMERA_UNTRUSTED_SENDER' };
    return { ok: true, expiresAt: grant.expiresAt };
  });

  // ===== WE IPC（Ported from Mineradio desktop/main.js:4168-4560）=====
  ipcMain.handle('mineradio-wallpaper-engine-list', async (event, payload = {}) => {
    try {
      if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, projects: [], count: 0, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
      const snapshot = await wallpaperEngineLibrary.list({ force: payload && payload.force === true });
      const runtime = await wallpaperEngineRuntime.probe(payload && payload.force === true);
      return { ...snapshot, runtime };
    } catch (error) {
      return { ok: false, projects: [], count: 0, error: error.message || 'WALLPAPER_ENGINE_SCAN_FAILED' };
    }
  });

  ipcMain.handle('mineradio-wallpaper-engine-project-details', async (event, id) => {
    try {
      if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
      return await wallpaperEngineLibrary.getProjectDetails(String(id || ''));
    } catch (error) {
      return { ok: false, error: error.message || 'WALLPAPER_ENGINE_PROJECT_DETAILS_FAILED' };
    }
  });

  ipcMain.handle('mineradio-wallpaper-engine-open-project-details', async (event, payload = {}) => {
    try {
      if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
      const details = await wallpaperEngineLibrary.getProjectDetails(String(payload && payload.id || ''));
      const workshopId = String(details && details.workshopId || '');
      if (!/^\d{5,32}$/.test(workshopId)) {
        return { ok: false, error: 'WALLPAPER_ENGINE_WORKSHOP_DETAILS_UNAVAILABLE' };
      }
      const target = payload && payload.target === 'workshop' ? 'workshop' : 'we';
      let revealError = '';
      if (target === 'we') {
        try {
          await wallpaperEngineRuntime.revealWorkshop(workshopId);
          return { ok: true, opened: 'wallpaper-engine', workshopId };
        } catch (error) {
          revealError = error && (error.code || error.message) || 'WALLPAPER_ENGINE_REVEAL_FAILED';
        }
      }
      const steamUri = 'steam://url/CommunityFilePage/' + workshopId;
      try {
        await shell.openExternal(steamUri);
        return { ok: true, opened: 'steam-workshop', workshopId, fallback: target === 'we', revealError };
      } catch (_) {
        const webUrl = 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + workshopId;
        await shell.openExternal(webUrl);
        return { ok: true, opened: 'web-workshop', workshopId, fallback: target === 'we', revealError };
      }
    } catch (error) {
      return { ok: false, error: error.message || 'WALLPAPER_ENGINE_OPEN_PROJECT_DETAILS_FAILED' };
    }
  });

  ipcMain.handle('mineradio-wallpaper-engine-choose-directory', async (event) => {
    try {
      if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, canceled: false, projects: [], count: 0, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
      const options = {
        title: '识别并导入 Wallpaper Engine 项目',
        buttonLabel: '识别此目录',
        properties: ['openDirectory'],
      };
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: true, canceled: true };
      const snapshot = await wallpaperEngineLibrary.addManualRoot(result.filePaths[0]);
      const runtime = await wallpaperEngineRuntime.probe(false);
      return { ...snapshot, runtime, canceled: false };
    } catch (error) {
      return { ok: false, canceled: false, projects: [], count: 0, error: error.message || 'WALLPAPER_ENGINE_IMPORT_FAILED' };
    }
  });

  ipcMain.handle('mineradio-wallpaper-engine-choose-project-file', async (event) => {
    try {
      if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, canceled: false, projects: [], count: 0, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
      const options = {
        title: '选择 Wallpaper Engine 的 project.json 或场景包（.pkg/.pak）',
        buttonLabel: '导入此项目',
        properties: ['openFile'],
        filters: [
          { name: 'Wallpaper Engine 项目', extensions: ['pkg', 'pak', 'json'] },
        ],
      };
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: true, canceled: true };
      const selected = path.resolve(result.filePaths[0]);
      const snapshot = await wallpaperEngineLibrary.addManualProjectFile(selected);
      const runtime = await wallpaperEngineRuntime.probe(false);
      return { ...snapshot, runtime, canceled: false };
    } catch (error) {
      return { ok: false, canceled: false, projects: [], count: 0, error: error.message || 'WALLPAPER_ENGINE_IMPORT_PROJECT_FAILED' };
    }
  });

  ipcMain.handle('mineradio-wallpaper-engine-remove-directory', async (event, rootId) => {
    try {
      if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, projects: [], count: 0, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
      const snapshot = await wallpaperEngineLibrary.removeManualRoot(rootId);
      const runtime = await wallpaperEngineRuntime.probe(false);
      return { ...snapshot, runtime };
    } catch (error) {
      return { ok: false, projects: [], count: 0, error: error.message || 'WALLPAPER_ENGINE_REMOVE_ROOT_FAILED' };
    }
  });

  ipcMain.handle('mineradio-wallpaper-engine-runtime-status', async (event, payload = {}) => {
    try {
      if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, available: false, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
      const probe = await wallpaperEngineRuntime.probe(payload && payload.force === true);
      // W-5：渲染层轮询状态 = "会话是否就绪"的天然判定点（含启动自动恢复）；就绪则确保守卫在跑
      if (wallpaperEngineRuntime.getStatus().active === true) startWallpaperTaskbarGuard();
      else stopWallpaperTaskbarGuard();
      // W-8 C：附带守卫只读计数（诊断"守卫到底有没有动手"，比日志更直观）
      return { ...probe, ...wallpaperEngineRuntime.getStatus(), pending: wallpaperEngineRuntime.pending != null,
        wallpaperTaskbarGuard: { ...wallpaperTaskbarGuardStats } };
    } catch (error) {
      return { ok: false, available: false, error: error.message || 'WALLPAPER_ENGINE_RUNTIME_PROBE_FAILED' };
    }
  });

  ipcMain.handle('mineradio-wallpaper-engine-start-scene', async (event, payload = {}) => {
    let operation = 0;
    let startedSessionId = '';
    try {
      if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
      operation = ++wallpaperEngineCaptureOperation;
      const desktopMode = fullDesktopModeRuntime.getStatus('wallpaper-engine-start-scene');
      if (wallpaperEngineHostVisibilitySuspended
        || (desktopMode.enabled === true
          && (desktopMode.interactive !== true || desktopMode.phase !== 'interactive'))) {
        return { ok: false, error: 'WALLPAPER_ENGINE_HOST_SUSPENDED' };
      }
      const physicalBounds = wallpaperEnginePhysicalContentBounds(mainWindow, payload);
      const display = physicalBounds.display;
      const targetFps = wallpaperEngineTargetFps(display, payload.fps);
      const hostCornerRadius = wallpaperEngineHostCornerRadius(mainWindow);
      const result = await wallpaperEngineRuntime.start(String(payload.id || ''), {
        // The native scene follows the authoritative BrowserWindow content rect;
        // renderer innerWidth/innerHeight can be stale during a DPI transition.
        width: Math.max(640, Math.min(7680, physicalBounds.width)),
        height: Math.max(360, Math.min(4320, physicalBounds.height)),
        fps: targetFps,
        x: physicalBounds.x,
        y: physicalBounds.y,
      });
      startedSessionId = String(result && result.sessionId || '');
      if (operation !== wallpaperEngineCaptureOperation) {
        await wallpaperEngineRuntime.stop(startedSessionId).catch(() => {});
        return { ok: false, error: 'WALLPAPER_ENGINE_START_SUPERSEDED', sessionId: startedSessionId };
      }
      let embedded;
      try {
        embedded = await wallpaperEngineRuntime.embedActiveWindow(startedSessionId, {
          hostWindowId: nativeWindowHandleDecimal(mainWindow),
          hostExecutable: process.execPath,
          cornerRadius: hostCornerRadius,
          desktopIconLayering: fullDesktopIconLayeringDesired('wallpaper-engine-embed'),
        });
      } catch (embeddingError) {
        clearWallpaperEngineCaptureGrant(startedSessionId);
        await wallpaperEngineRuntime.stop(startedSessionId).catch(() => {});
        return {
          ok: false,
          error: embeddingError && (embeddingError.code || embeddingError.message) || 'WALLPAPER_ENGINE_WINDOW_ISOLATION_FAILED',
          capturePrepared: false,
          sessionId: startedSessionId,
        };
      }
      if (operation !== wallpaperEngineCaptureOperation) {
        await wallpaperEngineRuntime.stop(startedSessionId).catch(() => {});
        return { ok: false, error: 'WALLPAPER_ENGINE_START_SUPERSEDED', sessionId: startedSessionId };
      }
      // Adaptive pixel calibration can relaunch the WE pop-out and replace its
      // HWND/sourceId. Build the one-shot grant only after embedding has settled
      // so the renderer never captures the stale pre-calibration window.
      const grant = createWallpaperEngineCaptureGrant({ ...result, ...embedded }, operation);
      if (!grant) {
        await wallpaperEngineRuntime.stop(startedSessionId).catch(() => {});
        return { ok: false, error: 'WALLPAPER_ENGINE_CAPTURE_UNAVAILABLE', sessionId: startedSessionId };
      }
      const embeddedDesktop = fullDesktopModeRuntime.getStatus('wallpaper-engine-embed-finished');
      if (mainWindow && !mainWindow.isDestroyed() && embeddedDesktop.enabled !== true) {
        try { mainWindow.moveTop(); } catch (_) { }
        try { mainWindow.focus(); } catch (_) { }
      } else if (embeddedDesktop.enabled === true && embeddedDesktop.interactive === true) {
        fullDesktopModeRuntime.ensureIconLayerOrder().catch((error) => {
          console.warn('[FullDesktopMode] WE coexistence z-order refresh failed:', error && error.message || error);
        });
      }
      if (operation !== wallpaperEngineCaptureOperation) {
        clearWallpaperEngineCaptureGrant(grant.sessionId);
        await wallpaperEngineRuntime.stop(grant.sessionId).catch(() => {});
        return { ok: false, error: 'WALLPAPER_ENGINE_START_SUPERSEDED', sessionId: grant.sessionId };
      }
      // Native Scene mode is composed by DWM, not captured as a Chromium video.
      // The renderer keeps this one-shot grant only for the readiness ACK; the
      // runtime starts a click-through live surface underneath the transparent
      // BrowserWindow and leaves the exact WE source aligned behind it.
      return { ...result, ...embedded, capturePrepared: true, captureMode: 'dwm-thumbnail' };
    } catch (error) {
      if (startedSessionId) {
        clearWallpaperEngineCaptureGrant(startedSessionId);
        await wallpaperEngineRuntime.stop(startedSessionId).catch(() => {});
      } else if (wallpaperEngineCaptureGrant && wallpaperEngineCaptureGrant.operation === operation) {
        clearWallpaperEngineCaptureGrant();
      }
      return { ok: false, error: error.code || error.message || 'WALLPAPER_ENGINE_SCENE_START_FAILED', sessionId: startedSessionId };
    }
  });

  ipcMain.handle('mineradio-wallpaper-engine-capture-result', async (event, payload = {}) => {
    if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
    const sessionId = String(payload && payload.sessionId || '');
    if (!/^[a-f0-9]{24}$/i.test(sessionId)) return { ok: false, error: 'WALLPAPER_ENGINE_SESSION_INVALID' };
    const matched = clearWallpaperEngineCaptureGrant(sessionId);
    let confirmed = false;
    if (matched && payload && payload.ok === true && typeof wallpaperEngineRuntime.confirmCaptureReady === 'function') {
      confirmed = await wallpaperEngineRuntime.confirmCaptureReady(sessionId).catch(() => false);
    }
    if (matched && !confirmed) {
      wallpaperEngineHostBoundsFollowupReason = '';
      await wallpaperEngineRuntime.stop(sessionId).catch(() => {});
    }
    if (matched && confirmed && wallpaperEngineHostVisibilityResumePending) {
      finishWallpaperEngineVisibleHostResume(mainWindow);
    }
    if (matched && confirmed && wallpaperEngineHostBoundsFollowupReason) {
      const followupReason = wallpaperEngineHostBoundsFollowupReason;
      wallpaperEngineHostBoundsFollowupReason = '';
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return;
        scheduleWallpaperEngineHostBoundsRestart(mainWindow, followupReason);
      }, 90);
    }
    if (matched && confirmed) {
      syncWallpaperEngineDesktopIconLayering('wallpaper-engine-capture-ready').catch(() => {});
    }
    return {
      ok: matched && confirmed,
      accepted: matched,
      captureReady: confirmed,
      error: matched && !confirmed ? 'WALLPAPER_ENGINE_DWM_SURFACE_FAILED' : '',
    };
  });

  ipcMain.handle('mineradio-wallpaper-engine-prepare-glass-capture', async (event, payload = {}) => {
    if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
    const sessionId = String(payload && payload.sessionId || '');
    if (!/^[a-f0-9]{24}$/i.test(sessionId)) return { ok: false, error: 'WALLPAPER_ENGINE_SESSION_INVALID' };
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()
      || wallpaperEngineHostVisibilitySuspended) {
      return { ok: false, error: 'WALLPAPER_GLASS_CAPTURE_HOST_HIDDEN' };
    }
    const captureOperation = wallpaperEngineCaptureOperation;
    const glassOperation = ++wallpaperEngineGlassCaptureOperation;
    try {
      const status = wallpaperEngineRuntime.getStatus();
      if (!status || status.active !== true || status.sessionId !== sessionId
        || status.captureMode !== 'dwm-thumbnail'
        || status.dwmGlassSurfaceReady !== true || status.dwmGlassSurfaceActive !== true) {
        return { ok: false, error: 'WALLPAPER_ENGINE_DWM_GLASS_SURFACE_UNAVAILABLE' };
      }
      const source = await wallpaperEngineRuntime.getDwmGlassCaptureSource(sessionId, {
        timeoutMs: 1800,
        pollIntervalMs: 60,
      });
      if (captureOperation !== wallpaperEngineCaptureOperation
        || glassOperation !== wallpaperEngineGlassCaptureOperation) {
        return { ok: false, error: 'WALLPAPER_ENGINE_START_SUPERSEDED' };
      }
      if (wallpaperEngineCaptureGrant && wallpaperEngineCaptureGrant.kind !== 'dwm-glass') {
        return { ok: false, error: 'WALLPAPER_GLASS_CAPTURE_GRANT_BUSY' };
      }
      clearWallpaperEngineCaptureGrant();
      const grant = createWallpaperEngineCaptureGrant({ sessionId, sourceId: source.id }, glassOperation, {
        kind: 'dwm-glass',
        captureSource: source,
      });
      if (!grant) return { ok: false, error: 'WALLPAPER_GLASS_CAPTURE_SOURCE_INVALID' };
      const prepared = await prepareWallpaperEngineRendererGlassCapture(sessionId, payload && payload.fps, source.id);
      const current = wallpaperEngineRuntime.getStatus();
      if (captureOperation !== wallpaperEngineCaptureOperation
        || glassOperation !== wallpaperEngineGlassCaptureOperation
        || !current || current.active !== true || current.sessionId !== sessionId) {
        return { ok: false, error: 'WALLPAPER_ENGINE_START_SUPERSEDED' };
      }
      if (prepared && prepared.ok === true) reassertWallpaperTaskbarHidden(); // ③ 玻璃采样就绪后再重申
      return {
        ok: !!(prepared && prepared.ok === true),
        capturePrepared: !!(prepared && prepared.ok === true),
        captureMode: 'dwm-glass-svg-sampler',
        error: String(prepared && prepared.error || ''),
      };
    } catch (error) {
      return {
        ok: false,
        error: String(error && (error.code || error.message || error.name) || error || 'WALLPAPER_GLASS_CAPTURE_PREPARE_FAILED').slice(0, 500),
      };
    } finally {
      if (wallpaperEngineCaptureGrant
        && wallpaperEngineCaptureGrant.kind === 'dwm-glass'
        && wallpaperEngineCaptureGrant.operation === glassOperation) {
        clearWallpaperEngineCaptureGrant(sessionId);
      }
    }
  });

  ipcMain.handle('mineradio-wallpaper-engine-activate-dwm-surface', async (event, payload = {}) => {
    if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
    const sessionId = String(payload && payload.sessionId || '');
    if (!/^[a-f0-9]{24}$/i.test(sessionId)) return { ok: false, error: 'WALLPAPER_ENGINE_SESSION_INVALID' };
    try {
      const result = await wallpaperEngineRuntime.activateDwmSurface(sessionId);
      return {
        ok: !!(result && result.dwmSurfaceActive === true),
        active: !!(result && result.dwmSurfaceActive === true),
        captureMode: 'dwm-thumbnail',
        error: result && result.dwmSurfaceActive === true ? '' : 'WALLPAPER_ENGINE_DWM_SURFACE_FAILED',
      };
    } catch (error) {
      return { ok: false, active: false, error: String(error && (error.code || error.message) || error || 'WALLPAPER_ENGINE_DWM_SURFACE_FAILED') };
    }
  });

  ipcMain.on('mineradio-wallpaper-engine-glass-surface', (event, payload = {}) => {
    if (!isTrustedWallpaperEngineIpc(event) || typeof wallpaperEngineRuntime.updateGlassSurface !== 'function') return;
    const sessionId = String(payload && payload.sessionId || '');
    if (!/^[a-f0-9]{24}$/i.test(sessionId)) return;
    if (payload.active === true && (!mainWindow
      || mainWindow.isDestroyed()
      || !mainWindow.isVisible()
      || mainWindow.isMinimized()
      || wallpaperEngineHostVisibilitySuspended)) return;
    try { wallpaperEngineRuntime.updateGlassSurface(sessionId, payload); } catch (_) { }
  });

  ipcMain.on('mineradio-wallpaper-engine-visual-settings', (event, payload = {}) => {
    if (!isTrustedWallpaperEngineIpc(event) || typeof wallpaperEngineRuntime.updateDwmVisualSettings !== 'function') return;
    const sessionId = String(payload && payload.sessionId || '');
    if (!/^[a-f0-9]{24}$/i.test(sessionId)) return;
    const opacity = Number(payload.opacity);
    const positionX = Number(payload.positionX);
    const positionY = Number(payload.positionY);
    const scale = Number(payload.scale);
    if (![opacity, positionX, positionY, scale].every(Number.isFinite)) return;
    wallpaperEngineRuntime.updateDwmVisualSettings(sessionId, { opacity, positionX, positionY, scale });
  });

  ipcMain.on('mineradio-wallpaper-engine-pointer-activity', (event, payload = {}) => {
    if (!isTrustedWallpaperEngineIpc(event)
      || !mainWindow
      || mainWindow.isDestroyed()
      || !mainWindow.isVisible()
      || mainWindow.isMinimized()
      || wallpaperEngineHostVisibilitySuspended) return;
    const sessionId = String(payload && payload.sessionId || '');
    if (!/^[a-f0-9]{24}$/i.test(sessionId)) return;
    const rawXUnit = payload && payload.xUnit;
    const rawYUnit = payload && payload.yUnit;
    const xUnit = Math.round(rawXUnit);
    const yUnit = Math.round(rawYUnit);
    if (typeof rawXUnit !== 'number' || typeof rawYUnit !== 'number'
      || !Number.isFinite(xUnit) || !Number.isFinite(yUnit)
      || xUnit < 0 || xUnit > 65535 || yUnit < 0 || yUnit > 65535) return;
    const status = wallpaperEngineRuntime.getStatus();
    if (!status
      || status.active !== true
      || status.sourceWindowParked !== true
      || String(status.sessionId || '') !== sessionId
      || typeof wallpaperEngineRuntime.noteHostPointerActivity !== 'function') return;
    try {
      wallpaperEngineRuntime.noteHostPointerActivity({ sessionId, xUnit, yUnit });
    } catch (_) { }
  });

  ipcMain.handle('mineradio-wallpaper-engine-stop-scene', async (event, payload = {}) => {
    try {
      if (!isTrustedWallpaperEngineIpc(event)) return { ok: false, error: 'WALLPAPER_ENGINE_UNTRUSTED_CALLER' };
      const sessionId = String(payload.sessionId || '');
      const stopAll = payload && payload.all === true || !sessionId;
      // Invalidate pending preparation before awaiting the old source shutdown.
      // Otherwise a new start can begin during the close wait and then be
      // incorrectly superseded when this stop handler resumes.
      if (stopAll) {
        wallpaperEngineCaptureOperation += 1;
        cancelWallpaperEngineHostBoundsRestart();
        clearWallpaperEngineCaptureGrant();
      }
      const result = await wallpaperEngineRuntime.stop(stopAll ? '' : sessionId);
      const current = wallpaperEngineRuntime.getStatus();
      if (!current.active) stopWallpaperTaskbarGuard(); // W-5：会话结束 → 收守卫（清 interval）
      if (!stopAll && (!current.active || (wallpaperEngineCaptureGrant && wallpaperEngineCaptureGrant.sessionId === sessionId))) {
        clearWallpaperEngineCaptureGrant(sessionId);
      }
      return result;
    } catch (error) {
      return { ok: false, error: error.code || error.message || 'WALLPAPER_ENGINE_SCENE_STOP_FAILED' };
    }
  });
  // ===== Wallpaper Engine 集成编排段结束 =====

  let win = null;
  // ===== W-13 B：看门狗/自愈 状态（配套 main.js:6060 `window-all-closed` 空实现的结构事实）=====
  // winHadBeenCreated：启动宽限期 —— 窗口创建完成前 win 恒为 null，不设它会把每次冷启动都判成"无窗僵尸"。
  // selfHealingInProgress：与 W-12 自愈互斥，否则看门狗可能在 app.relaunch() 之前 exit(0)，把自愈废掉（两个救命装置互相掐死）。
  // quitInFlight：before-quit 置位。app.isQuitting 只被部分退出入口设置（update:install 的 quitAndInstall 不设它），只看 app.isQuitting 会误判"更新安装中"。
  let winHadBeenCreated = false;
  let selfHealingInProgress = false;
  let quitInFlight = false;
  let tray = null;
  let library = store.load('library.json', { songs: [], scannedAt: 0 });
  let config = store.load('config.json', { dirs: DEFAULT_DIRS, volume: 0.8, mode: 'order', lyricWin: LYRIC_DEFAULTS, bgBlur: 2.5, autoLaunch: false, closeBehavior: 'tray', downloadOverwrite: false, autoSrcUpgrade: true, defaultPlSeeded: false });
  config.autoLaunch = app.getLoginItemSettings().openAtLogin; // 开机自启实际状态
  config.lyricWin = { ...LYRIC_DEFAULTS, ...(config.lyricWin || {}) };
  // #17 默认值美学迁移：旧版本升级后强制重置为新默认（保留用户窗口位置 pos/lockedSize，不重置几何）
  if (!config.defaultsV || config.defaultsV < 2) {
    const oldPos = config.lyricWin.pos || null;
    const oldLs = config.lyricWin.lockedSize || { width: 840, height: 160 };
    config.bgBlur = 2.5;
    config.lyricWin = { ...LYRIC_DEFAULTS, pos: oldPos, lockedSize: oldLs };
    config.defaultsV = 2;
    store.save('config.json', config);
  }
  // 快捷键配置合并：存量配置保留用户自定义值，新增动作补默认值（local=应用内聚焦生效，global=全局注册）
  config.hotkeys = { enabled: true, binds: {}, ...(config.hotkeys || {}) };
  const songIndex = new Map(); // id -> song（O(1) 查找）
  const lyricsCache = new Map(); // id -> { text, mtime }

  function rebuildIndex() {
    songIndex.clear();
    for (const s of library.songs || []) songIndex.set(s.id, s);
  }
  rebuildIndex();

  app.setAppUserModelId('com.lyraaria.musicplayer');

  // ---------- 窗口 ----------
  function appIcon() {
    return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 1120,
      height: 740,
      minWidth: 840,
      minHeight: 580,
      title: '深空折韵',
      icon: appIcon(),
      frame: false, // 去掉系统标题栏（白框+最小化/放大/关闭）；自绘顶栏 #topbar + 窗口控制 #winCtrl
      backgroundColor: '#f3f5f9',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    // 无边框窗口控制（自绘按钮 → IPC）：最小化 / 最大化切换 / 关闭（走现有 close 行为=托盘或退出）
    ipcMain.on('win:min', (e) => { if (isTrusted(e) && !win.isDestroyed()) win.minimize(); });
    ipcMain.on('win:max-toggle', (e) => { if (isTrusted(e) && !win.isDestroyed()) { if (win.isMaximized()) win.unmaximize(); else win.maximize(); } });
    ipcMain.on('win:close', (e) => { if (isTrusted(e) && !win.isDestroyed()) win.close(); });
    const pushMaxState = () => { try { if (!win.isDestroyed()) win.webContents.send('win:max-changed', win.isMaximized()); } catch { /* 窗口已销毁 */ } };
    win.on('maximize', pushMaxState);
    win.on('unmaximize', pushMaxState);
    try { win.setHasShadow(true); } catch { /* 平台不支持则忽略 */ } // 无边框窗口系统投影（Windows/macOS）
    win.webContents.setBackgroundThrottling(false); // 最小化/后台时保持渲染：任务栏缩略图实时更新
    mainWindow = win; // WE 编排段沿用 MR 的 mainWindow 命名
    // ===== WE 宿主生命周期钩子（Ported from Mineradio 2.2.0, GPL-3.0, desktop/main.js:5640-5875）=====
    win.webContents.on('did-navigate', () => { stopWallpaperEngineRuntimeForRenderer('main-frame-navigation'); });
    win.webContents.on('destroyed', () => { stopWallpaperEngineRuntimeForRenderer('webcontents-destroyed'); });
    win.webContents.on('render-process-gone', (_e, details) => {
      Promise.resolve(stopWallpaperEngineRuntimeForRenderer(`render-process-gone:${details && details.reason || 'unknown'}`)).catch(() => {});
    });
    win.on('minimize', () => { if (fullDesktopModeHostVisibilityTransitionDepth <= 0) suspendWallpaperEngineForHiddenHost(win, 'minimize'); });
    win.on('restore', () => { if (fullDesktopModeHostVisibilityTransitionDepth <= 0) resumeWallpaperEngineForVisibleHost(win, 'restore'); });
    win.on('show', () => { resumeWallpaperEngineForVisibleHost(win, 'show'); });
    win.on('hide', () => { suspendWallpaperEngineForHiddenHost(win, 'hide'); });
    win.on('move', () => { scheduleWallpaperEngineHostBoundsRestart(win, 'move'); });
    win.on('resize', () => { scheduleWallpaperEngineHostBoundsRestart(win, 'resize'); });
    win.on('enter-full-screen', () => {
      windowFullscreenActive = true;
      setTimeout(() => scheduleWallpaperEngineHostBoundsRestart(win, 'enter-full-screen'), 40);
    });
    win.on('leave-full-screen', () => {
      windowFullscreenActive = false;
      setTimeout(() => scheduleWallpaperEngineHostBoundsRestart(win, 'leave-full-screen'), 50);
    });
    win.on('enter-html-full-screen', () => {
      htmlFullscreenActive = true;
      setTimeout(() => scheduleWallpaperEngineHostBoundsRestart(win, 'enter-html-full-screen'), 40);
    });
    win.on('leave-html-full-screen', () => {
      htmlFullscreenActive = false;
      setTimeout(() => scheduleWallpaperEngineHostBoundsRestart(win, 'leave-html-full-screen'), 50);
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    // W-13 A：窗口创建完成点（B 的看门狗以此作为宽限期起点，故必须落盘可对齐）
    winHadBeenCreated = true; // W-13 B：宽限期起点（此前 win 恒 null，不得计时）
    try { shutLog('window-created', 'hwnd=' + win.getNativeWindowHandle().readBigUInt64LE(0)); } catch { shutLog('window-created'); }
    // W-15 演练开关（**默认关闭**）：仅当显式设置 DSH_WATCHDOG_DRILL=1 时，窗口创建后主动销毁主窗
    // （不走退出流程），人为制造"进程活着但窗口已不存在"的形态，交给看门狗自然接管。
    // 用途：给"看门狗确实会动手"留下正向证据（W-13 验收 3/4 因沙箱起不了实例而未拿到）。
    // 生产路径零行为变化：不设该环境变量时，这段完全不存在效果。
    if (process.env.DSH_WATCHDOG_DRILL) {
      setTimeout(() => {
        try {
          shutLog('drill', 'DSH_WATCHDOG_DRILL -> win.destroy()（人为制造无窗态，等看门狗接管）');
          if (win && !win.isDestroyed()) win.destroy();
        } catch { /* 演练失败不影响主流程 */ }
      }, 1200);
    }
    win.on('close', (e) => {
      shutLog('win-close', 'isQuitting=' + !!app.isQuitting + ' closeBehavior=' + config.closeBehavior); // W-13 A
      if (!app.isQuitting) {
        if (config.closeBehavior === 'exit') {
          shutLog('quit-request', 'closeBehavior=exit (window close)'); // W-13 A
          app.isQuitting = true; app.quit(); return;
        }
        e.preventDefault();
        win.hide(); // 关闭 → 后台托盘运行（任务栏按钮消失，托盘图标恢复窗口）
      }
    });
    win.on('closed', () => { shutLog('win-closed', 'isDestroyed=' + (!win || win.isDestroyed())); }); // W-13 A：销毁点（僵尸态的关键前因）
    // ---- 缩略图封面原生注入：任何状态下任务栏缩略图 = 歌曲封面（酷狗式）----
    // 关键：DWMWA_FORCE_ICONIC_REPRESENTATION = 7（此前误用 6=DWMWA_NONCLIENT_RTL_LAYOUT，
    // 强制图标化从未生效 → 前台 hover 一直是窗口内容 live preview——这正是"任何情况下都是封面"没实现的根因）
    // FORCE_ICONIC + HAS_ICONIC_BITMAP 始终开启 → DWM 任何状态（前台/后台/最小化）hover 任务栏都发 0x0323 → 注入封面
    if (iconicThumb) {
      const hwndBig = win.getNativeWindowHandle().readBigUInt64LE(0);
      const pTrue = iconicThumb.koffi.alloc('int', 1);
      iconicThumb.DwmSetWindowAttribute(hwndBig, 10, pTrue, 4); // DWMWA_HAS_ICONIC_BITMAP（声明支持图标化缩略图）
      const hrForce = iconicThumb.DwmSetWindowAttribute(hwndBig, 7, pTrue, 4);  // DWMWA_FORCE_ICONIC_REPRESENTATION（强制 iconic 表示 → 前台 hover 也走 0x0323）
      try { fs.appendFileSync(path.join(dataRoot(), '_thumb.log'), `[${new Date().toLocaleTimeString()}] 设置 FORCE_ICONIC(7) hr=0x${(Number(hrForce) >>> 0).toString(16)}\n`); } catch {}
      win.hookWindowMessage(0x0323, (w, l) => {
        const wd = w >>> 0, ht = l >>> 0;
        try { fs.appendFileSync(path.join(dataRoot(), '_thumb.log'), `[${new Date().toLocaleTimeString()}] 0x0323 触发 w=${wd} h=${ht} thumbDIB=${!!thumbDIB}\n`); } catch {}
        if (wd <= 0 || ht <= 0) return;
        if (!thumbDIB) thumbDIB = ensureDefaultThumbDIB(); // 无封面兜底（深色默认图，保证任何情况都有图）
        if (!thumbDIB) return;
        try {
          const ok = injectIconicThumbnail(wd, ht, win); // 在 0x0323 处理器内（正确时机+尺寸）注入封面
          if (!ok) throw new Error('DwmSetIconicThumbnail 失败');
        } catch (err) {
          console.error('[播放器] 缩略图注入失败:', err.message);
          // 降级：注入失败 → 异步关 FORCE_ICONIC → DWM 回退普通快照（避免缩略图空白）
          setImmediate(() => {
            try {
              const pFalse = iconicThumb.koffi.alloc('int', 0);
              iconicThumb.DwmSetWindowAttribute(hwndBig, 7, pFalse, 4);
              try { fs.appendFileSync(path.join(dataRoot(), '_thumb.log'), '[降级] 已关 FORCE_ICONIC，回退普通快照\n'); } catch {}
            } catch {}
          });
        }
      });
      // 0x0324（WM_DWMSENDICONICLIVEPREVIEWBITMAP）：前台 hover 任务栏/Aero Peek 时 DWM 请求实时预览位图
      win.hookWindowMessage(0x0324, (w, l) => {
        try { fs.appendFileSync(path.join(dataRoot(), '_thumb.log'), `[${new Date().toLocaleTimeString()}] 0x0324 触发 w=${w >>> 0} h=${l >>> 0}\n`); } catch {}
        injectLivePreview(win);
      });
      ipcMain.on('thumb:dib', (e, payload) => {
        if (!isTrusted(e) || !payload || !payload.buf) return;
        thumbDIB = { buf: Buffer.from(payload.buf), w: payload.w | 0, h: payload.h | 0 };
        // 新位图（含播放状态）→ 使图标化位图无效，DWM 重新发 0x0323 → 注入新缩略图（修复暂停/播放不同步）
        try { if (iconicThumb && !win.isDestroyed()) iconicThumb.DwmInvalidateIconicBitmaps(win.getNativeWindowHandle().readBigUInt64LE(0)); } catch {}
        try { fs.appendFileSync(path.join(dataRoot(), '_thumb.log'), `[${new Date().toLocaleTimeString()}] thumb:dib 收到 w=${thumbDIB.w} h=${thumbDIB.h} len=${thumbDIB.buf.length} + Invalidate\n`); } catch {}
      });
      // SMTC 任务栏音符按钮：切歌/播放/暂停时更新（首次调用初始化）
      ipcMain.on('smtc:update', (e, info) => {
        if (!isTrusted(e) || !info) return;
        if (info.enabled) smtcInit();
        smtcSet(info);
      });
    }
    // 窗口显示后再设置 DWM 图标化属性：窗口创建早期设置会被窗口显示流程重置（实测最小化不触发 0x0323 = 未生效）
    const applyIconicAttrs = () => {
      try {
        if (!iconicThumb || !win || win.isDestroyed()) return;
        const hwndBig = win.getNativeWindowHandle().readBigUInt64LE(0);
        const pTrue = iconicThumb.koffi.alloc('int', 1);
        iconicThumb.DwmSetWindowAttribute(hwndBig, 10, pTrue, 4); // DWMWA_HAS_ICONIC_BITMAP
        const hrF = iconicThumb.DwmSetWindowAttribute(hwndBig, 7, pTrue, 4); // DWMWA_FORCE_ICONIC_REPRESENTATION
        try { iconicThumb.DwmInvalidateIconicBitmaps(hwndBig); } catch {} // 使图标化位图无效 → DWM 重新发 0x0323/0x0324 请求
        try { fs.appendFileSync(path.join(dataRoot(), '_thumb.log'), `[${new Date().toLocaleTimeString()}] 窗口显示后重设 FORCE_ICONIC(7) hr=0x${(Number(hrF) >>> 0).toString(16)} + Invalidate\n`); } catch {}
      } catch {}
    };
    win.once('ready-to-show', () => {
      applyIconicAttrs();
      setTimeout(applyIconicAttrs, 800); // 首帧后再设一次（确保显示流程完成）
    });
    // 最小化/恢复：0x0323 处理器自动注入封面（FORCE_ICONIC 下任何状态都走注入路径，无需窗口内容切换）
    win.on('restore', () => {
      win.setThumbnailClip({ x: 0, y: 0, width: 0, height: 0 }); // 清除裁剪
      updateThumbar(false);
    });
    win.on('show', () => { if (win.isMinimized()) win.restore(); win.focus(); applyIconicAttrs(); updateThumbar(false); });
    // ===== 方案二 + 方案一结合：窗口背景=封面铺满 + hover 播放器任务栏按钮时切纯封面特写页 =====
    // 触发区域 = 播放器任务栏按钮矩形（GetTbBtn.exe 枚举 UIA Appid: com.dsh.musicplayer）+ 按钮上方的缩略图悬浮区
    // 状态机：仅"从按钮进入"激活；从按钮移到缩略图保持；离开恢复。（hover 时窗口内容切换为封面特写页属
    // Windows 任务栏预览的系统行为，用户确认接受）
    try {
      const { execFile } = require('child_process');
      const btnPath = app.isPackaged ? path.join(__dirname, '..', 'GetTbBtn.exe') : path.join(__dirname, 'GetTbBtn.exe');
      let btnRect = null; // {x,y,w,h} 物理坐标
      const refreshBtn = () => {
        execFile(btnPath, ['com.dsh.musicplayer'], { timeout: 3000, windowsHide: true }, (err, out) => {
          if (err) return;
          const s = (out || '').trim();
          if (s && s !== 'NONE') {
            const p = s.split(',').map(Number);
            if (p.length === 4 && p.every((n) => !isNaN(n) && n > 0)) btnRect = { x: p[0], y: p[1], w: p[2], h: p[3] };
          }
        });
      };
      refreshBtn();
      setInterval(refreshBtn, 10000); // 按钮位置随其他窗口开合变化，周期刷新
      const koffiU = require('koffi');
      const user32 = koffiU.load('user32.dll');
      koffiU.struct('DSH_TP_POINT', { x: 'long', y: 'long' });
      const getCursorPos = user32.func('int __stdcall GetCursorPos(void *pt)');
      const ptBuf = koffiU.alloc('DSH_TP_POINT', 1);
      let active = false; // 仅"从按钮进入"后激活；缩略图区只在激活时生效（鼠标直接从别处进该区域不触发）
      let outCount = 0; // 防抖：连续 ~120ms 不在区域内才退出（快速响应恢复）
      const setView = (on) => {
        if (!win.isDestroyed() && !win.isMinimized()) {
          win.webContents.send('thumb:view', on);
          try { fs.appendFileSync(path.join(dataRoot(), '_thumb.log'), `[${new Date().toLocaleTimeString()}] ${on ? '进入按钮区 → 封面特写页' : '离开 → 恢复主界面'}\n`); } catch {}
        }
      };
      setInterval(() => {
        try {
          if (!btnRect) return;
          getCursorPos(ptBuf);
          const pt = koffiU.decode(ptBuf, 'DSH_TP_POINT');
          const cx = btnRect.x + btnRect.w / 2;
          const inBtn = pt.x >= btnRect.x && pt.x <= btnRect.x + btnRect.w && pt.y >= btnRect.y && pt.y <= btnRect.y + btnRect.h;
          const inThumb = pt.y < btnRect.y && pt.y >= btnRect.y - 260 && pt.x >= cx - 130 && pt.x <= cx + 130; // 按钮上方缩略图悬浮区
          if (inBtn || (active && inThumb)) {
            outCount = 0;
            if (!active) { active = true; setView(true); } // 进入按钮 → 触发
          } else {
            outCount++;
            if (active && outCount >= 2) { active = false; outCount = 0; setView(false); } // 连续离开才恢复
          }
        } catch {}
      }, 60);
    } catch (e) { console.error('[播放器] 任务栏按钮检测失败:', e.message); }
  }

  // ---------- 任务栏缩略图（酷狗式：上一首/播放暂停/下一首 工具栏按钮） ----------
  function updateThumbar(playing) {
    if (!win || win.isDestroyed() || process.platform !== 'win32') return;
    const ic = (n) => nativeImage.createFromPath(path.join(__dirname, 'assets', 'thumb', n));
    win.setThumbarButtons([
      { tooltip: '上一首', icon: ic('prev.png'), click: () => sendMedia('prev') },
      { tooltip: playing ? '暂停' : '播放', icon: ic(playing ? 'pause.png' : 'play.png'), click: () => sendMedia('toggle') },
      { tooltip: '下一首', icon: ic('next.png'), click: () => sendMedia('next') }
    ]);
  }

  // ---------- 歌词悬浮窗（桌面 / 任务栏） ----------
  let lyricWin = null;
  let lyricLine = null;
  let lyricLrc = null; // 最近一次全量歌词缓存（悬浮窗重载后重发，恢复两句显示）
  let lyricHover = false; // 锁定状态下鼠标是否悬停在歌词上（悬停则显示解锁工具条）
  let lyricStripInteractive = false; // 锁定态下光标进入顶部锁图标条 → 临时恢复窗口交互（左键可点解锁）
  let lyricAdaptiveH = 0; // 渲染层 syncWinHeight 最近申请的自适应高度（0=未知，兜底 160）；防拉伸兜底用它而非固定 160

  // 从任务栏/任务视图/Alt+Tab 彻底隐藏歌词窗：Electron 43 的 skipTaskbar 在此组合下
  // 只移除 WS_EX_APPWINDOW、不添加 WS_EX_TOOLWINDOW → 任务视图/Win+Tab 仍会列出歌词页。
  // 用 koffi 直接补 WS_EX_TOOLWINDOW（工具窗口在所有切换器里都不出现）。
  let taskbarHider = null;
  try {
    const koffiT = require('koffi');
    const user32T = koffiT.load('user32.dll');
    const getEx = user32T.func('GetWindowLongPtrW', 'intptr_t', ['intptr_t', 'int']);
    const setEx = user32T.func('SetWindowLongPtrW', 'intptr_t', ['intptr_t', 'int', 'intptr_t']);
    const getAsyncKey = user32T.func('GetAsyncKeyState', 'int16', ['int']);
    let getTitle = null;
    try { getTitle = user32T.func('GetWindowTextA', 'int', ['intptr_t', 'char *', 'int']); } catch { getTitle = null; }
    taskbarHider = { getEx, setEx, getAsyncKey, getTitle };
  } catch { taskbarHider = null; }
  // W-5：任务栏隐藏补丁（从歌词窗那段抽出的通用实现；歌词窗路径行为与原实现逐字等价）。
  // 只加 WS_EX_TOOLWINDOW、剥 WS_EX_APPWINDOW —— 不改 owner、不动 ShowInTaskbar。
  function patchTaskbarHiddenFromHwnd(hwnd) {
    if (!taskbarHider || hwnd === null || hwnd === undefined) return false;
    try {
      const h = typeof hwnd === 'bigint' ? hwnd : BigInt(hwnd);
      const GWL_EXSTYLE = -20, TOOL = 0x80n, APP = 0x40000n;
      const ex = BigInt(taskbarHider.getEx(h, GWL_EXSTYLE));
      const want = BigInt.asIntN(64, (ex | TOOL) & ~APP);
      if (want !== ex) taskbarHider.setEx(h, GWL_EXSTYLE, want);
      return true;
    } catch { return false; }
  }
  function hideLyricFromTaskbar() {
    if (!taskbarHider || !lyricWin || lyricWin.isDestroyed()) return;
    try {
      const buf = lyricWin.getNativeWindowHandle();
      const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readInt32LE(0));
      patchTaskbarHiddenFromHwnd(hwnd);
    } catch { /* 忽略 */ }
  }

  function lyricWinCreate() {
    if (lyricWin) return;
    console.log('[深空折韵] 歌词悬浮窗创建');
    lyricWin = new BrowserWindow({
      width: 820, height: 140,
      frame: false, transparent: true, resizable: true,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
      focusable: false, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
    });
    lyricWin.webContents.setBackgroundThrottling(false); // 非聚焦窗口保持 rAF：卡拉OK渐变不被节流
    // screen-saver 层级（借鉴 Mineradio）：盖住全屏视频；副作用（WS_EX_APPWINDOW 出现在任务栏）
    // 由 hideLyricFromTaskbar()（koffi 补 WS_EX_TOOLWINDOW）在 show/配置/周期轮询三处清除
    lyricWin.setAlwaysOnTop(true, 'screen-saver');
    lyricWin.loadFile(path.join(__dirname, 'renderer', 'lyric-win.html'));
    lyricWin.webContents.on('did-finish-load', () => {
      applyLyricConfig();
      lyricWin.showInactive();
      // 兜底：showInactive/穿透切换可能覆盖 skipTaskbar（实测出现 WS_EX_APPWINDOW 导致任务栏出现歌词页）
      lyricWin.setSkipTaskbar(true);
      hideLyricFromTaskbar(); // 补 WS_EX_TOOLWINDOW：任务视图/Alt+Tab 也不显示歌词页
      if (lyricLrc) lyricWin.webContents.send('lyricwin:lrc', lyricLrc);
      if (lyricLine) lyricWin.webContents.send('lyricwin:line', lyricLine);
    });
    lyricWin.on('closed', () => { lyricWin = null; });
    // 保存歌词窗位置（固定尺寸 840x160；异常位置不保存）
    const saveLyricPos = () => {
      if (!lyricWin || lyricWin.isDestroyed()) return;
      const b = lyricWin.getBounds();
      if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
        config.lyricWin.pos = { x: b.x, y: b.y, width: 840, height: 160 };
        store.save('config.json', config);
      }
    };
    // 尺寸兜底：任何途径拉伸都弹回固定尺寸（taskbar 920x58 / desktop 840x160），防"按住拖动持续变大"
    // （原实现统一弹回 840x160：任务栏模式拖拽会被误弹成桌面大窗——BUG-D 修复）
    lyricWin.on('resize', () => {
      if (config.lyricWin.mode === 'taskbar') {
        positionLyricWin(); // 任务栏模式：弹回任务栏尺寸与底部位置
      } else {
        const s = lyricWin.getSize();
        // 高度以渲染层最近申请的自适应值为准（紧凑间距公式）；
        // 固定弹回 840x160 会覆盖自适应高度 → 间距压缩失效（2026-09-06 实测）
        const wantH = lyricAdaptiveH > 0 ? lyricAdaptiveH : 160;
        if (s[0] !== 840 || s[1] !== wantH) lyricWin.setSize(840, wantH);
        clearTimeout(moveTimer);
        moveTimer = setTimeout(saveLyricPos, 400);
      }
    });
    // 拖动位置记忆（仅桌面模式）+ 拖动结束后夹回屏幕内
    // （拖动中不干预，避免边缘抖动/抽搐；松手 350ms 后若出屏则弹回，否则保存位置）
    let moveTimer = null;
    lyricWin.on('move', () => {
      if (config.lyricWin.mode !== 'desktop') return;
      // v1.4.2：实时夹取（原 350ms 延迟弹回会造成边缘抽搐感）；保存仍防抖
      if (!lyricWin || lyricWin.isDestroyed()) return;
      const b = lyricWin.getBounds();
      const clamped = clampLyricWinBounds(b);
      if (clamped.x !== b.x || clamped.y !== b.y) {
        lyricWin.setPosition(clamped.x, clamped.y); // 出屏 → 立即弹回
        return;
      }
      clearTimeout(moveTimer);
      moveTimer = setTimeout(saveLyricPos, 400);
    });
    // 右键菜单
    lyricWin.webContents.on('context-menu', () => {
      const lc = config.lyricWin;
      const set = (patch) => { Object.assign(lc, patch); store.save('config.json', config); applyLyricConfig(); };
      Menu.buildFromTemplate([
        { label: '模式：桌面歌词', type: 'radio', checked: lc.mode === 'desktop', click: () => set({ mode: 'desktop' }) },
        { label: '模式：任务栏歌词', type: 'radio', checked: lc.mode === 'taskbar', click: () => set({ mode: 'taskbar' }) },
        { type: 'separator' },
        { label: '字号增大', click: () => set({ fontSize: Math.min(64, lc.fontSize + 2) }) },
        { label: '字号减小', click: () => set({ fontSize: Math.max(14, lc.fontSize - 2) }) },
        { type: 'separator' },
        { label: lc.locked ? '解锁（可拖动）' : '锁定（鼠标穿透）', click: () => set({ locked: !lc.locked }) },
        { type: 'separator' },
        { label: '隐藏歌词', click: () => lyricWinToggle(false) }
      ]).popup({ window: lyricWin });
    });
  }

  // 将歌词窗位置夹回屏幕工作区内（窗口完全在屏内，防止拖出屏幕）
  function clampLyricWinBounds(b) {
    try {
      const disp = screen.getDisplayMatching(b);
      if (!disp || !disp.workArea) return b;
      const wa = disp.workArea;
      if (typeof wa.x !== 'number' || typeof wa.y !== 'number' || typeof wa.width !== 'number' || typeof wa.height !== 'number' || wa.width <= 0) return b;
      const minX = wa.x, minY = wa.y;
      const maxX = wa.x + wa.width - b.width, maxY = wa.y + wa.height - b.height;
      return {
        x: Math.max(minX, Math.min(maxX, b.x)),
        y: Math.max(minY, Math.min(maxY, b.y)),
        width: b.width, height: b.height
      };
    } catch { return b; }
  }

  // v1.4.2（借鉴 Mineradio）：显示器增删/分辨率变化/睡眠唤醒布局变化 → 重新夹取歌词窗，防"跑出屏幕找不到"
  ['display-metrics-changed', 'display-added', 'display-removed'].forEach((evName) => {
    try {
      screen.on(evName, () => {
        if (config.lyricWin.enabled && lyricWin && !lyricWin.isDestroyed()) {
          positionLyricWin();
          hideLyricFromTaskbar();
        }
        // WE 活动会话跟随显示器布局变化（Ported from Mineradio，display-metrics-changed → bounds restart）
        scheduleWallpaperEngineHostBoundsRestart(win, evName);
      });
    } catch { /* 忽略 */ }
  });

  function positionLyricWin() {
    if (!lyricWin) return;
    const scr = screen.getPrimaryDisplay();
    const lc = config.lyricWin;
    if (lc.mode === 'taskbar') {
      const w = Math.min(scr.workArea.width - 60, 920);
      const h = 58;
      lyricWin.setResizable(false);
      lyricWin.setBounds({ x: Math.round((scr.workArea.x + scr.workArea.width - w) / 2), y: scr.workArea.y + scr.workArea.height - h, width: w, height: h });
    } else {
      if (lc.pos) {
        // 固定尺寸 840x160（忽略历史污染尺寸），位置用记忆值
        lyricWin.setBounds(clampLyricWinBounds({ x: lc.pos.x, y: lc.pos.y, width: 840, height: 160 }));
      } else {
        const w = 820, h = 140;
        lyricWin.setBounds({ x: Math.round((scr.workArea.x + scr.workArea.width - w) / 2), y: Math.round(scr.workArea.y + scr.workArea.height * 0.72), width: w, height: h });
      }
    }
  }

  function applyLyricConfig() {
    if (!lyricWin || lyricWin.isDestroyed()) return;
    const lc = config.lyricWin;
    positionLyricWin();
    // 简化方案：锁定/解锁都不改变窗口尺寸——解锁 = 可交互 + 底部浮现控制条，窗口保持原位大小
    // 注意：不可设为 resizable:false（与 transparent 组合会导致窗口收不到鼠标事件，彻底无法交互）
    // 拉伸防护由 resize 事件兜底完成（任何拉伸立即弹回 840x160）
    lyricWin.setResizable(true);
    // 兜底：强制固定尺寸 840x160（忽略历史污染尺寸）
    const cur = lyricWin.getSize();
    if (cur[0] !== 840 || cur[1] !== 160) lyricWin.setSize(840, 160);
    // v1.4.2 修复：锁定=真穿透（不再因悬停恢复交互——那会挡住下层窗口点击，用户实测抱怨点）。
    // 解锁途径：①悬停顶部锁图标条（轮询临时恢复交互）→ 左键点击锁按钮（2026-09-20 用户拍板，替代中键）
    // ②全局快捷键 Ctrl+Alt+L ③主窗口设置。forward:true 保证穿透时渲染层仍收得到 mousemove（悬停提示条用）。
    // 注意：不调用 setFocusable（实测会导致窗口出现 WS_EX_APPWINDOW → 任务栏出现歌词页）
    lyricWin.setIgnoreMouseEvents(!!lc.locked, { forward: true });
    lyricStripInteractive = false; // 锁定态被外部切换 → 复位热区交互标志，轮询下一拍重估
    lyricWin.webContents.send('lyricwin:config', { ...lc, playMode: config.mode });
    hideLyricFromTaskbar(); // 每次配置应用后确保 TOOLWINDOW（防止穿透/显示切换覆盖）
  }

  function lyricWinToggle(on) {
    config.lyricWin.enabled = !!on;
    store.save('config.json', config);
    if (on) { lyricWinCreate(); applyLyricConfig(); }
    else if (lyricWin) { lyricWin.destroy(); lyricWin = null; }
  }
  // 歌词窗开关 IPC（视觉控制台「桌面歌词」开关接线，2026-09-20；fx 桥 → 真实歌词窗）
  ipcMain.handle('dsh-lyricwin-get', (e) => {
    if (!isTrusted(e)) return { ok: false };
    return { ok: true, enabled: !!(config.lyricWin && config.lyricWin.enabled) };
  });
  ipcMain.handle('dsh-lyricwin-toggle', (e, on) => {
    if (!isTrusted(e)) return { ok: false };
    lyricWinToggle(!!on);
    return { ok: true, enabled: !!(config.lyricWin && config.lyricWin.enabled) };
  });

  // ---------- 曲库 ----------
  async function rescanLibrary() {
    const progress = (done, total, dir) => {
      if (win && !win.webContents.isLoading()) {
        win.webContents.send('scan:progress', { done, total, dir });
      }
    };
    library = { songs: await scanLibrary(config.dirs, progress), scannedAt: Date.now(), scanVersion: SCAN_VERSION };
    reconcileLibrary();
    store.save('library.json', library);
    rebuildIndex();
    return library;
  }

  // 索引调和：剔除失效文件，并清理歌单/收藏/历史中的失效 id
  function reconcileLibrary() {
    const alive = new Set();
    library.songs = (library.songs || []).filter((s) => {
      try {
        if (!fs.existsSync(s.path)) return false;
        alive.add(s.id);
        return true;
      } catch {
        return false;
      }
    });
    // 目录配置收敛为仍存在的目录
    config.dirs = config.dirs.filter((d) => {
      try { return fs.existsSync(d); } catch { return false; }
    });
    store.save('config.json', config);
    // 清理引用：字符串=本地歌曲 id（按存活过滤）；对象=在线歌曲（永远保留）
    const keep = (x) => typeof x === 'string' ? alive.has(x) : !!(x && x.online);
    const clean = (arr) => Array.isArray(arr) ? arr.filter(keep) : arr;
    const pls = store.load('playlists.json', []);
    const dirtyPls = pls.map((p) => ({ ...p, songIds: clean(p.songIds) }));
    store.save('playlists.json', dirtyPls);
    store.save('favorites.json', clean(store.load('favorites.json', [])));
    const hist = store.load('history.json', []);
    store.save('history.json', hist.filter((h) => h.id && alive.has(h.id)));
  }

  async function ensureLibrary() {
    if (!library.songs || library.songs.length === 0 || library.scanVersion !== SCAN_VERSION) await rescanLibrary();
  }

  // 下载目录纳入曲库配置：确保 downloadsDir 已在 config.dirs 中（目录不存在则先创建，
  // 避免 reconcileLibrary 把不存在的目录剔除）；返回 added 表示本次新增了目录
  function ensureDlDirInConfig() {
    if (!config.downloadsDir) return false;
    const norm = (d) => path.resolve(d).toLowerCase();
    const dir = config.downloadsDir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 目录不可创建则放弃 */ }
    if (!fs.existsSync(dir)) return false;
    const covered = config.dirs.some((d) => {
      const nd = norm(d);
      return nd === norm(dir) || norm(dir).startsWith(nd + path.sep) || nd.startsWith(norm(dir) + path.sep);
    });
    if (covered) return false;
    // 与手动添加目录同规则：剔除会被下载目录覆盖的子目录，避免重复收录
    config.dirs = config.dirs.filter((d) => !norm(dir).startsWith(norm(d) + path.sep) && !norm(d).startsWith(norm(dir) + path.sep));
    config.dirs.push(dir);
    store.save('config.json', config);
    return true;
  }

  function findSong(id) {
    return songIndex.get(id) || null;
  }

  // 首次启动：若无歌单则导入 songlist.json（过滤本地缺失）。
  // defaultPlSeeded 守卫：用户删除该歌单后不再重新播种（v1.3.6b 起系统歌单可删）
  function ensureDefaultPlaylist() {
    const pls = store.load('playlists.json', []);
    if (!config.defaultPlSeeded && pls.length === 0 && library.songs.length > 0) {
      const imp = importSonglist(SONGLIST_FILE, library.songs);
      if (imp.ok) {
        store.save('playlists.json', [{ id: 'default', name: '酷狗歌单', songIds: imp.matched, system: true }]);
        config.defaultPlSeeded = true;
        store.save('config.json', config);
        return { imported: imp.matched.length, missing: imp.missing };
      }
    }
    return null;
  }

  // ---------- IPC 校验 ----------
  function isTrusted(e) {
    return (win && e.sender === win.webContents) || (lyricWin && e.sender === lyricWin.webContents);
  }

  // 网易云人机验证（拼图滑块）弹窗：加载 verify.url，轮询 window.puzzle.instance.vars() 拿 validate
  function netVerifyDialog(verify) {
    return new Promise((resolve) => {
      const vUrl = (verify && (verify.url || verify.verifyUrl)) || '';
      if (!vUrl) return resolve(null);
      let done = false;
      const vwin = new BrowserWindow({
        width: 520, height: 680, autoHideMenuBar: true,
        title: '安全验证', resizable: false,
        webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false }
      });
      vwin.loadURL(vUrl);
      const probe = async () => {
        if (done || vwin.isDestroyed()) return;
        try {
          const r = await vwin.webContents.executeJavaScript(`(function(){
            try {
              if (!window.puzzle || !window.puzzle.instance) return '';
              var v = window.puzzle.instance.vars() || {};
              for (var k in v) {
                if (v[k] && v[k].validate) return JSON.stringify({ validate: v[k].validate, mod: k });
              }
              return '';
            } catch (e) { return ''; }
          })()`);
          if (r) {
            const o = JSON.parse(r);
            if (o.validate) {
              done = true;
              resolve(o.validate);
              if (!vwin.isDestroyed()) vwin.close();
              return;
            }
          }
        } catch { /* 页面未就绪 */ }
        setTimeout(probe, 700);
      };
      probe();
      vwin.on('closed', () => { if (!done) { done = true; resolve(null); } });
    });
  }

  // 应用信息（版本号运行时读取，发版不用改页面）
  ipcMain.handle('app:info', (e) => {
    if (!isTrusted(e)) return null;
    return { version: app.getVersion(), name: app.getName() };
  });

  // ---------- IPC ----------
  function registerIpc() {
    ipcMain.handle('library:get', async (e) => {
      if (!isTrusted(e)) return null;
      await ensureLibrary();
      return { songs: library.songs, dirs: config.dirs };
    });

    ipcMain.handle('library:rescan', async (e) => {
      if (!isTrusted(e)) return null;
      await rescanLibrary();
      return { songs: library.songs, dirs: config.dirs };
    });

    ipcMain.handle('library:addDir', async (e) => {
      if (!isTrusted(e)) return null;
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '添加音乐文件夹' });
      if (r.canceled || !r.filePaths.length) return { songs: library.songs, dirs: config.dirs };
      const dir = r.filePaths[0];
      const norm = (d) => path.resolve(d).toLowerCase();
      const exists = config.dirs.some((d) => norm(d) === norm(dir));
      // 双向剔除：①新目录是已有目录的子目录（保留新目录更细粒度）②已有目录是新目录的子目录（避免父+子重复收录）
      config.dirs = config.dirs.filter((d) => !norm(dir).startsWith(norm(d) + path.sep) && !norm(d).startsWith(norm(dir) + path.sep));
      if (!exists) {
        config.dirs.push(dir);
        store.save('config.json', config);
        await rescanLibrary();
      }
      return { songs: library.songs, dirs: config.dirs };
    });

    ipcMain.handle('library:removeDir', async (e, dir) => {
      if (!isTrusted(e) || typeof dir !== 'string') return null;
      config.dirs = config.dirs.filter((d) => d !== dir);
      store.save('config.json', config);
      await rescanLibrary();
      return { songs: library.songs, dirs: config.dirs };
    });

    // 曲库目录拖拽排序：重排 config.dirs（只改顺序，不触发重扫）
    ipcMain.handle('library:setDirOrder', (e, dirs) => {
      if (!isTrusted(e) || !Array.isArray(dirs)) return config.dirs;
      config.dirs = dirs.filter((d) => typeof d === 'string');
      store.save('config.json', config);
      return config.dirs;
    });

    // 删除歌曲：删除磁盘文件（含同名字幕），重扫曲库并清理歌单/收藏/历史中的引用
    ipcMain.handle('song:delete', async (e, id) => {
      if (!isTrusted(e) || typeof id !== 'string') return { ok: false, reason: '参数错误' };
      const song = findSong(id);
      if (!song || !song.path) return { ok: false, reason: '未找到歌曲文件' };
      try { fs.unlinkSync(song.path); } catch (err) { return { ok: false, reason: '文件删除失败：' + err.message }; }
      try { const lrc = song.path.replace(/\.[^.]+$/, '') + '.lrc'; if (fs.existsSync(lrc)) fs.unlinkSync(lrc); } catch { /* 忽略 */ }
      await rescanLibrary();
      return { ok: true, songs: library.songs };
    });

    // 下载完成路径：纳入配置 + 全量刷新（新下载的文件立即进曲库）
    async function ensureDlDirInLibrary() {
      const added = ensureDlDirInConfig();
      await rescanLibrary();
      return added;
    }
    ipcMain.handle('library:ensureDlDir', async (e) => {
      if (!isTrusted(e)) return null;
      const added = await ensureDlDirInLibrary();
      return { songs: library.songs, dirs: config.dirs, added };
    });

    // 封面：ID3 内嵌优先 → 磁盘缓存 → 在线获取（网易云/QQ，串行节流）
    ipcMain.handle('song:cover', async (e, id) => {
      if (!isTrusted(e) || typeof id !== 'string') return null;
      const song = findSong(id);
      if (!song) return null;
      const coverFile = path.join(store.getDataDir(), 'covers', crypto.createHash('sha1').update(id).digest('hex').slice(0, 32) + '.jpg');
      // 1) ID3 内嵌
      if (song.hasCover) {
        try {
          const stat = fs.statSync(song.path);
          const cacheStat = fs.existsSync(coverFile) ? fs.statSync(coverFile) : null;
          if (cacheStat && cacheStat.mtimeMs >= stat.mtimeMs) {
            return { mime: 'image/jpeg', data: fs.readFileSync(coverFile).toString('base64') };
          }
          const mm = await parseFile(song.path);
          const pic = mm.common.picture && mm.common.picture[0];
          if (pic) {
            if (pic.format === 'image/jpeg') {
              fs.mkdirSync(path.dirname(coverFile), { recursive: true });
              fs.writeFileSync(coverFile, pic.data);
            }
            return { mime: pic.format, data: pic.data.toString('base64') };
          }
        } catch { /* 落到在线 */ }
      }
      // 2) 在线封面（缓存/串行下载）
      const buf = await covers.getCover(song);
      if (buf) return { mime: 'image/jpeg', data: buf.toString('base64') };
      return null;
    });

    // 歌词：ID3 内嵌优先（保留）→ .lrc（UTF-8 优先，GBK 兜底），带 mtime 缓存
    ipcMain.handle('song:lyrics', async (e, id) => {
      if (!isTrusted(e) || typeof id !== 'string') return null;
      const song = findSong(id);
      if (!song) return null;
      // 1) ID3 内嵌歌词
      try {
        const mm = await parseFile(song.path);
        if (mm.common.lyrics && mm.common.lyrics.length && mm.common.lyrics[0].text) {
          return { source: 'id3', text: mm.common.lyrics[0].text };
        }
      } catch { /* 忽略 */ }
      // 2) 同名 .lrc 文件（UTF-8 优先，GBK 兜底；按 mtime 缓存）
      const lrc = path.join(path.dirname(song.path), path.basename(song.path, path.extname(song.path)) + '.lrc');
      try {
        const stat = fs.statSync(lrc);
        const cached = lyricsCache.get(id);
        if (cached && cached.mtime === stat.mtimeMs) return { source: 'lrc', text: cached.text };
        const buf = fs.readFileSync(lrc);
        let text = buf.toString('utf8');
        if (text.includes('\uFFFD')) {
          try { text = new TextDecoder('gbk').decode(buf); } catch { /* 保持 utf8 结果 */ }
        }
        lyricsCache.set(id, { text, mtime: stat.mtimeMs });
        return { source: 'lrc', text };
      } catch {
        return null;
      }
    });

    ipcMain.handle('util:fileUrl', (e, p) => {
      if (!isTrusted(e) || typeof p !== 'string') return null;
      try { return require('url').pathToFileURL(p).href; } catch { return null; }
    });

    // 标签编辑：读（ID3，仅 mp3 可写）
    ipcMain.handle('tag:read', async (e, id) => {
      if (!isTrusted(e) || typeof id !== 'string') return { ok: false, reason: '参数错误' };
      const song = findSong(id);
      if (!song) return { ok: false, reason: '歌曲不存在' };
      if (!/\.mp3$/i.test(song.path)) return { ok: false, reason: '仅支持 MP3 文件写入标签' };
      try {
        const t = NodeID3.read(song.path);
        const pic = t.image && t.image.imageBuffer ? { data: t.image.imageBuffer.toString('base64'), mime: t.image.mime || 'image/jpeg' } : null;
        return { ok: true, title: t.title || '', artist: t.artist || '', album: t.album || '', picture: pic, ext: 'mp3' };
      } catch (err) {
        return { ok: false, reason: '读取标签失败：' + err.message };
      }
    });

    // 标签编辑：写（title/artist/album + 封面；picture=null 移除封面）
    ipcMain.handle('tag:write', async (e, id, patch) => {
      if (!isTrusted(e) || typeof id !== 'string' || !patch || typeof patch !== 'object') return { ok: false, reason: '参数错误' };
      const song = findSong(id);
      if (!song) return { ok: false, reason: '歌曲不存在' };
      if (!/\.mp3$/i.test(song.path)) return { ok: false, reason: '仅支持 MP3 文件写入标签' };
      try {
        const tags = {};
        if (typeof patch.title === 'string') tags.title = patch.title;
        if (typeof patch.artist === 'string') tags.artist = patch.artist;
        if (typeof patch.album === 'string') tags.album = patch.album;
        if (patch.picture === null) {
          tags.image = ''; // node-id3: 空字符串 = 移除 APIC（已实测）
        } else if (patch.picture && patch.picture.data && patch.picture.mime) {
          tags.image = { mime: patch.picture.mime, type: { id: 3, name: 'front cover' }, description: 'cover', imageBuffer: Buffer.from(patch.picture.data, 'base64') };
        }
        const r = NodeID3.update(tags, song.path);
        if (r !== true) throw new Error(r && r.message ? r.message : '写入失败');
        // 同步库内歌曲字段
        song.title = (typeof patch.title === 'string' && patch.title.trim()) ? patch.title.trim() : song.title;
        song.artist = (typeof patch.artist === 'string' && patch.artist.trim()) ? patch.artist.trim() : song.artist;
        song.album = (typeof patch.album === 'string' && patch.album.trim()) ? patch.album.trim() : song.album;
        if (patch.picture !== undefined) song.hasCover = patch.picture !== null;
        // 封面缓存作废（下次读取用新封面）
        try {
          const coverFile = path.join(store.getDataDir(), 'covers', crypto.createHash('sha1').update(id).digest('hex').slice(0, 32) + '.jpg');
          if (fs.existsSync(coverFile)) fs.unlinkSync(coverFile);
        } catch { /* 忽略 */ }
        store.save('library.json', library);
        return { ok: true, song: { id: song.id, title: song.title, artist: song.artist, album: song.album, hasCover: song.hasCover } };
      } catch (err) {
        return { ok: false, reason: '写入标签失败：' + err.message };
      }
    });

    // 在线歌词：单首获取（无本地歌词时按歌名+艺术家查询并落盘 .lrc）
    ipcMain.handle('lyrics:fetch', async (e, id) => {
      if (!isTrusted(e) || typeof id !== 'string') return { ok: false, reason: '参数错误' };
      const song = findSong(id);
      if (!song) return { ok: false, reason: '歌曲不存在' };
      return await lyrics.ensureLyrics(song);
    });

    // 在线歌词：批量补齐曲库缺失歌词
    ipcMain.handle('lyrics:fillAll', async (e) => {
      if (!isTrusted(e)) return { ok: 0, fail: 0, skipped: 0, total: 0 };
      const progress = (done, total, ok, fail) => {
        if (win && !win.webContents.isLoading()) {
          win.webContents.send('lyrics:progress', { done, total, ok, fail });
        }
      };
      const stats = await lyrics.fillAll(library.songs || [], progress);
      return stats;
    });
    ipcMain.handle('song:reveal', (e, id) => {
      if (!isTrusted(e) || typeof id !== 'string') return;
      const song = findSong(id);
      if (song) shell.showItemInFolder(song.path);
    });

    // 重复歌曲检测：先按 文件大小 分组，组内再按内容 MD5 精确判定（真重复）
    ipcMain.handle('lib:findDupes', async (e) => {
      if (!isTrusted(e)) return [];
      const songs = (library.songs || []).filter((s) => s.path && fs.existsSync(s.path));
      const bySize = new Map();
      for (const s of songs) {
        try {
          const st = fs.statSync(s.path);
          if (!bySize.has(st.size)) bySize.set(st.size, []);
          bySize.get(st.size).push({ s, size: st.size });
        } catch { /* 忽略不可读文件 */ }
      }
      const groups = [];
      for (const bucket of bySize.values()) {
        if (bucket.length < 2) continue;
        const byHash = new Map();
        for (const { s, size } of bucket) {
          const h = await sha1File(s.path);
          if (!byHash.has(h)) byHash.set(h, []);
          byHash.get(h).push({ s, size });
        }
        for (const same of byHash.values()) {
          if (same.length > 1) {
            groups.push(same.map(({ s, size }) => ({
              id: s.id, title: s.title, artist: s.artist || '', path: s.path, size
            })));
          }
        }
      }
      return groups; // 每组第 0 个为"保留"，其余为候选删除
    });
    // 删除指定歌曲：移入回收站（可恢复）+ 库内剔除 + 清理歌单/收藏/历史引用
    ipcMain.handle('lib:removeSongs', async (e, ids) => {
      if (!isTrusted(e) || !Array.isArray(ids)) return { ok: false, reason: '参数错误' };
      const failed = [];
      for (const id of ids) {
        const s = findSong(id);
        if (!s) { failed.push(id); continue; }
        try {
          await shell.trashItem(s.path);
        } catch {
          try { fs.unlinkSync(s.path); } catch { failed.push(id); continue; }
        }
      }
      const okIds = ids.filter((id) => !failed.includes(id));
      if (okIds.length) {
        const gone = new Set(okIds);
        library.songs = (library.songs || []).filter((s) => !gone.has(s.id));
        reconcileLibrary(); // 同步清理歌单/收藏/历史引用 + 保存
        rebuildIndex();
        store.save('library.json', library);
      }
      return { ok: true, removed: okIds.length, failed };
    });

    async function sha1File(file) {
      return new Promise((resolve) => {
        const h = crypto.createHash('sha1');
        const st = fs.createReadStream(file);
        st.on('data', (c) => h.update(c));
        st.on('error', () => resolve(null));
        st.on('end', () => resolve(h.digest('hex')));
      });
    }

    // ================= 在线歌曲下载服务 =================
    // 串行队列 + 进度事件；网易云强制 higher(320k mp3，可写 ID3)、酷狗 128；
    // 落盘：下载目录\歌手 - 歌名.mp3（重名自动加序号）+ 同名 .lrc（过滤逐字 JSON 行）+ ID3（标题/歌手/专辑/封面）
    const dlQueue = [];
    let dlBusy = null;
    let dlSeq = 0;
    const dlHistory = []; // 已完成/失败/取消的任务（最近 20 条，供 UI 展示）
    function dlSnapshot(t) {
      return { taskId: t.taskId, title: t.title, status: t.status, pct: Math.round((t.pct || 0) * 100), path: t.path || null, reason: t.reason || null };
    }
    function dlEmit(task, patch) {
      Object.assign(task, patch);
      if (win && !win.webContents.isLoading()) {
        win.webContents.send('dl:progress', dlSnapshot(task));
      }
    }
    function dlAll() {
      return dlHistory.slice().reverse().concat(dlQueue, dlBusy ? [dlBusy] : []);
    }
    function dlDir() {
      let dir = config.downloadsDir;
      if (typeof dir !== 'string' || !dir.trim()) dir = path.join(app.getPath('music'), 'Downloads');
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
      return dir;
    }
    // 下载单文件（http/https，跟随重定向），返回 {status, size}；onProgress(pct 0..1)
    function streamFile(url, dest, onProgress, onCancel) {
      return new Promise((resolve, rej) => {
        const mod = url.startsWith('https:') ? https : http;
        const doGet = (u) => {
          const req = mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              res.resume(); doGet(new URL(res.headers.location, u).href); return;
            }
            if (res.statusCode !== 200) { res.resume(); rej(new Error('HTTP ' + res.statusCode)); return; }
            const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
            let got = 0;
            const ws = fs.createWriteStream(dest);
            res.on('data', (c) => {
              got += c.length;
              if (total) onProgress(Math.min(1, got / total));
            });
            res.pipe(ws);
            ws.on('finish', () => resolve({ size: got }));
            ws.on('error', (e) => { res.destroy(); rej(e); });
            res.on('error', (e) => { ws.destroy(); rej(e); });
          });
          req.on('error', rej);
          req.setTimeout(60000, () => { req.destroy(); rej(new Error('下载超时')); });
          if (onCancel) {
            onCancel(() => { try { req.destroy(); } catch { /* 忽略 */ } });
          }
        };
        doGet(url);
      });
    }
    async function dlResolveUrl(song) {
      // 返回 { url, ext }；质量按 song.level（netease: higher/lossless；kugou: 320/lossless），
      // 未指定时默认 网易云 higher / 酷狗 128（保证 mp3）
      const lv = (song && song.level) || '';
      let url, d;
      if (song.source === 'qq' || song.source === 'bodian') {
        // v1.4.2 QQ 音源已移除：存量 qq/波点歌曲下载时严格换源后按新源解析（strictAltHit 与 resolve:song 共用）
        const hit = await strictAltHit(song.title, song.artist);
        if (!hit) throw new Error('该歌曲来自已下线的 QQ 音源，未找到可用的换源版本');
        song.source = hit.source; song.ref = hit.ref;
        // level 归一值 → 新源特有值（kugou: flac/hires；netease: exhigh/jymaster）
        const srcLevelMap = hit.source === 'kugou'
          ? { standard: '128', high: '320', lossless: 'flac', master: 'hires' }
          : { standard: 'standard', high: 'exhigh', lossless: 'lossless', master: 'jymaster' };
        song.level = srcLevelMap[lv] || (hit.source === 'kugou' ? '128' : 'higher');
      }
      const qs = song.source === 'kugou'
        ? '/kugou?hash=' + encodeURIComponent(song.ref) + (lv ? '&level=' + encodeURIComponent(lv) : '')
        : '/netease?id=' + encodeURIComponent(song.ref) + '&level=' + encodeURIComponent(lv || 'higher');
      const r2 = await leizGet(qs);
      d = r2 && r2.data ? r2.data : null;
      url = d && (d.url || d.src) ? (d.url || d.src) : null;
      if (!url) throw new Error('无法解析播放地址（' + (r2 && r2.message ? r2.message : '未知错误') + '）');
      if (!(await verifyDirectUrl(url))) throw new Error('音源地址异常，请重试或重新下载'); // v1.4.2 韧性：下载直链同样先验魔数
      // 从 content-disposition/url 推断扩展名（higher/128 均为 mp3，兜底 .mp3）
      let ext = '.mp3';
      const fn = (d.filename || '').toLowerCase();
      if (/\.(flac|m4a|mp3|aac)$/.test(fn)) ext = '.' + fn.match(/\.(flac|m4a|mp3|aac)$/)[1];
      return { url, ext };
    }
    // 下载封面 → {mime,imageBuffer}（≤2MB）
    async function dlFetchCover(picUrl) {
      if (!picUrl || !/^https?:\/\//.test(picUrl)) return null;
      try {
        const buf = await new Promise((resolve, rej) => {
          const mod = picUrl.startsWith('https:') ? https : http;
          const req = mod.get(picUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode !== 200) { res.resume(); rej(new Error('HTTP ' + res.statusCode)); return; }
            const chunks = [];
            let total = 0;
            res.on('data', (c) => { total += c.length; if (total > 2 * 1048576) { req.destroy(); rej(new Error('封面过大')); return; } chunks.push(c); });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', rej);
          });
          req.on('error', rej);
          req.setTimeout(15000, () => { req.destroy(); rej(new Error('封面超时')); });
        });
        return { mime: 'image/jpeg', imageBuffer: buf };
      } catch { return null; }
    }
    // 歌词 → .lrc 文本（去掉逐字 JSON 行 + 元信息行）
    function lrcForSave(raw) {
      return String(raw || '').split(/\r?\n/)
        .filter((l) => /^\[\d{1,2}:\d{1,2}/.test(l))
        .join('\n').trim();
    }
    // 行时间戳（秒）：[mm:ss.xxx] → 秒；无时间戳返回 null
    function lrcLineTime(line) {
      const m = line.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
      if (!m) return null;
      const fracStr = m[3] || '0';
      const frac = fracStr.length === 1 ? +fracStr / 10 : (fracStr.length === 2 ? +fracStr / 100 : +fracStr / 1000);
      return (+m[1]) * 60 + (+m[2]) + frac;
    }
    // 行文本（去时间戳）
    function lrcLineText(line) { return line.replace(/\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').trim(); }
    // 原文行 + 译文行交错合并：译文行仅在同时间戳（±0.05s，同源歌词时间戳一致）且原文无相同文本时插入其原文行后
    function mergeLrcWithTrans(origLines, transLines) {
      if (!transLines.length) return origLines.join('\n');
      const out = [];
      for (const ol of origLines) {
        out.push(ol);
        const ot = lrcLineTime(ol);
        if (ot == null) continue;
        for (const tl of transLines) {
          const tt = lrcLineTime(tl);
          if (tt == null || Math.abs(ot - tt) > 0.05) continue;
          const tlText = lrcLineText(tl);
          if (!tlText) continue;
          // 同时间戳 original 已有相同文本（如 original 本身含译文）→ 跳过
          if (origLines.some((o) => lrcLineTime(o) != null && Math.abs(lrcLineTime(o) - tt) < 0.05 && lrcLineText(o) === tlText)) continue;
          out.push(tl);
        }
      }
      return out.join('\n');
    }
    async function dlSaveLyrics(task) {
      try {
        let r = null;
        const s = task.song || {};
        if (s.source === 'qq' || s.source === 'bodian') {
          // v1.4.2 QQ 音源已移除：存量歌曲歌词走网易云兜底（歌名+歌手搜网易云取 id 再拉歌词）
          const q = ((s.title || '') + ' ' + String(s.artist || '').replace(/^未知$/, '')).trim();
          const sr = await leizGet('/netease/search?q=' + encodeURIComponent(q) + '&limit=5');
          const first = sr.ok && Array.isArray(sr.data) && sr.data[0] && sr.data[0].id ? sr.data[0] : null;
          if (first) r = await leizGet('/netease?type=lyrics&id=' + encodeURIComponent(first.id) + '&level=lossless');
        } else {
          r = await leizGet('/' + s.source + '?type=lyrics&' + (s.source === 'kugou' ? 'hash=' : 'id=') + encodeURIComponent(s.ref));
        }
        const ly = r && r.data && r.data.lyrics ? r.data.lyrics : null;
        const origLines = lrcForSave(ly && ly.original).split('\n').filter(Boolean);
        if (!origLines.length) return false;
        // 译文行也保存：下载到本地的歌同样享受翻译（在线歌单导入后下载落地，翻译跟着走）
        const transLines = lrcForSave(ly && ly.translated).split('\n').filter(Boolean);
        const text = mergeLrcWithTrans(origLines, transLines);
        if (text) {
          fs.writeFileSync(path.join(task.dir, task.base + '.lrc'), text, 'utf8');
          return true;
        }
      } catch { /* 歌词失败不影响主文件 */ }
      return false;
    }
    // 同名判定（用户定调：歌手+歌名相同即视为同一首 → 触发替换，不再校验时长）
    // 任一字段缺失（无标签）都判为不同 → 不覆盖，走加序号保留两份
    async function sameSongAsFile(file, song) {
      try {
        const meta = await parseFile(file, { duration: true });
        const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const fTitle = norm(Array.isArray(meta.common.title) ? meta.common.title.join(' ') : meta.common.title);
        const fArtist = norm(Array.isArray(meta.common.artist) ? meta.common.artist.join(' ') : meta.common.artist);
        const wTitle = norm(song.title);
        const wArtist = norm(song.artist);
        if (!fTitle || !wTitle || fTitle !== wTitle) return false;
        if (!fArtist || !wArtist || fArtist !== wArtist) return false;
        return true; // 歌手+歌名相同 → 覆盖（不再看时长）
      } catch { return false; } // 读不到标签/文件损坏 → 不覆盖
    }
    async function dlProcess(task) {
      dlEmit(task, { status: 'resolving', pct: 0 });
      let audioUrl = null, ext = '.mp3';
      try {
        const res = await dlResolveUrl(task.song);
        audioUrl = res.url; ext = res.ext;
      } catch (e) {
        dlEmit(task, { status: 'error', reason: e.message });
        return;
      }
      // 目标文件名（重名自动加序号）
      let base = [task.song.artist, task.song.title].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]/g, ' ') || '下载歌曲';
      base = base.replace(/\s+/g, ' ').trim();
      task.base = base; // 供歌词落盘使用（含序号，保证重名歌曲各自有 .lrc）
      let file = path.join(task.dir, base + ext);
      if (config.downloadOverwrite) {
        // 覆盖模式：已有文件与下载歌曲「歌手+歌名」相同即替换（更正错误版本/同名更新）；
        // 歌手或歌名任一不同（或读不到标签）→ 自动加序号保留两份
        if (fs.existsSync(file) && !(await sameSongAsFile(file, task.song))) {
          let n = 1;
          while (fs.existsSync(file)) {
            file = path.join(task.dir, `${base} (${n})${ext}`);
            n++;
          }
        }
      } else {
        let n = 1;
        while (fs.existsSync(file)) {
          file = path.join(task.dir, `${base} (${n})${ext}`);
          n++;
        }
      }
      const tmp = file + '.part';
      try {
        dlEmit(task, { status: 'downloading', pct: 0 });
        let cancelCb = null;
        // 封面与音频并行抓取（封面是网络请求，串行会拖慢下载后的"写入标签"阶段）
        const coverP = dlFetchCover(task.song.picUrl);
        await streamFile(audioUrl, tmp, (p) => {
          if (task.status === 'cancelled') return;
          dlEmit(task, { status: 'downloading', pct: Math.min(0.92, p * 0.92) });
        }, (cb) => { cancelCb = cb; });
        if (task.status === 'cancelled') { try { fs.unlinkSync(tmp); } catch { /* 忽略 */ } return; }
        dlEmit(task, { status: 'cover', pct: 0.93 }); // 下载封面（通常已在并行抓取，很快）
        const cover = await coverP;
        dlEmit(task, { status: 'tagging', pct: 0.95 }); // 写入 ID3 标签 + 内嵌封面
        const tags = { title: task.song.title || '', artist: task.song.artist || '', album: task.song.album || '' };
        if (cover) tags.image = { mime: cover.mime, type: { id: 3, name: 'front cover' }, description: '', imageBuffer: cover.imageBuffer };
        try { NodeID3.update(tags, tmp); } catch { /* 标签失败不影响文件 */ }
        // 覆盖模式：Windows 下 rename 不覆盖已存在文件，先删旧文件（失败则走错误提示，不破坏旧文件）
        if (fs.existsSync(file)) { try { fs.unlinkSync(file); } catch { /* 忽略 */ } }
        fs.renameSync(tmp, file);
        await dlSaveLyrics(task);
        dlEmit(task, { status: 'done', pct: 1, path: file });
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
        if (task.status !== 'cancelled') dlEmit(task, { status: 'error', reason: e.message });
      }
    }
    async function dlPump() {
      if (dlBusy) return;
      const task = dlQueue.shift();
      if (!task) return;
      dlBusy = task;
      await dlProcess(task);
      // 终态任务入历史（保留最近 20 条），活动任务留在 dlBusy 供 dlList 查询
      dlHistory.push(task);
      if (dlHistory.length > 20) dlHistory.shift();
      dlBusy = null;
      dlPump();
    }
    function dlEnqueue(song) {
      const task = {
        taskId: 'dl' + (++dlSeq),
        song, title: song.title || '', status: 'queued', pct: 0, path: null, reason: null,
        dir: dlDir()
      };
      dlQueue.push(task);
      // 注意：不在此处提前 emit queued —— IPC 返回 taskId 前事件会先到页面，
      // 导致 renderer 只能建 'task:dlN' 匿名条目，后续进度事件全部匹配到匿名条目，
      // 真实行条目永远收不到更新。首个进度事件（resolving）由 dlProcess 发出。
      dlPump();
      return task.taskId;
    }
    ipcMain.handle('dl:dir', (e, dir) => {
      if (!isTrusted(e)) return dlDir();
      if (typeof dir === 'string' && dir.trim()) {
        try {
          fs.mkdirSync(dir.trim(), { recursive: true });
          config.downloadsDir = dir.trim();
          store.save('config.json', config);
        } catch { /* 忽略非法目录 */ }
      }
      return dlDir();
    });
    // 下载目录：原生文件夹选择框（设置里的「浏览…」）
    ipcMain.handle('dl:pickDir', async (e) => {
      if (!isTrusted(e)) return null;
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择下载目录' });
      if (r.canceled || !r.filePaths.length) return null;
      const dir = r.filePaths[0];
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
      config.downloadsDir = dir;
      store.save('config.json', config);
      return dir;
    });
    ipcMain.handle('dl:overwrite', (e, v) => {
      if (!isTrusted(e)) return !!config.downloadOverwrite;
      config.downloadOverwrite = !!v;
      store.save('config.json', config);
      return config.downloadOverwrite;
    });
    ipcMain.handle('autoSrcUpgrade', (e, v) => {
      if (!isTrusted(e)) return config.autoSrcUpgrade !== false;
      config.autoSrcUpgrade = v !== false;
      store.save('config.json', config);
      return config.autoSrcUpgrade;
    });
    ipcMain.handle('dl:start', (e, song, level) => {
      if (!isTrusted(e) || !song || typeof song !== 'object') return { ok: false, reason: '参数错误' };
      if (!['netease', 'kugou', 'qq'].includes(song.source) || !song.ref || !song.title) return { ok: false, reason: '歌曲信息不完整' };
      const s2 = typeof level === 'string' && level ? Object.assign({}, song, { level }) : song;
      const taskId = dlEnqueue(s2);
      return { ok: true, taskId, dir: dlDir() };
    });
    ipcMain.handle('dl:batch', (e, songs, level) => {
      if (!isTrusted(e) || !Array.isArray(songs)) return { ok: false, reason: '参数错误' };
      const ids = [];
      for (const s of songs.slice(0, 50)) {
        if (s && ['netease', 'kugou'].includes(s.source) && s.ref && s.title) {
          const s2 = typeof level === 'string' && level ? Object.assign({}, s, { level }) : s;
          ids.push(dlEnqueue(s2));
        }
      }
      return { ok: true, count: ids.length, ids, dir: dlDir() };
    });
    ipcMain.handle('dl:cancel', (e, taskId) => {
      if (!isTrusted(e) || typeof taskId !== 'string') return false;
      const t = dlQueue.find((x) => x.taskId === taskId);
      if (t) { dlQueue.splice(dlQueue.indexOf(t), 1); dlEmit(t, { status: 'cancelled' }); return true; }
      if (dlBusy && dlBusy.taskId === taskId) {
        dlEmit(dlBusy, { status: 'cancelled' });
        if (dlBusy._cancel) dlBusy._cancel();
        return true;
      }
      return false;
    });
    ipcMain.handle('dl:list', (e) => {
      if (!isTrusted(e)) return [];
      return dlAll().map((t) => dlSnapshot(t));
    });

    ipcMain.handle('playlists:get', (e) => {
      if (!isTrusted(e)) return [];
      return store.load('playlists.json', []);
    });
    ipcMain.handle('playlists:save', (e, pls) => {
      if (!isTrusted(e)) return [];
      if (!Array.isArray(pls)) return store.load('playlists.json', []);
      const valid = pls.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.songIds));
      store.save('playlists.json', valid);
      return valid;
    });
    ipcMain.handle('playlists:addSongs', (e, plId, songIds) => {
      if (!isTrusted(e) || typeof plId !== 'string' || !Array.isArray(songIds)) return [];
      const pls = store.load('playlists.json', []);
      const pl = pls.find((p) => p.id === plId);
      if (pl) {
        // 条目可为本地歌曲 id（字符串）或在线歌曲对象（含 online/source/ref）
        const keyOf = (x) => typeof x === 'string' ? x : (x && typeof x.id === 'string' ? x.id : null);
        const set = new Set(pl.songIds.map(keyOf).filter(Boolean));
        for (const id of songIds) {
          if (!id) continue;
          const k = keyOf(id);
          if (k === null || set.has(k)) continue;
          pl.songIds.push(id);
          set.add(k);
        }
      }
      store.save('playlists.json', pls);
      return pls;
    });

    // 在线歌单本地持久化（导入的歌单/收藏标记存用户数据目录 online-playlists.json，重启不丢）
    ipcMain.handle('opl:get', (e) => {
      if (!isTrusted(e)) return [];
      return store.load('online-playlists.json', []);
    });
    ipcMain.handle('opl:save', (e, pls) => {
      if (!isTrusted(e)) return [];
      if (!Array.isArray(pls)) return [];
      const filtered = pls.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.songs));
      // 护栏：空列表不覆盖非空文件——半初始化实例退出时误刷空数组会抹掉收藏的歌单（2026-09-06 实际发生）
      if (!filtered.length) {
        const cur = store.load('online-playlists.json', []);
        if (Array.isArray(cur) && cur.length) {
          console.error('[opl] 拒绝用空列表覆盖 ' + cur.length + ' 个已收藏歌单（疑似半初始化实例的误刷）');
          return cur;
        }
      }
      // 同步时间基准：新建盖 createdAt、每次保存盖 updatedAt（缺它则合并/墓碑全判错方向）
      const __now = Date.now();
      for (const p of filtered) { if (!p.createdAt) p.createdAt = __now; p.updatedAt = __now; }
      store.save('online-playlists.json', filtered);
      return pls;
    });

    // 最近听过歌单（推荐页横排；打开在线/本地歌单时记录，上限 10）
    ipcMain.handle('recPls:get', (e) => {
      if (!isTrusted(e)) return [];
      return store.load('recent-pls.json', []);
    });
    ipcMain.handle('recPls:record', (e, item) => {
      if (!isTrusted(e) || !item || typeof item.id !== 'string') return [];
      let l = store.load('recent-pls.json', []) || [];
      l = l.filter((x) => x && x.id !== item.id);
      l.unshift({ id: item.id, name: String(item.name || '').slice(0, 60), source: String(item.source || ''), cover: String(item.cover || '').slice(0, 500), at: Date.now() });
      l = l.slice(0, 10);
      store.save('recent-pls.json', l);
      return l;
    });
    // 我的歌单显示顺序（长按拖拽排序）：['playlist:<id>' | 'opl:<id>', ...]；未列入的按自然顺序追加
    ipcMain.handle('plOrder:get', (e) => {
      if (!isTrusted(e)) return [];
      return store.load('pl-order.json', []);
    });
    ipcMain.handle('plOrder:save', (e, arr) => {
      if (!isTrusted(e)) return [];
      if (!Array.isArray(arr)) return [];
      store.save('pl-order.json', arr.filter((k) => typeof k === 'string'));
      return arr;
    });

    // 在系统文件管理器中打开目录（设置-曲库维护「打开文件夹」）
    ipcMain.handle('util:openPath', async (e, p) => {
      if (!isTrusted(e) || typeof p !== 'string' || !p || p.length > 1024) return { ok: false, err: 'bad path' };
      try {
        const err = await shell.openPath(p);
        return { ok: !err, err: err || '' };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    });

    function pcTombstone(key) { if (!key) return; try { const l = store.load('sync-tomb.json', []) || []; const m = new Map(); for (const t of l) if (t && t.key) m.set(t.key, t.at || 0); m.set(key, Date.now()); store.save('sync-tomb.json', [...m].map(([k, at]) => ({ key: k, at }))); } catch (e) {} }
    ipcMain.handle('favorites:get', (e) => {
      if (!isTrusted(e)) return [];
      return store.load('favorites.json', []);
    });
    ipcMain.handle('favorites:toggle', (e, id, song) => {
      if (!isTrusted(e) || typeof id !== 'string' || id.length > 1024) return store.load('favorites.json', []);
      let favs = store.load('favorites.json', []);
      const same = (f) => (typeof f === 'string' ? f : f && f.id) === id;
      if (favs.some(same)) {
        const rm = favs.find(same);
        const src = (rm && typeof rm === 'object' && rm.source) || (id.indexOf('online:') === 0 ? id.split(':')[1] : '');
        const ref = (rm && typeof rm === 'object' && rm.ref) || (id.indexOf('online:') === 0 ? id.slice('online:'.length + (src ? src.length + 1 : 0)) : '');
        if (src && ref) pcTombstone('fav:' + src + ':' + ref);
        favs = favs.filter((f) => !same(f));
      } else if (song && typeof song === 'object' && song.online && typeof song.id === 'string') {
        // 在线歌曲收藏：存完整歌曲对象（含 source/ref，重启后可恢复播放；level 供音质徽标，缺失时渲染层回退在线音质设置）
        favs.push({ id: song.id, online: true, source: song.source, ref: song.ref, title: song.title, artist: song.artist || '', album: song.album || '', duration: song.duration || 0, picUrl: song.picUrl || '', level: song.level || '', updatedAt: Date.now() });
      } else {
        favs.push(id);
      }
      store.save('favorites.json', favs);
      return favs;
    });

    ipcMain.handle('history:get', (e) => {
      if (!isTrusted(e)) return [];
      return store.load('history.json', []);
    });
    ipcMain.handle('history:add', (e, id) => {
      if (!isTrusted(e) || typeof id !== 'string' || id.length > 1024) return store.load('history.json', []);
      let hist = store.load('history.json', []);
      hist = hist.filter((x) => x.id !== id);
      hist.unshift({ id, at: Date.now() });
      store.save('history.json', hist.slice(0, 200)); // 最近播放上限 200
      return hist;
    });

    // 播放状态（断点续播）：{ songId, position, mode }
    ipcMain.handle('player:getState', (e) => {
      if (!isTrusted(e)) return null;
      return store.load('state.json', null);
    });
    ipcMain.handle('player:saveState', (e, st) => {
      if (!isTrusted(e)) return;
      if (st && typeof st === 'object' && typeof st.songId === 'string') {
        store.save('state.json', {
          songId: st.songId,
          position: Number.isFinite(st.position) ? st.position : 0,
          mode: typeof st.mode === 'string' ? st.mode : 'order'
        });
      }
    });

    ipcMain.handle('config:get', (e) => {
      if (!isTrusted(e)) return null;
      return config;
    });
    ipcMain.handle('config:setVolume', (e, v) => {
      if (!isTrusted(e)) return config;
      if (typeof v !== 'number' || !isFinite(v)) return config;
      config.volume = Math.min(1, Math.max(0, v));
      store.save('config.json', config);
      return config;
    });
    ipcMain.handle('config:setBgBlur', (e, v) => {
      if (!isTrusted(e)) return config;
      const n = Number(v);
      if (!isFinite(n)) return config;
      config.bgBlur = Math.min(60, Math.max(0, Math.round(n * 10) / 10));
      store.save('config.json', config);
      return config;
    });
    ipcMain.handle('config:setMode', (e, m) => {
      if (!isTrusted(e)) return config;
      if (!['order', 'repeat-one', 'shuffle'].includes(m)) return config;
      config.mode = m;
      store.save('config.json', config);
      // 主窗切换播放模式 → 同步歌词窗右下角按钮图标
      if (lyricWin && !lyricWin.isDestroyed()) lyricWin.webContents.send('lyricwin:mode', config.mode);
      return config;
    });
    ipcMain.handle('config:setPin', (e, flag) => {
      if (!isTrusted(e)) return config;
      if (win) win.setAlwaysOnTop(!!flag);
      return config;
    });
    ipcMain.handle('config:setAutoLaunch', (e, flag) => {
      if (!isTrusted(e)) return config;
      const on = !!flag;
      app.setLoginItemSettings({ openAtLogin: on, path: process.execPath });
      config.autoLaunch = on;
      store.save('config.json', config);
      return config;
    });
    ipcMain.handle('config:setCloseBehavior', (e, v) => {
      if (!isTrusted(e)) return config;
      if (v === 'tray' || v === 'exit') {
        config.closeBehavior = v;
        store.save('config.json', config);
      }
      return config;
    });

    // ---------- 歌词悬浮窗 ----------
    ipcMain.handle('lyricwin:get', (e) => {
      if (!isTrusted(e)) return null;
      return config.lyricWin;
    });
    ipcMain.handle('lyricwin:set', (e, patch) => {
      if (!isTrusted(e) || !patch || typeof patch !== 'object') return config.lyricWin;
      const lc = config.lyricWin;
      if (typeof patch.mode === 'string' && ['desktop', 'taskbar'].includes(patch.mode)) lc.mode = patch.mode;
      if (typeof patch.fontSize === 'number') lc.fontSize = Math.min(64, Math.max(14, patch.fontSize));
      if (typeof patch.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.color)) lc.color = patch.color;
      if (typeof patch.color2 === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.color2)) lc.color2 = patch.color2;
      if (typeof patch.bgOpacity === 'number') lc.bgOpacity = Math.min(1, Math.max(0, patch.bgOpacity));
      if (typeof patch.opacity === 'number') lc.opacity = Math.min(1, Math.max(0.3, patch.opacity)); // 整窗透明度（设置-桌面歌词-窗口透明度）
      if (typeof patch.locked === 'boolean') lc.locked = patch.locked;
      if (typeof patch.stroke === 'boolean') lc.stroke = patch.stroke;
      if (typeof patch.sweepStyle === 'string' && ['classic', 'soft', 'clean', 'bold', 'legacy'].includes(patch.sweepStyle)) lc.sweepStyle = patch.sweepStyle;
      if (typeof patch.lyricFont === 'string' && ['default', 'noto', 'misans', 'yahei', 'songti', 'kai', 'wenkai', 'xingkai', 'xinwei'].includes(patch.lyricFont)) lc.lyricFont = patch.lyricFont;
      if (patch.enabled !== undefined) lc.enabled = !!patch.enabled;
      if (lc.enabled) { lyricWinCreate(); applyLyricConfig(); }
      else if (lyricWin) { lyricWin.destroy(); lyricWin = null; }
      store.save('config.json', config);
      return config.lyricWin;
    });
    ipcMain.on('lyricwin:line', (e, payload) => {
      if (!isTrusted(e)) return;
      lyricLine = payload && typeof payload === 'object' ? payload : null;
      if (lyricWin && !lyricWin.isDestroyed()) lyricWin.webContents.send('lyricwin:line', lyricLine);
    });
    // 歌词窗自适应高度：渲染进程测量内容高度 → 调整窗口（字号大/两句显示时自动加高，顶部贴齐）
    ipcMain.on('lyricwin:resize', (e, h) => {
      if (!isTrusted(e)) return;
      if (!lyricWin || lyricWin.isDestroyed() || !(h > 0) || h > 900) return;
      if (config.lyricWin && config.lyricWin.mode === 'taskbar') return; // 任务栏模式保持细长条固定高度
      lyricAdaptiveH = Math.round(h); // 记录自适应高度，resize 防拉伸兜底以此为准
      const b = lyricWin.getBounds();
      lyricWin.setBounds({ x: b.x, y: b.y, width: 840, height: Math.round(h) }, false);
    });
    // 全量歌词下发（歌词窗自主滚动：行定位/切换在歌词窗本地，主窗 rAF/事件被节流也不影响）
    ipcMain.on('lyricwin:lrc', (e, data) => {
      if (!isTrusted(e)) return;
      lyricLrc = data;
      if (lyricWin && !lyricWin.isDestroyed()) lyricWin.webContents.send('lyricwin:lrc', data);
    });
    ipcMain.on('lyricwin:hover', (e, on) => {
      if (!isTrusted(e)) return;
      // 穿透状态完全由悬停轮询的 nearBtn 判定控制（仅解锁按钮附近解除）；此处只记录悬停标志
      lyricHover = !!on;
    });

    // ---------- 快捷键 ----------
    ipcMain.handle('hotkeys:get', (e) => {
      if (!isTrusted(e)) return null;
      return { enabled: config.hotkeys.enabled, defs: HK_DEFS.map((d) => ({ id: d.id, name: d.name })), binds: config.hotkeys.binds };
    });
    // 设置单项：{ id, layer: 'local'|'global', value }（''=清除）或 { enabled: bool } 总开关。
    // 全局键注册失败（被其他程序占用）自动回滚并返回 reason:'taken'
    ipcMain.handle('hotkeys:set', (e, patch) => {
      if (!isTrusted(e) || !patch || typeof patch !== 'object') return { ok: false, reason: 'bad' };
      // 恢复默认：全部动作回到 HK_DEFS 出厂键位并重载全局注册
      if (patch.reset) {
        for (const d of HK_DEFS) config.hotkeys.binds[d.id] = { local: d.local, global: d.global };
        store.save('config.json', config);
        registerAllHotkeys();
        return { ok: true };
      }
      if (typeof patch.enabled === 'boolean') {
        config.hotkeys.enabled = patch.enabled;
        store.save('config.json', config);
        registerAllHotkeys();
        return { ok: true };
      }
      const { id, layer, value } = patch;
      if (!HK_DEFS.find((d) => d.id === id) || !['local', 'global'].includes(layer)) return { ok: false, reason: 'bad' };
      const val = typeof value === 'string' ? value.trim() : '';
      if (!hkIsValidAccel(val)) return { ok: false, reason: 'format' };
      for (const d of HK_DEFS) {
        if (d.id !== id && val && config.hotkeys.binds[d.id][layer] === val) return { ok: false, reason: 'dup', dup: d.name };
      }
      const old = config.hotkeys.binds[id][layer];
      config.hotkeys.binds[id][layer] = val;
      store.save('config.json', config);
      registerAllHotkeys();
      if (layer === 'global' && val && !globalShortcut.isRegistered(val)) {
        config.hotkeys.binds[id][layer] = old; // 被其他程序占用 → 回滚
        store.save('config.json', config);
        registerAllHotkeys();
        return { ok: false, reason: 'taken' };
      }
      return { ok: true };
    });
    // 应用内层触达主进程侧动作（桌面歌词开关/锁定）
    ipcMain.handle('hotkey:run', (e, id) => {
      if (!isTrusted(e)) return;
      if (id === 'lyric' || id === 'lyricLock') hkDispatch(id);
    });

    // ---------- LeiZ 在线音乐服务（网易云/酷狗爬歌，key 只存主进程）----------
    // 文档站 https://api.bileizhen.top/apis（SPA）；鉴权 ?key= 或 x-api-key；CORS 全开但仍走主进程
    // 网易云: search?q= / ?id=&level= / ?type=lyrics&id= / ?type=playlist&id|url=
    // 酷狗:   search?q= / ?url= / ?type=lyrics&url= / ?type=playlist&url=
    const LEIZ_BASE = 'https://api.bileizhen.top/api';
    const LEIZ_KEY = 'lz_b4dd85599fe9c71b3e7ae241dae2cb2ac767b5954aa18b14';
    const https = require('https');
    // W-6 S1：连接复用。裸 https.get 每请求新建 TCP+TLS，甲（C=8/G=50）把并发放开后 8 次握手互相竞争。
    // keepAlive 复用连接；maxSockets 必须 ≥ 探测并发 C=8（12 给搜索/解析留余量）。
    const leizAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 12,
      keepAliveMsecs: 30000,
      timeout: 30000,
    });
    function leizGet(pathWithQuery) {
      return new Promise((resolve) => {
        const sep = pathWithQuery.includes('?') ? '&' : '?';
        const url = LEIZ_BASE + pathWithQuery + sep + 'key=' + encodeURIComponent(LEIZ_KEY);
        const req = https.get(url, { agent: leizAgent, headers: { 'User-Agent': 'Mozilla/5.0 MusicPlayer/1.2.9' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolve({ ok: res.statusCode === 200 && j.success === true, status: res.statusCode, data: j.data || null, message: j.message || null });
            } catch {
              resolve({ ok: false, status: res.statusCode, message: '响应解析失败' });
            }
          });
        });
        req.on('error', (e) => resolve({ ok: false, status: 0, message: e.message }));
        req.setTimeout(20000, () => { req.destroy(); resolve({ ok: false, status: 0, message: 'LEIZ_REQUEST_TIMEOUT' }); }); // 具名错误码：日志可检索
      });
    }
    // ---------- v1.4.2 播放韧性（移植自 Mineradio 2.2.0, GPL-3.0, server.js:3550-3620，适配 leiz 返回结构） ----------
    // 直链魔数探测：直链交给渲染层/下载器之前先抓 8KB 验证是真音频（ID3/fLaC/OggS/RIFF/ftyp/MPEG frame sync），
    // 拦下"换源成功但实际是错误页/JSON"的静默失败。超时 8s 为本项目取舍（Mineradio 用 2s/次×多次是给 QQ vkey 预算的）。
    const PROBE_BYTES = 8192;
    const PROBE_TIMEOUT_MS = 8000;
    const PROBE_POS_TTL_MS = 10 * 60 * 1000; // 正缓存 10min（与直链短时效同量级）
    const PROBE_NEG_TTL_MS = 30 * 1000;      // 负缓存 30s（网络抖动不长期拉黑同一首）
    const probeCache = new Map(); // key: 直链 url → { ok, ts }
    function probeMagic(buf) {
      if (!buf || !buf.length) return '';
      if (buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3-id3';
      if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
      if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
      if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return 'wave';
      if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
      const scan = Math.min(buf.length - 1, 2048);
      for (let i = 0; i < scan; i++) {
        if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) return 'mpeg-frame'; // 裸 mp3 无文件头，扫 frame sync
      }
      return '';
    }
    function probePlaybackAudioUrl(audioUrl) {
      return new Promise((resolve) => {
        let u;
        try { u = new URL(audioUrl); } catch { return resolve(false); }
        if (!/^https?:$/.test(u.protocol)) return resolve(false);
        const mod = /^https:/i.test(audioUrl) ? https : require('http'); // leiz 直链 http/https 都有
        const req = mod.get(audioUrl, { headers: { Range: 'bytes=0-' + (PROBE_BYTES - 1), 'User-Agent': 'Mozilla/5.0 MusicPlayer/1.2.9' } }, (res) => {
          const st = res.statusCode;
          if (st !== 200 && st !== 206) { res.resume(); return resolve(false); }
          const ct = String(res.headers['content-type'] || '').toLowerCase();
          const chunks = []; let bytes = 0;
          res.on('data', (c) => { chunks.push(c); bytes += c.length; if (bytes >= PROBE_BYTES) req.destroy(); });
          res.on('end', () => finish());
          res.on('close', () => finish());
          let done = false;
          function finish() {
            if (done) return; done = true;
            const sample = Buffer.concat(chunks).subarray(0, PROBE_BYTES);
            const looksText = /text\/html|application\/(json|xml)|text\/plain/.test(ct);
            resolve(sample.length >= 512 && !looksText && !!probeMagic(sample));
          }
        });
        req.on('error', () => resolve(false));
        req.setTimeout(PROBE_TIMEOUT_MS, () => { try { req.destroy(); } catch { /* */ } resolve(false); });
      });
    }
    async function verifyDirectUrl(url) {
      if (!url || !/^https?:/i.test(url)) return false;
      const now = Date.now();
      const c = probeCache.get(url);
      if (c && now - c.ts < (c.ok ? PROBE_POS_TTL_MS : PROBE_NEG_TTL_MS)) return c.ok;
      const t0 = Date.now();
      const ok = await probePlaybackAudioUrl(url);
      if (!ok) console.error('[probe] 直链校验失败 code=PROBE_REJECTED url=' + url.slice(0, 80) + ' costMs=' + (Date.now() - t0));
      probeCache.set(url, { ok, ts: now });
      if (probeCache.size > 500) probeCache.delete(probeCache.keys().next().value); // 简易 FIFO 上限
      return ok;
    }
    // 失败原因翻译成人话。事实边界：本地自产消息（请求超时/响应解析失败/HTTP 状态/Node 网络错误）为精确映射；
    // 上游(leiz) message 的 版权/付费 关键词匹配是推测档（待实测校准），未命中原文透出并打日志收集真实文案。
    // 2026-09-19 实测捕获的上游原文："Song URL not found or requires higher VIP privileges"（坏 id）→ 不存在优先于会员提示
    const FAIL_REASON_MAP = [
      [/版权|无版权|copyright/i, '这首歌因版权限制暂不可播'],
      [/not found|不存在/i, '歌曲可能已下架或不存在'],
      [/付费|vip|会员|购买|数字专辑/i, '这首歌需要对应平台会员'],
    ];
    function humanizeFailReason(msg) {
      const s = String(msg || '');
      if (/请求超时|timed? ?out/i.test(s)) return '网络不稳，稍后再试';
      if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket|network|网络/i.test(s)) return '网络连接失败';
      if (/响应解析失败/i.test(s)) return '服务响应异常';
      if (/^HTTP 404/.test(s)) return '歌曲可能已下架';
      if (/^HTTP (401|403)/.test(s)) return '服务鉴权异常';
      for (const [re, txt] of FAIL_REASON_MAP) if (re.test(s)) { console.error('[fail-reason] 命中推测档映射, 上游原文:', s); return txt; }
      if (s && !/^HTTP \d+$/.test(s)) console.error('[fail-reason] 未映射的上游失败信息:', s);
      return s || '未知错误';
    }
    ipcMain.handle('leiz:search', async (e, source, query, limit) => {
      if (!isTrusted(e) || !['netease', 'kugou'].includes(source) || typeof query !== 'string' || !query.trim()) return { ok: false, reason: '参数错误' };
      // limit：每源条数（5~100，默认 30）——LeiZ 支持 limit 参数（page/offset 无效）
      const lmt = Number.isFinite(Number(limit)) ? Math.min(100, Math.max(5, Math.round(Number(limit)))) : 30;
      const r = await leizGet('/' + source + '/search?q=' + encodeURIComponent(query.trim()) + '&limit=' + lmt);
      return r.ok ? { ok: true, data: r.data } : { ok: false, reason: humanizeFailReason(r.message || ('HTTP ' + r.status)) };
    });
    // ref: 网易云=song id；酷狗=分享链接或 hash（url/hash/id 三选一，推荐 url）
    // 档位归一→源特有值（幂等，leiz:resolve 与 resolve:song 播放端点共用）：输入可能是档位名
    // (渲染层新契约 standard/high/lossless/master) 或源值(歌词/手机端 exhigh/320/flac/jymaster…)。
    // 此前 resolve:song 不做这层转换，把 'master' 原样拼进上游 URL → 上游不认（酷狗只认 hires）
    // → 静默回退默认档 =「选臻品必降标准/高品」（2026-09-20 用户报告根因）。
    const leizSourceLevel = (source, level) => {
      const toTier = (x) => {
        x = String(x || '');
        if (x === 'standard' || x === 'high' || x === 'lossless' || x === 'master') return x;
        if (x === 'exhigh' || x === 'higher' || x === '320' || x === 'hq' || x === '高品') return 'high';
        if (x === '128' || x === 'sq' || x === '标准') return 'standard';
        if (x === 'flac' || x === '无损') return 'lossless';
        if (x === 'jymaster' || x === 'jyeffect' || x === 'hires' || x === '臻品') return 'master';
        return 'lossless';
      };
      const srcLv = source === 'netease'
        ? { standard: 'standard', high: 'exhigh', lossless: 'lossless', master: 'jymaster' }
        : { standard: '128', high: '320', lossless: 'flac', master: 'hires' };
      return srcLv[toTier(level)] || 'lossless';
    };
    ipcMain.handle('leiz:resolve', async (e, source, ref, level) => {
      if (!isTrusted(e) || !['netease', 'kugou'].includes(source) || typeof ref !== 'string' || !ref) return { ok: false, reason: '参数错误' };
      const lv = leizSourceLevel(source, level);
      return leizResolveCore(source, ref, lv);
    });
    // leiz 解析核心（leiz:resolve 与 resolve:song 统一端点共用）：含直链魔数探测。
    // opts.probe===true = 「探测模式」（渲染层列表音质探测专用，结果读完即丢）：
    // 跳过直链魔数校验、且调用方不再登记本地流——这两步对"只为读一次码率"是纯浪费。
    // 播放链 / 下载链一律不传 opts → verifyDirectUrl 与 makeStreamUrl 的行为与改动前完全一致。
    async function leizResolveCore(source, ref, lv, opts) {
      const isProbe = !!(opts && opts.probe === true);
      let p;
      if (source === 'netease') {
        p = '/netease?id=' + encodeURIComponent(ref) + '&level=' + encodeURIComponent(lv);
      } else if (/^https?:\/\//.test(ref)) {
        // 酷狗分享链接：漏传 level 上游按默认 128 返回 MP3（实测），故必须显式带 level
        p = '/kugou?url=' + encodeURIComponent(ref) + '&level=' + encodeURIComponent(lv);
      } else if (/^\d+$/.test(ref)) {
        // 纯数字 ref 是专辑音频 id，拼进 hash= 会被上游 400 拒（实测），必须走 id=
        p = '/kugou?id=' + encodeURIComponent(ref) + '&level=' + encodeURIComponent(lv);
      } else {
        // 非链接且非数字时上游只认 32 位资源 hash，作兜底
        p = '/kugou?hash=' + encodeURIComponent(ref) + '&level=' + encodeURIComponent(lv);
      }
      const r = await leizGet(p);
      // status 原样透出（W-3 429 判定用）：resolve:song / leiz:resolve 都是原样返回 r → 自动带出；
      // 既有消费方忽略未知字段 → 行为零变化。
      if (!r.ok) return { ok: false, status: r.status, reason: humanizeFailReason(r.message || ('HTTP ' + r.status)) };
      const durl = r.data && (r.data.url || r.data.src);
      // 探测模式跳过：这次解析的对象不会进播放器，白花一次 8KB 抓取（每首探测省 1 次网络往返）
      if (!isProbe && durl && !(await verifyDirectUrl(durl))) return { ok: false, reason: '音源地址异常，请尝试换源或稍后再试' };
      return { ok: true, data: r.data };
    }
    // 存量 qq/波点歌曲严格换源（酷狗→网易云，歌名+歌手全等；dlResolveUrl 与 resolve:song 共用）
    async function strictAltHit(title, artist) {
      const artists = String(artist || '').split(/[、,，/]/).map((x) => x.trim()).filter(Boolean);
      const bare = String(title || '').trim();
      const qFull = (bare + ' ' + (artists[0] || '')).trim();
      let hit = null;
      if (qFull) {
        try { const kg = await leizGet('/kugou/search?q=' + encodeURIComponent(qFull) + '&limit=8'); if (kg.ok && Array.isArray(kg.data)) hit = pickFallback(kg.data, title, artists, 'kugou', true); } catch { /* 忽略 */ }
      }
      if (!hit && qFull) {
        try { const ne = await leizGet('/netease/search?q=' + encodeURIComponent(qFull) + '&limit=8'); if (ne.ok && Array.isArray(ne.data)) hit = pickFallback(ne.data, title, artists, 'netease', true); } catch { /* 忽略 */ }
      }
      return hit;
    }
    // v1.4.2 解析收拢：播放直链统一入口——前端不再区分音源分支。
    // qq/bodian 存量歌 → 主进程严格换源；bilibili → 自建解析；netease/kugou → leiz + 魔数探测。
    // 存量歌换源命中时返回 data.switchedSource/switchedRef 供前端改写歌曲对象。
    // opts.probe===true：渲染层列表音质探测专用（跳过魔数校验、不登记本地流；其余分支不受影响）
    ipcMain.handle('resolve:song', async (e, song, quality, opts) => {
      if (!isTrusted(e) || !song || typeof song !== 'object') return { ok: false, reason: '参数错误' };
      const source = String(song.source || '');
      try {
        if (source === 'qq' || source === 'bodian') {
          const hit = await strictAltHit(song.title, song.artist);
          if (!hit) return { ok: false, reason: '该歌曲来自已下线的 QQ 音源，未找到可用的换源版本' };
          const r = await leizResolveCore(hit.source, hit.ref, 'lossless');
          if (r.ok && r.data) {
            r.data.switchedSource = hit.source; r.data.switchedRef = hit.ref;
            const u = r.data.url || r.data.src;
            if (u) r.data.streamUrl = makeStreamUrl({ url: u, reResolve: { kind: 'leiz', source: hit.source, ref: hit.ref, level: 'lossless' } });
          }
          return r;
        }
        if (source === 'bilibili') {
          const r = await biliResolveFull(String(song.ref || '')); // 统一入口：缓存→自建→LeiZ 兜底
          if (!r || !r.ok || !r.data) return { ok: false, reason: (r && r.reason) || '解析失败' };
          const out = { url: r.data.url, bitrate: r.data.bitrate, format: r.data.format, level: r.data.level };
          if (r.data.url) out.streamUrl = makeStreamUrl({ url: r.data.url, reResolve: { kind: 'bili', bvid: String(song.ref || '') } });
          return { ok: true, data: out };
        }
        if (source === 'netease' || source === 'kugou') {
          // 2026-09-20 修复：quality 是渲染层归一档名（master/lossless…），必须先转源特有值
          // （酷狗 master→hires、网易 master→jymaster）再拼上游 URL——原样透传会被上游静默回退降档
          const lv = leizSourceLevel(source, String(quality || song.level || 'lossless'));
          const r = await leizResolveCore(source, String(song.ref || ''), lv, opts);
          // 探测模式的返回值马上被丢弃 → 不能登记本地流（12 首一轮会白扔 12 个流 token）
          if (r.ok && r.data && !(opts && opts.probe === true)) {
            const u = r.data.url || r.data.src;
            if (u) r.data.streamUrl = makeStreamUrl({ url: u, reResolve: { kind: 'leiz', source, ref: String(song.ref || ''), level: lv } });
          }
          return r;
        }
        return { ok: false, reason: '未知音源：' + source };
      } catch (err) {
        return { ok: false, reason: humanizeFailReason((err && err.message) || '解析异常') };
      }
    });
    ipcMain.handle('leiz:lyrics', async (e, source, ref, level) => {
      if (!isTrusted(e) || !['netease', 'kugou'].includes(source) || typeof ref !== 'string' || !ref) return { ok: false, reason: '参数错误' };
      const lv = typeof level === 'string' && level ? level : 'lossless';
      let p;
      if (source === 'netease') {
        p = '/netease?type=lyrics&id=' + encodeURIComponent(ref) + '&level=' + encodeURIComponent(lv);
      } else {
        p = /^https?:\/\//.test(ref) ? '/kugou?type=lyrics&url=' + encodeURIComponent(ref) : '/kugou?type=lyrics&hash=' + encodeURIComponent(ref);
      }
      const r = await leizGet(p);
      return r.ok ? { ok: true, data: r.data } : { ok: false, reason: humanizeFailReason(r.message || ('HTTP ' + r.status)) };
    });
    // 歌单：ref 可为链接或 id（网易云 id/url 二选一；酷狗支持数字 id 或 m.kugou.com/plist/list/N 链接——gcid 链接上游暂不可用）
    ipcMain.handle('leiz:playlist', async (e, source, ref) => {
      if (!isTrusted(e) || !['netease', 'kugou'].includes(source) || typeof ref !== 'string' || !ref) return { ok: false, reason: '参数错误' };
      let p;
      if (source === 'netease') {
        p = /^https?:\/\//.test(ref) ? '/netease?type=playlist&url=' + encodeURIComponent(ref) : '/netease?type=playlist&id=' + encodeURIComponent(ref);
      } else {
        if (/^https?:\/\//.test(ref)) {
          p = '/kugou?type=playlist&url=' + encodeURIComponent(ref);
        } else {
          const num = String(ref).match(/\d{4,}/);
          p = num ? '/kugou?type=playlist&id=' + encodeURIComponent(num[0]) : '/kugou?type=playlist&url=' + encodeURIComponent(ref);
        }
      }
      const r = await leizGet(p);
      return r.ok ? { ok: true, data: r.data } : { ok: false, reason: humanizeFailReason(r.message || ('HTTP ' + r.status)) };
    });

    // ---------- B 站收藏夹导入 + 播放解析（一期：公开收藏夹；播放走 LeiZ /bilibili 合并流）----------
    // 收藏夹清单是公开内容：直接调 B 站公开接口（实测无 WBI/风控）；私密收藏夹需设为公开才能导入
    function biliGet(pathWithQuery) {
      return new Promise((resolve) => {
        const req = https.get('https://api.bilibili.com' + pathWithQuery, { headers: { 'User-Agent': 'Mozilla/5.0 MusicPlayer/1.3.8', Referer: 'https://www.bilibili.com' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try { resolve({ ok: true, status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
            catch { resolve({ ok: false, status: res.statusCode, message: '响应解析失败' }); }
          });
        });
        req.on('error', (e) => resolve({ ok: false, status: 0, message: e.message }));
        req.setTimeout(20000, () => { req.destroy(); resolve({ ok: false, status: 0, message: 'LEIZ_REQUEST_TIMEOUT' }); }); // 具名错误码：日志可检索
      });
    }
    // 收藏夹识别：URL 里的 fid= 数字，或纯数字 media_id；自动翻页拉全（上限 400，防误粘超大收藏夹）
    ipcMain.handle('bili:favlist', async (e, ref) => {
      if (!isTrusted(e) || typeof ref !== 'string' || !ref.trim()) return { ok: false, reason: '参数错误' };
      const m = ref.match(/fid=(\d{4,})/) || ref.trim().match(/^(\d{4,})$/);
      if (!m) return { ok: false, reason: '无法识别收藏夹（请粘贴 space.bilibili.com 的 favlist 链接）' };
      const mediaId = m[1];
      const first = await biliGet('/x/v3/fav/resource/list?media_id=' + mediaId + '&pn=1&ps=20&order=mtime&type=2');
      if (!first.ok || !first.data || first.data.code !== 0 || !first.data.data || !first.data.data.info) {
        const code = first.data && first.data.code;
        return { ok: false, reason: code === -403 || code === -404 ? '收藏夹不存在或未公开（私密收藏夹请先设为公开）' : '收藏夹拉取失败（' + ((first.data && first.data.message) || ('HTTP ' + first.status)) + '）' };
      }
      const info = first.data.data.info;
      const total = Math.min(Number(info.media_count) || 0, 400);
      const songs = [];
      const push = (v) => {
        if (!v || !v.bvid) return;
        songs.push({
          ref: v.bvid,
          title: String(v.title || '').replace(/【[^】]*】/g, '').trim() || String(v.title || '').trim(), // 去【】标签但保底原标题
          artist: (v.upper && v.upper.name) || '未知UP主',
          album: '', duration: Number(v.duration) || 0, picUrl: v.cover || v.pic || ''
        });
      };
      for (const v of (first.data.data.medias || [])) push(v);
      const pages = Math.ceil(total / 20);
      for (let pn = 2; pn <= pages; pn++) {
        const r = await biliGet('/x/v3/fav/resource/list?media_id=' + mediaId + '&pn=' + pn + '&ps=20&order=mtime&type=2');
        const medias = r.ok && r.data && r.data.code === 0 && r.data.data ? r.data.data.medias : null;
        if (!medias || !medias.length) break;
        for (const v of medias) push(v);
      }
      if (!songs.length) return { ok: false, reason: '收藏夹为空' };
      // 后台预热前 5 首：导入完成后立即开始合成，用户点开头几首即可秒开（点播其他歌时预热自动作废）
      biliWarmPending = songs.slice(0, 5).map((x) => x.ref).filter((x) => /^BV[0-9A-Za-z]{8,12}$/.test(x));
      biliWarmKick();
      return {
        ok: true,
        data: {
          name: info.title || 'B站收藏夹',
          cover: info.cover || (songs[0] && songs[0].picUrl) || '',
          desc: 'UP：' + ((info.upper && info.upper.name) || '') + ' · ' + songs.length + ' 个视频',
          songs,
          truncated: total < (Number(info.media_count) || 0)
        }
      };
    });
    // 播放解析（混合）：自建直连优先（纯音频 DASH、登录后自动会员档），失败退 LeiZ 合并流兜底
    // 缓存：解析结果缓存 50 分钟；收藏夹导入后自动预热前 5 首 → 点播秒开
    const biliCache = new Map(); // bvid -> resolve data（50 分钟 TTL，对齐 token ~1h 有效期）
    const BILI_CACHE_TTL = 50 * 60 * 1000;
    let biliWarmPending = []; // 待预热 bvid 队列（用户点播其他歌时清空，不浪费服务端算力）
    let biliWarming = false;
    // ---------- 自建直连（@seiuna/bilibili-api，ESM 动态加载；凭证存数据根 bili-credentials.json）----------
    let biliLibPromise = null;
    let biliClient = null;
    let biliLoginBusy = false;
    let biliLastQr = ''; // 最近一张扫码二维码（弹窗关了会话还在，重开弹窗时补发）
    const biliCredPath = () => accScopedPath('bili-credentials.json');
    const biliCredBackupPath = () => accScopedPath('bili-credentials.backup.json');
    // 凭据健康检查：cookie+refreshToken 都非空才算有效（库里刷新失败会把主文件覆写成空串）
    function biliCredHasData(p) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return !!(j && j.cookie && j.refreshToken);
      } catch { return false; }
    }
    function biliCredRestoreIfNeeded() {
      try {
        if (!biliCredHasData(biliCredPath()) && biliCredHasData(biliCredBackupPath())) {
          fs.copyFileSync(biliCredBackupPath(), biliCredPath());
          console.log('[bili] 凭据主文件为空 → 已从备份恢复登录态');
        }
      } catch { /* 忽略 */ }
    }
    async function biliGetClient() {
      if (biliClient) return biliClient;
      const lib = await (biliLibPromise || (biliLibPromise = import('@seiuna/bilibili-api')));
      biliCredRestoreIfNeeded(); // 空文件（刷新失败覆写）→ 从备份还原，保住登录态
      biliClient = await lib.BiliClient.create(biliCredPath());
      return biliClient;
    }
    // 自建解析：view+playurl 取 DASH 最高音轨（纯音频，无视频轨/无合成等待；登录后自动 192k/Hi-Res）
    async function biliSelfImpl(bvid) {
      const client = await biliGetClient();
      const video = await client.getVideo(bvid);
      const pu = await video.getPlayUrl({ fnval: 16 | 512 }); // 512=Hi-Res 无损位（无权益时服务端自动降级）
      // 库返回扁平结构（playurl 字段直接在顶层）；兼容 {data:{...}} 包装
      const pd = (pu && pu.data) || pu || {};
      const dash = pd.dash || (pu && pu.result && pu.result.dash);
      const tracks = [];
      if (dash && Array.isArray(dash.audio)) tracks.push(...dash.audio);
      if (dash && dash.flac && dash.flac.baseUrl) tracks.push(dash.flac); // Hi-Res 无损独立字段（大会员）
      if (!tracks.length) throw new Error('响应中没有音频轨');
      const best = tracks.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
      const bitrate = Math.round((best.bandwidth || 0) / 1000);
      // 按音轨代码诚实标档：30251=Hi-Res无损、30280=高清(192k)、30232/30216=标准
      const level = best.id === 30251 || /flac/i.test(String(best.codec || '')) ? 'lossless' : best.id === 30280 ? 'high' : 'standard';
      return {
        ok: true,
        data: {
          url: best.baseUrl, bitrate, format: level === 'lossless' ? 'flac' : 'm4a', level,
          title: video.title || '', artist: video.owner ? video.owner.name : '', duration: video.duration || 0,
          self: true
        }
      };
    }
    // LeiZ 兜底：合并流 MP4（qn=16 最低清晰度——纯音频播放用不着视频轨，低清合成快得多）
    // 流程：解析拿 merged token → POST prepare 触发服务端合成（202）→ 轮询合并流至 200/206（约 10-20s，上限 90s）
    async function biliResolveImpl(bvid) {
      const r = await leizGet('/bilibili?bvid=' + encodeURIComponent(bvid) + '&qn=16');
      // 注意：leizGet 已拆信封——r.data 即视频数据（kind/bvid/dash/merged...），无 success 包装
      if (!r.ok || !r.data) {
        return { ok: false, reason: humanizeFailReason(r.message || ('HTTP ' + r.status)) };
      }
      const d = r.data;
      const audioArr = (d.dash && d.dash.audio) || [];
      let best = null;
      for (const a of audioArr) if (!best || (a.bandwidth || 0) > (best.bandwidth || 0)) best = a;
      const bitrate = best ? Math.round((best.bandwidth || 0) / 1000) : 0; // kbps（如 132）
      const fmt = best ? (/flac/i.test(String(best.codec || '')) || best.id === 30251 ? 'flac' : 'm4a') : 'mp4';
      if (!d.merged || !d.merged.url) return { ok: false, reason: '响应中没有可播放的流' };
      const abs = (u) => 'https://api.bileizhen.top' + u + (u.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(LEIZ_KEY);
      const url = abs(d.merged.url);
      const code = (method, u) => new Promise((resolve) => {
        const req = https.request(u, { method, headers: { 'User-Agent': 'Mozilla/5.0 MusicPlayer/1.3.8' } }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', () => resolve(0));
        req.setTimeout(15000, () => { req.destroy(); resolve(0); });
        req.end();
      });
      await code('POST', abs(d.merged.prepareUrl)); // 触发合成（202=已开始；不触发则永远 425）
      for (let i = 0; i < 30; i++) {
        const st = await code('GET', url + '&r=' + i); // Range 探测：200/206=就绪，425=合并中
        if (st === 200 || st === 206) {
          return { ok: true, data: { url, bitrate, format: fmt, title: d.partTitle || d.title || '', artist: d.owner || '', duration: d.duration || 0 } };
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      return { ok: false, reason: '音视频合并超时，请稍后重试' };
    }
    // 统一入口：缓存 → 自建直连 → LeiZ 兜底
    async function biliResolveFull(bvid) {
      const cached = biliCache.get(bvid);
      if (cached && Date.now() - cached.ts < BILI_CACHE_TTL) return { ok: true, data: cached };
      try {
        const self = await biliSelfImpl(bvid);
        if (self && self.ok) { self.data.ts = Date.now(); biliCache.set(bvid, self.data); return self; }
      } catch (err) {
        console.error('[bili] 自建直连失败 → LeiZ 兜底:', (err && err.message) || err);
      }
      const lz = await biliResolveImpl(bvid);
      if (lz.ok) { lz.data.ts = Date.now(); biliCache.set(bvid, lz.data); }
      return lz;
    }
    async function biliWarmKick() {
      if (biliWarming) return;
      biliWarming = true;
      try {
        while (biliWarmPending.length) {
          const bvid = biliWarmPending.shift();
          const c = biliCache.get(bvid);
          if (c && Date.now() - c.ts < BILI_CACHE_TTL) continue;
          const r = await biliResolveFull(bvid);
          if (!r.ok) break; // 上游异常（风控/网络）→ 停止预热轰炸
          await new Promise((resolve) => setTimeout(resolve, 1500)); // 预热节流：对上游礼貌
        }
      } finally { biliWarming = false; }
    }
    ipcMain.handle('bili:resolve', async (e, bvid) => {
      if (!isTrusted(e) || typeof bvid !== 'string' || !/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) return { ok: false, reason: '无效的 BV 号' };
      biliWarmPending = []; // 用户点播了别的歌 → 未开始的预热作废
      return biliResolveFull(bvid);
    });
    // ---------- B 站账号（扫码登录；会员档随登录态自动生效）----------
    ipcMain.handle('bili:loginStart', async (e) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝访问' };
      if (biliLoginBusy) { // 已有扫码会话进行中：补发当前二维码（否则重开弹窗会一直卡「正在获取二维码…」）
        if (biliLastQr && win && !win.isDestroyed()) win.webContents.send('bili:loginStatus', { status: 'qr', msg: '', qr: biliLastQr });
        return { ok: true };
      }
      try {
        const lib = await (biliLibPromise || (biliLibPromise = import('@seiuna/bilibili-api')));
        const client = await biliGetClient();
        biliLoginBusy = true;
        client.ensureLogin({
          pollInterval: 2000,
          timeout: 180000,
          onStatusChange: (status, msg, qrBase64) => {
            if (qrBase64) biliLastQr = qrBase64;
            if (win && !win.isDestroyed()) win.webContents.send('bili:loginStatus', { status, msg: msg || '', qr: qrBase64 || null });
          }
        }).then((authed) => {
          biliLoginBusy = false;
          biliClient = authed;
          biliCache.clear(); // 会员解析结果与匿名不同，清掉旧缓存与预热
          biliWarmPending = [];
          try { if (biliCredHasData(biliCredPath())) fs.copyFileSync(biliCredPath(), biliCredBackupPath()); } catch { /* 备份失败不影响登录 */ }
          (async () => { // 补取昵称写进凭据文件，并把名字随成功事件带给界面
            let uname = '';
            try { const d = JSON.parse(fs.readFileSync(biliCredPath(), 'utf8')); uname = await biliFetchUname(d && d.cookie); if (uname) { d.uname = uname; fs.writeFileSync(biliCredPath(), JSON.stringify(d, null, 2), 'utf8'); } } catch { /* 忽略 */ }
            if (win && !win.isDestroyed()) win.webContents.send('bili:loginStatus', { status: 'success', msg: '登录成功', uname });
          })();
        }).catch((err) => {
          biliLoginBusy = false;
          if (win && !win.isDestroyed()) win.webContents.send('bili:loginStatus', { status: 'error', msg: (err && err.message) || '登录失败' });
        });
        return { ok: true };
      } catch (err) {
        biliLoginBusy = false;
        return { ok: false, reason: (err && err.message) || '登录初始化失败' };
      }
    });
    // 登录态判定直接读凭据文件（不走库：create/init 偶发挂起时设置页不该被拖住）
    ipcMain.handle('bili:account', async (e) => {
      if (!isTrusted(e)) return { loggedIn: false };
      let uname = '';
      try { uname = String((JSON.parse(fs.readFileSync(biliCredPath(), 'utf8')) || {}).uname || '').slice(0, 40); } catch { /* 未登录/损坏 */ }
      return { loggedIn: biliCredHasData(biliCredPath()), uname };
    });
    ipcMain.handle('bili:logout', async (e) => {
      if (!isTrusted(e)) return { ok: false };
      try { fs.rmSync(biliCredPath(), { force: true }); } catch { /* 忽略 */ }
      biliClient = null;
      biliLastQr = '';
      biliCache.clear();
      biliWarmPending = [];
      pcTombstone('acc:bilibili');
      return { ok: true };
    });
    // —— B站验证码（短信）登录：先过官方人机验证（弹窗滑块），再发短信、用验证码换登录 Cookie ——
    let biliSmsCtx = null; // { captchaKey, tel, ts } 发短信成功后的上下文（10 分钟内有效）
    let biliBuvid3 = '';
    const biliGetBuvid = () => (biliBuvid3 || (biliBuvid3 = crypto.randomUUID().toUpperCase() + 'infoc'));
    // 官方人机验证弹窗：加载验证组件，用户完成后返回 { challenge, validate, seccode }；关闭/超时返回 null
    function biliGeetestWindow(gt, challenge) {
      return new Promise((resolve) => {
        let done = false;
        let srv = null;
        const finish = (v) => { if (done) return; done = true; try { if (srv) srv.close(); } catch { /* 忽略 */ } try { if (geeWin && !geeWin.isDestroyed()) geeWin.destroy(); } catch { /* 忽略 */ } resolve(v); };
        const html = '<!doctype html><html><head><meta charset="utf-8"><title>安全验证</title>' +
          '<style>body{font-family:system-ui,"Segoe UI",sans-serif;background:#fff;margin:0;padding:20px;text-align:center}h3{margin:6px 0 2px;color:#333;font-weight:600}.sub{color:#999;font-size:12px;margin:0 0 14px}#cap{display:inline-block;min-height:60px}</style></head>' +
          '<body><h3>安全验证</h3><p class="sub">完成后，验证码短信将发送到你的手机</p><div id="cap"></div>' +
          '<script src="https://static.geetest.com/static/tools/gt.js"><' + '/script>' +
          '<script>window.__geeResult=null;(function wait(){if(typeof initGeetest!=="function"){setTimeout(wait,150);return;}initGeetest({gt:"__GT__",challenge:"__CH__",offline:false,new_captcha:true,product:"float",width:"300px"},function(c){c.appendTo("#cap");c.onSuccess(function(){window.__geeResult=c.getValidate();});});})();<' + '/script></body></html>';
        const page = html.replace('__GT__', String(gt)).replace('__CH__', String(challenge));
        const geeWin = new BrowserWindow({
          width: 380, height: 460, show: false, resizable: false, minimizable: false, maximizable: false,
          title: '安全验证', autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false }
        });
        geeWin.setMenu(null);
        geeWin.once('ready-to-show', () => { try { geeWin.show(); } catch { /* 忽略 */ } });
        // 本地 http 源承载验证页：验证组件按 location.protocol 拼资源地址，data:/file: 页面会拼出非法地址报网络错误
        srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page); });
        srv.on('error', () => finish(null));
        srv.listen(0, '127.0.0.1', () => {
          geeWin.loadURL('http://127.0.0.1:' + srv.address().port + '/').catch(() => {});
        });
        geeWin.on('closed', () => finish(null));
        const t0 = Date.now();
        const poll = setInterval(() => {
          if (done) { clearInterval(poll); return; }
          if (Date.now() - t0 > 180000) { clearInterval(poll); finish(null); return; } // 3 分钟未完成视为放弃
          try {
            if (geeWin.isDestroyed()) { clearInterval(poll); finish(null); return; }
            geeWin.webContents.executeJavaScript('window.__geeResult || null').then((r) => {
              if (r && r.geetest_validate) { clearInterval(poll); finish({ challenge: r.geetest_challenge, validate: r.geetest_validate, seccode: r.geetest_seccode }); }
            }).catch(() => { /* 下轮再取 */ });
          } catch { /* 窗口销毁竞态：下轮检测 */ }
        }, 700);
      });
    }
    
    // 取B站昵称（nav 端点，凭 SESSDATA；失败返回空 → 界面显示「已登录」兜底）
    const BILI_NAV_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
    async function biliFetchUname(cookie) {
      try {
        const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': BILI_NAV_UA, 'Cookie': String(cookie || '') } });
        const j = await r.json();
        if (j && j.code === 0 && j.data && j.data.uname) return String(j.data.uname).slice(0, 40);
      } catch { /* 忽略 */ }
      return '';
    }
    // 旧凭据补昵称：已登录但凭据没有 uname（升级前登录的）时后台补一次，不阻塞启动
    (async () => {
      try {
        if (biliCredHasData(biliCredPath())) {
          const d = JSON.parse(fs.readFileSync(biliCredPath(), 'utf8'));
          if (d && d.cookie && !d.uname) {
            const u = await biliFetchUname(d.cookie);
            if (u) {
              d.uname = u;
              fs.writeFileSync(biliCredPath(), JSON.stringify(d, null, 2), 'utf8');
              if (win && !win.isDestroyed()) win.webContents.send('bili:loginStatus', { status: 'profile', msg: '', uname: u });
            }
          }
        }
      } catch { /* 忽略 */ }
    })();
    // 发送验证码短信：11 位大陆手机号（国际区号固定 86）
    ipcMain.handle('bili:sms-send', async (e, phone) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝访问' };
      if (!/^1\d{10}$/.test(String(phone || ''))) return { ok: false, reason: '请输入正确的手机号' };
      try {
        const cfgRes = await fetch('https://passport.bilibili.com/x/passport-login/captcha?source=main_web', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
        const cfg = await cfgRes.json();
        if (!cfg || cfg.code !== 0 || !cfg.data || !cfg.data.geetest) return { ok: false, reason: '安全验证配置获取失败，请稍后重试' };
        const { token, geetest } = cfg.data;
        const gee = await biliGeetestWindow(geetest.gt, geetest.challenge);
        if (!gee) return { ok: false, reason: '未完成安全验证' };
        const body = new URLSearchParams({ cid: '86', tel: String(phone), source: 'main_web', token, challenge: gee.challenge, validate: gee.validate, seccode: gee.seccode });
        const res = await fetch('https://passport.bilibili.com/x/passport-login/web/sms/send', {
          method: 'POST',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': 'buvid3=' + biliGetBuvid(), 'Referer': 'https://passport.bilibili.com/login' },
          body
        });
        const j = await res.json();
        if (j && j.code === 0 && j.data && j.data.captcha_key) {
          biliSmsCtx = { captchaKey: j.data.captcha_key, tel: String(phone), ts: Date.now() };
          return { ok: true };
        }
        return { ok: false, reason: ((j && (j.message || j.msg)) || '短信发送失败').slice(0, 120) };
      } catch (err) { return { ok: false, reason: (err && err.message) || '网络异常' }; }
    });
    // 用短信验证码换登录凭据：成功后写入凭据文件（与扫码登录同款格式与备份机制），播放自动升级音质
    ipcMain.handle('bili:sms-login', async (e, phone, code) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝访问' };
      const ctx = biliSmsCtx;
      if (!ctx || ctx.tel !== String(phone || '') || Date.now() - ctx.ts > 600000) return { ok: false, reason: '请先获取验证码' };
      if (!/^\d{4,8}$/.test(String(code || ''))) return { ok: false, reason: '请输入短信验证码' };
      try {
        const body = new URLSearchParams({ cid: '86', tel: ctx.tel, code: String(code), captcha_key: ctx.captchaKey, source: 'main_web' });
        const res = await fetch('https://passport.bilibili.com/x/passport-login/web/login/sms', {
          method: 'POST',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': 'buvid3=' + biliGetBuvid(), 'Referer': 'https://passport.bilibili.com/login' },
          body
        });
        const j = await res.json();
        if (!j || j.code !== 0) return { ok: false, reason: ((j && (j.message || j.msg)) || '验证码校验失败').slice(0, 120) };
        let setCookies = [];
        try { setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : String(res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/); } catch { setCookies = []; }
        const pairs = {};
        for (const sc of setCookies) {
          const kv = String(sc).split(';')[0];
          const i = kv.indexOf('=');
          if (i > 0) pairs[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
        }
        if (!pairs.SESSDATA) return { ok: false, reason: '登录响应缺少凭据，请重试' };
        // 写入凭据文件（沿用扫码登录的文件格式与备份机制）
        biliCredRestoreIfNeeded();
        let data = {};
        try { data = JSON.parse(fs.readFileSync(biliCredPath(), 'utf8')) || {}; } catch { data = {}; }
        const existing = {};
        String(data.cookie || '').split(';').forEach((pc) => { const i = pc.indexOf('='); if (i > 0) existing[pc.slice(0, i).trim()] = pc.slice(i + 1).trim(); });
        for (const k of ['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct', 'sid']) if (pairs[k]) existing[k] = pairs[k];
        data.cookie = Object.entries(existing).map(([k, v]) => k + '=' + v).join('; ');
        const mid = parseInt(pairs.DedeUserID, 10);
        if (mid) data.mid = mid;
        const uname = await biliFetchUname(data.cookie);
        if (uname) data.uname = uname;
        fs.writeFileSync(biliCredPath(), JSON.stringify(data, null, 2), 'utf8');
        try { fs.copyFileSync(biliCredPath(), biliCredBackupPath()); } catch { /* 备份失败不影响登录 */ }
        biliClient = null;
        biliCache.clear();
        biliWarmPending = [];
        biliSmsCtx = null;
        if (win && !win.isDestroyed()) win.webContents.send('bili:loginStatus', { status: 'success', msg: '登录成功', uname });
        return { ok: true };
      } catch (err) { return { ok: false, reason: (err && err.message) || '网络异常' }; }
    });
    // 一键导入：列出登录账号创建的收藏夹（公开接口，mid 取凭据）
    ipcMain.handle('bili:myfav', async (e) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝访问' };
      try {
        let mid = 0, cookie = '';
        try { const d = JSON.parse(fs.readFileSync(biliCredPath(), 'utf8')) || {}; mid = Number(d.mid || 0); cookie = String(d.cookie || ''); } catch { /* 未登录 */ }
        if (!mid) { const m = /DedeUserID=(\d+)/.exec(cookie); if (m) mid = Number(m[1]); }
        if (!mid) return { ok: false, reason: '未登录B站，请先在账号管理登录' };
        const res = await fetch('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + mid, { headers: { 'User-Agent': BILI_NAV_UA, 'Cookie': cookie, 'Referer': 'https://space.bilibili.com/' } });
        const j = await res.json();
        if (j && j.code === 0 && Array.isArray(j.data && j.data.list)) {
          return { ok: true, folders: j.data.list.map((f) => ({ id: String(f.id), title: String(f.title || ''), count: Number(f.media_count || 0) })) };
        }
        return { ok: false, reason: ((j && (j.message || j.msg)) || '收藏夹获取失败').slice(0, 120) };
      } catch (err) { return { ok: false, reason: (err && err.message) || '网络异常' }; }
    });
    // 主动预热（渲染层在当前歌开始播放时预热队列下一首；导入时预热前 5 首同款队列）
    ipcMain.on('bili:warm', (e, bvid) => {
      if (!isTrusted(e) || typeof bvid !== 'string' || !/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) return;
      const c = biliCache.get(bvid);
      if (c && Date.now() - c.ts < BILI_CACHE_TTL) return;
      if (!biliWarmPending.includes(bvid)) { biliWarmPending.push(bvid); biliWarmKick(); }
    });
    // —— 猜你喜欢：按常听歌手生成（熟歌池=网易云搜歌手热门；尝新池=登录用网易每日推荐，未登录用酷狗推荐歌单抽歌）——
    // 熟歌过滤非原版标记（含「变速」——用户反馈 QQ 歌单导入常混变速版，这里同步拦）
    const GUESS_NON_ORIG = ['变速', '加速', '减速', 'slowed', 'sped up', 'pitch', 'remix', 'cover', '翻唱', '伴奏', '铃声', '现场', 'live版', 'dj版'];
    ipcMain.handle('rec:guess', async (e, seeds, ratio) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝访问' };
      const artists = (Array.isArray(seeds) ? seeds : []).filter((a) => a && typeof a.name === 'string' && a.name.trim()).slice(0, 6);
      const rn = Number(ratio);
      const R = Number.isFinite(rn) ? Math.min(0.5, Math.max(0, rn)) : 0.3;
      const isNonOrig = (t) => GUESS_NON_ORIG.some((w) => t.includes(w));
      // 熟歌池
      const fam = [];
      for (const a of artists) {
        try {
          const s = await leizGet('/netease/search?q=' + encodeURIComponent(a.name.trim()) + '&limit=12');
          if (!s.ok || !Array.isArray(s.data)) continue;
          const raw = s.data.filter((it) => it && it.id);
          const okv = raw.filter((it) => !isNonOrig((String(it.name || '') + String(it.artists || '')).toLowerCase()));
          for (const it of (okv.length ? okv : raw).slice(0, 8)) {
            fam.push({ id: 'online:netease:' + it.id, online: true, source: 'netease', ref: String(it.id), title: it.name || '', artist: it.artists || '', album: it.album || '', duration: Math.round((it.duration || 0) / 1000), picUrl: it.picUrl || '' });
          }
        } catch { /* 单歌手失败继续 */ }
      }
      // 尝新池
      let fresh = [];
      let freshSrc = 'hot';
      try {
        const n = neteaseAcc.getState();
        if (n.cookie && /MUSIC_U=/.test(n.cookie)) {
          const d = await neteaseAcc.recommendSongs();
          if (d.ok && d.songs.length) {
            freshSrc = 'daily';
            fresh = d.songs.map((x) => ({ id: 'online:netease:' + x.id, online: true, source: 'netease', ref: x.id, title: x.name, artist: x.artist, album: x.album || '', duration: Math.round((x.duration || 0) / 1000), picUrl: x.picUrl || '' }));
          }
        }
      } catch { /* 忽略 */ }
      if (!fresh.length) {
        try {
          const pr = await kugouAcc.recommendPlaylists(0, 1, 12);
          const pls = (pr.playlists || []).filter((x) => x.gcid).sort(() => Math.random() - 0.5).slice(0, 2);
          for (const pl of pls) {
            const full = await fetchKugouCollectAll(pl.gcid);
            if (full.ok) fresh.push(...full.songs);
          }
        } catch { /* 忽略 */ }
      }
      // 合成 50：nNew = round(50×R)，其余熟歌；各自洗牌去重
      const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
      const TOTAL = 50;
      const seen = new Set();
      const pick = (pool, n) => { const out = []; for (const x of shuffle(pool)) { if (out.length >= n) break; if (seen.has(x.id) || !x.title) continue; seen.add(x.id); out.push(x); } return out; };
      const newPart = pick(shuffle(fresh), Math.round(TOTAL * R));
      const famPart = pick(shuffle(fam), TOTAL - newPart.length);
      const songs = shuffle(newPart.concat(famPart)).slice(0, TOTAL);
      return { ok: songs.length > 0, songs, mix: { familiar: famPart.length, fresh: newPart.length, freshSource: freshSrc } };
    });
    // —— 导入自动适配最佳：标题带非原版标记（变速/DJ/翻唱等）的歌，跨源搜「干净标题+歌手匹配」的原版替换 ——
    const NON_ORIG_RES = [/变速/, /加速/, /减速/, /slowed/i, /sped\s?up/i, /pitch/i, /remix/i, /dj版/, /\bdj\b/i, /cover/i, /翻唱/, /伴奏/, /铃声/, /现场/, /live版/i, /纯音乐/, /串烧/, /慢摇/, /钢琴版/, /吉他版/, /变奏/, /治愈版/, /伤感版/, /抖音版/, /热歌版/, /女声版/, /男生版/, /慢速版/, /快速版/, /8d/i];
    function isNonOrigTitle(t) { return false; }
    function cleanTitleForSearch(t) {
      let x = String(t || '');
      x = x.replace(/[\(（\[【].*?[\)）\]】]/g, ' ');
      for (const w of ['变速', '加速', '减速', 'slowed', 'sped up', 'pitch', 'remix', 'cover', '翻唱', '伴奏', '铃声', '现场', 'live版', 'dj版', '纯音乐', '串烧', '慢摇', '钢琴版', '吉他版', '变奏']) x = x.split(w).join(' ');
      return x.replace(/\s+/g, ' ').trim().toLowerCase();
    }
    // 歌单导入后处理：给 acc:playlist 与渲染层链接导入共用；bilibili/qq 不动（qq 自带换源）
    // 候选打分：标题干净相等 4 / 互含 2；歌手任一命中必填 +2；专辑匹配（跨平台强证据）+3；首歌手精确 +2；
    // 两源全扫取最高分，≥6 才换——纯「互含+歌手」(4) 不再够格，避免换到同名单曲页/非原版
    const normSoft = (x) => String(x || '').toLowerCase().replace(/[\s（）()\[\]]+/g, '');
    const albumEq = (a, b) => { const x = normSoft(a), y = normSoft(b); return !!x && !!y && (x === y || (x.includes(y) || y.includes(x)) && Math.min(x.length, y.length) >= 2); };
    const firstTok = (ar) => (String(ar || '').split(/[、,/]/)[0] || '').trim().toLowerCase().replace(/[.。\s]+$/, '');
    async function adaptImportSongs(payload) {
      return payload; // 非原版替换已解除
      const songs = (payload && payload.songs) || [];
      const targets = songs.filter((x) => x && x.title && x.source !== 'bilibili' && x.source !== 'qq' && isNonOrigTitle(x.title + ' ' + (x.artist || '')));
      let replaced = 0, idx = 0;
      async function worker() {
        while (idx < targets.length) {
          const tg = targets[idx++];
          const clean = cleanTitleForSearch(tg.title);
          if (!clean) continue;
          const wantArts = String(tg.artist || '').toLowerCase().split(/[、,/]/).map((x) => x.trim()).filter(Boolean);
          const wFirst = firstTok(tg.artist);
          let best = null, bestScore = -1, bestSrc = '';
          for (const src of ['netease', 'kugou']) {
            try {
              const r = await leizGet('/' + src + '/search?q=' + encodeURIComponent(clean) + '&limit=10');
              if (!r.ok || !Array.isArray(r.data)) continue;
              for (const it of r.data) {
                if (!it || !it.id) continue;
                const tn = String(it.name || '').toLowerCase();
                const ar = String(it.artists || '').toLowerCase();
                if (!tn || isNonOrigTitle(tn + ' ' + ar)) continue;
                const tc = cleanTitleForSearch(tn);
                let sc = 0;
                if (tc === clean) sc += 4;
                else if ((tc.includes(clean) || clean.includes(tc)) && Math.min(tc.length, clean.length) >= 2) sc += 2;
                else continue;
                const artistOk = !tg.artist || wantArts.some((a) => a && ar.includes(a));
                if (!artistOk) continue; // 歌手任一命中仍是硬条件（翻唱署名不含原唱即拒）
                if (tg.album && it.album && albumEq(tg.album, it.album)) sc += 3; // 专辑对上：跨平台最强证据
                if (wFirst && firstTok(it.artists) === wFirst) sc += 2; // 首歌手精确（翻唱常挂原唱名在后面凑匹配）
                if (sc > bestScore) { bestScore = sc; best = it; bestSrc = src; }
              }
            } catch { /* 单源失败继续 */ }
          }
          if (best && bestScore >= 6) {
            const i = songs.indexOf(tg);
            if (i >= 0) {
              songs[i] = Object.assign({}, tg, { source: bestSrc, ref: String(best.id), id: 'online:' + bestSrc + ':' + best.id, title: best.name || tg.title, artist: best.artists || tg.artist, album: best.album || tg.album || '', picUrl: best.picUrl || tg.picUrl || '', duration: Math.round((best.duration || 0) / 1000) || tg.duration, level: undefined });
              replaced++;
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, Math.max(1, targets.length)) }, worker));
      return Object.assign({}, payload, { songs, adaptedReplaced: replaced, adaptedChecked: targets.length });
    }
    ipcMain.handle('import:adapt', async (e, songs) => {
      if (!isTrusted(e) || !Array.isArray(songs)) return { ok: false, reason: '参数错误' };
      const r = await adaptImportSongs({ songs });
      return { ok: true, songs: r.songs, replaced: r.adaptedReplaced, checked: r.adaptedChecked };
    });
    // ---------- QQ 歌单导入（官方 musicu.fcg 匿名拉取；v1.4.2 起 QQ 音源已移除，拉到的曲目走 leiz 严格换源补齐酷狗/网易云版本）----------
    // QQ 歌单导入：官方接口匿名拉全量 → 10 路并发逐首 leiz 严格换源（酷狗→网易云，歌名+歌手全等才换，宁缺毋滥）；未匹配到的歌跳过（避免导入后播放失败）
    ipcMain.handle('qq:playlist', async (e, disstid) => {
      if (!isTrusted(e) || typeof disstid !== 'string' || !disstid) return { ok: false, reason: '参数错误' };
      const pl = await qqPlaylist.playlistAll(disstid);
      if (!pl.ok) return { ok: false, reason: pl.reason || '歌单获取失败' };
      const out = new Array(pl.songs.length); // 预分配保序（并发 worker 按索引写入）
      let replaced = 0, failed = 0, kept = 0;
      const CONCURRENCY = 10;
      const resolveOne = async (s) => {
        const bare = String(s.name || '').trim();
        const firstArtist = Array.isArray(s.artists) ? (s.artists[0] || '') : '';
        const qFull = (bare + ' ' + firstArtist).trim();
        let hit = null;
        if (qFull) {
          try { const kg = await leizGet('/kugou/search?q=' + encodeURIComponent(qFull) + '&limit=8'); if (kg.ok && Array.isArray(kg.data)) hit = pickFallback(kg.data, s.name, s.artists, 'kugou', true); } catch { /* 单歌失败不拖垮整体 */ }
        }
        if (!hit && qFull) {
          try { const ne = await leizGet('/netease/search?q=' + encodeURIComponent(qFull) + '&limit=8'); if (ne.ok && Array.isArray(ne.data)) hit = pickFallback(ne.data, s.name, s.artists, 'netease', true); } catch { /* 忽略 */ }
        }
        return { hit };
      };
      let idx = 0;
      const win = BrowserWindow.fromWebContents(e.sender);
      const pushProgress = (done, total) => {
        try { if (win && !win.isDestroyed()) win.webContents.send('qq-playlist-progress', { done, total }); } catch { /* 窗口已关忽略 */ }
      };
      let doneCount = 0;
      const worker = async () => {
        while (idx < pl.songs.length) {
          const i = idx++;
          const { hit } = await resolveOne(pl.songs[i]);
          doneCount++;
          if (doneCount % 25 === 0 || doneCount === pl.songs.length) pushProgress(doneCount, pl.songs.length);
          if (hit) {
            replaced++; // 全部为换源命中（酷狗/网易云）
            out[i] = { source: hit.source, ref: hit.ref, title: hit.title, artist: hit.artist, album: hit.album, duration: hit.duration, picUrl: hit.picUrl || pl.songs[i].picUrl || '' };
          } else {
            failed++;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pl.songs.length) }, worker));
      const flat = out.filter(Boolean);
      return { ok: true, data: { name: pl.name || 'QQ 歌单', picUrl: pl.picUrl, desc: pl.desc || '', songs: flat, total: pl.songs.length }, replaced, failed, kept };
    });

    // 解析 QQ 歌单短链（c6.y.qq.com/base/fcgi-bin/u?__=xxx 跳转链）→ 最终 URL
    ipcMain.handle('qq:resolveLink', async (e, url) => {
      if (!isTrusted(e) || typeof url !== 'string' || !/^https?:\/\//.test(url)) return { ok: false, reason: '参数错误' };
      const resolved = await new Promise((resolve) => {
        const mod = /^https:/.test(url) ? https : http;
        const doGet = (u, depth) => {
          if (depth > 8) return resolve(null);
          let req;
          try {
            req = mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
              if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                let next;
                try { next = new URL(res.headers.location, u).toString(); } catch { next = res.headers.location; }
                return doGet(next, depth + 1);
              }
              res.resume();
              resolve(u);
            });
          } catch { return resolve(null); }
          req.on('error', () => resolve(null));
          req.setTimeout(10000, () => { try { req.destroy(); } catch { /* */ } resolve(null); });
        };
        doGet(url, 0);
      });
      if (!resolved) return { ok: false, reason: '链接解析失败' };
      return { ok: true, url: resolved };
    });

    // 会员歌换源匹配：同歌名同歌手（宽松：小写去空格比较歌名；歌手任一匹配）
    // strict=true（换到酷狗/网易云等外部源）：歌手名与歌曲名须严格相等，否则宁愿保持原源 128k（避免换错版本）
    function pickFallback(list, qqTitle, qqArtists, source, strict) {
      const norm = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, '');
      const want = norm(qqTitle);
      const artists = (Array.isArray(qqArtists) ? qqArtists : []).map(norm).filter(Boolean);
      const mkk = (it) => ({ source: 'kugou', ref: String(it.hash), title: it.name || it.title, artist: String(it.artists || ''), album: it.album || '', duration: it.duration || 0, picUrl: it.picUrl || '' });
      const mkn = (it) => ({ source: 'netease', ref: String(it.id), title: it.name || it.title, artist: String(it.artists || ''), album: it.album || '', duration: it.duration || 0, picUrl: it.picUrl || '' });
      // 歌手验证：pass1 歌名≥1分+歌手匹配；pass2 歌名≥1分不验歌手（保底同歌名任意版本）；
      // pass3 歌名0分(包含)+歌手匹配。合集/多人歌（群星、歌手≥3）跳过歌手验证避免误弃。
      const bareName = (t) => norm(t).replace(/[\(（].*?[\)）]/g, '').replace(/[-·—]?\s*《[^》]*》/g, '').trim();
      const wantBare = bareName(qqTitle);
      const score = (it) => {
        const t = norm(it.name || it.title || '');
        if (!t) return -1;
        if (t === want) return 2;
        if (bareName(it.name || it.title || '') === wantBare) return 1;
        if (wantBare && (t.includes(wantBare) || wantBare.includes(t)) && Math.abs(t.length - wantBare.length) <= 6) return 0;
        return -1;
      };
      const artistsOf = (it) => Array.isArray(it.artists) ? it.artists.join('、').toLowerCase() : String(it.artists || it.author_name || '').toLowerCase();
      const isCollective = artists.length >= 3 || artists.some((a) => /群星|合辑|原声带|影视|soundtrack|va\b/i.test(a));
      const ranked = list.map((it) => ({ it, s: score(it) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);
      const mk = (it) => {
        // 波点：rid 即保留（含 PAY 锁定歌——播放时 resolveUrl 自动走 antiserver 128k 兜底，保证能播且保持 QQ 源）
        if (source === 'kugou' && it.hash) return mkk(it);
        if (source === 'netease' && it.id) return mkn(it);
        return null;
      };
      if (strict) {
        // 严格模式：歌名完全相等（norm 后）且歌手匹配（歌手缺失时只验歌名），否则宁缺毋滥
        for (const { it, s } of ranked) {
          if (s < 2) continue;
          const artOk = !artists.length || artists.some((a) => artistsOf(it).includes(a));
          if (!artOk) continue;
          return mk(it);
        }
        return null;
      }
      for (const { it, s } of ranked) {
        const artOk = !artists.length || isCollective || artists.some((a) => artistsOf(it).includes(a));
        if (!artOk) continue;
        if (s >= 1) return mk(it);
      }
      for (const { it, s } of ranked) {
        if (s >= 1) return mk(it); // 歌名强匹配保底（歌手对不上也取同歌名版本，避免换源）
      }
      for (const { it } of ranked) {
        const artOk = !artists.length || isCollective || artists.some((a) => artistsOf(it).includes(a));
        if (!artOk) continue;
        return mk(it);
      }
      return null;
    }
    // ---------- 账号登录 + 推荐（网易云/酷狗官方接口，登录态与推荐走官方链路，凭据只存主进程）----------
    // 模块：core/netease.js（weapi/eapi 扫码+密码登录、推荐、歌单全量）、core/kugou.js（扫码登录、推荐歌单）
    const neteaseAcc = require('./core/netease');
    const kugouAcc = require('./core/kugou');
    const qqPlaylist = require('./core/qqplaylist'); // v1.4.2：仅存 QQ 歌单匿名拉取，QQ 音源播放/搜索已移除
    // 凭据持久化（主进程私有：cookie/token 不出主进程，渲染层只拿登录态摘要；D 盘数据根）
    // v2 格式：safeStorage 加密（DPAPI，绑定当前 Windows 用户）；v1 明文自动迁移
    const ACC_FILE = () => accScopedPath('accounts.json');
    function accEncryptAvailable() { try { return !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()); } catch { return false; } }
    function loadAccounts() {
      try {
        let raw = '';
        try { raw = fs.readFileSync(ACC_FILE(), 'utf8'); } catch { return; }
        let acc = null;
        try {
          const j = JSON.parse(raw);
          if (j && j.v === 2 && j.enc) {
            if (!accEncryptAvailable()) return; // 加密不可用(环境变化) → 按匿名处理，避免读到乱码
            acc = JSON.parse(safeStorage.decryptString(Buffer.from(j.enc, 'base64')).toString('utf8'));
          } else if (j && typeof j === 'object' && j.netease !== undefined) {
            acc = j; // v1 明文 → 下次保存自动迁移为 v2
          }
        } catch { /* 损坏忽略，按匿名处理 */ }
        if (acc && typeof acc === 'object') {
          neteaseAcc.setState(acc.netease || { cookie: '', csrf: '', account: null });
          kugouAcc.setState(acc.kugou || { token: '', userid: '', mid: '', dfid: '', vipType: '', vipToken: '', dev: '' });
        }
      } catch { /* 损坏忽略，按匿名处理 */ }
    }
    function saveAccounts() {
      try {
        const data = { netease: neteaseAcc.getState(), kugou: kugouAcc.getState() };
        fs.mkdirSync(store.getDataDir(), { recursive: true });
        if (accEncryptAvailable()) {
          const enc = safeStorage.encryptString(JSON.stringify(data)).toString('base64');
          fs.writeFileSync(ACC_FILE(), JSON.stringify({ v: 2, enc }), 'utf8');
        } else {
          fs.writeFileSync(ACC_FILE(), JSON.stringify(data, null, 1), 'utf8'); // 加密不可用 → 降级明文
        }
      } catch (e) { console.error('[acc] 保存凭据失败', e.message); }
    }
    loadAccounts();
    function accStatus() {
      const n = neteaseAcc.getState();
      const k = kugouAcc.getState();
      return {
        netease: { loggedIn: !!(n.cookie && /MUSIC_U=/.test(n.cookie)), nickname: n.account || '' },
        kugou: { loggedIn: !!(k.token && k.userid), nickname: k.account || '' }
      };
    }
    // 网易云扫码：换取新二维码（返回 unikey + qrurl 供二维码渲染）
    ipcMain.handle('acc:net-qr', async (e) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝访问' };
      const r = await neteaseAcc.qrCreate();
      return r.ok ? { ok: true, unikey: r.unikey, qrurl: r.qrurl } : { ok: false, reason: r.msg || '二维码获取失败' };
    });
    // 网易云扫码状态轮询：803 成功 → 持久化并返回登录态；800/801/802 返回 code
    ipcMain.handle('acc:net-poll', async (e, unikey) => {
      if (!isTrusted(e) || typeof unikey !== 'string' || !unikey) return { ok: false, reason: '参数错误' };
      const r = await neteaseAcc.qrCheck(unikey);
      if (r.ok) {
        const a = await neteaseAcc.accountInfo();
        if (a.ok) neteaseAcc.getState().account = a.nickname || '';
        saveAccounts();
        const s = accStatus();
        return { ok: true, code: 803, status: s.netease };
      }
      return { ok: false, code: r.code, reason: r.msg || '' };
    });
    // 酷狗扫码：换取二维码 key
    ipcMain.handle('acc:kg-qr', async (e) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝访问' };
      const r = await kugouAcc.qrCreate();
      return r.ok ? { ok: true, key: r.key, img: r.img || '', qrurl: r.qrurl || '' } : { ok: false, reason: (r.raw || r.msg || '二维码获取失败').slice(0, 120) };
    });
    // 酷狗扫码状态轮询：status 4 成功 → 持久化并返回登录态
    ipcMain.handle('acc:kg-poll', async (e, key) => {
      if (!isTrusted(e) || typeof key !== 'string' || !key) return { ok: false, reason: '参数错误' };
      const r = await kugouAcc.qrCheck(key);
      if (r.ok) {
        saveAccounts();
        const s = accStatus();
        s.kugou.nickname = r.nickname || '';
        return { ok: true, status: s.kugou };
      }
      return { ok: false, code: r.status, reason: r.msg || '' };
    });
    // 登出：清当前平台凭据并持久化
    ipcMain.handle('acc:logout', (e, platform) => {
      if (!isTrusted(e) || !['netease', 'kugou'].includes(platform)) return { ok: false, reason: '参数错误' };
      if (platform === 'netease') neteaseAcc.setState({ cookie: '', csrf: '', account: null });
      else kugouAcc.setState({ token: '', userid: '', mid: kugouAcc.getState().mid, dfid: '', vipType: '', vipToken: '', dev: kugouAcc.getState().dev });
      saveAccounts();
      pcTombstone('acc:' + platform);
      return { ok: true, status: accStatus() };
    });
    // 登录态查询（渲染层启动/推荐页刷新用）
    ipcMain.handle('acc:status', (e) => {
      if (!isTrusted(e)) return null;
      return accStatus();
    });
    // 账号「我的歌单」列表（登录后）：netease 已实现；kugou 接口待逆向
    ipcMain.handle('acc:my-playlists', async (e, platform) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝访问' };
      if (platform === 'netease') {
        const n = neteaseAcc.getState();
        if (!(n.cookie && /MUSIC_U=/.test(n.cookie))) return { ok: false, reason: '未登录网易云（推荐页可登录）' };
        return await neteaseAcc.myPlaylists();
      }
      if (platform === 'kugou') {
        const k = kugouAcc.getState();
        if (!(k.token && k.userid)) return { ok: false, reason: '未登录酷狗（账号管理可登录）' };
        return await kugouAcc.myPlaylists();
      }
      return { ok: false, reason: '未知平台' };
    });
    // 二维码图（登录弹窗渲染用）：任意文本 → dataURL（qrcode 纯 JS 生成，无外链）
    const qrCodeLib = (() => { try { return require('qrcode'); } catch { return null; } })();
    // 网易云手机验证码：发送 + 登录
    ipcMain.handle('acc:net-captcha-send', async (e, phone) => {
      if (!isTrusted(e) || typeof phone !== 'string' || !/^\d{5,15}$/.test(phone)) return { ok: false, reason: '手机号格式不正确' };
      let r = await neteaseAcc.captchaSend(phone);
      // -462 人机验证:弹窗完成滑块后自动重发验证码
      if (!r.ok && Number(r.code) === -462 && r.verify) {
        const vr = await netVerifyDialog(r.verify);
        if (!vr) return { ok: false, reason: '安全验证未完成', code: -462 };
        r = await neteaseAcc.captchaSend(phone, '86', vr);
      }
      return { ok: r.ok, reason: r.msg || '' };
    });
    ipcMain.handle('acc:net-captcha-login', async (e, phone, captcha) => {
      if (!isTrusted(e) || typeof phone !== 'string' || typeof captcha !== 'string' || !captcha) return { ok: false, reason: '参数错误' };
      let r = await neteaseAcc.captchaLogin(phone, captcha);
      // -462 人机验证(拼图滑块):弹出验证窗口,完成后自动重试登录
      if (!r.ok && Number(r.code) === -462 && r.verify) {
        const vr = await netVerifyDialog(r.verify);
        if (!vr) return { ok: false, reason: '安全验证未完成', code: -462 };
        r = await neteaseAcc.captchaLogin(phone, captcha, '86', vr);
      }
      console.error('[net-captcha-login]', JSON.stringify({ code: r.code, ok: r.ok, msg: r.msg || '', raw: (r.raw || '').slice(0, 160) }));
      if (r.ok) {
        neteaseAcc.getState().account = r.nickname || '';
        saveAccounts();
      }
      return { ok: r.ok, reason: r.msg || '', nickname: r.nickname || '' };
    });
    // 酷狗手机验证码：发送 + 登录（官方接口，逻辑在 kugou.js）
    ipcMain.handle('acc:kg-captcha-send', async (e, phone) => {
      if (!isTrusted(e) || typeof phone !== 'string' || !/^\d{5,15}$/.test(phone)) return { ok: false, reason: '手机号格式不正确' };
      const r = await kugouAcc.captchaSend(phone);
      return { ok: r.ok, reason: r.reason || '' };
    });
    ipcMain.handle('acc:kg-captcha-login', async (e, phone, captcha) => {
      if (!isTrusted(e) || typeof phone !== 'string' || typeof captcha !== 'string' || !captcha) return { ok: false, reason: '参数错误' };
      const r = await kugouAcc.captchaLogin(phone, captcha);
      console.error('[kg-captcha-login]', JSON.stringify({ code: r.code, ok: r.ok, raw: (r.raw || '').slice(0, 160) }));
      if (r.ok) {
        kugouAcc.getState().account = r.nickname || '';
        saveAccounts();
      }
      const reason = r.reason + (r.code ? `（错误码 ${r.code}）` : '');
      return { ok: r.ok, reason, nickname: r.nickname || '' };
    });
    ipcMain.handle('acc:qr-img', async (e, text) => {
      if (!isTrusted(e) || typeof text !== 'string' || !text || !qrCodeLib) return null;
      try {
        const url = await qrCodeLib.toDataURL(text.slice(0, 500), { margin: 1, width: 240, errorCorrectionLevel: 'M' });
        return url;
      } catch { return null; }
    });
    // 推荐数据：网易云每日推荐（需登录）+ 歌单推荐（匿名可用）+ 酷狗推荐歌单（匿名可用）
    ipcMain.handle('acc:recommend', async (e, platform) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝访问' };
      const out = {};
      if (!platform || platform === 'netease') {
        const n = neteaseAcc.getState();
        let daily = { ok: false, songs: [] }, pls = { ok: false, playlists: [] };
        if (n.cookie && /MUSIC_U=/.test(n.cookie)) daily = await neteaseAcc.recommendSongs();
        else daily = await neteaseAcc.guestDaily(); // 游客态：明文端点通用推荐
        pls = await neteaseAcc.personalizedPlaylists(30);
        // 服务端无视分页参数（实测 offset 0/30/60 返回相同）→ 本地洗牌全量 30 条，
        // 渲染层取前 10：每次刷新（重走本 handler）展示的歌单子集随机变化
        for (let i = (pls.playlists || []).length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pls.playlists[i]; pls.playlists[i] = pls.playlists[j]; pls.playlists[j] = t; }
        out.netease = {
          loggedIn: !!(n.cookie && /MUSIC_U=/.test(n.cookie)),
          daily: daily.songs.map((s) => ({
            id: 'online:netease:' + s.id, online: true, source: 'netease', ref: s.id,
            title: s.name, artist: s.artist, album: s.album, picUrl: s.picUrl, duration: Math.round((s.duration || 0) / 1000), reason: s.reason || ''
          })),
          dailyOk: daily.ok, dailyNeedLogin: !!daily.needLogin, dailyGuest: !(n.cookie && /MUSIC_U=/.test(n.cookie)),
          playlists: (pls.playlists || []).map((p) => ({
            id: 'online:netease:' + p.id, source: 'netease', ref: String(p.id), name: p.name,
            picUrl: p.picUrl, desc: p.copywriter, playCount: p.playCount, creator: p.creator
          }))
        };
      }
      if (!platform || platform === 'kugou') {
        const k = kugouAcc.getState();
        // 随机页码换一批；实测服务端偶发返回空页（同页码两次请求一次 0 条一次 29 条）→ 空则回退第 1 页
        const pr0 = await kugouAcc.recommendPlaylists(0, 1 + Math.floor(Math.random() * 4), 30);
        const pr = (pr0.playlists && pr0.playlists.length) ? pr0 : await kugouAcc.recommendPlaylists(0, 1, 30);
        out.kugou = {
          loggedIn: !!(k.token && k.userid),
          playlists: (pr.playlists || []).map((p) => ({
            id: 'online:kugou:' + p.gcid, source: 'kugou', ref: p.gcid, name: p.name,
            picUrl: p.img, desc: p.desc, playCount: p.count, creator: p.creator
          }))
        };
      }
      return { ok: true, data: out };
    });
    // 推荐歌单全量拉取：网易云 trackIds→song/detail 分批（无上限）；酷狗官方分页（复用现有 fetchKugouCollectAll）
    ipcMain.handle('acc:playlist', async (e, source, ref) => {
      if (!isTrusted(e) || !['netease', 'kugou'].includes(source) || typeof ref !== 'string' || !ref) return { ok: false, reason: '参数错误' };
      if (source === 'netease') {
        const r = await neteaseAcc.playlistSongsAll(ref, null);
        if (!r.ok || !r.songs.length) return { ok: false, reason: r.reason || '歌单为空或获取失败' };
        // 非原版标题自动跨源换原版；total 供渲染层做掉歌透明提示（本源无版权歌 detail 接口会静默剔除）
        return await adaptImportSongs({
          ok: true, name: r.name || '', desc: r.desc || '', total: r.total || 0,
          songs: r.songs.map((s) => ({
            id: 'online:netease:' + s.id, online: true, source: 'netease', ref: s.id,
            title: s.name, artist: s.artist, album: s.album, picUrl: s.picUrl, duration: Math.round((s.duration || 0) / 1000)
          }))
        });
      }
      const full = await fetchKugouCollectAll(ref);
      return full.ok ? await adaptImportSongs({ ok: true, name: '酷狗推荐歌单', desc: '', songs: full.songs }) : { ok: false, reason: '歌单获取失败' };
    });
    // ---------- 本地账号（名字+头像；数据可序列化，为 1.3.8 云端账号同步铺路）----------
    // 存储：dataRoot()/local-account.json（含 avatar 本地路径）；头像复制到 dataRoot()/avatars/local.<ext>
    const LOCAL_ACC_FILE = () => accScopedPath('local-account.json');
    function localAccRead() {
      try {
        if (fs.existsSync(LOCAL_ACC_FILE())) return JSON.parse(fs.readFileSync(LOCAL_ACC_FILE(), 'utf8'));
      } catch { /* 损坏回退默认 */ }
      return { name: '', avatar: '' };
    }
    function localAccWrite(acc) {
      try {
        fs.mkdirSync(path.dirname(LOCAL_ACC_FILE()), { recursive: true });
        fs.writeFileSync(LOCAL_ACC_FILE(), JSON.stringify(acc, null, 2), 'utf8');
        return true;
      } catch { return false; }
    }
    ipcMain.handle('local-acc:get', (e) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝' };
      return { ok: true, account: localAccRead() };
    });
    ipcMain.handle('local-acc:save', (e, name, avatar) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝' };
      // avatar 必须落在 dataRoot()/avatars/ 下（防任意路径注入渲染层 file:// 读取）
      let safeAvatar = '';
      if (typeof avatar === 'string' && avatar) {
        const avDir = path.join(dataRoot(), 'avatars');
        const resolved = path.resolve(avatar);
        if (resolved === avDir || resolved.startsWith(avDir + path.sep)) safeAvatar = resolved;
      }
      const acc = {
        name: String(name || '').trim().slice(0, 24),
        avatar: safeAvatar,
        updatedAt: new Date().toISOString()
      };
      return { ok: localAccWrite(acc), account: acc };
    });
    ipcMain.handle('local-acc:pick-avatar', async (e) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝' };
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(win, {
        title: '选择头像图片', properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
      const src = r.filePaths[0];
      const ext = (path.extname(src) || '.png').toLowerCase();
      try {
        const dir = path.join(dataRoot(), 'avatars');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, 'local' + ext);
        fs.copyFileSync(src, dest);
        return { ok: true, avatar: dest };
      } catch (err) { return { ok: false, reason: '头像保存失败：' + (err.message || err) }; }
    });
    ipcMain.handle('local-acc:export', async (e) => {
      if (!isTrusted(e)) return { ok: false, reason: '拒绝' };
      const acc = localAccRead();
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showSaveDialog(win, {
        title: '导出本地账号数据', defaultPath: 'local-account.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      try { fs.writeFileSync(r.filePath, JSON.stringify(acc, null, 2), 'utf8'); return { ok: true, path: r.filePath }; }
      catch (err) { return { ok: false, reason: '导出失败：' + (err.message || err) }; }
    });
    // ===== 局域网同步（PC 当服务器，手机连同一 WiFi 同步）=====
    const syncBundle = require('./core/sync-bundle.js');
    const syncServer = require('./core/sync-server.js');
    const syncState = { enabled: false, port: 8790, code: '', identity: '' };
    try { const j = store.load('sync.json', null); if (j && typeof j === 'object') { syncState.port = j.port || 8790; syncState.code = j.code || ''; syncState.enabled = !!j.enabled; syncState.identity = j.identity || ''; } } catch (e) {}
    function syncSaveCfg() { try { store.save('sync.json', { enabled: syncState.enabled, port: syncState.port, code: syncState.code, identity: syncState.identity }); } catch (e) {} }
    function syncGenCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
    // —— 设备绑定：账号唯一 identity（随 sync.json 走账号作用域）+ 首次授权签发 deviceToken ——
    if (!syncState.identity) { syncState.identity = crypto.randomBytes(8).toString('hex'); syncSaveCfg(); }
    function syncDevices() { try { return store.load('sync-devices.json', {}) || {}; } catch (e) { return {}; } }
    function syncSaveDevices(d) { try { store.save('sync-devices.json', d); } catch (e) {} }
    function syncIssueToken(label) { const tk = crypto.randomBytes(16).toString('hex'); const d = syncDevices(); d[tk] = { label: String(label || '').slice(0, 24), createdAt: Date.now(), lastSeen: Date.now() }; syncSaveDevices(d); return tk; }
    function syncVerifyToken(tk) { const d = syncDevices(); if (!d[tk]) return false; d[tk].lastSeen = Date.now(); syncSaveDevices(d); return true; }
    function syncReloadForAccount() { // 本地账号切换：identity/码/设备表随账号作用域重载，服务在跑则重启
      try { const j = store.load('sync.json', null) || {}; syncState.port = j.port || 8790; syncState.code = j.code || ''; syncState.enabled = !!j.enabled; syncState.identity = j.identity || ''; } catch (e) {}
      if (!syncState.identity) syncState.identity = crypto.randomBytes(8).toString('hex');
      if (syncServer.running()) syncStart(); else syncSaveCfg();
    }
    function syncFileToDataURL(p) { try { if (!p || !fs.existsSync(p)) return ''; let ext = (path.extname(p) || '.png').toLowerCase().replace(/^\./, ''); if (ext === 'jpg') ext = 'jpeg'; return 'data:image/' + ext + ';base64,' + fs.readFileSync(p).toString('base64'); } catch (e) { return ''; } }
    function syncDataURLToFile(dataURL) { try { const m = /^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/.exec(dataURL || ''); if (!m) return ''; const ext = m[1] === 'jpeg' ? 'jpg' : m[1]; const dir = path.join(dataRoot(), 'avatars'); fs.mkdirSync(dir, { recursive: true }); const dest = path.join(dir, 'local.' + ext); fs.writeFileSync(dest, Buffer.from(m[2], 'base64')); return dest; } catch (e) { return ''; } }
    function syncExportBundle() {
      const opls = store.load('online-playlists.json', []) || [];
      const playlists = store.load('playlists.json', []) || [];
      const favs = store.load('favorites.json', []) || [];
      const hist = store.load('history.json', []) || [];
      const combined = opls.slice();
      for (const ml of playlists) {
        if (!ml || ml.system) continue;
        const songs = (ml.songIds || []).filter((x) => x && typeof x === 'object' && x.online && x.ref)
          .map((x) => ({ online: true, source: x.source, ref: x.ref, title: x.title || '', artist: x.artist || '', album: x.album || '', duration: x.duration || 0, picUrl: x.picUrl || '' }));
        if (songs.length) combined.push({ id: ml.id, name: ml.name, source: 'local-pl', cover: '', songs });
      }
      const recent = hist.filter((h) => h && typeof h.id === 'string' && h.id.indexOf('online:') === 0).map((h) => { const parts = h.id.split(':'); return { online: true, source: parts[1], ref: parts.slice(2).join(':'), at: h.at || 0 }; });
      const acc = localAccRead();
      let bili = null; try { bili = JSON.parse(fs.readFileSync(biliCredPath(), 'utf8')); } catch (e) {}
      return syncBundle.exportBundle({
        onlinePlaylists: combined, favorites: favs, recent,
        profile: { nickname: acc.name || '', avatar: syncFileToDataURL(acc.avatar) },
        accounts: { netease: neteaseAcc.getState(), kugou: kugouAcc.getState(), bilibili: bili ? { cookie: bili.cookie, refreshToken: bili.refreshToken, mid: bili.mid, uname: bili.uname } : null },
        tombstones: store.load('sync-tomb.json', []) || []
      }, 'pc');
    }
    function syncApplyMerged(merged) {
      const r = syncBundle.importBundle(merged);
      if (!r.ok) return r;
      const tom = r.tombstones || [];
      const tomAt = (k) => { const t = tom.find((x) => x.key === k); return t ? (t.at || 0) : 0; };
      const cur = store.load('online-playlists.json', []) || [];
      const map = new Map(); for (const p of cur) if (p && p.id) map.set(p.id, p);
      for (const p of r.onlinePlaylists) { const old = map.get(p.id) || {}; map.set(p.id, Object.assign({}, old, { id: p.id, name: p.name, source: p.source, cover: p.cover || old.cover || '', songs: p.songs, fav: true, updatedAt: p.updatedAt || old.updatedAt || Date.now() })); }
      const keptOpls = [...map.values()].filter((p) => !(tomAt('pl:' + p.id) > (p.updatedAt || 0)));
      store.save('online-playlists.json', keptOpls);
      const favs = store.load('favorites.json', []) || [];
      const fmap = new Map(); for (const x of favs) { const id = (typeof x === 'string' ? x : (x && x.id)); if (id) fmap.set(id, x); }
      for (const f of r.favorites) {
        const ex = fmap.get(f.id);
        if (!ex) { favs.push(f); fmap.set(f.id, f); }
        else if (ex && typeof ex === 'object') { if (f.picUrl && !ex.picUrl) ex.picUrl = f.picUrl; if (f.title && !ex.title) ex.title = f.title; if (f.artist && !ex.artist) ex.artist = f.artist; }
      }
      const keptFavs = favs.filter((x) => { if (!x || typeof x !== 'object' || !x.source || !x.ref) return true; return !(tomAt('fav:' + x.source + ':' + x.ref) > (x.updatedAt || 0)); });
      store.save('favorites.json', keptFavs);
      const hist = store.load('history.json', []) || [];
      const hset = new Set(hist.map((h) => h && h.id));
      for (const rc of r.recent) { const id = 'online:' + rc.source + ':' + rc.ref; if (!hset.has(id)) { hist.push({ id, at: rc.at || Date.now() }); hset.add(id); } }
      hist.sort((a, b) => (b.at || 0) - (a.at || 0));
      store.save('history.json', hist.slice(0, 200));
      if (r.profile && (r.profile.nickname || r.profile.avatar)) {
        const acc = localAccRead();
        if (r.profile.nickname) acc.name = String(r.profile.nickname).slice(0, 24);
        if (r.profile.avatar) { const p = syncDataURLToFile(r.profile.avatar); if (p) acc.avatar = p; }
        acc.updatedAt = new Date().toISOString(); localAccWrite(acc);
      }
      const a = r.accounts || {};
      try { if (a.netease && a.netease.cookie && !neteaseAcc.getState().cookie) neteaseAcc.setState(a.netease); } catch (e) {}
      try { if (a.kugou && a.kugou.token && !kugouAcc.getState().token) kugouAcc.setState(a.kugou); } catch (e) {}
      try { if (a.bilibili && a.bilibili.cookie) { let curB = null; try { curB = JSON.parse(fs.readFileSync(biliCredPath(), 'utf8')); } catch (e) {} if (!curB || !curB.cookie) { fs.writeFileSync(biliCredPath(), JSON.stringify(a.bilibili, null, 2), 'utf8'); biliClient = null; } } } catch (e) {}
      try { saveAccounts(); } catch (e) {}
      try { const m = new Map(); for (const t of (store.load('sync-tomb.json', []) || [])) if (t && t.key) m.set(t.key, t.at || 0); for (const t of tom) { if (!t || !t.key) continue; m.set(t.key, Math.max(m.get(t.key) || 0, t.at || 0)); } store.save('sync-tomb.json', [...m].map(([key, at]) => ({ key, at }))); } catch (e) {}
      try { if (win && !win.isDestroyed()) win.webContents.send('sync:event', { type: 'applied' }); } catch (e) {}
      return { ok: true };
    }
    function syncOnServerIncoming(incomingBundle) {
      const mine = syncExportBundle();
      const merged = syncBundle.mergeBundles(mine, incomingBundle);
      syncApplyMerged(merged);
      return merged;
    }
    // 一键允许：无有效配对码时弹窗，由用户确认后才合并回传（替代 6 位配对码）
    let syncApproving = false;
    async function syncOnServerRequest(incomingBundle, meta) {
      if (!incomingBundle || typeof incomingBundle !== 'object') return { ok: false, status: 400, reason: '无效的同步包' };
      if (syncApproving) return { ok: false, status: 429, reason: '电脑端正有待确认的同步请求' };
      const devName = incomingBundle.device && incomingBundle.device !== 'mobile' && incomingBundle.device !== 'pc' ? String(incomingBundle.device).slice(0, 24) : '';
      const pnick = incomingBundle.profile && incomingBundle.profile.nickname ? String(incomingBundle.profile.nickname).slice(0, 24) : '';
      const typeDev = ({ mobile: '手机端', pc: '电脑端' })[incomingBundle.device] || '设备';
      const dev = devName || pnick || typeDev;
      const c = { pls: (incomingBundle.onlinePlaylists || []).length, favs: (incomingBundle.favorites || []).length, recent: (incomingBundle.recent || []).length };
      const detail = `${dev}${meta && meta.ip ? '（' + meta.ip + '）' : ''} 收到来自手机端的同步请求，将合并以下数据（两端都新的为准，不会覆盖电脑上更新的修改）——歌单 ${c.pls} · 收藏 ${c.favs} · 最近 ${c.recent}`;
      syncApproving = true;
      try {
        const box = { type: 'question', buttons: ['允许同步', '拒绝'], defaultId: 0, cancelId: 1, noLink: true, title: '局域网同步请求', message: '收到同步请求', detail };
        const r = (win && !win.isDestroyed()) ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box);
        if (r && r.response === 0) {
          try { const merged = syncOnServerIncoming(incomingBundle); return { ok: true, bundle: merged }; }
          catch (e) { return { ok: false, status: 500, reason: '合并失败：' + String((e && e.message) || e) }; }
        }
        return { ok: false, status: 403, reason: '电脑端已拒绝' };
      } finally { syncApproving = false; }
    }
    function syncStart() { if (!syncState.code) syncState.code = syncGenCode(); syncServer.start({ port: syncState.port, code: syncState.code, identity: syncState.identity, handlers: { onSync: syncOnServerIncoming, onRequest: syncOnServerRequest, verifyToken: syncVerifyToken, issueToken: syncIssueToken } }); syncState.enabled = true; syncSaveCfg(); }
    function syncStop() { syncServer.stop(); syncState.enabled = false; syncSaveCfg(); }
    if (syncState.enabled) syncStart();
    ipcMain.handle('sync:info', (e) => { if (!isTrusted(e)) return { ok: false }; const ip = syncServer.lanIPv4(); const dv = syncDevices(); return { ok: true, running: syncServer.running(), ip, port: syncState.port, code: syncState.code, identity: syncState.identity, devices: Object.keys(dv).map((k) => ({ id: k.slice(0, 8), label: dv[k].label || '设备', lastSeen: dv[k].lastSeen || 0 })), url: ip ? ('http://' + ip + ':' + syncState.port) : '' }; });
    ipcMain.handle('sync:revokeOne', (e, id8) => { if (!isTrusted(e) || typeof id8 !== 'string' || !id8) return { ok: false }; const d = syncDevices(); const tk = Object.keys(d).find((k) => k.startsWith(id8)); if (!tk) return { ok: false, reason: '设备不存在' }; delete d[tk]; syncSaveDevices(d); return { ok: true }; });
    ipcMain.handle('sync:repairFirewall', async (e) => {
      if (!isTrusted(e)) return { ok: false };
      try {
        const ps = 'New-NetFirewallRule -DisplayName LyraAria-Sync -Direction Inbound -Protocol TCP -LocalPort 8790 -Action Allow -Profile Any | Out-Null; New-NetFirewallRule -DisplayName LyraAria-Discover -Direction Inbound -Protocol UDP -LocalPort 41230 -Action Allow -Profile Any | Out-Null';
        await new Promise((resolve) => { try { require('child_process').exec('powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList \'-NoProfile,-Command,' + ps.replace(/'/g, '') + '\'"', { timeout: 120000 }, () => resolve()); } catch (e2) { resolve(); } });
      } catch (e3) { /* 用户取消 UAC 等 */ }
      // 验证：查询规则是否存在（提权成功才有）
      let ok1 = false, ok2 = false;
      try { ok1 = /LyraAria-Sync/.test(require('child_process').execSync('netsh advfirewall firewall show rule name=LyraAria-Sync', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { }
      try { ok2 = /LyraAria-Discover/.test(require('child_process').execSync('netsh advfirewall firewall show rule name=LyraAria-Discover', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { }
      return { ok: ok1 && ok2, reason: (ok1 && ok2) ? '' : 'UAC 未批准或执行失败，可手动以管理员运行 netsh 命令' };
    });
    ipcMain.handle('sync:revoke', (e) => { if (!isTrusted(e)) return { ok: false }; syncSaveDevices({}); return { ok: true }; });
    ipcMain.handle('sync:setEnabled', (e, on) => { if (!isTrusted(e)) return { ok: false }; if (on) syncStart(); else syncStop(); return { ok: true, running: syncServer.running(), code: syncState.code }; });
    ipcMain.handle('sync:tomb', (e, key) => { if (!isTrusted(e) || typeof key !== 'string' || !key || key.length > 200) return { ok: false }; pcTombstone(key); return { ok: true }; });
    ipcMain.handle('sync:regenCode', (e) => { if (!isTrusted(e)) return { ok: false }; syncState.code = syncGenCode(); if (syncState.enabled) syncStart(); else syncSaveCfg(); return { ok: true, code: syncState.code }; });
    // 方案升级：先跟随重定向拿最终分享页 URL → 优先走 LeiZ 歌单接口（可返回全量，
    // 实测收藏合集分享页只内嵌 100 首，LeiZ 解析完整 zlist.html URL 返回 trackCount 全量 201 首）；
    // LeiZ 失败才兜底抓分享页 dataFromSmarty（最多 100 首）。
    // ===== 酷狗收藏合集全量拉取（官方 gateway 接口，内嵌签名，零外部依赖）=====
    // 背景：LeiZ 酷狗渠道（id/url 形式）固定返回前 300 首，大歌单（>300）会被截断；
    // 酷狗官方接口 /pubsongs/v2/get_other_list_file_nofilt 支持 begin_idx 分页（单页 300），可全量。
    // 签名逻辑移植自 MakcRe/KuGouMusicApi（MIT，util/helper.js + util/request.js），仅保留本接口所需部分。
    const KG_APPID = 1005, KG_CLIENTVER = 20489;
    const KG_SALT = 'OIlwieks28dk2k092lksi2UIkp'; // android 签名盐（标准版）
    const KG_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
    const KG_EXTRA_HEADERS = { 'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': 1, 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F' };
    function kgGuidV4() {
      const e = () => ((65536 * (1 + Math.random())) | 0).toString(16).substring(1);
      return `${e()}${e()}-${e()}-${e()}-${e()}-${e()}${e()}${e()}`;
    }
    // GUID → mid：MD5(guid) 十六进制逐位转十进制大整数（BigInt）
    function kgMid(guid) {
      const digest = crypto.createHash('md5').update(guid, 'utf8').digest('hex');
      let acc = 0n, base = 1n;
      for (let i = digest.length - 1; i >= 0; i--) { acc += BigInt(parseInt(digest.charAt(i), 16)) * base; base *= 16n; }
      return acc.toString();
    }
    // 分页拉取收藏合集全量（begin_idx 0/300/600…，去重；失败返回 ok:false）
    async function fetchKugouCollectAll(globalCollectionId) {
      const mid = kgMid(kgGuidV4());
      const all = [], seen = new Set();
      const pageSize = 300;
      let beginIdx = 0, total = 0;
      for (let page = 0; page < 10; page++) {
        const clienttime = Math.floor(Date.now() / 1000);
        const params = {
          dfid: '-', mid, uuid: '-', appid: KG_APPID, clientver: KG_CLIENTVER, clienttime,
          area_code: 1, begin_idx: beginIdx, plat: 1, type: 1, mode: 1, personal_switch: 1,
          extend_fields: 'abtags,hot_cmt,popularization', pagesize: pageSize,
          global_collection_id: globalCollectionId
        };
        const paramsString = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
        params.signature = crypto.createHash('md5').update(KG_SALT + paramsString + '' + KG_SALT, 'utf8').digest('hex');
        const qs = Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
        const r = await kugouFetchJson('https://gateway.kugou.com/pubsongs/v2/get_other_list_file_nofilt?' + qs, { dfid: '-', clienttime, mid, ...KG_EXTRA_HEADERS });
        if (!r || !r.data || r.status === 0) break;
        const d = r.data;
        total = d.count || total;
        const songs = Array.isArray(d.songs) ? d.songs : [];
        if (!songs.length) break;
        for (const s of songs) {
          if (!s || !s.hash || seen.has(s.hash)) continue;
          seen.add(s.hash);
          const singerNames = (Array.isArray(s.singerinfo) ? s.singerinfo : []).map((x) => x && x.name).filter(Boolean).join('、');
          let title = s.name || s.song_name || '';
          if (singerNames && title.startsWith(singerNames + ' - ')) title = title.slice(singerNames.length + 3);
          const albumInfo = s.albuminfo || {};
          all.push({
            id: 'online:kugou:' + s.hash, online: true, source: 'kugou', ref: s.hash,
            title, artist: singerNames || s.artists || s.author_name || '',
            duration: Math.round((s.timelen || s.duration || s.timelength || 0) / 1000),
            album: albumInfo.name || s.album || '', picUrl: (s.cover || '').replace('{size}', '200')
            // level 不硬编码：LeiZ/官方接口歌单数据无音质字段，交由渲染层按 mp_online_quality 兜底（默认高品 320）
          });
        }
        if (all.length >= total || songs.length < pageSize) break;
        beginIdx += pageSize;
      }
      return all.length ? { ok: true, songs: all } : { ok: false };
    }

    // 酷狗分享链接解析：t1.kugou.com 短链（收藏歌单/单曲分享）没有标准歌单 ID。
    async function kugouResolveShare(rawUrl) {
      try {
        // 1) 跟随重定向拿最终分享页 URL（并保留最后一跳页面 body 供兜底）
        let url = rawUrl, depth = 0, finalPage = null;
        while (depth < 5) {
          const mod = /^https:/.test(url) ? https : http;
          const page = await new Promise((res2) => {
            const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept': 'text/html' } }, (r) => {
              if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
                r.resume();
                res2({ redirect: r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location, url).href });
                return;
              }
              const chunks = [];
              r.on('data', (c) => chunks.push(c));
              r.on('end', () => res2({ body: Buffer.concat(chunks).toString('utf8') }));
            });
            req.on('error', () => res2({ error: true }));
            req.setTimeout(15000, () => { req.destroy(); res2({ error: true }); });
          });
          if (page.redirect) { url = page.redirect; depth++; continue; }
          finalPage = page;
          break;
        }
        if (depth >= 5) return { ok: false, reason: '重定向过多' };

        // 2) 酷狗官方接口全量（收藏合集）：分享 URL 带 global_collection_id → 签名分页拉全量（突破 LeiZ 300 上限）
        const gcMatch = url.match(/global_collection_id=([^&]+)/);
        if (gcMatch) {
          try {
            const cid = decodeURIComponent(gcMatch[1]);
            const full = await fetchKugouCollectAll(cid);
            if (full.ok && full.songs.length) {
              // 歌单名：尝试 LeiZ（它返回真实歌单名），失败不影响（UI 显示「酷狗分享歌单（N 首）」）
              let name = '';
              try {
                const lzUrl = url.replace(/^http:/i, 'https:');
                const lz = await leizGet('/kugou?type=playlist&url=' + encodeURIComponent(lzUrl));
                if (lz.ok && lz.data && lz.data.name) name = lz.data.name;
              } catch (e) { /* 忽略 */ }
              return { ok: true, name, songs: full.songs };
            }
          } catch (e) { /* 回落 LeiZ */ }
        }

        // 3) LeiZ 全量歌单接口（服务端解析完整分享 URL；酷狗渠道上游封顶 300 首）
        // 注意：t1 短链重定向到的是 http://wwwapi…，LeiZ 只认 https 变体（http 会报"无效链接"）→ 先转 https
        try {
          const lzUrl = url.replace(/^http:/i, 'https:');
          const lz = await leizGet('/kugou?type=playlist&url=' + encodeURIComponent(lzUrl));
          if (lz.ok && lz.data && Array.isArray(lz.data.songs) && lz.data.songs.length) {
            const songs = lz.data.songs.filter((s) => s && s.hash).map((s) => ({
              id: 'online:kugou:' + s.hash,
              online: true, source: 'kugou', ref: s.hash,
              title: s.name || s.song_name || '',
              artist: s.artists || s.author_name || '',
              duration: Math.round((s.duration || s.timelength || 0) / (s.duration ? 1 : 1000)),
              album: s.album || s.album_id || '', picUrl: s.picUrl || ''
              // level 不硬编码：LeiZ 歌单数据无音质字段，交由渲染层按 mp_online_quality 兜底（默认高品 320）
            }));
            if (songs.length) return { ok: true, name: lz.data.name || '', songs };
          }
        } catch (e) { /* 落到兜底 */ }

        // 3) 兜底：分享页 dataFromSmarty 提取（原逻辑）
        if (finalPage.error || !finalPage.body) return { ok: false, reason: '网络异常' };
        const m = finalPage.body.match(/var dataFromSmarty = (\[.*?\])\s*,?\s*\/\/当前页面歌曲信息/s);
        if (!m) return { ok: false, reason: '无法识别分享内容（可能是单曲分享或页面结构变化）' };
        let arr = [];
        try { arr = JSON.parse(m[1]); } catch { return { ok: false, reason: '分享内容解析失败' }; }
        const songs = (Array.isArray(arr) ? arr : []).filter((s) => s && s.hash).map((s) => ({
          id: 'online:kugou:' + s.hash,
          online: true, source: 'kugou', ref: s.hash,
          title: s.song_name || s.audio_name || '',
          artist: s.author_name || '',
          duration: Math.round((s.timelength || 0) / 1000),
          album: s.album_id || '', picUrl: ''
        }));
        return songs.length ? { ok: true, songs } : { ok: false, reason: '分享页没有歌曲数据' };
      } catch (e) { return { ok: false, reason: e.message }; }
    }
    ipcMain.handle('leiz:share', async (e, url) => {
      if (!isTrusted(e) || typeof url !== 'string' || !url.trim()) return { ok: false, reason: '参数错误' };
      return await kugouResolveShare(url.trim());
    });
    // 酷狗歌曲封面：分享页 dataFromSmarty 只有 album_id，没有图片 → 按 album_id 查专辑信息拿封面
    // （mobilecdn 专辑接口实测可用；getdata 按 hash 接口被 WAF 拦，不可用——已实测）
    const kugouCoverCache = new Map(); // albumId|hash -> Promise<coverUrl|null>（并发去重 + 失败也缓存）
    function kugouFetchJson(url, extraHeaders) {
      return new Promise((resolve) => {
        const mod = /^https:/.test(url) ? https : http;
        const req = mod.get(url, { headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Referer': 'https://www.kugou.com/' }, extraHeaders || {}) }, (r) => {
          const chunks = [];
          let total = 0;
          r.on('data', (c) => { total += c.length; if (total <= 2 * 1048576) chunks.push(c); });
          r.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { resolve(null); }
          });
          r.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(12000, () => { req.destroy(); resolve(null); });
      });
    }
    ipcMain.handle('kugou:cover', async (e, song) => {
      if (!isTrusted(e) || !song || typeof song !== 'object') return null;
      const albumId = String(song.albumId || song.album || '');
      const hash = String(song.hash || song.ref || '');
      const key = albumId || hash;
      if (!key) return null;
      if (kugouCoverCache.has(key)) return kugouCoverCache.get(key);
      const p = (async () => {
        let data = null;
        if (albumId) {
          const r = await kugouFetchJson('http://mobilecdn.kugou.com/api/v3/album/info?albumid=' + encodeURIComponent(albumId) + '&plat=0&version=8990');
          data = r && r.data;
        }
        if (!data || !data.imgurl) return null;
        // {size} 占位符替换为 400px；imge.kugou.com 图片 CDN 支持 https
        return data.imgurl.replace(/\{size\}/g, '400').replace(/^http:/, 'https:');
      })();
      kugouCoverCache.set(key, p);
      return p;
    });
    // v1.3.6b：在线封面抓取（带 Referer → dataURL），供直链失败兜底 + 磁盘缓存共用
    async function fetchCoverDataUrlImpl(url) {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
      let host = '';
      try { host = new URL(url).host; } catch { return null; }
      const referer = /(music\.163\.com|music\.126\.net)/i.test(host) ? 'http://music.163.com/'
        : /(kugou|kgimg)/i.test(host) ? 'https://www.kugou.com/' : '';
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            ...(referer ? { Referer: referer } : {})
          },
          signal: ctl.signal
        });
        if (!r.ok) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length || buf.length > 5 * 1024 * 1024) return null;
        const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const mime = /^image\/(png|jpe?g|webp|gif|bmp)$/i.test(ct) ? ct
          : (/\.png$/i.test(url) ? 'image/png' : (/\.webp$/i.test(url) ? 'image/webp' : 'image/jpeg'));
        return 'data:' + mime + ';base64,' + buf.toString('base64');
      } catch { return null; } finally { clearTimeout(timer); }
    }
    // 在线封面磁盘缓存：cover-remote/<url哈希>.txt 存 dataURL；命中直接读，未命中联网抓取并落盘
    function remoteCoverFile(url) {
      return path.join(dataRoot(), 'cover-remote', crypto.createHash('sha256').update(url).digest('hex').slice(0, 32) + '.txt');
    }
    ipcMain.handle('cover:getOrFetch', async (e, url) => {
      if (!isTrusted(e) || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false };
      const file = remoteCoverFile(url);
      try {
        const cached = fs.readFileSync(file, 'utf8');
        if (cached && cached.startsWith('data:image/')) return { ok: true, dataUrl: cached, cached: true };
      } catch { /* 未命中 */ }
      const dataUrl = await fetchCoverDataUrlImpl(url);
      if (!dataUrl) return { ok: false };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, dataUrl, 'utf8');
      } catch { /* 落盘失败不致命 */ }
      return { ok: true, dataUrl, cached: false };
    });
    ipcMain.handle('app:fetchCoverDataUrl', async (e, url) => {
      if (!isTrusted(e)) return null;
      return await fetchCoverDataUrlImpl(url);
    });
    ipcMain.on('lyricwin:play', (e, st) => {
      if (!isTrusted(e)) return;
      if (lyricWin && !lyricWin.isDestroyed()) lyricWin.webContents.send('lyricwin:play', st);
    });
    // 迷你模式控制（歌词窗 → 主播放器）
    ipcMain.on('lyricwin:control', (e, action) => {
      if (!isTrusted(e)) return;
      if (action === 'mode') {
        // 播放模式切换（列表循环 → 单曲循环 → 随机）→ 持久化 + 双向广播
        const order = ['order', 'repeat-one', 'shuffle'];
        config.mode = order[(order.indexOf(config.mode) + 1) % order.length];
        store.save('config.json', config);
        if (lyricWin && !lyricWin.isDestroyed()) lyricWin.webContents.send('lyricwin:mode', config.mode);
        if (win && !win.isDestroyed()) win.webContents.send('player:control', { mode: config.mode });
        return;
      }
      if (win && !win.isDestroyed()) win.webContents.send('player:control', action);
    });
    // 手动拖动（实体感）：渲染层拖动 → 实时 clamp 到屏幕内（窗口被屏幕边缘挡住）
    ipcMain.on('lyricwin:drag', (e, dx, dy) => {
      if (!isTrusted(e)) return;
      if (!lyricWin || lyricWin.isDestroyed() || config.lyricWin.mode !== 'desktop') return;
      // 防御：非有效数字直接忽略（避免 IPC 参数转换异常）
      if (typeof dx !== 'number' || typeof dy !== 'number' || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
      try {
        const b = lyricWin.getBounds();
        const clamped = clampLyricWinBounds({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height });
        if (Number.isFinite(clamped.x) && Number.isFinite(clamped.y)) {
          lyricWin.setPosition(Math.round(clamped.x), Math.round(clamped.y));
          // 兜底：拖动中任何尺寸变化立即弹回固定尺寸
          const s = lyricWin.getSize();
          if (s[0] !== 840 || s[1] !== 160) lyricWin.setSize(840, 160);
        }
      } catch (err) { /* 拖动异常忽略，不影响播放 */ }
    });
    // 周期确保歌词窗保持工具窗口（防 Electron/Windows 重置 EXSTYLE 后任务视图再出现）
    setInterval(() => {
      if (config.lyricWin.enabled && lyricWin && !lyricWin.isDestroyed()) hideLyricFromTaskbar();
    }, 1000);
    // 歌词窗悬停轮询（锁定穿透时鼠标不动也能检测 → 显示"解除锁定"工具条）
    setInterval(() => {
      if (!config.lyricWin.enabled || !lyricWin || lyricWin.isDestroyed()) return;
      // 持续置顶：防止主窗口（大窗）盖住歌词窗导致无法点击/拖动
      try { lyricWin.moveTop(); } catch { /* 忽略 */ }
      // 锁定态左键解锁（2026-09-20 用户拍板，替代中键）：光标进入顶部锁图标条区域 →
      // 临时恢复窗口交互（点 unlockBtn 即解锁）；离开该区域 → 恢复穿透。中键轮询链已移除。
      try {
        const pt = screen.getCursorScreenPoint();
        const b = lyricWin.getBounds();
        const inside = pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
        if (config.lyricWin.locked) {
          // 顶部 44px、水平居中 ±26px = 圆形锁钮热区（#lockbar top:8 + 钮 28px + 富余；
          // 2026-09-20 长条胶囊改单圆钮后热区随收，避免歌词上半段整片变成可交互区挡下层点击）
          const overStrip = pt.y >= b.y && pt.y <= b.y + 44 && Math.abs(pt.x - (b.x + b.width / 2)) <= 26;
          if (overStrip !== lyricStripInteractive) {
            lyricStripInteractive = overStrip;
            try {
              if (overStrip) lyricWin.setIgnoreMouseEvents(false);
              else lyricWin.setIgnoreMouseEvents(true, { forward: true });
            } catch { /* 忽略 */ }
          }
        } else if (lyricStripInteractive) {
          lyricStripInteractive = false; // 解锁态窗口本就交互，复位标志防陈旧
        }
        if (!config.lyricWin.locked) return;
        if (inside !== lyricHover) {
          lyricHover = inside;
          if (inside) lyricWin.moveTop(); // 持续置顶：防主窗口盖住歌词窗
          lyricWin.webContents.send('lyricwin:hoverui', inside);
        }
      } catch { /* 忽略 */ }
    }, 100);
    ipcMain.on('thumb:state', (e, playing) => {
      if (!isTrusted(e)) return;
      updateThumbar(!!playing);
    });
    // 窗口标题 = 歌曲名 → 任务栏缩略图预览上方的文字
    ipcMain.on('media:title', (e, title) => {
      if (!isTrusted(e) || typeof title !== 'string') return;
      if (win && !win.isDestroyed()) {
        win.setTitle(title);
        win.setThumbnailToolTip(title);
      }
    });
  }

  // ---------- 托盘 / 快捷键 ----------
  function sendMedia(action) {
    if (win && !win.webContents.isLoading()) {
      win.webContents.send('media:action', action);
    }
  }

  function setupTray() {
    tray = new Tray(appIcon());
    tray.setToolTip('深空折韵');
    const menu = Menu.buildFromTemplate([
      { label: '播放 / 暂停', click: () => sendMedia('toggle') },
      { label: '上一首', click: () => sendMedia('prev') },
      { label: '下一首', click: () => sendMedia('next') },
      { type: 'separator' },
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => { shutLog('quit-request', 'tray-menu-exit'); app.isQuitting = true; flushState(); app.quit(); } } // W-13 A
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => showMainWindow());
  }

  // ---------- 快捷键系统（应用内 + 全局双层，可自定义；参考网易云/Spotify 公约） ----------
  // global 由主进程 globalShortcut 注册（窗口未聚焦也生效）；local 由渲染层 keydown 处理（聚焦生效）。
  // 空字符串 = 未绑定；全局层支持单键但会全系统拦截，设置页录入时由用户自行权衡。
  const HK_DEFS = [
    { id: 'toggle',    name: '播放 / 暂停',      local: 'Space',      global: 'Ctrl+Alt+P' },
    { id: 'prev',      name: '上一首',           local: 'Ctrl+Left',  global: 'Ctrl+Alt+Left' },
    { id: 'next',      name: '下一首',           local: 'Ctrl+Right', global: 'Ctrl+Alt+Right' },
    { id: 'volUp',     name: '音量增大',         local: 'Up',         global: 'Ctrl+Alt+Up' },
    { id: 'volDown',   name: '音量减小',         local: 'Down',       global: 'Ctrl+Alt+Down' },
    { id: 'mute',      name: '静音',             local: 'M',          global: '' },
    { id: 'seekFwd',   name: '快进 5 秒',        local: 'Right',      global: '' },
    { id: 'seekBack',  name: '快退 5 秒',        local: 'Left',       global: '' },
    { id: 'playMode',  name: '切换播放模式',     local: 'Ctrl+R',     global: 'Ctrl+Alt+R' },
    { id: 'fav',       name: '收藏当前歌曲',     local: 'Ctrl+L',     global: '' },
    { id: 'lyric',     name: '桌面歌词 开/关',   local: 'Ctrl+D',     global: 'Ctrl+Alt+D' },
    { id: 'lyricLock', name: '桌面歌词 锁/解锁', local: '',           global: 'Ctrl+Alt+L' }
  ];
  // 补齐 binds（保留用户已自定义的值，新增动作用默认值）
  for (const d of HK_DEFS) {
    const cur = (config.hotkeys.binds && config.hotkeys.binds[d.id]) || {};
    config.hotkeys.binds[d.id] = {
      local: typeof cur.local === 'string' ? cur.local : d.local,
      global: typeof cur.global === 'string' ? cur.global : d.global
    };
  }

  const HK_MEDIA_KEYS = [['MediaPlayPause', 'toggle'], ['MediaNextTrack', 'next'], ['MediaPreviousTrack', 'prev']];
  const HK_MODS = ['Ctrl', 'Alt', 'Shift', 'Super'];
  function hkIsValidAccel(s) {
    if (typeof s !== 'string') return false;
    if (s === '') return true; // 空 = 未绑定
    const parts = s.split('+');
    const key = parts[parts.length - 1];
    if (!key || key.length > 24 || HK_MODS.includes(key)) return false;
    const seen = [];
    for (let i = 0; i < parts.length - 1; i++) {
      if (!HK_MODS.includes(parts[i]) || seen.includes(parts[i])) return false;
      seen.push(parts[i]);
    }
    return true;
  }
  // 动作分发：主进程能直接执行的就地执行；需要播放状态的（音量/seek/收藏）转发主窗
  function hkDispatch(id) {
    if (id === 'toggle' || id === 'prev' || id === 'next') { sendMedia(id); return; }
    if (id === 'playMode') {
      const order = ['order', 'repeat-one', 'shuffle'];
      config.mode = order[(order.indexOf(config.mode) + 1) % order.length];
      store.save('config.json', config);
      if (lyricWin && !lyricWin.isDestroyed()) lyricWin.webContents.send('lyricwin:mode', config.mode);
      if (win && !win.isDestroyed()) win.webContents.send('player:control', { mode: config.mode });
      return;
    }
    if (id === 'lyric') { lyricWinToggle(!config.lyricWin.enabled); return; }
    if (id === 'lyricLock') {
      config.lyricWin.locked = !config.lyricWin.locked;
      store.save('config.json', config);
      applyLyricConfig();
      return;
    }
    if (win && !win.isDestroyed()) win.webContents.send('player:control', { hk: id });
  }
  // 注册全部全局键：先 unregisterAll 再装回媒体键 + 自定义键（全局总开关关闭时只留媒体键）
  function registerAllHotkeys() {
    try { globalShortcut.unregisterAll(); } catch { /* 忽略 */ }
    for (const [acc, act] of HK_MEDIA_KEYS) {
      if (!globalShortcut.register(acc, () => sendMedia(act))) console.warn('[深空折韵] 媒体键注册失败（可能被其他应用占用）:', acc);
    }
    if (!config.hotkeys.enabled) return;
    for (const d of HK_DEFS) {
      const acc = config.hotkeys.binds[d.id].global;
      if (!acc) continue;
      if (!globalShortcut.register(acc, () => hkDispatch(d.id))) console.warn('[深空折韵] 全局快捷键注册失败（可能被占用）:', d.id, acc);
    }
  }

  function setupShortcuts() {
    registerAllHotkeys();
  }

  // ---------- 生命周期 ----------
  function flushState() {
    if (win && !win.isDestroyed()) {
      win.webContents.send('player:flush');
    }
  }

  // 唤回主窗（托盘/双击第二实例共用）：Windows 前台锁会让裸 focus() 静默失败——
  // 表现为"应用其实在后台托盘运行，双击图标窗口却不出现"。alwaysOnTop 短切换是
  // 通行绕法（把窗口钉到顶再放回，等效抢前台），moveTop 兜 z 序。
  function showMainWindow() {
    // W-12 P0 自愈：窗口已不在（僵尸态 = 进程活着但窗口/渲染进程已消失）时，原本直接 return —— 单实例锁被本进程占着，
    // 双击图标走的正是本函数，于是"永远打不开"（2026-09-24 实测：主进程 12 小时无窗口、双击新实例 exit=0 秒退）。
    // 这里沿用仓内既有重启形态（dsh-restart-app: app.relaunch() + app.exit(0)）重启自身，让用户拿到正常实例。
    if (!win || win.isDestroyed()) {
      // 延后 400ms：让"双击那次第二实例"先拿到单实例握手的应答。探针实测（_w12_probe2）：
      // 在事件里同步 app.exit(0) 会让那次第二实例一直挂着不退出（握手方先走了）；延后后它 344ms 正常退出。
      selfHealingInProgress = true; // W-13 B：自愈期间看门狗让路（否则可能在 relaunch 之前 exit(0)）
      shutLog('self-heal', 'window gone -> app.relaunch()+app.exit(0) in 400ms'); // W-13 A.5：自愈触发也记一笔
      setTimeout(() => {
        try { app.relaunch(); } catch (e) { /* 忽略 */ }
        app.exit(0);
      }, 400);
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    try { win.setAlwaysOnTop(true); win.setAlwaysOnTop(false); } catch { /* 忽略 */ }
    win.moveTop();
    win.focus();
  }

  app.on('second-instance', () => {
    showMainWindow();
  });

  // ---------- v1.4.2 本地流代理（Mineradio 同款架构：127.0.0.1 HTTP 服务器；直链只存在于主进程）----------
  // 渲染层 <audio> 拿到的是 http://127.0.0.1:<port>/stream/<token>?k=<key>；上游 403/过期时主进程拿 reResolve
  // 信息自动重新解析一次（用户无感续播）。key 为每次启动随机生成，防止本机其他程序蹭直链。
  const STREAM_TOKEN_TTL = 30 * 60 * 1000;
  let streamServer = null, streamPort = 0, streamKey = '';
  const streamTokens = new Map(); // token → { url, reResolve:{kind,source,ref,level,bvid}|null, ts }
  function makeStreamUrl(entry) {
    if (!streamServer) return ''; // 服务器未就绪（如端口全占）→ 前端回退直连直链
    const token = crypto.randomBytes(12).toString('hex');
    streamTokens.set(token, Object.assign({ ts: Date.now() }, entry));
    if (streamTokens.size > 300) streamTokens.delete(streamTokens.keys().next().value);
    return 'http://127.0.0.1:' + streamPort + '/stream/' + token + '?k=' + streamKey;
  }
  function streamContentType(url, upstreamType) {
    const ct = String(upstreamType || '');
    if (/audio|video|octet-stream/.test(ct)) return ct;
    try {
      const p = new URL(url).pathname.toLowerCase();
      if (/\.flac$/.test(p)) return 'audio/flac';
      if (/\.m4a$|\.mp4$/.test(p)) return 'audio/mp4';
      if (/\.ogg$/.test(p)) return 'audio/ogg';
      if (/\.wav$/.test(p)) return 'audio/wav';
    } catch { /* 忽略 */ }
    return 'audio/mpeg';
  }
  // ---- B-1 beatmap 缓存端点辅助（MR server.js 同名函数等价实现） ----
  const SEND_JSON_CORS = { 'access-control-allow-origin': '*', 'access-control-allow-private-network': 'true', 'content-type': 'application/json; charset=utf-8' };
  function sendStreamJson(res, data, status) {
    try { res.writeHead(status || 200, SEND_JSON_CORS); res.end(JSON.stringify(data)); } catch { /* 忽略 */ }
  }
  function readStreamJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 8 * 1024 * 1024) { reject(new Error('BEAT_CACHE_BODY_TOO_LARGE')); req.destroy(); return; } chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }
  function beatCacheRootInfo() {
    const dir = path.resolve(path.join(dataRoot(), 'beatmaps'));
    const root = path.parse(dir).root;
    const drive = root ? root.replace(/[\\\/]+$/, '').toUpperCase() : '';
    const allowed = !!root && !/^C:$/i.test(drive); // MR 同款纪律：C 盘不写节拍缓存（memory-only 降级）
    const available = allowed && fs.existsSync(root);
    return { dir, root, drive, allowed, available };
  }
  function ensureBeatMapCacheDir() {
    const info = beatCacheRootInfo();
    if (!info.allowed) { const err = new Error('BEAT_CACHE_ON_C_DRIVE_DISABLED'); err.code = 'BEAT_CACHE_ON_C_DRIVE_DISABLED'; err.info = info; throw err; }
    if (!info.available) { const err = new Error('BEAT_CACHE_DRIVE_UNAVAILABLE'); err.code = 'BEAT_CACHE_DRIVE_UNAVAILABLE'; err.info = info; throw err; }
    fs.mkdirSync(info.dir, { recursive: true });
    return info.dir;
  }
  function safeBeatMapCacheFile(key) {
    const raw = String(key || '').trim();
    if (!raw || raw.length > 240) return null;
    const hash = crypto.createHash('sha1').update(raw).digest('hex');
    const label = raw.replace(/[^a-z0-9_.-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'beatmap';
    return path.join(ensureBeatMapCacheDir(), `${label}-${hash}.json`);
  }
  function readBeatMapCacheFile(key) {
    const file = safeBeatMapCacheFile(key);
    if (!file || !fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && raw.map ? raw : null;
  }
  function writeBeatMapCacheFile(body) {
    const key = String(body && body.key || '').trim();
    const map = body && body.map;
    if (!key || !map || typeof map !== 'object') return { ok: false, error: 'INVALID_BEATMAP_CACHE_PAYLOAD' };
    const payload = {
      v: 1, key, savedAt: Date.now(),
      meta: {
        provider: String(body.provider || '').slice(0, 32),
        title: String(body.title || '').slice(0, 160),
        artist: String(body.artist || '').slice(0, 160),
        mode: String(body.mode || 'mr').slice(0, 32),
      },
      map,
    };
    const file = safeBeatMapCacheFile(payload.key);
    if (!file) return { ok: false, error: 'INVALID_BEATMAP_CACHE_KEY' };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
    return { ok: true, key: payload.key, savedAt: payload.savedAt, dir: path.dirname(file) };
  }
  async function handleStream(req, res) {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      // CORS 预检（file:// 源带 Range 头的 fetch 会先发 OPTIONS；<audio> 媒体请求不受此限）
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'range', 'access-control-allow-methods': 'GET', 'access-control-allow-private-network': 'true' }); res.end(); return; }
      // 封面代理（/api/cover 同款能力，MR 03-beat/05 封面管线需要 CORS 干净的图片才能读像素做深度分析）：
      // 主进程服务端拉取远端封面 → 带 ACAO:* 回给 renderer
      if (u.pathname === '/api/cover') {
        const coverUrl = u.searchParams.get('url') || '';
        if (!/^https?:\/\//i.test(coverUrl)) { res.writeHead(400); res.end(); return; }
        try {
          const cr = await fetch(coverUrl, { headers: { 'user-agent': 'Mozilla/5.0', 'referer': new URL(coverUrl).origin + '/' } });
          if (!cr.ok || !cr.body) { res.writeHead(502); res.end(); return; }
          const ab = await cr.arrayBuffer();
          res.writeHead(200, { 'access-control-allow-origin': '*', 'access-control-allow-private-network': 'true', 'content-type': cr.headers.get('content-type') || 'image/jpeg', 'cache-control': 'public, max-age=86400' });
          res.end(Buffer.from(ab));
        } catch { try { res.writeHead(502); res.end(); } catch { /* 忽略 */ } }
        return;
      }
      // ---------- B-1 离线节拍链：beatmap D 盘缓存端点（Ported from Mineradio server.js:709-773, 4769-4880 语义，GPL-3.0） ----------
      // MR 原文在 express 风格 server.js；DSH 等价物 = 本地流服务器。免鉴权同 /api/cover（只存按歌 key 的
      // beatmap JSON，不含账号/直链信息——MR 注释同义）。缓存目录跟随数据根（DSH 数据根本身在 D 盘即满足
      // MR 的"不写 C 盘"纪律；C 盘兜底场景照 MR 语义禁用磁盘缓存 → memory-only 降级）。
      if (u.pathname === '/api/beatmap/cache/status') {
        const info = beatCacheRootInfo();
        sendStreamJson(res, {
          enabled: info.allowed && info.available,
          dir: info.dir,
          drive: info.drive,
          reason: !info.allowed ? 'C_DRIVE_DISABLED' : (!info.available ? 'TARGET_DRIVE_UNAVAILABLE' : ''),
          mode: info.allowed && info.available ? 'disk' : 'memory-only',
        });
        return;
      }
      if (u.pathname === '/api/beatmap/cache') {
        if (req.method === 'GET') {
          const key = u.searchParams.get('key') || '';
          try {
            const entry = readBeatMapCacheFile(key);
            sendStreamJson(res, entry
              ? { ok: true, hit: true, key: entry.key || key, map: entry.map, meta: entry.meta || {}, savedAt: entry.savedAt || 0 }
              : { ok: true, hit: false, key });
          } catch (err) {
            const info = err.info || beatCacheRootInfo();
            sendStreamJson(res, { ok: false, hit: false, enabled: false, mode: 'memory-only', key, reason: err.code || err.message || 'BEAT_CACHE_READ_FAILED', dir: info.dir });
          }
          return;
        }
        if (req.method === 'POST') {
          try {
            const body = await readStreamJsonBody(req);
            sendStreamJson(res, writeBeatMapCacheFile(body));
          } catch (err) {
            const info = err.info || beatCacheRootInfo();
            sendStreamJson(res, { ok: false, enabled: false, mode: 'memory-only', reason: err.code || err.message || 'BEAT_CACHE_WRITE_FAILED', dir: info.dir });
          }
          return;
        }
        sendStreamJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
        return;
      }
      if (u.searchParams.get('k') !== streamKey) { res.writeHead(403); res.end(); return; }
      const m = u.pathname.match(/^\/stream\/([0-9a-f]{24})$/);
      const entry = m && streamTokens.get(m[1]);
      if (!entry) { res.writeHead(404); res.end('not found'); return; }
      if (Date.now() - entry.ts > STREAM_TOKEN_TTL) { streamTokens.delete(m[1]); res.writeHead(410); res.end('expired'); return; }
      const range = req.headers.range || 'bytes=0-';
      let referer = '';
      try { if (/qq\.com$/.test(new URL(entry.url).hostname)) referer = 'https://y.qq.com/'; } catch { /* 忽略 */ }
      const pull = (url) => {
        const ac = new AbortController();
        const headers = { Range: range };
        if (referer) headers.Referer = referer;
        res.on('close', () => { try { ac.abort(); } catch { /* 已结束 */ } }); // 客户端断开 → 取消上游
        return fetch(url, { headers, signal: ac.signal });
      };
      const badStatus = (up) => !up || (up.status !== 200 && up.status !== 206);
      let up = null;
      try { up = await pull(entry.url); } catch (err) { console.error('[stream] 上游请求失败 code=UPSTREAM_FETCH_FAILED ' + ((err && err.message) || err)); }
      if (badStatus(up)) {
        console.error('[stream] 上游状态异常 code=UPSTREAM_BAD_STATUS status=' + (up ? up.status : 0));
        try { if (up && up.body) up.body.cancel(); } catch { /* 忽略 */ }
        up = null;
      }
      // 上游失效 → 用 reResolve 信息重新解析一次（直链过期的无感续播）
      if (!up && entry.reResolve) {
        console.error('[stream] 直链失效，自动重新解析 code=STREAM_RERESOLVE kind=' + entry.reResolve.kind);
        let re = null;
        try {
          if (entry.reResolve.kind === 'leiz') re = await leizResolveCore(entry.reResolve.source, entry.reResolve.ref, entry.reResolve.level);
          else if (entry.reResolve.kind === 'bili') re = await biliResolveFull(entry.reResolve.bvid);
        } catch (err) { console.error('[stream] 重解析失败 code=STREAM_RERESOLVE_FAILED ' + ((err && err.message) || err)); }
        const nu = re && re.ok && re.data && (re.data.url || re.data.src);
        if (nu) {
          entry.url = nu; entry.ts = Date.now();
          try { up = await pull(nu); } catch (err) { console.error('[stream] 重拉失败 code=UPSTREAM_REPULL_FAILED ' + ((err && err.message) || err)); }
          if (badStatus(up)) up = null;
        }
      }
      if (!up) { res.writeHead(502); res.end('upstream unavailable'); return; }
      const h = { 'accept-ranges': 'bytes', 'access-control-allow-origin': '*', 'access-control-allow-private-network': 'true', 'content-type': streamContentType(entry.url, up.headers.get('content-type')) };
      for (const k of ['content-length', 'content-range']) { const v = up.headers.get(k); if (v) h[k] = v; }
      res.writeHead(up.status, h);
      const reader = up.body.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (res.destroyed) { try { await reader.cancel(); } catch { /* 忽略 */ } break; }
            if (!res.write(Buffer.from(value))) await new Promise((r2) => res.once('drain', r2));
          }
          res.end();
        } catch { try { res.destroy(); } catch { /* 忽略 */ } }
      })();
    } catch (err) {
      console.error('[stream] 处理异常 code=STREAM_HANDLER_ERROR ' + ((err && err.message) || err));
      try { res.writeHead(500); res.end(); } catch { /* 忽略 */ }
    }
  }
  function startStreamServer() {
    const tryPort = (port, left) => new Promise((resolve) => {
      if (left <= 0) return resolve(null);
      const srv = http.createServer(handleStream);
      srv.once('error', () => { try { srv.close(); } catch { /* 忽略 */ } resolve(tryPort(port + 1, left - 1)); });
      srv.listen(port, '127.0.0.1', () => resolve(srv));
    });
    return tryPort(30000, 100).then((srv) => {
      if (!srv) { console.error('[stream] 本地流服务器启动失败 code=STREAM_SERVER_NO_PORT'); return; }
      streamServer = srv; streamPort = srv.address().port;
      streamKey = crypto.randomBytes(16).toString('hex');
      srv.unref(); // 不阻止进程退出
      console.error('[stream] 本地流服务器已启动 port=' + streamPort);
    });
  }
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null); // 移除默认菜单栏（File/Edit/View/Window）
    startStreamServer(); // v1.4.2 本地流代理（失败只影响 streamUrl，前端自动回退直连直链）
    // WE 媒体协议（mineradio-wallpaper:// 壁纸封面/预览流）+ 会话权限处理器（Ported from Mineradio）
    try {
      await wallpaperEngineLibrary.installProtocol(protocol);
    } catch (error) {
      console.warn('[Wallpaper Engine] local media protocol unavailable:', error && error.message || error);
    }
    // 手势识别 MediaPipe 本地资产协议（dsh-mediapipe://assets/<file>；特权注册见本文件顶部）：
    // MR 原文手势子系统从 jsDelivr CDN 取 MediaPipe 运行时（hands.js glue 经 fetch/XHR 拉取
    // wasm/tflite/binarypb/.data，script 标签 crossorigin=anonymous 拉 *_bin.js）；DSH 页面为
    // file:，fetch/XHR/CORS 脚本均无法加载 file: 子资源（Chromium 限制），故统一改走本协议，
    // 并在响应头带 ACAO:*（crossorigin=anonymous 脚本标签需要）。
    try {
      const MEDIAPIPE_ASSETS_DIR = path.join(__dirname, 'renderer', 'mr', 'vendor', 'mediapipe');
      const MEDIAPIPE_ASSET_MIME = { '.js': 'text/javascript', '.wasm': 'application/wasm' };
      protocol.handle('dsh-mediapipe', async (request) => {
        try {
          const name = decodeURIComponent(String(new URL(request.url).pathname || '')).replace(/^\/+/, '');
          if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response('Not Found', { status: 404 }); // 只放行目录内白名单文件名（防穿越）
          const data = await fs.promises.readFile(path.join(MEDIAPIPE_ASSETS_DIR, name));
          return new Response(data, {
            headers: {
              'Content-Type': MEDIAPIPE_ASSET_MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
              'Access-Control-Allow-Origin': '*',
            },
          });
        } catch (_) {
          return new Response('Not Found', { status: 404 });
        }
      });
    } catch (error) {
      console.warn('[GestureCamera] local mediapipe protocol unavailable:', error && error.message || error);
    }
    try { configureLocalAppPermissions(); } catch (error) { console.warn('[Wallpaper Engine] permission handlers unavailable:', error && error.message || error); }
    // B 站 CDN 热链保护：<audio> 发不了自定义头，用 webRequest 统一补 Referer（音视频直链/封面必备）
    try {
      session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['*://*.bilivideo.com/*', '*://*.akamaized.net/*', '*://*.bilitv.com/*'] }, (details, callback) => {
        const h = details.requestHeaders;
        if (!h.Referer) h.Referer = 'https://www.bilibili.com/';
        callback({ requestHeaders: h });
      });
    } catch { /* 拦截失败不影响主流程（LeiZ 兜底路径不依赖） */ }
    try { session.defaultSession.setCacheSize(200 * 1024 * 1024); } catch {} // 磁盘缓存上限 200MB（防 D 盘堆到 300MB+）
    await ensureLibrary();
    // 下载目录直接纳入曲库（不等待首次下载）；首次纳入时全量刷新以索引其歌曲
    if (ensureDlDirInConfig()) await rescanLibrary();
    const imp = ensureDefaultPlaylist();
    if (imp) console.log('[深空折韵] 默认歌单导入:', imp.imported, '首，缺失:', imp.missing.length, '首');
    registerIpc();
    createWindow();
    updateThumbar(false);
    setupTray();
    setupShortcuts();
    if (config.lyricWin.enabled) lyricWinToggle(true);
    prefetchCovers(); // 后台批量获取曲库封面（慢速串行防限流）
    setupAutoUpdate(); // 自动更新：启动 6 秒后静默检查，有新版本才提示
  });

  // ---------- 自动更新（electron-updater，GitHub Release 源）----------
  // 更新公告表：版本号 → 更新内容列表（新版本首次启动展示；设置-软件更新页侧栏按历代版本浏览，须随发版同步维护）
  const CHANGELOG = {
    '1.4.2': [
      '**在线播放更稳**：修掉播放时向音源请求漏传档位的毛病——此前网易云的歌几乎每首都要先失败一次再自动换源、酷狗的「臻品」档会被静默降成无损；另外酷狗分享链接与数字歌曲编号现在也能按所选档位正确解析（数字编号此前会被判为无效请求）',
      '**音质标签改为按实际标注**：所有在线歌列表（搜索、导入歌单、推荐歌单、收藏）与底栏的音质标签，都不再按你选的档位乐观推测，改为按**真正会拿到的文件**标注（实测码率 + 容器格式）；搜索后逐首核对实际档位，核对完成前留空，拿不到实际信息就空着，不编造档位；核对过的歌会被记住，下次搜索不再重复请求',
      '**首次进 3D 舞台大幅提速**：修掉两个真 bug——歌词预热参数写错，第一首进入舞台要等 8.7 秒才构建完成（现约 0.3 秒）；暂停状态下进舞台会一直转圈（现约 1.3 秒）',
      '**桌面歌词锁定钮改版**：长条胶囊换成独立圆形钮（28px），说明文字改为鼠标悬停时才在下方浮出，锁定时不再挡住歌词',
      '**搜索音质填充大幅提速**：音质核对改为并发进行 + 连接复用（keepAlive），首次搜一批歌的徽标从约 8.6 秒缩短到约 2 秒',
      '**搜索结果按音源交错**：网易云 / 酷狗一个隔一个排，不再一整块压顶',
      '**在线歌单、每日推荐滚到哪核对到哪**：进入歌单先核对视口内与下方一屏的歌，滚动继续补齐；已保存歌单的核对结果会被长期保留，不受临时缓存上限清理',
      '**壁纸模式下任务栏不再多出图标**：修掉壁纸源窗与 DWM 宿主各占一个任务栏按钮的问题，现在只剩主窗口一个',
      '**设置项清理**：移除「启动自动播放」与「恢复模式」两个从未真正接通的开关（点了只会静默报错或不响应）。按上次进度继续播放仍由原有设置项正常提供，功能不受影响',
    ],
    '1.4.1': [
      '**臻品母带音质**：音质新增「臻品母带 Hi-Res」档（网易云超清母带 / 酷狗 Hi-Res），在线与下载均可选；「臻品」酒红金徽标一眼可辨；无母带曲目自动降级并诚实标注实际档位',
      '**推荐页焕新**：每日推荐带封面与「播放全部 / 查看全部」；猜你喜欢改为单曲电台模式（播完自动续猜、可跳过）；推荐歌单刷新即换一批；设置-用户偏好统一管理首页显示与区块',
      '**手机后台播放彻底修复**：锁屏/切后台连续播放不再中断，通知栏上一首/下一首即时生效',
      '**手机电脑双端互通**：同一 WiFi 下自动同步歌单、收藏、最近播放与账号登录态；首次配对后设备绑定，之后无感同步；已配对设备可逐台管理',
      '**游客可用每日推荐**：无需登录即享网易云每日推荐（含推荐理由），登录自动升级个性化',
      '**QQ 歌单导入**：粘贴 QQ 歌单链接即可导入，自动匹配网易云/酷狗可播版本，匹配不到的透明提示跳过数',
      '**换源更聪明**：播放失败自动跨平台找同歌续播，严格同名同歌手匹配，绝不塞错版本（Live / 翻唱等版本歌曲原样保留）',
      '**设置全面整理**：下拉选择器收纳多选项；断点续播默认永久生效；进度条样式等冗余项移除；界面更简洁',
      '**修复**：音质标签不再消失、导入歌单音质跟随设置、桌面歌词与播放同步、搜索页残留、推荐页死代码清理等十余项',
      '**界面**：手机四角圆角化、设置分类重组、歌单列表去除底部渐隐；B站主题色统一粉色'
    ],    '1.4.0': [
      '**重磅：手机电脑双端互通**——深空折韵安卓端正式发布！同一 WiFi 下，手机与电脑自动同步歌单、收藏、最近播放与账号登录态：首次配对后设备绑定，之后无需任何操作，听歌记录两端无缝衔接',
      '安卓端下载：github.com/kita18986342016/lyra-aria-mobile/releases（下载 APK 安装；开启同步入口：手机端设置 → 局域网同步，电脑端：设置-账号管理-局域网同步）',
      '**全新「猜你喜欢」**：推荐页按你常听的歌手生成 50 首混合队列，整批听完自动换新一批；尝新比例可调（默认 30%）',
      '**导入自动适配原版**：歌单导入自动识别变速 / DJ / 翻唱等版本并跨平台替换为原版，找不到原版才保留；导入结果透明提示本源缺失歌曲数',
      '**播放不中断**：无版权 / 下架歌曲自动尝试其他音源同歌续播，全部无资源则自动跳下一首，不再停在原地',
      '**音质全面升级**：酷狗支持高品 320k 与无损 FLAC（此前固定 128k）；网易云高品档修正为真 320k；播放按当前音质设置实时请求',
      '**界面优化**：设置-账号管理合并本地账号与同步入口；播放条新增收藏按钮（倍速左侧）；B站主题色统一粉色'
    ],
    '1.3.9': [
      '**B站音源**：收藏夹一键导入（粘贴链接，或登录后勾选账号内收藏夹批量导入）；大会员登录自动获得高音质（高清 192k / Hi-Res 无损）；纯音频播放秒开，封面与歌词详情齐备',
      '**账号歌单一键导入**：设置-账号管理点击「一键导入」，列出账号内歌单/收藏夹，勾选批量导入（支持网易云 / 酷狗 / B站）',
      '**账号管理改版**：网易云 / 酷狗 / B站三平台统一管理，显示账号昵称与登录权益；登录方式精简为扫码 + 短信验证码',
      '**快捷键系统**：播放控制、歌词锁定等 12 个动作支持自定义（应用内 + 全局双层，最少单个按键），可一键恢复默认',
      '**桌面歌词优化**：锁定 / 解锁歌词零位移，行距更紧凑，锁定时控制条原地消失不再跳动',
      '**修复**：重新打开登录窗二维码不显示；B站歌曲音质标注与实际不符；音源标签颜色区分度不足'
    ],    '1.3.8': [
      '**修复：QQ 音源开关可关闭**：设置-音源与音质中的 QQ 音源开关现在可以自由开关（此前固定开启）；关闭后在线搜索不再使用 QQ 音源',
      '**修复：安装包版本信息**：exe 文件属性显示正确版本号（此前为旧值）'
    ],
    '1.3.7': [
      '**全新首页推荐**：推荐歌单 + 每日推荐，网易云/酷狗一键切换',
      '**全新皮肤系统**：7 款主题皮肤（背景+面板+强调色联动），配合 12 款背景预设，一键换肤',
      '**QQ 音源**：在线搜索/播放/下载可选「QQ」来源；免费歌无损直出，其余歌曲自动提供可播放版本并如实标注音质',
      '**搜索结果更干净**：自动排除试听片段与非原版版本（Live/现场/DJ/伴奏/翻唱等），原版优先',
      '**QQ 歌单一键导入**：实时显示进度；同歌名同歌手的原版优先保留，仅标准音质版本自动尝试替换为其他平台高音质版本（可在 设置-音源 关闭）',
      '**桌面歌词卡拉OK**：逐字推进 + 5 款样式可选（极简/柔光/立体/旧影/描边）',
      '**歌词字体**：9 款可选（楷体/行书/新魏/思源黑体/MiSans 等）',
      '**本地账号**：自定义名字与头像，选完自动保存；账号菜单与账号管理页以本地账号置顶',
      '**登录更顺手**：登录弹窗重做（记住密码/明文切换/手机验证码），账号管理页卡片化',
      '**无边框窗口**：自定义标题栏（最小化/最大化/关闭），界面更沉浸',
      '**歌单信息卡整合**：封面/名字/副标题并入标题栏，工具栏右对齐更紧凑',
      '**无损音质标签升级**：香槟金渐变高亮，视觉更醒目',
      '**播放修复**：部分 FLAC 歌曲时长显示错误已修复（升级后自动重扫一次曲库）',
      '细节优化与问题修复'
    ],
    '1.3.6': [
      '全新界面：浅色/深色主题 + 6 款强调色 + 自定义背景图；侧栏全面翻新（全高布局/歌单封面/数量常显/在线胶囊）；底栏信息增强（收藏/来源/音质）；进度条两版可切',
      '搜索体验：每源条数可配（默认 30，最多 100）；「显示更多歌曲」一键追加；即时加载动画先到先显；来源筛选（全部/网易云/酷狗）',
      '歌单批量操作：勾选批量加入播放/收藏/下载/删除/添加到歌单；歌单内独立搜索；导入歌单显示原始名称与来源',
      '在线歌单：专辑墙纳入在线歌曲、列表视图修复；一键下载弹窗可选音质（默认无损）；右键菜单直接下载',
      '更新系统：右下角常驻更新卡片（下载进度/一键重启）；静默更新装回原目录；更新公告每次必弹',
      '播放体验：点单曲插入队首立即播放（不再重置队列）；最近听过 3 首；音质默认在线 320 / 下载无损',
      '性能与包体：安装包瘦身约 25%（133MB → 约 100MB）；缓存上限 200MB + 一键清理；磁盘占用优化'
    ],
    '1.3.5': [
      '酷狗收藏合集全量导入：突破上游 300 首上限（官方接口签名分页，实测 775 首歌单完整导入）',
      '专辑列显示真实专辑名（此前酷狗在线歌单显示数字专辑 ID）',
      '长标题悬停滚动：所有超长文本省略号显示，鼠标悬停横向滚动展示全名（列表/导航/队列/下载/卡片/播放器）',
      '任务栏应用名修复为「深空折韵 1.3.5」（此前显示 Electron）',
      '新增更新公告：更新后首次启动展示本次更新内容'
    ],
    '1.3.4': [
      '酷狗分享短链全量拉取（LeiZ 服务端解析）',
      '一键下载全量分批入队'
    ],
    '1.3.3': [
      '图标修复：exe 内嵌 v6 多尺寸图标（rcedit 直嵌源 exe，桌面快捷方式/任务栏恢复定制图标）',
      '更新通道切为 generic 直链（绕开 api.github.com 限流，国内收更新更稳定）'
    ],
    '1.3.2': [
      '更新失败提示增加手动下载兜底链接（GitHub Release 最新版安装包覆盖安装）'
    ],
    '1.3.1': [
      '任务栏应用名修复（AppUserModelId，安装版显示「深空折韵」而非 Electron）',
      '自动更新首次实战：已装 1.3.0 的用户启动后自动收到更新提示 → 下载 → 重启安装'
    ],
    '1.3.0': [
      '普适化改造 + 交互增强（全新 1.3 大版本）',
      '自动更新链路就绪：安装版启动静默检查，设置-软件更新可手动检查/下载/安装',
      '版本号改为运行时读取（页面不再写死）',
      '修复 artifactName 文件名不一致导致的自动更新下载失败'
    ],
    '1.2.8': [
      '设置按钮固定在右上角（详情页也能随时打开设置）',
      '默认值对齐用户用法；桌面歌词已唱/未唱双色独立可调'
    ]
  };
  function sendUpdate(type, data) {
    if (win && !win.webContents.isLoading()) {
      win.webContents.send('update:event', { type, data });
    }
  }
  function setupAutoUpdate() {
    if (!autoUpdater) return;
    autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
    let pendingVer = '';
    autoUpdater.on('update-available', (info) => {
      pendingVer = (info && info.version) || '';
      sendUpdate('available', { version: pendingVer, notes: CHANGELOG[pendingVer] || [] });
    });
    autoUpdater.on('update-not-available', () => sendUpdate('not-available'));
    autoUpdater.on('download-progress', (p) => sendUpdate('progress', { percent: Math.round((p && p.percent) || 0) }));
    autoUpdater.on('update-downloaded', () => {
      // 写「刚更新」标记：更新完成重启后公告必弹（不依赖 localStorage，绿色版/安装版数据共享也不串状态）
      try {
        if (pendingVer) fs.writeFileSync(path.join(dataRoot(), '.just-updated'), pendingVer, 'utf8');
      } catch { /* 忽略 */ }
      sendUpdate('downloaded');
    });
    autoUpdater.on('error', (err) => sendUpdate('error', { message: (err && err.message) || String(err) }));
    // 启动 6 秒后静默检查（打包版才检查；开发模式 electron-updater 会报 dev-app-update.yml 缺失，忽略即可）
    setTimeout(() => {
      if (!app.isPackaged) return;
      try { autoUpdater.checkForUpdates().catch(() => {}); } catch { /* 忽略 */ }
    }, 6000);
  }
  ipcMain.handle('app:changelog', (e) => {
    if (!isTrusted(e)) return null;
    // 更新完成标记：存在则返回版本号并清除（公告必弹）
    let justUpdated = '';
    try {
      const marker = path.join(dataRoot(), '.just-updated');
      if (fs.existsSync(marker)) {
        justUpdated = fs.readFileSync(marker, 'utf8').trim();
        fs.unlinkSync(marker);
      }
    } catch { /* 忽略 */ }
    return { current: app.getVersion(), entries: CHANGELOG, justUpdated };
  });
  // 清理运行缓存（设置-常规「清除缓存」按钮）
  ipcMain.handle('app:clearCache', async (e) => {
    if (!isTrusted(e)) return { ok: false };
    try {
      await session.defaultSession.clearCache();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || String(err) };
    }
  });
  // 自定义背景选图：弹窗选图 → 复制到数据目录 bg.jpg → 返回 dataURL（CSP img-src 支持 data:，禁 file:）
  ipcMain.handle('app:pickBgImage', async (e) => {
    if (!isTrusted(e)) return { ok: false };
    try {
      const res = await dialog.showOpenDialog({
        title: '选择背景图片',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }]
      });
      if (!res || res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
      const src = res.filePaths[0];
      const buf = fs.readFileSync(src);
      const ext = (path.extname(src) || '.jpg').toLowerCase().replace('.', '');
      const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[ext] || 'image/jpeg';
      const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
      try { fs.writeFileSync(path.join(dataRoot(), 'bg.jpg'), buf); } catch { /* 忽略 */ }
      return { ok: true, dataUrl };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('update:check', async (e) => {
    if (!isTrusted(e)) return { ok: false, reason: '拒绝' };
    if (!autoUpdater) return { ok: false, reason: '更新模块不可用' };
    if (!app.isPackaged) return { ok: false, reason: '开发模式不检查更新（安装版可用）' };
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('检查超时')), 30000));
      await Promise.race([autoUpdater.checkForUpdates(), timeout]);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('update:download', async (e) => {
    if (!isTrusted(e) || !autoUpdater || !app.isPackaged) return { ok: false, reason: '不可用' };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('update:install', (e) => {
    if (!isTrusted(e) || !autoUpdater || !app.isPackaged) return;
    shutLog('quit-request', 'update-install quitAndInstall'); // W-13 A / D 的嫌疑入口
    // W-15：与「托盘退出 :5391」「closeBehavior=exit :2299」保持同一个语义源 —— quitAndInstall 内部只调
    // app.quit()，并不会自己设 app.isQuitting；若不设，它会走到 win.on('close') 的 `!app.isQuitting` 分支，
    // closeBehavior==='tray' 时被 preventDefault()+hide() 拦下 ⇒ Electron 取消退出 ⇒ 安装器无限等待，
    // 表现为"点了更新没反应/更新永远装不上"（W-13 D 项定位）。先置位，再触发安装。
    app.isQuitting = true;
    // 静默安装（true,true）：/S --updated --force-run → 无向导、装回原目录、装完自动重启（方案C，源码已验证）
    try { autoUpdater.quitAndInstall(true, true); } catch { /* 忽略 */ }
  });
  // 性能诊断（体验版）：GPU 加速状态 + 系统/窗口信息 + 主进程 CPU 采样——远程排查用户机器高 CPU
  ipcMain.handle('diag:collect', async (e) => {
    if (!isTrusted(e)) return null;
    try {
      const gpu = (app.getGPUFeatureStatus && app.getGPUFeatureStatus()) || {};
      const mem = (process.getSystemMemoryInfo && process.getSystemMemoryInfo()) || {};
      const displays = screen.getAllDisplays().map((d) => ({ size: d.size.width + 'x' + d.size.height, scale: d.scaleFactor }));
      const cpu0 = process.cpuUsage();
      await new Promise((r) => setTimeout(r, 500));
      const cpu1 = process.cpuUsage(cpu0); // 相对差值（微秒）
      return {
        app: app.getVersion(),
        platform: process.platform + ' ' + process.arch,
        node: process.versions.node,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        memTotalMB: mem.total ? Math.round(mem.total / 1048576) : null,
        displays,
        gpu: gpu, // 原样返回（key 形如 'gpu_compositing'/'2d_canvas'，避免字段名随版本漂移）
        mainCpu500ms: cpu1,
        lyricWin: (() => { // 歌词窗存在性与可见性（播放时可见=60fps 逐字循环在跑）
          try {
            if (typeof lyricWin === 'undefined' || !lyricWin || lyricWin.isDestroyed()) return { exists: false };
            return { exists: true, visible: lyricWin.isVisible() };
          } catch { return { exists: false }; }
        })(),
        procs: (() => { // 各进程原始信息（type/cpu/memory 原样返回，BigInt 转 Number；播放时采集直接定位烧 CPU 的进程）
          try {
            return app.getAppMetrics().map((m) => {
              const o = { type: m.type, service: m.serviceName || '', pid: m.pid };
              for (const k of Object.keys(m)) {
                if (k === 'type' || k === 'serviceName' || k === 'pid') continue;
                const v = m[k];
                if (typeof v === 'bigint') { o[k] = Number(v); continue; }
                if (v && typeof v === 'object' && k === 'memory') {
                  o[k] = {};
                  for (const mk of Object.keys(v)) o[k][mk] = typeof v[mk] === 'bigint' ? Number(v[mk]) : v[mk];
                  continue;
                }
                o[k] = v;
              }
              return o;
            });
          } catch (err) { return [{ error: (err && err.message) || String(err) }]; }
        })()
      };
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    }
  });

  // 旧命名（<id>.jpg，超长路径会超 255 字符）迁移为 hash 命名
  function migrateCovers() {
    const coverDir = path.join(store.getDataDir(), 'covers');
    if (!fs.existsSync(coverDir)) return;
    for (const song of library.songs || []) {
      const oldF = path.join(coverDir, song.id + '.jpg');
      if (!fs.existsSync(oldF)) continue;
      const newF = path.join(coverDir, crypto.createHash('sha1').update(song.id).digest('hex').slice(0, 32) + '.jpg');
      try {
        if (fs.existsSync(newF)) fs.unlinkSync(oldF);
        else fs.renameSync(oldF, newF);
      } catch { /* 忽略单张 */ }
    }
  }

  // 后台批量获取封面（慢速串行 450ms/首 + 失败熔断 30s，完成后通知渲染层刷新表格）
  // 之后每 5 分钟强制重试缺封面的歌（在线接口限流通常 10-60 分钟恢复）
  function prefetchCovers() {
    setTimeout(async () => {
      migrateCovers();
      if (!library.songs || !library.songs.length) return;
      let failStreak = 0;
      for (const song of library.songs) {
        try {
          const buf = await covers.getCover(song);
          if (buf) { failStreak = 0; continue; }
          if (++failStreak >= 8) { await new Promise((r) => setTimeout(r, 30000)); failStreak = 0; }
        } catch { /* 忽略单首失败 */ }
      }
      if (win && !win.isDestroyed()) win.webContents.send('covers:done');
      // 定时重试（force 忽略失败标记）
      for (let round = 0; round < 12; round++) {
        await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
        const coverDir = path.join(store.getDataDir(), 'covers');
        let allDone = true;
        for (const song of library.songs) {
          const f = path.join(coverDir, crypto.createHash('sha1').update(song.id).digest('hex').slice(0, 32) + '.jpg');
          if (fs.existsSync(f)) continue;
          allDone = false;
          try { await covers.getCover(song, { force: true }); } catch { /* 忽略 */ }
        }
        if (win && !win.isDestroyed()) win.webContents.send('covers:done');
        if (allDone) break;
      }
    }, 12000);
  }

  app.on('window-all-closed', () => {
    // 常驻托盘，不退出
  });

  let weQuitCleanupDone = false;

  // ===== W-13 B：无窗僵尸看门狗 =====
  // 为什么会存在僵尸：`window-all-closed`（上一行区块）刻意"不退出"（托盘常驻是设计），
  // 于是一次没走完的退出会留下"进程活着、窗口已销毁"的残骸，它占着单实例锁 → 此后双击永久没反应。
  // 判据纪律（W-13 §2.3 坑二）：必须用 isDestroyed()，**不能用可见性** —— 托盘态 closeBehavior:'tray'
  // 是 win.hide()，win 存在且未销毁；若用 !win.isVisible() 会把"用户关到托盘"判成僵尸 → 灾难级回归。
  // 四个排除项：窗口从未创建（启动宽限）、退出流程中、W-12 自愈中、收尾已完成。
  let winGoneSince = 0;
  let quitStuckSince = 0; // W-13 B2：退出中持续时长（>20s 视为卡死）
  const zombieWatchdog = setInterval(() => {
    try {
      // 退出中卡死也要管：正常退出最长 15s（will-quit 兜底），超过 20s 仍未退出即判"quit 活锁/卡死"。
      // 依据：W-13 探针实测 —— 同类形态下若 will-quit 被反复 preventDefault，进程会陷入"quit→拦→再 quit"活锁永不退出
      // （exit=124）；同一形态把兜底换成 app.exit(0) 则 1s 内正常退出。故这里的硬退是唯一的终止手段。
      if (quitInFlight && !selfHealingInProgress && winHadBeenCreated) {
        if (!quitStuckSince) { quitStuckSince = Date.now(); return; }
        if (Date.now() - quitStuckSince > 20000) {
          shutLog('watchdog-fire', 'quit in flight for >20s -> app.exit(0) (quit 卡死兜底)');
          app.exit(0);
        }
        return;
      }
      if (!winHadBeenCreated || app.isQuitting || selfHealingInProgress || weQuitCleanupDone) { winGoneSince = 0; return; }
      if (win && !win.isDestroyed()) { winGoneSince = 0; return; }
      if (!winGoneSince) { winGoneSince = Date.now(); shutLog('watchdog-arm', 'window destroyed while not quitting'); return; }
      if (Date.now() - winGoneSince > 10000) {
        shutLog('watchdog-fire', 'window destroyed for >10s -> app.exit(0)');
        app.exit(0);
      }
    } catch { /* 看门狗自身绝不抛错 */ }
  }, 2000);
  try { if (zombieWatchdog && typeof zombieWatchdog.unref === 'function') zombieWatchdog.unref(); } catch { /* 忽略 */ }

  app.on('before-quit', () => {
    // W-13 A：before-quit 是所有"走 quit 的入口"都会经过的点（app.exit 不走）。
    quitInFlight = true; // W-13 B：看门狗据此跳过"退出中"（app.isQuitting 只被部分入口设置）
    shutLog('before-quit', 'isQuitting=' + !!app.isQuitting);
  });
  app.on('will-quit', (e) => {
    shutLog('will-quit', 'isQuitting=' + !!app.isQuitting + ' cleanupDone=' + weQuitCleanupDone); // W-13 A
    globalShortcut.unregisterAll();
    if (wallpaperTaskbarSupervisorTimer) { clearInterval(wallpaperTaskbarSupervisorTimer); wallpaperTaskbarSupervisorTimer = null; } // W-9：顺手收监督器
    if (tray) tray.destroy();
    // WE 收尾（Ported from Mineradio desktop/main.js:6030-6052 简化：无全桌面模式部分）：
    // 关停壁纸进程/DWM 助手后再真正退出，15s 上限防卡死退出
    if (weQuitCleanupDone) return;
    e.preventDefault();
    const cleanupTimeout = setTimeout(() => {
      // W-13 C：走到这里说明 WE 收尾已失败（超 15s），再走一次 app.quit() 没有意义 —— 硬退，不依赖 quit 握手。
      shutLog('cleanup-timeout', 'WE runtime cleanup exceeded 15000ms -> app.exit(0)'); // W-13 A：兜底是否触发（永不到达 = 卡在 dispose 里）
      console.warn('[Shutdown] WE runtime cleanup exceeded 15000ms; hard exit.');
      weQuitCleanupDone = true;
      app.exit(0);
    }, 15000);
    Promise.resolve()
      .then(() => { shutLog('dispose-start', 'fullDesktopModeRuntime'); return fullDesktopModeRuntime.dispose('app-quit'); })
      .then((r) => { shutLog('dispose-done', 'fullDesktopModeRuntime ' + JSON.stringify(r === undefined ? null : r)); }) // W-13 A：有起点无本行 = 永不 settle
      .catch((err) => { shutLog('dispose-error', 'fullDesktopModeRuntime ' + (err && err.message || err)); })
      .then(() => { shutLog('dispose-start', 'wallpaperEngineRuntime'); return wallpaperEngineRuntime.dispose(); })
      .then((result) => {
        shutLog('dispose-done', 'wallpaperEngineRuntime ok=' + (result && result.ok) + ' reason=' + ((result && result.reason) || ''));
        if (result && result.ok === false) {
          console.warn('[Wallpaper Engine] dispose incomplete:', result.reason || 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED');
        }
      })
      .catch((error) => {
        shutLog('dispose-error', 'wallpaperEngineRuntime ' + (error && error.message || error));
        console.warn('[Wallpaper Engine] dispose failed:', error && error.message || error);
      })
      .finally(() => {
        clearTimeout(cleanupTimeout);
        weQuitCleanupDone = true;
        shutLog('quit-continue', 'cleanup finished -> app.quit()'); // W-13 A
        app.quit();
      });
  });
}
