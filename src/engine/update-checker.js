const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { dataFile } = require('../paths');
const sceneShare = require('./scene-share');

// Update checks. Two independent things:
//  1. A newer SheetsToOBS release on GitHub (the UI links to the release page;
//     nothing is downloaded or run automatically).
//  2. A newer OBS scene collection export, described by a small manifest the
//     producer hosts somewhere (per profile):
//       { "name": "CCS Broadcast", "version": "1.4.0", "url": "CCS.json",
//         "notes": "New caster cam", "sha256": "<optional>" }
//     "url" may be relative to the manifest. The file is downloaded into the
//     data folder; OBS has no WebSocket request to import a collection, so the
//     user imports it with Scene Collection > Import.
//     Packages made with "Prepare for sharing" (scene-share.js) also list
//     "media" files (downloaded into the producer's media folder, which replaces
//     the {{MEDIA}} placeholder), "optionalMedia", "requirements" (plugins,
//     fonts, League esports timers) for the Setup Check, and checklist "links".

const REPO = 'MisterBantastic/SheetsToOBS';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const MANIFEST_MAX_BYTES = 64 * 1024;
const COLLECTION_MAX_BYTES = 50 * 1024 * 1024;
const MEDIA_MAX_BYTES = 500 * 1024 * 1024;
// A plain file name: no folders, no characters Windows forbids, not ending in a dot or space.
const MEDIA_FILE_RE = /^(?!\.{1,2}$)[^\\/:*?"<>|\x00-\x1f]{0,149}[^\\/:*?"<>|\x00-\x1f. ]$/;
const TIMEOUT_MS = 10000; // manifests and the GitHub release check
// Big files on a slow connection need far longer than a manifest does.
const COLLECTION_TIMEOUT_MS = 2 * 60 * 1000;
const MEDIA_TIMEOUT_MS = 15 * 60 * 1000;
const VERSION_RE = /^v?[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

function appVersion() {
  try {
    return require('../../package.json').version || '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

/**
 * Compares two version strings ("1.10.0" > "1.9.2", "v1.2" == "1.2.0").
 * A pre-release ("1.2.0-beta") sorts before its release. Returns -1, 0 or 1.
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v || '').trim().replace(/^v/i, '').split('+')[0];
    const dash = s.indexOf('-');
    const main = dash === -1 ? s : s.slice(0, dash);
    const pre = dash === -1 ? '' : s.slice(dash + 1);
    return { nums: main.split('.').map(n => parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  const len = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true }) > 0 ? 1 : -1;
}

/** HTTPS-only GET. Redirects to plain http are refused. */
async function httpsGet(url, { maxBytes, responseType = 'json', headers = {}, timeout = TIMEOUT_MS } = {}) {
  const res = await axios.get(url, {
    timeout,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    maxRedirects: 5,
    responseType,
    headers: { 'User-Agent': `SheetsToOBS/${appVersion()}`, ...headers },
    beforeRedirect: (options) => {
      if (options.protocol !== 'https:') throw new Error('Refused a redirect to a non-HTTPS address.');
    }
  });
  return res.data;
}

function shortText(value, max = 2000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Turns a GitHub "latest release" API response into what the UI needs. */
function parseRelease(data, currentVersion) {
  if (!data || typeof data !== 'object' || typeof data.tag_name !== 'string' || !VERSION_RE.test(data.tag_name)) {
    throw new Error('GitHub returned an unexpected release format.');
  }
  const latest = data.tag_name.replace(/^v/i, '');
  // Only ever link to this project's own release pages.
  const prefix = `https://github.com/${REPO}/releases/`;
  const url = typeof data.html_url === 'string' && data.html_url.startsWith(prefix) ? data.html_url : RELEASES_PAGE;
  return {
    current: currentVersion,
    latest,
    newer: compareVersions(latest, currentVersion) > 0,
    url,
    name: shortText(data.name, 200),
    notes: shortText(data.body),
    publishedAt: shortText(data.published_at, 40)
  };
}

async function checkApp({ get = httpsGet, currentVersion = appVersion() } = {}) {
  const data = await get(RELEASES_API, {
    maxBytes: 1024 * 1024,
    headers: { Accept: 'application/vnd.github+json' }
  });
  return parseRelease(data, currentVersion);
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/** Validates a scene collection manifest and resolves its file URL. Throws with a readable message. */
function parseManifest(data, manifestUrl) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('The update manifest is not a JSON object.');
  }
  const version = typeof data.version === 'string' || typeof data.version === 'number' ? String(data.version).trim() : '';
  if (!VERSION_RE.test(version)) {
    throw new Error('The update manifest needs a "version", e.g. "1.4.0".');
  }
  if (typeof data.url !== 'string' || !data.url.trim()) {
    throw new Error('The update manifest needs a "url" pointing to the scene collection .json.');
  }
  let fileUrl;
  try {
    fileUrl = new URL(data.url.trim(), manifestUrl).toString();
  } catch (e) {
    throw new Error('The "url" in the update manifest is not a valid address.');
  }
  if (!isHttpsUrl(fileUrl)) {
    throw new Error('The scene collection "url" must start with https://');
  }
  return {
    name: shortText(data.name, 100).trim() || 'Scene Collection',
    version: version.replace(/^v/i, ''),
    url: fileUrl,
    notes: shortText(data.notes),
    sha256: parseSha(data.sha256),
    media: parseMediaList(data.media, manifestUrl),
    optionalMedia: (Array.isArray(data.optionalMedia) ? data.optionalMedia : [])
      .filter(s => typeof s === 'string' && s.trim()).slice(0, 50).map(s => s.slice(0, 150)),
    requirements: parseRequirements(data.requirements),
    // Checklist items for the Setup Check. The link is optional.
    links: (Array.isArray(data.links) ? data.links : []).slice(0, 20)
      .filter(l => l && typeof l.label === 'string' && l.label.trim())
      .map(l => ({ label: l.label.trim().slice(0, 120), url: isHttpsUrl(l.url) ? String(l.url) : '' }))
  };
}

function parseSha(value) {
  const sha = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (sha && !/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error('A "sha256" in the update manifest is not 64 hex characters.');
  }
  return sha;
}

function parseMediaList(list, manifestUrl) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 100) throw new Error('"media" in the update manifest must be a list (at most 100 files).');
  return list.map((m) => {
    if (!m || typeof m.file !== 'string' || !MEDIA_FILE_RE.test(m.file)) {
      throw new Error('Every "media" entry needs a plain file name, without folders.');
    }
    if (!sceneShare.isAllowedMedia(m.file)) {
      throw new Error(`"${m.file}" is not a media file (picture, video, sound or font). Setup kits can't download other file types.`);
    }
    let url;
    try {
      url = new URL(String(m.url || ''), manifestUrl).toString();
    } catch (e) {
      throw new Error(`The url for media file "${m.file}" is not valid.`);
    }
    if (!isHttpsUrl(url)) throw new Error(`The url for media file "${m.file}" must start with https://`);
    return { file: m.file, url, sha256: parseSha(m.sha256), size: Number.isFinite(m.size) ? m.size : 0 };
  });
}

function parseRequirements(req) {
  const r = req && typeof req === 'object' ? req : {};
  const plugins = (Array.isArray(r.plugins) ? r.plugins : []).slice(0, 30)
    .filter(p => p && typeof p.id === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,59}$/.test(p.id))
    .map(p => ({
      id: p.id,
      name: shortText(p.name, 80) || p.id,
      dll: typeof p.dll === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}\.dll$/i.test(p.dll) ? p.dll : '',
      minVersion: typeof p.minVersion === 'string' && VERSION_RE.test(p.minVersion) ? p.minVersion : '',
      url: isHttpsUrl(p.url) ? String(p.url) : ''
    }));
  const fonts = (Array.isArray(r.fonts) ? r.fonts : []).slice(0, 50)
    .filter(f => typeof f === 'string' && f.trim()).map(f => f.trim().slice(0, 100));
  return { plugins, fonts, leagueEsportsTimers: r.leagueEsportsTimers === true };
}

async function checkSceneCollection(manifestUrl, installedVersion, { get = httpsGet } = {}) {
  if (!isHttpsUrl(manifestUrl)) {
    throw new Error('The scene collection update URL must start with https://');
  }
  const data = await get(manifestUrl, { maxBytes: MANIFEST_MAX_BYTES });
  const manifest = parseManifest(typeof data === 'string' ? JSON.parse(data) : data, manifestUrl);
  return {
    ...manifest,
    installed: installedVersion || '',
    newer: !installedVersion || compareVersions(manifest.version, installedVersion) > 0
  };
}

function hostedError(err) {
  const status = err && err.response && err.response.status;
  if (status === 404) return 'Not found (404). Check the link, that the files are pushed, and that the repo is public.';
  if (status) return `The server answered ${status}.`;
  return (err && err.message) || String(err);
}

/**
 * The admin's "Test my link": fetches a hosted kit the way a producer's PC would
 * and checks every file against the manifest. Never throws for a bad kit.
 */
async function verifyHostedPackage(rawUrl, { get = httpsGet } = {}) {
  const url = sceneShare.normalizeManifestUrl(rawUrl);
  const items = [];
  let info;
  try {
    info = await checkSceneCollection(url, '', { get });
    items.push({ label: 'manifest.json', ok: true, detail: `"${info.name}" v${info.version}` });
  } catch (err) {
    items.push({ label: 'manifest.json', ok: false, detail: hostedError(err) });
    return { url, ok: false, items };
  }
  try {
    const raw = await get(info.url, { maxBytes: COLLECTION_MAX_BYTES, responseType: 'arraybuffer', timeout: COLLECTION_TIMEOUT_MS });
    const json = validateSceneCollection(Buffer.isBuffer(raw) ? raw : Buffer.from(raw), info.sha256);
    const scripts = sceneShare.countScripts(json);
    if (scripts) {
      items.push({ label: 'OBS scripts', ok: true, detail: `${scripts} script(s) in Tools > Scripts are not passed on: SheetsToOBS removes them on each producer's PC. Tell producers to add them by hand if the show needs them.` });
    }
    const secrets = sceneShare.findPrivateUrls(json);
    items.push(secrets.length
      ? { label: 'Scene collection', ok: false, detail: `Readable, but ${secrets.length} private-looking URL(s) are public in it (${[...new Set(secrets)].join(', ')}).` }
      : { label: 'Scene collection', ok: true, detail: 'Readable, and no private-looking URLs found.' });
  } catch (err) {
    items.push({ label: 'Scene collection', ok: false, detail: hostedError(err) });
  }
  for (const m of info.media) {
    try {
      const raw = await get(m.url, { maxBytes: MEDIA_MAX_BYTES, responseType: 'arraybuffer', timeout: MEDIA_TIMEOUT_MS });
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const match = !m.sha256 || crypto.createHash('sha256').update(buf).digest('hex') === m.sha256;
      items.push(match
        ? { label: m.file, ok: true, detail: 'Matches the manifest.' }
        : { label: m.file, ok: false, detail: 'Different from the manifest. If you just pushed, GitHub can take about 5 minutes to update.' });
    } catch (err) {
      items.push({ label: m.file, ok: false, detail: hostedError(err) });
    }
  }
  return { url, ok: items.every(i => i.ok), name: info.name, version: info.version, items };
}

/** Throws unless the bytes are an OBS scene collection export (Scene Collection > Export). */
function validateSceneCollection(buffer, sha256) {
  if (sha256) {
    const actual = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actual !== sha256) throw new Error('The downloaded file does not match the sha256 in the manifest.');
  }
  let json;
  try {
    json = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new Error('The downloaded file is not valid JSON.');
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json.sources)) {
    throw new Error('The downloaded file does not look like an OBS scene collection export.');
  }
  return json;
}

function safeFileName(name, version) {
  const clean = (s) => String(s).replace(/[^A-Za-z0-9 _.-]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'scene-collection';
  return `${clean(name)} v${clean(version)}.json`;
}

function collectionsDir() {
  return dataFile('scene-collections');
}

/** Default media folder for a collection: <data folder>\media\<collection name>. */
function defaultMediaDir(manifestName) {
  return dataFile('media', sceneShare.safeName(manifestName || 'Scene Collection'));
}

function fileMatches(filePath, sha) {
  if (!fs.existsSync(filePath)) return false;
  if (!sha) return true;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') === sha;
}

/**
 * Downloads the media files, then the collection named in a checked manifest,
 * with the {{MEDIA}} placeholder replaced by this PC's media folder.
 */
async function downloadSceneCollection(manifest, { get = httpsGet, dir = collectionsDir(), mediaDir } = {}) {
  const media = manifest.media || [];
  const targetMedia = mediaDir || defaultMediaDir(manifest.name);
  let downloaded = 0;
  let skipped = 0;
  if (media.length) fs.mkdirSync(targetMedia, { recursive: true });
  for (const m of media) {
    const target = path.join(targetMedia, m.file);
    if (fileMatches(target, m.sha256)) {
      skipped++;
      continue;
    }
    const raw = await get(m.url, { maxBytes: MEDIA_MAX_BYTES, responseType: 'arraybuffer', timeout: MEDIA_TIMEOUT_MS });
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (m.sha256 && crypto.createHash('sha256').update(buf).digest('hex') !== m.sha256) {
      throw new Error(`Media file "${m.file}" does not match its sha256 in the manifest.`);
    }
    fs.writeFileSync(target, buf);
    downloaded++;
  }

  const raw = await get(manifest.url, { maxBytes: COLLECTION_MAX_BYTES, responseType: 'arraybuffer', timeout: COLLECTION_TIMEOUT_MS });
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const json = validateSceneCollection(buffer, manifest.sha256);
  const pathsFixed = sceneShare.applyMediaFolder(json, targetMedia);
  // A collection from someone else never brings OBS scripts with it.
  const scriptsRemoved = sceneShare.removeScripts(json);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, safeFileName(manifest.name, manifest.version));
  fs.writeFileSync(filePath, pathsFixed || scriptsRemoved ? JSON.stringify(json, null, 4) : buffer);
  return {
    filePath,
    fileName: path.basename(filePath),
    dir,
    mediaDir: media.length ? targetMedia : '',
    mediaDownloaded: downloaded,
    mediaSkipped: skipped,
    pathsFixed,
    scriptsRemoved
  };
}

module.exports = {
  REPO,
  RELEASES_PAGE,
  appVersion,
  compareVersions,
  parseRelease,
  checkApp,
  parseManifest,
  parseRequirements,
  verifyHostedPackage,
  checkSceneCollection,
  validateSceneCollection,
  safeFileName,
  collectionsDir,
  defaultMediaDir,
  downloadSceneCollection
};
