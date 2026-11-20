const { execFile } = require('child_process');

// "Browse…" for folder fields. The app's window is a browser page, which can't
// see full folder paths, so the server (on this PC) opens the Windows folder
// picker and returns the chosen path. Only reachable from this PC: the server
// never lets other devices call it.

// The window title comes from this list, never from the page.
const TITLES = {
  'kit-media': 'Choose the folder with your league\'s media (stingers, masks, sounds)',
  'profile-media': 'Choose where this PC keeps the scene collection\'s media files'
};

// PowerShell (5.1, ships with Windows) shows the picker on top of other windows.
// The start folder and title arrive as environment variables, never as script
// text, so nothing in them can run as code.
const SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0',
  '$owner.StartPosition = "CenterScreen"; $owner.Size = New-Object System.Drawing.Size(1, 1)',
  '$owner.Show(); $owner.Activate()',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = $env:STO_PICK_TITLE',
  '$d.ShowNewFolderButton = $true',
  'if ($env:STO_PICK_START -and (Test-Path -LiteralPath $env:STO_PICK_START -PathType Container)) { $d.SelectedPath = $env:STO_PICK_START }',
  '$r = $d.ShowDialog($owner)',
  '$owner.Close()',
  'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }'
].join('\n');

/** Runs the picker script; resolves with what it printed. Replaced by tests. */
function runPicker(env) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      env: { ...process.env, ...env },
      windowsHide: true,
      timeout: 30 * 60 * 1000, // the user may take a while; don't hang forever
      maxBuffer: 64 * 1024
    }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

let pickerOpen = false;

/**
 * Opens the Windows folder picker. Resolves { path } or { cancelled: true }.
 * Throws if it can't be shown (not Windows, or one is already open).
 */
async function pickFolder({ purpose, start = '' } = {}, { run = runPicker, platform = process.platform } = {}) {
  if (!Object.prototype.hasOwnProperty.call(TITLES, purpose)) throw new Error('Unknown folder field.');
  if (platform !== 'win32') throw new Error('Browse only works on Windows. Type the folder path instead.');
  if (pickerOpen) throw new Error('A folder window is already open. It may be behind this window.');
  pickerOpen = true;
  try {
    const out = await run({
      STO_PICK_TITLE: TITLES[purpose],
      STO_PICK_START: String(start || '').slice(0, 500)
    });
    const chosen = String(out || '').replace(/^﻿/, '').trim();
    return chosen ? { path: chosen } : { cancelled: true };
  } finally {
    pickerOpen = false;
  }
}

module.exports = { pickFolder, TITLES };
