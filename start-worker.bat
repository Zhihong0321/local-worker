@echo off
setlocal enabledelayedexpansion
title Local Worker - ee-auto
cd /d "%~dp0"

echo ========================================================
echo   Local Worker for ee-auto.up.railway.app (Windows)
echo ========================================================
echo.

:: 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not found in PATH!
    echo Please install Node.js 20 or higher from https://nodejs.org/
    pause
    exit /b 1
)

:: 2. Check for .env file
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] .env not found. Creating .env from .env.example...
        copy .env.example .env >nul
        echo [INFO] Created .env file. Please edit it with your desired WORKER_NAME and tokens!
        echo.
    ) else (
        echo [WARNING] No .env file found. Worker will use default environment variables.
    )
)

:: 3. Run worker loop
echo Starting worker loop... (Press Ctrl+C to stop)
echo.

:worker_loop
echo [%date% %time%] Launching node worker.mjs...
node worker.mjs
echo.
echo [%date% %time%] Worker process exited with code %errorlevel%.
echo Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto worker_loop
