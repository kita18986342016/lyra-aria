; v1.4.2 卸载安全加固（借鉴 Mineradio INSTALLER_STYLE / build/installer.nsh，GPL-3.0）
; 背景：electron-builder 原版卸载器对 $INSTDIR 做 RMDir /r 整目录递归删除；本应用历史上允许用户自定义
; 安装目录——若用户把安装目录设在自己的文件夹，卸载会连用户自有文件一起删掉。
; 策略：应用 100% 自有的子目录（resources/locales/swiftshader）递归删除；顶层按已知文件白名单删除；
; 最后用不带 /r 的 RMDir 移除空目录——用户放在安装目录里的自有文件一律不动（宁可残留，不可误删）。

; 2026-09-20 安装位置规则（用户拍板）：深空折韵固定安装 D:\MusicPlayer\lyra-aria，不再允许改目录。
; 背景：桌面快捷方式与 agent 同步流程（robocopy dist/win-unpacked → 该目录）都锚定这一路径；
; 历史上 setup.exe 默认会装 %LOCALAPPDATA%\Programs\lyra-aria（C 盘）且目录页可改 → 位置漂移=快捷方式失效。
; allowToChangeInstallationDirectory=false 后无目录页，customInit 在 initMultiUser 之后钉死 INSTDIR 即最终值。
!macro customInit
  StrCpy $INSTDIR "D:\MusicPlayer\lyra-aria"
!macroend

!macro customRemoveFiles
  Call un.LyraRemoveInstalledFiles
!macroend

!ifdef BUILD_UNINSTALLER
Function un.LyraRemoveInstalledFiles
  SetOutPath $TEMP

  ; 主程序与卸载器
  Delete "$INSTDIR\${PRODUCT_FILENAME}.exe"
  Delete "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"
  Delete "$INSTDIR\uninstallerIcon.ico"

  ; Electron/Chromium 运行时顶层文件（白名单，随 electron 版本演进需维护）
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\dxil.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vulkan-1.dll"

  ; 应用完全自有的子目录 → 可安全递归删除（app.asar / app.asar.unpacked / 语言包）
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"

  ; 仅当目录已空才会被移除；用户自有文件/子目录原样保留
  RMDir "$INSTDIR"
FunctionEnd
!endif