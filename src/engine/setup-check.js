const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { compareVersions } = require('./update-checker');
const { KNOWN_PLUGINS, BUILT_IN_DLLS } = require('./scene-share');

// Setup Check: walks a producer through everything the show needs on this PC
// (profile, OBS WebSocket, plugins + versions, fonts, League esports timers,
// media files) and fixes what it safely can. Plugin/font/media requirements come
// from the scene collection manifest (see scene-share.js). Runs automatically
// once after an install/update and after a scene collection download; otherwise
// only when the user presses "Run setup check".

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true, ...opts }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** Real system access. Tests pass their own. */
const realSystem = {
  exists: (p) => fs.existsSync(p),
  listDir: (p) => {
    try {
      return fs.readdirSync(p);
    } catch (e) {
      return [];
    }
  },
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  writeFile: (p, data) => fs.writeFileSync(p, data, 'utf8'),
  copyFile: (a, b) => fs.copyFileSync(a, b),
  sha256: (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
  env: process.env,

  /** { path: version } for DLLs, read from their Windows version info. */
  async fileVersions(paths) {
    if (!paths.length || process.platform !== 'win32') return {};
    const script = '$p = $env:STO_PATHS | ConvertFrom-Json; @($p | ForEach-Object { ' +
      '$v = (Get-Item -LiteralPath $_).VersionInfo; [pscustomobject]@{ p = $_; f = $v.FileVersion; pr = $v.ProductVersion } }) | ConvertTo-Json -Compress';
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, STO_PATHS: JSON.stringify(paths) }
    });
    const result = {};
    try {
      let rows = JSON.parse(out || '[]');
      if (!Array.isArray(rows)) rows = [rows];
      rows.forEach((r) => {
        const pr = String(r.pr || '').split('+')[0].trim();
        result[r.p] = /^\d+(\.\d+)*$/.test(pr) ? pr : String(r.f || '').trim();
      });
    } catch (e) { /* versions unknown */ }
    return result;
  },

  /** Font names registered for all users and for this user. */
  async installedFonts() {
    if (process.platform !== 'win32') return [];
    const keys = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
    ];
    const names = [];
    for (const key of keys) {
      const out = await run('reg', ['query', key]);
      out.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+/);
        if (m) m[1].replace(/\s*\((TrueType|OpenType|All res)\)\s*$/i, '').split(/\s*&\s*/).forEach(n => names.push(n));
      });
    }
    return names;
  },

  /** OBS install folder from the registry (custom install locations). */
  async obsInstallDir() {
    if (process.platform !== 'win32') return '';
    const out = await run('reg', ['query', 'HKLM\\SOFTWARE\\OBS Studio', '/ve']);
    const m = out.match(/REG_SZ\s+(.+)\s*$/m);
    return m ? m[1].trim() : '';
  }
};

function pluginCandidates(plugin, sys, obsDir) {
  const env = sys.env || {};
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pd = env.ProgramData || 'C:\\ProgramData';
  const dll = plugin.dll || `${plugin.id}.dll`;
  const list = [
    path.join(pf, 'obs-studio', 'obs-plugins', '64bit', dll),
    path.join(pd, 'obs-studio', 'plugins', plugin.id, 'bin', '64bit', dll)
  ];
  if (obsDir) list.push(path.join(obsDir, 'obs-plugins', '64bit', dll));
  if (env.APPDATA) list.push(path.join(env.APPDATA, 'obs-studio', 'plugins', plugin.id, 'bin', '64bit', dll));
  return [...new Set(list)];
}

function fontInstalled(face, installed) {
  const f = face.toLowerCase();
  return installed.some((n) => {
    const name = n.toLowerCase();
    return name === f || name.startsWith(`${f} `);
  });
}

/** League's game.cfg files on this PC (from Riot's install list, plus the default folder). */
function findGameCfgs(sys) {
  const env = sys.env || {};
  const pd = env.ProgramData || 'C:\\ProgramData';
  const dirs = ['C:/Riot Games/League of Legends/'];
  const installs = path.join(pd, 'Riot Games', 'RiotClientInstalls.json');
  if (sys.exists(installs)) {
    try {
      const data = JSON.parse(sys.readFile(installs));
      Object.keys(data.associated_client || {}).forEach(d => dirs.push(d));
    } catch (e) { /* ignore */ }
  }
  const seen = new Set();
  return dirs
    .filter(d => /league of legends/i.test(d))
    .map(d => path.normalize(path.join(d, 'Config', 'game.cfg')))
    .filter((p) => {
      const k = p.toLowerCase();
      if (seen.has(k) || !sys.exists(p)) return false;
      seen.add(k);
      return true;
    });
}

function hasEsportsTimers(text) {
  const lines = String(text).split(/\r?\n/);
  let inSpectator = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[(.+?)\]\s*$/);
    if (section) {
      inSpectator = section[1].toLowerCase() === 'spectator';
      continue;
    }
    if (inSpectator && /^\s*eSportsNeutralTimers\s*=\s*1\s*$/i.test(line)) return true;
  }
  return false;
}

/** Adds (or turns on) eSportsNeutralTimers=1 in the [Spectator] section. */
function enableEsportsTimers(text) {
  const src = String(text);
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex(l => /^\s*\[spectator\]\s*$/i.test(l));
  if (start === -1) {
    return `${src.replace(/\s+$/, '')}${eol}[Spectator]${eol}eSportsNeutralTimers=1${eol}`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const rel = lines.slice(start + 1, end).findIndex(l => /^\s*eSportsNeutralTimers\s*=/i.test(l));
  if (rel >= 0) lines[start + 1 + rel] = 'eSportsNeutralTimers=1';
  else lines.splice(start + 1, 0, 'eSportsNeutralTimers=1');
  return lines.join(eol);
}

/** Turns the esports timers on in every game.cfg found. Backs each file up once. */
function fixEsportsTimers(sys = realSystem) {
  const files = findGameCfgs(sys);
  if (!files.length) throw new Error('League of Legends was not found on this PC.');
  const changed = [];
  files.forEach((file) => {
    const text = sys.readFile(file);
    if (hasEsportsTimers(text)) return;
    const backup = `${file}.sheetstoobs-backup`;
    if (!sys.exists(backup)) sys.copyFile(file, backup);
    sys.writeFile(file, enableEsportsTimers(text));
    changed.push(file);
  });
  return { files, changed };
}

/** { pluginId: version } for the known plugins installed on this PC (the admin's "tested on"). */
async function installedPluginVersions(sys = realSystem) {
  const obsDir = await sys.obsInstallDir();
  const found = {};
  Object.entries(KNOWN_PLUGINS).forEach(([id, p]) => {
    const hit = pluginCandidates({ id, dll: p.dll }, sys, obsDir).find(c => sys.exists(c));
    if (hit) found[id] = hit;
  });
  const versions = await sys.fileVersions(Object.values(found));
  const out = {};
  Object.entries(found).forEach(([id, p]) => { if (versions[p]) out[id] = versions[p]; });
  return out;
}

/**
 * Every third-party plugin on this PC, whether we know it or not, so an admin
 * can pick which ones producers need: [{ id, name, dll, version, url }].
 */
async function scanInstalledPlugins(sys = realSystem) {
  const env = sys.env || {};
  const list = sys.listDir || (() => []);
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pd = env.ProgramData || 'C:\\ProgramData';
  const obsDir = await sys.obsInstallDir();
  const found = new Map();
  const add = (id, dll, file) => {
    if (!found.has(id.toLowerCase())) found.set(id.toLowerCase(), { id, dll, file });
  };
  [path.join(pf, 'obs-studio', 'obs-plugins', '64bit'), obsDir && path.join(obsDir, 'obs-plugins', '64bit')].filter(Boolean).forEach((dir) => {
    list(dir).filter(f => /\.dll$/i.test(f)).forEach((f) => {
      const id = f.replace(/\.dll$/i, '');
      if (!BUILT_IN_DLLS.has(id.toLowerCase())) add(id, f, path.join(dir, f));
    });
  });
  [path.join(pd, 'obs-studio', 'plugins'), env.APPDATA && path.join(env.APPDATA, 'obs-studio', 'plugins')].filter(Boolean).forEach((root) => {
    list(root).forEach((id) => {
      const file = path.join(root, id, 'bin', '64bit', `${id}.dll`);
      if (sys.exists(file)) add(id, `${id}.dll`, file);
    });
  });
  const rows = [...found.values()];
  const versions = await sys.fileVersions(rows.map(r => r.file));
  return rows.map((r) => {
    const known = KNOWN_PLUGINS[r.id];
    return { id: r.id, name: known ? known.name : r.id, dll: r.dll, version: versions[r.file] || '', url: known ? known.url : '' };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Runs every check. Returns [{ id, title, status: ok|warn|fail|info, detail, link?, fix? }].
 *  config: the active profile; info: checkSceneCollection() result or null;
 *  infoError: why the manifest couldn't be read; testObs(address, password) -> { success, ... }.
 */
async function runChecks({ config, info, infoError, mediaDir, testObs, sys = realSystem }) {
  const items = [];
  const add = (item) => items.push(item);

  // fix 'import-profile': the window offers to import the profile file from the league admin.
  add(config.sheetId && config.apikey
    ? { id: 'profile', title: 'Profile', status: 'ok', fix: 'import-profile', detail: `Profile "${config.activeProfile}" has a Sheet ID and Google API key.` }
    : { id: 'profile', title: 'Profile', status: 'fail', fix: 'import-profile', detail: 'No Sheet ID or Google API key yet. Press Import profile and choose the profile file your league admin sent you.' });

  try {
    const obs = await testObs(config.obsaddress, config.obsauth);
    add(obs.success
      ? { id: 'obs', title: 'OBS WebSocket', status: 'ok', detail: `Connected to OBS${obs.obsVersion ? ` ${obs.obsVersion}` : ''} at ${config.obsaddress}.` }
      : { id: 'obs', title: 'OBS WebSocket', status: 'fail', detail: `Can't reach OBS at ${config.obsaddress} (${obs.error || 'no answer'}). Start OBS, turn on Tools › WebSocket Server Settings › Enable, and put its password in Profiles & Config.` });
  } catch (e) {
    add({ id: 'obs', title: 'OBS WebSocket', status: 'fail', detail: e.message });
  }

  if (!config.sceneCollectionManifestUrl) {
    add({ id: 'manifest', title: 'Scene collection', status: 'warn', fix: 'import-profile', detail: 'No Scene Collection Update URL in this profile, so plugins, fonts and media can\'t be checked. Ask your admin for it, or import the profile file they made (it usually includes it).' });
    return items;
  }
  if (!info) {
    add({ id: 'manifest', title: 'Scene collection', status: 'fail', detail: `Could not read the scene collection manifest: ${infoError || 'unknown error'}.` });
    return items;
  }

  let from = '';
  try {
    from = ` Setup kit from ${new URL(config.sceneCollectionManifestUrl).host}.`;
  } catch (e) { /* the manifest was read, so this is only cosmetic */ }
  add(info.installed && !info.newer
    ? { id: 'collection', title: `Scene collection "${info.name}"`, status: 'ok', detail: `v${info.installed} downloaded. Import it in OBS (Scene Collection › Import) if you haven't yet.${from}` }
    : { id: 'collection', title: `Scene collection "${info.name}"`, status: 'fail', fix: 'download-collection', detail: `${info.installed ? `v${info.version} is available (you have v${info.installed}).` : `v${info.version} hasn't been downloaded on this PC yet.`}${from}` });

  const req = info.requirements || { plugins: [], fonts: [] };
  if (req.plugins.length) {
    const obsDir = await sys.obsInstallDir();
    const found = {};
    req.plugins.forEach((p) => {
      const known = KNOWN_PLUGINS[p.id];
      found[p.id] = pluginCandidates({ ...p, dll: p.dll || (known && known.dll) }, sys, obsDir).find(c => sys.exists(c)) || '';
    });
    const versions = await sys.fileVersions(Object.values(found).filter(Boolean));
    req.plugins.forEach((p) => {
      const where = found[p.id];
      const have = where ? versions[where] || '' : '';
      let item;
      if (!where) {
        item = { status: 'fail', detail: `Not installed. Close OBS, install it${p.minVersion ? ` (${p.minVersion} or newer)` : ''}, then start OBS again.` };
      } else if (p.minVersion && have && compareVersions(have, p.minVersion) < 0) {
        item = { status: 'fail', detail: `Version ${have} is older than ${p.minVersion}. Older versions can crash or break this collection. Close OBS and update it.` };
      } else {
        item = { status: 'ok', detail: `Installed${have ? ` (${have})` : ''}.` };
      }
      add({ id: `plugin:${p.id}`, title: `Plugin: ${p.name}`, link: item.status === 'ok' ? undefined : p.url, ...item });
    });
  }

  if (req.fonts.length) {
    const installed = await sys.installedFonts();
    const missing = req.fonts.filter(f => !fontInstalled(f, installed));
    add(missing.length
      ? { id: 'fonts', title: 'Fonts', status: 'fail', detail: `Missing: ${missing.join(', ')}. Install them (right-click › Install), then restart OBS.` }
      : { id: 'fonts', title: 'Fonts', status: 'ok', detail: `All installed: ${req.fonts.join(', ')}.` });
  }

  if (req.leagueEsportsTimers) {
    const cfgs = findGameCfgs(sys);
    if (!cfgs.length) {
      add({ id: 'league-timers', title: 'League esports timers', status: 'warn', detail: 'League of Legends was not found. In League\'s Config\\game.cfg, add [Spectator] and eSportsNeutralTimers=1 at the bottom.' });
    } else {
      const off = cfgs.filter(f => !hasEsportsTimers(sys.readFile(f)));
      add(off.length
        ? { id: 'league-timers', title: 'League esports timers', status: 'fail', fix: 'league-timers', detail: `Not turned on in ${off.join(', ')}. Close League, then press Fix.` }
        : { id: 'league-timers', title: 'League esports timers', status: 'ok', detail: 'eSportsNeutralTimers=1 is set.' });
    }
  }

  if (info.media && info.media.length) {
    const missing = info.media.filter(m => !sys.exists(path.join(mediaDir, m.file)));
    add(missing.length
      ? { id: 'media', title: 'Media files', status: 'fail', fix: 'download-collection', detail: `${missing.length} of ${info.media.length} missing in ${mediaDir}: ${missing.map(m => m.file).join(', ')}.` }
      : { id: 'media', title: 'Media files', status: 'ok', detail: `All ${info.media.length} files are in ${mediaDir}.` });
  }
  if (info.optionalMedia && info.optionalMedia.length) {
    add({ id: 'optional-media', title: 'Optional media (not included)', status: 'info', detail: `${info.optionalMedia.join(', ')}. Only needed if your show uses them; OBS will list them as missing files.` });
  }

  (info.links || []).forEach((l, i) => add({ id: `link:${i}`, title: l.label, status: 'info', detail: 'From your league admin: check this by hand.', link: l.url || undefined }));
  return items;
}

module.exports = {
  realSystem,
  runChecks,
  installedPluginVersions,
  scanInstalledPlugins,
  findGameCfgs,
  hasEsportsTimers,
  enableEsportsTimers,
  fixEsportsTimers,
  fontInstalled,
  pluginCandidates
};
