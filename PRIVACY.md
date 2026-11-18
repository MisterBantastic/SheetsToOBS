# Privacy & Data Handling

SheetsToOBS runs on your computer. It has **no telemetry or analytics**, and it never sends your data to the project's authors.

## What is stored, and where

Settings are kept in `config.json`:
- **Installed copy:** in `%APPDATA%\SheetsToOBS\`.
- **Portable copy:** in the app folder.

That file holds your Google Sheets API key, OBS WebSocket password and, if you use the experimental bridge, the Apps Script token, all **in plain text** on your PC. `config.json.bak`, `logs\crash.log` and `window-state.json` are stored next to it. Crash logs contain error details, your OS version, computer name and Windows user name. The activity log shown in the app is also saved there as `logssync-<date>.log` (one file per day, deleted after 14 days); it contains source names and the values synced from your sheet, with private-looking URLs (overlay tokens, keys, passwords) left out. They stay on your PC.

## Network connections

| Destination | When | Why |
| :--- | :--- | :--- |
| `https://sheets.googleapis.com` | While syncing or testing | Reads your sheet with your API key |
| Your OBS WebSocket (default `ws://localhost:4455`) | While syncing or testing | Updates sources |
| `http://127.0.0.1:4587` | Always | The app's own local interface |
| `https://fonts.googleapis.com` / `fonts.gstatic.com` | When the app window opens | Interface fonts |
| `https://api.github.com` | Once at startup, and when you press Check now (can be switched off in Personalization › Updates) | Checks whether a newer SheetsToOBS release exists. Sends no settings or personal data |
| The Scene Collection Update URL you enter (and the file it names) | Only if you set one: at startup, when you switch to that profile, and when you press Check now | Checks for and downloads a newer scene collection export |
| A link you paste into **Test link** (Create a Setup Kit) | Only when you press it | Checks your uploaded kit the way a producer's PC would |
| `https://script.google.com` (your own Apps Script) | Experimental Control Sheet only, when configured | Reads/writes the control tab |
| `https://raw.communitydragon.org` | Experimental Control Sheet only | Champion icons |

The **Setup Check** only looks at this PC and sends nothing anywhere. It reads the OBS plugin folders, the installed fonts list in the Windows registry, and League's `game.cfg`. It changes `game.cfg` only when you press **Fix**, and keeps a `game.cfg.sheetstoobs-backup` copy first.

Your use of Google services is covered by the [Google Privacy Policy](https://policies.google.com/privacy).

## Questions

Open an issue in the repository.
