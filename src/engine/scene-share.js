const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// "Prepare for sharing": turns an OBS scene collection export into a package an
// admin can host publicly (e.g. a GitHub repo) for producers:
//  - private URLs (StreamElements overlay tokens, ?key=, ?password=, VDO.Ninja
//    rooms) are blanked on "|sheet" sources, because the sheet fills them in
//    again on the first sync; elsewhere they are only reported;
//  - local paths to files in the admin's media folder become "{{MEDIA}}/<file>",
//    which each producer's copy replaces with their own media folder on download;
//  - required plugins and fonts are detected for the producer's Setup Check.
// Output folder: manifest.json + the collection + media/ (ready to upload).

const MEDIA_TOKEN = '{{MEDIA}}';
const SHEET_NAME_RE = /\|sheet\s*\d+/i;
const SECRET_PARAMS = /^(key|token|apikey|api_key|access_token|auth|secret|password|pass|pw|room|code)$/i;

// Plugins we know how to detect, by what they add to a scene collection.
const KNOWN_PLUGINS = {
  'advanced-scene-switcher': {
    name: 'Advanced Scene Switcher',
    dll: 'advanced-scene-switcher.dll',
    url: 'https://obsproject.com/forum/resources/advanced-scene-switcher.395/'
  },
  'move-transition': {
    name: 'Move Transition',
    dll: 'move-transition.dll',
    url: 'https://obsproject.com/forum/resources/move.913/'
  },
  'transition-table': {
    name: 'Transition Table',
    dll: 'transition-table.dll',
    url: 'https://obsproject.com/forum/resources/transition-table.1174/'
  },
  'source-switcher': {
    name: 'Source Switcher',
    dll: 'source-switcher.dll',
    url: 'https://obsproject.com/forum/resources/source-switcher.941/'
  },
  'xObsAsyncImageSource': {
    name: 'xObsAsyncImageSource',
    dll: 'xObsAsyncImageSource.dll',
    url: 'https://obsproject.com/forum/resources/xobsasyncimagesource-asynchronous-image-source.1681/'
  }
};

// Types OBS itself provides (version suffixes like _v2 are removed first). Any
// other type in a collection comes from a plugin the admin should review.
const BUILT_IN_KINDS = new Set([
  'scene', 'group', 'image_source', 'color_source', 'slideshow', 'browser_source', 'ffmpeg_source', 'vlc_source',
  'text_gdiplus', 'text_ft2_source', 'monitor_capture', 'window_capture', 'game_capture', 'dshow_input',
  'wasapi_input_capture', 'wasapi_output_capture', 'wasapi_process_output_capture', 'decklink-input', 'aja_source',
  'mask_filter', 'color_filter', 'color_key_filter', 'chroma_key_filter', 'luma_key_filter', 'crop_filter', 'gain_filter',
  'scroll_filter', 'sharpness_filter', 'scale_filter', 'gpu_delay', 'async_delay_filter', 'render_delay_filter',
  'noise_gate_filter', 'noise_suppress_filter', 'compressor_filter', 'limiter_filter', 'expander_filter',
  'upward_compressor_filter', 'invert_polarity_filter', 'hdr_tonemap_filter', 'basic_eq_filter', 'vst_filter',
  'fade_transition', 'cut_transition', 'swipe_transition', 'slide_transition', 'wipe_transition',
  'fade_to_color_transition', 'obs_stinger_transition'
]);

// Plugin DLLs that ship with OBS, or that are browser support files.
const BUILT_IN_DLLS = new Set([
  'aja-output-ui', 'aja', 'chrome_elf', 'coreaudio-encoder', 'd3dcompiler_47', 'decklink-captions', 'decklink-output-ui',
  'decklink', 'enc-amf', 'frontend-tools', 'image-source', 'libegl', 'libglesv2', 'libcef', 'nv-filters', 'obs-browser',
  'obs-ffmpeg', 'obs-filters', 'obs-nvenc', 'obs-outputs', 'obs-qsv11', 'obs-text', 'obs-transitions', 'obs-vst',
  'obs-webrtc', 'obs-websocket', 'obs-x264', 'rtmp-services', 'source-profiler', 'text-freetype2', 'vlc-video',
  'win-capture', 'win-dshow', 'win-wasapi', 'win-mf', 'vk_swiftshader', 'vulkan-1'
]);

// Kits can come from any league's admin, so only these file types are ever shipped
// or downloaded as "media": pictures, video, sound, fonts and plain web/text files.
// Everything else is refused, which covers programs, shortcuts, and scripts OBS
// could run (.lua / .py).
const ALLOWED_MEDIA_RE = new RegExp('\\.(' + [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tga', 'svg', 'avif',
  'mp4', 'mov', 'mkv', 'webm', 'avi', 'flv', 'm4v', 'ts',
  'mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac', 'opus',
  'ttf', 'otf',
  'html', 'htm', 'css', 'txt', 'json'
].join('|') + ')$', 'i');

function isAllowedMedia(file) {
  return typeof file === 'string' && ALLOWED_MEDIA_RE.test(file);
}

/**
 * Removes OBS scripts (Tools > Scripts) from a collection someone else made.
 * OBS loads them as soon as the collection is opened and they can run anything
 * on the PC, so a downloaded kit never brings scripts with it. Returns how many
 * were removed.
 */
function removeScripts(collection) {
  const modules = collection && collection.modules;
  const scripts = modules && modules['scripts-tool'];
  if (!Array.isArray(scripts) || !scripts.length) return 0;
  modules['scripts-tool'] = [];
  return scripts.length;
}

function countScripts(collection) {
  const scripts = collection && collection.modules && collection.modules['scripts-tool'];
  return Array.isArray(scripts) ? scripts.length : 0;
}

function isPrivateUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
  let u;
  try {
    u = new URL(value);
  } catch (e) {
    return false;
  }
  if (/(^|\.)streamelements\.com$/i.test(u.hostname) && u.pathname.startsWith('/overlay/')) return true;
  if (/(^|\.)streamlabs\.com$/i.test(u.hostname) && /^\/(alert-box|widgets|alert-?box)\b/i.test(u.pathname)) return true;
  if (/(^|\.)discord(app)?\.com$/i.test(u.hostname) && u.pathname.startsWith('/api/webhooks/')) return true;
  for (const k of u.searchParams.keys()) {
    if (SECRET_PARAMS.test(k)) return true;
  }
  return false;
}

function isLocalPath(value) {
  return typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value));
}

/** Last path segment ("D:\a\Reaction Videos\" -> "Reaction Videos"). */
function lastSegment(p) {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

/** Calls fn(value, key, parent, trail) for every string in the tree. */
function walkStrings(node, fn, trail = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => (typeof v === 'string' ? fn(v, i, node, trail) : walkStrings(v, fn, trail)));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') fn(v, k, node, trail);
      else walkStrings(v, fn, trail.concat(node));
    }
  }
}

function sheetRowOf(name) {
  const m = String(name || '').match(/\|sheet\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Blanks private URLs on "|sheet" sources and reports the rest. With blankUnlinked,
 * private URLs elsewhere are blanked too. A browser source only gets its URL back
 * if its sheet row is a Browser row with a value, so when sheetRows ({ row: { type,
 * value } }) is known, sources that would stay empty are listed in needsSheetRow.
 * The URL is removed either way: a secret never ships because of a sheet problem.
 */
function scrubPrivateUrls(collection, { blankUnlinked = false, sheetRows = null } = {}) {
  const blanked = [];
  const warnings = [];
  const needsSheetRow = [];
  (collection.sources || []).forEach((src) => {
    const sheetLinked = SHEET_NAME_RE.test(src.name || '');
    walkStrings(src, (value, key, parent) => {
      if (!isPrivateUrl(value)) return;
      const host = new URL(value).host;
      if (sheetLinked || blankUnlinked) {
        parent[key] = '';
        blanked.push({ source: src.name, host });
        if (sheetLinked && sheetRows && src.id === 'browser_source' && key === 'url') {
          const row = sheetRows[sheetRowOf(src.name)];
          const ok = row && String(row.type || '').trim().toLowerCase() === 'browser' && String(row.value || '').trim();
          if (!ok) needsSheetRow.push({ source: src.name, row: sheetRowOf(src.name) });
        }
      } else {
        warnings.push({ source: src.name, host });
      }
    });
  });
  // Private URLs outside sources (macros, transitions...) are only reported.
  const rest = { ...collection, sources: [] };
  walkStrings(rest, (value) => {
    if (isPrivateUrl(value)) warnings.push({ source: '(outside sources)', host: new URL(value).host });
  });
  return { blanked, warnings, needsSheetRow };
}

/**
 * Replaces local paths to files that exist in the media folder with
 * "{{MEDIA}}/<file>". Paths inside OBS's own plugin folders are left alone.
 * Everything else is reported as optional (not shipped).
 */
function tokenizeMediaPaths(collection, mediaNames) {
  const byLower = new Map(mediaNames.map(n => [n.toLowerCase(), n]));
  const replaced = new Map(); // file -> count
  const unmatched = new Map(); // normalized path -> count
  walkStrings(collection, (value, key, parent) => {
    if (!isLocalPath(value) || /[\\/]obs-studio[\\/]/i.test(value)) return;
    const hit = byLower.get(lastSegment(value).toLowerCase());
    if (hit && !/[\\/]$/.test(value)) {
      parent[key] = `${MEDIA_TOKEN}/${hit}`;
      replaced.set(hit, (replaced.get(hit) || 0) + 1);
    } else {
      const norm = value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      unmatched.set(norm, (unmatched.get(norm) || 0) + 1);
    }
  });
  // Files inside an unmatched folder are listed under that folder.
  const optional = new Map();
  for (const [p, count] of unmatched) {
    const parentFolder = [...unmatched.keys()].find(other => other !== p && p.startsWith(`${other}/`));
    const shown = lastSegment(parentFolder || p);
    optional.set(shown, (optional.get(shown) || 0) + count);
  }
  // Keep the original spelling for display.
  const display = (lower) => {
    let found = lower;
    walkStrings(collection, (v) => {
      if (isLocalPath(v) && lastSegment(v).toLowerCase() === lower) found = lastSegment(v);
    });
    return found;
  };
  return {
    replaced: [...replaced].map(([file, count]) => ({ file, count })),
    optional: [...optional].map(([name, count]) => ({ name: display(name), count }))
  };
}

/** Source, group, filter and transition types used by the collection. */
function collectKinds(collection) {
  const kinds = new Set();
  const add = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.id === 'string') kinds.add(node.id);
    (Array.isArray(node.filters) ? node.filters : []).forEach(add);
  };
  ['sources', 'groups', 'transitions'].forEach((k) => {
    (Array.isArray(collection[k]) ? collection[k] : []).forEach(add);
  });
  return kinds;
}

/** Which known plugins and which fonts the collection needs. */
function detectRequirements(collection) {
  const kinds = collectKinds(collection);
  const fonts = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node && typeof node === 'object') {
      if (node.font && typeof node.font.face === 'string' && node.font.face.trim()) fonts.add(node.font.face.trim());
      Object.values(node).forEach(visit);
    }
  };
  visit(collection);
  const modules = collection.modules || {};
  const plugins = [];
  const ass = modules['advanced-scene-switcher'];
  if (ass && Array.isArray(ass.macros) && ass.macros.length) plugins.push('advanced-scene-switcher');
  if ([...kinds].some(k => /^move_/.test(k))) plugins.push('move-transition');
  if (modules['transition-table'] && Object.keys(modules['transition-table']).length) plugins.push('transition-table');
  if (kinds.has('source_switcher')) plugins.push('source-switcher');
  if (kinds.has('xObsAsyncImageSource')) plugins.push('xObsAsyncImageSource');
  const unknownKinds = [...kinds].filter((k) => {
    const base = k.replace(/_v\d+$/, '');
    return !BUILT_IN_KINDS.has(base) && !/^move_/.test(base) && base !== 'source_switcher' && base !== 'xObsAsyncImageSource';
  }).sort();
  return { plugins, fonts: [...fonts].sort(), unknownKinds };
}

function parseCollection(text) {
  let collection;
  try {
    collection = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (e) {
    throw new Error('That file is not valid JSON.');
  }
  if (!collection || !Array.isArray(collection.sources)) {
    throw new Error('That file is not an OBS scene collection export (Scene Collection › Export).');
  }
  return collection;
}

/** What the kit builder shows the admin to review before building. */
function scan(collectionText) {
  const collection = parseCollection(collectionText);
  const req = detectRequirements(collection);
  return { name: packageName(collection), plugins: req.plugins, fonts: req.fonts, unknownKinds: req.unknownKinds };
}

/** "CCS Fall 26 v0.4" -> "CCS Fall 26": the package has its own version. */
function packageName(collection) {
  return String(collection.name || 'Scene Collection').replace(/\s+v?\d+(\.\d+)*\s*$/i, '').slice(0, 100) || 'Scene Collection';
}

/** Rows of a sheet ([[A, B, C, D, E], ...]) as { rowNumber: { type, value } }. */
function sheetRowsFromValues(values) {
  const rows = {};
  (Array.isArray(values) ? values : []).forEach((r, i) => {
    rows[i + 1] = { type: (r && r[2]) || '', value: (r && r[3]) || '' };
  });
  return rows;
}

/** Common copy-paste mistake: a GitHub page link instead of the raw file link. */
function normalizeManifestUrl(value) {
  const url = String(value || '').trim();
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+?)(?:\?.*)?$/i);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url;
}

/** Hosts of private-looking URLs anywhere in a collection (checks a hosted kit). */
function findPrivateUrls(collection) {
  const hosts = [];
  walkStrings(collection, (value) => {
    if (isPrivateUrl(value)) hosts.push(new URL(value).host);
  });
  return hosts;
}

/** "0.4" -> "0.5", "1.2.3" -> "1.2.4". */
function nextVersion(v) {
  const parts = String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10));
  if (!parts.length || parts.some(isNaN)) return '1.0.0';
  parts[parts.length - 1] += 1;
  return parts.join('.');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9 _.-]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'scene-collection';
}

/**
 * Builds the package in memory. installedPlugins: { id: version } from this PC
 * (used as the "tested on" minimum version).
 */
function prepare(collectionText, opts) {
  const {
    version,
    notes = '',
    mediaFiles = [], // [{ file, buffer }]
    installedPlugins = {},
    leagueEsportsTimers = false,
    links = [],
    blankUnlinked = false,
    sheetRows = null,
    plugins = null, // the admin's reviewed list; null = what was detected
    fonts = null
  } = opts;
  const collection = parseCollection(collectionText);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(String(version || ''))) {
    throw new Error('Enter a version like 1.0.0.');
  }

  const shippable = mediaFiles.filter(m => isAllowedMedia(m.file));
  const scrub = scrubPrivateUrls(collection, { blankUnlinked, sheetRows });
  const paths = tokenizeMediaPaths(collection, shippable.map(m => m.file));
  const req = detectRequirements(collection);
  const usedMedia = shippable.filter(m => paths.replaced.some(r => r.file === m.file));

  // The collection's name inside OBS is left alone (the scene collection lock uses it).
  const name = packageName(collection);
  const collectionFile = `${safeName(name)} v${safeName(version)}.json`;
  const collectionBuffer = Buffer.from(JSON.stringify(collection, null, 4), 'utf8');

  const manifest = {
    name,
    version: String(version),
    url: encodeURIComponent(collectionFile),
    sha256: sha256(collectionBuffer),
    notes: String(notes).slice(0, 2000),
    media: usedMedia.map(m => ({
      file: m.file,
      url: `media/${encodeURIComponent(m.file)}`,
      sha256: sha256(m.buffer),
      size: m.buffer.length
    })),
    optionalMedia: paths.optional.map(o => o.name),
    requirements: {
      plugins: plugins || req.plugins.map(id => ({
        id,
        name: KNOWN_PLUGINS[id].name,
        dll: KNOWN_PLUGINS[id].dll,
        minVersion: installedPlugins[id] || '',
        url: KNOWN_PLUGINS[id].url
      })),
      fonts: fonts || req.fonts,
      leagueEsportsTimers: !!leagueEsportsTimers
    },
    // Checklist items for producers. A link is optional; a bad link is dropped.
    links: links
      .filter(l => l && l.label)
      .map(l => ({ label: String(l.label).slice(0, 120), url: /^https:\/\//i.test(l.url || '') ? l.url : '' }))
      .slice(0, 20)
  };

  return {
    manifest,
    collectionFile,
    collectionBuffer,
    usedMedia,
    report: {
      blanked: scrub.blanked,
      warnings: scrub.warnings,
      needsSheetRow: scrub.needsSheetRow,
      sheetChecked: !!sheetRows,
      blockedMedia: mediaFiles.filter(m => !isAllowedMedia(m.file)).map(m => m.file),
      // OBS scripts are removed on the producer's PC (see removeScripts).
      scripts: countScripts(collection),
      replaced: paths.replaced,
      optional: paths.optional,
      unusedMedia: shippable.filter(m => !usedMedia.includes(m)).map(m => m.file)
    }
  };
}

/** Writes the package to outDir (emptied first; it belongs to the app). */
function writePackage(outDir, pkg) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(outDir, pkg.collectionFile), pkg.collectionBuffer);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(pkg.manifest, null, 2));
  pkg.usedMedia.forEach(m => fs.writeFileSync(path.join(outDir, 'media', m.file), m.buffer));
  return outDir;
}

/** Reads the files directly inside a media folder. */
function readMediaFolder(dir) {
  if (!dir || !fs.existsSync(dir)) throw new Error(`Media folder not found: ${dir}`);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => ({ file: d.name, buffer: fs.readFileSync(path.join(dir, d.name)) }));
}

/** Producer side: swaps "{{MEDIA}}" for this PC's media folder (OBS uses forward slashes). */
function applyMediaFolder(collection, mediaDir) {
  const dir = mediaDir.replace(/\\/g, '/').replace(/\/+$/, '');
  let count = 0;
  walkStrings(collection, (value, key, parent) => {
    if (value.includes(MEDIA_TOKEN)) {
      parent[key] = value.split(MEDIA_TOKEN).join(dir);
      count++;
    }
  });
  return count;
}

module.exports = {
  MEDIA_TOKEN,
  KNOWN_PLUGINS,
  BUILT_IN_DLLS,
  isAllowedMedia,
  removeScripts,
  countScripts,
  scan,
  parseCollection,
  sheetRowsFromValues,
  normalizeManifestUrl,
  findPrivateUrls,
  isPrivateUrl,
  scrubPrivateUrls,
  tokenizeMediaPaths,
  detectRequirements,
  nextVersion,
  prepare,
  writePackage,
  readMediaFolder,
  applyMediaFolder,
  safeName
};
