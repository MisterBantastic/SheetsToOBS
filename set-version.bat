@echo off
:: Sets the app version everywhere it lives (see installer\set-version.js).
::   set-version.bat 0.3.1
cd /d "%~dp0"
set "NODE_BIN=node"
if exist "%~dp0runtime\node.exe" set "NODE_BIN=%~dp0runtime\node.exe"
"%NODE_BIN%" "%~dp0installer\set-version.js" %1
if /i not "%~2"=="nopause" pause
