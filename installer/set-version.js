// Sets the app version in every place it lives, so they can't drift apart:
//   package.json, package-lock.json, installer\Setup_SheetsToOBS_GUI.iss and
//   src\launcher\AppLauncher.cs.
//
//   set-version.bat 0.3.1          (or: runtime\node.exe installer\set-version.js 0.3.1)
//
// Then run build-installer.bat.
const fs = require('fs');
const path = require('path');

const root = process.env.SHEETSTOOBS_VERSION_ROOT || path.join(__dirname, '..');
const version = String(process.argv[2] || '').replace(/^v/i, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: set-version.bat <major.minor.patch>   e.g. set-version.bat 0.3.1');
  process.exit(1);
}

/** Replaces exactly `count` matches of `pattern` in a file, or stops with an error. */
function update(rel, pattern, replacement, count = 1) {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, 'utf8');
  const found = (before.match(pattern) || []).length;
  if (found !== count) {
    console.error(`${rel}: expected ${count} version line(s), found ${found}. Nothing was changed in this file.`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(file, before.replace(pattern, replacement), 'utf8');
  console.log(`  ${rel}`);
}

console.log(`Setting version ${version} in:`);
update('package.json', /^(  "version": ")[^"]+(")/gm, `$1${version}$2`);
// The lock file repeats the version at the top and in its root package entry.
try {
  const lockFile = path.join(root, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.version = version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = version;
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  console.log('  package-lock.json');
} catch (e) {
  console.error(`package-lock.json: ${e.message}`);
  process.exitCode = 1;
}
update('installer/Setup_SheetsToOBS_GUI.iss', /^(#define MyAppVersion ")[^"]+(")/gm, `$1${version}$2`);
update('src/launcher/AppLauncher.cs', /(Assembly(?:File)?Version\(")[^"]+("\))/g, `$1${version}.0$2`, 2);

if (!process.exitCode) console.log('Done. Next: build-installer.bat');
