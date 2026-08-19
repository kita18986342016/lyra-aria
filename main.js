// 深空折韵 主进程（v2：单实例/IPC 校验/调和/缓存/媒体会话支持）
const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, dialog, nativeImage, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { parseFile } = require('music-metadata');
const NodeID3 = require('node-id3');
const crypto = require('crypto');
const { scanLibrary } = require('./core/scanner');
const store = require('./core/store');
const { importSonglist } = require('./core/songlist');
const lyrics = require('./core/lyrics');
const covers = require('./core/covers');

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
// 数据根（模块级引用）：main() 里 store.setDataDir() 之后即为最终数据目录（D 盘或 %APPDATA%）
function dataRoot() {
  return store.getDataDir() || app.getPath('userData');
}
// AppUserModelID：与 SMTC 会话/任务栏图标关联（Win11 媒体浮出需应用身份匹配）
app.setAppUserModelId('com.lyraaria.musicplayer');
// 启用 Chromium 系统媒体会话集成：Win11 任务栏全局媒体浮出（Edge 同款机制）依赖
// GlobalMediaControls/MediaSessionService 特性——Electron 默认可能禁用（此前 hover 无浮出的关键疑点）
try { app.commandLine.appendSwitch('enable-features', 'GlobalMediaControls,MediaSessionService'); } catch {}

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

// 单实例锁：防止双开导致双托盘/双窗口/JSON 竞态
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

// 旧版本数据在 D:\MusicPlayerData：当最终数据根不是 D 盘（D 盘不可用）且目标无数据时，
// 一次性迁移过去。幂等：目标已有数据或已迁移过则跳过；迁移后旧目录保留（安全，不删源）。
function migrateLegacyData() {
  const dest = store.getDataDir();
  if (!dest || dest === 'D:\\MusicPlayerData') return; // D 盘即目标：旧数据原位可用，无需迁移
  const OLD = 'D:\\MusicPlayerData';
  try {
    if (!fs.existsSync(OLD)) return;
    if (fs.existsSync(path.join(dest, 'config.json')) || fs.existsSync(path.join(dest, '.migrated'))) return;
    for (const entry of fs.readdirSync(OLD)) {
      if (entry === 'userdata' || entry === '_thumb.log') continue; // Electron 运行时数据/调试日志不迁移
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
  store.setDataDir(DATA_ROOT || app.getPath('userData'));
  migrateLegacyData(); // D 盘不可用且旧数据残留时兜底迁移

  // 默认不预置任何曲库目录：首次启动由用户自行添加自己的音乐文件夹（曲库为空时界面有引导）
  const DEFAULT_DIRS = [];
  // 酷狗歌单映射文件：位于数据根（别人放一份同名文件也能用；不存在则跳过）
  const SONGLIST_FILE = path.join(dataRoot(), 'songlist.json');
  const LYRIC_DEFAULTS = { enabled: false, mode: 'desktop', fontSize: 26, color: '#bcfb89', color2: '#4deaff', bgOpacity: 0.55, locked: false, pos: null, lockedSize: { width: 840, height: 160 } };

  let win = null;
  let tray = null;
  let library = store.load('library.json', { songs: [], scannedAt: 0 });
  let config = store.load('config.json', { dirs: DEFAULT_DIRS, volume: 0.8, mode: 'order', lyricWin: LYRIC_DEFAULTS, bgBlur: 0, autoLaunch: false, closeBehavior: 'tray', downloadOverwrite: false });
  config.autoLaunch = app.getLoginItemSettings().openAtLogin; // 开机自启实际状态
  config.lyricWin = { ...LYRIC_DEFAULTS, ...(config.lyricWin || {}) };
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
      backgroundColor: '#f3f5f9',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.webContents.setBackgroundThrottling(false); // 最小化/后台时保持渲染：任务栏缩略图实时更新
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.on('close', (e) => {
      if (!app.isQuitting) {
        if (config.closeBehavior === 'exit') { app.isQuitting = true; app.quit(); return; }
        e.preventDefault();
        win.hide(); // 关闭 → 后台托盘运行（任务栏按钮消失，托盘图标恢复窗口）
      }
    });
    // ---- 缩略图封面原生注入：任何状态下任务栏缩略图 = 歌曲封面（酷狗式）----
    // 关键：DWMWA_FORCE_ICONIC_REPRESENTATION = 7（此前误用 6=DWMWA_NONCLIENT_RTL_LAYOUT，
    // 强制图标化从未生效 → 前台 hover 一直是窗口内容 live preview——这正是"任何情况下都是封面"没实现的根因）
    // FORCE_ICONIC + HAS_ICONIC_BITMAP 始终开启 → DWM 任何状态（前台/后台/最小化）hover 任务栏都发 0x0323 → 注入封面
    if (iconicThumb) {
      const hwndBig = win.getNativeWindowHandle().readBigUInt64LE(0);
      const pTrue = iconicThumb.koffi.alloc('int', 1);
      iconicThumb.DwmSetWindowAttribute(hwndBig, 10, pTrue, 4); // DWMWA_HAS_ICONIC_BITMAP（声明支持图标化缩略图）
      const hrForce = iconicThumb.DwmSetWindowAttribute(hwndBig, 7, pTrue, 4);  // DWMWA_FORCE_ICONIC_REPRESENTATION（强制 iconic 表示 → 前台 hover 也走 0x0323）
      try { fs.appendFileSync('D:\MusicPlayerData\\_thumb.log', `[${new Date().toLocaleTimeString()}] 设置 FORCE_ICONIC(7) hr=0x${(Number(hrForce) >>> 0).toString(16)}\n`); } catch {}
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
  let lyricNearBtn = false; // 锁定状态下鼠标是否在解锁按钮附近（仅此小范围解除穿透，其余区域保持穿透）

  // 从任务栏/任务视图/Alt+Tab 彻底隐藏歌词窗：Electron 43 的 skipTaskbar 在此组合下
  // 只移除 WS_EX_APPWINDOW、不添加 WS_EX_TOOLWINDOW → 任务视图/Win+Tab 仍会列出歌词页。
  // 用 koffi 直接补 WS_EX_TOOLWINDOW（工具窗口在所有切换器里都不出现）。
  let taskbarHider = null;
  try {
    const koffiT = require('koffi');
    const user32T = koffiT.load('user32.dll');
    const getEx = user32T.func('GetWindowLongPtrW', 'intptr_t', ['intptr_t', 'int']);
    const setEx = user32T.func('SetWindowLongPtrW', 'intptr_t', ['intptr_t', 'int', 'intptr_t']);
    taskbarHider = { getEx, setEx };
  } catch { taskbarHider = null; }
  function hideLyricFromTaskbar() {
    if (!taskbarHider || !lyricWin || lyricWin.isDestroyed()) return;
    try {
      const buf = lyricWin.getNativeWindowHandle();
      const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readInt32LE(0));
      const GWL_EXSTYLE = -20, TOOL = 0x80n, APP = 0x40000n;
      const ex = BigInt(taskbarHider.getEx(hwnd, GWL_EXSTYLE));
      const want = BigInt.asIntN(64, (ex | TOOL) & ~APP);
      if (want !== ex) taskbarHider.setEx(hwnd, GWL_EXSTYLE, want);
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
    // floating 层级：实测 screen-saver 层级会导致窗口被标记 WS_EX_APPWINDOW（任务栏出现歌词页）
    // 防主窗口覆盖改由 hover 轮询里的 moveTop() 兜底
    lyricWin.setAlwaysOnTop(true, 'floating');
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
        if (s[0] !== 840 || s[1] !== 160) lyricWin.setSize(840, 160);
        clearTimeout(moveTimer);
        moveTimer = setTimeout(saveLyricPos, 400);
      }
    });
    // 拖动位置记忆（仅桌面模式）+ 拖动结束后夹回屏幕内
    // （拖动中不干预，避免边缘抖动/抽搐；松手 350ms 后若出屏则弹回，否则保存位置）
    let moveTimer = null;
    lyricWin.on('move', () => {
      if (config.lyricWin.mode !== 'desktop') return;
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (!lyricWin || lyricWin.isDestroyed()) return;
        const b = lyricWin.getBounds();
        const clamped = clampLyricWinBounds(b);
        if (clamped.x !== b.x || clamped.y !== b.y) {
          lyricWin.setPosition(clamped.x, clamped.y); // 出屏 → 弹回
        } else {
          saveLyricPos();
        }
      }, 350);
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
    // 锁定=穿透；但悬停时临时恢复交互（右键可调）
    // 注意：不调用 setFocusable（实测会导致窗口出现 WS_EX_APPWINDOW → 任务栏出现歌词页）
    lyricWin.setIgnoreMouseEvents(lc.locked && !lyricHover, { forward: true });
    lyricWin.webContents.send('lyricwin:config', { ...lc, playMode: config.mode });
    hideLyricFromTaskbar(); // 每次配置应用后确保 TOOLWINDOW（防止穿透/显示切换覆盖）
  }

  function lyricWinToggle(on) {
    config.lyricWin.enabled = !!on;
    store.save('config.json', config);
    if (on) { lyricWinCreate(); applyLyricConfig(); }
    else if (lyricWin) { lyricWin.destroy(); lyricWin = null; }
  }

  // ---------- 曲库 ----------
  async function rescanLibrary() {
    const progress = (done, total, dir) => {
      if (win && !win.webContents.isLoading()) {
        win.webContents.send('scan:progress', { done, total, dir });
      }
    };
    library = { songs: await scanLibrary(config.dirs, progress), scannedAt: Date.now() };
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
    if (!library.songs || library.songs.length === 0) await rescanLibrary();
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

  // 首次启动：若无歌单则导入 songlist.json（过滤本地缺失）
  function ensureDefaultPlaylist() {
    const pls = store.load('playlists.json', []);
    if (pls.length === 0 && library.songs.length > 0) {
      const imp = importSonglist(SONGLIST_FILE, library.songs);
      if (imp.ok) {
        store.save('playlists.json', [{ id: 'default', name: '酷狗歌单', songIds: imp.matched, system: true }]);
        return { imported: imp.matched.length, missing: imp.missing };
      }
    }
    return null;
  }

  // ---------- IPC 校验 ----------
  function isTrusted(e) {
    return (win && e.sender === win.webContents) || (lyricWin && e.sender === lyricWin.webContents);
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
      // 返回 { url, ext }；网易云 higher / 酷狗 128，保证 mp3
      const qs = song.source === 'kugou'
        ? '/kugou?hash=' + encodeURIComponent(song.ref)
        : '/netease?id=' + encodeURIComponent(song.ref) + '&level=higher';
      const r = await leizGet(qs);
      const d = r && r.data ? r.data : null;
      const url = d && (d.url || d.src) ? (d.url || d.src) : null;
      if (!url) throw new Error('无法解析播放地址（' + (r && r.message ? r.message : '未知错误') + '）');
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
    async function dlSaveLyrics(task) {
      try {
        const r = await leizGet('/' + task.song.source + '?type=lyrics&' + (task.song.source === 'kugou' ? 'hash=' : 'id=') + encodeURIComponent(task.song.ref));
        const ly = r && r.data && r.data.lyrics ? r.data.lyrics : null;
        const text = lrcForSave(ly && ly.original);
        if (text) {
          fs.writeFileSync(path.join(task.dir, task.base + '.lrc'), text, 'utf8');
          return true;
        }
      } catch { /* 歌词失败不影响主文件 */ }
      return false;
    }
    // 严格同名判定：歌名+歌手+时长完全一致才视为同一首歌（时长容差 ±3s，编码/头尾静音差异）
    // 任一字段缺失（无标签/无时长信息）都判为不同 → 不覆盖，走加序号保留两份（严格语义）
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
        const fDur = meta.format && meta.format.duration;
        const wDur = Number(song.duration) || 0;
        if (!(fDur > 0) || !(wDur > 0)) return false; // 时长缺失 → 不覆盖
        return Math.abs(fDur - wDur) <= 3;
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
        // 覆盖模式：仅当已有文件是同一首歌（歌名+歌手+时长完全一致）才替换（用于更正错误版本）；
        // 同名但不是同一首（或读不到元数据）→ 自动加序号保留两份
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
    ipcMain.handle('dl:start', (e, song) => {
      if (!isTrusted(e) || !song || typeof song !== 'object') return { ok: false, reason: '参数错误' };
      if (!['netease', 'kugou'].includes(song.source) || !song.ref || !song.title) return { ok: false, reason: '歌曲信息不完整' };
      const taskId = dlEnqueue(song);
      return { ok: true, taskId, dir: dlDir() };
    });
    ipcMain.handle('dl:batch', (e, songs) => {
      if (!isTrusted(e) || !Array.isArray(songs)) return { ok: false, reason: '参数错误' };
      const ids = [];
      for (const s of songs.slice(0, 50)) {
        if (s && ['netease', 'kugou'].includes(s.source) && s.ref && s.title) ids.push(dlEnqueue(s));
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
          if (pl.songIds.length >= 500) break; // 歌单上限 500 首
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
      store.save('online-playlists.json', pls.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.songs)));
      return pls;
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

    ipcMain.handle('favorites:get', (e) => {
      if (!isTrusted(e)) return [];
      return store.load('favorites.json', []);
    });
    ipcMain.handle('favorites:toggle', (e, id, song) => {
      if (!isTrusted(e) || typeof id !== 'string' || id.length > 1024) return store.load('favorites.json', []);
      let favs = store.load('favorites.json', []);
      const same = (f) => (typeof f === 'string' ? f : f && f.id) === id;
      if (favs.some(same)) {
        favs = favs.filter((f) => !same(f));
      } else if (song && typeof song === 'object' && song.online && typeof song.id === 'string') {
        // 在线歌曲收藏：存完整歌曲对象（含 source/ref，重启后可恢复播放）
        favs.push({ id: song.id, online: true, source: song.source, ref: song.ref, title: song.title, artist: song.artist || '', album: song.album || '', duration: song.duration || 0, picUrl: song.picUrl || '' });
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
      store.save('history.json', hist.slice(0, 100)); // 最近播放上限 100
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
      if (typeof patch.locked === 'boolean') lc.locked = patch.locked;
      if (typeof patch.stroke === 'boolean') lc.stroke = patch.stroke;
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

    // ---------- LeiZ 在线音乐服务（网易云/酷狗爬歌，key 只存主进程）----------
    // 文档站 https://api.bileizhen.top/apis（SPA）；鉴权 ?key= 或 x-api-key；CORS 全开但仍走主进程
    // 网易云: search?q= / ?id=&level= / ?type=lyrics&id= / ?type=playlist&id|url=
    // 酷狗:   search?q= / ?url= / ?type=lyrics&url= / ?type=playlist&url=
    const LEIZ_BASE = 'https://api.bileizhen.top/api';
    const LEIZ_KEY = 'lz_b4dd85599fe9c71b3e7ae241dae2cb2ac767b5954aa18b14';
    const https = require('https');
    function leizGet(pathWithQuery) {
      return new Promise((resolve) => {
        const sep = pathWithQuery.includes('?') ? '&' : '?';
        const url = LEIZ_BASE + pathWithQuery + sep + 'key=' + encodeURIComponent(LEIZ_KEY);
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 MusicPlayer/1.2.9' } }, (res) => {
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
        req.setTimeout(20000, () => { req.destroy(); resolve({ ok: false, status: 0, message: '请求超时' }); });
      });
    }
    ipcMain.handle('leiz:search', async (e, source, query) => {
      if (!isTrusted(e) || !['netease', 'kugou'].includes(source) || typeof query !== 'string' || !query.trim()) return { ok: false, reason: '参数错误' };
      const r = await leizGet('/' + source + '/search?q=' + encodeURIComponent(query.trim()));
      return r.ok ? { ok: true, data: r.data } : { ok: false, reason: r.message || ('HTTP ' + r.status) };
    });
    // ref: 网易云=song id；酷狗=分享链接或 hash（url/hash/id 三选一，推荐 url）
    ipcMain.handle('leiz:resolve', async (e, source, ref, level) => {
      if (!isTrusted(e) || !['netease', 'kugou'].includes(source) || typeof ref !== 'string' || !ref) return { ok: false, reason: '参数错误' };
      const lv = typeof level === 'string' && level ? level : 'lossless';
      let p;
      if (source === 'netease') {
        p = '/netease?id=' + encodeURIComponent(ref) + '&level=' + encodeURIComponent(lv);
      } else {
        p = /^https?:\/\//.test(ref) ? '/kugou?url=' + encodeURIComponent(ref) : '/kugou?hash=' + encodeURIComponent(ref);
      }
      const r = await leizGet(p);
      return r.ok ? { ok: true, data: r.data } : { ok: false, reason: r.message || ('HTTP ' + r.status) };
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
      return r.ok ? { ok: true, data: r.data } : { ok: false, reason: r.message || ('HTTP ' + r.status) };
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
      return r.ok ? { ok: true, data: r.data } : { ok: false, reason: r.message || ('HTTP ' + r.status) };
    });
    // 酷狗分享链接解析：t1.kugou.com 短链（收藏歌单/单曲分享）没有标准歌单 ID。
    // 方案升级：先跟随重定向拿最终分享页 URL → 优先走 LeiZ 歌单接口（可返回全量，
    // 实测收藏合集分享页只内嵌 100 首，LeiZ 解析完整 zlist.html URL 返回 trackCount 全量 201 首）；
    // LeiZ 失败才兜底抓分享页 dataFromSmarty（最多 100 首）。
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

        // 2) 优先 LeiZ 全量歌单接口（服务端解析完整分享 URL）
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
              album: s.album || s.album_id || '', picUrl: s.picUrl || '',
              level: '128'
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
    function kugouFetchJson(url) {
      return new Promise((resolve) => {
        const mod = /^https:/.test(url) ? https : http;
        const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Referer': 'https://www.kugou.com/' } }, (r) => {
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
      if (!config.lyricWin.locked) return;
      try {
        const pt = screen.getCursorScreenPoint();
        // 实测：本机 getCursorScreenPoint 与 getBounds 同坐标系（数值一致），无需缩放换算
        const b = lyricWin.getBounds();
        const inside = pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
        // 解锁热点：仅解锁按钮本体附近极小范围解除穿透（视口坐标，按钮 ~(407,20,26,26)）
        const vx = pt.x - b.x, vy = pt.y - b.y;
        const nearBtn = inside && vx >= 392 && vx <= 448 && vy >= 8 && vy <= 58;
        if (inside !== lyricHover) {
          lyricHover = inside;
          if (inside) lyricWin.moveTop(); // 持续置顶：防主窗口盖住歌词窗
          lyricWin.webContents.send('lyricwin:hoverui', inside);
        }
        if (nearBtn !== lyricNearBtn) {
          lyricNearBtn = nearBtn;
          if (nearBtn) {
            lyricWin.moveTop();
            lyricWin.setIgnoreMouseEvents(false); // 按钮附近：可点击解锁
          } else {
            lyricWin.setIgnoreMouseEvents(true, { forward: true }); // 其余区域：保持穿透
          }
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
      { label: '显示主窗口', click: () => win.show() },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; flushState(); app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => win.show());
  }

  function setupShortcuts() {
    const regs = [
      ['MediaPlayPause', () => sendMedia('toggle')],
      ['MediaNextTrack', () => sendMedia('next')],
      ['MediaPreviousTrack', () => sendMedia('prev')]
    ];
    for (const [acc, cb] of regs) {
      if (!globalShortcut.register(acc, cb)) {
        console.warn('[深空折韵] 媒体键注册失败（可能被其他应用占用）:', acc);
      }
    }
  }

  // ---------- 生命周期 ----------
  function flushState() {
    if (win && !win.isDestroyed()) {
      win.webContents.send('player:flush');
    }
  }

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null); // 移除默认菜单栏（File/Edit/View/Window）
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
  function sendUpdate(type, data) {
    if (win && !win.webContents.isLoading()) {
      win.webContents.send('update:event', { type, data });
    }
  }
  function setupAutoUpdate() {
    if (!autoUpdater) return;
    autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
    autoUpdater.on('update-available', (info) => sendUpdate('available', { version: (info && info.version) || '' }));
    autoUpdater.on('update-not-available', () => sendUpdate('not-available'));
    autoUpdater.on('download-progress', (p) => sendUpdate('progress', { percent: Math.round((p && p.percent) || 0) }));
    autoUpdater.on('update-downloaded', () => sendUpdate('downloaded'));
    autoUpdater.on('error', (err) => sendUpdate('error', { message: (err && err.message) || String(err) }));
    // 启动 6 秒后静默检查（打包版才检查；开发模式 electron-updater 会报 dev-app-update.yml 缺失，忽略即可）
    setTimeout(() => {
      if (!app.isPackaged) return;
      try { autoUpdater.checkForUpdates().catch(() => {}); } catch { /* 忽略 */ }
    }, 6000);
  }
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
    try { autoUpdater.quitAndInstall(); } catch { /* 忽略 */ }
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

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (tray) tray.destroy();
  });
}
