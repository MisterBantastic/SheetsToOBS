; ==============================================================================
; Inno Setup Script: SheetsToOBS
; 100% Standalone Windows Installer with Native Launcher (.EXE) and Bundled Runtime
; ==============================================================================

#define MyAppName "SheetsToOBS"
; Name used by v0.2.0 and earlier. On upgrade its Start menu folder and desktop
; shortcut are removed, and its install folder is replaced by one named SheetsToOBS.
#define OldAppName "OBS Google Sheet Importer GUI"
; Never change: Windows uses it to recognise earlier versions as the same app.
#define MyAppIdGuid "D37E6B81-54A2-4B22-8A97-152F94EC210A"
#define MyAppVersion "0.3.0"
#define MyAppPublisher "MisterBantastic"
#define MyAppURL "https://github.com/MisterBantastic/SheetsToOBS"
#define MyAppExeName "SheetsToOBS.exe"

[Setup]
AppId={{{#MyAppIdGuid}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
; Name in Settings > Apps (the version has its own column there).
UninstallDisplayName={#MyAppName}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases/latest
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
; Upgrades from v0.2.0 move to "Program Files\SheetsToOBS" instead of keeping the
; old "OBS Google Sheet Importer GUI" folder; settings are carried over in [Code].
UsePreviousAppDir=no
UsePreviousGroup=no
; Kept in installer\ so GitHub sees only one license file (LICENSE) and detects MIT.
LicenseFile=LICENSE.txt
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
Source: "LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\THIRD_PARTY_LICENSES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\PRIVACY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\SECURITY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\AI_DISCLOSURE.md"; DestDir: "{app}"; Flags: ignoreversion

; Bundled Node.js runtime: only node.exe is needed to run the app (npm and
; corepack stay on the build PC).
Source: "..\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\runtime\LICENSE"; DestDir: "{app}\runtime"; Flags: ignoreversion

; Pre-packaged dependencies (offline ready)
Source: "..\node_modules\*"; DestDir: "{app}\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion

; Core application source files
Source: "..\src\*"; DestDir: "{app}\src"; Flags: recursesubdirs createallsubdirs ignoreversion
; apps-script\ and docs\ are not shipped yet (unreleased Control Sheet material).
Source: "..\launch-gui.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\launch-gui.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\config-dist.json"; DestDir: "{app}"; Flags: ignoreversion

; No config.json is installed into the program folder any more. Settings, logs and
; window position are kept per user in %APPDATA%\SheetsToOBS (see src\paths.js),
; so the program folder stays read-only for normal users.

; The original obs-google-sheet-importer script is no longer installed (it is
; still in the source repository for reference).

; Upgrade helper (stops the old copy, carries its settings over). Not installed.
Source: "upgrade-helper.ps1"; Flags: dontcopy

[InstallDelete]
; Left behind by v0.2.0 and earlier: files that are no longer shipped, and the
; shortcuts under the old name (for all users and for this user).
Type: filesandordirs; Name: "{app}\obs-google-sheet-importer-master"
Type: filesandordirs; Name: "{app}\runtime"
Type: files; Name: "{app}\main.js"
Type: filesandordirs; Name: "{commonprograms}\{#OldAppName}"
Type: filesandordirs; Name: "{userprograms}\{#OldAppName}"
Type: files; Name: "{commondesktop}\{#OldAppName}.lnk"
Type: files; Name: "{userdesktop}\{#OldAppName}.lnk"

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

var
  // Folder of the version installed before this one ('' on a first install).
  PreviousDir: String;

function ReadPreviousDir(): String;
var
  Key: String;
begin
  Result := '';
  Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{' + '{#MyAppIdGuid}' + '}_is1';
  if IsWin64 and RegQueryStringValue(HKLM64, Key, 'Inno Setup: App Path', Result) then Exit;
  if RegQueryStringValue(HKLM32, Key, 'Inno Setup: App Path', Result) then Exit;
  if RegQueryStringValue(HKCU, Key, 'Inno Setup: App Path', Result) then Exit;
  Result := '';
end;

function HelperParams(const Mode: String): String;
begin
  Result := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\upgrade-helper.ps1') + '" ' + Mode +
    ' -OldDir "' + RemoveBackslashUnlessRoot(PreviousDir) + '"';
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  PreviousDir := ReadPreviousDir();
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
  // The background server keeps running while an app window is open, and it may
  // have been started without the launcher: stop anything running from the old
  // or the new folder so its files can be replaced or removed.
  ExtractTemporaryFile('upgrade-helper.ps1');
  Exec('powershell.exe', HelperParams('-Stop') + ' -NewDir "' + ExpandConstant('{app}') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

// v0.2.0 and earlier: settings were often kept in the install folder itself. Copy
// them into %APPDATA%\SheetsToOBS (as the signed-in user, so they land in the right
// profile), and remove the old folder only once the copy is confirmed.
procedure MoveOldInstallFolder();
var
  OldDir, NewDir: String;
  ResultCode: Integer;
begin
  OldDir := RemoveBackslashUnlessRoot(PreviousDir);
  NewDir := RemoveBackslashUnlessRoot(ExpandConstant('{app}'));
  if (OldDir = '') or (CompareText(OldDir, NewDir) = 0) or not DirExists(OldDir) then Exit;

  if ExecAsOriginalUser('powershell.exe', HelperParams('-Migrate'), '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
  begin
    if DelTree(OldDir, True, True, True) then
      Log('Removed the old install folder ' + OldDir + ' (settings are now in %APPDATA%\SheetsToOBS).')
    else
      Log('Could not fully remove the old install folder ' + OldDir + '.');
  end
  else
  begin
    Log('Settings could not be copied from ' + OldDir + ' (code ' + IntToStr(ResultCode) + '). The old folder was kept.');
    SuppressibleMsgBox('SheetsToOBS was installed in ' + NewDir + '.' + #13#10#13#10 +
      'Your settings from the previous version could not be moved automatically, so the old folder was kept:' + #13#10 +
      OldDir + #13#10#13#10 +
      'To move them yourself, copy config.json from there into %APPDATA%\SheetsToOBS, then delete the old folder.',
      mbInformation, MB_OK, IDOK);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    MoveOldInstallFolder();
    Log('SheetsToOBS installed successfully with native SheetsToOBS.exe launcher.');
  end;
end;
