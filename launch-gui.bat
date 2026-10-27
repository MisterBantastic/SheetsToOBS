@echo off
setlocal enabledelayedexpansion
title OBS Google Sheet Importer GUI
cd /d "%~dp0"

:: 1. Locate Node.js Runtime (Bundled private runtime first, then system PATH)
set "NODE_BIN="
if exist "%~dp0runtime\node.exe" set "NODE_BIN=%~dp0runtime\node.exe"
if "%NODE_BIN%"=="" if exist "%~dp0node.exe" set "NODE_BIN=%~dp0node.exe"

if "%NODE_BIN%"=="" (
    where node >nul 2>nul
    if !errorlevel! equ 0 set "NODE_BIN=node"
)

if "%NODE_BIN%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if "%NODE_BIN%"=="" if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
if "%NODE_BIN%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if "%NODE_BIN%"=="" (
    echo [ERROR] Node.js runtime not found.
    echo Install Node.js LTS from https://nodejs.org or run installer\setup-runtime.ps1
    pause
    exit /b 1
)

:: 2. Start Detached Background Server
start "" "%NODE_BIN%" "%~dp0src\server.js"

:: 3. Brief wait for server listening
ping 127.0.0.1 -n 2 >nul

:: 4. Launch Desktop App Window (Edge App Mode / Chrome App Mode / Default Browser)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:4587 --window-size=580,680
    exit /b 0
)

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:4587 --window-size=580,680
    exit /b 0
)

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=http://localhost:4587 --window-size=580,680
    exit /b 0
)

if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --app=http://localhost:4587 --window-size=580,680
    exit /b 0
)

start http://localhost:4587
exit /b 0
