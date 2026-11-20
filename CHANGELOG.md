# Changelog

## 0.3.1

Run the new installer over 0.3.0. Your settings are kept.

### New
- **Browse… for media folders.** Both media folder fields (the profile's **Media Folder** and **Your media folder** in Create a Setup Kit) have a **Browse…** button that opens the normal Windows folder window.

### Fixed
- **The profile's Media Folder wasn't saved** unless you also pressed Save Profile Settings. It now saves on its own, like the other fields.
- **Test link gave no answer when the kit worked.** It now shows that it's checking, then a clear green "All checks passed" or red "X of N checks failed" box with a message, scrolled into view. A re-test no longer leaves the old result on screen while it runs.

## 0.3.0

Upgrading from 0.2.0: run the new installer over the old one. The app is now called **SheetsToOBS** everywhere: Start menu, Settings › Apps and the install folder (`C:\Program Files\SheetsToOBS`). Your settings are moved to `%APPDATA%\SheetsToOBS` and the old "OBS Google Sheet Importer GUI" folder and shortcuts are removed. Exported profiles are now named `SheetsToOBS-….json`; older `obs-sheets-….json` files still import.

### New
- **Scene collection lock.** A profile can name the OBS scene collection it belongs to. While another collection is open, nothing is sent to OBS.
- **Setup kits.** A league admin can package a scene collection, its media, and the plugins and fonts it needs, and host it for producers. Private URLs are removed from sheet-controlled sources first.
- **Setup Check.** Walks a producer through what the show needs on their PC: profile, OBS connection, plugins, fonts, media and League esports timers. Its **Import profile** button loads the profile file a league admin sends out.
- **Update checks.** The app tells you when a newer SheetsToOBS or a newer scene collection is available. Nothing is installed without you.
- **Activity log files.** The log is saved as `logs\sync-<date>.log`, one file per day, kept for 14 days.
- **Crash recovery.** If the app stops with an error it starts itself again and carries on syncing.
- **Unknown types are flagged.** A typo in column C now shows "Unknown type" on that source instead of silently doing nothing. Capital letters no longer matter (`text` works like `Text`).

### Changed
- **Faster syncing with many sources.** OBS is read in two requests per poll instead of one per source.
- **Google errors are handled calmly.** After a failed sheet read the app retries less often (up to every 2 minutes) and logs the error once. Sync Now retries straight away.
- **Importing a profile asks before replacing** one with the same name.
- **Imported profiles can't change this PC's folders or network access**, and your OBS password is only reused for OBS on this PC.
- **Setup kits only carry media files** (pictures, video, sound, fonts). OBS scripts (Tools › Scripts) are removed from downloaded scene collections; add them by hand if your show needs them.
- **Bundled Node.js is now 24 LTS** (0.2.0 shipped Node 20, which is no longer supported).
- **Smaller installer.** The original command-line script and npm are no longer installed.

### Fixed
- A delayed image or video swap could still be sent after pressing Stop or switching scene collection.
- An OBS request that failed during a sync left no trace in the log.
- Large media files in a setup kit could time out after 10 seconds.

### Removed
- The unused Electron entry point (`npm run electron`).

## 0.2.0

First public release.
