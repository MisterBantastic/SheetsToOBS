const EventEmitter = require('events');
const ConfigManager = require('./config-manager');

let axios = null;
try {
  axios = require('axios');
} catch (e) {
  try {
    axios = require('../../obs-google-sheet-importer-master/node_modules/axios');
  } catch (err) {
    axios = null;
  }
}

let OBSWebSocket = null;
try {
  const mod = require('obs-websocket-js');
  OBSWebSocket = mod.default || mod;
} catch (e) {
  try {
    const mod = require('../../obs-google-sheet-importer-master/node_modules/obs-websocket-js');
    OBSWebSocket = mod.default || mod;
  } catch (err) {
    OBSWebSocket = null;
  }
}

class ImporterEngine extends EventEmitter {
  constructor(configManager) {
    super();
    this.configManager = configManager;
    this.obs = null;
    this.timer = null;
    this.isRunning = false;
    this.isUpdating = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.simulationMode = false;
    this.simulationTimer = null;

    // Track previous visibility state to suppress unchanged spam
    this.visibilityStateMap = new Map();
    // Track previous missing row warnings to suppress unchanged spam
    this.missingRowsWarned = new Set();

    this.obsStatus = {
      connected: false,
      state: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'error'
      address: '',
      version: 'Unknown',
      latency: 0,
      lastConnected: null,
      error: null,
      activeScenesCount: 0,
      monitoredSourcesCount: 0
    };

    this.sheetStatus = {
      state: 'idle', // 'idle' | 'fetching' | 'success' | 'error'
      lastSync: null,
      rowsCount: 0,
      error: null,
      requestCount: 0,
      errorCount: 0,
      tabName: '',
      sheetId: ''
    };

    this.sources = [];
    this.rawSheetData = [];
    this.lastJsonString = '';
    this.lastSyncDiffs = [];
    this.lastSyncTimestamp = null;
  }

  log(level, message, details = null) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = { timestamp, level, message, details };
    this.emit('log', entry);
  }

  recordDiff(sourceName, type, oldValue, newValue) {
    this.lastSyncTimestamp = Date.now();
    const diffItem = {
      sourceName,
      type,
      oldValue: oldValue !== null && oldValue !== undefined ? String(oldValue) : '',
      newValue: newValue !== null && newValue !== undefined ? String(newValue) : '',
      timestamp: new Date().toLocaleTimeString(),
      time: Date.now()
    };
    this.lastSyncDiffs.unshift(diffItem);
    if (this.lastSyncDiffs.length > 30) {
      this.lastSyncDiffs.pop();
    }
  }

  emitStatus() {
    this.emit('status', {
      obs: { ...this.obsStatus },
      sheet: { ...this.sheetStatus },
      running: this.isRunning,
      simulation: this.simulationMode,
      sourcesCount: this.sources.length,
      rowsCount: this.rawSheetData.length,
      lastSyncDiffs: this.lastSyncDiffs.slice(0, 15),
      lastSyncTimestamp: this.lastSyncTimestamp
    });
  }

  /**
   * Helper to convert Hex (#RRGGBB) to OBS color integer (0xFFBBGGRR)
   */
  static hexToObsColor(hexStr) {
    if (!hexStr) return null;
    let clean = hexStr.replace('#', '').trim();
    if (clean.length === 3) {
      clean = clean.split('').map(c => c + c).join('');
    }
    if (clean.length !== 6) return null;
    const r = clean.substring(0, 2);
    const g = clean.substring(2, 4);
    const b = clean.substring(4, 6);
    return parseInt('ff' + b + g + r, 16);
  }

  /**
   * Parse tags from cell value (e.g. ?color=#FF0000;Text or ?fontstyle=underline;Text or ?hide;Text)
   */
  static parseCellTags(val) {
    let cellvalue = val !== undefined && val !== null ? String(val) : '';
    let color = null;
    let fontstyle = null;
    let visibility = null; // true | false | null

    if (cellvalue.startsWith('?color=')) {
      const split = cellvalue.split(';');
      cellvalue = split.slice(1).join(';');
      const colorVal = split[0].split('=')[1];
      color = ImporterEngine.hexToObsColor(colorVal);
    } else if (cellvalue.startsWith('?fontstyle=')) {
      const split = cellvalue.split(';');
      cellvalue = split.slice(1).join(';');
      const style = split[0].split('=')[1];
      if (style === 'strikethrough') fontstyle = 8;
      if (style === 'underline') fontstyle = 4;
    }

    if (cellvalue.startsWith('?hide')) {
      const split = cellvalue.split(';');
      cellvalue = split.slice(1).join(';');
      visibility = false;
    } else if (cellvalue.startsWith('?show')) {
      const split = cellvalue.split(';');
      cellvalue = split.slice(1).join(';');
      visibility = true;
    }

    return {
      cleanValue: cellvalue,
      color,
      fontstyle,
      visibility
    };
  }

  /**
   * Extracts color / style variant ("White" / "Black" / "Red" / "Blue" / "Extra") from an OBS source name or base label.
   * Handles formats like:
   *  - "Talent Name 1 - White", "Talent Name 1 (Black)", "Team 1 Name - Red", "Team 2 Name (Blue)", "Scoreboard - Extra", "Talent 1_alt", "Player [Red]"
   */
  static extractColorVariant(name) {
    if (!name || typeof name !== 'string') return { baseName: name || '', variant: null };

    // Suffix pattern: e.g. " - White", " (Black)", "_white", " [White]", " - W", " - B", " - Red", " (Blue)", " - Extra", " [Alt]"
    const suffixRegex = /(?:[\s\-_/(\[]+)(white|black|red|blue|extra|alt|ext|w|b|r)[\s\-_/)\]]*$/i;
    const suffixMatch = name.match(suffixRegex);
    if (suffixMatch) {
      const raw = suffixMatch[1].toLowerCase();
      let variant = 'Extra';
      if (raw === 'white' || raw === 'w') variant = 'White';
      else if (raw === 'black' || raw === 'b') variant = 'Black';
      else if (raw === 'red' || raw === 'r') variant = 'Red';
      else if (raw === 'blue') variant = 'Blue';
      else if (raw === 'extra' || raw === 'alt' || raw === 'ext') variant = 'Extra';

      const baseName = name.slice(0, suffixMatch.index).trim();
      return { baseName, variant };
    }

    // Infix pattern: e.g. "Talent Name (White) Secondary", "Team (Red) Overlay", "Talent (Extra) Camera"
    const tagRegex = /[\s\-_/(\[]+(white|black|red|blue|extra|alt|ext)[\s\-_/)\]]+/i;
    const tagMatch = name.match(tagRegex);
    if (tagMatch) {
      const raw = tagMatch[1].toLowerCase();
      let variant = 'Extra';
      if (raw === 'white') variant = 'White';
      else if (raw === 'black') variant = 'Black';
      else if (raw === 'red') variant = 'Red';
      else if (raw === 'blue') variant = 'Blue';
      else if (raw === 'extra' || raw === 'alt' || raw === 'ext') variant = 'Extra';

      const baseName = (name.slice(0, tagMatch.index) + ' ' + name.slice(tagMatch.index + tagMatch[0].length)).trim();
      return { baseName, variant };
    }

    return { baseName: name.trim(), variant: null };
  }

  /**
   * Checks whether a source or its label contains "WIP" (Work In Progress)
   */
  static isWipSource(sourceName, label = '') {
    if (!sourceName && !label) return false;
    const combined = `${sourceName || ''} ${label || ''}`;
    return /(^|[^a-zA-Z0-9])wip([^a-zA-Z0-9]|$)/i.test(combined);
  }

  /**
   * Compares an actual OBS source name against what it should be named based on Google Sheets.
   */
  static compareSourceName(obsSourceName, targetRow, expectedLabel, expectedFullName = '') {
    if (!obsSourceName) return { status: 'no_label', label: 'No Source', isMatch: true, variant: null };

    const expLabel = (expectedLabel || (expectedFullName ? expectedFullName.split('|sheet')[0].trim() : '')).trim();
    const expFull = expectedFullName || (expLabel ? `${expLabel} |sheet ${targetRow}` : '');

    if (!expLabel && !expFull) {
      return {
        status: 'no_label',
        label: 'No Sheet Label',
        isMatch: true,
        variant: null,
        expected: '',
        expectedBase: ''
      };
    }

    const parts = obsSourceName.split('|sheet');
    const actualBase = parts[0].trim();
    const actualRowMatch = parts[1] ? parts[1].match(/[0-9]+/) : null;
    const actualRow = actualRowMatch ? parseInt(actualRowMatch[0], 10) : targetRow;

    if (actualRow !== targetRow) {
      return {
        status: 'mismatch',
        label: `Row Mismatch (Obs: ${actualRow} vs Sheet: ${targetRow})`,
        isMatch: false,
        variant: null,
        expected: expFull,
        expectedBase: expLabel,
        actual: obsSourceName
      };
    }

    const { baseName: normalizedActual, variant: variantColor } = ImporterEngine.extractColorVariant(actualBase);

    // Normalize for comparison (collapse multiple spaces, hyphens, underscores)
    const cleanActual = actualBase.toLowerCase().replace(/[\s\-_]+/g, ' ').trim();
    const cleanNorm = normalizedActual.toLowerCase().replace(/[\s\-_]+/g, ' ').trim();
    const cleanExp = expLabel.toLowerCase().replace(/[\s\-_]+/g, ' ').trim();

    if (cleanActual === cleanExp) {
      return {
        status: 'exact',
        label: 'Exact Match',
        isMatch: true,
        variant: null,
        expected: expFull,
        expectedBase: expLabel,
        actual: obsSourceName
      };
    }

    if (cleanNorm === cleanExp && variantColor) {
      return {
        status: 'variant',
        label: `${variantColor} Variant`,
        isMatch: true,
        variant: variantColor,
        expected: expFull,
        expectedBase: expLabel,
        actual: obsSourceName
      };
    }

    return {
      status: 'mismatch',
      label: 'Name Mismatch',
      isMatch: false,
      variant: variantColor,
      expected: expFull,
      expectedBase: expLabel,
      actual: obsSourceName
    };
  }

  /**
   * Start synchronization loop
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.emitStatus();

    const config = this.configManager.load();
    this.log('info', `Starting Sync Engine for profile "${config.activeProfile || 'CCS1'}" (Polling: ${config.polling || 2000}ms)...`);

    if (this.simulationMode) {
      this.startSimulation();
      return;
    }

    await this.connectOBS();
    this.startPollingTimer();
  }

  /**
   * Stop synchronization loop
   */
  async stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
      this.simulationTimer = null;
    }
    this.missingRowsWarned.clear();
    if (this.obs && this.obsStatus.connected) {
      try {
        await this.obs.disconnect();
      } catch (e) {}
    }
    this.obsStatus.connected = false;
    this.obsStatus.state = 'disconnected';
    this.log('info', 'Sync Engine stopped.');
    this.emitStatus();
  }

  /**
   * Toggle Simulation Mode
   */
  toggleSimulation(enabled) {
    this.simulationMode = typeof enabled === 'boolean' ? enabled : !this.simulationMode;
    this.log('info', `Simulation Mode ${this.simulationMode ? 'ENABLED' : 'DISABLED'}`);
    if (this.isRunning) {
      this.stop().then(() => this.start());
    } else {
      this.emitStatus();
    }
  }

  startPollingTimer() {
    if (this.timer) clearInterval(this.timer);
    const config = this.configManager.load();
    let interval = parseInt(config.polling, 10);
    if (!interval || isNaN(interval)) interval = 2000;
    if (interval > 0 && interval <= 60) interval = interval * 1000;
    interval = Math.max(500, interval);
    this.timer = setInterval(() => {
      if (this.isRunning && !this.isUpdating) {
        this.updateCycle().catch(err => {
          this.log('error', `Update cycle error: ${err.message}`);
        });
      }
    }, interval);
  }

  /**
   * Connect to OBS WebSocket v5
   */
  async connectOBS() {
    const config = this.configManager.load();
    let address = config.obsaddress || 'ws://localhost:4455';
    const password = config.obsauth || '';

    this.obsStatus.state = 'connecting';
    this.obsStatus.address = address;
    this.emitStatus();
    this.log('obs', `Connecting to OBS WebSocket at ${address}...`);

    if (!OBSWebSocket) {
      this.obsStatus.state = 'error';
      this.obsStatus.error = 'obs-websocket-js library not loaded. Please run npm install or run installer.';
      this.log('error', this.obsStatus.error);
      this.emitStatus();
      return;
    }

    try {
      this.obs = new OBSWebSocket();
      const startTime = Date.now();
      
      let connectErr = null;
      try {
        await this.obs.connect(address, password);
      } catch (firstErr) {
        connectErr = firstErr;
        // Attempt IPv4 / IPv6 fallback between localhost and 127.0.0.1
        let fallbackAddress = null;
        if (address.includes('localhost')) {
          fallbackAddress = address.replace('localhost', '127.0.0.1');
        } else if (address.includes('127.0.0.1')) {
          fallbackAddress = address.replace('127.0.0.1', 'localhost');
        }
        if (fallbackAddress) {
          try {
            this.obs = new OBSWebSocket();
            await this.obs.connect(fallbackAddress, password);
            address = fallbackAddress;
            this.obsStatus.address = fallbackAddress;
            connectErr = null;
          } catch (secondErr) {
            // Keep first error
          }
        }
      }

      if (connectErr) {
        throw connectErr;
      }

      const latency = Date.now() - startTime;

      this.obsStatus.connected = true;
      this.obsStatus.state = 'connected';
      this.obsStatus.latency = latency;
      this.obsStatus.lastConnected = new Date().toLocaleTimeString();
      this.obsStatus.error = null;
      this.reconnectAttempts = 0;

      // Query version info
      try {
        const versionInfo = await this.obs.call('GetVersion');
        this.obsStatus.version = versionInfo.obsVersion || versionInfo.obsWebSocketVersion || '5.x';
      } catch (verErr) {
        this.obsStatus.version = '5.x';
      }

      // Query installed input kinds (check for plugins like obs-source-switcher)
      try {
        const inputKindsData = await this.obs.call('GetInputKindList');
        const kinds = inputKindsData.inputKinds || [];
        this.installedInputKinds = new Set(kinds);
        this.hasSourceSwitcherPlugin = kinds.some(k => k.toLowerCase().includes('source_switcher') || k.toLowerCase().includes('source-switcher'));
        this.obsStatus.hasSourceSwitcherPlugin = this.hasSourceSwitcherPlugin;
      } catch (kindErr) {
        this.installedInputKinds = new Set();
        this.hasSourceSwitcherPlugin = null;
      }

      const pluginMsg = this.hasSourceSwitcherPlugin === true ? ' | Source Switcher: Detected' : '';
      this.log('obs', `Connected to OBS! (Latency: ${latency}ms, Version: ${this.obsStatus.version}${pluginMsg})`);
      this.emitStatus();

      // Listen for unexpected disconnect
      this.obs.on('ConnectionClosed', () => {
        this.handleObsDisconnect('Connection closed by OBS.');
      });
      this.obs.on('ConnectionError', (err) => {
        this.handleObsDisconnect(`Connection error: ${err.message}`);
      });

      // Initial sync right after connect
      this.updateCycle().catch(e => console.error(e));
    } catch (err) {
      this.obsStatus.connected = false;
      this.obsStatus.state = 'error';
      this.obsStatus.error = err.message || 'Failed to connect to OBS';
      let hint = '';
      const errMsg = (err.message || '').toLowerCase();
      if (errMsg.includes('connect') || errMsg.includes('econnrefused')) {
        hint = ' (Make sure OBS Studio is running and Tools > WebSocket Server Settings > "Enable WebSocket server" is checked)';
      } else if (errMsg.includes('auth') || errMsg.includes('password')) {
        hint = ' (Check OBS WebSocket Server Password in OBS Tools menu and enter it in Settings)';
      }
      this.log('error', `OBS Connection Failed: ${this.obsStatus.error}${hint}`);
      this.emitStatus();
      this.scheduleObsReconnect();
    }
  }

  handleObsDisconnect(reason) {
    if (this.obsStatus.connected) {
      this.obsStatus.connected = false;
      this.obsStatus.state = 'disconnected';
      this.log('warn', `OBS Disconnected: ${reason}`);
      this.emitStatus();
      this.scheduleObsReconnect();
    }
  }

  scheduleObsReconnect() {
    if (!this.isRunning || this.isReconnecting || this.simulationMode) return;
    this.isReconnecting = true;
    const delay = Math.min(30000, 3000 * Math.pow(1.5, Math.min(this.reconnectAttempts++, 6)));
    this.log('obs', `Scheduling OBS reconnection in ${(delay / 1000).toFixed(1)}s (Attempt #${this.reconnectAttempts})...`);
    setTimeout(async () => {
      this.isReconnecting = false;
      if (this.isRunning && !this.obsStatus.connected) {
        await this.connectOBS();
      }
    }, delay);
  }

  /**
   * Helper to perform HTTP GET using axios or global fetch
   */
  static async httpGetJson(url) {
    if (axios) {
      const res = await axios.get(url, { timeout: 20000 });
      return res.data;
    } else if (typeof fetch === 'function') {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        const text = await res.text();
        let errData;
        try { errData = JSON.parse(text); } catch (e) {}
        const err = new Error(errData && errData.error ? errData.error.message : `HTTP ${res.status}: ${res.statusText}`);
        err.response = { status: res.status, data: errData };
        throw err;
      }
      return await res.json();
    } else {
      throw new Error('No HTTP client (axios or fetch) available');
    }
  }

  /**
   * Maps the columns returned for `rangeA1` (majorDimension=COLUMNS) to the
   * importer's fields by their sheet column letter:
   *   A = ID, B = Label, C = Type, D = Value, E = EZ Sheet ID
   * A range that starts at C (e.g. the classic "C2:D") gives Type + Value only.
   */
  static mapColumns(values, rangeA1) {
    const startLetters = (String(rangeA1 || 'A').split(':')[0].match(/^[A-Za-z]+/) || ['A'])[0].toUpperCase();
    let startIndex = 0; // 0 = column A
    for (const ch of startLetters) startIndex = startIndex * 26 + (ch.charCodeAt(0) - 64);
    startIndex -= 1;
    const col = (letterIndex) => {
      const i = letterIndex - startIndex;
      return i >= 0 && Array.isArray(values) && Array.isArray(values[i]) ? values[i] : [];
    };
    return { idCol: col(0), labelCol: col(1), typeCol: col(2), valCol: col(3), ezCol: col(4) };
  }

  /**
   * Fetches data from Google Sheets API v4
   */
  async fetchSheetData() {
    const config = this.configManager.load();
    const { sheetId, tabname, range, apikey, dimension } = config;

    this.sheetStatus.sheetId = sheetId;
    this.sheetStatus.tabName = tabname;

    if (!sheetId || !apikey) {
      const msg = `Missing Sheet ID or API Key in profile "${config.activeProfile || 'CCS1'}".`;
      this.sheetStatus.state = 'error';
      this.sheetStatus.error = msg;
      this.emitStatus();
      throw new Error(msg);
    }

    this.sheetStatus.state = 'fetching';
    this.emitStatus();

    const dim = dimension || 'COLUMNS';
    const startCell = (config.range || 'C2:D').split(':')[0].trim();
    const startRowMatch = startCell.match(/[0-9]+/);
    const rowOffset = startRowMatch ? parseInt(startRowMatch[0], 10) : 2;

    // Fetch columns A through E (ID, Label, Type, Value, EZ Sheet ID)
    let fetchRange = `A${rowOffset}:E`;
    if (range && /^A[0-9]/i.test(range.trim())) {
      fetchRange = range.trim();
    }
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabname)}!${fetchRange}?key=${apikey}&majorDimension=${dim}`;

    try {
      this.sheetStatus.requestCount++;
      const data = await ImporterEngine.httpGetJson(url);
      const values = data.values || [];

      this.sheetStatus.state = 'success';
      this.sheetStatus.lastSync = new Date().toLocaleTimeString();
      this.sheetStatus.error = null;

      // Columns are mapped by POSITION in the requested range, never by how many
      // came back: Google omits empty columns at the end, so a sheet whose Value
      // column (D) was just cleared returns only A-C. Guessing from the count used
      // to shift Label into Type and Type into Value (every text source became "Text").
      const { idCol, labelCol, typeCol, valCol, ezCol } = ImporterEngine.mapColumns(values, fetchRange);

      const rowCount = Math.max(typeCol.length, valCol.length, labelCol.length);

      this.rawSheetData = [];
      for (let i = 0; i < rowCount; i++) {
        const rowNum = i + rowOffset;
        const label = (labelCol && labelCol[i] !== undefined) ? String(labelCol[i]).trim() : '';
        const type = (typeCol && typeCol[i] !== undefined) ? String(typeCol[i]).trim() : 'Text';
        const val = (valCol && valCol[i] !== undefined) ? String(valCol[i]) : '';
        const ez = (ezCol && ezCol[i] !== undefined && String(ezCol[i]).trim())
          ? String(ezCol[i]).trim()
          : (label ? `${label} |sheet ${rowNum}` : '');

        this.rawSheetData.push({
          row: rowNum,
          label,
          type,
          value: val,
          ezSheetId: ez
        });
      }

      this.sheetStatus.rowsCount = this.rawSheetData.length;
      this.emit('data:preview', this.rawSheetData);
      this.emitStatus();
      return [typeCol, valCol, labelCol, ezCol];
    } catch (err) {
      this.sheetStatus.state = 'error';
      this.sheetStatus.errorCount++;
      let errMsg = err.message;
      if (err.response && err.response.data && err.response.data.error) {
        errMsg = `API ${err.response.data.error.code}: ${err.response.data.error.message}`;
      }
      this.sheetStatus.error = errMsg;
      this.log('error', `Google Sheet Fetch Error: ${errMsg}`);
      this.emitStatus();
      throw err;
    }
  }

  /**
   * Main synchronization update cycle
   */
  async updateCycle() {
    if (this.isUpdating) return;
    this.isUpdating = true;

    try {
      if (!this.obs || !this.obsStatus.connected) {
        return;
      }

      const config = this.configManager.load();
      const data = await this.fetchSheetData();

      // Check if data changed
      const currentJson = JSON.stringify(data);
      const dataChanged = currentJson !== this.lastJsonString;

      const range = config.range || 'C2:D';
      const startcell = range.split(':')[0].trim();
      const startrow = startcell.match(/[0-9]+/);
      const rowoffset = startrow ? parseInt(startrow[0], 10) : 2;

      // Discover OBS scenes & groups
      const sceneList = await this.obs.call('GetSceneList');
      let groupList = { groups: [] };
      try {
        groupList = await this.obs.call('GetGroupList');
      } catch (gErr) {}

      let sceneNameList = [];
      if (sceneList && sceneList.scenes) {
        sceneList.scenes.forEach(scene => {
          sceneNameList.push([scene.sceneName, 0]);
        });
      }
      if (groupList && groupList.groups) {
        groupList.groups.forEach(group => {
          sceneNameList.push([group, 1]);
        });
      }

      this.obsStatus.activeScenesCount = sceneNameList.length;

      const discoveredSources = [];
      let monitoredCount = 0;

      for (const scene of sceneNameList) {
        let allSources;
        try {
          if (scene[1] === 0) {
            allSources = await this.obs.call('GetSceneItemList', { sceneName: scene[0] });
          } else {
            allSources = await this.obs.call('GetGroupSceneItemList', { sceneName: scene[0] });
          }
        } catch (itemErr) {
          continue;
        }

        if (!allSources || !allSources.sceneItems) continue;

        for (const source of allSources.sceneItems) {
          if (source.sourceName && source.sourceName.includes('|sheet')) {
            monitoredCount++;
            const reference = source.sourceName.split('|sheet')[1].trim();
            const rowMatch = reference.match(/[0-9]+/);
            if (!rowMatch) continue;

            const targetRow = parseInt(rowMatch[0], 10);
            const rownumber = targetRow - rowoffset;

            // A row "exists" if any of its columns came back. Google drops trailing
            // empty cells, so an existing row with a blank Value means "empty text".
            const sheetRowCount = Math.max((data[0] || []).length, (data[1] || []).length, (data[2] || []).length);
            const hasRowData = rownumber >= 0 && rownumber < sheetRowCount;
            const rawCellType = data[0] && data[0][rownumber] ? data[0][rownumber] : 'Text';
            const cellRaw = data[1] ? data[1][rownumber] : undefined;
            let rawCellValue = hasRowData && cellRaw !== undefined && cellRaw !== null ? String(cellRaw) : '';

            const parsedTags = ImporterEngine.parseCellTags(rawCellValue);
            const cleanVal = parsedTags.cleanValue;

            const sheetRow = this.rawSheetData.find(r => r.row === targetRow);
            const expectedLabel = sheetRow ? sheetRow.label : '';
            const expectedFullName = sheetRow ? (sheetRow.ezSheetId || (expectedLabel ? `${expectedLabel} |sheet ${targetRow}` : '')) : '';
            const nameCheck = ImporterEngine.compareSourceName(source.sourceName, targetRow, expectedLabel, expectedFullName);
            const isWip = ImporterEngine.isWipSource(source.sourceName, expectedLabel);

            const sourceInfo = {
              sceneName: scene[0],
              isGroup: scene[1] === 1,
              sourceItemId: source.sceneItemId,
              sourceName: source.sourceName,
              sceneItemEnabled: source.sceneItemEnabled,
              targetRow,
              sourceType: rawCellType,
              rawValue: rawCellValue,
              cleanValue: cleanVal,
              tags: parsedTags,
              currentObsValue: '',
              expectedLabel,
              expectedFullName,
              nameCheck,
              isWip,
              syncStatus: hasRowData ? 'synced' : (isWip ? 'wip' : 'error'),
              isMissingRow: !hasRowData,
              error: !hasRowData ? (isWip ? null : `Row ${targetRow} is outside sheet data range (${rowoffset}-${sheetRowCount + rowoffset - 1})`) : null,
              lastUpdated: new Date().toLocaleTimeString()
            };

            const sourceKey = `${scene[0]}::${source.sourceName}::${targetRow}`;

            // Execute OBS updates if data changed or first discovery
            if (hasRowData) {
              this.missingRowsWarned.delete(sourceKey);
              try {
                await this.applySourceUpdate(scene[0], source, rawCellType, rawCellValue, parsedTags, sourceInfo, config);
              } catch (applyErr) {
                sourceInfo.syncStatus = 'error';
                sourceInfo.error = applyErr.message;
                this.log('error', `Failed to update ${source.sourceName}: ${applyErr.message}`);
              }
            } else {
              // Missing row in spreadsheet
              const showMissingLogs = config.showMissingRowLogs === true;
              const onlyOnChanges = config.logMissingRowsOnlyOnChanges !== false;

              // Do not log warnings if source is marked WIP or if missing logs are disabled
              if (!isWip && showMissingLogs) {
                if (onlyOnChanges) {
                  if (!this.missingRowsWarned.has(sourceKey)) {
                    this.missingRowsWarned.add(sourceKey);
                    this.log('warn', `Source "${source.sourceName}" references Row ${targetRow} which does not exist in the spreadsheet.`);
                  }
                } else {
                  this.log('warn', `Source "${source.sourceName}" references Row ${targetRow} which does not exist in the spreadsheet.`);
                }
              }
            }

            discoveredSources.push(sourceInfo);
          }
        }
      }

      this.obsStatus.monitoredSourcesCount = monitoredCount;
      this.sources = discoveredSources;
      this.emit('sources:mapped', this.sources);

      if (dataChanged) {
        this.lastJsonString = currentJson;
        this.log('sheet', `Google Sheet updated (${config.activeProfile || 'CCS1'}): ${this.rawSheetData.length} rows parsed, ${monitoredCount} OBS sources monitored.`);
      }

      this.emitStatus();
    } catch (err) {
      // Handled in sub-methods
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * Apply individual source update based on type with smart visibility state tracking & log deduping
   */
  async applySourceUpdate(sceneName, source, sourcetype, rawCellValue, tags, sourceInfo, config = null) {
    const cfg = config || this.configManager.load();
    const { cleanValue, color, fontstyle, visibility } = tags;
    const showVisLogs = cfg.showVisibilityLogs !== false;
    const logOnlyChanges = cfg.logVisibilityOnlyOnChanges !== false;

    const visibilityKey = `${sceneName}::${source.sceneItemId || source.sourceName}`;
    // The sheet is the source of truth (as in the original importer): compare
    // against what OBS reports right now, so a source someone toggled by hand in
    // OBS is put back on the next poll. The cache is only a fallback.
    const prevEnabled = typeof source.sceneItemEnabled === 'boolean'
      ? source.sceneItemEnabled
      : (this.visibilityStateMap.has(visibilityKey) ? this.visibilityStateMap.get(visibilityKey) : null);
    const isMediaType = sourcetype === 'Image' || sourcetype === 'Video';

    // Handle visibility tag (?hide / ?show). Image/Video handle it themselves
    // below so the file can be swapped while the source is hidden.
    if (visibility !== null && !isMediaType) {
      const stateChanged = prevEnabled !== visibility;
      if (stateChanged || prevEnabled === null) {
        await this.obs.call('SetSceneItemEnabled', {
          sceneName: sceneName,
          sceneItemId: source.sceneItemId,
          sceneItemEnabled: visibility
        });
        this.visibilityStateMap.set(visibilityKey, visibility);
        sourceInfo.sceneItemEnabled = visibility;

        if (showVisLogs && (!logOnlyChanges || stateChanged)) {
          this.log('diff', `[Visibility] '${source.sourceName}' set to ${visibility ? 'Visible' : 'Hidden'} (Scene: ${sceneName})`);
          this.recordDiff(source.sourceName, 'Visibility', prevEnabled ? 'Visible' : 'Hidden', visibility ? 'Visible' : 'Hidden');
        }
      }
    }

    // Text Source
    if (sourcetype === 'Text') {
      let textsettings = await this.obs.call('GetInputSettings', { inputName: source.sourceName });
      let oldText = textsettings.inputSettings ? textsettings.inputSettings.text : '';
      let oldColor = textsettings.inputSettings ? textsettings.inputSettings.color : null;
      let oldFont = textsettings.inputSettings ? textsettings.inputSettings.font : {};

      sourceInfo.currentObsValue = oldText;

      const oldFlags = oldFont && oldFont.flags !== undefined ? oldFont.flags : null;
      const colorChanged = color !== null && color !== oldColor;
      const styleChanged = fontstyle !== null && fontstyle !== oldFlags;
      // Only push when something actually differs (tags used to force a write every poll)
      if (cleanValue !== oldText || colorChanged || styleChanged) {
        const newSettings = {
          text: cleanValue,
          color: color !== null ? color : oldColor,
          font: oldFont ? { ...oldFont } : {}
        };
        if (fontstyle !== null && newSettings.font) {
          newSettings.font.flags = fontstyle;
        }

        await this.obs.call('SetInputSettings', {
          inputName: source.sourceName,
          inputSettings: newSettings
        });

        if (cleanValue !== oldText) {
          this.log('diff', `[Text] '${source.sourceName}' updated: "${oldText}" -> "${cleanValue}"`);
          this.recordDiff(source.sourceName, 'Text', oldText, cleanValue);
        } else {
          this.log('diff', `[Text] '${source.sourceName}' style updated (color/font).`);
        }
        sourceInfo.currentObsValue = cleanValue;
        sourceInfo.syncStatus = 'synced';
      }
    }

    // Color Source
    else if (sourcetype === 'Color') {
      if (rawCellValue) {
        const obsColor = ImporterEngine.hexToObsColor(rawCellValue);
        if (obsColor !== null) {
          let colorsettings = await this.obs.call('GetInputSettings', { inputName: source.sourceName });
          let oldColor = colorsettings.inputSettings ? colorsettings.inputSettings.color : null;
          sourceInfo.currentObsValue = oldColor ? `#${oldColor.toString(16)}` : '';

          if (obsColor !== oldColor) {
            await this.obs.call('SetInputSettings', {
              inputName: source.sourceName,
              inputSettings: { color: obsColor }
            });
            this.log('diff', `[Color] '${source.sourceName}' updated color to ${rawCellValue}`);
            this.recordDiff(source.sourceName, 'Color', sourceInfo.currentObsValue || 'None', rawCellValue);
            sourceInfo.currentObsValue = rawCellValue;
            sourceInfo.syncStatus = 'synced';
          }
        }
      }
    }

    // Image / Video Source (with hide -> swap file -> show transitions)
    else if (isMediaType) {
      await this.applyMediaUpdate(sceneName, source, sourcetype, cleanValue, visibility, prevEnabled, visibilityKey, sourceInfo, { showVisLogs, logOnlyChanges });
    }

    // Browser Source
    else if (sourcetype === 'Browser') {
      let browsersettings = await this.obs.call('GetInputSettings', { inputName: source.sourceName });
      let oldUrl = browsersettings.inputSettings ? browsersettings.inputSettings.url : '';
      sourceInfo.currentObsValue = oldUrl;

      if (cleanValue !== oldUrl) {
        await this.obs.call('SetInputSettings', {
          inputName: source.sourceName,
          inputSettings: { url: cleanValue }
        });
        this.log('diff', `[Browser] '${source.sourceName}' updated url: ${cleanValue}`);
        this.recordDiff(source.sourceName, 'Browser', oldUrl, cleanValue);
        sourceInfo.currentObsValue = cleanValue;
        sourceInfo.syncStatus = 'synced';
      }
    }

    // HS (Hide / Show) - Deduped to only change & log when state actually differs!
    else if (sourcetype === 'HS') {
      const isHide = rawCellValue.toLowerCase().startsWith('hide');
      const isShow = rawCellValue.toLowerCase().startsWith('show');
      if (isHide || isShow) {
        const targetEnabled = isShow;
        const stateChanged = prevEnabled !== targetEnabled;

        if (stateChanged || prevEnabled === null) {
          await this.obs.call('SetSceneItemEnabled', {
            sceneName: sceneName,
            sceneItemId: source.sceneItemId,
            sceneItemEnabled: targetEnabled
          });
          this.visibilityStateMap.set(visibilityKey, targetEnabled);
          sourceInfo.sceneItemEnabled = targetEnabled;

          if (showVisLogs && (!logOnlyChanges || stateChanged)) {
            this.log('diff', `[Visibility] '${source.sourceName}' set to ${targetEnabled ? 'Visible' : 'Hidden'} (Scene: ${sceneName})`);
            this.recordDiff(source.sourceName, 'Visibility', prevEnabled ? 'Visible' : 'Hidden', targetEnabled ? 'Visible' : 'Hidden');
          }
        }
      }
    }

    // Source Switcher (e.g. exeldro/obs-source-switcher or multi-source rotation)
    else if (sourcetype === 'SourceSwitcher' || sourcetype === 'Switcher' || sourcetype === 'Source Switcher') {
      // Split on double semicolon ';;' (or newline '\n') and trim each source name
      const sceneList = cleanValue
        .split(/;;|\r?\n/)
        .map(name => name.trim())
        .filter(Boolean);

      let switcherSettings = null;
      try {
        switcherSettings = await this.obs.call('GetInputSettings', { inputName: source.sourceName });
      } catch (getErr) {
        sourceInfo.syncStatus = 'error';
        sourceInfo.error = `Input '${source.sourceName}' not found in OBS: ${getErr.message}`;
        this.log('error', `[SourceSwitcher] ${sourceInfo.error}`);
        return;
      }

      const inputKind = switcherSettings && switcherSettings.inputKind ? switcherSettings.inputKind : '';
      const isSwitcherKind = inputKind.toLowerCase().includes('switch');

      // Check if the Source Switcher plugin is not installed or if OBS source is the wrong type
      if (inputKind && !isSwitcherKind) {
        if (this.installedInputKinds && this.hasSourceSwitcherPlugin === false) {
          sourceInfo.syncStatus = 'error';
          sourceInfo.error = `Plugin 'obs-source-switcher' is NOT installed in OBS (Source is '${inputKind}').`;
          sourceInfo.warning = `Install plugin from https://obsproject.com/forum/resources/source-switcher.941/`;
          this.log('error', `[SourceSwitcher] Missing Plugin: '${source.sourceName}' is configured as SourceSwitcher in Google Sheets, but 'obs-source-switcher' plugin is not installed in OBS Studio.`);
        } else {
          sourceInfo.warning = `Source in OBS has type '${inputKind}' instead of 'source_switcher'.`;
          this.log('warn', `[SourceSwitcher] '${source.sourceName}' has inputKind '${inputKind}'. Attempting update...`);
        }
      }

      let currentSettings = (switcherSettings && switcherSettings.inputSettings) || {};

      // Determine existing sources list in OBS
      let oldSources = [];
      if (Array.isArray(currentSettings.sources)) {
        oldSources = currentSettings.sources.map(s => typeof s === 'object' && s !== null ? (s.value || s.name || '') : String(s));
      } else if (typeof currentSettings.sources === 'string') {
        oldSources = [currentSettings.sources];
      }

      const oldSummary = oldSources.join(';; ');
      const newSummary = sceneList.join(';; ');
      sourceInfo.currentObsValue = oldSummary;

      if (oldSummary !== newSummary && sceneList.length > 0) {
        // Format for OBS editable list structure (array of objects { value, selected, hidden })
        const formattedSources = sceneList.map(name => ({
          value: name,
          selected: false,
          hidden: false
        }));

        try {
          await this.obs.call('SetInputSettings', {
            inputName: source.sourceName,
            inputSettings: {
              sources: formattedSources
            }
          });

          this.log('diff', `[SourceSwitcher] '${source.sourceName}' updated ${sceneList.length} items: "${sceneList.join(' | ')}"`);
          this.recordDiff(source.sourceName, 'SourceSwitcher', oldSummary || 'None', newSummary);
          sourceInfo.currentObsValue = newSummary;
          if (!sourceInfo.error) sourceInfo.syncStatus = 'synced';
        } catch (setErr) {
          sourceInfo.syncStatus = 'error';
          sourceInfo.error = `Failed to update switcher in OBS: ${setErr.message}`;
          this.log('error', `[SourceSwitcher] '${source.sourceName}' update error: ${setErr.message}`);
        }
      }
    }
  }

  /**
   * Image / Video sources.
   *  ?hide;file  -> hide now, swap the file after 1.5 s (while hidden)
   *  ?show;file  -> swap the file now, show it 0.75 s later (once it has loaded)
   *  file        -> swap the file, leave visibility alone
   * Calls OBS only when something actually differs, and never schedules the same
   * change twice when polling is faster than the transition.
   */
  async applyMediaUpdate(sceneName, source, sourcetype, cleanValue, visibility, prevEnabled, visibilityKey, sourceInfo, logOpts) {
    const fileKey = sourcetype === 'Video' ? 'local_file' : 'file';
    const label = sourcetype === 'Video' ? 'Video' : 'Image';
    const settings = await this.obs.call('GetInputSettings', { inputName: source.sourceName });
    const oldFile = settings.inputSettings ? (settings.inputSettings[fileKey] || '') : '';
    sourceInfo.currentObsValue = oldFile;
    if (!this.pendingMedia) this.pendingMedia = new Map();

    const setVisible = async (enabled, previous) => {
      await this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: source.sceneItemId, sceneItemEnabled: enabled });
      this.visibilityStateMap.set(visibilityKey, enabled);
      sourceInfo.sceneItemEnabled = enabled;
      const changed = previous !== enabled;
      if (logOpts.showVisLogs && (!logOpts.logOnlyChanges || changed)) {
        this.log('diff', `[Visibility] '${source.sourceName}' set to ${enabled ? 'Visible' : 'Hidden'} (Scene: ${sceneName})`);
        this.recordDiff(source.sourceName, 'Visibility', previous ? 'Visible' : 'Hidden', enabled ? 'Visible' : 'Hidden');
      }
    };

    const setFile = async () => {
      await this.obs.call('SetInputSettings', { inputName: source.sourceName, inputSettings: { [fileKey]: cleanValue } });
      this.log('diff', `[${label}] '${source.sourceName}' updated ${fileKey}: ${cleanValue}`);
      this.recordDiff(source.sourceName, label, oldFile, cleanValue);
      sourceInfo.currentObsValue = cleanValue;
    };

    const fileChanged = cleanValue !== oldFile;
    const pendingKey = `${source.sourceName}::${cleanValue}::${visibility}`;

    if (visibility === false) {
      if (prevEnabled !== false) await setVisible(false, prevEnabled);
      if (fileChanged && !this.pendingMedia.has(pendingKey)) {
        if (prevEnabled === false) {
          await setFile(); // already hidden: nothing to wait for
        } else {
          this.pendingMedia.set(pendingKey, true);
          setTimeout(async () => {
            try { if (this.obs && this.obsStatus.connected) await setFile(); } catch (e) {
              this.log('error', `[${label}] '${source.sourceName}' update failed: ${e.message}`);
            } finally { this.pendingMedia.delete(pendingKey); }
          }, 1500);
        }
      }
      return;
    }

    if (fileChanged && !this.pendingMedia.has(pendingKey)) await setFile();

    if (visibility === true && prevEnabled !== true) {
      if (!fileChanged) {
        await setVisible(true, prevEnabled);
      } else if (!this.pendingMedia.has(pendingKey)) {
        this.pendingMedia.set(pendingKey, true);
        setTimeout(async () => {
          try { if (this.obs && this.obsStatus.connected) await setVisible(true, prevEnabled); } catch (e) {
            this.log('error', `[Visibility] '${source.sourceName}' show failed: ${e.message}`);
          } finally { this.pendingMedia.delete(pendingKey); }
        }, 750);
      }
    }
    if (!sourceInfo.error) sourceInfo.syncStatus = 'synced';
  }

  /**
   * Simulation mode: runs demo loop with simulated OBS & Google Sheet data
   */
  startSimulation() {
    this.log('info', '--- Starting Live Demo Simulation Mode ---');
    this.obsStatus = {
      connected: true,
      state: 'connected',
      address: 'ws://localhost:4455 (Simulated)',
      version: 'OBS Studio 30.2.0 (Simulated)',
      latency: 4,
      lastConnected: new Date().toLocaleTimeString(),
      error: null,
      activeScenesCount: 3,
      monitoredSourcesCount: 6
    };

    let tick = 0;
    const demoRows = [
      { row: 2, label: 'Match Title', type: 'Text', value: 'Championship Match - Final Round', ezSheetId: 'Match Title |sheet 2' },
      { row: 3, label: 'Player 1 Header', type: 'Text', value: '?color=#3B82F6;Team Blue (Score: 3)', ezSheetId: 'Player 1 Header |sheet 3' },
      { row: 4, label: 'Player 2 Header', type: 'Text', value: '?color=#EF4444;Team Red (Score: 2)', ezSheetId: 'Player 2 Header |sheet 4' },
      { row: 5, label: 'Background Accent', type: 'Color', value: '#3B82F6', ezSheetId: 'Background Accent |sheet 5' },
      { row: 6, label: 'Sponsor Logo', type: 'Image', value: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=400', ezSheetId: 'Sponsor Logo |sheet 6' },
      { row: 7, label: 'Live Ticker', type: 'Browser', value: 'https://scoreboard.live/stream/view', ezSheetId: 'Live Ticker |sheet 7' },
      { row: 8, label: 'Talent Visibility', type: 'HS', value: 'show', ezSheetId: 'Talent Visibility |sheet 8' },
      { row: 9, label: 'Camera Switcher', type: 'SourceSwitcher', value: 'Caster Desk Cam;; Gameplay Direct;; Crowd Wide Angle', ezSheetId: 'Camera Switcher |sheet 9' }
    ];

    const runSimCycle = () => {
      tick++;
      const config = this.configManager.load();
      this.sheetStatus = {
        state: 'success',
        lastSync: new Date().toLocaleTimeString(),
        rowsCount: demoRows.length,
        error: null,
        requestCount: tick,
        errorCount: 0,
        tabName: config.tabname || 'Interface',
        sheetId: config.sheetId || '1Z1MlruzHm0UYCNO4cTlcDtUdWrMaRB5gwkVy7Zthl8c'
      };

      // Randomly simulate score updates
      if (tick % 3 === 0) {
        const oldScore = demoRows[1].value.replace('?color=#3B82F6;', '');
        const blueScore = Math.floor(Math.random() * 5);
        const newScore = `Team Blue (Score: ${blueScore})`;
        demoRows[1].value = `?color=#3B82F6;${newScore}`;
        this.log('diff', `[Simulated] Team Blue score updated to ${blueScore}`);
        this.recordDiff('Player 1 Header |sheet 3', 'Text', oldScore, newScore);
      }

      this.lastSyncTimestamp = Date.now();
      this.rawSheetData = [...demoRows];
      this.emit('data:preview', this.rawSheetData);

      this.sources = [
        {
          sceneName: 'Main Stream Overlay',
          isGroup: false,
          sourceName: 'Match Title |sheet 2',
          targetRow: 2,
          sourceType: 'Text',
          rawValue: demoRows[0].value,
          cleanValue: 'Championship Match - Final Round',
          tags: ImporterEngine.parseCellTags(demoRows[0].value),
          currentObsValue: 'Championship Match - Final Round',
          expectedLabel: 'Match Title',
          expectedFullName: 'Match Title |sheet 2',
          nameCheck: ImporterEngine.compareSourceName('Match Title |sheet 2', 2, 'Match Title', 'Match Title |sheet 2'),
          syncStatus: 'synced',
          lastUpdated: new Date().toLocaleTimeString()
        },
        {
          sceneName: 'Main Stream Overlay',
          isGroup: false,
          sourceName: 'Match Title - Extra |sheet 2',
          targetRow: 2,
          sourceType: 'Text',
          rawValue: demoRows[0].value,
          cleanValue: 'Championship Match - Final Round',
          tags: ImporterEngine.parseCellTags(demoRows[0].value),
          currentObsValue: 'Championship Match - Final Round',
          expectedLabel: 'Match Title',
          expectedFullName: 'Match Title |sheet 2',
          nameCheck: ImporterEngine.compareSourceName('Match Title - Extra |sheet 2', 2, 'Match Title', 'Match Title |sheet 2'),
          syncStatus: 'synced',
          lastUpdated: new Date().toLocaleTimeString()
        },
        {
          sceneName: 'Main Stream Overlay',
          isGroup: false,
          sourceName: 'Player 1 Header - White |sheet 3',
          targetRow: 3,
          sourceType: 'Text',
          rawValue: demoRows[1].value,
          cleanValue: demoRows[1].value.split(';')[1] || demoRows[1].value,
          tags: ImporterEngine.parseCellTags(demoRows[1].value),
          currentObsValue: demoRows[1].value.split(';')[1] || demoRows[1].value,
          expectedLabel: 'Player 1 Header',
          expectedFullName: 'Player 1 Header |sheet 3',
          nameCheck: ImporterEngine.compareSourceName('Player 1 Header - White |sheet 3', 3, 'Player 1 Header', 'Player 1 Header |sheet 3'),
          syncStatus: 'synced',
          lastUpdated: new Date().toLocaleTimeString()
        },
        {
          sceneName: 'Main Stream Overlay',
          isGroup: false,
          sourceName: 'Player 1 Header - Red |sheet 3',
          targetRow: 3,
          sourceType: 'Text',
          rawValue: demoRows[1].value,
          cleanValue: demoRows[1].value.split(';')[1] || demoRows[1].value,
          tags: ImporterEngine.parseCellTags(demoRows[1].value),
          currentObsValue: demoRows[1].value.split(';')[1] || demoRows[1].value,
          expectedLabel: 'Player 1 Header',
          expectedFullName: 'Player 1 Header |sheet 3',
          nameCheck: ImporterEngine.compareSourceName('Player 1 Header - Red |sheet 3', 3, 'Player 1 Header', 'Player 1 Header |sheet 3'),
          syncStatus: 'synced',
          lastUpdated: new Date().toLocaleTimeString()
        },
        {
          sceneName: 'Main Stream Overlay',
          isGroup: false,
          sourceName: 'Player 2 Header (Blue) |sheet 4',
          targetRow: 4,
          sourceType: 'Text',
          rawValue: demoRows[2].value,
          cleanValue: 'Team Red (Score: 2)',
          tags: ImporterEngine.parseCellTags(demoRows[2].value),
          currentObsValue: 'Team Red (Score: 2)',
          expectedLabel: 'Player 2 Header',
          expectedFullName: 'Player 2 Header |sheet 4',
          nameCheck: ImporterEngine.compareSourceName('Player 2 Header (Blue) |sheet 4', 4, 'Player 2 Header', 'Player 2 Header |sheet 4'),
          syncStatus: 'synced',
          lastUpdated: new Date().toLocaleTimeString()
        },
        {
          sceneName: 'Main Stream Overlay',
          isGroup: false,
          sourceName: 'Player 2 Header (Black) |sheet 4',
          targetRow: 4,
          sourceType: 'Text',
          rawValue: demoRows[2].value,
          cleanValue: 'Team Red (Score: 2)',
          tags: ImporterEngine.parseCellTags(demoRows[2].value),
          currentObsValue: 'Team Red (Score: 2)',
          expectedLabel: 'Player 2 Header',
          expectedFullName: 'Player 2 Header |sheet 4',
          nameCheck: ImporterEngine.compareSourceName('Player 2 Header (Black) |sheet 4', 4, 'Player 2 Header', 'Player 2 Header |sheet 4'),
          syncStatus: 'synced',
          lastUpdated: new Date().toLocaleTimeString()
        },
        {
          sceneName: 'Lower Thirds',
          isGroup: false,
          sourceName: 'Background Accent |sheet 5',
          targetRow: 5,
          sourceType: 'Color',
          rawValue: '#3B82F6',
          cleanValue: '#3B82F6',
          tags: ImporterEngine.parseCellTags('#3B82F6'),
          currentObsValue: '#3B82F6',
          expectedLabel: 'Background Accent',
          expectedFullName: 'Background Accent |sheet 5',
          nameCheck: ImporterEngine.compareSourceName('Background Accent |sheet 5', 5, 'Background Accent', 'Background Accent |sheet 5'),
          syncStatus: 'synced',
          lastUpdated: new Date().toLocaleTimeString()
        },
        {
          sceneName: 'Sponsor Banner',
          isGroup: false,
          sourceName: 'Sponsor Logo |sheet 6',
          targetRow: 6,
          sourceType: 'Image',
          rawValue: demoRows[4].value,
          cleanValue: demoRows[4].value,
          tags: ImporterEngine.parseCellTags(demoRows[4].value),
          currentObsValue: demoRows[4].value,
          expectedLabel: 'Sponsor Logo',
          expectedFullName: 'Sponsor Logo |sheet 6',
          nameCheck: ImporterEngine.compareSourceName('Sponsor Logo |sheet 6', 6, 'Sponsor Logo', 'Sponsor Logo |sheet 6'),
          syncStatus: 'synced',
          lastUpdated: new Date().toLocaleTimeString()
        },
        {
          sceneName: 'Web Widgets',
          isGroup: false,
          sourceName: 'Web Ticker Overlay |sheet 7',
          targetRow: 7,
          sourceType: 'Browser',
          rawValue: demoRows[5].value,
          cleanValue: demoRows[5].value,
          tags: ImporterEngine.parseCellTags(demoRows[5].value),
          currentObsValue: demoRows[5].value,
          expectedLabel: 'Live Ticker',
          expectedFullName: 'Live Ticker |sheet 7',
          nameCheck: ImporterEngine.compareSourceName('Web Ticker Overlay |sheet 7', 7, 'Live Ticker', 'Live Ticker |sheet 7'),
          syncStatus: 'synced',
          lastUpdated: new Date().toLocaleTimeString()
        },
        {
          sceneName: 'Main Stream Overlay',
          isGroup: false,
          sourceName: 'Camera Switcher |sheet 9',
          targetRow: 9,
          sourceType: 'SourceSwitcher',
          rawValue: demoRows[7].value,
          cleanValue: demoRows[7].value,
          tags: ImporterEngine.parseCellTags(demoRows[7].value),
          currentObsValue: demoRows[7].value,
          expectedLabel: 'Camera Switcher',
          expectedFullName: 'Camera Switcher |sheet 9',
          nameCheck: ImporterEngine.compareSourceName('Camera Switcher |sheet 9', 9, 'Camera Switcher', 'Camera Switcher |sheet 9'),
          syncStatus: 'synced',
          lastUpdated: new Date().toLocaleTimeString()
        },
        {
          sceneName: 'Web Widgets',
          isGroup: false,
          sourceName: 'Missing Sponsor |sheet 99',
          targetRow: 99,
          sourceType: 'Image',
          rawValue: '',
          cleanValue: '',
          tags: ImporterEngine.parseCellTags(''),
          currentObsValue: '',
          expectedLabel: '',
          expectedFullName: '',
          nameCheck: ImporterEngine.compareSourceName('Missing Sponsor |sheet 99', 99, '', ''),
          syncStatus: 'error',
          isMissingRow: true,
          error: 'Row 99 is outside Google Sheet data range (1-9)',
          lastUpdated: new Date().toLocaleTimeString()
        }
      ];

      this.emit('sources:mapped', this.sources);
      this.emitStatus();
    };

    runSimCycle();
    this.simulationTimer = setInterval(runSimCycle, 3000);
  }

  /**
   * One-shot test for OBS WebSocket connection
   */
  static async testObsConnection(address, password) {
    if (!OBSWebSocket) {
      return { success: false, error: 'obs-websocket-js library is not available' };
    }
    const testObs = new OBSWebSocket();
    const startTime = Date.now();
    try {
      await testObs.connect(address || 'ws://localhost:4455', password || '');
      const latency = Date.now() - startTime;
      const ver = await testObs.call('GetVersion').catch(() => ({ obsVersion: '5.x' }));
      const scenes = await testObs.call('GetSceneList').catch(() => ({ scenes: [] }));
      const kindsData = await testObs.call('GetInputKindList').catch(() => ({ inputKinds: [] }));
      const kinds = kindsData.inputKinds || [];
      const hasSwitcher = kinds.some(k => k.toLowerCase().includes('source_switcher') || k.toLowerCase().includes('source-switcher'));
      await testObs.disconnect().catch(() => {});

      return {
        success: true,
        latency,
        obsVersion: ver.obsVersion || ver.obsWebSocketVersion || '5.x',
        scenesCount: scenes.scenes ? scenes.scenes.length : 0,
        hasSourceSwitcherPlugin: hasSwitcher
      };
    } catch (err) {
      return {
        success: false,
        error: err.message || 'Connection failed'
      };
    }
  }

  /**
   * One-shot test for Google Sheets API connection
   */
  static async testSheetConnection(sheetId, tabname, range, apikey, dimension) {
    const cleanId = ConfigManager.extractSheetId(sheetId);
    if (!cleanId || !apikey) {
      return { success: false, error: 'Sheet ID and API Key are required' };
    }
    const dim = dimension || 'COLUMNS';
    const cleanRange = range || 'C2:D';
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${cleanId}/values/${encodeURIComponent(tabname || 'Interface')}!${cleanRange}?key=${apikey}&majorDimension=${dim}`;

    const startTime = Date.now();
    try {
      const data = await ImporterEngine.httpGetJson(url);
      const latency = Date.now() - startTime;
      const values = data.values || [];
      const rowCount = Math.max((values[0] || []).length, (values[1] || []).length);
      return {
        success: true,
        latency,
        rowsCount: rowCount,
        sample: values
      };
    } catch (err) {
      let msg = err.message;
      if (err.response && err.response.data && err.response.data.error) {
        msg = `API Error (${err.response.data.error.code}): ${err.response.data.error.message}`;
      }
      return { success: false, error: msg };
    }
  }
}

module.exports = ImporterEngine;
