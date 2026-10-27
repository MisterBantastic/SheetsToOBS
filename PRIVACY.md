# Privacy & Data Handling

SheetsToOBS runs on your computer. It has **no telemetry or analytics**, and it never sends your data to the project's authors.

## What is stored, and where

Settings are kept in `config.json`:
- **Installed copy:** in `%APPDATA%\SheetsToOBS\`.
- **Portable copy:** in the app folder.

That file holds your Google Sheets API key, OBS WebSocket password and, if you use the experimental bridge, the Apps Script token, all **in plain text** on your PC. `config.json.bak`, `logs\crash.log` and `window-state.json` are stored next to it. Crash logs contain error details, your OS version, computer name and Windows user name. They stay on your PC.

## Network connections

| Destination | When | Why |
| :--- | :--- | :--- |
| `https://sheets.googleapis.com` | While syncing or testing | Reads your sheet with your API key |
| Your OBS WebSocket (default `ws://localhost:4455`) | While syncing or testing | Updates sources |
| `http://127.0.0.1:4587` | Always | The app's own local interface |
| `https://fonts.googleapis.com` / `fonts.gstatic.com` | When the app window opens | Interface fonts |
| `https://script.google.com` (your own Apps Script) | Experimental Control Sheet only, when configured | Reads/writes the control tab |
| `https://raw.communitydragon.org` | Experimental Control Sheet only | Champion icons |

Your use of Google services is covered by the [Google Privacy Policy](https://policies.google.com/privacy).

## Questions

Open an issue in the repository.
