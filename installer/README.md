# Windows installer

This folder builds the Windows installer with **Inno Setup 6**.

| File | Purpose |
| :--- | :--- |
| `Setup_SheetsToOBS_GUI.iss` | Inno Setup script |
| `setup-runtime.ps1` | Downloads the latest Node.js LTS (checksum-verified) into `..\runtime` and runs `npm ci --omit=dev` |
| `AI-NOTICE.txt` | "Made with AI" notice shown before installing |
| `sign-executables.ps1` | Optional: signs the EXEs with a **self-signed** certificate. This only helps on your own PC; other PCs will still show a SmartScreen warning unless you use a real code-signing certificate. |
| `app.ico` | Icon for the installer and launcher |

## Build

1. `powershell -ExecutionPolicy Bypass -File installer\setup-runtime.ps1`
2. `build-installer.bat` in the project root. This also builds `SheetsToOBS.exe` from `src\launcher\AppLauncher.cs`.
3. The installer is written to `installer\Output\Setup_SheetsToOBS_v<version>.exe`. Upload it to a GitHub Release; don't commit it.

## What the installer does

- Installs the app, the bundled Node.js runtime and dependencies into Program Files. Normal users can't modify that folder.
- Settings are created per user in `%APPDATA%\SheetsToOBS` on first run.
- **Upgrading from 0.1:** if the old install folder still has a `config.json`, that file keeps being used. To move to the per-user folder, copy it to `%APPDATA%\SheetsToOBS\config.json`, then delete it from the install folder.
- Asks a running SheetsToOBS to shut down before installing.
