// 预加载：通过 contextBridge 暴露安全 API（v2）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 曲库
  getLibrary: () => ipcRenderer.invoke('library:get'),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  addDir: () => ipcRenderer.invoke('library:addDir'),
  removeDir: (dir) => ipcRenderer.invoke('library:removeDir', dir),
  setDirOrder: (arr) => ipcRenderer.invoke('library:setDirOrder', arr),
  deleteSong: (id) => ipcRenderer.invoke('song:delete', id),
  ensureDlDir: () => ipcRenderer.invoke('library:ensureDlDir'),
  onScanProgress: (cb) => ipcRenderer.on('scan:progress', (_e, p) => cb(p)),

  // 歌曲
  getCover: (id) => ipcRenderer.invoke('song:cover', id),
  getLyrics: (id) => ipcRenderer.invoke('song:lyrics', id),
  fetchLyrics: (id) => ipcRenderer.invoke('lyrics:fetch', id),
  fillAllLyrics: () => ipcRenderer.invoke('lyrics:fillAll'),
  onLyricsProgress: (cb) => ipcRenderer.on('lyrics:progress', (_e, p) => cb(p)),
  toFileUrl: (p) => ipcRenderer.invoke('util:fileUrl', p),
  revealSong: (id) => ipcRenderer.invoke('song:reveal', id),
  openPath: (p) => ipcRenderer.invoke('util:openPath', p),
  readTag: (id) => ipcRenderer.invoke('tag:read', id),
  writeTag: (id, patch) => ipcRenderer.invoke('tag:write', id, patch),
  findDupes: () => ipcRenderer.invoke('lib:findDupes'),
  removeSongs: (ids) => ipcRenderer.invoke('lib:removeSongs', ids),
  dlDir: (dir) => ipcRenderer.invoke('dl:dir', dir),
  pickDlDir: () => ipcRenderer.invoke('dl:pickDir'),
  dlOverwrite: (v) => ipcRenderer.invoke('dl:overwrite', v),
  autoSrcUpgrade: (v) => ipcRenderer.invoke('autoSrcUpgrade', v),
  dlStart: (song, level) => ipcRenderer.invoke('dl:start', song, level),
  dlBatch: (songs, level) => ipcRenderer.invoke('dl:batch', songs, level),
  dlCancel: (taskId) => ipcRenderer.invoke('dl:cancel', taskId),
  dlList: () => ipcRenderer.invoke('dl:list'),
  onDlProgress: (cb) => ipcRenderer.on('dl:progress', (_e, p) => cb(p)),
  leizShare: (url) => ipcRenderer.invoke('leiz:share', url),

  // 歌单 / 收藏 / 历史
  getPlaylists: () => ipcRenderer.invoke('playlists:get'),
  savePlaylists: (pls) => ipcRenderer.invoke('playlists:save', pls),
  addSongsToPlaylist: (plId, songIds) => ipcRenderer.invoke('playlists:addSongs', plId, songIds),
  getOpls: () => ipcRenderer.invoke('opl:get'),
  getRecPls: () => ipcRenderer.invoke('recPls:get'),
  recordRecPl: (item) => ipcRenderer.invoke('recPls:record', item),
  saveOpls: (pls) => ipcRenderer.invoke('opl:save', pls),
  getPlOrder: () => ipcRenderer.invoke('plOrder:get'),
  savePlOrder: (arr) => ipcRenderer.invoke('plOrder:save', arr),
  kugouCover: (song) => ipcRenderer.invoke('kugou:cover', song),
  fetchCoverDataUrl: (url) => ipcRenderer.invoke('app:fetchCoverDataUrl', url),
  coverGetOrFetch: (url) => ipcRenderer.invoke('cover:getOrFetch', url),
  getFavorites: () => ipcRenderer.invoke('favorites:get'),
  toggleFavorite: (id, song) => ipcRenderer.invoke('favorites:toggle', id, song),
  getHistory: () => ipcRenderer.invoke('history:get'),
  addHistory: (id) => ipcRenderer.invoke('history:add', id),

  // 播放状态 / 配置
  getState: () => ipcRenderer.invoke('player:getState'),
  saveState: (st) => ipcRenderer.invoke('player:saveState', st),
  onFlush: (cb) => ipcRenderer.on('player:flush', () => cb()),
  getConfig: () => ipcRenderer.invoke('config:get'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  appChangelog: () => ipcRenderer.invoke('app:changelog'),
  clearCache: () => ipcRenderer.invoke('app:clearCache'),
  pickBgImage: () => ipcRenderer.invoke('app:pickBgImage'),

  // 本地账号（名字+头像；数据可导出，为 1.3.8 云端账号铺路）
  localAccGet: () => ipcRenderer.invoke('local-acc:get'),
  localAccSave: (name, avatar) => ipcRenderer.invoke('local-acc:save', name, avatar),
  localAccPickAvatar: () => ipcRenderer.invoke('local-acc:pick-avatar'),
  localAccExport: () => ipcRenderer.invoke('local-acc:export'),

  // 自动更新（electron-updater）
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateEvent: (cb) => ipcRenderer.on('update:event', (_e, d) => cb(d)),
  setVolume: (v) => ipcRenderer.invoke('config:setVolume', v),
  setBgBlur: (v) => ipcRenderer.invoke('config:setBgBlur', v),
  setAutoLaunch: (flag) => ipcRenderer.invoke('config:setAutoLaunch', flag),
  setMode: (m) => ipcRenderer.invoke('config:setMode', m),
  setPin: (flag) => ipcRenderer.invoke('config:setPin', flag),
  setCloseBehavior: (v) => ipcRenderer.invoke('config:setCloseBehavior', v),

  // 歌词悬浮窗
  getLyricWin: () => ipcRenderer.invoke('lyricwin:get'),
  setLyricWin: (patch) => ipcRenderer.invoke('lyricwin:set', patch),
  setLyricWinHeight: (h) => ipcRenderer.send('lyricwin:resize', h),

  // 快捷键（应用内 + 全局双层，可自定义）
  getHotkeys: () => ipcRenderer.invoke('hotkeys:get'),
  setHotkey: (patch) => ipcRenderer.invoke('hotkeys:set', patch),
  hotkeyRun: (id) => ipcRenderer.invoke('hotkey:run', id),

  // B 站收藏夹导入 + 播放解析
  biliFavlist: (ref) => ipcRenderer.invoke('bili:favlist', ref),
  biliResolve: (bvid) => ipcRenderer.invoke('bili:resolve', bvid),
  biliLoginStart: () => ipcRenderer.invoke('bili:loginStart'),
  getBiliAccount: () => ipcRenderer.invoke('bili:account'),
  biliLogout: () => ipcRenderer.invoke('bili:logout'),
  onBiliLoginStatus: (cb) => ipcRenderer.on('bili:loginStatus', (_e, s) => cb(s)),
  biliWarm: (bvid) => ipcRenderer.send('bili:warm', bvid),
  biliSmsSend: (phone) => ipcRenderer.invoke('bili:sms-send', phone),
  biliSmsLogin: (phone, code) => ipcRenderer.invoke('bili:sms-login', phone, code),
  biliMyfav: () => ipcRenderer.invoke('bili:myfav'),
  recGuess: (seeds, ratio) => ipcRenderer.invoke('rec:guess', seeds, ratio),
  importAdapt: (songs) => ipcRenderer.invoke('import:adapt', songs),
  sendLyricLine: (payload) => ipcRenderer.send('lyricwin:line', payload),
  sendLyricPlayState: (st) => ipcRenderer.send('lyricwin:play', st),
  sendLyricLrc: (data) => ipcRenderer.send('lyricwin:lrc', data),

  // LeiZ 在线音乐（网易云/酷狗）
  leizSearch: (source, q, limit) => ipcRenderer.invoke('leiz:search', source, q, limit),
  leizResolve: (source, ref, level) => ipcRenderer.invoke('leiz:resolve', source, ref, level),
  leizLyrics: (source, ref, level) => ipcRenderer.invoke('leiz:lyrics', source, ref, level),
  // QQ 音乐官方接口（2026-08 起弃用第三方 API；登录态 Cookie 只存主进程，渲染层只拿状态摘要）
  qqStatus: () => ipcRenderer.invoke('qq:status'),
  qqSetCookie: (cookie) => ipcRenderer.invoke('qq:setCookie', cookie),
  qqSearch: (query, limit) => ipcRenderer.invoke('qq:search', query, limit),
  qqLyrics: (songmid) => ipcRenderer.invoke('qq:lyrics', songmid),
  qqResolve: (songmid) => ipcRenderer.invoke('qq:resolve', songmid),
  qqPlaylist: (disstid) => ipcRenderer.invoke('qq:playlist', disstid),
  // QQ 歌单导入进度（主进程逐批推送 done/total）；返回取消订阅函数
  onQqPlaylistProgress: (cb) => {
    const h = (_e, d) => { try { cb && cb(d); } catch { /* 忽略 */ } };
    ipcRenderer.on('qq-playlist-progress', h);
    return () => ipcRenderer.removeListener('qq-playlist-progress', h);
  },
  // 波点音乐（酷我曲库）官方音源：搜索/播放/歌词全走酷我官方接口
  bdStatus: () => ipcRenderer.invoke('bd:status'),
  bdSearch: (query, limit) => ipcRenderer.invoke('bd:search', query, limit),
  bdResolve: (musicId, title, artist) => ipcRenderer.invoke('bd:resolve', musicId, title, artist),
  bdLyrics: (musicId, title, artist) => ipcRenderer.invoke('bd:lyrics', musicId, title, artist),
  bdPlaylists: () => ipcRenderer.invoke('bd:playlists'),
  bdPlaylistMusic: (pid) => ipcRenderer.invoke('bd:playlistMusic', pid),
  qqResolveLink: (url) => ipcRenderer.invoke('qq:resolveLink', url),
  accMyPlaylists: (platform) => ipcRenderer.invoke('acc:my-playlists', platform),
  netCaptchaSend: (phone) => ipcRenderer.invoke('acc:net-captcha-send', phone),
  netCaptchaLogin: (phone, captcha) => ipcRenderer.invoke('acc:net-captcha-login', phone, captcha),
  kgCaptchaSend: (phone) => ipcRenderer.invoke('acc:kg-captcha-send', phone),
  kgCaptchaLogin: (phone, captcha) => ipcRenderer.invoke('acc:kg-captcha-login', phone, captcha),
  winMin: () => ipcRenderer.send('win:min'),
  winMaxToggle: () => ipcRenderer.send('win:max-toggle'),
  winClose: () => ipcRenderer.send('win:close'),
  onWinMaxChange: (cb) => ipcRenderer.on('win:max-changed', (_e, v) => cb && cb(v)),
  // 账号登录 + 推荐（网易云/酷狗官方接口；凭据只存主进程，渲染层仅拿登录态摘要）
  accStatus: () => ipcRenderer.invoke('acc:status'),
  accLogout: (platform) => ipcRenderer.invoke('acc:logout', platform),
  accQr: (platform) => ipcRenderer.invoke(platform === 'kugou' ? 'acc:kg-qr' : 'acc:net-qr'),
  accPoll: (platform, key) => ipcRenderer.invoke(platform === 'kugou' ? 'acc:kg-poll' : 'acc:net-poll', key),
  accRecommend: (platform) => ipcRenderer.invoke('acc:recommend', platform),
  accPlaylist: (source, ref) => ipcRenderer.invoke('acc:playlist', source, ref),
  accQrImg: (text) => ipcRenderer.invoke('acc:qr-img', text),
  // 性能诊断（体验版）
  diagCollect: () => ipcRenderer.invoke('diag:collect'),
  leizPlaylist: (source, ref) => ipcRenderer.invoke('leiz:playlist', source, ref),
  sendThumbState: (playing) => ipcRenderer.send('thumb:state', playing),
  sendTitle: (title) => ipcRenderer.send('media:title', title),
  onThumbView: (cb) => ipcRenderer.on('thumb:view', (_e, show) => cb(show)),
  thumbViewed: () => ipcRenderer.send('thumb:viewed'),
  sendThumbDIB: (buf, w, h) => ipcRenderer.send('thumb:dib', { buf, w, h }),
  smtcUpdate: (info) => ipcRenderer.send('smtc:update', info),
  onSmtcControl: (cb) => ipcRenderer.on('smtc:control', (_e, action) => cb(action)),
  onCoversDone: (cb) => ipcRenderer.on('covers:done', () => cb()),
  onLyricWinConfig: (cb) => ipcRenderer.on('lyricwin:config', (_e, c) => cb(c)),
  onLyricWinLine: (cb) => ipcRenderer.on('lyricwin:line', (_e, p) => cb(p)),
  onLyricWinLrc: (cb) => ipcRenderer.on('lyricwin:lrc', (_e, d) => cb(d)),
  onLyricPlayState: (cb) => ipcRenderer.on('lyricwin:play', (_e, s) => cb(s)),
  lyricWinHover: (on) => ipcRenderer.send('lyricwin:hover', on),
  onLyricWinHoverUI: (cb) => ipcRenderer.on('lyricwin:hoverui', (_e, on) => cb(on)),
  lyricWinControl: (action) => ipcRenderer.send('lyricwin:control', action),
  lyricWinDrag: (dx, dy) => ipcRenderer.send('lyricwin:drag', dx, dy),
  onLyricWinMode: (cb) => ipcRenderer.on('lyricwin:mode', (_e, m) => cb(m)),
  onPlayerControl: (cb) => ipcRenderer.on('player:control', (_e, action) => cb(action)),

  // 托盘 / 全局快捷键
  onMedia: (cb) => ipcRenderer.on('media:action', (_e, action) => cb(action)),

  // 局域网同步
  syncInfo: () => ipcRenderer.invoke('sync:info'),
  syncSetEnabled: (on) => ipcRenderer.invoke('sync:setEnabled', on),
  syncRegenCode: () => ipcRenderer.invoke('sync:regenCode'),
  syncTomb: (key) => ipcRenderer.invoke('sync:tomb', key),
  syncRevoke: () => ipcRenderer.invoke('sync:revoke'),
  syncRevokeOne: (id) => ipcRenderer.invoke('sync:revokeOne', id),
  syncRepairFirewall: () => ipcRenderer.invoke('sync:repairFirewall'),
  onSyncEvent: (cb) => ipcRenderer.on('sync:event', (_e, d) => cb(d)),

  // 本地多账号
  accountsList: () => ipcRenderer.invoke('accounts:list'),
  accountsSwitch: (id) => ipcRenderer.invoke('accounts:switch', id),
  accountsCreate: (name) => ipcRenderer.invoke('accounts:create', name),
  accountsDelete: (id) => ipcRenderer.invoke('accounts:delete', id),
  onAccountChanged: (cb) => ipcRenderer.on('account:changed', () => cb())
});
