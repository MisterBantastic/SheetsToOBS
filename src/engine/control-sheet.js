/**
 * ControlSheet: reads / writes the human-facing "Stream" control tabs
 * (Stream1, Stream2, ...) for the Web Dashboard.
 *
 * Two modes:
 *  - "bridge"   : Google Apps Script Web App (apps-script/WebApp.gs). Read + write.
 *  - "readonly" : Google Sheets API v4 with the profile's API key. Read only.
 *
 * Every write is validated against src/public/control-layout.json: only cells
 * declared there as editable (not "readonly") on an allowed tab can be written.
 */
const fs = require('fs');
const path = require('path');
const ConfigManager = require('./config-manager');

const LAYOUT_PATH = path.join(__dirname, '..', 'public', 'control-layout.json');
const RUNNABLE_FUNCTIONS = ['fetchActiveLeagues', 'fetchAllStats', 'refreshShowData', 'fetchSchedule', 'fetchLiveStatsForStreams', 'fetchPlayerInfo', 'fetchLiveStats', 'importChampionDataAndSkins', 'auditSheet'];
// Per-stream live stats: run from the dashboard's "Live stats" button for the open tab.
const STREAM_FUNCTIONS = ['fetchLiveStatsStream1', 'fetchLiveStatsStream2', 'fetchLiveStatsStream3'];
const SNAPSHOT_CACHE_MS = 2500;
// Oldest Apps Script bridge that reads dropdown lists live. 1.0.0 cached them for
// 10 minutes inside Apps Script (league -> team lists did not follow).
const REQUIRED_BRIDGE_VERSION = '1.1.0';

function versionAtLeast(v, min) {
  const a = String(v || '0').split('.').map(n => parseInt(n, 10) || 0);
  const b = String(min).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}
// Dropdown lists are re-read whenever an editable cell changed since they were
// last read (league -> teams, team -> subs, champion -> skins, ...), and at
// least this often to catch changes made on other tabs (API imports, Crew).
const OPTIONS_MAX_AGE_MS = 30 * 1000;

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseA1(a1) {
  const m = /^([A-Z]{1,3})([0-9]{1,5})$/.exec(String(a1 || '').toUpperCase());
  if (!m) return null;
  return { col: colToIndex(m[1]), row: parseInt(m[2], 10) };
}

function parseRange(range) {
  const [a, b] = String(range).split(':');
  const start = parseA1(a);
  const end = parseA1(b || a);
  if (!start || !end) return null;
  return { top: start.row, left: start.col, bottom: end.row, right: end.col };
}

/** Walks the layout and returns { cells: Map(a1 -> field), headerCells: Set } */
function indexLayout(layout) {
  const cells = new Map();
  const headerCells = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (typeof node.cell === 'string') {
      if (node.type) cells.set(node.cell.toUpperCase(), node);
      else headerCells.add(node.cell.toUpperCase());
    }
    Object.values(node).forEach(walk);
  };
  walk(layout.sections || []);
  return { cells, headerCells };
}

function indexToCol(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Moves an A1 cell down by every row block inserted at or above it. */
function shiftA1(a1, inserts) {
  const p = parseA1(a1);
  if (!p) return a1;
  const add = inserts.reduce((n, ins) => n + (p.row >= ins.at ? ins.count : 0), 0);
  return indexToCol(p.col) + (p.row + add);
}

/**
 * Builds the layout of one tab. The base layout describes the shared Stream tab
 * shape; layout.tabLayouts[tab] can adjust it for a tab that differs:
 *   insertRows  [{ at, count }]  rows inserted on that tab (cells at/below move down)
 *   readRange   range to read on that tab
 *   addSections [{ after, section }]  extra sections (cells already in that tab's rows)
 */
function resolveLayout(base, tab) {
  const own = (base.tabLayouts || {})[tab];
  const out = Object.assign({}, base);
  delete out.tabLayouts;
  if (!own) return out;
  const inserts = own.insertRows || [];
  const shift = (node) => {
    if (Array.isArray(node)) return node.map(shift);
    if (!node || typeof node !== 'object') return node;
    const copy = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'cell' && typeof v === 'string') copy[k] = shiftA1(v.toUpperCase(), inserts);
      else if (k === 'range' && typeof v === 'string') copy[k] = v.split(':').map(a => shiftA1(a, inserts)).join(':');
      else copy[k] = shift(v);
    }
    return copy;
  };
  const sections = shift(base.sections || []);
  (own.addSections || []).forEach(({ after, section }) => {
    const i = sections.findIndex(s => s.id === after);
    sections.splice(i === -1 ? sections.length : i + 1, 0, section);
  });
  out.sections = sections;
  if (own.readRange) out.readRange = own.readRange;
  out.tab = tab;
  return out;
}

function coerceForWrite(field, value) {
  if (field.type === 'bool') {
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  const str = String(value);
  if (str.length > 2000) throw new Error(`Value for ${field.cell} is too long.`);
  return str;
}

/** Converts a Sheets display value into what the dashboard expects for a field. */
function normalizeValue(field, value) {
  if (field && field.type === 'bool') {
    if (typeof value === 'boolean') return value;
    return String(value).trim().toUpperCase() === 'TRUE';
  }
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

class ControlSheet {
  constructor(configManager, options = {}) {
    this.configManager = configManager;
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.layoutPath = options.layoutPath || LAYOUT_PATH;
    this.layout = null;
    this.index = null;
    this.snapshotCache = new Map(); // tab -> { at, data }
    this.inflight = new Map(); // tab -> Promise
    this.optionsCache = new Map(); // tab -> { at, sig, options }
    this.inputSig = new Map(); // tab -> signature of editable cells in the last snapshot
    this.loadLayout();
  }

  loadLayout() {
    this.baseLayout = JSON.parse(fs.readFileSync(this.layoutPath, 'utf8'));
    this.layout = resolveLayout(this.baseLayout, null);
    this.index = indexLayout(this.layout);
    this.tabLayouts = new Map(); // tab -> { layout, index }
    return this.layout;
  }

  /** The layout + cell index for one tab (a tab can have extra rows / sections). */
  forTab(tab) {
    if (!tab) return { layout: this.layout, index: this.index };
    if (!this.tabLayouts.has(tab)) {
      const layout = resolveLayout(this.baseLayout, tab);
      this.tabLayouts.set(tab, { layout, index: indexLayout(layout) });
    }
    return this.tabLayouts.get(tab);
  }

  /** Resolved layout of every configured tab (for the dashboard). */
  layoutsByTab() {
    const out = {};
    this.settings().tabs.forEach(t => { out[t] = this.forTab(t).layout; });
    return out;
  }

  settings() {
    const cfg = this.configManager.load();
    const scriptUrl = (cfg.scriptUrl || '').trim();
    const scriptToken = (cfg.scriptToken || '').trim();
    const hasBridge = /^https:\/\/script\.google(usercontent)?\.com\//.test(scriptUrl) && !!scriptToken;
    const tabs = Array.from(new Set([...(this.layout.tabs || []), cfg.controlTabName].filter(Boolean)));
    return {
      profile: cfg.activeProfile || '',
      mode: hasBridge ? 'bridge' : ((cfg.sheetId && cfg.apikey) ? 'readonly' : 'offline'),
      tab: cfg.controlTabName || (this.layout.tabs || ['Stream1'])[0],
      tabs,
      hasBridge,
      scriptUrlSet: !!scriptUrl,
      scriptUrlPreview: scriptUrl ? scriptUrl.replace(/\/macros\/s\/([^/]{6})[^/]*/, '/macros/s/$1…') : '',
      tokenSet: !!scriptToken,
      allowLanDashboard: !!cfg.allowLanDashboard,
      pollMs: Math.max(2000, parseInt(cfg.controlPollMs, 10) || 4000)
    };
  }

  assertTab(tab) {
    const s = this.settings();
    if (!s.tabs.includes(tab)) throw new Error(`Tab "${tab}" is not a configured control tab.`);
    return s;
  }

  async callBridge(body, timeoutMs = 30000) {
    const cfg = this.configManager.load();
    if (!this.fetchImpl) throw new Error('No HTTP client available.');
    const res = await this.fetchImpl(cfg.scriptUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, token: cfg.scriptToken.trim() }),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      if (/<html/i.test(text)) {
        throw new Error('Apps Script returned an HTML page. Check the deployment is a Web app with access "Anyone" and that the URL ends in /exec.');
      }
      throw new Error(`Apps Script returned invalid JSON (HTTP ${res.status}).`);
    }
    if (!data.ok) throw new Error(data.error || 'Apps Script request failed.');
    // Remember which bridge version is deployed (1.0.0 did not report it on snapshots).
    if (body.action === 'snapshot' || body.action === 'ping') this.bridgeVersion = data.version || '1.0.0';
    return data;
  }

  /** Maps a 2D values block to { A1: value } for every layout cell inside it. */
  extractCells(values, rangeA1, index = this.index) {
    const rng = parseRange(rangeA1);
    const out = {};
    const take = (a1, field) => {
      const p = parseA1(a1);
      if (!p) return;
      const r = p.row - rng.top;
      const c = p.col - rng.left;
      const row = values[r] || [];
      out[a1] = normalizeValue(field, row[c]);
    };
    for (const [a1, field] of index.cells) take(a1, field);
    for (const a1 of index.headerCells) take(a1, null);
    return out;
  }

  async snapshot(tab, { withOptions = false, fresh = false } = {}) {
    const s = this.assertTab(tab);
    const cached = this.snapshotCache.get(tab);
    const sameProfile = cached && cached.data.profile === s.profile;
    if (!fresh && !withOptions && sameProfile && Date.now() - cached.at < SNAPSHOT_CACHE_MS) return cached.data;
    if (!withOptions && this.inflight.has(tab)) return this.inflight.get(tab);

    const work = (async () => {
      const { layout, index } = this.forTab(tab);
      const range = layout.readRange || 'A1:AA155';
      let values;
      let options = null;

      if (s.mode === 'bridge') {
        const cachedOpts = this.optionsCache.get(tab);
        const lastSig = this.inputSig.get(tab);
        const needOptions = withOptions || !cachedOpts ||
          Date.now() - cachedOpts.at > OPTIONS_MAX_AGE_MS ||
          (lastSig !== undefined && cachedOpts.sig !== lastSig);
        const optionFields = Array.from(index.cells.entries())
          .filter(([, f]) => f.type === 'select' || f.type === 'champion');
        const optionCells = needOptions ? optionFields.map(([a1]) => a1) : [];
        const optionRanges = {};
        if (needOptions) {
          optionFields.forEach(([a1, f]) => {
            if (f.optionsFrom) optionRanges[a1] = f.optionsFrom.replace(/\{tab\}/g, tab);
          });
        }
        const data = await this.callBridge({ action: 'snapshot', tab, range, optionCells, optionRanges });
        values = data.values || [];
        if (needOptions) {
          const sig = this.inputSignature(this.extractCells(values, range, index), index);
          this.optionsCache.set(tab, { at: Date.now(), sig, options: data.options || {} });
        }
        // The cache can be cleared while this request was in flight (an edit was
        // saved meanwhile), so fall back to what we had when we started.
        const latest = this.optionsCache.get(tab) || cachedOpts;
        options = (latest && latest.options) || {};
      } else if (s.mode === 'readonly') {
        const cfg = this.configManager.load();
        const id = ConfigManager.extractSheetId(cfg.sheetId);
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`${tab}!${range}`)}` +
          `?key=${encodeURIComponent(cfg.apikey)}&valueRenderOption=FORMATTED_VALUE`;
        const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20000) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ? `Sheets API ${body.error.code}: ${body.error.message}` : `Sheets API HTTP ${res.status}`);
        values = body.values || [];
      } else {
        throw new Error('No Google Sheet connection. Add a Sheet ID + API key (read-only) or an Apps Script bridge (read/write).');
      }

      const cells = this.extractCells(values, range, index);
      this.inputSig.set(tab, this.inputSignature(cells, index));
      const data = {
        tab,
        profile: s.profile,
        mode: s.mode,
        bridgeVersion: s.mode === 'bridge' ? this.bridgeVersion : null,
        bridgeOutdated: s.mode === 'bridge' && !versionAtLeast(this.bridgeVersion, REQUIRED_BRIDGE_VERSION),
        readAt: new Date().toISOString(),
        cells,
        options: options || {},
        optionsAt: this.optionsCache.has(tab) ? this.optionsCache.get(tab).at : null
      };
      this.snapshotCache.set(tab, { at: Date.now(), data });
      return data;
    })();

    this.inflight.set(tab, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(tab);
    }
  }

  /** Fingerprint of every editable cell: when it changes, dependent dropdowns may have too. */
  inputSignature(cells, index = this.index) {
    const parts = [];
    for (const [a1, f] of index.cells) {
      if (f.type !== 'readonly') parts.push(`${a1}=${cells[a1]}`);
    }
    return parts.join('\u0001');
  }

  /** Validates operator edits against the layout. Throws on the first bad update. */
  validateUpdates(updates, tab) {
    const index = this.forTab(tab).index;
    if (!Array.isArray(updates) || updates.length === 0) throw new Error('No updates supplied.');
    if (updates.length > 60) throw new Error('Too many updates in one request.');
    return updates.map((u) => {
      const a1 = String((u && u.cell) || '').toUpperCase();
      const field = index.cells.get(a1);
      if (!field) throw new Error(`Cell ${a1 || '(empty)'} is not part of the control layout.`);
      if (field.type === 'readonly') throw new Error(`Cell ${a1} is formula-driven and cannot be edited.`);
      const clean = { cell: a1, value: coerceForWrite(field, u.value) };
      if (u.expect !== undefined && u.expect !== null) clean.expect = String(u.expect);
      return clean;
    });
  }

  async write(tab, updates) {
    const s = this.assertTab(tab);
    if (s.mode !== 'bridge') throw new Error('Read-only mode: connect the Apps Script bridge to edit the sheet from the dashboard.');
    const clean = this.validateUpdates(updates, tab);
    const result = await this.callBridge({ action: 'set', tab, updates: clean });
    this.snapshotCache.delete(tab);
    this.optionsCache.delete(tab); // dependent dropdowns (teams, subs, skins) must be re-read
    return result;
  }

  async run(fn) {
    const s = this.settings();
    if (s.mode !== 'bridge') throw new Error('Running Apps Script functions needs the Apps Script bridge.');
    if (!RUNNABLE_FUNCTIONS.includes(fn) && !STREAM_FUNCTIONS.includes(fn)) throw new Error(`Function "${fn}" is not allowed.`);
    return this.callBridge({ action: 'run', fn }, 330000);
  }

  async ping() {
    const s = this.settings();
    if (s.mode !== 'bridge') return { ok: false, mode: s.mode, error: 'Apps Script bridge not configured.' };
    return this.callBridge({ action: 'ping' }, 20000);
  }

  clearCaches() {
    this.snapshotCache.clear();
    this.optionsCache.clear();
    this.inputSig.clear();
    this.bridgeVersion = null;
  }
}

ControlSheet.RUNNABLE_FUNCTIONS = RUNNABLE_FUNCTIONS;
ControlSheet.REQUIRED_BRIDGE_VERSION = REQUIRED_BRIDGE_VERSION;
ControlSheet.versionAtLeast = versionAtLeast;
ControlSheet.parseA1 = parseA1;
ControlSheet.parseRange = parseRange;
ControlSheet.resolveLayout = resolveLayout;
ControlSheet.indexLayout = indexLayout;
module.exports = ControlSheet;
