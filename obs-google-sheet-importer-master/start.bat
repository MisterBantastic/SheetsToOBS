@echo off
cd /d "%~dp0"
title OBS Google Sheet Importer

:: Check for bundled runtime or system node
set "NODE_BIN=node"
if exist "..\runtime\node.exe" (
    set "NODE_BIN=..\runtime\node.exe"
) else if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
)

echo Starting OBS Google Sheet Importer...
"%NODE_BIN%" index.js
if %errorlevel% neq 0 (
    echo.
    echo Script exited with error code %errorlevel%.
)
pause