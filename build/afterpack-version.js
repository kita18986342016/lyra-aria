// afterPack 钩子：signAndEditExecutable=false 跳过了 builder 的 rcedit 步骤，
// 导致主 exe 版本资源停留在 Electron 底包版本（1.3.7）。
// 此钩子用 builder 缓存里的 rcedit 手动把 FileVersion/ProductVersion 写成当前版本。
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'win32') return;
  const productName = context.packager.appInfo.productFilename; // 深空折韵
  const version = context.packager.appInfo.version;             // 1.4.1
  const exePath = path.join(context.appOutDir, productName + '.exe');
  if (!fs.existsSync(exePath)) { console.log('[afterpack] exe not found, skip:', exePath); return; }
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  let rcedit = null;
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache)) {
      const p = path.join(cache, d, 'rcedit-x64.exe');
      if (fs.existsSync(p)) { rcedit = p; break; }
    }
  }
  if (!rcedit) { console.log('[afterpack] rcedit not found in cache, skip'); return; }
  // 注：builder 缓存的 rcedit 版本只支持 --set-version-string（数值字段由字符串自动推导），
  // 传 --set-version-number 会报 Unrecognized argument
  execFileSync(rcedit, [
    exePath,
    '--set-version-string', 'FileVersion', version,
    '--set-version-string', 'ProductVersion', version,
    '--set-version-string', 'ProductName', productName
  ], { stdio: 'inherit' });
  console.log('[afterpack] version resource set to ' + version + ' for ' + exePath);
};
