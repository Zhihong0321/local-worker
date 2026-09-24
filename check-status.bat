@echo off
title Check Cloud Hub Workers
cd /d "%~dp0"
node check-status.mjs
echo.
pause
