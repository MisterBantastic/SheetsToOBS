/**
 * Where SheetsToOBS keeps files it writes (config.json, logs, window-state.json).
 *
 *  1. SHEETSTOOBS_DATA_DIR environment variable, if set (used by the tests).
 *  2. "Portable" mode: the app folder itself, when it already holds a config.json
 *     (or a portable.txt marker) AND we can really write there. This keeps
 *     existing setups and developer checkouts working unchanged.
 *  3. Otherwise a per-user folder: %APPDATA%\SheetsToOBS on Windows
 *     (~/.config/SheetsToOBS elsewhere). This is what an installed copy under
 *     C:\Program Files uses, so the program folder can stay read-only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');

// fs.accessSync() ignores Windows ACLs, so test by actually creating a file.
function canWriteTo(dir) {
  try {
    const probe = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

function userDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'SheetsToOBS');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'SheetsToOBS');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'SheetsToOBS');
}

let cachedDataDir = null;

function dataDir() {
  if (process.env.SHEETSTOOBS_DATA_DIR) return path.resolve(process.env.SHEETSTOOBS_DATA_DIR);
  if (cachedDataDir) return cachedDataDir;

  const portable = fs.existsSync(path.join(APP_DIR, 'portable.txt')) || fs.existsSync(path.join(APP_DIR, 'config.json'));
  if (portable && canWriteTo(APP_DIR)) {
    cachedDataDir = APP_DIR;
    return cachedDataDir;
  }

  const dir = userDataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) { /* reported later when a save fails */ }

  // First run after moving out of the app folder: carry the old settings over once.
  for (const name of ['config.json', 'window-state.json']) {
    const from = path.join(APP_DIR, name);
    const to = path.join(dir, name);
    try {
      if (!fs.existsSync(to) && fs.existsSync(from)) fs.copyFileSync(from, to);
    } catch (e) { /* not fatal */ }
  }

  cachedDataDir = dir;
  return cachedDataDir;
}

function dataFile(...parts) {
  return path.join(dataDir(), ...parts);
}

module.exports = { APP_DIR, dataDir, dataFile, canWriteTo, userDataDir };
