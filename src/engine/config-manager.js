const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { APP_DIR, dataFile } = require('../paths');

const DEFAULT_PROFILE_CONFIG = {
  sheetId: '',
  tabname: 'Interface',
  range: 'C2:D',
  dimension: 'COLUMNS',
  apikey: '',
  obsaddress: 'ws://localhost:4455',
  obsauth: '',
  polling: 2000,
  autoStart: false,
  logVisibilityOnlyOnChanges: true,
  showVisibilityLogs: true,
  logMissingRowsOnlyOnChanges: true,
  showMissingRowLogs: false,
  // Web Dashboard (control sheet) settings
  controlTabName: 'Stream1',
  scriptUrl: '',
  scriptToken: '',
  allowLanDashboard: false,
  controlPollMs: 4000
};

// Credentials that must never leave this PC in a "clean" (shareable) export.
const PERSONAL_KEYS = ['apikey', 'obsauth', 'scriptToken'];

// Keys that belong to the whole app, never to a single profile. The GUI sends
// some of them back with a profile save; they are filtered out there.
const GLOBAL_KEYS = ['activeProfile', 'profilesList', 'permissions', 'minimizeToTray', 'theme',
  'experimentalControlSheet', 'lanAccessCode'];

/** Experimental Control Sheet / Web Dashboard: off unless switched on. */
function experimentalFromEnv() {
  return process.env.SHEETSTOOBS_EXPERIMENTAL === '1' || process.env.SHEETSTOOBS_EXPERIMENTAL === 'true';
}

function isSafeProfileName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 &&
    !['__proto__', 'constructor', 'prototype'].includes(name);
}

function newAccessCode() {
  // 8 characters from an unambiguous alphabet (~40 bits), shown as XXXX-XXXX.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

const DEFAULT_GLOBAL_SETTINGS = {
  activeProfile: 'Default',
  profiles: {
    'Default': {
      ...DEFAULT_PROFILE_CONFIG,
      tabname: 'Interface'
    }
  },
  minimizeToTray: false,
  theme: 'dark'
};

class ConfigManager {
  constructor(customPath = null) {
    // config.json lives in the user data folder (see src/paths.js); the shipped
    // template config-dist.json stays next to the program.
    this.configPath = customPath || dataFile('config.json');
    this.distPath = path.join(APP_DIR, 'config-dist.json');
    this.corruptReported = false;
  }

  /** Reads and parses a JSON file; returns null if it is missing. Throws on bad JSON. */
  static readJson(file) {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /**
   * Reads config.json. If it is damaged (e.g. the PC lost power mid-save), the
   * damaged file is copied aside once and the last good backup (config.json.bak)
   * is used instead, so a single bad write can no longer wipe every profile.
   */
  readRawConfig() {
    try {
      const raw = ConfigManager.readJson(this.configPath);
      if (raw) return raw;
    } catch (err) {
      if (!this.corruptReported) {
        this.corruptReported = true;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const aside = `${this.configPath}.corrupt-${stamp}`;
        try { fs.copyFileSync(this.configPath, aside); } catch (e) { /* ignore */ }
        console.error(`[ConfigManager] config.json could not be read (${err.message}). A copy was saved as ${aside}.`);
      }
      try {
        const bak = ConfigManager.readJson(`${this.configPath}.bak`);
        if (bak) return bak;
      } catch (e) { /* fall through to defaults */ }
      return null;
    }
    try {
      return ConfigManager.readJson(this.distPath);
    } catch (e) {
      return null;
    }
  }

  isExperimentalEnabled() {
    if (experimentalFromEnv()) return true;
    return this.getFullData().experimentalControlSheet === true;
  }

  /** Access code other devices must enter to use the (experimental) LAN dashboard. */
  getLanAccessCode() {
    const full = this.getFullData();
    if (typeof full.lanAccessCode === 'string' && full.lanAccessCode.length >= 8) return full.lanAccessCode;
    full.lanAccessCode = newAccessCode();
    this.saveFullData(full);
    return full.lanAccessCode;
  }

  /** Turns the experimental Control Sheet on or off (app-wide, not per profile). */
  setExperimental(enabled) {
    const full = this.getFullData();
    full.experimentalControlSheet = !!enabled;
    const res = this.saveFullData(full);
    return res.success ? { success: true, experimentalControlSheet: this.isExperimentalEnabled(), forcedByEnv: experimentalFromEnv() } : res;
  }

  static experimentalForcedByEnv() {
    return experimentalFromEnv();
  }

  rotateLanAccessCode() {
    const full = this.getFullData();
    full.lanAccessCode = newAccessCode();
    const res = this.saveFullData(full);
    return res.success ? full.lanAccessCode : null;
  }

  /**
   * Extract Google Spreadsheet ID from either raw ID or full Google Sheets URL.
   */
  static extractSheetId(input) {
    if (!input || typeof input !== 'string') return '';
    const trimmed = input.trim();
    const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match && match[1]) {
      return match[1];
    }
    return trimmed;
  }

  /**
   * Loads full configuration object containing all profiles and active profile
   */
  getFullData() {
    try {
      const rawData = this.readRawConfig();

      if (!rawData) {
        return JSON.parse(JSON.stringify(DEFAULT_GLOBAL_SETTINGS));
      }

      // Check if legacy single-config format (no "profiles" object)
      if (!rawData.profiles || typeof rawData.profiles !== 'object') {
        const defaultProfileName = 'Default';
        const singleConfig = {
          ...DEFAULT_PROFILE_CONFIG,
          sheetId: rawData.sheetId || '',
          tabname: rawData.tabname || 'Interface',
          range: rawData.range || 'C2:D',
          dimension: rawData.dimension || 'COLUMNS',
          apikey: rawData.apikey || '',
          obsaddress: rawData.obsaddress || 'ws://localhost:4455',
          obsauth: rawData.obsauth || '',
          polling: rawData.polling || 2000,
          autoStart: !!rawData.autoStart,
          logVisibilityOnlyOnChanges: rawData.logVisibilityOnlyOnChanges !== undefined ? rawData.logVisibilityOnlyOnChanges : true,
          showVisibilityLogs: rawData.showVisibilityLogs !== undefined ? rawData.showVisibilityLogs : true
        };

        const migrated = {
          activeProfile: defaultProfileName,
          profiles: {
            [defaultProfileName]: singleConfig
          },
          minimizeToTray: !!rawData.minimizeToTray,
          theme: rawData.theme || 'dark'
        };

        this.saveFullData(migrated);
        return migrated;
      }

      // Ensure activeProfile exists
      const profiles = { ...rawData.profiles };
      let activeProfile = rawData.activeProfile;
      if (!activeProfile || !profiles[activeProfile]) {
        activeProfile = Object.keys(profiles)[0] || 'Default';
      }

      if (!profiles[activeProfile]) {
        profiles[activeProfile] = { ...DEFAULT_PROFILE_CONFIG };
      }

      // Keep any other top-level settings (experimentalControlSheet, lanAccessCode, ...).
      return {
        ...rawData,
        activeProfile,
        profiles,
        minimizeToTray: !!rawData.minimizeToTray,
        theme: rawData.theme || 'dark'
      };
    } catch (err) {
      console.error('[ConfigManager] Error loading config:', err.message);
      return JSON.parse(JSON.stringify(DEFAULT_GLOBAL_SETTINGS));
    }
  }

  /**
   * Check if config file and directory are writable by current process
   */
  checkWritePermission() {
    try {
      const dir = path.dirname(this.configPath);
      if (fs.existsSync(this.configPath)) {
        fs.accessSync(this.configPath, fs.constants.W_OK);
      } else {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.accessSync(dir, fs.constants.W_OK);
      }
      return { isWritable: true };
    } catch (err) {
      return {
        isWritable: false,
        code: 'WRITE_PERMISSION_DENIED',
        title: 'Permission Denied: Unable to Save Settings',
        message: `Windows prevented the app from writing to: ${this.configPath}`,
        solutions: [
          'Right-click SheetsToOBS.exe and select "Run as administrator".',
          'Move the application folder out of "C:\\Program Files" to a user folder (e.g. C:\\SheetsToOBS or Documents).',
          'Right-click the application folder > Properties > Security > Edit > Grant "Full Control" to Users.'
        ],
        rawError: err.message
      };
    }
  }

  /**
   * Loads the active profile configuration merged with top-level helpers
   */
  load() {
    const full = this.getFullData();
    const active = full.profiles[full.activeProfile] || { ...DEFAULT_PROFILE_CONFIG };
    return {
      ...DEFAULT_PROFILE_CONFIG,
      ...active,
      activeProfile: full.activeProfile,
      profilesList: Object.keys(full.profiles),
      minimizeToTray: full.minimizeToTray,
      theme: full.theme,
      experimentalControlSheet: experimentalFromEnv() || full.experimentalControlSheet === true,
      experimentalForced: experimentalFromEnv()
    };
  }

  /**
   * Save full data structure to config.json
   */
  saveFullData(fullData) {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Ensure active profile exists
      if (!fullData.profiles || Object.keys(fullData.profiles).length === 0) {
        fullData.profiles = { 'Default': { ...DEFAULT_PROFILE_CONFIG } };
        fullData.activeProfile = 'Default';
      }

      // Atomic save: write a temp file, keep the previous file as .bak, then rename
      // the temp file into place. A crash mid-save leaves either the old or the new file.
      const tmp = `${this.configPath}.tmp`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, JSON.stringify(fullData, null, 2), 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (fs.existsSync(this.configPath)) {
        try {
          // Only back up a file that still parses, so .bak is always a good copy.
          JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
          fs.copyFileSync(this.configPath, `${this.configPath}.bak`);
        } catch (e) { /* damaged or unreadable: keep the existing .bak */ }
      }
      fs.renameSync(tmp, this.configPath);
      this.corruptReported = false;
      return { success: true };
    } catch (err) {
      console.error('[ConfigManager] Failed to save full data:', err);
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        return {
          success: false,
          code: 'WRITE_PERMISSION_DENIED',
          title: 'Permission Denied: Unable to Save Settings',
          error: `Windows denied permission to write to ${this.configPath}`,
          message: `Windows prevented the app from writing to: ${this.configPath}`,
          solutions: [
            'Right-click SheetsToOBS.exe and select "Run as administrator".',
            'Move the application folder out of "C:\\Program Files" to a user folder (e.g. C:\\SheetsToOBS or Documents).',
            'Right-click the application folder > Properties > Security > Edit > Grant "Full Control" to Users.'
          ],
          rawError: err.message
        };
      }
      return { success: false, error: err.message };
    }
  }

  /**
   * Saves or updates the active profile configuration
   */
  save(profileConfig) {
    try {
      const full = this.getFullData();
      const activeName = full.activeProfile;
      const current = full.profiles[activeName] || { ...DEFAULT_PROFILE_CONFIG };

      const profileFields = { ...profileConfig };
      GLOBAL_KEYS.forEach(k => delete profileFields[k]);
      const sanitized = { ...current, ...profileFields };
      GLOBAL_KEYS.forEach(k => delete sanitized[k]); // clean up keys older versions stored per profile

      if (sanitized.sheetId) {
        sanitized.sheetId = ConfigManager.extractSheetId(sanitized.sheetId);
      }
      if (sanitized.polling !== undefined) {
        let p = parseInt(sanitized.polling, 10);
        if (!p || isNaN(p)) p = 2000;
        if (p > 0 && p <= 60) p = p * 1000;
        sanitized.polling = Math.max(500, p);
      }

      full.profiles[activeName] = sanitized;

      if (profileConfig.minimizeToTray !== undefined) full.minimizeToTray = profileConfig.minimizeToTray;
      if (profileConfig.theme !== undefined) full.theme = profileConfig.theme;

      const saveRes = this.saveFullData(full);
      if (!saveRes.success) return saveRes;

      return { success: true, config: this.load() };
    } catch (err) {
      console.error('[ConfigManager] Failed to save active profile:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Switch active profile
   */
  switchProfile(profileName) {
    const full = this.getFullData();
    if (!full.profiles[profileName]) {
      return { success: false, error: `Profile "${profileName}" not found.` };
    }
    full.activeProfile = profileName;
    const saveRes = this.saveFullData(full);
    if (!saveRes.success) return saveRes;

    return { success: true, activeProfile: profileName, config: this.load() };
  }

  setActiveProfile(profileName) {
    return this.switchProfile(profileName);
  }

  /**
   * Create a new profile
   */
  createProfile(profileName, baseConfig = null) {
    const trimmed = (profileName || '').trim();
    if (!trimmed) return { success: false, error: 'Profile name cannot be empty.' };
    if (!isSafeProfileName(trimmed)) return { success: false, error: 'That profile name is not allowed.' };

    const full = this.getFullData();
    if (full.profiles[trimmed]) {
      return { success: false, error: `Profile "${trimmed}" already exists.` };
    }

    full.profiles[trimmed] = baseConfig ? { ...DEFAULT_PROFILE_CONFIG, ...baseConfig } : { ...DEFAULT_PROFILE_CONFIG };
    full.activeProfile = trimmed;
    const saveRes = this.saveFullData(full);
    if (!saveRes.success) return saveRes;

    return { success: true, activeProfile: trimmed, config: this.load() };
  }

  /**
   * Duplicate an existing profile to a new name
   */
  duplicateProfile(sourceName, newName) {
    const trimmedNew = (newName || '').trim();
    if (!trimmedNew) return { success: false, error: 'New profile name cannot be empty.' };
    if (!isSafeProfileName(trimmedNew)) return { success: false, error: 'That profile name is not allowed.' };

    const full = this.getFullData();
    if (!full.profiles[sourceName]) {
      return { success: false, error: `Source profile "${sourceName}" does not exist.` };
    }
    if (full.profiles[trimmedNew]) {
      return { success: false, error: `Profile "${trimmedNew}" already exists.` };
    }

    full.profiles[trimmedNew] = JSON.parse(JSON.stringify(full.profiles[sourceName]));
    full.activeProfile = trimmedNew;
    const saveRes = this.saveFullData(full);
    if (!saveRes.success) return saveRes;

    return { success: true, activeProfile: trimmedNew, config: this.load() };
  }

  /**
   * Rename an existing profile
   */
  renameProfile(oldName, newName) {
    const trimmedNew = (newName || '').trim();
    if (!trimmedNew) return { success: false, error: 'New profile name cannot be empty.' };
    if (!isSafeProfileName(trimmedNew)) return { success: false, error: 'That profile name is not allowed.' };

    const full = this.getFullData();
    if (!full.profiles[oldName]) {
      return { success: false, error: `Profile "${oldName}" does not exist.` };
    }
    if (oldName !== trimmedNew && full.profiles[trimmedNew]) {
      return { success: false, error: `Profile "${trimmedNew}" already exists.` };
    }

    const data = full.profiles[oldName];
    delete full.profiles[oldName];
    full.profiles[trimmedNew] = data;

    if (full.activeProfile === oldName) {
      full.activeProfile = trimmedNew;
    }

    const saveRes = this.saveFullData(full);
    if (!saveRes.success) return saveRes;

    return { success: true, activeProfile: full.activeProfile, config: this.load() };
  }

  /**
   * Delete a profile. If deleting the last remaining profile, resets to a clean 'Default' profile.
   */
  deleteProfile(profileName) {
    const full = this.getFullData();
    const keys = Object.keys(full.profiles);

    if (!full.profiles[profileName]) {
      return { success: false, error: `Profile "${profileName}" does not exist.` };
    }

    if (keys.length <= 1) {
      delete full.profiles[profileName];
      full.profiles['Default'] = { ...DEFAULT_PROFILE_CONFIG };
      full.activeProfile = 'Default';
      const saveRes = this.saveFullData(full);
      if (!saveRes.success) return saveRes;

      return {
        success: true,
        activeProfile: 'Default',
        config: this.load(),
        resetToDefault: true,
        message: 'Profile deleted and reset to clean Default.'
      };
    }

    delete full.profiles[profileName];
    if (full.activeProfile === profileName) {
      full.activeProfile = Object.keys(full.profiles)[0];
    }

    const saveRes = this.saveFullData(full);
    if (!saveRes.success) return saveRes;

    return { success: true, activeProfile: full.activeProfile, config: this.load() };
  }

  /**
   * Export single active profile or specific profile to shareable JSON object
   * @param {string|null} profileName - Profile to export (or null for active)
   * @param {boolean} includePersonal - Whether to include personal API key and OBS password (false = clean shareable config)
   * @param {object} [opts]
   * @param {boolean} [opts.includeSheetAccess] - Clean export only: keep the Sheet ID and Google API key
   *   so an admin can hand a ready-to-run profile to their producers. The OBS password and
   *   Apps Script token are still removed.
   */
  exportProfile(profileName = null, includePersonal = false, opts = {}) {
    const full = this.getFullData();
    const target = profileName || full.activeProfile;
    const profileData = full.profiles[target];
    if (!profileData) return null;

    const exportedConfig = ConfigManager.shareableProfile({ ...DEFAULT_PROFILE_CONFIG, ...profileData }, includePersonal, opts);

    return {
      version: '2.0.0',
      type: 'single-profile',
      profileName: target,
      includePersonal: !!includePersonal,
      includesSheetAccess: !!includePersonal || !!opts.includeSheetAccess,
      exportedAt: new Date().toISOString(),
      config: exportedConfig
    };
  }

  /**
   * Export all profiles to shareable JSON object
   * @param {boolean} includePersonal - Whether to include personal API key and OBS password
   */
  exportAll(includePersonal = false, opts = {}) {
    const full = this.getFullData();
    const cleanProfiles = {};
    for (const [name, prof] of Object.entries(full.profiles)) {
      cleanProfiles[name] = ConfigManager.shareableProfile({ ...DEFAULT_PROFILE_CONFIG, ...prof }, includePersonal, opts);
    }

    return {
      version: '2.0.0',
      type: 'all-profiles',
      activeProfile: full.activeProfile,
      includePersonal: !!includePersonal,
      includesSheetAccess: !!includePersonal || !!opts.includeSheetAccess,
      exportedAt: new Date().toISOString(),
      profiles: cleanProfiles
    };
  }

  /**
   * What a profile looks like when it leaves this PC.
   *  - Full backup: everything.
   *  - Clean (default): no Sheet ID, API key, OBS password or Apps Script token.
   *  - Clean + includeSheetAccess: Sheet ID and API key kept (admin -> producer hand-off);
   *    OBS password and Apps Script token still removed.
   */
  static shareableProfile(profile, includePersonal, opts = {}) {
    const p = { ...profile };
    GLOBAL_KEYS.forEach(k => delete p[k]);
    if (includePersonal) return p;
    PERSONAL_KEYS.forEach(k => {
      if (!(opts.includeSheetAccess && k === 'apikey')) delete p[k];
    });
    if (!opts.includeSheetAccess) p.sheetId = '';
    p.obsaddress = 'ws://localhost:4455';
    return p;
  }

  /**
   * Import profile(s) from JSON object
   */
  importData(importedJson, overrideName = null) {
    try {
      if (!importedJson || typeof importedJson !== 'object') {
        return { success: false, error: 'Invalid JSON data.' };
      }

      const full = this.getFullData();
      const currentActive = full.profiles[full.activeProfile] || {};
      const fallbackApiKey = currentActive.apikey || '';
      const fallbackObsAddress = currentActive.obsaddress || 'ws://localhost:4455';
      const fallbackObsAuth = currentActive.obsauth || '';
      const fallbackScriptToken = currentActive.scriptToken || '';

      const sanitizeImport = (prof) => {
        const merged = { ...DEFAULT_PROFILE_CONFIG, ...prof };
        GLOBAL_KEYS.forEach(k => delete merged[k]);
        // If imported profile is a clean export (no personal API key / OBS password), inherit local user credentials
        if (!merged.apikey && fallbackApiKey) merged.apikey = fallbackApiKey;
        if (!merged.obsauth && fallbackObsAuth) merged.obsauth = fallbackObsAuth;
        if (!merged.scriptToken && fallbackScriptToken && merged.scriptUrl === currentActive.scriptUrl) {
          merged.scriptToken = fallbackScriptToken;
        }
        if ((!merged.obsaddress || merged.obsaddress === 'ws://localhost:4455') && fallbackObsAddress) {
          merged.obsaddress = fallbackObsAddress;
        }
        return merged;
      };

      // Case 1: Multi-profile export bundle
      if (importedJson.type === 'all-profiles' && importedJson.profiles) {
        let count = 0;
        for (const [name, prof] of Object.entries(importedJson.profiles)) {
          if (prof && typeof prof === 'object' && isSafeProfileName(name)) {
            full.profiles[name] = sanitizeImport(prof);
            count++;
          }
        }
        if (importedJson.activeProfile && full.profiles[importedJson.activeProfile]) {
          full.activeProfile = importedJson.activeProfile;
        }
        const saveRes = this.saveFullData(full);
        if (!saveRes.success) return saveRes;
        return { success: true, message: `Successfully imported ${count} profiles.`, config: this.load() };
      }

      // Case 2: Single-profile export bundle
      if (importedJson.type === 'single-profile' && importedJson.config) {
        const targetName = overrideName || importedJson.profileName || 'Imported Profile';
        if (!isSafeProfileName(targetName)) return { success: false, error: 'Invalid profile name.' };
        full.profiles[targetName] = sanitizeImport(importedJson.config);
        full.activeProfile = targetName;
        const saveRes = this.saveFullData(full);
        if (!saveRes.success) return saveRes;
        return { success: true, message: `Successfully imported profile "${targetName}".`, config: this.load() };
      }

      // Case 3: Raw single config object
      if (importedJson.sheetId !== undefined || importedJson.obsaddress !== undefined) {
        const targetName = overrideName || 'Imported Config';
        if (!isSafeProfileName(targetName)) return { success: false, error: 'Invalid profile name.' };
        full.profiles[targetName] = sanitizeImport(importedJson);
        full.activeProfile = targetName;
        const saveRes = this.saveFullData(full);
        if (!saveRes.success) return saveRes;
        return { success: true, message: `Successfully imported profile "${targetName}".`, config: this.load() };
      }

      return { success: false, error: 'Unrecognized config format.' };
    } catch (err) {
      return { success: false, error: `Import failed: ${err.message}` };
    }
  }

  listProfiles() {
    const full = this.getFullData();
    return Object.keys(full.profiles);
  }

  getActiveProfileName() {
    return this.getFullData().activeProfile;
  }

  getProfile(profileName) {
    const full = this.getFullData();
    return full.profiles[profileName] || null;
  }

  get() {
    return this.load();
  }

  getPath() {
    return this.configPath;
  }
}

ConfigManager.PERSONAL_KEYS = PERSONAL_KEYS;
ConfigManager.GLOBAL_KEYS = GLOBAL_KEYS;
module.exports = ConfigManager;
