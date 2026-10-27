@echo off
cd /d "%~dp0"
title Install OBS Google Sheet Importer Dependencies

set "NPM_BIN=npm"
if exist "..\runtime\npm.cmd" (
    set "NPM_BIN=..\runtime\npm.cmd"
)

"%NPM_BIN%" install
pause