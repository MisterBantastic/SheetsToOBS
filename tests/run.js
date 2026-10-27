/**
 * Runs every test file that is present. Some suites belong to parts of the
 * project that are not published yet (Apps Script, the production Control Sheet
 * data); those files are kept out of the public repository and are skipped here
 * when missing.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = [
  { file: 'test-suite.js' },
  { file: 'hardening-tests.js' },
  // Not in the public repository (need apps-script/ and private fixtures):
  { file: 'control-sheet-tests.js', needs: ['../apps-script/WebApp.gs', 'fixtures/mock-stream-tabs.json'] },
  { file: 'apps-script-imports-tests.js', needs: ['../apps-script/Code.gs'] },
  { file: 'menu-tests.js', needs: ['../apps-script/Menu.gs'] }
];

let failed = false;
for (const suite of SUITES) {
  const missing = [suite.file, ...(suite.needs || [])].filter(f => !fs.existsSync(path.join(__dirname, f)));
  if (missing.length) {
    console.log(`- skipped ${suite.file} (not in this copy: ${missing.join(', ')})`);
    continue;
  }
  console.log(`\n=== ${suite.file} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, suite.file)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed = true;
    console.error(`✗ ${suite.file} failed`);
  }
}
process.exit(failed ? 1 : 0);
