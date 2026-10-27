@echo off
setlocal
title Build SheetsToOBS.exe launcher
cd /d "%~dp0"

:: Compiles src\launcher\AppLauncher.cs into SheetsToOBS.exe with the C# compiler
:: that ships with Windows (.NET Framework 4.x). No Visual Studio needed.
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    echo [ERROR] .NET Framework 4 C# compiler ^(csc.exe^) not found.
    if /i not "%~1"=="nopause" pause
    exit /b 1
)

"%CSC%" /nologo /target:winexe /optimize+ /codepage:65001 ^
  /win32icon:installer\app.ico ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
  /out:SheetsToOBS.exe src\launcher\AppLauncher.cs
set "RESULT=%errorlevel%"

if "%RESULT%"=="0" (
    echo SheetsToOBS.exe built.
) else (
    echo [ERROR] Build failed with code %RESULT%.
)
if /i not "%~1"=="nopause" pause
exit /b %RESULT%
