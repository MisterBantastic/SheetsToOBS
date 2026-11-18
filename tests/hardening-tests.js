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
    engine.isRunning = true;
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
    engine.isRunning = true;
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

  await test('scene collection lock: wrong collection blocks every OBS change, right one syncs', async () => {
    let required = 'Main Show';
    const cm = { load: () => ({ sheetId: 's', apikey: 'k', tabname: 'T', range: 'C2:D', activeProfile: 'P', requiredSceneCollection: required }) };
    const engine = new ImporterEngine(cm);
    const logs = [];
    engine.on('log', l => logs.push(l));
    const state = { collection: 'Test Scenes', settings: { text: 'old' } };
    const calls = [];
    let sheetFetches = 0;
    engine.obs = {
      async call(name, args) {
        calls.push(name);
        if (name === 'GetSceneCollectionList') return { currentSceneCollectionName: state.collection, sceneCollections: ['Main Show', 'Test Scenes'] };
        if (name === 'GetSceneList') return { scenes: [{ sceneName: 'Scene' }] };
        if (name === 'GetGroupList') return { groups: [] };
        if (name === 'GetSceneItemList') return { sceneItems: [{ sourceName: 'Title |sheet 2', sceneItemId: 1, sceneItemEnabled: true }] };
        if (name === 'GetInputSettings') return { inputSettings: { ...state.settings } };
        if (name === 'SetInputSettings') Object.assign(state.settings, args.inputSettings);
        return {};
      }
    };
    engine.obsStatus.connected = true;
    const orig = ImporterEngine.httpGetJson;
    ImporterEngine.httpGetJson = async () => { sheetFetches++; return { values: [['1'], ['Title'], ['Text'], ['new']] }; };
    try {
      await engine.updateCycle();
      assert.strictEqual(state.settings.text, 'old', 'nothing written in the wrong collection');
      assert.ok(!calls.includes('SetInputSettings') && !calls.includes('SetSceneItemEnabled'));
      assert.strictEqual(sheetFetches, 0, 'sheet is not even read');
      assert.strictEqual(engine.obsStatus.sceneCollectionMismatch, true);
      assert.ok(logs.some(l => l.level === 'error' && /WRONG SCENE COLLECTION/.test(l.message)));
      const errorsBefore = logs.filter(l => l.level === 'error').length;
      await engine.updateCycle();
      assert.strictEqual(logs.filter(l => l.level === 'error').length, errorsBefore, 'error logged once, not every poll');

      state.collection = 'main show'; // case / spacing differences are tolerated
      await engine.updateCycle();
      assert.strictEqual(engine.obsStatus.sceneCollectionMismatch, false);
      assert.strictEqual(state.settings.text, 'new', 'syncs once the right collection is open');

      required = '';
      state.collection = 'Anything';
      state.settings.text = 'x';
      await engine.updateCycle();
      assert.strictEqual(state.settings.text, 'new', 'no lock configured: any collection syncs');
    } finally {
      ImporterEngine.httpGetJson = orig;
    }
  });

  await test('scene collection lock: blocks while OBS is switching collections', async () => {
    const engine = new ImporterEngine({ load: () => ({ requiredSceneCollection: 'Main Show' }) });
    engine.on('log', () => {});
    engine.obs = { async call() { return { currentSceneCollectionName: 'Main Show' }; } };
    assert.strictEqual(await engine.checkSceneCollection(), true);
    engine.sceneCollectionChanging = true;
    assert.strictEqual(await engine.checkSceneCollection(), false);
  });

  // --- Update checks -------------------------------------------------------
  const updates = require('../src/engine/update-checker');
  const OBS_EXPORT = JSON.stringify({ name: 'CCS', sources: [{ name: 'Scene' }], scene_order: [] });

  await test('updates: version comparison', async () => {
    const c = updates.compareVersions;
    assert.strictEqual(c('0.2.1', '0.2.0'), 1);
    assert.strictEqual(c('v0.10.0', '0.9.9'), 1, 'numeric, not alphabetical');
    assert.strictEqual(c('1.2', '1.2.0'), 0);
    assert.strictEqual(c('1.2.0-beta', '1.2.0'), -1, 'pre-release sorts before release');
    assert.strictEqual(c('0.2.0', '0.2.1'), -1);
  });

  await test('updates: GitHub release parsing only links to this project', async () => {
    const r = updates.parseRelease({ tag_name: 'v0.3.0', html_url: 'https://github.com/MisterBantastic/SheetsToOBS/releases/tag/v0.3.0', body: 'Notes' }, '0.2.0');
    assert.strictEqual(r.latest, '0.3.0');
    assert.strictEqual(r.newer, true);
    assert.ok(r.url.endsWith('/tag/v0.3.0'));
    const evil = updates.parseRelease({ tag_name: 'v9.0.0', html_url: 'https://evil.example/download' }, '0.2.0');
    assert.strictEqual(evil.url, updates.RELEASES_PAGE, 'foreign link replaced by the real release page');
    assert.strictEqual(updates.parseRelease({ tag_name: 'v0.2.0' }, '0.2.0').newer, false);
    assert.throws(() => updates.parseRelease({ tag_name: '<script>' }, '0.2.0'));
  });

  await test('updates: scene collection manifest is validated', async () => {
    const m = updates.parseManifest({ name: 'CCS', version: '1.4', url: 'files/CCS.json' }, 'https://example.com/obs/manifest.json');
    assert.strictEqual(m.url, 'https://example.com/obs/files/CCS.json', 'relative url resolved against the manifest');
    assert.throws(() => updates.parseManifest({ version: '1.4', url: 'http://example.com/CCS.json' }, 'https://example.com/m.json'), /https/);
    assert.throws(() => updates.parseManifest({ url: 'CCS.json' }, 'https://example.com/m.json'), /version/);
    assert.throws(() => updates.parseManifest({ version: '1', url: 'a.json', sha256: 'abc' }, 'https://example.com/m.json'), /sha256/);
    assert.throws(() => updates.parseManifest([1], 'https://example.com/m.json'));

    const get = async () => ({ name: 'CCS', version: '1.4.0', url: 'CCS.json' });
    assert.strictEqual((await updates.checkSceneCollection('https://example.com/m.json', '', { get })).newer, true, 'nothing recorded yet = offer it');
    assert.strictEqual((await updates.checkSceneCollection('https://example.com/m.json', '1.4.0', { get })).newer, false);
    assert.strictEqual((await updates.checkSceneCollection('https://example.com/m.json', '1.3.9', { get })).newer, true);
    await assert.rejects(updates.checkSceneCollection('http://example.com/m.json', '', { get }), /https/);
  });

  await test('updates: downloaded file must be an OBS export (and match sha256 if given)', async () => {
    const buf = Buffer.from(OBS_EXPORT);
    assert.ok(updates.validateSceneCollection(Buffer.from('﻿' + OBS_EXPORT)), 'BOM tolerated');
    assert.throws(() => updates.validateSceneCollection(Buffer.from('<html>')), /not valid JSON/);
    assert.throws(() => updates.validateSceneCollection(Buffer.from('{"version":"1"}')), /scene collection/);
    const sha = require('crypto').createHash('sha256').update(buf).digest('hex');
    assert.ok(updates.validateSceneCollection(buf, sha));
    assert.throws(() => updates.validateSceneCollection(buf, 'f'.repeat(64)), /sha256/);

    const dir = path.join(TMP, 'collections');
    const saved = await updates.downloadSceneCollection(
      { name: '..\\..\\evil', version: '1.0/..', url: 'https://example.com/x.json', sha256: '' },
      { get: async () => buf, dir }
    );
    assert.strictEqual(path.dirname(saved.filePath), dir, 'name cannot escape the folder');
    assert.ok(!saved.fileName.includes('\\') && !saved.fileName.includes('/'));
    assert.strictEqual(fs.readFileSync(saved.filePath, 'utf8'), OBS_EXPORT);
  });

  await test('updates: config keys (app-wide vs profile, clean export, https only)', async () => {
    const file = path.join(TMP, 'updates-config.json');
    writeConfig(file, {}, { sceneCollectionManifestUrl: 'https://example.com/m.json', sceneCollectionVersion: '1.2', sceneCollectionSkippedVersion: '1.3' });
    const cm = new ConfigManager(file);
    assert.strictEqual(cm.load().checkForAppUpdates, true, 'on by default');
    cm.setUpdateSettings({ checkForAppUpdates: false, skippedAppVersion: '0.3.0' });
    cm.save({ ...cm.load(), polling: 2000 });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(raw.checkForAppUpdates, false);
    assert.strictEqual(raw.profiles.P.checkForAppUpdates, undefined, 'not stored per profile');
    assert.strictEqual(raw.profiles.P.skippedAppVersion, undefined);

    const clean = cm.exportProfile('P', false);
    assert.strictEqual(clean.config.sceneCollectionManifestUrl, 'https://example.com/m.json', 'manifest URL is shared');
    assert.strictEqual(clean.config.sceneCollectionVersion, '', 'installed version is this PC only');
    assert.strictEqual(clean.config.sceneCollectionSkippedVersion, '', 'ignored version is this PC only');
    assert.strictEqual(cm.exportProfile('P', true).config.sceneCollectionVersion, '1.2', 'full backup keeps it');

    assert.strictEqual(cm.save({ sceneCollectionManifestUrl: 'http://example.com/m.json' }).success, false);
    assert.strictEqual(cm.load().sceneCollectionManifestUrl, 'https://example.com/m.json', 'bad URL not saved');
  });

  await test('server: update endpoints (one check per start, ignore, server-side manifest download)', async () => {
    const file = path.join(TMP, 'server-updates.json');
    writeConfig(file, {}, { sceneCollectionManifestUrl: 'https://example.com/obs/m.json' });
    const dir = path.join(TMP, 'server-collections');
    let appChecks = 0;
    const fetched = [];
    const fakeGet = async (url) => {
      fetched.push(url);
      return url.endsWith('m.json') ? { name: 'CCS', version: '2.0', url: 'CCS.json' } : Buffer.from(OBS_EXPORT);
    };
    const srv = new DesktopServer(4625, file);
    srv.updateChecker = {
      ...updates,
      checkApp: async () => { appChecks++; return updates.parseRelease({ tag_name: 'v9.9.9' }, updates.appVersion()); },
      checkSceneCollection: (u, v) => updates.checkSceneCollection(u, v, { get: fakeGet }),
      downloadSceneCollection: (m) => updates.downloadSceneCollection(m, { get: fakeGet, dir })
    };
    const server = srv.start();
    await new Promise(r => setTimeout(r, 150));
    try {
      const a = JSON.parse((await request(4625, '/api/updates/app')).body);
      assert.strictEqual(a.newer, true);
      assert.strictEqual(a.skipped, false);
      await request(4625, '/api/updates/app');
      assert.strictEqual(appChecks, 1, 'GitHub is asked once per start (window reloads reuse it)');
      await request(4625, '/api/updates/app?force=1');
      assert.strictEqual(appChecks, 2, '"Check now" always asks GitHub');
      await request(4625, '/api/updates/settings', { method: 'POST', body: { skippedAppVersion: '9.9.9' } });
      assert.strictEqual(JSON.parse((await request(4625, '/api/updates/app')).body).skipped, true);
      assert.strictEqual(JSON.parse((await request(4625, '/api/updates/app?force=1')).body).skipped, false, 'manual check still reports it');

      const cross = await request(4625, '/api/updates/scene-collection/download', { method: 'POST', headers: { Origin: 'https://evil.example' } });
      assert.strictEqual(cross.status, 403, 'other websites cannot trigger a download');

      const s = JSON.parse((await request(4625, '/api/updates/scene-collection')).body);
      assert.strictEqual(s.newer, true);
      assert.strictEqual(s.skipped, false);
      await request(4625, '/api/updates/scene-collection/skip', { method: 'POST' });
      assert.strictEqual(new ConfigManager(file).load().sceneCollectionSkippedVersion, '2.0');
      assert.strictEqual(JSON.parse((await request(4625, '/api/updates/scene-collection')).body).skipped, true, 'ignored version stays quiet');
      assert.strictEqual(JSON.parse((await request(4625, '/api/updates/scene-collection?force=1')).body).skipped, false, 'Check now still reports it');
      const d = JSON.parse((await request(4625, '/api/updates/scene-collection/download', { method: 'POST', body: { url: 'https://evil.example/x.json' } })).body);
      assert.strictEqual(d.success, true, d.error);
      assert.ok(fetched.includes('https://example.com/obs/CCS.json'), 'file URL comes from the manifest');
      assert.ok(!fetched.some(u => u.includes('evil')), 'URL in the request body is ignored');
      assert.ok(fs.existsSync(d.filePath));
      assert.strictEqual(new ConfigManager(file).load().sceneCollectionVersion, '2.0', 'version recorded');
      assert.strictEqual(JSON.parse((await request(4625, '/api/updates/scene-collection')).body).newer, false);
    } finally {
      clearInterval(srv.watchdogInterval);
      server.close();
    }
  });

  // --- Share a scene collection / Setup Check ------------------------------
  const sceneShare = require('../src/engine/scene-share');
  const setupCheck = require('../src/engine/setup-check');
  const SE = 'https://streamelements.com/overlay/aaaaaaaaaaaaaaaaaaaaaaaa/' + 'b'.repeat(48);
  const sampleCollection = () => ({
    name: 'Show',
    sources: [
      { id: 'browser_source', name: 'SE Break |sheet 605', settings: { url: SE } },
      { id: 'browser_source', name: 'Subscribe', settings: { url: SE } },
      { id: 'text_gdiplus', name: 'Talent |sheet 2', settings: { text: 'x', url: 'https://vdo.ninja/?view=a&room=secret&password=pw', font: { face: 'Gobold' } } },
      { id: 'browser_source', name: 'Plain', settings: { url: 'https://github.com/x/y/blob/main/a.png?raw=true' } },
      { id: 'ffmpeg_source', name: 'Sound', settings: { local_file: 'C:/Users/Someone/Desktop/CCS Media/Song.mp3' } },
      { id: 'vlc_source', name: 'Reactions', settings: { playlist: [{ value: 'D:\\Work\\Reaction Videos\\' }, { value: 'D:\\Work\\Reaction Videos\\R1.mp4' }] } },
      { id: 'source_switcher', name: 'Switch', settings: {} },
      { id: 'xObsAsyncImageSource', name: 'Img', settings: { file: 'https://example.com/a.png' } }
    ],
    transitions: [{ id: 'obs_stinger_transition', name: 'Stinger', settings: { path: 'G:/Prod/CCS Prod Media/Stinger.mp4' } }],
    modules: {
      'advanced-scene-switcher': {
        macros: [{ conditions: [{ filePath: 'G:/Prod/CCS Prod Media/Top.png', modelPath: 'C:\\ProgramData\\obs-studio/plugins/advanced-scene-switcher/data/x.xml' }] }]
      }
    }
  });
  const sampleMedia = [
    { file: 'Song.mp3', buffer: Buffer.from('song') },
    { file: 'Stinger.mp4', buffer: Buffer.from('stinger') },
    { file: 'Top.png', buffer: Buffer.from('top') },
    { file: 'Unused.webm', buffer: Buffer.from('unused') }
  ];

  await test('share: private URLs detected (StreamElements overlay, key/password/room params)', async () => {
    assert.strictEqual(sceneShare.isPrivateUrl(SE), true);
    assert.strictEqual(sceneShare.isPrivateUrl('https://modelviewer.lol/embed?id=1&key=abc'), true);
    assert.strictEqual(sceneShare.isPrivateUrl('https://vdo.ninja/?view=a&room=r'), true);
    assert.strictEqual(sceneShare.isPrivateUrl('https://github.com/x/y/blob/main/a.png?raw=true'), false);
    assert.strictEqual(sceneShare.isPrivateUrl('https://streamelements.com/dashboard'), false);
  });

  await test('share: prepare blanks sheet-linked secrets, tokenizes media paths, detects requirements', async () => {
    const pkg = sceneShare.prepare(JSON.stringify(sampleCollection()), {
      version: '1.1', mediaFiles: sampleMedia, installedPlugins: { 'source-switcher': '0.4.4' }, leagueEsportsTimers: true,
      links: [{ label: 'Sheet', url: 'https://docs.google.com/x' }, { label: 'Bad', url: 'http://x' }]
    });
    const out = pkg.collectionBuffer.toString();
    const col = JSON.parse(out);
    assert.strictEqual(col.sources[0].settings.url, '', 'sheet-linked SE overlay removed');
    assert.strictEqual(col.sources[2].settings.url, '', 'stale VDO.Ninja room on a sheet text source removed');
    assert.strictEqual(col.sources[1].settings.url, SE, 'unlinked source kept...');
    assert.deepStrictEqual(pkg.report.warnings.map(w => w.source), ['Subscribe'], '...but reported');
    assert.ok(!out.includes('password=pw'));
    assert.strictEqual(col.sources[3].settings.url, 'https://github.com/x/y/blob/main/a.png?raw=true', 'public URLs untouched');
    assert.strictEqual(col.sources[4].settings.local_file, '{{MEDIA}}/Song.mp3');
    assert.strictEqual(col.transitions[0].settings.path, '{{MEDIA}}/Stinger.mp4', 'stinger transitions fixed');
    assert.strictEqual(col.modules['advanced-scene-switcher'].macros[0].conditions[0].filePath, '{{MEDIA}}/Top.png', 'macro paths fixed');
    assert.ok(col.modules['advanced-scene-switcher'].macros[0].conditions[0].modelPath.includes('obs-studio'), 'plugin data paths untouched');
    assert.ok(!out.includes('Someone'), 'personal paths of shipped files are gone');
    assert.deepStrictEqual(pkg.report.optional.map(o => o.name), ['Reaction Videos'], 'files inside an optional folder are grouped under it');
    assert.deepStrictEqual(pkg.report.unusedMedia, ['Unused.webm']);
    const m = pkg.manifest;
    assert.deepStrictEqual(m.media.map(x => x.file).sort(), ['Song.mp3', 'Stinger.mp4', 'Top.png']);
    assert.strictEqual(m.sha256, require('crypto').createHash('sha256').update(pkg.collectionBuffer).digest('hex'));
    assert.deepStrictEqual(m.requirements.plugins.map(p => p.id).sort(), ['advanced-scene-switcher', 'source-switcher', 'xObsAsyncImageSource']);
    assert.strictEqual(m.requirements.plugins.find(p => p.id === 'source-switcher').minVersion, '0.4.4', 'tested-on version');
    assert.deepStrictEqual(m.requirements.fonts, ['Gobold']);
    assert.strictEqual(m.requirements.leagueEsportsTimers, true);
    assert.deepStrictEqual(m.links, [{ label: 'Sheet', url: 'https://docs.google.com/x' }, { label: 'Bad', url: '' }], 'a non-https link is dropped, the step stays');
    assert.deepStrictEqual(m.optionalMedia, ['Reaction Videos']);

    const all = sceneShare.prepare(JSON.stringify(sampleCollection()), { version: '1', blankUnlinked: true });
    assert.strictEqual(JSON.parse(all.collectionBuffer.toString()).sources[1].settings.url, '', '"Also remove" blanks unlinked sources too');
    assert.throws(() => sceneShare.prepare('{"no":"sources"}', { version: '1' }), /scene collection/);
    assert.throws(() => sceneShare.prepare(JSON.stringify(sampleCollection()), { version: '../x' }), /version/);
  });

  await test('share: producer download fetches media and points paths at the media folder', async () => {
    const pkg = sceneShare.prepare(JSON.stringify(sampleCollection()), { version: '2.0', mediaFiles: sampleMedia });
    const files = { 'https://example.com/obs/manifest.json': pkg.manifest };
    files[new URL(pkg.manifest.url, 'https://example.com/obs/manifest.json').toString()] = pkg.collectionBuffer;
    sampleMedia.forEach(m => { files[`https://example.com/obs/media/${encodeURIComponent(m.file)}`] = m.buffer; });
    const fetched = [];
    const get = async (url) => { fetched.push(url); if (!(url in files)) throw new Error(`404 ${url}`); return files[url]; };

    const info = await updates.checkSceneCollection('https://example.com/obs/manifest.json', '', { get });
    assert.strictEqual(info.media.length, 3);
    const mediaDir = path.join(TMP, 'producer media');
    const dir = path.join(TMP, 'producer-collections');
    const saved = await updates.downloadSceneCollection(info, { get, dir, mediaDir });
    assert.strictEqual(saved.mediaDownloaded, 3);
    assert.strictEqual(fs.readFileSync(path.join(mediaDir, 'Stinger.mp4'), 'utf8'), 'stinger');
    const col = JSON.parse(fs.readFileSync(saved.filePath, 'utf8'));
    const expected = `${mediaDir.replace(/\\/g, '/')}/Stinger.mp4`;
    assert.strictEqual(col.transitions[0].settings.path, expected);
    assert.ok(!fs.readFileSync(saved.filePath, 'utf8').includes('{{MEDIA}}'));

    fetched.length = 0;
    const again = await updates.downloadSceneCollection(info, { get, dir, mediaDir });
    assert.strictEqual(again.mediaSkipped, 3, 'files already there are not downloaded again');
    assert.ok(!fetched.some(u => u.includes('/media/')));

    fs.writeFileSync(path.join(mediaDir, 'Top.png'), 'changed');
    files['https://example.com/obs/media/Top.png'] = Buffer.from('tampered');
    await assert.rejects(updates.downloadSceneCollection(info, { get, dir, mediaDir }), /sha256/, 'tampered media refused');

    assert.throws(() => updates.parseManifest({ version: '1', url: 'a.json', media: [{ file: '../evil.exe', url: 'x' }] }, 'https://e.com/m.json'), /plain file name/);
    assert.throws(() => updates.parseManifest({ version: '1', url: 'a.json', media: [{ file: 'a.png', url: 'http://e.com/a.png' }] }, 'https://e.com/m.json'), /https/);
  });

  await test('setup check: League esports timers are added safely', async () => {
    const e = setupCheck.enableEsportsTimers;
    const h = setupCheck.hasEsportsTimers;
    const plain = '[General]\r\nWidth=1920\r\n';
    const fixed = e(plain);
    assert.ok(h(fixed));
    assert.ok(fixed.includes('\r\n[Spectator]\r\neSportsNeutralTimers=1'), 'keeps Windows line endings');
    assert.ok(fixed.startsWith('[General]\r\nWidth=1920'), 'rest of the file untouched');
    assert.ok(h(e('[Spectator]\nFoo=1\n[Other]\nX=1')), 'key added to an existing section');
    assert.ok(h(e('[Spectator]\neSportsNeutralTimers=0\n')), '0 turned into 1');
    assert.strictEqual(e(e(plain)), e(plain), 'running it twice changes nothing');
    assert.strictEqual(h('[Other]\neSportsNeutralTimers=1'), false, 'must be in [Spectator]');

    const files = { 'C:\\ProgramData\\Riot Games\\RiotClientInstalls.json': JSON.stringify({ associated_client: { 'D:/Games/League of Legends/': 'x' } }) };
    files[path.normalize('D:/Games/League of Legends/Config/game.cfg')] = plain;
    const sys = {
      env: { ProgramData: 'C:\\ProgramData' },
      exists: p => p in files,
      readFile: p => files[p],
      writeFile: (p, d) => { files[p] = d; },
      copyFile: (a, b) => { files[b] = files[a]; }
    };
    const r = setupCheck.fixEsportsTimers(sys);
    const cfg = path.normalize('D:/Games/League of Legends/Config/game.cfg');
    assert.deepStrictEqual(r.changed, [cfg]);
    assert.strictEqual(files[`${cfg}.sheetstoobs-backup`], plain, 'original backed up');
    assert.ok(h(files[cfg]));
    assert.deepStrictEqual(setupCheck.fixEsportsTimers(sys).changed, [], 'nothing to do the second time');
  });

  /** Fake PC for runChecks: some plugins, some fonts, a game.cfg. */
  function fakePc({ pluginVersions = {}, fonts = [], cfg = '', mediaDir = '', mediaFiles = [] } = {}) {
    const files = new Set();
    const pf = 'C:\\Program Files';
    Object.keys(pluginVersions).forEach(id => files.add(path.join(pf, 'obs-studio', 'obs-plugins', '64bit', sceneShare.KNOWN_PLUGINS[id].dll)));
    const cfgPath = path.normalize('C:/Riot Games/League of Legends/Config/game.cfg');
    const texts = {};
    if (cfg) { files.add(cfgPath); texts[cfgPath] = cfg; }
    mediaFiles.forEach(f => files.add(path.join(mediaDir, f)));
    return {
      env: { ProgramFiles: pf, ProgramData: 'C:\\ProgramData' },
      exists: p => files.has(p),
      readFile: p => texts[p],
      async fileVersions(paths) {
        const out = {};
        paths.forEach(p => {
          const id = Object.keys(sceneShare.KNOWN_PLUGINS).find(k => p.endsWith(sceneShare.KNOWN_PLUGINS[k].dll));
          out[p] = pluginVersions[id];
        });
        return out;
      },
      async installedFonts() { return fonts; },
      async obsInstallDir() { return ''; }
    };
  }

  await test('setup check: reports plugins, versions, fonts, timers, media and optional files', async () => {
    const info = {
      name: 'Show', version: '2.0', installed: '2.0', newer: false,
      media: [{ file: 'Stinger.mp4' }, { file: 'Top.png' }],
      optionalMedia: ['Reaction Videos', 'CCS Music'],
      requirements: {
        plugins: [
          { id: 'advanced-scene-switcher', name: 'Advanced Scene Switcher', minVersion: '1.36.1', url: 'https://obsproject.com/a' },
          { id: 'move-transition', name: 'Move Transition', minVersion: '3.2.1', url: 'https://obsproject.com/m' },
          { id: 'source-switcher', name: 'Source Switcher', minVersion: '', url: '' }
        ],
        fonts: ['Gobold', 'Edo', 'Gobold Uplow'],
        leagueEsportsTimers: true
      },
      links: [{ label: 'Control Sheet edit access', url: 'https://docs.google.com/x' }]
    };
    const mediaDir = 'C:\\Media';
    const sys = fakePc({
      pluginVersions: { 'advanced-scene-switcher': '1.30.0', 'source-switcher': '0.4.4' },
      fonts: ['Gobold', 'Edo', 'Arial'],
      cfg: '[General]\nX=1\n',
      mediaDir,
      mediaFiles: ['Stinger.mp4']
    });
    const config = { activeProfile: 'P', sheetId: 's', apikey: 'k', obsaddress: 'ws://localhost:4455', sceneCollectionManifestUrl: 'https://e.com/m.json' };
    const items = await setupCheck.runChecks({ config, info, mediaDir, testObs: async () => ({ success: true, obsVersion: '32.2.2' }), sys });
    const by = Object.fromEntries(items.map(i => [i.id, i]));
    assert.strictEqual(by.obs.status, 'ok');
    assert.strictEqual(by['plugin:advanced-scene-switcher'].status, 'fail');
    assert.ok(/older than 1\.36\.1/.test(by['plugin:advanced-scene-switcher'].detail), 'old ASS flagged');
    assert.strictEqual(by['plugin:move-transition'].status, 'fail');
    assert.ok(/Not installed/.test(by['plugin:move-transition'].detail));
    assert.strictEqual(by['plugin:move-transition'].link, 'https://obsproject.com/m');
    assert.strictEqual(by['plugin:source-switcher'].status, 'ok');
    assert.strictEqual(by.fonts.status, 'fail');
    assert.ok(/Missing: Gobold Uplow\./.test(by.fonts.detail), '"Gobold" alone does not count as "Gobold Uplow"');
    assert.strictEqual(by['league-timers'].fix, 'league-timers');
    assert.strictEqual(by.media.status, 'fail');
    assert.ok(/1 of 2 missing.*Top\.png/.test(by.media.detail));
    assert.strictEqual(by['optional-media'].status, 'info', 'optional media never fails the check');
    assert.ok(/Reaction Videos, CCS Music/.test(by['optional-media'].detail));
    assert.strictEqual(items[items.length - 1].link, 'https://docs.google.com/x');

    const noManifest = await setupCheck.runChecks({ config: { ...config, sheetId: '', sceneCollectionManifestUrl: '' }, info: null, mediaDir, testObs: async () => ({ success: false, error: 'refused' }), sys });
    assert.deepStrictEqual(noManifest.map(i => `${i.id}:${i.status}`), ['profile:fail', 'obs:fail', 'manifest:warn']);
  });

  await test('server: setup check opens once per version; prepare writes a package; local folders not shared', async () => {
    const file = path.join(TMP, 'server-setup.json');
    writeConfig(file, {}, { mediaFolder: 'C:\\Media', publishMediaFolder: 'C:\\Admin\\Media' });
    const srv = new DesktopServer(4626, file);
    srv.setupSystem = fakePc({});
    srv.testObs = async () => ({ success: false, error: 'not running' });
    srv.readSheetRows = async () => null;
    const server = srv.start();
    await new Promise(r => setTimeout(r, 150));
    try {
      assert.strictEqual(JSON.parse((await request(4626, '/api/config')).body).setupCheckDue, true, 'due after install');
      const check = JSON.parse((await request(4626, '/api/setup-check')).body);
      assert.strictEqual(check.success, true);
      assert.deepStrictEqual(check.items.map(i => i.id), ['profile', 'obs', 'manifest']);
      await request(4626, '/api/setup-check/seen', { method: 'POST' });
      assert.strictEqual(JSON.parse((await request(4626, '/api/config')).body).setupCheckDue, false, 'not again on a normal start');

      const cross = await request(4626, '/api/setup-check/fix', { method: 'POST', body: { id: 'league-timers' }, headers: { Origin: 'https://evil.example' } });
      assert.strictEqual(cross.status, 403, 'other websites cannot edit game.cfg');
      const unknownFix = JSON.parse((await request(4626, '/api/setup-check/fix', { method: 'POST', body: { id: 'rm -rf' } })).body);
      assert.strictEqual(unknownFix.success, false);

      const mediaDir = path.join(TMP, 'admin-media');
      fs.mkdirSync(mediaDir, { recursive: true });
      sampleMedia.forEach(m => fs.writeFileSync(path.join(mediaDir, m.file), m.buffer));
      const prep = JSON.parse((await request(4626, '/api/publish/prepare', {
        method: 'POST',
        body: { collectionText: JSON.stringify(sampleCollection()), version: '3.0', mediaFolder: mediaDir, links: 'Sheet | https://docs.google.com/x', leagueEsportsTimers: true }
      })).body);
      assert.strictEqual(prep.success, true, prep.error);
      assert.ok(fs.existsSync(path.join(prep.outDir, 'manifest.json')));
      assert.ok(fs.existsSync(path.join(prep.outDir, 'media', 'Stinger.mp4')));
      assert.ok(!fs.existsSync(path.join(prep.outDir, 'media', 'Unused.webm')), 'unused media not shipped');
      assert.ok(fs.existsSync(path.join(prep.outDir, prep.collectionFile)));
      assert.strictEqual(new ConfigManager(file).load().lastPublishedVersion, '3.0');

      const clean = new ConfigManager(file).exportProfile('P', false).config;
      assert.strictEqual(clean.mediaFolder, '', 'producer media folder is this PC only');
      assert.strictEqual(clean.publishMediaFolder, '', 'admin media folder is this PC only');
    } finally {
      clearInterval(srv.watchdogInterval);
      server.close();
    }
  });

  // --- Setup kits made by any league's admin -------------------------------
  await test('kit: warns when the sheet will not refill a blanked browser source', async () => {
    const col = sampleCollection();
    col.sources.push({ id: 'browser_source', name: 'Visibility Only |sheet 700', settings: { url: SE } });
    col.sources.push({ id: 'browser_source', name: 'No Row |sheet 701', settings: { url: SE } });
    const sheetRows = { 605: { type: 'Browser', value: SE }, 700: { type: 'HS', value: 'show' } };
    const pkg = sceneShare.prepare(JSON.stringify(col), { version: '1', sheetRows });
    assert.deepStrictEqual(pkg.report.needsSheetRow.map(n => n.row), [700, 701], 'row 605 refills; 700 and 701 would stay empty');
    assert.strictEqual(JSON.parse(pkg.collectionBuffer.toString()).sources[8].settings.url, '', 'a secret never ships because of a sheet problem');
    assert.strictEqual(pkg.report.sheetChecked, true);
    assert.strictEqual(sceneShare.prepare(JSON.stringify(col), { version: '1' }).report.sheetChecked, false);
    assert.deepStrictEqual(sceneShare.sheetRowsFromValues([['1'], ['2', 'Label', 'Browser', 'https://x']])[2], { type: 'Browser', value: 'https://x' });
  });

  await test('kit: admin can require any plugin, including ones we do not know', async () => {
    assert.deepStrictEqual(sceneShare.scan(JSON.stringify({ name: 'L v1', sources: [{ id: 'streamfx-filter', name: 'x' }, { id: 'color_source_v3', name: 'y' }, { id: 'browser_source', name: 'z', filters: [{ id: 'composite_blur' }] }], modules: { 'advanced-scene-switcher': { macros: [{ id: 'not-a-source-type' }] } } })), {
      name: 'L', plugins: ['advanced-scene-switcher'], fonts: [], unknownKinds: ['composite_blur', 'streamfx-filter']
    }, 'built-in types and macro ids are not reported as unknown');

    const pf = 'C:\\Program Files';
    const pluginDir = path.join(pf, 'obs-studio', 'obs-plugins', '64bit');
    const customDll = path.join('C:\\ProgramData', 'obs-studio', 'plugins', 'composite-blur', 'bin', '64bit', 'composite-blur.dll');
    const sys = {
      env: { ProgramFiles: pf, ProgramData: 'C:\\ProgramData' },
      listDir: p => (p === pluginDir ? ['obs-filters.dll', 'libcef.dll', 'streamfx.dll', 'readme.txt'] : (p === path.join('C:\\ProgramData', 'obs-studio', 'plugins') ? ['composite-blur', 'empty-folder'] : [])),
      exists: p => p === customDll,
      fileVersions: async () => ({ [customDll]: '1.5.0' }),
      obsInstallDir: async () => '',
      installedFonts: async () => []
    };
    const found = await setupCheck.scanInstalledPlugins(sys);
    assert.deepStrictEqual(found.map(p => p.id), ['composite-blur', 'streamfx'], 'OBS built-ins and non-plugins left out');
    assert.strictEqual(found[0].version, '1.5.0');

    const reqs = updates.parseRequirements({ plugins: [
      { id: 'composite-blur', name: 'Composite Blur', dll: 'composite-blur.dll', minVersion: '1.6.0', url: 'https://example.com/blur' },
      { id: '..', name: 'Escape', dll: '../../evil.dll' },
      { id: 'ok', name: 'Bad dll', dll: '..\\evil.dll' }
    ] });
    assert.deepStrictEqual(reqs.plugins.map(p => p.id), ['composite-blur', 'ok'], 'path tricks in a plugin id are refused');
    assert.strictEqual(reqs.plugins[1].dll, '', 'path tricks in a dll name are refused');

    const items = await setupCheck.runChecks({
      config: { activeProfile: 'P', sheetId: 's', apikey: 'k', obsaddress: 'ws://x', sceneCollectionManifestUrl: 'https://league.example/m.json' },
      info: { name: 'L', version: '1', installed: '1', newer: false, media: [], optionalMedia: [], requirements: { plugins: [reqs.plugins[0]], fonts: [] }, links: [{ label: 'Join the Discord', url: '' }] },
      mediaDir: 'C:\\M',
      testObs: async () => ({ success: true }),
      sys
    });
    const by = Object.fromEntries(items.map(i => [i.id, i]));
    assert.ok(/older than 1\.6\.0/.test(by['plugin:composite-blur'].detail), 'unknown plugin found through its own dll and version-checked');
    assert.strictEqual(by['link:0'].title, 'Join the Discord');
    assert.strictEqual(by['link:0'].link, undefined, 'a checklist step does not need a link');
    assert.ok(/league\.example/.test(by.collection.detail), 'producers can see where a kit comes from');
  });

  await test('kit: program files are never shipped or downloaded as media', async () => {
    const col = sampleCollection();
    col.sources[4].settings.local_file = 'C:/x/run.exe';
    const pkg = sceneShare.prepare(JSON.stringify(col), { version: '1', mediaFiles: [{ file: 'run.exe', buffer: Buffer.from('MZ') }, ...sampleMedia] });
    assert.deepStrictEqual(pkg.report.blockedMedia, ['run.exe']);
    assert.ok(!pkg.manifest.media.some(m => m.file === 'run.exe'));
    // Only known media types pass (an allow list): shortcuts, OBS scripts, unknown
    // types and Windows tricks like a trailing dot are all refused.
    ['evil.exe', 'a.BAT', 'x.ps1', 'y.dll', 'z.lnk', 'link.url', 'tool.lua', 'tool.py', 'app.msix', 'noextension', 'photo.png.exe'].forEach((file) => {
      assert.throws(() => updates.parseManifest({ version: '1', url: 'a.json', media: [{ file, url: 'x' }] }, 'https://e.com/m.json'), /not a media file/, file);
    });
    ['evil.exe.', 'logo.png.', 'logo.png ', 'sub/logo.png', '..'].forEach((file) => {
      assert.throws(() => updates.parseManifest({ version: '1', url: 'a.json', media: [{ file, url: 'x' }] }, 'https://e.com/m.json'), /plain file name/, file);
    });
    ['Logo.PNG', 'intro.mp4', 'sting.wav', 'League.ttf', 'overlay.html'].forEach((file) => {
      assert.strictEqual(updates.parseManifest({ version: '1', url: 'a.json', media: [{ file, url: 'x' }] }, 'https://e.com/m.json').media.length, 1, file);
    });
    const withLua = sceneShare.prepare(JSON.stringify(col), { version: '1', mediaFiles: [{ file: 'timer.lua', buffer: Buffer.from('x') }, ...sampleMedia] });
    assert.deepStrictEqual(withLua.report.blockedMedia, ['timer.lua'], 'the kit builder leaves them out too');
    assert.strictEqual(updates.parseManifest({ version: '1', url: 'a.json', media: [{ file: 'wipe.webm', url: 'x' }] }, 'https://e.com/m.json').media.length, 1);
  });

  await test('kit: GitHub page links become raw links', async () => {
    const n = sceneShare.normalizeManifestUrl;
    assert.strictEqual(n('https://github.com/me/repo/blob/main/kit/manifest.json'), 'https://raw.githubusercontent.com/me/repo/main/kit/manifest.json');
    assert.strictEqual(n('https://github.com/me/repo/raw/main/manifest.json?raw=true'), 'https://raw.githubusercontent.com/me/repo/main/manifest.json');
    assert.strictEqual(n(' https://league.example/m.json '), 'https://league.example/m.json');
    const file = path.join(TMP, 'kit-url.json');
    writeConfig(file);
    const cm = new ConfigManager(file);
    cm.save({ sceneCollectionManifestUrl: 'https://github.com/me/repo/blob/main/manifest.json' });
    assert.strictEqual(cm.load().sceneCollectionManifestUrl, 'https://raw.githubusercontent.com/me/repo/main/manifest.json');
  });

  await test('kit: "Test link" checks every hosted file the way a producer would', async () => {
    const pkg = sceneShare.prepare(JSON.stringify(sampleCollection()), { version: '2', mediaFiles: sampleMedia, blankUnlinked: true });
    const base = 'https://raw.githubusercontent.com/me/repo/main/kit/';
    const files = { [`${base}manifest.json`]: pkg.manifest, [`${base}${pkg.manifest.url}`]: pkg.collectionBuffer };
    sampleMedia.forEach((m) => { files[`${base}media/${encodeURIComponent(m.file)}`] = m.buffer; });
    const get = async (url) => {
      if (!(url in files)) { const e = new Error('404'); e.response = { status: 404 }; throw e; }
      return files[url];
    };
    const good = await updates.verifyHostedPackage('https://github.com/me/repo/blob/main/kit/manifest.json', { get });
    assert.strictEqual(good.ok, true, JSON.stringify(good.items));
    assert.strictEqual(good.url, `${base}manifest.json`);
    assert.strictEqual(good.items.length, 5, 'manifest, collection, 3 media files');

    const missing = await updates.verifyHostedPackage('https://league.example/nope.json', { get });
    assert.strictEqual(missing.ok, false);
    assert.ok(/public/.test(missing.items[0].detail), 'a 404 explains the usual causes');

    files[`${base}media/Top.png`] = Buffer.from('old file');
    delete files[`${base}media/Song.mp3`];
    const partial = await updates.verifyHostedPackage(`${base}manifest.json`, { get });
    assert.strictEqual(partial.ok, false);
    assert.ok(/5 minutes/.test(partial.items.find(i => i.label === 'Top.png').detail));
    assert.ok(/404/.test(partial.items.find(i => i.label === 'Song.mp3').detail));

    const leaky = sceneShare.prepare(JSON.stringify(sampleCollection()), { version: '3' });
    const leakFiles = { [`${base}manifest.json`]: leaky.manifest, [`${base}${leaky.manifest.url}`]: leaky.collectionBuffer };
    const leak = await updates.verifyHostedPackage(`${base}manifest.json`, { get: async u => leakFiles[u] });
    assert.ok(/private-looking.*streamelements\.com/.test(leak.items.find(i => i.label === 'Scene collection').detail), 'a secret left in the kit is flagged');
    assert.strictEqual(leak.ok, false);
  });

  await test('server: kit scan, reviewed requirements, sheet check; admin settings not shared', async () => {
    const file = path.join(TMP, 'server-kit.json');
    writeConfig(file);
    const srv = new DesktopServer(4627, file);
    srv.setupSystem = fakePc({ pluginVersions: { 'source-switcher': '0.4.4' } });
    srv.readSheetRows = async () => ({ 605: { type: 'HS', value: 'show' } });
    const server = srv.start();
    await new Promise(r => setTimeout(r, 150));
    try {
      const scanned = JSON.parse((await request(4627, '/api/publish/scan', { method: 'POST', body: { collectionText: JSON.stringify(sampleCollection()) } })).body);
      assert.strictEqual(scanned.success, true, scanned.error);
      assert.strictEqual(scanned.plugins.find(p => p.id === 'advanced-scene-switcher').required, true, 'needed but not installed here is still listed');
      assert.strictEqual(JSON.parse((await request(4627, '/api/publish/scan', { method: 'POST', body: { collectionText: '{"nope":1}' } })).body).success, false);

      const prep = JSON.parse((await request(4627, '/api/publish/prepare', {
        method: 'POST',
        body: {
          collectionText: JSON.stringify(sampleCollection()),
          version: '1.0',
          links: 'Join the Discord\nSheet access | https://docs.google.com/x',
          plugins: [{ id: 'custom-thing', name: 'Custom Thing', dll: 'custom-thing.dll', minVersion: '2.0', url: 'https://example.com/c' }],
          fonts: ['My Font']
        }
      })).body);
      assert.strictEqual(prep.success, true, prep.error);
      assert.deepStrictEqual(prep.manifest.requirements.plugins.map(p => p.id), ['custom-thing'], 'the reviewed list wins');
      assert.deepStrictEqual(prep.manifest.requirements.fonts, ['My Font']);
      assert.deepStrictEqual(prep.manifest.links.map(l => l.label), ['Join the Discord', 'Sheet access']);
      assert.deepStrictEqual(prep.report.needsSheetRow.map(n => n.row), [605]);

      const cross = await request(4627, '/api/publish/test-link', { method: 'POST', body: { url: 'https://x.example/m.json' }, headers: { Origin: 'https://evil.example' } });
      assert.strictEqual(cross.status, 403, 'other websites cannot use the link tester');

      const clean = new ConfigManager(file).exportProfile('P', false).config;
      assert.strictEqual(clean.lastPublishedVersion, '');
      assert.strictEqual(clean.publishLinks, '');
    } finally {
      clearInterval(srv.watchdogInterval);
      server.close();
    }
  });

  // --- Live-show reliability ------------------------------------------------
  await test('lock: a delayed image swap is dropped after Stop or a scene collection switch', async () => {
    const run = async (afterSchedule) => {
      const engine = new ImporterEngine({ load: () => ({}) });
      engine.on('log', () => {});
      const state = { settings: { file: 'old.png' }, enabled: true };
      engine.obs = fakeObs(state);
      engine.obsStatus.connected = true;
      engine.obsStatus.sceneCollection = 'Main Show';
      engine.isRunning = true;
      const tags = ImporterEngine.parseCellTags('?hide;new.png');
      await engine.applySourceUpdate('Scene', { sourceName: 'Logo |sheet 2', sceneItemId: 1, sceneItemEnabled: true }, 'Image', '?hide;new.png', tags, {}, {});
      afterSchedule(engine);
      await new Promise(r => setTimeout(r, 1700));
      return state.settings.file;
    };
    assert.strictEqual(await run(() => {}), 'new.png', 'normal case still swaps');
    assert.strictEqual(await run((e) => { e.isRunning = false; }), 'old.png', 'stopped: no late write');
    assert.strictEqual(await run((e) => { e.obsStatus.sceneCollection = 'Test Scenes'; }), 'old.png', 'other collection: no late write');
    assert.strictEqual(await run((e) => { e.sceneCollectionChanging = true; }), 'old.png', 'while switching: no late write');
    assert.strictEqual(await run((e) => { e.obs = fakeObs({ settings: {} }); }), 'old.png', 'after a reconnect: no late write');
  });

  /** Engine wired to a fake OBS with one text source, for whole-cycle tests. */
  function cycleEngine({ obsExtra = {}, items = [{ sourceName: 'Title |sheet 2', sceneItemId: 1, sceneItemEnabled: true }] } = {}) {
    const engine = new ImporterEngine({ load: () => ({ sheetId: 's', apikey: 'k', tabname: 'T', range: 'C2:D', activeProfile: 'P' }) });
    const logs = [];
    engine.on('log', l => logs.push(l));
    const state = { settings: { text: 'old' } };
    const calls = [];
    engine.obs = {
      async call(name, args) {
        calls.push(name);
        if (name === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Main Show' };
        if (name === 'GetSceneList') return { scenes: [{ sceneName: 'A' }, { sceneName: 'B' }] };
        if (name === 'GetGroupList') return { groups: [] };
        if (name === 'GetSceneItemList') return { sceneItems: items };
        if (name === 'GetInputSettings') return { inputSettings: { ...state.settings } };
        if (name === 'SetInputSettings') Object.assign(state.settings, args.inputSettings);
        return {};
      },
      ...obsExtra
    };
    engine.obsStatus.connected = true;
    return { engine, logs, state, calls };
  }

  await test('sync: a failing OBS request is logged once instead of being swallowed', async () => {
    const { engine, logs } = cycleEngine();
    const realCall = engine.obs.call;
    engine.obs.call = async (name, args) => {
      if (name === 'GetSceneList') throw new Error('OBS is not ready');
      return realCall(name, args);
    };
    const orig = ImporterEngine.httpGetJson;
    ImporterEngine.httpGetJson = async () => ({ values: [['1'], ['Title'], ['Text'], ['new']] });
    try {
      await engine.updateCycle();
      await engine.updateCycle();
      const errors = logs.filter(l => l.level === 'error' && /Sync cycle failed: OBS is not ready/.test(l.message));
      assert.strictEqual(errors.length, 1, 'logged, and only once while it keeps failing');
      engine.obs.call = realCall;
      await engine.updateCycle();
      assert.strictEqual(engine.lastCycleError, '', 'a good cycle clears it, so the next failure is logged again');
    } finally {
      ImporterEngine.httpGetJson = orig;
    }
  });

  await test('sheet errors: retried less often, logged once, Sync Now forces a retry', async () => {
    const { engine, logs, state } = cycleEngine();
    let fetches = 0;
    let fail = true;
    const orig = ImporterEngine.httpGetJson;
    ImporterEngine.httpGetJson = async () => {
      fetches++;
      if (fail) {
        const e = new Error('Request failed with status code 429');
        e.response = { status: 429, data: { error: { code: 429, message: 'Quota exceeded' } } };
        throw e;
      }
      return { values: [['1'], ['Title'], ['Text'], ['new']] };
    };
    try {
      await engine.updateCycle();
      assert.strictEqual(fetches, 1);
      assert.ok(engine.sheetRetryAt - Date.now() > 25000, 'a quota error waits about 30 s before the next try');
      await engine.updateCycle();
      await engine.updateCycle();
      assert.strictEqual(fetches, 1, 'polls during the wait do not hit Google');
      await engine.updateCycle({ force: true });
      assert.strictEqual(fetches, 2, 'Sync Now retries straight away');
      assert.ok(engine.sheetRetryAt - Date.now() > 55000, 'and the wait grows after each failure');
      assert.strictEqual(logs.filter(l => /Google Sheet Fetch Error/.test(l.message)).length, 1, 'the same error is logged once');

      fail = false;
      await engine.updateCycle({ force: true });
      assert.strictEqual(engine.sheetRetryAt, 0);
      assert.strictEqual(state.settings.text, 'new', 'syncing carries on once the sheet answers');
      assert.ok(logs.some(l => /readable again/.test(l.message)));
      await engine.updateCycle();
      assert.strictEqual(fetches, 4, 'normal polling is back');
    } finally {
      ImporterEngine.httpGetJson = orig;
    }
  });

  await test('sync: OBS is read in batches, and a source used in two scenes is written once', async () => {
    const batches = [];
    const { engine, state, calls } = cycleEngine({
      obsExtra: {
        async callBatch(requests) {
          batches.push(requests.map(r => r.requestType));
          return requests.map((r) => {
            if (r.requestType === 'GetInputSettings' && r.requestData.inputName === 'Gone |sheet 2') {
              return { requestType: r.requestType, requestId: r.requestId, requestStatus: { result: false, code: 600, comment: 'No source was found' } };
            }
            const responseData = r.requestType === 'GetInputSettings'
              ? { inputSettings: { ...state.settings } }
              : { sceneItems: [
                { sourceName: 'Title |sheet 2', sceneItemId: 1, sceneItemEnabled: true },
                { sourceName: 'Gone |sheet 2', sceneItemId: 2, sceneItemEnabled: true },
                { sourceName: 'Camera', sceneItemId: 3, sceneItemEnabled: true }
              ] };
            return { requestType: r.requestType, requestId: r.requestId, requestStatus: { result: true, code: 100 }, responseData };
          });
        }
      }
    });
    const orig = ImporterEngine.httpGetJson;
    ImporterEngine.httpGetJson = async () => ({ values: [['1'], ['Title'], ['Text'], ['new']] });
    try {
      await engine.updateCycle();
      assert.deepStrictEqual(batches, [
        ['GetSceneItemList', 'GetSceneItemList'],
        ['GetInputSettings', 'GetInputSettings']
      ], 'one batch for the scenes, one for the "|sheet" inputs (each input once, other sources skipped)');
      assert.ok(!calls.includes('GetInputSettings') && !calls.includes('GetSceneItemList'), 'no single reads left');
      assert.strictEqual(calls.filter(c => c === 'SetInputSettings').length, 1, 'scenes A and B share the input: one write');
      assert.strictEqual(state.settings.text, 'new');
      assert.strictEqual(engine.sources.length, 4);
      const gone = engine.sources.find(s => s.sourceName === 'Gone |sheet 2');
      assert.strictEqual(gone.syncStatus, 'error', 'a read that failed inside the batch is reported on that source');
      assert.strictEqual(engine.cycleSettings, null, 'the batch is not reused by the next poll');

      // A batch that fails as a whole falls back to single requests.
      engine.obs.callBatch = async () => { throw new Error('batch not supported'); };
      state.settings.text = 'changed in OBS';
      await engine.updateCycle();
      assert.strictEqual(state.settings.text, 'new');
    } finally {
      ImporterEngine.httpGetJson = orig;
    }
  });

  await test('log file: daily file with dates, private URLs left out, old days deleted, crash.log capped', async () => {
    const { LogFile, rotateIfLarge } = require('../src/engine/log-file');
    const dir = path.join(TMP, 'logfile-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sync-2026-10-01.log'), 'old\n');
    fs.writeFileSync(path.join(dir, 'sync-2026-11-01.log'), 'recent\n');
    fs.writeFileSync(path.join(dir, 'crash.log'), 'keep me\n');
    let now = new Date(2026, 10, 10, 20, 15, 5);
    const log = new LogFile(dir, { now: () => now });
    log.append({ level: 'diff', message: "[Browser] 'Alerts |sheet 9' updated url: https://streamelements.com/overlay/abc/SECRETTOKEN" });
    log.append({ level: 'info', message: 'Docs at https://example.com/help\nsecond line' });
    const text = fs.readFileSync(path.join(dir, 'sync-2026-11-10.log'), 'utf8');
    assert.ok(text.startsWith('2026-11-10 20:15:05 DIFF  '), text);
    assert.ok(!text.includes('SECRETTOKEN') && text.includes('[private URL on streamelements.com]'));
    assert.ok(text.includes('https://example.com/help second line'), 'ordinary links stay; one entry is one line');
    assert.strictEqual(text.trim().split('\n').length, 2);
    assert.ok(!fs.existsSync(path.join(dir, 'sync-2026-10-01.log')), 'older than 14 days: deleted');
    assert.ok(fs.existsSync(path.join(dir, 'sync-2026-11-01.log')));
    assert.ok(fs.existsSync(path.join(dir, 'crash.log')), 'other files in logs\\ are left alone');

    now = new Date(2026, 10, 11, 0, 0, 1);
    log.append({ level: 'info', message: 'after midnight' });
    assert.ok(fs.existsSync(path.join(dir, 'sync-2026-11-11.log')), 'a new file each day');

    const crash = path.join(dir, 'crash.log');
    assert.strictEqual(rotateIfLarge(crash, 1024), false, 'small file: left alone');
    fs.writeFileSync(crash, 'x'.repeat(2048));
    assert.strictEqual(rotateIfLarge(crash, 1024), true);
    assert.ok(!fs.existsSync(crash) && fs.existsSync(`${crash}.old`));

    // A folder that can't be written must never break the app.
    const blocked = path.join(TMP, 'not-a-folder');
    fs.writeFileSync(blocked, 'file');
    const broken = new LogFile(path.join(blocked, 'logs'));
    broken.append({ level: 'info', message: 'x' });
    broken.append({ level: 'info', message: 'y' });
    assert.strictEqual(broken.failed, true);
  });

  await test('server: engine log lines reach the log file; a crash while syncing resumes on the next start', async () => {
    const DesktopServer = require('../src/server');
    const file = path.join(TMP, 'resume-config.json');
    writeConfig(file);
    const srv = new DesktopServer(4630, file);
    srv.engine.log('info', 'hello from the test');
    const day = new Date();
    const name = `sync-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.log`;
    assert.ok(fs.readFileSync(path.join(TMP, 'logs', name), 'utf8').includes('hello from the test'));

    const flag = path.join(TMP, 'resume-sync.flag');
    assert.strictEqual(srv.markResumeIfRunning(), false, 'engine idle: nothing to resume');
    assert.ok(!fs.existsSync(flag));
    srv.engine.isRunning = true;
    srv.engine.simulationMode = true;
    assert.strictEqual(srv.markResumeIfRunning(), false, 'simulation is not resumed');
    srv.engine.simulationMode = false;
    assert.strictEqual(srv.markResumeIfRunning(), true);
    srv.engine.isRunning = false;
    assert.strictEqual(srv.consumeResumeMarker(), true);
    assert.strictEqual(srv.consumeResumeMarker(), false, 'used once');
    fs.writeFileSync(flag, String(Date.now() - 10 * 60 * 1000));
    assert.strictEqual(srv.consumeResumeMarker(), false, 'a crash from 10 minutes ago does not start syncing by surprise');
    assert.ok(!fs.existsSync(flag));

    // On start, a fresh marker starts the engine even though autoStart is off.
    fs.writeFileSync(flag, String(Date.now()));
    let started = 0;
    srv.engine.start = async () => { started++; };
    const server = srv.start();
    try {
      await new Promise(r => setTimeout(r, 300));
      assert.strictEqual(started, 1);
    } finally {
      clearInterval(srv.watchdogInterval);
      server.close();
    }
  });

  // --- Security hardening ---------------------------------------------------
  await test('kit: OBS scripts are removed from a downloaded scene collection', async () => {
    const col = { name: 'Show', sources: [], modules: { 'scripts-tool': [{ path: '\\\\evil\\share\\run.lua', settings: {} }], 'advanced-scene-switcher': { macros: [] } } };
    const buffer = Buffer.from(JSON.stringify(col));
    const dir = path.join(TMP, 'scripts-download');
    const saved = await updates.downloadSceneCollection(
      { name: 'Show', version: '1.0', url: 'https://e.com/show.json', sha256: '', media: [] },
      { get: async () => buffer, dir, mediaDir: path.join(TMP, 'scripts-media') }
    );
    assert.strictEqual(saved.scriptsRemoved, 1);
    const written = JSON.parse(fs.readFileSync(saved.filePath, 'utf8'));
    assert.deepStrictEqual(written.modules['scripts-tool'], []);
    assert.ok(written.modules['advanced-scene-switcher'], 'the rest of the collection is untouched');
    assert.strictEqual(sceneShare.removeScripts({ sources: [] }), 0, 'no scripts: nothing to do');
  });

  await test('import: a profile from someone else cannot set this PC\'s folders, LAN access or odd addresses', async () => {
    const file = path.join(TMP, 'import-config.json');
    writeConfig(file, {}, { obsauth: 'local-obs-pw', obsaddress: 'ws://localhost:4455', scriptUrl: '', scriptToken: 'tok' });
    const cm = new ConfigManager(file);
    const hostile = {
      type: 'single-profile',
      profileName: 'League',
      config: {
        sheetId: 'x',
        mediaFolder: 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
        publishMediaFolder: 'C:\\secret',
        sceneCollectionVersion: '99',
        allowLanDashboard: true,
        obsaddress: 'ws://203.0.113.9:4455',
        scriptUrl: 'https://evil.example/exec',
        scriptToken: 'x',
        sceneCollectionManifestUrl: 'http://evil.example/manifest.json'
      }
    };
    assert.strictEqual(cm.importData(hostile).success, true);
    const p = cm.getProfile('League');
    assert.strictEqual(p.mediaFolder, '');
    assert.strictEqual(p.publishMediaFolder, '');
    assert.strictEqual(p.sceneCollectionVersion, '');
    assert.strictEqual(p.allowLanDashboard, false);
    assert.strictEqual(p.scriptUrl, '', 'only Google Apps Script web app URLs are accepted');
    assert.strictEqual(p.scriptToken, '');
    assert.strictEqual(p.sceneCollectionManifestUrl, '', 'not https: dropped');
    assert.strictEqual(p.obsaddress, 'ws://203.0.113.9:4455');
    assert.strictEqual(p.obsauth, '', 'this PC\'s OBS password is not handed to an address from the file');
    assert.strictEqual(p.apikey, 'key', 'the Google API key is still inherited (it only ever goes to Google)');

    // A normal clean export from an admin still works as before.
    cm.switchProfile('P');
    const clean = { type: 'single-profile', profileName: 'Clean', config: { sheetId: 'y', obsaddress: 'ws://localhost:4455', sceneCollectionManifestUrl: 'https://github.com/a/b/blob/main/manifest.json' } };
    assert.strictEqual(cm.importData(clean).success, true);
    const c = cm.getProfile('Clean');
    assert.strictEqual(c.obsauth, 'local-obs-pw');
    assert.strictEqual(c.sceneCollectionManifestUrl, 'https://raw.githubusercontent.com/a/b/main/manifest.json');

    // This app's own Full Backup restores this-PC settings.
    const backup = { type: 'single-profile', profileName: 'Restored', includePersonal: true, config: { sheetId: 'z', mediaFolder: 'D:\\Show Media', obsauth: 'pw' } };
    assert.strictEqual(cm.importData(backup).success, true);
    assert.strictEqual(cm.getProfile('Restored').mediaFolder, 'D:\\Show Media');

    assert.strictEqual(ConfigManager.isLocalObsAddress('ws://127.0.0.1:4455'), true);
    assert.strictEqual(ConfigManager.isLocalObsAddress('ws://[::1]:4455'), true);
    assert.strictEqual(ConfigManager.isLocalObsAddress('ws://localhost.evil.example:4455'), false);
    assert.strictEqual(ConfigManager.isLocalObsAddress('not a url'), false);
  });

  await test('import: an existing profile is only replaced after a clear yes', async () => {
    const file = path.join(TMP, 'import-overwrite.json');
    writeConfig(file, {}, { tabname: 'Mine' });
    const cm = new ConfigManager(file);
    const incoming = { type: 'single-profile', profileName: 'P', config: { sheetId: 'other', tabname: 'Theirs' } };
    const refused = cm.importData(incoming);
    assert.strictEqual(refused.success, false);
    assert.strictEqual(refused.code, 'PROFILE_EXISTS');
    assert.deepStrictEqual(refused.existing, ['P']);
    assert.strictEqual(cm.getProfile('P').tabname, 'Mine', 'nothing changed');
    assert.strictEqual(cm.importData(incoming, 'P copy').success, true, 'another name imports without asking');
    assert.strictEqual(cm.importData(incoming, null, { overwrite: true }).success, true);
    assert.strictEqual(cm.getProfile('P').tabname, 'Theirs');
    const bundle = { type: 'all-profiles', profiles: { P: { tabname: 'B' }, New: { tabname: 'N' } } };
    const refusedAll = cm.importData(bundle);
    assert.strictEqual(refusedAll.code, 'PROFILE_EXISTS');
    assert.ok(!cm.getProfile('New'), 'a refused bundle imports nothing');
    assert.strictEqual(cm.importData(bundle, null, { overwrite: true }).success, true);
  });

  await test('server: oversized request bodies are refused on every endpoint; import asks before replacing', async () => {
    const DesktopServer = require('../src/server');
    const file = path.join(TMP, 'body-limit-config.json');
    writeConfig(file, {}, { tabname: 'Mine' });
    const srv = new DesktopServer(4631, file);
    const server = srv.start();
    await new Promise(r => setTimeout(r, 300));
    const big = (port, p, bytes) => new Promise((resolve) => {
      const payload = Buffer.from(JSON.stringify({ tabname: 'Hacked', pad: 'x'.repeat(bytes) }));
      const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      r.on('error', () => resolve('closed')); // the server may hang up before the upload ends
      r.end(payload);
    });
    const chunked = (port, p, bytes) => new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      r.on('error', () => resolve('closed'));
      r.write('{"tabname":"Hacked","pad":"');
      r.end('x'.repeat(bytes) + '"}');
    });
    try {
      for (const p of ['/api/config', '/api/profiles/create', '/api/test/sheet', '/api/logs/client-error']) {
        const status = await big(4631, p, 2 * 1024 * 1024);
        assert.ok(status === 413 || status === 'closed', `${p}: ${status}`);
      }
      const noLength = await chunked(4631, '/api/config', 2 * 1024 * 1024);
      assert.ok(noLength === 413 || noLength === 'closed', `no Content-Length: ${noLength}`);
      assert.strictEqual(new ConfigManager(file).getProfile('P').tabname, 'Mine', 'the oversized save was not applied');

      const ok = await request(4631, '/api/config', { method: 'POST', body: { tabname: 'Saved' } });
      assert.strictEqual(ok.status, 200, 'normal requests still work');

      const incoming = { type: 'single-profile', profileName: 'P', config: { sheetId: 's', tabname: 'Theirs' } };
      const refused = await request(4631, '/api/profiles/import', { method: 'POST', body: { json: incoming } });
      assert.strictEqual(refused.status, 400);
      assert.strictEqual(JSON.parse(refused.body).code, 'PROFILE_EXISTS');
      const yes = await request(4631, '/api/profiles/import', { method: 'POST', body: { json: incoming, overwrite: true } });
      assert.strictEqual(yes.status, 200);
      assert.strictEqual(new ConfigManager(file).getProfile('P').tabname, 'Theirs');
    } finally {
      clearInterval(srv.watchdogInterval);
      server.close();
    }
  });

  await test('types: any letter case works; an unknown type is flagged once and nothing is written', async () => {
    assert.strictEqual(ImporterEngine.normalizeType('text'), 'Text');
    assert.strictEqual(ImporterEngine.normalizeType(' IMAGE '), 'Image');
    assert.strictEqual(ImporterEngine.normalizeType('Source Switcher'), 'SourceSwitcher');
    assert.strictEqual(ImporterEngine.normalizeType('switcher'), 'SourceSwitcher');
    assert.strictEqual(ImporterEngine.normalizeType('hs'), 'HS');
    assert.strictEqual(ImporterEngine.normalizeType(''), 'Text', 'an empty type cell still means Text');
    assert.strictEqual(ImporterEngine.normalizeType('Txt'), null);
    assert.strictEqual(ImporterEngine.normalizeType('constructor'), null);

    const engine = new ImporterEngine({ load: () => ({}) });
    const logs = [];
    engine.on('log', l => logs.push(l));
    const state = { settings: { text: 'old' }, enabled: true };
    engine.obs = fakeObs(state);
    engine.obsStatus.connected = true;
    const source = { sourceName: 'Title |sheet 2', sceneItemId: 1, sceneItemEnabled: true };

    const lower = {};
    await engine.applySourceUpdate('Scene', source, 'text', 'new', ImporterEngine.parseCellTags('new'), lower, {});
    assert.strictEqual(state.settings.text, 'new', 'lower-case "text" is synced');
    assert.strictEqual(lower.sourceType, 'Text');
    assert.ok(!lower.warning);

    const info = {};
    await engine.applySourceUpdate('Scene', source, 'Txt', 'typo', ImporterEngine.parseCellTags('typo'), info, {});
    await engine.applySourceUpdate('Scene', source, 'Txt', 'typo', ImporterEngine.parseCellTags('typo'), {}, {});
    assert.strictEqual(state.settings.text, 'new', 'nothing is written for an unknown type');
    assert.ok(/Unknown type "Txt"/.test(info.warning));
    assert.strictEqual(logs.filter(l => l.level === 'warn' && /Unknown type "Txt"/.test(l.message)).length, 1, 'warned once, not every poll');

    // A ?hide tag on such a row keeps working as before.
    await engine.applySourceUpdate('Scene', source, 'Txt', '?hide;x', ImporterEngine.parseCellTags('?hide;x'), {}, {});
    assert.strictEqual(state.enabled, false);
  });

  await test('kit: media and collection downloads get a long timeout, manifests stay short', async () => {
    const seen = [];
    const collection = Buffer.from(JSON.stringify({ name: 'Show', sources: [] }));
    const get = async (url, opts) => {
      seen.push({ url, timeout: opts.timeout });
      return url.endsWith('.mp4') ? Buffer.from('video') : collection;
    };
    await updates.downloadSceneCollection(
      { name: 'Show', version: '1.0', url: 'https://e.com/show.json', sha256: '', media: [{ file: 'intro.mp4', url: 'https://e.com/media/intro.mp4', sha256: '' }] },
      { get, dir: path.join(TMP, 'timeout-download'), mediaDir: path.join(TMP, 'timeout-media') }
    );
    const media = seen.find(s => s.url.endsWith('.mp4'));
    const col = seen.find(s => s.url.endsWith('.json'));
    assert.ok(media.timeout >= 10 * 60 * 1000, 'a large video has minutes, not 10 seconds');
    assert.ok(col.timeout >= 60 * 1000);
    let manifestTimeout = 'not called';
    await updates.checkSceneCollection('https://e.com/manifest.json', '', {
      get: async (url, opts) => { manifestTimeout = opts.timeout; return { version: '1', url: 'show.json' }; }
    });
    assert.strictEqual(manifestTimeout, undefined, 'the manifest check keeps the short default');
  });

  await test('setup check: the Profile row offers to import a profile file (and so does a missing kit link)', async () => {
    const setup = require('../src/engine/setup-check');
    const sys = { env: {}, exists: () => false, listDir: () => [], readFile: () => '', obsInstallDir: async () => '', fileVersions: async () => ({}), installedFonts: async () => [] };
    const testObs = async () => ({ success: true, obsVersion: '31.0' });
    const empty = await setup.runChecks({ config: { activeProfile: 'Default', obsaddress: 'ws://localhost:4455' }, info: null, testObs, sys });
    const profile = empty.find(i => i.id === 'profile');
    assert.strictEqual(profile.status, 'fail');
    assert.strictEqual(profile.fix, 'import-profile');
    assert.ok(/Import profile/.test(profile.detail), 'the text points at the button');
    assert.strictEqual(empty.find(i => i.id === 'manifest').fix, 'import-profile');

    const ready = await setup.runChecks({ config: { activeProfile: 'CCS1', sheetId: 's', apikey: 'k', obsaddress: 'ws://localhost:4455' }, info: null, testObs, sys });
    const ok = ready.find(i => i.id === 'profile');
    assert.strictEqual(ok.status, 'ok');
    assert.strictEqual(ok.fix, 'import-profile', 'still offered, to load another profile');

    const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
    assert.ok(/data-fix="import-profile"/.test(ui) && /fix === 'import-profile'/.test(ui), 'the window draws the button and handles it');
  });

  await test('release: the app is called SheetsToOBS everywhere a user sees it', async () => {
    const repo = path.join(__dirname, '..');
    const read = f => fs.readFileSync(path.join(repo, f), 'utf8');
    const OLD = /OBS Google Sheet Importer|obs-sheets-/i;
    // Only the installer may mention the old name (to clean up after it).
    for (const f of ['src/launcher/AppLauncher.cs', 'src/public/index.html', 'src/server.js', 'src/public/app.js', 'launch-gui.bat', 'build-installer.bat', 'package.json']) {
      assert.ok(!OLD.test(read(f)), `${f} still uses the old name`);
    }
    const iss = read('installer/Setup_SheetsToOBS_GUI.iss');
    assert.ok(iss.includes('#define MyAppName "SheetsToOBS"'));
    assert.ok(/^DefaultDirName=\{autopf\}\\\{#MyAppName\}$/m.test(iss), 'installs into Program Files\\SheetsToOBS');
    assert.ok(/^UsePreviousAppDir=no$/m.test(iss), 'upgrades move out of the old-named folder');
    assert.ok(/^UninstallDisplayName=\{#MyAppName\}$/m.test(iss));
    assert.ok(iss.includes('#define MyAppIdGuid "D37E6B81-54A2-4B22-8A97-152F94EC210A"'), 'same AppId, so 0.2.0 is upgraded, not installed twice');
    ['{commonprograms}', '{userprograms}', '{commondesktop}', '{userdesktop}'].forEach((c) => {
      assert.ok(iss.includes(`Name: "${c}\\{#OldAppName}`), `old shortcut removed from ${c}`);
    });
    assert.strictEqual(JSON.parse(read('package.json')).name, 'sheetstoobs');

    const DesktopServer = require('../src/server');
    const file = path.join(TMP, 'export-name-config.json');
    writeConfig(file);
    const srv = new DesktopServer(4632, file);
    const server = srv.start();
    try {
      await new Promise(r => setTimeout(r, 300));
      const one = await request(4632, '/api/profiles/export?profile=P&clean=true');
      assert.ok(/filename="SheetsToOBS-profile-P-clean\.json"/.test(one.headers['content-disposition']), one.headers['content-disposition']);
      const all = await request(4632, '/api/profiles/export?profile=all&clean=false');
      assert.ok(/filename="SheetsToOBS-all-profiles-backup\.json"/.test(all.headers['content-disposition']));
    } finally {
      clearInterval(srv.watchdogInterval);
      server.close();
    }
  });

  await test('upgrade: settings in the old install folder move to %APPDATA%\\SheetsToOBS, never overwriting', async () => {
    if (process.platform !== 'win32') return;
    const { spawnSync } = require('child_process');
    const helper = path.join(__dirname, '..', 'installer', 'upgrade-helper.ps1');
    const migrate = (oldDir, appData) => spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Migrate', '-OldDir', oldDir],
      { env: { ...process.env, APPDATA: appData }, encoding: 'utf8' }).status;

    const oldDir = path.join(TMP, 'upg', 'OBS Google Sheet Importer GUI');
    fs.mkdirSync(path.join(oldDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{"profiles":{"CCS1":{}}}');
    fs.writeFileSync(path.join(oldDir, 'logs', 'crash.log'), 'x');
    fs.writeFileSync(path.join(oldDir, 'SheetsToOBS.exe'), 'program');

    const fresh = path.join(TMP, 'upg', 'appdata-fresh');
    assert.strictEqual(migrate(oldDir, fresh), 0);
    assert.strictEqual(fs.readFileSync(path.join(fresh, 'SheetsToOBS', 'config.json'), 'utf8'), '{"profiles":{"CCS1":{}}}');
    assert.ok(fs.existsSync(path.join(fresh, 'SheetsToOBS', 'logs', 'crash.log')));
    assert.ok(!fs.existsSync(path.join(fresh, 'SheetsToOBS', 'SheetsToOBS.exe')), 'only settings move, not program files');

    const used = path.join(TMP, 'upg', 'appdata-used');
    fs.mkdirSync(path.join(used, 'SheetsToOBS'), { recursive: true });
    fs.writeFileSync(path.join(used, 'SheetsToOBS', 'config.json'), 'CURRENT');
    assert.strictEqual(migrate(oldDir, used), 0);
    assert.strictEqual(fs.readFileSync(path.join(used, 'SheetsToOBS', 'config.json'), 'utf8'), 'CURRENT', 'existing settings are never overwritten');
    assert.ok(fs.existsSync(path.join(used, 'SheetsToOBS', 'from-old-install', 'config.json')), 'the old ones are kept beside them');

    assert.strictEqual(migrate(path.join(TMP, 'upg', 'missing'), fresh), 0, 'no old folder: nothing to do');
  });

  await test('release: set-version updates every place the version lives', async () => {
    const { spawnSync } = require('child_process');
    const root = path.join(TMP, 'version-root');
    const repo = path.join(__dirname, '..');
    const files = ['package.json', 'package-lock.json', 'installer/Setup_SheetsToOBS_GUI.iss', 'src/launcher/AppLauncher.cs'];
    files.forEach((f) => {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.copyFileSync(path.join(repo, f), path.join(root, f));
    });
    const run = (v) => spawnSync(process.execPath, [path.join(repo, 'installer', 'set-version.js'), v], { env: { ...process.env, SHEETSTOOBS_VERSION_ROOT: root }, encoding: 'utf8' });
    assert.notStrictEqual(run('banana').status, 0, 'a bad version is refused');
    const r = run('9.8.7');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const read = f => fs.readFileSync(path.join(root, f), 'utf8');
    assert.strictEqual(JSON.parse(read('package.json')).version, '9.8.7');
    const lock = JSON.parse(read('package-lock.json'));
    assert.strictEqual(lock.version, '9.8.7');
    assert.strictEqual(lock.packages[''].version, '9.8.7');
    assert.ok(read('installer/Setup_SheetsToOBS_GUI.iss').includes('#define MyAppVersion "9.8.7"'));
    const cs = read('src/launcher/AppLauncher.cs');
    assert.ok(cs.includes('AssemblyFileVersion("9.8.7.0")') && cs.includes('AssemblyVersion("9.8.7.0")'));

    // The real files agree with each other right now.
    const real = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
    assert.ok(fs.readFileSync(path.join(repo, 'installer/Setup_SheetsToOBS_GUI.iss'), 'utf8').includes(`#define MyAppVersion "${real}"`), 'installer version matches package.json');
    assert.ok(fs.readFileSync(path.join(repo, 'src/launcher/AppLauncher.cs'), 'utf8').includes(`AssemblyVersion("${real}.0")`), 'launcher version matches package.json');
  });

  console.log(`\n${passed} hardening tests passed.`);
  process.exit(0);
})();
