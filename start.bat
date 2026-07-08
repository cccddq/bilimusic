@echo off
chcp 65001 >nul
title BiliMusic
cd /d "%~dp0"

echo ========================================
echo   BiliMusic - Electron 桌面版
echo ========================================
echo.

REM 检查 Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js (建议 LTS 版):
  echo        https://nodejs.org/
  echo.
  pause
  exit /b 1
)

REM 检查是否已安装依赖
if not exist "node_modules" (
  echo [1/2] 首次运行，正在安装依赖 ^(需要联网，约 1-3 分钟^)...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
) else (
  echo [1/2] 依赖已就绪。
)

echo [2/2] 启动应用...
echo.
npm start

pause
