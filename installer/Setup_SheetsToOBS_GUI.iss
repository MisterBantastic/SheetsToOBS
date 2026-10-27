; ==============================================================================
; Inno Setup Script: OBS Google Sheet Importer Desktop GUI
; 100% Standalone Windows Installer with Native Launcher (.EXE) and Bundled Runtime
; ==============================================================================

#define MyAppName "OBS Google Sheet Importer GUI"
#define MyAppVersion "0.2.0"
#define MyAppPublisher "MisterBantastic"
#define MyAppURL "https://github.com/DaBenjamins/obs-google-sheet-importer"
#define MyAppExeName "SheetsToOBS.exe"

[Setup]
AppId={{D37E6B81-54A2-4B22-8A97-152F94EC210A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
AppCopyright=Copyright (C) 2026 {#MyAppPublisher}
VersionInfoCompany={#MyAppPublisher}
VersionInfoCopyright=Copyright (C) 2026 {#MyAppPublisher}
VersionInfoDescription={#MyAppName} Installer
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}
VersionInfoVersion={#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=..\LICENSE.txt
; Shown before installing: this project was written with heavy AI assistance.
InfoBeforeFile=AI-NOTICE.txt
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=Output
OutputBaseFilename=Setup_SheetsToOBS_v{#MyAppVersion}
SetupIconFile=app.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=force
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Main Native Application Executable
Source: "..\SheetsToOBS.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\SheetsToOBS_Logo.png"; DestDir: "{app}"; Flags: ignoreversion

; Documentation & Legal Agreements
Source: "..\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\THIRD_PARTY_LICENSES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\PRIVACY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\SECURITY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\AI_DISCLOSURE.md"; DestDir: "{app}"; Flags: ignoreversion

; Bundled self-contained Node.js runtime
Source: "..\runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs createallsubdirs ignoreversion

; Pre-packaged dependencies (offline ready)
Source: "..\node_modules\*"; DestDir: "{app}\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion

; Core application source files
Source: "..\src\*"; DestDir: "{app}\src"; Flags: recursesubdirs createallsubdirs ignoreversion
; apps-script\ and docs\ are not shipped yet (unreleased Control Sheet material).
Source: "..\launch-gui.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\launch-gui.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\main.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\config-dist.json"; DestDir: "{app}"; Flags: ignoreversion

; No config.json is installed into the program folder any more. Settings, logs and
; window position are kept per user in %APPDATA%\SheetsToOBS (see src\paths.js),
; so the program folder stays read-only for normal users.

; Legacy scripts bundle
Source: "..\obs-google-sheet-importer-master\*"; DestDir: "{app}\obs-google-sheet-importer-master"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
// ==============================================================================
// PASCAL CODE
// ==============================================================================

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  // Gracefully request background server shutdown
  Exec('powershell.exe', '-NoProfile -Command "try { Invoke-RestMethod -Uri http://localhost:4587/api/shutdown -Method Post -TimeoutSec 1 } catch {}"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // Terminate any running SheetsToOBS launcher
  Exec('taskkill.exe', '/F /T /IM SheetsToOBS.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec('taskkill.exe', '/F /T /IM SheetsToOBS.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('powershell.exe', '-NoProfile -Command "try { Invoke-RestMethod -Uri http://localhost:4587/api/shutdown -Method Post -TimeoutSec 1 } catch {}"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    Log('OBS Google Sheet Importer GUI installed successfully with native SheetsToOBS.exe launcher.');
  end;
end;
