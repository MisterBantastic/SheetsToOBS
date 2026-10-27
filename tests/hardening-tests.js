/**
 * Regression tests for the fixes made before the first public release:
 * column mapping, Image/Video transitions, control-sheet race, config safety,
 * experimental gating, CSP / shutdown guards and the LAN access code.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetstoobs-hardening-'));
process.env.SHEETSTOOBS_DATA_DIR = TMP;
delete process.env.SHEETSTOOBS_EXPERIMENTAL;

const ConfigManager = require('../src/engine/config-manager');
const ImporterEngine = require('../src/engine/importer-engine');
const ControlSheet = require('../src/engine/control-sheet');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n`, err);
    process.exit(1);
  }
}

function writeConfig(file, extra = {}, profile = {}) {
  fs.writeFileSync(file, JSON.stringify({
    activeProfile: 'P',
    profiles: { P: { sheetId: 'sheet', apikey: 'key', tabname: 'Interface', range: 'C2:D', ...profile } },
    ...extra
  }, null, 2));
}

function request(port, p, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

/** Minimal fake OBS that records calls. */
function fakeObs(state) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args, at: Date.now() });
      if (name === 'GetInputSettings') return { inputSettings: { ...state.settings } };
      if (name === 'SetInputSettings') Object.assign(state.settings, args.inputSettings);
      if (name === 'SetSceneItemEnabled') state.enabled = args.sceneItemEnabled;
      return {};
    }
  };
}

(async () => {
  console.log('--- Hardening / regression tests ---');

  await test('columns map by position: empty Value column no longer shifts Label into Type', () => {
    const values = [['1', '2'], ['Team 1', 'Team 2'], ['Text', 'Text']]; // D and E omitted by Google
    const cols = ImporterEngine.mapColumns(values, 'A2:E');
    assert.deepStrictEqual(cols.labelCol, ['Team 1', 'Team 2']);
    assert.deepStrictEqual(cols.typeCol, ['Text', 'Text']);
    assert.deepStrictEqual(cols.valCol, []);
    const cd = ImporterEngine.mapColumns([['Text'], ['Hello']], 'C2:D');
    assert.deepStrictEqual(cd.typeCol, ['Text']);
    assert.deepStrictEqual(cd.valCol, ['Hello']);
  });

  await test('fetchSheetData keeps Type/Value aligned when column D is empty', async () => {
    const cm = { load: () => ({ sheetId: 's', apikey: 'k', tabname: 'T', range: 'C2:D', dimension: 'COLUMNS', activeProfile: 'P' }) };
    const engine = new ImporterEngine(cm);
    engine.on('log', () => {});
    const orig = ImporterEngine.httpGetJson;
    ImporterEngine.httpGetJson = async () => ({ values: [['1'], ['Team 1'], ['Text']] });
    try {
      const [typeCol, valCol] = await engine.fetchSheetData();
      assert.deepStrictEqual(typeCol, ['Text']);
      assert.deepStrictEqual(valCol, []);
      assert.strictEqual(engine.rawSheetData[0].label, 'Team 1');
      assert.strictEqual(engine.rawSheetData[0].value, '');
    } finally {
      ImporterEngine.httpGetJson = orig;
    }
  });

  await test('Image ?show; swaps the file BEFORE showing (no flash of the old image)', async () => {
    const cm = { load: () => ({}) };
    const engine = new ImporterEngine(cm);
    engine.on('log', () => {});
    const state = { settings: { file: 'old.png' }, enabled: false };
    engine.obs = fakeObs(state);
    engine.obsStatus.connected = true;
    const tags = ImporterEngine.parseCellTags('?show;new.png');
    const source = { sourceName: 'Logo |sheet 2', sceneItemId: 1, sceneItemEnabled: false };
    await engine.applySourceUpdate('Scene', source, 'Image', '?show;new.png', tags, {}, {});
    const order = engine.obs.calls.filter(c => c.name.startsWith('Set')).map(c => c.name);
    assert.deepStrictEqual(order, ['SetInputSettings'], 'only the file is set immediately');
    await new Promise(r => setTimeout(r, 900));
    const after = engine.obs.calls.filter(c => c.name.startsWith('Set')).map(c => c.name);
    assert.deepStrictEqual(after, ['SetInputSettings', 'SetSceneItemEnabled']);
    assert.strictEqual(state.enabled, true);
    assert.strictEqual(state.settings.file, 'new.png');
  });

  await test('Image ?hide; hides once, then swaps the file while hidden', async () => {
    const engine = new ImporterEngine({ load: () => ({}) });
    engine.on('log', () => {});
    const state = { settings: { file: 'old.png' }, enabled: true };
    engine.obs = fakeObs(state);
    engine.obsStatus.connected = true;
    const tags = ImporterEngine.parseCellTags('?hide;new.png');
    const source = { sourceName: 'Logo |sheet 2', sceneItemId: 1, sceneItemEnabled: true };
    await engine.applySourceUpdate('Scene', source, 'Image', '?hide;new.png', tags, {}, {});
    const hides = engine.obs.calls.filter(c => c.name === 'SetSceneItemEnabled');
    assert.strictEqual(hides.length, 1, 'hide must be sent exactly once');
    assert.strictEqual(state.settings.file, 'old.png', 'file not swapped while still visible');
    await new Promise(r => setTimeout(r, 1700));
    assert.strictEqual(state.settings.file, 'new.png');
  });

  await test('visibility follows the sheet even if someone toggled it in OBS', async () => {
    const engine = new ImporterEngine({ load: () => ({}) });
    engine.on('log', () => {});
    const state = { settings: {}, enabled: true };
    engine.obs = fakeObs(state);
    engine.obsStatus.connected = true;
    engine.visibilityStateMap.set('Scene::1', false); // cache says hidden ...
    const tags = ImporterEngine.parseCellTags('show');
    // ... but OBS reports it visible and the sheet says hide
    await engine.applySourceUpdate('Scene', { sourceName: 'X |sheet 2', sceneItemId: 1, sceneItemEnabled: true }, 'HS', 'hide', tags, {}, {});
    assert.strictEqual(state.enabled, false);
  });

  await test('control sheet: an edit during a refresh no longer crashes the refresh', async () => {
    let release;
    const gate = new Promise(r => (release = r));
    const cfg = { activeProfile: 'p', scriptUrl: 'https://script.google.com/macros/s/abc/exec', scriptToken: 't', controlTabName: 'Stream1' };
    const fetchImpl = async (url, opts) => {
      const b = JSON.parse(opts.body);
      if (b.action === 'snapshot' && b.optionCells.length === 0) await gate;
      return { status: 200, text: async () => JSON.stringify({ ok: true, version: '1.4.0', values: [], options: {} }) };
    };
    const cs = new ControlSheet({ load: () => cfg }, { fetchImpl });
    await cs.snapshot('Stream1', { withOptions: true });
    const pending = cs.snapshot('Stream1', { fresh: true });
    await new Promise(r => setTimeout(r, 10));
    cs.optionsCache.delete('Stream1');
    release();
    const data = await pending;
    assert.deepStrictEqual(data.options, {});
  });

  await test('config: saves are atomic, keep a .bak, and survive a corrupted file', () => {
    const file = path.join(TMP, 'atomic.json');
    writeConfig(file);
    const cm = new ConfigManager(file);
    assert.ok(cm.save({ tabname: 'One' }).success);
    assert.ok(cm.save({ tabname: 'Two' }).success);
    assert.ok(fs.existsSync(`${file}.bak`), '.bak written');
    assert.strictEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).profiles.P.tabname, 'One');
    fs.writeFileSync(file, '{ "activeProfile": "P", "profi'); // simulated power cut
    const origErr = console.error;
    console.error = () => {};
    try {
      const recovered = new ConfigManager(file).load();
      assert.strictEqual(recovered.tabname, 'One', 'falls back to the last good backup');
    } finally {
      console.error = origErr;
    }
    assert.ok(fs.readdirSync(TMP).some(f => f.startsWith('atomic.json.corrupt-')), 'damaged file kept aside');
  });

  await test('config: app-wide keys sent with a profile save are not stored in the profile', () => {
    const file = path.join(TMP, 'globals.json');
    writeConfig(file, { experimentalControlSheet: true });
    const cm = new ConfigManager(file);
    cm.save({ tabname: 'X', activeProfile: 'Hacked', profilesList: ['a'], permissions: {}, experimentalControlSheet: false });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(raw.profiles.P.profilesList, undefined);
    assert.strictEqual(raw.profiles.P.permissions, undefined);
    assert.strictEqual(raw.activeProfile, 'P');
    assert.strictEqual(raw.experimentalControlSheet, true, 'unknown top-level settings are preserved');
    assert.strictEqual(cm.createProfile('__proto__').success, false);
  });

  const DesktopServer = require('../src/server');

  await test('server: experimental control sheet is OFF by default; CSP sent; shutdown is POST-only', async () => {
    const file = path.join(TMP, 'server-off.json');
    writeConfig(file);
    const srv = new DesktopServer(4621, file);
    const server = srv.start();
    await new Promise(r => setTimeout(r, 150));
    try {
      assert.strictEqual(server.address().address, '127.0.0.1', 'listens on this PC only');
      assert.strictEqual((await request(4621, '/dashboard')).status, 404);
      assert.strictEqual((await request(4621, '/dashboard.js')).status, 404);
      assert.strictEqual((await request(4621, '/api/sheet-control/layout')).status, 404);
      const page = await request(4621, '/');
      assert.strictEqual(page.status, 200);
      assert.ok(/script-src 'self'/.test(page.headers['content-security-policy'] || ''), 'CSP header present');
      const cfg = JSON.parse((await request(4621, '/api/config')).body);
      assert.strictEqual(cfg.experimentalControlSheet, false);
      const getShutdown = await request(4621, '/api/shutdown');
      assert.notStrictEqual(getShutdown.status, 200, 'GET must not shut the server down');
    } finally {
      clearInterval(srv.watchdogInterval);
      server.close();
    }
  });

  await test('server: experimental flag in config.json switches the dashboard on', async () => {
    const file = path.join(TMP, 'server-on.json');
    writeConfig(file, { experimentalControlSheet: true });
    const srv = new DesktopServer(4622, file);
    const server = srv.start();
    await new Promise(r => setTimeout(r, 150));
    try {
      assert.strictEqual((await request(4622, '/dashboard')).status, 200);
      assert.strictEqual((await request(4622, '/api/sheet-control/layout')).status, 200);
    } finally {
      clearInterval(srv.watchdogInterval);
      server.close();
    }
  });

  await test('LAN access code: required, compared exactly, brute force is throttled', () => {
    const file = path.join(TMP, 'lan.json');
    writeConfig(file, { experimentalControlSheet: true }, { allowLanDashboard: true });
    const srv = new DesktopServer(4623, file);
    const code = srv.configManager.getLanAccessCode();
    assert.ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code));
    const fakeRes = () => ({ status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b; } });
    const url = new URL('http://x/api/status');
    let res = fakeRes();
    assert.strictEqual(srv.checkAccessCode({ headers: {} }, url, '10.0.0.5', res), false);
    assert.strictEqual(res.status, 401);
    res = fakeRes();
    assert.strictEqual(srv.checkAccessCode({ headers: { 'x-access-code': code.toLowerCase() } }, url, '10.0.0.5', res), true);
    for (let i = 0; i < 10; i++) srv.checkAccessCode({ headers: { 'x-access-code': 'WRONG-CODE' } }, url, '10.0.0.9', fakeRes());
    res = fakeRes();
    assert.strictEqual(srv.checkAccessCode({ headers: { 'x-access-code': code } }, url, '10.0.0.9', res), false);
    assert.strictEqual(res.status, 429, 'locked out after repeated wrong codes');
    assert.ok(!JSON.stringify(srv.configManager.exportAll(false)).includes(code), 'code never in a clean export');
  });

  await test('sharing: clean export strips Sheet ID + keys; "include sheet access" keeps only Sheet ID + API key', () => {
    const file = path.join(TMP, 'share.json');
    writeConfig(file, {}, { sheetId: 'SHEET123', apikey: 'AIzaKEY', obsauth: 'obs-pass', scriptToken: 'tok' });
    const cm = new ConfigManager(file);
    const clean = cm.exportProfile(null, false).config;
    assert.strictEqual(clean.sheetId, '');
    assert.strictEqual(clean.apikey, undefined);
    assert.strictEqual(clean.obsauth, undefined);
    const shared = cm.exportProfile(null, false, { includeSheetAccess: true }).config;
    assert.strictEqual(shared.sheetId, 'SHEET123');
    assert.strictEqual(shared.apikey, 'AIzaKEY');
    assert.strictEqual(shared.obsauth, undefined, 'OBS password is never shared');
    assert.strictEqual(shared.scriptToken, undefined, 'bridge token is never shared');
    const all = cm.exportAll(false, { includeSheetAccess: true });
    assert.strictEqual(all.profiles.P.apikey, 'AIzaKEY');
    assert.strictEqual(all.profiles.P.obsauth, undefined);
    const full = cm.exportProfile(null, true).config;
    assert.strictEqual(full.obsauth, 'obs-pass', 'full backup still has everything');
  });

  await test('server: Personalization toggle switches the Control Sheet on and off without a restart', async () => {
    const file = path.join(TMP, 'toggle.json');
    writeConfig(file);
    const srv = new DesktopServer(4624, file);
    const server = srv.start();
    await new Promise(r => setTimeout(r, 150));
    try {
      assert.strictEqual((await request(4624, '/dashboard')).status, 404);
      const on = JSON.parse((await request(4624, '/api/settings/experimental', { method: 'POST', body: { controlSheet: true } })).body);
      assert.strictEqual(on.experimentalControlSheet, true);
      assert.strictEqual((await request(4624, '/dashboard')).status, 200);
      const off = JSON.parse((await request(4624, '/api/settings/experimental', { method: 'POST', body: { controlSheet: false } })).body);
      assert.strictEqual(off.experimentalControlSheet, false);
      assert.strictEqual((await request(4624, '/dashboard')).status, 404);
      const share = JSON.parse((await request(4624, '/api/profiles/export?profile=P&clean=true&sheetAccess=1')).body);
      assert.strictEqual(share.config.apikey, 'key');
      assert.strictEqual(share.config.sheetId, 'sheet');
    } finally {
      clearInterval(srv.watchdogInterval);
      server.close();
    }
  });

  console.log(`\n${passed} hardening tests passed.`);
  process.exit(0);
})();
