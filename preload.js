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
  dlStart: (song) => ipcRenderer.invoke('dl:start', song),
  dlBatch: (songs) => ipcRenderer.invoke('dl:batch', songs),
  dlCancel: (taskId) => ipcRenderer.invoke('dl:cancel', taskId),
  dlList: () => ipcRenderer.invoke('dl:list'),
  onDlProgress: (cb) => ipcRenderer.on('dl:progress', (_e, p) => cb(p)),
  leizShare: (url) => ipcRenderer.invoke('leiz:share', url),

  // 歌单 / 收藏 / 历史
  getPlaylists: () => ipcRenderer.invoke('playlists:get'),
  savePlaylists: (pls) => ipcRenderer.invoke('playlists:save', pls),
  addSongsToPlaylist: (plId, songIds) => ipcRenderer.invoke('playlists:addSongs', plId, songIds),
  getOpls: () => ipcRenderer.invoke('opl:get'),
  saveOpls: (pls) => ipcRenderer.invoke('opl:save', pls),
  getPlOrder: () => ipcRenderer.invoke('plOrder:get'),
  savePlOrder: (arr) => ipcRenderer.invoke('plOrder:save', arr),
  kugouCover: (song) => ipcRenderer.invoke('kugou:cover', song),
  getFavorites: () => ipcRenderer.invoke('favorites:get'),
  toggleFavorite: (id, song) => ipcRenderer.invoke('favorites:toggle', id, song),
  getHistory: () => ipcRenderer.invoke('history:get'),
  addHistory: (id) => ipcRenderer.invoke('history:add', id),

  // 播放状态 / 配置
  getState: () => ipcRenderer.invoke('player:getState'),
  saveState: (st) => ipcRenderer.invoke('player:saveState', st),
  onFlush: (cb) => ipcRenderer.on('player:flush', () => cb()),
  getConfig: () => ipcRenderer.invoke('config:get'),

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
  sendLyricLine: (payload) => ipcRenderer.send('lyricwin:line', payload),
  sendLyricPlayState: (st) => ipcRenderer.send('lyricwin:play', st),
  sendLyricLrc: (data) => ipcRenderer.send('lyricwin:lrc', data),

  // LeiZ 在线音乐（网易云/酷狗）
  leizSearch: (source, q) => ipcRenderer.invoke('leiz:search', source, q),
  leizResolve: (source, ref, level) => ipcRenderer.invoke('leiz:resolve', source, ref, level),
  leizLyrics: (source, ref, level) => ipcRenderer.invoke('leiz:lyrics', source, ref, level),
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
  onMedia: (cb) => ipcRenderer.on('media:action', (_e, action) => cb(action))
});
