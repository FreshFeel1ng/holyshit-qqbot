@echo off
chcp 65001 >nul
cd /d "%~dp0"
title QQ 群聊机器人
node --env-file=.env src/index.js
echo.
echo 机器人已退出，按任意键关闭窗口。
pause >nul
