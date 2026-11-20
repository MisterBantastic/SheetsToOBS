const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ConfigManager = require('./engine/config-manager');
const ImporterEngine = require('./engine/importer-engine');
const ControlSheet = require('./engine/control-sheet');
const updates = require('./engine/update-checker');
const sceneShare = require('./engine/scene-share');
const setupCheck = require('./engine/setup-check');
const { LogFile, rotateIfLarge } = require('./engine/log-file');
const folderPicker = require('./engine/folder-picker');
const { dataFile, dataDir } = require('./paths');

// Experimental Control Sheet / Web Dashboard. Everything behind this switch is
// still being tested: it is off unless config.json has
// "experimentalControlSheet": true or SHEETSTOOBS_EXPERIMENTAL=1 is set.
const EXPERIMENTAL_STATIC = new Set(['/dashboard', '/demo', '/remote', '/dashboard.html', '/dashboard.js', '/dashboard.css', '/control-layout.json']);
const EXPERIMENTAL_OFF_MESSAGE = 'The Control Sheet / Web Dashboard is an experimental feature and is switched off. ' +
  'See "Experimental features" in README.md to try it.';

// Served with every page. Scripts may only come from this server, which blocks
// injected script even if some sheet text slipped through unescaped.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self' https://raw.communitydragon.org",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};

// If the server stops because of an unexpected error while syncing, it leaves this
// note behind; the next start within RESUME_MAX_AGE_MS carries on syncing.
const RESUME_MAX_AGE_MS = 2 * 60 * 1000;

// Failed access-code attempts per remote address (simple brute-force brake).
const ACCESS_FAILS = new Map(); // ip -> { count, until }
const ACCESS_MAX_FAILS = 10;
const ACCESS_LOCK_MS = 10 * 60 * 1000;

// Requests from other devices on the network may only use these endpoints, and only
// when "allowLanDashboard" is switched on. Everything that exposes or changes
// credentials/config stays on this PC.
const LAN_ALLOWED_API = new Set([
  '/api/heartbeat',
  '/api/events',
  '/api/status',
  '/api/logs',
  '/api/sheet-control/layout',
  '/api/sheet-control/snapshot',
  '/api/sheet-control/write'
]);

function isLoopbackAddress(addr) {
  if (!addr) return false;
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

function isAcceptableHostHeader(hostHeader) {
  // Blocks DNS-rebinding: a malicious site pointing its own domain at 127.0.0.1.
  if (!hostHeader) return true;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch (e) {
    return false;
  }
  hostname = hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname === os.hostname().toLowerCase()) return true;
  if (/^[0-9.]+$/.test(hostname) || hostname.includes(':')) return true; // IP literal
  if (hostname.endsWith('.local')) return true;
  return false;
}

function lanUrls(port) {
  const urls = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) urls.push(`http://${n.address}:${port}/dashboard`);
    }
  }
  return urls;
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

// Largest request body accepted per endpoint (bytes). Everything else: 1 MB.
const BODY_LIMIT_DEFAULT = 1024 * 1024;
const BODY_LIMITS = {
  '/api/publish/scan': 80 * 1024 * 1024,
  '/api/publish/prepare': 80 * 1024 * 1024,
  '/api/profiles/import': 5 * 1024 * 1024
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

class DesktopServer {
  constructor(port = 4587, customConfigPath = null) {
    this.port = port;
    this.configManager = new ConfigManager(customConfigPath);
    this.engine = new ImporterEngine(this.configManager);
    this.controlSheet = new ControlSheet(this.configManager);
    this.clients = new Set();
    this.logHistory = [];
    this.maxLogs = 300;
    this.logFile = new LogFile(dataFile('logs'));
    this.lastHeartbeat = Date.now();
    this.serverStartTime = Date.now();
    this.hasEverHadClients = false;
    this.watchdogInterval = null;
    this.shutdownTimer = null;
    this.appUpdateCache = null; // { at, result }
    this.updateChecker = updates;
    this.setupSystem = setupCheck.realSystem; // replaced by tests
    this.testObs = (address, password) => ImporterEngine.testObsConnection(address, password);
    this.readSheetRows = (config) => DesktopServer.fetchSheetRows(config); // replaced by tests
    this.pickFolder = (opts) => folderPicker.pickFolder(opts); // replaced by tests

    this.setupEngineListeners();
  }

  /** The active profile's sheet as { row: { type, value } }, or null if it can't be read. */
  static async fetchSheetRows(config) {
    if (!config.sheetId || !config.apikey) return null;
    const range = encodeURIComponent(`${config.tabname || 'Interface'}!A:E`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}/values/${range}?key=${encodeURIComponent(config.apikey)}&majorDimension=ROWS`;
    try {
      const data = await ImporterEngine.httpGetJson(url);
      return sceneShare.sheetRowsFromValues(data.values);
    } catch (e) {
      return null;
    }
  }

  /** Media folder for the active profile's collection. */
  mediaDirFor(config, info) {
    return config.mediaFolder || this.updateChecker.defaultMediaDir(info && info.name);
  }

  /**
   * Setup Check and "Prepare for sharing" (this PC only: not in LAN_ALLOWED_API).
   * Returns true when the request was handled.
   */
  async handleSetup(req, res, pathname) {
    const u = this.updateChecker;
    try {
      if (pathname === '/api/setup-check' && req.method === 'GET') {
        const config = this.configManager.load();
        let info = null;
        let infoError = '';
        if (config.sceneCollectionManifestUrl) {
          try {
            info = await u.checkSceneCollection(config.sceneCollectionManifestUrl, config.sceneCollectionVersion);
          } catch (e) {
            infoError = e.response ? `server answered ${e.response.status}` : e.message;
          }
        }
        const items = await setupCheck.runChecks({
          config,
          info,
          infoError,
          mediaDir: this.mediaDirFor(config, info),
          testObs: this.testObs,
          sys: this.setupSystem
        });
        sendJson(res, 200, { success: true, items });
        return true;
      }

      if (pathname === '/api/setup-check/seen' && req.method === 'POST') {
        sendJson(res, 200, this.configManager.setUpdateSettings({ setupCheckShownVersion: u.appVersion() }));
        return true;
      }

      if (pathname === '/api/setup-check/fix' && req.method === 'POST') {
        const { id } = await readJsonBody(req);
        if (id !== 'league-timers') {
          sendJson(res, 400, { success: false, error: 'Nothing to fix for that item.' });
          return true;
        }
        const result = setupCheck.fixEsportsTimers(this.setupSystem);
        result.changed.forEach(f => this.engine.log('info', `Turned on League esports timers in ${f} (backup: ${f}.sheetstoobs-backup).`));
        sendJson(res, 200, { success: true, ...result });
        return true;
      }

      // Kit builder, step 1: what this collection needs, for the admin to review.
      if (pathname === '/api/publish/scan' && req.method === 'POST') {
        const body = await readJsonBody(req, 80 * 1024 * 1024);
        const scanned = sceneShare.scan(body.collectionText);
        const installed = await setupCheck.scanInstalledPlugins(this.setupSystem);
        const plugins = installed.map(p => ({ ...p, required: scanned.plugins.includes(p.id) }));
        // Needed by the collection but not installed on this PC.
        scanned.plugins.filter(id => !installed.some(p => p.id === id)).forEach((id) => {
          const k = sceneShare.KNOWN_PLUGINS[id];
          plugins.unshift({ id, name: k.name, dll: k.dll, version: '', url: k.url, required: true });
        });
        sendJson(res, 200, { success: true, name: scanned.name, fonts: scanned.fonts, unknownKinds: scanned.unknownKinds, plugins });
        return true;
      }

      // Kit builder, last step: fetch the hosted kit the way a producer's PC would.
      if (pathname === '/api/publish/test-link' && req.method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 200, { success: true, ...(await u.verifyHostedPackage(String(body.url || ''))) });
        return true;
      }

      if (pathname === '/api/publish/prepare' && req.method === 'POST') {
        const body = await readJsonBody(req, 80 * 1024 * 1024);
        const mediaFolder = String(body.mediaFolder || '').trim();
        const links = String(body.links || '').split(/\r?\n/).map((line) => {
          const [label, url] = line.split('|').map(s => (s || '').trim());
          return { label, url };
        }).filter(l => l.label);
        const reviewed = Array.isArray(body.plugins) ? u.parseRequirements({ plugins: body.plugins, fonts: body.fonts }) : null;
        const pkg = sceneShare.prepare(body.collectionText, {
          plugins: reviewed && reviewed.plugins,
          fonts: reviewed && reviewed.fonts,
          sheetRows: await this.readSheetRows(this.configManager.load()),
          version: String(body.version || '').trim(),
          notes: body.notes || '',
          mediaFiles: mediaFolder ? sceneShare.readMediaFolder(mediaFolder) : [],
          installedPlugins: await setupCheck.installedPluginVersions(this.setupSystem),
          leagueEsportsTimers: body.leagueEsportsTimers === true,
          links,
          blankUnlinked: body.blankUnlinked === true
        });
        const outDir = sceneShare.writePackage(dataFile('publish', sceneShare.safeName(pkg.manifest.name)), pkg);
        this.configManager.save({
          publishMediaFolder: mediaFolder,
          lastPublishedVersion: pkg.manifest.version,
          publishLinks: String(body.links || '').slice(0, 2000),
          publishLeagueTimers: body.leagueEsportsTimers === true
        });
        this.engine.log('info', `Prepared "${pkg.manifest.name}" v${pkg.manifest.version} for sharing in ${outDir}.`);
        if (pkg.report.scripts) {
          this.engine.log('warn', `This collection has ${pkg.report.scripts} OBS script(s) (Tools > Scripts). They are not passed on to producers: tell them to add the scripts by hand if the show needs them.`);
        }
        sendJson(res, 200, {
          success: true,
          outDir,
          manifest: pkg.manifest,
          collectionFile: pkg.collectionFile,
          report: pkg.report
        });
        return true;
      }

      if (pathname === '/api/publish/open-folder' && req.method === 'POST') {
        const dir = dataFile('publish');
        fs.mkdirSync(dir, { recursive: true });
        if (process.platform === 'win32') {
          require('child_process').spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        }
        sendJson(res, 200, { success: true, dir });
        return true;
      }
    } catch (err) {
      sendJson(res, 200, { success: false, error: err.message || String(err) });
      return true;
    }
    return false;
  }

  /**
   * Update checks (this PC only: none of these paths are in LAN_ALLOWED_API).
   * Returns true when the request was handled.
   */
  async handleUpdates(req, res, pathname, parsedUrl) {
    const u = this.updateChecker;
    try {
      if (pathname === '/api/updates/app' && req.method === 'GET') {
        const config = this.configManager.load();
        const force = parsedUrl.searchParams.get('force') === '1';
        if (!force && !config.checkForAppUpdates) {
          sendJson(res, 200, { success: true, enabled: false, current: u.appVersion() });
          return true;
        }
        // GitHub is asked once per app start (reopening the window reuses the answer)
        // and again only when "Check now" is pressed.
        const cached = this.appUpdateCache;
        let result;
        if (!force && cached) {
          result = cached.result;
        } else {
          result = await u.checkApp();
          this.appUpdateCache = { at: Date.now(), result };
          if (result.newer) this.engine.log('info', `SheetsToOBS ${result.latest} is available (you have ${result.current}).`);
        }
        sendJson(res, 200, {
          success: true,
          enabled: config.checkForAppUpdates,
          ...result,
          skipped: !force && result.latest === config.skippedAppVersion
        });
        return true;
      }

      if (pathname === '/api/updates/settings' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = this.configManager.setUpdateSettings({
          checkForAppUpdates: body.checkForAppUpdates,
          skippedAppVersion: body.skippedAppVersion
        });
        sendJson(res, result.success ? 200 : 400, result);
        return true;
      }

      if (pathname.startsWith('/api/updates/scene-collection')) {
        const config = this.configManager.load();
        if (!config.sceneCollectionManifestUrl) {
          sendJson(res, 200, { success: true, configured: false });
          return true;
        }
        // Always re-read the manifest here; never trust a file URL sent by the page.
        const info = await u.checkSceneCollection(config.sceneCollectionManifestUrl, config.sceneCollectionVersion);

        if (pathname === '/api/updates/scene-collection' && req.method === 'GET') {
          const force = parsedUrl.searchParams.get('force') === '1';
          sendJson(res, 200, {
            success: true,
            configured: true,
            ...info,
            skipped: !force && info.version === config.sceneCollectionSkippedVersion
          });
          return true;
        }

        if (pathname === '/api/updates/scene-collection/download' && req.method === 'POST') {
          const saved = await u.downloadSceneCollection(info, { mediaDir: this.mediaDirFor(config, info) });
          this.configManager.save({ sceneCollectionVersion: info.version });
          if (saved.scriptsRemoved) {
            this.engine.log('warn', `${saved.scriptsRemoved} OBS script(s) were removed from the downloaded scene collection, because scripts can run anything on this PC. If the show needs them, ask your admin and add them yourself in OBS: Tools > Scripts.`);
          }
          if (saved.mediaDir) {
            this.engine.log('info', `Media for "${info.name}": ${saved.mediaDownloaded} downloaded, ${saved.mediaSkipped} already up to date, in ${saved.mediaDir}.`);
          }
          this.engine.log('info', `Downloaded scene collection "${info.name}" v${info.version} to ${saved.filePath}. Import it in OBS: Scene Collection > Import.`);
          sendJson(res, 200, { success: true, ...info, installed: info.version, newer: false, ...saved });
          return true;
        }

        if (pathname === '/api/updates/scene-collection/skip' && req.method === 'POST') {
          this.configManager.save({ sceneCollectionSkippedVersion: info.version });
          this.engine.log('info', `Scene collection "${info.name}" v${info.version} ignored.`);
          sendJson(res, 200, { success: true, ...info, skipped: true });
          return true;
        }
      }

      if (pathname === '/api/updates/open-folder' && req.method === 'POST') {
        const dir = u.collectionsDir();
        fs.mkdirSync(dir, { recursive: true });
        if (process.platform === 'win32') {
          require('child_process').spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        }
        sendJson(res, 200, { success: true, dir });
        return true;
      }
    } catch (err) {
      const msg = err.response ? `Server answered ${err.response.status}` : (err.message || String(err));
      sendJson(res, 200, { success: false, error: msg });
      return true;
    }
    return false;
  }

  /**
   * Generates and writes extensive diagnostic crash report to logs/crash.log
   */
  static writeCrashLog(error, type = 'CRASH') {
    try {
      const logsDir = dataFile('logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      const mem = process.memoryUsage();
      const crashReport = [
        '======================================================================',
        `SHEETSTOOBS DIAGNOSTIC CRASH REPORT - ${new Date().toISOString()}`,
        '======================================================================',
        `Crash Type:        ${type}`,
        `OS Platform:       ${os.type()} ${os.release()} (${os.arch()}) - Windows Version ${os.version ? os.version() : 'N/A'}`,
        `Host Name:         ${os.hostname()}`,
        `Node.js Version:   ${process.version}`,
        `App Data Dir:      ${dataDir()}`,
        `Process ID (PID):  ${process.pid}`,
        `Process Uptime:    ${Math.round(process.uptime())} seconds`,
        `Heap Memory Used:  ${Math.round(mem.heapUsed / 1024 / 1024)} MB / ${Math.round(mem.heapTotal / 1024 / 1024)} MB`,
        `RSS Memory:        ${Math.round(mem.rss / 1024 / 1024)} MB`,
        '----------------------------------------------------------------------',
        'ERROR DETAILS:',
        `Message: ${error && error.message ? error.message : String(error)}`,
        `Code:    ${error && error.code ? error.code : 'N/A'}`,
        'Stack Trace:',
        error && error.stack ? error.stack : 'No stack trace available',
        '======================================================================\n'
      ].join('\n');

      const crashFilePath = path.join(logsDir, 'crash.log');
      rotateIfLarge(crashFilePath);
      fs.appendFileSync(crashFilePath, crashReport, 'utf8');
      console.error(crashReport);
    } catch (logErr) {
      console.error('[DesktopServer] Failed to write crash log:', logErr);
    }
  }

  /** Called just before the server stops on an unexpected error. */
  markResumeIfRunning() {
    try {
      if (this.engine.isRunning && !this.engine.simulationMode) {
        fs.writeFileSync(dataFile('resume-sync.flag'), String(Date.now()), 'utf8');
        return true;
      }
    } catch (e) { /* nothing more can be done while crashing */ }
    return false;
  }

  /** True (once) when the last run stopped unexpectedly while syncing, a moment ago. */
  consumeResumeMarker() {
    const file = dataFile('resume-sync.flag');
    try {
      if (!fs.existsSync(file)) return false;
      const at = parseInt(fs.readFileSync(file, 'utf8'), 10);
      fs.unlinkSync(file);
      const age = Date.now() - at;
      return Number.isFinite(age) && age >= 0 && age < RESUME_MAX_AGE_MS;
    } catch (e) {
      return false;
    }
  }

  setupEngineListeners() {
    this.engine.on('log', (logEntry) => {
      this.logFile.append(logEntry);
      this.logHistory.push(logEntry);
      if (this.logHistory.length > this.maxLogs) {
        this.logHistory.shift();
      }
      this.broadcast('log', logEntry);
    });

    this.engine.on('status', (status) => {
      this.broadcast('status', status);
    });

    this.engine.on('data:preview', (rows) => {
      this.broadcast('data:preview', rows);
    });

    this.engine.on('sources:mapped', (sources) => {
      this.broadcast('sources:mapped', sources);
    });
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch (err) {
        this.clients.delete(client);
      }
    }
  }

  async handleSheetControl(req, res, pathname, parsedUrl, fromLoopback) {
    const cs = this.controlSheet;
    try {
      if (pathname === '/api/sheet-control/layout' && req.method === 'GET') {
        const settings = cs.settings();
        sendJson(res, 200, {
          success: true,
          layout: cs.layout,
          layouts: cs.layoutsByTab(),
          settings,
          isLocal: fromLoopback,
          lanUrls: settings.allowLanDashboard && this.lanBound ? lanUrls(this.port) : [],
          lanAccessCode: fromLoopback && settings.allowLanDashboard ? this.configManager.getLanAccessCode() : undefined,
          lanRestartRequired: fromLoopback && settings.allowLanDashboard !== this.lanBound,
          runnable: ControlSheet.RUNNABLE_FUNCTIONS
        });
        return;
      }

      if (pathname === '/api/sheet-control/snapshot' && req.method === 'GET') {
        const settings = cs.settings();
        const tab = parsedUrl.searchParams.get('tab') || settings.tab;
        const data = await cs.snapshot(tab, {
          withOptions: parsedUrl.searchParams.get('options') === '1',
          fresh: parsedUrl.searchParams.get('fresh') === '1'
        });
        sendJson(res, 200, { success: true, ...data });
        return;
      }

      if (pathname === '/api/sheet-control/write' && req.method === 'POST') {
        const { tab, updates } = await readJsonBody(req);
        const result = await cs.write(tab, updates);
        const who = fromLoopback ? 'local' : (req.socket.remoteAddress || 'remote');
        result.applied.forEach(cell => this.engine.log('sheet', `[Dashboard] ${tab}!${cell} edited (${who}).`));
        (result.skipped || []).forEach(sk => this.engine.log('warn', `[Dashboard] ${tab}!${sk.cell} not written: ${sk.reason}.`));
        // Push the change to OBS straight away instead of waiting for the next poll.
        if (result.applied.length && this.engine.isRunning && !this.engine.simulationMode) {
          setTimeout(() => this.engine.updateCycle().catch(() => {}), 300);
        }
        this.broadcast('control:changed', { tab, applied: result.applied, at: Date.now() });
        sendJson(res, 200, { success: true, ...result });
        return;
      }

      // Everything below changes settings or runs scripts: this PC only (LAN filter above).
      if (pathname === '/api/sheet-control/run' && req.method === 'POST') {
        const { fn } = await readJsonBody(req);
        this.engine.log('info', `[Dashboard] Running Apps Script ${fn}()...`);
        const result = await cs.run(fn);
        this.engine.log('info', `[Dashboard] ${fn}() finished in ${(result.ms / 1000).toFixed(1)}s.`);
        cs.clearCaches();
        sendJson(res, 200, { success: true, ...result });
        return;
      }

      if (pathname === '/api/sheet-control/test' && req.method === 'POST') {
        const result = await cs.ping();
        sendJson(res, 200, { success: !!result.ok, ...result });
        return;
      }

      if (pathname === '/api/sheet-control/settings' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const patch = {};
        if (typeof body.controlTabName === 'string' && body.controlTabName.trim()) patch.controlTabName = body.controlTabName.trim();
        if (typeof body.scriptUrl === 'string') patch.scriptUrl = body.scriptUrl.trim();
        if (typeof body.scriptToken === 'string' && body.scriptToken.trim()) patch.scriptToken = body.scriptToken.trim();
        if (body.clearToken === true) patch.scriptToken = '';
        if (typeof body.allowLanDashboard === 'boolean') patch.allowLanDashboard = body.allowLanDashboard;
        if (body.controlPollMs !== undefined) patch.controlPollMs = Math.max(2000, parseInt(body.controlPollMs, 10) || 4000);
        if (patch.scriptUrl && !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(patch.scriptUrl)) {
          sendJson(res, 400, { success: false, error: 'Web App URL must look like https://script.google.com/macros/s/…/exec' });
          return;
        }
        const result = this.configManager.save(patch);
        if (!result.success) {
          sendJson(res, 400, result);
          return;
        }
        cs.clearCaches();
        this.engine.log('info', '[Dashboard] Control sheet connection settings saved.');
        const restartRequired = cs.settings().allowLanDashboard !== this.lanBound;
        if (restartRequired) {
          this.engine.log('warn', '[Dashboard] Restart SheetsToOBS for the network access change to take effect.');
        }
        sendJson(res, 200, { success: true, settings: cs.settings(), restartRequired });
        return;
      }

      if (pathname === '/api/sheet-control/rotate-code' && req.method === 'POST') {
        const code = this.configManager.rotateLanAccessCode();
        if (!code) {
          sendJson(res, 500, { success: false, error: 'Could not save a new access code.' });
          return;
        }
        this.engine.log('info', '[Dashboard] Network access code changed.');
        sendJson(res, 200, { success: true, lanAccessCode: code });
        return;
      }

      sendJson(res, 404, { success: false, error: 'Unknown control sheet endpoint.' });
    } catch (err) {
      sendJson(res, 400, { success: false, error: err.message || String(err) });
    }
  }

  /**
   * Requests from other devices must carry the dashboard access code (header
   * "X-Access-Code", or ?code= for EventSource). Returns false after replying.
   */
  checkAccessCode(req, parsedUrl, remoteAddr, res) {
    const now = Date.now();
    const fails = ACCESS_FAILS.get(remoteAddr);
    if (fails && fails.until > now) {
      sendJson(res, 429, { success: false, error: 'Too many wrong access codes. Try again in a few minutes.' });
      return false;
    }
    const expected = this.configManager.getLanAccessCode().replace(/-/g, '').toUpperCase();
    const given = String(req.headers['x-access-code'] || parsedUrl.searchParams.get('code') || '')
      .replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length === b.length && require('crypto').timingSafeEqual(a, b)) {
      ACCESS_FAILS.delete(remoteAddr);
      return true;
    }
    if (given) {
      const entry = fails && fails.until <= now && fails.count < ACCESS_MAX_FAILS ? fails : (fails || { count: 0, until: 0 });
      entry.count += 1;
      if (entry.count >= ACCESS_MAX_FAILS) {
        entry.until = now + ACCESS_LOCK_MS;
        entry.count = 0;
      }
      ACCESS_FAILS.set(remoteAddr, entry);
    }
    sendJson(res, 401, {
      success: false,
      code: 'ACCESS_CODE_REQUIRED',
      error: given ? 'Wrong access code.' : 'Enter the access code shown in the dashboard settings on the SheetsToOBS PC.'
    });
    return false;
  }

  start() {
    const publicDir = path.join(__dirname, 'public');

    // Watchdog timer: Manages background server lifecycle safely
    const isPersistentServer = process.argv.includes('--server') || 
                               process.argv.includes('--no-shutdown') || 
                               process.env.SERVER_MODE === 'true';

    if (!isPersistentServer) {
      this.watchdogInterval = setInterval(() => {
        const now = Date.now();
        // If the sync engine is actively running, NEVER shut down automatically
        if (this.engine && this.engine.isRunning) {
          return;
        }

        if (this.hasEverHadClients) {
          // Allow up to 60 seconds of client inactivity when engine is idle before shutting down
          if (this.clients.size === 0 && (now - this.lastHeartbeat > 60000)) {
            console.log('[SheetsToOBS Desktop Server] No active GUI clients for 60s and engine idle. Auto-shutting down background server...');
            this.engine.stop();
            process.exit(0);
          }
        } else if (now - this.serverStartTime > 120000) {
          console.log('[SheetsToOBS Desktop Server] No GUI client connected within 120s. Auto-shutting down...');
          this.engine.stop();
          process.exit(0);
        }
      }, 5000);
    } else {
      console.log('[SheetsToOBS Server] Running in persistent server mode (auto-shutdown watchdog disabled).');
    }

    const server = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      // --- Request guards -------------------------------------------------
      // No CORS headers on purpose: the UI is served from this same server, and
      // "Access-Control-Allow-Origin: *" let any website read /api/config
      // (Google API key + OBS password) while the app was running.
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (!isAcceptableHostHeader(req.headers.host)) {
        sendJson(res, 403, { success: false, error: 'Host not allowed.' });
        return;
      }

      const isApi = pathname.startsWith('/api/');
      if (isApi && req.headers.origin) {
        let originHost = '';
        try { originHost = new URL(req.headers.origin).host; } catch (e) {}
        if (originHost !== req.headers.host) {
          sendJson(res, 403, { success: false, error: 'Cross-origin request blocked.' });
          return;
        }
      }

      // Every request body is size-limited here, whichever endpoint reads it.
      const bodyLimit = BODY_LIMITS[pathname] || BODY_LIMIT_DEFAULT;
      const tooLarge = () => {
        if (res.headersSent) return;
        req.removeAllListeners('end'); // the endpoint never sees a cut-off body
        res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(JSON.stringify({ success: false, error: 'Request body too large.' }), () => req.destroy());
      };
      if (Number(req.headers['content-length']) > bodyLimit) {
        tooLarge();
        return;
      }
      let bodyBytes = 0;
      req.on('data', (chunk) => {
        bodyBytes += chunk.length;
        if (bodyBytes > bodyLimit) tooLarge();
      });

      const experimental = this.configManager.isExperimentalEnabled();
      if (!experimental && (EXPERIMENTAL_STATIC.has(pathname) || pathname.startsWith('/api/sheet-control/'))) {
        if (isApi) {
          sendJson(res, 404, { success: false, error: EXPERIMENTAL_OFF_MESSAGE, code: 'EXPERIMENTAL_DISABLED' });
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
          res.end(EXPERIMENTAL_OFF_MESSAGE);
        }
        return;
      }

      const remoteAddr = (req.socket && req.socket.remoteAddress) || '';
      const fromLoopback = isLoopbackAddress(remoteAddr);
      if (!fromLoopback) {
        // Other devices only ever get the experimental dashboard, and only when it is switched on.
        const lanOn = experimental && !!this.configManager.load().allowLanDashboard;
        const staticOk = !isApi && lanOn;
        if (!lanOn || (isApi && !LAN_ALLOWED_API.has(pathname)) || (!isApi && !staticOk)) {
          sendJson(res, 403, {
            success: false,
            error: lanOn
              ? 'This endpoint is only available on the SheetsToOBS PC.'
              : 'Remote access is off. Enable "Allow other devices on my network" in the Web Dashboard settings on the SheetsToOBS PC.'
          });
          return;
        }
        if (isApi && !this.checkAccessCode(req, parsedUrl, remoteAddr, res)) return;
      }

      // --- Web Dashboard: control sheet API ---------------------------------
      if (pathname.startsWith('/api/sheet-control/')) {
        await this.handleSheetControl(req, res, pathname, parsedUrl, fromLoopback);
        return;
      }

      // API: Heartbeat ping from GUI
      if (pathname === '/api/heartbeat') {
        this.lastHeartbeat = Date.now();
        this.hasEverHadClients = true;
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, timestamp: this.lastHeartbeat }));
        return;
      }

      // API: Graceful Shutdown from GUI (POST only, so a link or <img> on a web page can't trigger it)
      if (pathname === '/api/shutdown' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Server shutting down' }));
        if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
        this.shutdownTimer = setTimeout(() => {
          if (this.clients.size === 0) {
            console.log('[SheetsToOBS Desktop Server] Clean shutdown executed.');
            this.engine.stop();
            process.exit(0);
          }
        }, 800);
        return;
      }

      // SSE Endpoint
      if (pathname === '/api/events') {
        this.hasEverHadClients = true;
        this.lastHeartbeat = Date.now();
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write('\n');
        this.clients.add(res);

        // Send initial state snapshot
        res.write(`event: status\ndata: ${JSON.stringify({
          obs: this.engine.obsStatus,
          sheet: this.engine.sheetStatus,
          running: this.engine.isRunning,
          simulation: this.engine.simulationMode,
          sourcesCount: this.engine.sources.length,
          rowsCount: this.engine.rawSheetData.length,
          lastSyncDiffs: this.engine.lastSyncDiffs.slice(0, 15),
          lastSyncTimestamp: this.engine.lastSyncTimestamp,
          permissions: this.configManager.checkWritePermission()
        })}\n\n`);

        if (this.engine.sources.length > 0) {
          res.write(`event: sources:mapped\ndata: ${JSON.stringify(this.engine.sources)}\n\n`);
        }

        if (this.engine.rawSheetData.length > 0) {
          res.write(`event: data:preview\ndata: ${JSON.stringify(this.engine.rawSheetData)}\n\n`);
        }

        req.on('close', () => {
          this.clients.delete(res);
        });
        return;
      }

      // API: Get Status
      if (pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          obs: this.engine.obsStatus,
          sheet: this.engine.sheetStatus,
          running: this.engine.isRunning,
          simulation: this.engine.simulationMode,
          sources: this.engine.sources,
          sheetData: this.engine.rawSheetData,
          lastSyncDiffs: this.engine.lastSyncDiffs.slice(0, 15),
          lastSyncTimestamp: this.engine.lastSyncTimestamp,
          permissions: this.configManager.checkWritePermission()
        }));
        return;
      }

      // API: Window State Memory
      if (pathname === '/api/window-state' && req.method === 'GET') {
        const statePath = dataFile('window-state.json');
        let state = { width: 580, height: 680, mode: 'simple' };
        if (fs.existsSync(statePath)) {
          try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
      }

      if (pathname === '/api/window-state' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            // Only keep the numeric/plain fields the launcher understands.
            const clean = {};
            ['width', 'height', 'x', 'y'].forEach(k => {
              if (Number.isFinite(data[k])) clean[k] = Math.round(data[k]);
            });
            if (typeof data.mode === 'string') clean.mode = data.mode.slice(0, 20);
            const statePath = dataFile('window-state.json');
            fs.writeFileSync(statePath, JSON.stringify(clean, null, 2), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // API: Get Logs
      if (pathname === '/api/logs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.logHistory));
        return;
      }

      // API: Get Crash Logs
      if (pathname === '/api/logs/crash' && req.method === 'GET') {
        const crashPath = dataFile('logs', 'crash.log');
        if (fs.existsSync(crashPath)) {
          const content = fs.readFileSync(crashPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(content);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ exists: false, message: 'No crash logs recorded.' }));
        }
        return;
      }

      // API: Client-Side UI Error Logger
      if (pathname === '/api/logs/client-error' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            const clientErr = new Error(`[Client UI Error] ${data.message || 'Unknown UI Error'}`);
            if (data.stack) clientErr.stack = data.stack;
            DesktopServer.writeCrashLog(clientErr, 'CLIENT_UI_ERROR');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // API: Get Config / Active Profile
      if (pathname === '/api/config' && req.method === 'GET') {
        const config = this.configManager.load();
        const permissions = this.configManager.checkWritePermission();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ...config,
          permissions,
          appVersion: this.updateChecker.appVersion(),
          // Setup Check opens by itself once per installed version, not on every start.
          setupCheckDue: config.setupCheckShownVersion !== this.updateChecker.appVersion(),
          defaultMediaFolder: dataFile('media')
        }));
        return;
      }

      // API: Save Active Profile Config
      if (pathname === '/api/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const result = this.configManager.save(data);
            if (result.success) {
              this.engine.log('info', `Profile "${result.config.activeProfile}" settings saved.`);
              this.controlSheet.clearCaches();
              if (this.engine.isRunning && !this.engine.simulationMode) {
                this.engine.startPollingTimer();
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // API: "Browse…" for folder fields: opens the Windows folder picker on this PC.
      // Never in LAN_ALLOWED_API, so other devices can't pop up windows here.
      if (pathname === '/api/pick-folder' && req.method === 'POST') {
        readJsonBody(req)
          .then(body => this.pickFolder({ purpose: String(body.purpose || ''), start: String(body.start || '') }))
          .then(result => sendJson(res, 200, { success: true, ...result }))
          .catch(e => sendJson(res, 200, { success: false, error: e.message || String(e) }));
        return;
      }

      // API: Experimental features switch (Personalization tab). This PC only.
      if (pathname === '/api/settings/experimental' && req.method === 'POST') {
        readJsonBody(req).then((body) => {
          const result = this.configManager.setExperimental(body.controlSheet === true);
          if (!result.success) {
            sendJson(res, 400, result);
            return;
          }
          this.controlSheet.clearCaches();
          this.engine.log('info', `Experimental Control Sheet ${result.experimentalControlSheet ? 'enabled' : 'disabled'}.`);
          sendJson(res, 200, result);
        }).catch((e) => sendJson(res, 400, { success: false, error: e.message }));
        return;
      }

      // API: Setup Check and "Prepare for sharing"
      if (pathname.startsWith('/api/setup-check') || pathname.startsWith('/api/publish/')) {
        if (await this.handleSetup(req, res, pathname)) return;
        sendJson(res, 404, { success: false, error: 'Unknown setup endpoint.' });
        return;
      }

      // API: App and scene collection update checks
      if (pathname.startsWith('/api/updates/')) {
        if (await this.handleUpdates(req, res, pathname, parsedUrl)) return;
        sendJson(res, 404, { success: false, error: 'Unknown update endpoint.' });
        return;
      }

      // API: Get Full Profiles structure
      if (pathname === '/api/profiles' && req.method === 'GET') {
        const fullData = this.configManager.getFullData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fullData));
        return;
      }

      // API: Switch Active Profile
      if (pathname === '/api/profiles/switch' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { profileName } = JSON.parse(body || '{}');
            const result = this.configManager.switchProfile(profileName);
            if (result.success) {
              this.engine.log('info', `Switched active profile to "${profileName}".`);
              this.controlSheet.clearCaches();
              // Reset cached visibility states for clean sync on profile switch
              this.engine.visibilityStateMap.clear();
              if (this.engine.isRunning && !this.engine.simulationMode) {
                this.engine.updateCycle({ force: true }).catch(() => {});
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // API: Create Profile
      if (pathname === '/api/profiles/create' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { profileName, baseConfig } = JSON.parse(body || '{}');
            const result = this.configManager.createProfile(profileName, baseConfig);
            if (result.success) {
              this.engine.log('info', `Created new profile "${profileName}".`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // API: Rename Profile
      if (pathname === '/api/profiles/rename' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { oldName, newName } = JSON.parse(body || '{}');
            const result = this.configManager.renameProfile(oldName, newName);
            if (result.success) {
              this.engine.log('info', `Renamed profile "${oldName}" to "${newName}".`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // API: Delete Profile
      if (pathname === '/api/profiles/delete' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { profileName } = JSON.parse(body || '{}');
            const result = this.configManager.deleteProfile(profileName);
            if (result.success) {
              this.engine.log('info', `Deleted profile "${profileName}". Active is now "${result.activeProfile}".`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // API: Export Profile / All Profiles
      if (pathname === '/api/profiles/export' && req.method === 'GET') {
        const profileParam = parsedUrl.searchParams.get('profile');
        const isClean = parsedUrl.searchParams.get('clean') === 'true';
        // Admin hand-off: a clean export that keeps the Sheet ID + Google API key.
        const shareAccess = isClean && parsedUrl.searchParams.get('sheetAccess') === '1';
        const opts = { includeSheetAccess: shareAccess };
        const kind = !isClean ? 'backup' : (shareAccess ? 'with-sheet-access' : 'clean');
        let data;
        let filename;
        if (profileParam === 'all') {
          data = this.configManager.exportAll(!isClean, opts);
          filename = `SheetsToOBS-all-profiles-${kind}.json`;
        } else {
          data = this.configManager.exportProfile(profileParam, !isClean, opts);
          const safeName = (data ? data.profileName : 'config').replace(/[^a-zA-Z0-9_-]/g, '_');
          filename = `SheetsToOBS-profile-${safeName}-${kind}.json`;
        }

        if (!data) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Profile not found' }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${filename}"`
        });
        res.end(JSON.stringify(data, null, 2));
        return;
      }

      // API: Import Profile / Profiles
      if (pathname === '/api/profiles/import' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { json, overrideName, overwrite } = JSON.parse(body || '{}');
            const result = this.configManager.importData(json, overrideName, { overwrite: overwrite === true });
            if (result.success) {
              this.engine.log('info', result.message || 'Import successful.');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // API: Controls (start, stop, sync-now, simulation)
      if (pathname === '/api/control/start' && req.method === 'POST') {
        this.engine.start();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, running: true }));
        return;
      }

      if (pathname === '/api/control/stop' && req.method === 'POST') {
        this.engine.stop();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, running: false }));
        return;
      }

      if (pathname === '/api/control/sync-now' && req.method === 'POST') {
        if (!this.engine.isRunning) {
          this.engine.start();
        } else {
          this.engine.updateCycle({ force: true }).catch(() => {});
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (pathname === '/api/control/simulation' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = body ? JSON.parse(body) : {};
            this.engine.toggleSimulation(data.enabled);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, simulation: this.engine.simulationMode }));
          } catch (e) {
            this.engine.toggleSimulation();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, simulation: this.engine.simulationMode }));
          }
        });
        return;
      }

      // API: Test OBS Connection
      if (pathname === '/api/test/obs' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const config = this.configManager.load();
            const address = data.obsaddress || config.obsaddress;
            const password = data.obsauth !== undefined ? data.obsauth : config.obsauth;
            const result = await ImporterEngine.testObsConnection(address, password);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // API: Scene collections in OBS (for the "Required scene collection" setting)
      if (pathname === '/api/obs/scene-collections' && req.method === 'GET') {
        (async () => {
          try {
            if (this.engine.obs && this.engine.obsStatus.connected && !this.engine.simulationMode) {
              const r = await this.engine.obs.call('GetSceneCollectionList');
              sendJson(res, 200, { success: true, current: r.currentSceneCollectionName || '', collections: r.sceneCollections || [] });
              return;
            }
            const config = this.configManager.load();
            const t = await ImporterEngine.testObsConnection(config.obsaddress, config.obsauth);
            if (!t.success) {
              sendJson(res, 200, { success: false, error: t.error });
              return;
            }
            sendJson(res, 200, { success: true, current: t.sceneCollection || '', collections: t.sceneCollections || [] });
          } catch (e) {
            sendJson(res, 200, { success: false, error: e.message });
          }
        })();
        return;
      }

      // API: Test Google Sheet Connection
      if (pathname === '/api/test/sheet' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const config = this.configManager.load();
            const sheetId = data.sheetId || config.sheetId;
            const tabname = data.tabname || config.tabname;
            const range = data.range || config.range;
            const apikey = data.apikey || config.apikey;
            const dimension = data.dimension || config.dimension;

            const result = await ImporterEngine.testSheetConnection(sheetId, tabname, range, apikey, dimension);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // Static File Serving
      let resolvedPath = pathname === '/' ? 'index.html' : pathname;
      if (pathname === '/dashboard' || pathname === '/demo' || pathname === '/remote') {
        resolvedPath = 'dashboard.html';
      }
      let filePath = path.join(publicDir, resolvedPath);

      if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
        res.writeHead(403);
        res.end('Access Denied');
        return;
      }

      const mimeTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      };

      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      fs.readFile(filePath, (err, content) => {
        if (err) {
          if (err.code === 'ENOENT') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File Not Found');
          } else {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Server Error: ${err.code}`);
          }
        } else {
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': contentType,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          });
          res.end(content, 'utf-8');
        }
      });
    });

    // Only listen on the network when the experimental LAN dashboard is switched on;
    // otherwise other devices can't even reach the port (and Windows won't ask
    // about the firewall). Changing that setting needs a restart.
    const startCfg = this.configManager.load();
    this.lanBound = !!(this.configManager.isExperimentalEnabled() && startCfg.allowLanDashboard);
    const host = this.lanBound ? undefined : (this.listenHost || '127.0.0.1');
    server.listen(this.port, host, () => {
      console.log(`[SheetsToOBS Desktop Server] Running on http://localhost:${this.port}${this.lanBound ? ' (also reachable from the local network)' : ''}`);
      const initialConfig = this.configManager.load();
      const resume = this.consumeResumeMarker();
      if (resume) {
        this.engine.log('warn', 'SheetsToOBS restarted after an unexpected error (details in logs\\crash.log). Syncing is resumed.');
      }
      if (initialConfig.autoStart || resume) {
        this.engine.start();
      }
    });

    return server;
  }
}

// Global Process Crash Watchdogs
let activeServer = null;
process.on('uncaughtException', (err) => {
  DesktopServer.writeCrashLog(err, 'UNCAUGHT_EXCEPTION');
  // Exit code 1 tells the tray launcher to start the server again.
  if (activeServer) activeServer.markResumeIfRunning();
  console.error('[CRITICAL] Uncaught exception occurred:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  DesktopServer.writeCrashLog(err, 'UNHANDLED_REJECTION');
  console.error('[WARNING] Unhandled promise rejection:', reason);
});

if (require.main === module) {
  const srv = new DesktopServer(4587);
  activeServer = srv;
  srv.start();
}

module.exports = DesktopServer;
