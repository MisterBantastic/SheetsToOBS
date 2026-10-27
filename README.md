# SheetsToOBS: OBS Google Sheet Importer GUI

> [!WARNING]
> **This project was built with AI.** Most of the code, installer scripts and documentation were written by AI coding assistants, with a human directing, testing and reviewing the work. It has **not** had an independent security audit. Test it on a copy of your sheet and a test OBS scene collection before using it on a live show, and keep a manual fallback. See [AI_DISCLOSURE.md](AI_DISCLOSURE.md).

## ⬇️ Download

**[Get the latest installer from the Releases page](https://github.com/MisterBantastic/SheetsToOBS/releases/latest)**: download `Setup_SheetsToOBS_v<version>.exe` and run it. That's all most people need: it includes everything (its own Node.js runtime), so nothing else has to be installed.

The full source code is in this repository, so you can read it before you install, or run it yourself (see [Running from source](#running-from-source)).

---

A Windows desktop GUI for [obs-google-sheet-importer](https://github.com/DaBenjamins/obs-google-sheet-importer). It reads a Google Sheet and updates OBS Studio text, color, image, video, browser, visibility and Source Switcher sources in bulk during a show, over OBS WebSocket v5.

---

## Features

- **Live monitoring:** OBS WebSocket connection, latency, OBS version, scene and source counts, plus Google Sheets sync state, last fetch, row count and errors.
- **Source mapping:** finds every OBS source named `Anything |sheet <row>` and shows its scene, row, type, value, tags, visibility and sync state. It also flags OBS names that don't match the sheet's label.
- **Engine controls:** start/stop, Sync Now, polling interval (1 s, 2 s, 5 s or custom).
- **Simulation mode:** try the interface without OBS or Google credentials.
- **Connection testers:** test the OBS WebSocket and Google Sheets settings before starting.
- **Profiles:** several shows or sheets, with "clean" exports that never contain your API key, OBS password or tokens.

---

## Getting started

1. Install with the [latest installer](https://github.com/MisterBantastic/SheetsToOBS/releases/latest) and open **SheetsToOBS** from the Start menu.
2. In **Profiles & Config**, enter your Sheet ID (or paste the sheet's URL), tab name and Google API key. Then enter your OBS WebSocket address and password, and press the two **Test** buttons.
3. Name your OBS sources as described below and press **Start Sync**.

If an admin sent you a profile file, use **Import Config** instead of step 2. You'll only need to enter your OBS password.

### What you need
- A Google Sheets API key ([how to create one](https://developers.google.com/sheets/api/guides/authorizing#APIKey)). Restrict it to the **Google Sheets API** only.
- The sheet shared as "Anyone with the link can view" (needed for API-key access).
- OBS Studio 28+ with **Tools › WebSocket Server Settings › Enable WebSocket server** on, with a password set.

---

## OBS source naming

Name each OBS source you want the sheet to control:

```
[Any name] |sheet [Row number]
```

Examples: `Match Title |sheet 2`, `Team 1 Color |sheet 4`, `Sponsor Banner |sheet 5`.

## Sheet layout

The importer reads columns **A–E** of the data tab, starting at the row given in the profile's range (default `C2:D`, so row 2):

| Column | Meaning |
| :--- | :--- |
| A | ID (optional) |
| B | Label, used to check that OBS names match |
| C | Type (see below) |
| D | Value |
| E | Expected OBS source name (optional) |

## Supported types (column C)

| Type | OBS source | Behavior |
| :--- | :--- | :--- |
| `Text` | GDI+ / FreeType2 text | Sets the text; supports `?color=` and `?fontstyle=` tags. |
| `Color` | Color source | Sets the color from a hex value, e.g. `#3B82F6`. |
| `Image` | Image source | Sets the file path or URL. With `?hide;` it hides first and swaps the file while hidden; with `?show;` it swaps the file, then shows it. |
| `Video` | Media source | Same as Image, for `local_file`. |
| `Browser` | Browser source | Sets the URL. |
| `HS` | Any scene item | `show` or `hide`. |
| `SourceSwitcher` / `Switcher` | [Source Switcher plugin](https://obsproject.com/forum/resources/source-switcher.941/) | Sets the list of sources, separated by `;;`. |

## Value tags (column D)

| Tag | Example | Effect |
| :--- | :--- | :--- |
| `?color=HEX;` | `?color=FF5500;Grand Finals` | Orange text "Grand Finals". |
| `?fontstyle=underline;` / `strikethrough;` | `?fontstyle=strikethrough;Eliminated` | Font style. |
| `?hide;` / `?show;` | `?hide;Optional Subtitle` | Hides or shows the source. **The sheet wins:** if someone toggles the source by hand in OBS, the next poll puts it back. |
| `;;` | `Cam 1, Desk;; Cam 2, Crowd` | Source Switcher list items (comma-safe). |

---

## Where settings are stored

| Setup | Location |
| :--- | :--- |
| Installed (Program Files) | `%APPDATA%\SheetsToOBS\` (`config.json`, `config.json.bak`, `logs\`, `window-state.json`) |
| Portable / source checkout | The app folder, if it already contains `config.json` (or an empty `portable.txt`) and is writable |
| Override | Set the environment variable `SHEETSTOOBS_DATA_DIR` |

`config.json` holds your Google API key, OBS password and any Apps Script token **in plain text**. It is listed in `.gitignore`. Never commit it or send it to anyone. Use **Export Clean Profile** to share settings.

Each save writes a temporary file and renames it into place, and the previous good file is kept as `config.json.bak`. If `config.json` gets damaged, the app copies it aside (`config.json.corrupt-…`) and loads the backup.

## Profile sharing

| Export | Contains | Use |
| :--- | :--- | :--- |
| **Export Profile / Export All** (default) | Tab, range, polling and rules. No Sheet ID, no keys | Safe to post publicly as a template |
| **…with "Include Sheet ID & Google API key" ticked** | The above plus the Sheet ID and Google API key | **Admins → producers:** a ready-to-run profile. Only send it to people you trust |
| **Full Backup** | Everything, including the OBS password and tokens | Your own PC only |
| **Import Config** | Any of the above | Keeps your PC's own OBS connection and password |

The OBS password and Apps Script token are never included in a shared export. Exported files (`obs-sheets-*.json`) are listed in `.gitignore`, so they can't be committed by accident.

---

## Experimental features (off by default)

The **Control Sheet / Web Dashboard** (`/dashboard`) is still being built and tested. It includes:
- a web version of a "Stream" control tab;
- writes back to Google Sheets through an Apps Script bridge;
- a phone/tablet "remote" over the local network.

It is **switched off by default**. While it's off:
- the Control Sheet button and settings are hidden;
- its pages and API return 404;
- the app only listens on `127.0.0.1`.

To try it, go to **Personalization › Experimental Features** and tick **Control Sheet (Web Dashboard)**, preferably while connected to a **copy** of your sheet. Untick it to remove it again. Developers can also set the environment variable `SHEETSTOOBS_EXPERIMENTAL=1`.

Editing the sheet from the dashboard needs an Apps Script bridge that is **not published yet**. It will be added later, together with starter scripts for new producers. Without it, the dashboard works read-only. The layout in `src/public/control-layout.json` is written for one specific production sheet.

If you enable "Allow other devices on my network":
- **Restart the app** for it to take effect.
- Other devices must enter the **access code** shown in the dashboard settings.
- After 10 wrong codes from one device, it is locked out for 10 minutes.
- Only use this on a network you trust.

---

## Running from source

1. Install [Node.js](https://nodejs.org) LTS (20 or newer).
2. `npm install`
3. `npm start`, then open <http://localhost:4587>. Or double-click `launch-gui.bat`.

## Building

| Step | Command |
| :--- | :--- |
| Bundle Node.js LTS + dependencies into `runtime\` | `powershell -ExecutionPolicy Bypass -File installer\setup-runtime.ps1` |
| Build the tray launcher `SheetsToOBS.exe` (uses the C# compiler built into Windows) | `build-launcher.bat` |
| Build the installer ([Inno Setup 6](https://jrsoftware.org/isinfo.php)) | `build-installer.bat` (also builds the launcher) |
| Run the tests | `npm test` |

Release binaries (`SheetsToOBS.exe`, the installer, `runtime\`, `node_modules\`) are not committed.

**Publishing a release:** run `build-installer.bat`, then on GitHub go to **Releases › Draft a new release**. Tag it (e.g. `v0.2.0`) and attach `installer\Output\Setup_SheetsToOBS_v0.2.0.exe`. The Download link at the top of this README always points to the newest release.

---

## Security

- The local server listens on `127.0.0.1:4587` only, unless the experimental network option is switched on.
- It blocks cross-site requests and DNS-rebinding hosts.
- It sends a strict Content-Security-Policy, so the page only runs its own scripts.
- Sheet content is always escaped before display. Anyone who can edit your sheet is still trusted to control what goes on stream, so share edit access carefully.

See [SECURITY.md](SECURITY.md) for how to report a problem.

## Credits & license

- Based on [obs-google-sheet-importer](https://github.com/DaBenjamins/obs-google-sheet-importer) by Michael Benjamins (MIT). The original script is included in `obs-google-sheet-importer-master/`.
- Released under the [MIT License](LICENSE). See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md), [PRIVACY.md](PRIVACY.md) and [AI_DISCLOSURE.md](AI_DISCLOSURE.md).
- OBS Studio is a trademark of Wizards of OBS LLC. Google Sheets is a trademark of Google LLC. This project is not affiliated with or endorsed by either.
