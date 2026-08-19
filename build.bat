@echo off
rem ============================================================
rem  深空折韵 - 一键打包脚本（防打包事故复发）
rem  流程：杀进程树 → 等句柄释放 → 删 dist → electron-builder → 产物自检
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
echo [1/4] 结束运行中的播放器进程树...
taskkill /F /IM "深空折韵.exe" /T >nul 2>&1
ping -n 4 127.0.0.1 >nul

echo [2/4] 确认进程退出并清理 dist...
:WAITKILL
tasklist /FI "IMAGENAME eq 深空折韵.exe" 2>nul | findstr /I "深空折韵" >nul
if not errorlevel 1 (
  ping -n 3 127.0.0.1 >nul
  goto WAITKILL
)
if exist "dist\win-unpacked" rmdir /s /q "dist\win-unpacked"
if exist "dist\win-unpacked" (
  echo [错误] dist\win-unpacked 删除失败（文件仍被占用）
  exit /b 1
)
echo 目录已清理。

echo [3/4] electron-builder 打包...
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --win dir
if errorlevel 1 (
  echo [错误] electron-builder 打包失败
  exit /b 1
)

echo [4/4] 产物自检...
if not exist "dist\win-unpacked\深空折韵.exe" ( echo [错误] exe 未生成 & exit /b 1 )
if not exist "dist\win-unpacked\resources\app.asar" ( echo [错误] asar 未生成 & exit /b 1 )
for %%F in ("dist\win-unpacked\深空折韵.exe" "dist\win-unpacked\resources\app.asar") do (
  echo     %%~tF  %%~nxF
)
echo 打包完成：dist\win-unpacked\深空折韵.exe