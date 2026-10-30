@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 或更新版本：https://nodejs.org/
  echo 安装后重新双击此文件。
  pause
  exit /b 1
)
node scripts/launch.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
timeout /t 5 >nul 2>nul
exit /b 0
