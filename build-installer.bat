@echo off
title Build OBS Sheets Live Windows Installer
cd /d "%~dp0"

echo ========================================================
echo   Building Standalone Windows Installer (.EXE)
echo ========================================================
echo.

set "ISCC_PATH="

:: Look for Inno Setup compiler in standard locations
if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" (
    set "ISCC_PATH=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
) else if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" (
    set "ISCC_PATH=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
) else if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" (
    set "ISCC_PATH=%ProgramFiles%\Inno Setup 6\ISCC.exe"
)

if "%ISCC_PATH%"=="" (
    echo [INFO] Inno Setup compiler not found. Installing via winget...
    winget install JRSoftware.InnoSetup -e --silent --accept-source-agreements --accept-package-agreements
    if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" (
        set "ISCC_PATH=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
    )
)

if "%ISCC_PATH%"=="" (
    echo [ERROR] Inno Setup compiler could not be located.
    echo Please install Inno Setup 6 from https://jrsoftware.org/isdl.php
    pause
    exit /b 1
)

if not exist "%~dp0runtime\node.exe" (
    echo [ERROR] runtime\node.exe is missing. Run installer\setup-runtime.ps1 first.
    pause
    exit /b 1
)

echo Building SheetsToOBS.exe launcher...
call "%~dp0build-launcher.bat" nopause
if errorlevel 1 (
    echo [ERROR] Launcher build failed.
    pause
    exit /b 1
)

echo Compiling installer using: "%ISCC_PATH%"
"%ISCC_PATH%" "installer\Setup_SheetsToOBS_GUI.iss"

if %errorlevel% equ 0 (
    echo.
    echo ========================================================
    echo   BUILD SUCCESSFUL!
    echo   Installer EXE created at:
    echo   installer\Output\Setup_SheetsToOBS_v*.exe
    echo ========================================================
    echo.
) else (
    echo [ERROR] Inno Setup compilation failed with error code %errorlevel%
)

pause
