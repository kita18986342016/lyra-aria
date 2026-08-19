# 深空折韵 (Lyra Aria)

本地音乐播放器 —— 播放本地音乐文件，支持在线曲库、歌单管理、桌面歌词、自动更新。

## ✨ 功能

- **本地曲库**：扫描文件夹建立曲库，歌曲墙/专辑墙/列表三种视图
- **曲库目录歌单化**：侧栏每个曲库目录 = 一个可交互歌单（点击查看、右键菜单、拖拽排序）
- **在线音乐**：接入在线曲库（搜索/歌单/歌词/封面）
- **歌单管理**：导入/创建歌单，歌曲加入歌单、从歌单移除；在线歌曲右键删除 = 从歌单移除，本地歌曲右键删除 = 删除文件
- **下载**：在线歌曲下载到本地（自动写入 ID3 标签、封面、同名 .lrc 歌词），下载完成自动入库
- **桌面歌词**：独立歌词窗口，字号/颜色/透明度可调
- **歌词/封面**：自动抓取、翻译，可手动修正标签
- **媒体集成**：SMTC（Win 媒体会话）、任务栏缩略图、托盘、全局快捷键
- **自动更新**：GitHub Release 发布，应用内检查/下载/安装

## 🚀 快速开始（开发者）

```bash
npm install
npm start        # 启动开发版（electron .）
```

要求：Node.js 18+，Windows 10/11（依赖 koffi 原生模块做任务栏缩略图）

## 📦 打包发布

```bat
build.bat        # 打便携版（dist\win-unpacked）
```

发布安装包（NSIS + 自动更新元数据）：

```bash
npx electron-builder --win nsis --publish never
```

产物在 `dist\`：`lyra-aria-setup-<版本>.exe` + `latest.yml` + `.blockmap`
（发布到 GitHub Release 时三个文件一起上传；`latest.yml` 是自动更新的元数据，必须与安装包同名对应）

## 📁 目录结构

```
main.js              # 主进程：窗口/托盘/IPC/扫描调度/下载/更新
preload.js           # contextBridge 安全 API
core/
  store.js           # 配置/状态持久化（数据目录可配置）
  scanner.js         # 曲库扫描（音乐文件解析）
  songlist.js        # 歌单导入（酷狗分享链接等）
  lyrics.js          # 歌词抓取/解析
  covers.js          # 封面获取/缓存
renderer/
  index.html         # 主界面
  app.js             # 渲染层逻辑
  style.css
  lyric-win.html     # 桌面歌词窗口
assets/              # 图标等
```

## 💾 数据存储（重要）

- **优先 D 盘**：`D:\MusicPlayerData`（config/library/歌单/封面/缓存）
- **无 D 盘时**：自动落到系统用户目录 `%APPDATA%\<应用名>` —— 每台机器每个用户完全隔离，数据私有

升级安装不会触碰数据目录，歌曲/歌单/收藏始终保留。

## 🔄 自动更新

- 更新源：GitHub Release（`provider: generic`，走 `github.com` 直链，绕开 `api.github.com` 限流）
- 启动 6 秒静默检查，发现新版才提示；设置 → 软件更新 可手动检查/下载/安装
- 检查/下载失败时提示手动下载链接

## 🤝 参与贡献

1. Fork 本仓库
2. Clone 到本地，`npm install && npm start` 跑起来
3. 改代码，自测（注意别动到 `D:\MusicPlayerData` 的真实数据——开发版会用它）
4. 提交 PR（Pull Request），描述改动和测试结果

或联系仓库所有者添加为协作者直接推送分支。

## 🛠 技术栈

Electron 43 · 原生 JS（无框架）· music-metadata · node-id3 · koffi · electron-builder · electron-updater

## 📄 License

MIT
