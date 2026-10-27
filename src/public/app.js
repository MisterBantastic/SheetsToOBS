// Global Client-Side Error Boundary
window.onerror = function (message, source, lineno, colno, error) {
  console.error('[Client UI Exception]', { message, source, lineno, colno, error });
  try {
    fetch('/api/logs/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: String(message),
        source: String(source),
        lineno,
        colno,
        stack: error ? error.stack : null,
        time: new Date().toISOString()
      })
    }).catch(() => {});
  } catch (e) {}
};

window.addEventListener('unhandledrejection', function (event) {
  console.error('[Client UI Unhandled Rejection]', event.reason);
  try {
    const reason = event.reason;
    fetch('/api/logs/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : null,
        type: 'unhandledrejection',
        time: new Date().toISOString()
      })
    }).catch(() => {});
  } catch (e) {}
});

let eventSource = null;
let saveDebounceTimer = null;
let appState = {
  running: false,
  simulation: false,
  activeProfile: 'Default',
  profilesList: ['Default'],
  obs: {
    connected: false,
    state: 'disconnected',
    address: 'ws://localhost:4455',
    version: 'Unknown',
    latency: 0,
    activeScenesCount: 0,
    monitoredSourcesCount: 0
  },
  sheet: {
    state: 'idle',
    lastSync: 'Never',
    rowsCount: 0,
    requestCount: 0,
    error: null,
    sheetId: '',
    tabName: ''
  },
  sources: [],
  selectedScenes: null, // Set of scene names to monitor (null = all scenes)
  allDiscoveredScenes: [],
  sourceStatusFilter: 'all', // 'all' | 'issues' | 'missing' | 'mismatches' | 'variants' | ...
  sourceTypeFilter: 'all',
  ignoreWip: localStorage.getItem('sheetsToObs_ignore_wip') !== 'false',
  sourceSort: { col: 'targetRow', dir: 'asc' }, // col: 'targetRow' | 'sceneName' | 'sourceName' | 'sourceType', dir: 'asc' | 'desc'
  sheetData: [],
  sheetSort: { col: 'row', dir: 'asc' }, // col: 'row' | 'label' | 'type' | 'ezSheetId', dir: 'asc' | 'desc'
  logs: [],
  activeLogFilter: 'all',
  mode: 'simple'
};

document.addEventListener('DOMContentLoaded', () => {
  const safeInit = (name, fn) => {
    try {
      fn();
    } catch (e) {
      console.error(`[Init Error in ${name}]`, e);
    }
  };

  safeInit('initDelegatedActions', initDelegatedActions);
  safeInit('initExperimentalToggle', initExperimentalToggle);
  safeInit('initTabs', initTabs);
  safeInit('initModeToggle', initModeToggle);
  safeInit('initSSE', initSSE);
  safeInit('initControls', initControls);
  safeInit('initSourceFilters', initSourceFilters);
  safeInit('initSceneFilterDropdown', initSceneFilterDropdown);
  safeInit('initValueDetailsModal', initValueDetailsModal);
  safeInit('initProfiles', initProfiles);
  safeInit('initSettings', initSettings);
  safeInit('initLogs', initLogs);
  safeInit('initLiveDiffPanel', initLiveDiffPanel);
  safeInit('initPersonalizationTab', initPersonalizationTab);
  safeInit('initWindowStateAutoSave', initWindowStateAutoSave);
  safeInit('initImportModal', initImportModal);
  safeInit('initLifecycle', initLifecycle);
  safeInit('loadInitialConfig', loadInitialConfig);
  safeInit('loadInitialStatus', loadInitialStatus);
});

/* ==========================================================================
   APP VIEW MODES (Simplified vs Advanced)
   ========================================================================== */
function initModeToggle() {
  const btnSimple = document.getElementById('btnModeSimple');
  const btnAdvanced = document.getElementById('btnModeAdvanced');

  if (btnSimple) {
    btnSimple.addEventListener('click', () => {
      setAppMode('simple');
    });
  }

  if (btnAdvanced) {
    btnAdvanced.addEventListener('click', () => {
      setAppMode('advanced');
    });
  }

  // Simplified mode is loaded at startup
  setAppMode('simple');
}

function setAppMode(mode) {
  appState.mode = mode;
  const btnSimple = document.getElementById('btnModeSimple');
  const btnAdvanced = document.getElementById('btnModeAdvanced');

  if (mode === 'simple') {
    document.body.classList.add('mode-simple');
    document.body.classList.remove('mode-advanced');
    if (btnSimple) btnSimple.classList.add('active');
    if (btnAdvanced) btnAdvanced.classList.remove('active');

    // If currently on an advanced tab (Sources, Sheet Data, Guide), switch to Logs
    const activeTab = document.querySelector('.nav-tab.active');
    if (activeTab && activeTab.classList.contains('tab-advanced-only')) {
      switchTab('tabLogs');
    }

    try {
      if (window.outerWidth > 640) {
        window.resizeTo(580, 680);
      }
    } catch (e) {}
  } else {
    document.body.classList.remove('mode-simple');
    document.body.classList.add('mode-advanced');
    if (btnSimple) btnSimple.classList.remove('active');
    if (btnAdvanced) btnAdvanced.classList.add('active');

    try {
      if (window.outerWidth < 1200) {
        window.resizeTo(1240, 860);
      }
    } catch (e) {}
  }
}

function switchTab(targetTabId) {
  const tabs = document.querySelectorAll('.nav-tab');
  const panes = document.querySelectorAll('.tab-pane');

  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveConfig(false);
  }

  tabs.forEach(t => {
    if (t.getAttribute('data-tab') === targetTabId) {
      t.classList.add('active');
    } else {
      t.classList.remove('active');
    }
  });

  panes.forEach(p => {
    if (p.id === targetTabId) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });
}

/* ==========================================================================
   APP LIFECYCLE & HEARTBEAT
   ========================================================================== */
function initLifecycle() {
  // Send periodic heartbeat to keep background server alive while GUI is open
  setInterval(() => {
    fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
  }, 1000);
}

/* ==========================================================================
   TABS MANAGEMENT
   ========================================================================== */
function initTabs() {
  const tabs = document.querySelectorAll('.nav-tab');
  const panes = document.querySelectorAll('.tab-pane');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Auto-flush any pending settings save so data is always preserved across tabs
      if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveConfig(false);
      }

      const targetId = tab.getAttribute('data-tab');
      tabs.forEach(t => t.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');
    });
  });
}

/* ==========================================================================
   REAL-TIME SSE (SERVER-SENT EVENTS)
   ========================================================================== */
function initSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/events');

  eventSource.addEventListener('status', (e) => {
    try {
      const data = JSON.parse(e.data);
      updateStatusUI(data);
    } catch (err) {
      console.error('Failed to parse status SSE:', err);
    }
  });

  eventSource.addEventListener('log', (e) => {
    try {
      const entry = JSON.parse(e.data);
      appendLog(entry);
    } catch (err) {
      console.error('Failed to parse log SSE:', err);
    }
  });

  eventSource.addEventListener('sources:mapped', (e) => {
    try {
      const sources = JSON.parse(e.data);
      appState.sources = sources;
      renderSourcesTable(sources);
    } catch (err) {
      console.error('Failed to parse sources SSE:', err);
    }
  });

  eventSource.addEventListener('data:preview', (e) => {
    try {
      const rows = JSON.parse(e.data);
      appState.sheetData = rows;
      renderSheetGrid(rows);
    } catch (err) {
      console.error('Failed to parse sheet data SSE:', err);
    }
  });

  eventSource.onerror = () => {
    console.warn('SSE stream disconnected. Reconnecting in 3s...');
  };
}

/* ==========================================================================
   UI STATUS UPDATES
   ========================================================================== */
function updateStatusUI(data) {
  if (data.obs) appState.obs = data.obs;
  if (data.sheet) appState.sheet = data.sheet;
  if (typeof data.running === 'boolean') appState.running = data.running;
  if (typeof data.simulation === 'boolean') appState.simulation = data.simulation;

  // 1. OBS Card
  const obsBadge = document.getElementById('obsBadge');
  const obsAddressText = document.getElementById('obsAddressText');
  const obsVersionLatency = document.getElementById('obsVersionLatency');
  const obsScenesSources = document.getElementById('obsScenesSources');

  obsAddressText.textContent = appState.obs.address || 'ws://localhost:4455';
  
  if (appState.obs.connected) {
    obsBadge.className = 'badge badge-connected';
    obsBadge.textContent = 'Connected';
    obsVersionLatency.textContent = `${appState.obs.version || '5.x'} / ${appState.obs.latency || 0} ms`;
    obsScenesSources.textContent = `${appState.obs.activeScenesCount || 0} scenes / ${appState.obs.monitoredSourcesCount || 0} mapped`;
  } else if (appState.obs.state === 'connecting') {
    obsBadge.className = 'badge badge-syncing';
    obsBadge.textContent = 'Connecting...';
    obsVersionLatency.textContent = 'Negotiating...';
    obsScenesSources.textContent = '- scenes / - mapped';
  } else if (appState.obs.state === 'error') {
    obsBadge.className = 'badge badge-disconnected';
    obsBadge.textContent = 'Error';
    obsVersionLatency.textContent = appState.obs.error || 'Connection Failed';
    obsScenesSources.textContent = '- scenes / - mapped';
  } else {
    obsBadge.className = 'badge badge-disconnected';
    obsBadge.textContent = 'Disconnected';
    obsVersionLatency.textContent = '- / - ms';
    obsScenesSources.textContent = '- scenes / - mapped';
  }

  // 2. Google Sheets Card
  const sheetBadge = document.getElementById('sheetBadge');
  const sheetTargetText = document.getElementById('sheetTargetText');
  const sheetRowsReqs = document.getElementById('sheetRowsReqs');
  const activeProfileLabel = document.getElementById('activeProfileLabel');

  if (activeProfileLabel) activeProfileLabel.textContent = appState.activeProfile;

  const sheetNameDisplay = appState.sheet.sheetId ? `ID: ${appState.sheet.sheetId.slice(0, 8)}... (${appState.sheet.tabName || 'Interface'})` : 'Not Configured';
  sheetTargetText.textContent = sheetNameDisplay;
  sheetRowsReqs.textContent = `${appState.sheet.lastSync || 'Never'} (${appState.sheet.rowsCount || 0} rows)`;

  if (appState.sheet.state === 'fetching') {
    sheetBadge.className = 'badge badge-syncing';
    sheetBadge.textContent = 'Syncing...';
  } else if (appState.sheet.state === 'success') {
    sheetBadge.className = 'badge badge-connected';
    sheetBadge.textContent = 'Synced';
  } else if (appState.sheet.state === 'error') {
    sheetBadge.className = 'badge badge-disconnected';
    sheetBadge.textContent = 'Sync Error';
  } else {
    sheetBadge.className = 'badge badge-idle';
    sheetBadge.textContent = 'Idle';
  }

  // 3. Engine Controls & Badges
  const engineBadge = document.getElementById('engineBadge');
  const btnToggleEngine = document.getElementById('btnToggleEngine');
  const engineBtnText = document.getElementById('engineBtnText');
  const startIcon = btnToggleEngine ? btnToggleEngine.querySelector('.btn-start-icon') : null;
  const stopIcon = btnToggleEngine ? btnToggleEngine.querySelector('.btn-stop-icon') : null;
  const simBadge = document.getElementById('simBadge');
  const btnToggleSim = document.getElementById('btnToggleSim');

  if (appState.running) {
    if (engineBadge) {
      engineBadge.className = 'badge badge-connected';
      engineBadge.textContent = 'Running';
    }
    if (btnToggleEngine) btnToggleEngine.classList.add('running');
    if (engineBtnText) engineBtnText.textContent = 'Stop Sync';
    if (startIcon) startIcon.classList.add('hidden');
    if (stopIcon) stopIcon.classList.remove('hidden');
  } else {
    if (engineBadge) {
      engineBadge.className = 'badge badge-idle';
      engineBadge.textContent = 'Stopped';
    }
    if (btnToggleEngine) btnToggleEngine.classList.remove('running');
    if (engineBtnText) engineBtnText.textContent = 'Start Sync';
    if (startIcon) startIcon.classList.remove('hidden');
    if (stopIcon) stopIcon.classList.add('hidden');
  }

  if (appState.simulation) {
    if (simBadge) simBadge.classList.remove('hidden');
    if (btnToggleSim) {
      btnToggleSim.textContent = 'Disable Simulation';
      btnToggleSim.classList.add('btn-primary');
      btnToggleSim.classList.remove('btn-outline');
    }
  } else {
    if (simBadge) simBadge.classList.add('hidden');
    if (btnToggleSim) {
      btnToggleSim.textContent = 'Enable Simulation';
      btnToggleSim.classList.remove('btn-primary');
      btnToggleSim.classList.add('btn-outline');
    }
  }

  // 4. Live Diff Updates & Sync Pulse
  if (data.lastSyncDiffs) {
    renderSyncDiffs(data.lastSyncDiffs, data.lastSyncTimestamp);
  }
  if (data.lastSyncTimestamp) {
    triggerSyncPulse();
    updateSyncTicker(data.lastSyncTimestamp);
  }
}

/* ==========================================================================
   PROFILES MANAGEMENT (CCS1, CCS2, Custom Profiles)
   ========================================================================== */
function initProfiles() {
  const headerSelect = document.getElementById('headerProfileSelect');
  const settingsSelect = document.getElementById('settingsProfileSelect');

  const onProfileChange = async (e) => {
    const selected = e.target.value;
    if (selected === appState.activeProfile) return;
    await switchProfile(selected);
  };

  if (headerSelect) headerSelect.addEventListener('change', onProfileChange);
  if (settingsSelect) settingsSelect.addEventListener('change', onProfileChange);

  // New Profile Buttons
  const createNewProfileHandler = async () => {
    const name = prompt('Enter title / name for new profile (e.g. CCS2, Tournament, Scoreboard):');
    if (!name || !name.trim()) return;

    const trimmed = name.trim();
    try {
      const res = await fetch('/api/profiles/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileName: trimmed })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Profile "${trimmed}" created!`, 'success');
        await loadInitialConfig();
      } else {
        showToast(data.error || 'Failed to create profile', 'error');
      }
    } catch (err) {
      showToast(`Error creating profile: ${err.message}`, 'error');
    }
  };

  const btnHeaderNewProfile = document.getElementById('btnHeaderNewProfile');
  if (btnHeaderNewProfile) btnHeaderNewProfile.addEventListener('click', createNewProfileHandler);

  const btnNewProfile = document.getElementById('btnNewProfile');
  if (btnNewProfile) btnNewProfile.addEventListener('click', createNewProfileHandler);

  // Rename Profile
  const btnRenameProfile = document.getElementById('btnRenameProfile');
  if (btnRenameProfile) {
    btnRenameProfile.addEventListener('click', async () => {
      const current = appState.activeProfile;
      const newName = prompt(`Rename profile "${current}" to:`, current);
      if (!newName || !newName.trim() || newName.trim() === current) return;

      const trimmed = newName.trim();
      try {
        const res = await fetch('/api/profiles/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldName: current, newName: trimmed })
        });
        const data = await res.json();
        if (data.success) {
          showToast(`Renamed to "${trimmed}"`, 'success');
          await loadInitialConfig();
        } else if (data.code === 'WRITE_PERMISSION_DENIED') {
          showPermissionModal(data);
        } else {
          showToast(data.error || 'Failed to rename profile', 'error');
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    });
  }

  // Duplicate Profile
  const btnDuplicateProfile = document.getElementById('btnDuplicateProfile');
  if (btnDuplicateProfile) {
    btnDuplicateProfile.addEventListener('click', async () => {
      const current = appState.activeProfile;
      const copyName = prompt(`Enter title for duplicated copy:`, `${current} Copy`);
      if (!copyName || !copyName.trim()) return;

      const trimmed = copyName.trim();
      try {
        const currentConfig = getCurrentFormConfig();
        const res = await fetch('/api/profiles/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileName: trimmed, baseConfig: currentConfig })
        });
        const data = await res.json();
        if (data.success) {
          showToast(`Profile "${trimmed}" duplicated!`, 'success');
          await loadInitialConfig();
        } else if (data.code === 'WRITE_PERMISSION_DENIED') {
          showPermissionModal(data);
        } else {
          showToast(data.error || 'Failed to duplicate profile', 'error');
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    });
  }

  // Delete Profile
  const btnDeleteProfile = document.getElementById('btnDeleteProfile');
  if (btnDeleteProfile) {
    btnDeleteProfile.addEventListener('click', async () => {
      const current = appState.activeProfile;
      if (!confirm(`Are you sure you want to delete profile "${current}"?`)) return;

      try {
        const res = await fetch('/api/profiles/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileName: current })
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message || `Profile "${current}" deleted.`, 'info');
          await loadInitialConfig();
        } else if (data.code === 'WRITE_PERMISSION_DENIED') {
          showPermissionModal(data);
        } else {
          showToast(data.error || 'Failed to delete profile', 'error');
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    });
  }

  // "Include Sheet ID & Google API key" checkbox: used by admins to hand a ready
  // profile to producers. Off by default every time the app opens.
  const shareAccessBox = document.getElementById('chkShareSheetAccess');
  const shareQuery = () => {
    if (!shareAccessBox || !shareAccessBox.checked) return '&clean=true';
    return '&clean=true&sheetAccess=1';
  };
  const confirmShareAccess = () => {
    if (!shareAccessBox || !shareAccessBox.checked) return true;
    return confirm('This export will contain your Sheet ID and Google API key.\n\nOnly send it to producers you trust, and never post it publicly or commit it to GitHub. (The OBS password is never included.)');
  };
  const shareLabel = () => (shareAccessBox && shareAccessBox.checked ? 'with Sheet ID + API key' : 'without Sheet ID or keys');

  // Export Active Profile (shareable; never contains the OBS password)
  const btnExportActive = document.getElementById('btnExportActiveProfile');
  if (btnExportActive) {
    btnExportActive.addEventListener('click', () => {
      if (!confirmShareAccess()) return;
      window.location.href = `/api/profiles/export?profile=${encodeURIComponent(appState.activeProfile)}${shareQuery()}`;
      showToast(`Exporting "${appState.activeProfile}" (${shareLabel()})...`, 'success');
    });
  }

  // Export Active Profile (Full Backup with API key & OBS password)
  const btnExportFull = document.getElementById('btnExportActiveFull');
  if (btnExportFull) {
    btnExportFull.addEventListener('click', () => {
      window.location.href = `/api/profiles/export?profile=${encodeURIComponent(appState.activeProfile)}&clean=false`;
      showToast(`Exporting full backup for "${appState.activeProfile}"...`, 'info');
    });
  }

  // Export All Profiles (Clean)
  const btnExportAll = document.getElementById('btnExportAllProfiles');
  if (btnExportAll) {
    btnExportAll.addEventListener('click', () => {
      if (!confirmShareAccess()) return;
      window.location.href = `/api/profiles/export?profile=all${shareQuery()}`;
      showToast(`Exporting all profiles (${shareLabel()})...`, 'success');
    });
  }

  // Copy Clean Share JSON to Clipboard
  const btnCopyShare = document.getElementById('btnCopyShareJson');
  const btnShareConfig = document.getElementById('btnShareConfig');
  const copyShareHandler = async () => {
    try {
      if (!confirmShareAccess()) return;
      const res = await fetch(`/api/profiles/export?profile=${encodeURIComponent(appState.activeProfile)}${shareQuery()}`);
      const data = await res.json();
      const text = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(text);
      showToast(`Profile "${appState.activeProfile}" JSON copied (${shareLabel()})`, 'success');
    } catch (err) {
      showToast('Failed to copy config to clipboard', 'error');
    }
  };

  if (btnCopyShare) btnCopyShare.addEventListener('click', copyShareHandler);
  if (btnShareConfig) btnShareConfig.addEventListener('click', copyShareHandler);
}

async function switchProfile(profileName) {
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }
  // First ensure current form edits are saved to the current active profile before switching!
  await saveConfig(false);

  try {
    const res = await fetch('/api/profiles/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileName })
    });
    const result = await res.json();
    if (result.success) {
      appState.activeProfile = profileName;
      appState.selectedScenes = loadSelectedScenes(profileName);
      populateProfileDropdowns(result.config.profilesList, profileName);
      populateFormFields(result.config);
      updateSceneDropdownUI();
      renderSourcesTable(appState.sources);
      showToast(`Switched to profile: ${profileName}`, 'success');
    } else if (result.code === 'WRITE_PERMISSION_DENIED') {
      showPermissionModal(result);
    } else {
      showToast(result.error || 'Failed to switch profile', 'error');
    }
  } catch (err) {
    showToast(`Error switching profile: ${err.message}`, 'error');
  }
}

function populateProfileDropdowns(profilesList, activeProfile) {
  const headerSelect = document.getElementById('headerProfileSelect');
  const settingsSelect = document.getElementById('settingsProfileSelect');
  const titleHeader = document.getElementById('formProfileTitle');

  if (titleHeader) titleHeader.textContent = `Profile Settings: ${activeProfile || 'Default'}`;

  const optionsHtml = (profilesList && profilesList.length > 0 ? profilesList : ['Default']).map(p => 
    `<option value="${escapeHtml(p)}" ${p === activeProfile ? 'selected' : ''}>${escapeHtml(p)}</option>`
  ).join('');

  if (headerSelect) headerSelect.innerHTML = optionsHtml;
  if (settingsSelect) settingsSelect.innerHTML = optionsHtml;
}

/* ==========================================================================
   IMPORT CONFIG MODAL
   ========================================================================== */
function initImportModal() {
  const modal = document.getElementById('importModal');
  const btnOpen = document.getElementById('btnOpenImportModal');
  const btnClose = document.getElementById('btnCloseImportModal');
  const btnCancel = document.getElementById('btnCancelImport');
  const btnBrowse = document.getElementById('btnBrowseFile');
  const fileInput = document.getElementById('importFileInput');
  const btnConfirm = document.getElementById('btnConfirmImport');
  const textarea = document.getElementById('importJsonText');
  const nameOverride = document.getElementById('importProfileNameOverride');

  const openModal = () => {
    modal.classList.remove('hidden');
    textarea.value = '';
    nameOverride.value = '';
    fileInput.value = '';
  };

  const closeModal = () => {
    modal.classList.add('hidden');
  };

  if (btnOpen) btnOpen.addEventListener('click', openModal);
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  if (btnBrowse && fileInput) {
    btnBrowse.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (evt) => {
        textarea.value = evt.target.result;
        showToast(`Loaded "${file.name}" into import box`, 'info');
      };
      reader.readAsText(file);
    });
  }

  if (btnConfirm) {
    btnConfirm.addEventListener('click', async () => {
      const rawText = textarea.value.trim();
      if (!rawText) {
        showToast('Please paste JSON or choose a file first', 'error');
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (err) {
        showToast('Invalid JSON syntax: ' + err.message, 'error');
        return;
      }

      try {
        const res = await fetch('/api/profiles/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            json: parsed,
            overrideName: nameOverride.value.trim() || null
          })
        });
        const result = await res.json();
        if (result.success) {
          showToast(result.message || 'Import successful!', 'success');
          closeModal();
          await loadInitialConfig();
        } else if (result.code === 'WRITE_PERMISSION_DENIED') {
          closeModal();
          showPermissionModal(result);
        } else {
          showToast(result.error || 'Import failed', 'error');
        }
      } catch (err) {
        showToast(`Error importing: ${err.message}`, 'error');
      }
    });
  }
}

/* ==========================================================================
   SOURCE FILTERS INITIALIZATION
   ========================================================================== */
function initSourceFilters() {
  const filterInput = document.getElementById('filterSources');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      renderSourcesTable(appState.sources);
    });
  }

  const typeSelect = document.getElementById('filterSourceType');
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      appState.sourceTypeFilter = typeSelect.value;
      renderSourcesTable(appState.sources);
    });
  }

  const chips = document.querySelectorAll('[data-source-filter]');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      appState.sourceStatusFilter = chip.getAttribute('data-source-filter') || 'all';
      renderSourcesTable(appState.sources);
    });
  });

  const chkIgnoreWip = document.getElementById('chkIgnoreWip');
  if (chkIgnoreWip) {
    chkIgnoreWip.checked = appState.ignoreWip !== false;
    chkIgnoreWip.addEventListener('change', () => {
      appState.ignoreWip = chkIgnoreWip.checked;
      localStorage.setItem('sheetsToObs_ignore_wip', chkIgnoreWip.checked ? 'true' : 'false');
      renderSourcesTable(appState.sources);
    });
  }

  const filterSheetInput = document.getElementById('filterSheetData');
  if (filterSheetInput) {
    filterSheetInput.addEventListener('input', () => {
      renderSheetGrid(appState.sheetData);
    });
  }
}

window.resetSourceFilters = function () {
  appState.sourceStatusFilter = 'all';
  appState.sourceTypeFilter = 'all';
  appState.selectedScenes = null;
  saveSelectedScenes(appState.activeProfile, null);
  const filterInput = document.getElementById('filterSources');
  if (filterInput) filterInput.value = '';
  const typeSelect = document.getElementById('filterSourceType');
  if (typeSelect) typeSelect.value = 'all';
  const chips = document.querySelectorAll('[data-source-filter]');
  chips.forEach(c => {
    if (c.getAttribute('data-source-filter') === 'all') c.classList.add('active');
    else c.classList.remove('active');
  });
  updateSceneDropdownUI();
  renderSourcesTable(appState.sources);
};

/* ==========================================================================
   SCENE FILTER MULTI-SELECT DROPDOWN
   ========================================================================== */
function loadSelectedScenes(profileName) {
  try {
    const raw = localStorage.getItem(`sheetsToObs_scenes_${profileName || 'Default'}`);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        return new Set(arr);
      }
    }
  } catch (e) {
    console.warn('Failed to load selected scenes from localStorage:', e);
  }
  return null; // null means all scenes are monitored
}

function saveSelectedScenes(profileName, sceneSet) {
  try {
    const key = `sheetsToObs_scenes_${profileName || 'Default'}`;
    if (!sceneSet || sceneSet.size === 0 || (appState.allDiscoveredScenes && sceneSet.size === appState.allDiscoveredScenes.length)) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(Array.from(sceneSet)));
    }
  } catch (e) {
    console.warn('Failed to save selected scenes to localStorage:', e);
  }
}

function initSceneFilterDropdown() {
  const dropdown = document.getElementById('sceneFilterDropdown');
  const toggleBtn = document.getElementById('btnSceneFilterToggle');
  const menu = document.getElementById('sceneDropdownMenu');
  const btnSelectAll = document.getElementById('btnSelectAllScenes');
  const btnDeselectAll = document.getElementById('btnDeselectAllScenes');
  const searchInput = document.getElementById('sceneSearchInput');

  // Load saved scene preferences
  appState.selectedScenes = loadSelectedScenes(appState.activeProfile);

  if (toggleBtn && menu) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = menu.classList.contains('hidden');
      if (isHidden) {
        menu.classList.remove('hidden');
        if (dropdown) dropdown.classList.add('open');
        if (searchInput) {
          searchInput.value = '';
          filterSceneCheckboxes('');
          setTimeout(() => searchInput.focus(), 50);
        }
      } else {
        menu.classList.add('hidden');
        if (dropdown) dropdown.classList.remove('open');
      }
    });

    document.addEventListener('click', (e) => {
      if (dropdown && !dropdown.contains(e.target)) {
        menu.classList.add('hidden');
        dropdown.classList.remove('open');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
        menu.classList.add('hidden');
        if (dropdown) dropdown.classList.remove('open');
      }
    });
  }

  if (btnSelectAll) {
    btnSelectAll.addEventListener('click', (e) => {
      e.stopPropagation();
      appState.selectedScenes = null; // null = all monitored
      saveSelectedScenes(appState.activeProfile, null);
      updateSceneDropdownUI();
      renderSourcesTable(appState.sources);
    });
  }

  if (btnDeselectAll) {
    btnDeselectAll.addEventListener('click', (e) => {
      e.stopPropagation();
      appState.selectedScenes = new Set();
      saveSelectedScenes(appState.activeProfile, appState.selectedScenes);
      updateSceneDropdownUI();
      renderSourcesTable(appState.sources);
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      filterSceneCheckboxes(e.target.value.toLowerCase().trim());
    });
    searchInput.addEventListener('click', (e) => e.stopPropagation());
  }
}

function filterSceneCheckboxes(query) {
  const items = document.querySelectorAll('.scene-checkbox-item');
  items.forEach(item => {
    const sceneName = (item.getAttribute('data-scene-name') || '').toLowerCase();
    if (!query || sceneName.includes(query)) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
}

function updateSceneDropdownUI() {
  const toggleBtn = document.getElementById('btnSceneFilterToggle');
  const label = document.getElementById('sceneFilterLabel');
  const container = document.getElementById('sceneCheckboxList');
  if (!container) return;

  const allScenes = appState.allDiscoveredScenes || [];
  const selected = appState.selectedScenes;

  // Update button label
  if (label) {
    if (!selected || selected.size === allScenes.length || allScenes.length === 0) {
      label.textContent = 'Scenes (All)';
      if (toggleBtn) toggleBtn.classList.remove('has-filter');
    } else if (selected.size === 0) {
      label.textContent = 'Scenes (0 Selected)';
      if (toggleBtn) toggleBtn.classList.add('has-filter');
    } else {
      label.textContent = `Scenes (${selected.size}/${allScenes.length})`;
      if (toggleBtn) toggleBtn.classList.add('has-filter');
    }
  }

  // Count sources per scene
  const sceneCounts = {};
  (appState.sources || []).forEach(s => {
    if (s && s.sceneName) {
      sceneCounts[s.sceneName] = (sceneCounts[s.sceneName] || 0) + 1;
    }
  });

  if (allScenes.length === 0) {
    container.innerHTML = `
      <div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 0.775rem;">
        No OBS scenes discovered yet
      </div>
    `;
    return;
  }

  container.innerHTML = allScenes.map(scene => {
    const isChecked = !selected || selected.has(scene);
    const count = sceneCounts[scene] || 0;
    return `
      <label class="scene-checkbox-item" data-scene-name="${escapeHtml(scene)}">
        <input type="checkbox" ${isChecked ? 'checked' : ''} data-action="toggle-scene" data-scene="${escapeHtml(scene)}">
        <span class="scene-checkbox-name" title="${escapeHtml(scene)}">${escapeHtml(scene)}</span>
        <span class="scene-count-badge">${count}</span>
      </label>
    `;
  }).join('');
}

window.toggleSceneSelection = function (sceneName, isChecked) {
  const allScenes = appState.allDiscoveredScenes || [];
  if (!appState.selectedScenes) {
    appState.selectedScenes = new Set(allScenes);
  }

  if (isChecked) {
    appState.selectedScenes.add(sceneName);
  } else {
    appState.selectedScenes.delete(sceneName);
  }

  if (appState.selectedScenes.size === allScenes.length) {
    appState.selectedScenes = null; // revert to all monitored
  }

  saveSelectedScenes(appState.activeProfile, appState.selectedScenes);
  updateSceneDropdownUI();
  renderSourcesTable(appState.sources);
};

/* ==========================================================================
   VALUE DETAILS POPUP MODAL
   ========================================================================== */
function initValueDetailsModal() {
  const modal = document.getElementById('valueDetailsModal');
  const btnClose = document.getElementById('btnCloseValModal');
  const btnCloseFooter = document.getElementById('btnCloseValModalFooter');
  const btnCopyRaw = document.getElementById('btnCopyValRaw');
  const btnCopyClean = document.getElementById('btnCopyValClean');
  const rawTextarea = document.getElementById('valModalRawText');
  const cleanDisplay = document.getElementById('valModalCleanDisplay');

  const closeModal = () => {
    if (modal) modal.classList.add('hidden');
  };

  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCloseFooter) btnCloseFooter.addEventListener('click', closeModal);

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });

  if (btnCopyRaw && rawTextarea) {
    btnCopyRaw.addEventListener('click', () => {
      const text = rawTextarea.value || '';
      window.copyExpectedName(text, btnCopyRaw);
    });
  }

  if (btnCopyClean && cleanDisplay) {
    btnCopyClean.addEventListener('click', () => {
      const text = cleanDisplay.textContent || '';
      window.copyExpectedName(text, btnCopyClean);
    });
  }
}

window.openSourceValueModal = function (sourceIndex) {
  const modal = document.getElementById('valueDetailsModal');
  if (!modal) return;

  const source = appState.sources && appState.sources[sourceIndex];
  if (!source) return;

  const titleEl = document.getElementById('valModalTitle');
  const sourceEl = document.getElementById('valModalSource');
  const sceneRowEl = document.getElementById('valModalSceneRow');
  const typeEl = document.getElementById('valModalType');
  const tagsEl = document.getElementById('valModalTags');
  const rawTextarea = document.getElementById('valModalRawText');
  const cleanDisplay = document.getElementById('valModalCleanDisplay');
  const parsedSection = document.getElementById('valModalParsedSection');

  if (titleEl) titleEl.textContent = 'OBS Source Value Details';
  if (sourceEl) sourceEl.textContent = source.sourceName || source.expectedFullName || '-';
  if (sceneRowEl) sceneRowEl.textContent = `Scene: ${source.sceneName} | Row ${source.targetRow}`;
  if (typeEl) typeEl.textContent = source.sourceType || 'Text';

  // Build tags description
  let tagDesc = [];
  if (source.tags) {
    if (source.tags.color !== null && source.tags.color !== undefined) {
      tagDesc.push(`Color: #${source.tags.color.toString(16).padStart(6, '0')}`);
    }
    if (source.tags.fontstyle === 8) tagDesc.push('Strikethrough');
    if (source.tags.fontstyle === 4) tagDesc.push('Underline');
    if (source.tags.visibility === false) tagDesc.push('Hidden');
    else if (source.tags.visibility === true) tagDesc.push('Visible');
  }
  const isSwitcher = (source.sourceType || '').toLowerCase().includes('switch') || (source.cleanValue && source.cleanValue.includes(';;'));
  if (isSwitcher && source.cleanValue) {
    const itemCount = source.cleanValue.split(/;;|\r?\n/).filter(s => s.trim()).length;
    tagDesc.push(`Playlist: ${itemCount} sources`);
  }
  if (tagsEl) tagsEl.textContent = tagDesc.length > 0 ? tagDesc.join(', ') : 'None';

  // Find corresponding sheet row raw expression if available
  const matchingRow = (appState.sheetData || []).find(r => r && r.row === source.targetRow);
  const rawVal = matchingRow && matchingRow.value !== undefined ? matchingRow.value : (source.cleanValue || '');
  const cleanVal = source.cleanValue !== undefined ? source.cleanValue : '';

  if (rawTextarea) rawTextarea.value = rawVal;
  if (cleanDisplay) cleanDisplay.textContent = cleanVal || '(empty)';
  if (parsedSection) parsedSection.classList.remove('hidden');

  modal.classList.remove('hidden');
};

window.openSheetRowValueModal = function (rowIndex) {
  const modal = document.getElementById('valueDetailsModal');
  if (!modal) return;

  const row = appState.sheetData && appState.sheetData[rowIndex];
  if (!row) return;

  const titleEl = document.getElementById('valModalTitle');
  const sourceEl = document.getElementById('valModalSource');
  const sceneRowEl = document.getElementById('valModalSceneRow');
  const typeEl = document.getElementById('valModalType');
  const tagsEl = document.getElementById('valModalTags');
  const rawTextarea = document.getElementById('valModalRawText');
  const cleanDisplay = document.getElementById('valModalCleanDisplay');
  const parsedSection = document.getElementById('valModalParsedSection');

  if (titleEl) titleEl.textContent = 'Google Sheet Row Value Details';
  if (sourceEl) sourceEl.textContent = `Row ${row.row}: ${row.label || '(No Label)'}`;
  if (sceneRowEl) sceneRowEl.textContent = `Google Sheet Tab: ${appState.sheet.tabName || 'Interface'} | Row ${row.row}`;
  if (typeEl) typeEl.textContent = row.type || 'Text';

  // Parse tags
  const rawVal = row.value || '';
  let cleanVal = rawVal;
  let tagList = [];

  if (rawVal.startsWith('?color=')) {
    const split = rawVal.split(';');
    const colorHex = split[0].split('=')[1];
    cleanVal = split.slice(1).join(';');
    tagList.push(`Color: ${colorHex}`);
  }
  if (rawVal.startsWith('?hide')) {
    const split = rawVal.split(';');
    cleanVal = split.slice(1).join(';');
    tagList.push('Hidden');
  }
  if (rawVal.startsWith('?show')) {
    const split = rawVal.split(';');
    cleanVal = split.slice(1).join(';');
    tagList.push('Visible');
  }
  const isRowSwitcher = (row.type || '').toLowerCase().includes('switch') || cleanVal.includes(';;');
  if (isRowSwitcher) {
    const itemCount = cleanVal.split(/;;|\r?\n/).filter(s => s.trim()).length;
    tagList.push(`Playlist: ${itemCount} items`);
  }

  if (tagsEl) tagsEl.textContent = tagList.length > 0 ? tagList.join(', ') : 'None';
  if (rawTextarea) rawTextarea.value = rawVal;
  if (cleanDisplay) cleanDisplay.textContent = cleanVal || '(empty)';
  if (parsedSection) parsedSection.classList.remove('hidden');

  modal.classList.remove('hidden');
};

/* ==========================================================================
   SORTING HELPERS & HANDLERS
   ========================================================================== */
function sortSourcesList(list, sortConfig) {
  if (!sortConfig || !sortConfig.col) return list;
  const { col, dir } = sortConfig;
  const mult = dir === 'desc' ? -1 : 1;

  return [...list].sort((a, b) => {
    if (col === 'targetRow' || col === 'row') {
      const rowA = Number(a.targetRow != null ? a.targetRow : a.row) || 0;
      const rowB = Number(b.targetRow != null ? b.targetRow : b.row) || 0;
      if (rowA !== rowB) return (rowA - rowB) * mult;
      const sc = (a.sceneName || '').localeCompare(b.sceneName || '');
      if (sc !== 0) return sc;
      return (a.sourceName || '').localeCompare(b.sourceName || '');
    }

    if (col === 'sceneName' || col === 'scene') {
      const valA = (a.sceneName || '').toLowerCase();
      const valB = (b.sceneName || '').toLowerCase();
      const cmp = valA.localeCompare(valB);
      if (cmp !== 0) return cmp * mult;
      return ((a.targetRow || 0) - (b.targetRow || 0));
    }

    if (col === 'sourceName' || col === 'source') {
      const valA = (a.sourceName || a.expectedFullName || '').toLowerCase();
      const valB = (b.sourceName || b.expectedFullName || '').toLowerCase();
      const cmp = valA.localeCompare(valB);
      if (cmp !== 0) return cmp * mult;
      return ((a.targetRow || 0) - (b.targetRow || 0));
    }

    if (col === 'sourceType' || col === 'type') {
      const valA = (a.sourceType || a.type || '').toLowerCase();
      const valB = (b.sourceType || b.type || '').toLowerCase();
      const cmp = valA.localeCompare(valB);
      if (cmp !== 0) return cmp * mult;
      return ((a.targetRow || 0) - (b.targetRow || 0));
    }

    return 0;
  });
}

function sortSheetList(list, sortConfig) {
  if (!sortConfig || !sortConfig.col) return list;
  const { col, dir } = sortConfig;
  const mult = dir === 'desc' ? -1 : 1;

  return [...list].sort((a, b) => {
    if (col === 'row') {
      const valA = Number(a.row) || 0;
      const valB = Number(b.row) || 0;
      return (valA - valB) * mult;
    }

    if (col === 'label') {
      const valA = (a.label || '').toLowerCase();
      const valB = (b.label || '').toLowerCase();
      const cmp = valA.localeCompare(valB);
      if (cmp !== 0) return cmp * mult;
      return ((a.row || 0) - (b.row || 0));
    }

    if (col === 'type') {
      const valA = (a.type || '').toLowerCase();
      const valB = (b.type || '').toLowerCase();
      const cmp = valA.localeCompare(valB);
      if (cmp !== 0) return cmp * mult;
      return ((a.row || 0) - (b.row || 0));
    }

    if (col === 'ezSheetId' || col === 'sourceName') {
      const valA = (a.ezSheetId || a.label || '').toLowerCase();
      const valB = (b.ezSheetId || b.label || '').toLowerCase();
      const cmp = valA.localeCompare(valB);
      if (cmp !== 0) return cmp * mult;
      return ((a.row || 0) - (b.row || 0));
    }

    return 0;
  });
}

function updateSourceSortHeaders() {
  const headers = document.querySelectorAll('#sourcesTable .sortable-th');
  headers.forEach(th => {
    const col = th.getAttribute('data-sort-col');
    const ind = th.querySelector('.sort-indicator');
    if (appState.sourceSort && (appState.sourceSort.col === col || (col === 'targetRow' && appState.sourceSort.col === 'row'))) {
      th.classList.add('sort-active');
      if (ind) ind.textContent = appState.sourceSort.dir === 'asc' ? '▲' : '▼';
    } else {
      th.classList.remove('sort-active');
      if (ind) ind.textContent = '⇅';
    }
  });
}

function updateSheetSortHeaders() {
  const headers = document.querySelectorAll('#sheetDataTable .sortable-th');
  headers.forEach(th => {
    const col = th.getAttribute('data-sort-col');
    const ind = th.querySelector('.sort-indicator');
    if (appState.sheetSort && appState.sheetSort.col === col) {
      th.classList.add('sort-active');
      if (ind) ind.textContent = appState.sheetSort.dir === 'asc' ? '▲' : '▼';
    } else {
      th.classList.remove('sort-active');
      if (ind) ind.textContent = '⇅';
    }
  });
}

window.handleSourceSort = function (column) {
  if (!appState.sourceSort) {
    appState.sourceSort = { col: column, dir: 'asc' };
  } else if (appState.sourceSort.col === column || (column === 'targetRow' && appState.sourceSort.col === 'row')) {
    appState.sourceSort.dir = appState.sourceSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    appState.sourceSort = { col: column, dir: 'asc' };
  }
  updateSourceSortHeaders();
  renderSourcesTable(appState.sources);
};

window.handleSheetSort = function (column) {
  if (!appState.sheetSort) {
    appState.sheetSort = { col: column, dir: 'asc' };
  } else if (appState.sheetSort.col === column) {
    appState.sheetSort.dir = appState.sheetSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    appState.sheetSort = { col: column, dir: 'asc' };
  }
  updateSheetSortHeaders();
  renderSheetGrid(appState.sheetData);
};

/* ==========================================================================
   RENDER SOURCE MAPPING TABLE
   ========================================================================== */
function isSheetRowBlank(r) {
  if (!r) return true;
  const label = (r.label || '').trim();
  const val = (r.value || '').trim();
  const ez = (r.ezSheetId || '').trim();
  const hasCustomEz = ez && !/^\|sheet\s*\d+$/i.test(ez) && !/^(Item|Text|Color|Image|Video|Browser|HS)\s*\|sheet\s*\d+$/i.test(ez);
  return !label && !val && !hasCustomEz;
}

function isSourceWip(s) {
  if (!s) return false;
  const name = s.sourceName || '';
  const exp = s.expectedLabel || '';
  const expFull = s.expectedFullName || '';
  const combined = `${name} ${exp} ${expFull}`;
  return /(^|[^a-zA-Z0-9])wip([^a-zA-Z0-9]|$)/i.test(combined);
}

function isSourceBroken(s) {
  if (!s) return false;
  if (appState.ignoreWip && isSourceWip(s)) return false;
  if (s.syncStatus !== 'synced' && s.syncStatus !== 'wip') return true;
  if (s.error || s.isMissingRow) return true;
  if (s.nameCheck && (s.nameCheck.status === 'mismatch' || s.nameCheck.status === 'out_of_bounds')) return true;
  if (s.warning) return true;
  return false;
}

function renderSourcesTable(sources) {
  const tbody = document.getElementById('sourcesTableBody');
  const filterInput = document.getElementById('filterSources');
  const query = filterInput ? filterInput.value.toLowerCase().trim() : '';
  const countBadge = document.getElementById('sourcesCountBadge');
  const issueBadge = document.getElementById('sourcesIssueBadge');
  const chipAll = document.getElementById('chipCountAll');
  const chipIssues = document.getElementById('chipCountIssues');
  const chipMissing = document.getElementById('chipCountMissing');
  const chipMismatches = document.getElementById('chipCountMismatches');
  const chipVariants = document.getElementById('chipCountVariants');
  const chipRed = document.getElementById('chipCountRed');
  const chipBlue = document.getElementById('chipCountBlue');
  const chipWhite = document.getElementById('chipCountWhite');
  const chipBlack = document.getElementById('chipCountBlack');
  const chipExtra = document.getElementById('chipCountExtra');
  const chipSynced = document.getElementById('chipCountSynced');
  const chipWip = document.getElementById('chipCountWip');

  updateSourceSortHeaders();

  const sourceList = Array.isArray(sources) ? sources : [];
  
  // Discover and store unique scenes
  const allDiscoveredScenes = Array.from(new Set(sourceList.map(s => s.sceneName).filter(Boolean))).sort();
  appState.allDiscoveredScenes = allDiscoveredScenes;
  updateSceneDropdownUI();

  // Filter sources by monitored scenes
  const activeSources = sourceList.filter(s => {
    if (!appState.selectedScenes) return true;
    return appState.selectedScenes.has(s.sceneName);
  });

  if (countBadge) countBadge.textContent = activeSources.length;

  // Track which sheet rows have OBS sources mapped among active monitored scenes
  const mappedRows = new Set(activeSources.map(s => s.targetRow));
  // Ignore any sheet entries that are blank in the sheet and do not exist in OBS
  const unmappedSheetRows = (appState.sheetData || []).filter(r => {
    if (!r || !r.row || mappedRows.has(r.row) || isSheetRowBlank(r)) return false;
    if (appState.ignoreWip) {
      const rowCombined = `${r.label || ''} ${r.ezSheetId || ''}`;
      if (/(^|[^a-zA-Z0-9])wip([^a-zA-Z0-9]|$)/i.test(rowCombined)) return false;
    }
    return true;
  });

  // Compute status counts across active monitored sources
  let issuesCount = 0;
  let missingObsSourcesCount = 0;
  let mismatchesCount = 0;
  let variantsCount = 0;
  let redCount = 0;
  let blueCount = 0;
  let whiteCount = 0;
  let blackCount = 0;
  let extraCount = 0;
  let syncedCount = 0;
  let wipCount = 0;

  activeSources.forEach(s => {
    const isWip = isSourceWip(s);
    if (isWip) wipCount++;
    const ignoreThis = appState.ignoreWip && isWip;

    const broken = !ignoreThis && isSourceBroken(s);
    if (broken) issuesCount++;
    if (!ignoreThis && (s.isMissingRow || s.nameCheck?.status === 'out_of_bounds')) {
      missingObsSourcesCount++;
    }
    if (s.nameCheck) {
      if (!ignoreThis && s.nameCheck.status === 'mismatch') {
        mismatchesCount++;
      } else if (s.nameCheck.status === 'variant') {
        variantsCount++;
        const v = (s.nameCheck.variant || '').toLowerCase();
        if (v === 'red') redCount++;
        else if (v === 'blue') blueCount++;
        else if (v === 'white') whiteCount++;
        else if (v === 'black') blackCount++;
        else if (v === 'extra' || v === 'alt') extraCount++;
      } else if (s.nameCheck.status === 'exact' && !broken) {
        syncedCount++;
      }
    } else if (!broken) {
      syncedCount++;
    }
  });

  const totalMissingCount = missingObsSourcesCount + unmappedSheetRows.length;

  if (chipAll) chipAll.textContent = activeSources.length;
  if (chipIssues) chipIssues.textContent = issuesCount;
  if (chipMissing) chipMissing.textContent = totalMissingCount;
  if (chipMismatches) chipMismatches.textContent = mismatchesCount;
  if (chipVariants) chipVariants.textContent = variantsCount;
  if (chipRed) chipRed.textContent = redCount;
  if (chipBlue) chipBlue.textContent = blueCount;
  if (chipWhite) chipWhite.textContent = whiteCount;
  if (chipBlack) chipBlack.textContent = blackCount;
  if (chipExtra) chipExtra.textContent = extraCount;
  if (chipSynced) chipSynced.textContent = syncedCount;
  if (chipWip) chipWip.textContent = wipCount;

  // Highlight/pulse issues filter button if issues exist
  const btnIssues = document.getElementById('filterSourcesIssues');
  if (btnIssues) {
    if (issuesCount > 0) {
      btnIssues.classList.add('has-issues');
    } else {
      btnIssues.classList.remove('has-issues');
    }
  }

  // Update navigation tab issue badge
  if (issueBadge) {
    if (issuesCount > 0) {
      issueBadge.textContent = `${issuesCount} Issue${issuesCount > 1 ? 's' : ''}`;
      issueBadge.classList.remove('hidden');
    } else {
      issueBadge.classList.add('hidden');
    }
  }

  if (activeSources.length === 0 && unmappedSheetRows.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="8">No mapped sources discovered in OBS. Name sources like: <code>Text 1 |sheet 2</code></td>
      </tr>
    `;
    return;
  }

  const statusFilter = appState.sourceStatusFilter || 'all';
  const typeFilter = appState.sourceTypeFilter || 'all';

  const filtered = activeSources.filter(s => {
    const isWip = isSourceWip(s);
    const ignoreThis = appState.ignoreWip && isWip;
    const broken = !ignoreThis && isSourceBroken(s);
    const check = s.nameCheck;
    const v = (check?.variant || '').toLowerCase();
    
    // Status filter
    if (statusFilter === 'issues' && (ignoreThis || !broken)) return false;
    if (statusFilter === 'missing' && (ignoreThis || (!s.isMissingRow && check?.status !== 'out_of_bounds'))) return false;
    if (statusFilter === 'mismatches' && (ignoreThis || !check || check.status !== 'mismatch')) return false;
    if (statusFilter === 'wip' && !isWip) return false;
    if (statusFilter === 'variants' && (!check || check.status !== 'variant')) return false;
    if (statusFilter === 'variant-red' && (!check || check.status !== 'variant' || v !== 'red')) return false;
    if (statusFilter === 'variant-blue' && (!check || check.status !== 'variant' || v !== 'blue')) return false;
    if (statusFilter === 'variant-white' && (!check || check.status !== 'variant' || v !== 'white')) return false;
    if (statusFilter === 'variant-black' && (!check || check.status !== 'variant' || v !== 'black')) return false;
    if (statusFilter === 'variant-extra' && (!check || check.status !== 'variant' || (v !== 'extra' && v !== 'alt'))) return false;
    if (statusFilter === 'synced' && (!check || check.status !== 'exact' || broken)) return false;

    // Type filter
    if (typeFilter !== 'all' && s.sourceType && s.sourceType.toLowerCase() !== typeFilter.toLowerCase()) {
      return false;
    }

    // Search query filter
    if (query) {
      const matchText = [
        s.sceneName || '',
        s.sourceName || '',
        s.expectedLabel || '',
        s.expectedFullName || '',
        check?.expected || '',
        check?.variant || '',
        String(s.targetRow || ''),
        s.sourceType || '',
        s.cleanValue || '',
        s.error || '',
        s.warning || ''
      ].join(' ').toLowerCase();
      if (!matchText.includes(query)) return false;
    }

    return true;
  });

  // If filtering for "missing" or "issues", also check if there are unmapped sheet rows to show
  let unmappedFiltered = [];
  if (statusFilter === 'missing' || statusFilter === 'issues') {
    unmappedFiltered = unmappedSheetRows.filter(r => {
      if (typeFilter !== 'all' && r.type && r.type.toLowerCase() !== typeFilter.toLowerCase()) return false;
      if (query) {
        const matchText = [
          String(r.row || ''),
          r.label || '',
          r.type || '',
          r.value || '',
          r.ezSheetId || ''
        ].join(' ').toLowerCase();
        if (!matchText.includes(query)) return false;
      }
      return true;
    });
  }

  if (filtered.length === 0 && unmappedFiltered.length === 0) {
    let emptyMsg = `No sources match current filter criteria.`;
    if (statusFilter === 'issues') {
      emptyMsg = `🎉 All clear! No broken or erroring sources were found.`;
    } else if (statusFilter === 'missing') {
      emptyMsg = `🎉 Everything is mapped! No missing sheet rows or out-of-bounds sources found.`;
    } else if (statusFilter === 'mismatches') {
      emptyMsg = `🎉 No naming mismatches! All OBS source names match your sheet.`;
    } else if (statusFilter === 'wip') {
      emptyMsg = `No sources containing "WIP" in their name were found.`;
    } else if (statusFilter.startsWith('variant')) {
      emptyMsg = `No sources with selected variant found.`;
    }
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="8">
          <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
            <span>${emptyMsg}</span>
            ${(statusFilter !== 'all' || typeFilter !== 'all' || query || appState.selectedScenes) ? `<button type="button" class="btn btn-xs btn-outline" data-action="reset-source-filters">Clear Filters</button>` : ''}
          </div>
        </td>
      </tr>
    `;
    return;
  }

  const sortedFiltered = sortSourcesList(filtered, appState.sourceSort);

  let rowsHtml = sortedFiltered.map(s => {
    const origIndex = appState.sources.indexOf(s);
    const isWip = isSourceWip(s);
    const ignoreThis = appState.ignoreWip && isWip;
    const broken = !ignoreThis && isSourceBroken(s);
    const check = s.nameCheck || { status: 'no_label', label: 'No Check' };
    const expFull = s.expectedFullName || (check ? check.expected : '') || '';
    const typeClass = `type-${cssToken(s.sourceType || 'text')}`;
    
    let rowClass = '';
    if (broken) {
      rowClass = 'row-issue';
    } else if (ignoreThis) {
      rowClass = 'row-wip';
    } else if (check.status === 'variant') {
      rowClass = 'row-variant';
    }

    // Expected Name & Verification Cell HTML
    let expectedHtml = '';
    if (check.status === 'exact') {
      expectedHtml = `
        <div class="name-verify-cell">
          <div class="name-badge-row">
            <span class="name-status-badge badge-match-exact">
              <svg class="badge-mini-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
              Exact Match
            </span>
          </div>
          <div class="expected-name-line">
            <span class="expected-text font-mono truncate" title="${escapeHtml(expFull)}">${escapeHtml(expFull)}</span>
            <button type="button" class="btn-copy-name" data-action="copy-name" data-copy="${escapeHtml(expFull)}" title="Copy expected name to clipboard">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
          </div>
        </div>
      `;
    } else if (check.status === 'variant') {
      const vColor = check.variant || 'Color';
      let dotClass = 'dot-white';
      let badgeVariantClass = 'badge-match-variant';
      const vLower = vColor.toLowerCase();
      if (vLower === 'black') {
        dotClass = 'dot-black';
        badgeVariantClass += ' variant-black';
      } else if (vLower === 'red') {
        dotClass = 'dot-red';
        badgeVariantClass += ' variant-red';
      } else if (vLower === 'blue') {
        dotClass = 'dot-blue';
        badgeVariantClass += ' variant-blue';
      } else if (vLower === 'extra' || vLower === 'alt') {
        dotClass = 'dot-extra';
        badgeVariantClass += ' variant-extra';
      } else {
        dotClass = 'dot-white';
        badgeVariantClass += ' variant-white';
      }

      expectedHtml = `
        <div class="name-verify-cell">
          <div class="name-badge-row">
            <span class="name-status-badge ${badgeVariantClass}">
              <span class="variant-dot ${dotClass}"></span>
              ${escapeHtml(vColor)} Variant
            </span>
            <span class="variant-ok-tag">Compatible</span>
          </div>
          <div class="expected-name-line">
            <span class="expected-text font-mono truncate" title="Base: ${escapeHtml(expFull)}">${escapeHtml(expFull)}</span>
            <button type="button" class="btn-copy-name" data-action="copy-name" data-copy="${escapeHtml(expFull)}" title="Copy base sheet name to clipboard">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
          </div>
        </div>
      `;
    } else if (check.status === 'mismatch') {
      expectedHtml = `
        <div class="name-verify-cell">
          <div class="name-badge-row">
            ${ignoreThis ? `
              <span class="name-status-badge badge-match-wip">
                🚧 WIP (Ignored)
              </span>
            ` : `
              <span class="name-status-badge badge-match-mismatch">
                <svg class="badge-mini-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
                Name Mismatch
              </span>
            `}
          </div>
          <div class="expected-name-line">
            <span class="expected-text ${ignoreThis ? '' : 'text-mismatch'} font-mono truncate" title="Expected: ${escapeHtml(expFull || `Row ${s.targetRow}`)}">Sheet: <strong>${escapeHtml(expFull || `Row ${s.targetRow}`)}</strong></span>
            <button type="button" class="btn-copy-name" data-action="copy-name" data-copy="${escapeHtml(expFull)}" title="Copy expected OBS name to clipboard">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy
            </button>
          </div>
        </div>
      `;
    } else if (check.status === 'out_of_bounds') {
      expectedHtml = `
        <div class="name-verify-cell">
          ${ignoreThis ? `
            <span class="name-status-badge badge-match-wip">🚧 WIP (Row ${s.targetRow})</span>
          ` : `
            <span class="name-status-badge badge-match-mismatch">❌ Row ${s.targetRow} Not Found</span>
          `}
        </div>
      `;
    } else {
      expectedHtml = `
        <div class="name-verify-cell">
          <span class="name-status-badge badge-match-neutral">No Sheet Label</span>
        </div>
      `;
    }

    // Build tag badges
    let tagsHtml = '';
    if (s.tags) {
      if (s.tags.color !== null && s.tags.color !== undefined) {
        tagsHtml += `<span class="tag-badge"><span class="color-preview-dot" style="background: #${s.tags.color.toString(16).padStart(6, '0')}"></span>Color</span>`;
      }
      if (s.tags.fontstyle === 8) {
        tagsHtml += `<span class="tag-badge">Strikethrough</span>`;
      }
      if (s.tags.fontstyle === 4) {
        tagsHtml += `<span class="tag-badge">Underline</span>`;
      }
      if (s.tags.visibility === false) {
        tagsHtml += `<span class="tag-badge" style="color: #f87171">Hidden</span>`;
      } else if (s.tags.visibility === true) {
        tagsHtml += `<span class="tag-badge" style="color: #34d399">Visible</span>`;
      }
    }
    if (!tagsHtml) tagsHtml = '<span style="color: var(--text-muted); font-size: 0.75rem;">None</span>';

    // Build clickable value cell with popup expand trigger
    const cleanDisplayVal = s.cleanValue !== undefined && s.cleanValue !== null && s.cleanValue !== '' ? s.cleanValue : '-';
    let valHtml = `
      <div class="source-val-wrapper">
        <div class="clickable-val-cell" data-action="open-source-modal" data-index="${origIndex}" title="Click to view full value and expression details">
          <span class="truncate-val" title="${escapeHtml(cleanDisplayVal)}">${escapeHtml(cleanDisplayVal)}</span>
          <span class="btn-expand-hint" title="Expand value">⤢</span>
        </div>
        ${broken && !ignoreThis && (s.error || s.warning) ? `
          <div class="source-issue-alert" title="${escapeHtml(s.error || s.warning || 'Issue')}">
            <svg class="issue-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>${escapeHtml(s.error || s.warning)}</span>
          </div>
        ` : ''}
      </div>
    `;

    const badgeStatusClass = ignoreThis 
      ? 'badge-wip' 
      : (s.syncStatus === 'synced' && !broken ? 'badge-connected' : 'badge-disconnected');
    const badgeText = ignoreThis 
      ? (s.syncStatus === 'synced' ? 'Synced (WIP)' : '🚧 WIP') 
      : (s.syncStatus === 'synced' && !broken ? 'Synced' : '⚠️ Issue');

    return `
      <tr class="${rowClass}">
        <td><strong>${escapeHtml(s.sceneName)}</strong>${s.isGroup ? ' <small style="color:var(--text-muted)">(Group)</small>' : ''}</td>
        <td class="font-mono">${escapeHtml(s.sourceName)}</td>
        <td>${expectedHtml}</td>
        <td><span class="tag-badge">Row ${s.targetRow}</span></td>
        <td><span class="source-type-chip ${typeClass}">${escapeHtml(s.sourceType || 'Text')}</span></td>
        <td>${valHtml}</td>
        <td>${tagsHtml}</td>
        <td>
          <span class="badge ${badgeStatusClass}" title="${escapeHtml(s.error || (broken ? 'Issue detected' : 'Synced'))}">
            ${badgeText}
          </span>
        </td>
      </tr>
    `;
  }).join('');

  // Append unmapped sheet rows if looking at missing items
  if (unmappedFiltered.length > 0) {
    const sortedUnmapped = sortSourcesList(unmappedFiltered, appState.sourceSort);
    const unmappedHtml = sortedUnmapped.map(r => {
      const rowIndex = appState.sheetData.indexOf(r);
      const typeClass = `type-${cssToken(r.type || 'text')}`;
      const ezName = r.ezSheetId || `${r.label || 'Item'} |sheet ${r.row}`;
      const rVal = r.value || '(empty)';

      return `
        <tr class="row-unmapped">
          <td><span class="badge badge-missing-obs">Google Sheet</span></td>
          <td style="color: var(--text-muted); font-style: italic;">(Not mapped in OBS)</td>
          <td>
            <div class="name-verify-cell">
              <div class="name-badge-row">
                <span class="name-status-badge badge-missing-obs">⚠️ Missing in OBS</span>
              </div>
              <div class="expected-name-line">
                <span class="expected-text text-mismatch font-mono truncate" title="Expected: ${escapeHtml(ezName)}">Expected: <strong>${escapeHtml(ezName)}</strong></span>
                <button type="button" class="btn-copy-name" data-action="copy-name" data-copy="${escapeHtml(ezName)}" title="Copy OBS source name to clipboard">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy
                </button>
              </div>
            </div>
          </td>
          <td><span class="tag-badge">Row ${r.row}</span></td>
          <td><span class="source-type-chip ${typeClass}">${escapeHtml(r.type || 'Text')}</span></td>
          <td>
            <div class="clickable-val-cell" data-action="open-sheet-modal" data-index="${rowIndex}" title="Click to inspect full cell content and tags">
              <span class="truncate-val" title="${escapeHtml(rVal)}">${escapeHtml(rVal)}</span>
              <span class="btn-expand-hint" title="Expand value">⤢</span>
            </div>
          </td>
          <td><span style="color: var(--text-muted); font-size: 0.75rem;">None</span></td>
          <td>
            <span class="badge badge-disconnected" title="Google Sheet has this row, but no OBS source references |sheet ${r.row}">
              ⚠️ Missing
            </span>
          </td>
        </tr>
      `;
    }).join('');
    rowsHtml += unmappedHtml;
  }

  tbody.innerHTML = rowsHtml;
}

/* ==========================================================================
   RENDER SHEET DATA GRID
   ========================================================================== */
function renderSheetGrid(rows) {
  const tbody = document.getElementById('sheetDataTableBody');
  const filterInput = document.getElementById('filterSheetData');
  const query = filterInput ? filterInput.value.toLowerCase().trim() : '';
  const rowsBadge = document.getElementById('sheetRowsBadge');

  updateSheetSortHeaders();

  const rowList = Array.isArray(rows) ? rows : [];
  if (rowsBadge) rowsBadge.textContent = rowList.length;

  if (rowList.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="5">No sheet data fetched yet. Check your Google Sheet API settings or click "Sync Now".</td>
      </tr>
    `;
    return;
  }

  const filtered = rowList.filter(r => {
    if (!query) return true;
    return (
      String(r.row).includes(query) ||
      (r.label && r.label.toLowerCase().includes(query)) ||
      (r.type && r.type.toLowerCase().includes(query)) ||
      (r.value && r.value.toLowerCase().includes(query)) ||
      (r.ezSheetId && r.ezSheetId.toLowerCase().includes(query))
    );
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="5">
          <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
            <span>No sheet rows match "${escapeHtml(query)}"</span>
            <button type="button" class="btn btn-xs btn-outline" data-action="clear-sheet-search">Clear Search</button>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  const sortedSheet = sortSheetList(filtered, appState.sheetSort);

  tbody.innerHTML = sortedSheet.map(r => {
    const origIndex = appState.sheetData.indexOf(r);
    const typeClass = `type-${cssToken(r.type || 'text')}`;
    const parsed = parseDisplayValue(r.value);
    const ezId = r.ezSheetId || `${r.label || 'Text'} |sheet ${r.row}`;
    const valRaw = r.value || '(empty)';

    return `
      <tr>
        <td><strong class="font-mono">${r.row}</strong></td>
        <td><span class="sheet-label-text" title="${escapeHtml(r.label || '-')}">${escapeHtml(r.label || '-')}</span></td>
        <td><span class="source-type-chip ${typeClass}">${escapeHtml(r.type || 'Text')}</span></td>
        <td>
          <div class="sheet-cell-value-wrap">
            <div class="clickable-val-cell" data-action="open-sheet-modal" data-index="${origIndex}" title="Click to inspect full cell content, tags, and parsed output (${escapeHtml(valRaw)})">
              <span class="truncate-val font-mono">${parsed}</span>
              <span class="btn-expand-hint" title="Expand value">⤢</span>
            </div>
          </div>
        </td>
        <td>
          <div class="ez-id-cell">
            <code class="font-mono ez-id-text" title="${escapeHtml(ezId)}">${escapeHtml(ezId)}</code>
            <button type="button" class="btn-copy-name" data-action="copy-name" data-copy="${escapeHtml(ezId)}" title="Copy EZ Sheet ID for OBS source">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              <span>Copy</span>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function parseDisplayValue(val) {
  if (!val) return '<span style="color:var(--text-muted); font-size:0.75rem;">(empty)</span>';
  let clean = val;
  let badges = '';

  if (val.startsWith('?color=')) {
    const split = val.split(';');
    const rawHex = (split[0].split('=')[1] || '').trim();
    clean = split.slice(1).join(';');
    // Only a real hex colour may reach the style attribute (sheet text is untrusted).
    const colorHex = /^#?[0-9a-fA-F]{3,8}$/.test(rawHex) ? (rawHex.startsWith('#') ? rawHex : `#${rawHex}`) : null;
    badges += colorHex
      ? `<span class="tag-badge"><span class="color-preview-dot" style="background: ${colorHex}"></span>${escapeHtml(colorHex)}</span>`
      : `<span class="tag-badge">Invalid color</span>`;
  }
  if (val.startsWith('?fontstyle=')) {
    const split = val.split(';');
    const style = split[0].split('=')[1];
    clean = split.slice(1).join(';');
    badges += `<span class="tag-badge">${escapeHtml(style)}</span>`;
  }
  if (val.startsWith('?hide')) {
    const split = val.split(';');
    clean = split.slice(1).join(';');
    badges += `<span class="tag-badge" style="color:#f87171">Hide</span>`;
  }
  if (val.startsWith('?show')) {
    const split = val.split(';');
    clean = split.slice(1).join(';');
    badges += `<span class="tag-badge" style="color:#34d399">Show</span>`;
  }
  if (clean.includes(';;')) {
    const count = clean.split(/;;|\r?\n/).filter(s => s.trim()).length;
    badges += `<span class="tag-badge" style="color: #06d6a0; border-color: rgba(6,214,160,0.3)">${count} Items</span>`;
  }

  return `${badges}<span class="truncate-val-text" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;">${escapeHtml(clean)}</span>`;
}

/* ==========================================================================
   LOG CONSOLE & FILTERS
   ========================================================================== */
function initLogs() {
  const filterChips = document.querySelectorAll('.btn-chip');
  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      appState.activeLogFilter = chip.getAttribute('data-filter');
      reRenderLogs();
    });
  });

  const btnClear = document.getElementById('btnClearLogs');
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      appState.logs = [];
      const logConsole = document.getElementById('logConsole');
      if (logConsole) logConsole.innerHTML = '';
      const countBadge = document.getElementById('logCountBadge');
      if (countBadge) countBadge.textContent = '0';
    });
  }

  const btnExport = document.getElementById('btnExportLogs');
  if (btnExport) {
    btnExport.addEventListener('click', exportLogs);
  }

  const filterSources = document.getElementById('filterSources');
  if (filterSources) {
    filterSources.addEventListener('input', () => renderSourcesTable(appState.sources));
  }

  const filterSheet = document.getElementById('filterSheetData');
  if (filterSheet) {
    filterSheet.addEventListener('input', () => renderSheetGrid(appState.sheetData));
  }
}

function appendLog(entry) {
  appState.logs.push(entry);
  if (appState.logs.length > 300) appState.logs.shift();

  const countBadge = document.getElementById('logCountBadge');
  if (countBadge) countBadge.textContent = appState.logs.length;

  if (matchesLogFilter(entry, appState.activeLogFilter)) {
    const logConsole = document.getElementById('logConsole');
    if (!logConsole) return;

    const row = document.createElement('div');
    row.className = 'log-entry';
    row.innerHTML = `
      <span class="log-time">${entry.timestamp || ''}</span>
      <span class="log-tag log-tag-${(entry.level || 'info').toLowerCase()}">${(entry.level || 'info').toUpperCase()}</span>
      <span class="log-msg">${escapeHtml(entry.message || '')}</span>
    `;

    logConsole.appendChild(row);

    const chkAutoScroll = document.getElementById('chkAutoScroll');
    if (chkAutoScroll && chkAutoScroll.checked) {
      logConsole.scrollTop = logConsole.scrollHeight;
    }
  }
}

function reRenderLogs() {
  const logConsole = document.getElementById('logConsole');
  if (!logConsole) return;
  logConsole.innerHTML = '';

  appState.logs.forEach(entry => {
    if (matchesLogFilter(entry, appState.activeLogFilter)) {
      const row = document.createElement('div');
      row.className = 'log-entry';
      row.innerHTML = `
        <span class="log-time">${entry.timestamp || ''}</span>
        <span class="log-tag log-tag-${(entry.level || 'info').toLowerCase()}">${(entry.level || 'info').toUpperCase()}</span>
        <span class="log-msg">${escapeHtml(entry.message || '')}</span>
      `;
      logConsole.appendChild(row);
    }
  });

  const chkAutoScroll = document.getElementById('chkAutoScroll');
  if (chkAutoScroll && chkAutoScroll.checked) {
    logConsole.scrollTop = logConsole.scrollHeight;
  }
}

function matchesLogFilter(entry, filter) {
  if (filter === 'all') return true;
  const lvl = (entry.level || '').toLowerCase();
  const msg = (entry.message || '').toLowerCase();

  if (filter === 'obs') return lvl === 'obs';
  if (filter === 'sheet') return lvl === 'sheet';
  if (filter === 'diff') return lvl === 'diff' && !msg.includes('[visibility]');
  if (filter === 'visibility') return msg.includes('[visibility]');
  if (filter === 'error') return lvl === 'error' || lvl === 'warn';
  return true;
}

function exportLogs() {
  if (appState.logs.length === 0) {
    showToast('No logs to export', 'info');
    return;
  }
  const text = appState.logs.map(l => `[${l.timestamp}] [${(l.level || 'INFO').toUpperCase()}] ${l.message}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `obs-sheets-logs-${appState.activeProfile}-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Logs exported to text file', 'success');
}

/* ==========================================================================
   ENGINE CONTROLS
   ========================================================================== */
function initControls() {
  const btnToggleEngine = document.getElementById('btnToggleEngine');
  if (btnToggleEngine) {
    btnToggleEngine.addEventListener('click', async () => {
      const action = appState.running ? 'stop' : 'start';
      try {
        const res = await fetch(`/api/control/${action}`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast(action === 'start' ? 'Sync Engine Started' : 'Sync Engine Stopped', 'info');
        }
      } catch (err) {
        showToast(`Failed to toggle engine: ${err.message}`, 'error');
      }
    });
  }

  const btnSyncNow = document.getElementById('btnSyncNow');
  if (btnSyncNow) {
    btnSyncNow.addEventListener('click', async () => {
      try {
        btnSyncNow.classList.add('loading');
        const res = await fetch('/api/control/sync-now', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('Manual sync triggered', 'info');
        }
      } catch (err) {
        showToast(`Sync trigger failed: ${err.message}`, 'error');
      } finally {
        btnSyncNow.classList.remove('loading');
      }
    });
  }

  const btnToggleSim = document.getElementById('btnToggleSim');
  if (btnToggleSim) {
    btnToggleSim.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/control/simulation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !appState.simulation })
        });
        const data = await res.json();
        if (data.success) {
          showToast(`Simulation Mode ${data.simulation ? 'Enabled' : 'Disabled'}`, 'info');
        }
      } catch (err) {
        showToast(`Failed to toggle simulation: ${err.message}`, 'error');
      }
    });
  }

  const quickPollingSelect = document.getElementById('quickPollingSelect');
  if (quickPollingSelect) {
    quickPollingSelect.addEventListener('change', async () => {
      const val = parseInt(quickPollingSelect.value, 10) || 2000;
      const pollingEl = document.getElementById('cfgPolling');
      if (pollingEl) {
        pollingEl.value = val;
      }
      await saveConfig(true);
    });
  }

  const btnQuitApp = document.getElementById('btnQuitApp');
  if (btnQuitApp) {
    btnQuitApp.addEventListener('click', async () => {
      if (confirm('Are you sure you want to exit and shut down the application server?')) {
        showToast('Shutting down SheetsToOBS...', 'info');
        try {
          await fetch('/api/shutdown', { method: 'POST' });
        } catch (e) {}
        setTimeout(() => {
          window.close();
        }, 300);
      }
    });
  }
}

/* ==========================================================================
   SETTINGS & CONNECTION TESTERS
   ========================================================================== */
function scheduleAutoSave() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveConfig(false); // silent save in background
  }, 400);
}

function initSettings() {
  const btnSaveConfig = document.getElementById('btnSaveConfig');
  if (btnSaveConfig) {
    btnSaveConfig.addEventListener('click', () => saveConfig(true));
  }

  // Real-time auto-save listeners on all form fields
  const inputIds = [
    'cfgSheetId', 'cfgTabName', 'cfgRange', 'cfgApiKey', 
    'cfgObsAddress', 'cfgObsAuth', 'cfgPolling', 'cfgAutoStart', 
    'cfgLogVisibilityOnlyOnChanges', 'cfgShowVisibilityLogs',
    'cfgLogMissingRowsOnlyOnChanges', 'cfgShowMissingRowLogs',
    'cfgControlTab', 'cfgControlPoll', 'cfgScriptUrl', 'cfgScriptToken', 'cfgAllowLanDashboard'
  ];
  inputIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', scheduleAutoSave);
      el.addEventListener('change', scheduleAutoSave);
    }
  });

  const cfgPollingEl = document.getElementById('cfgPolling');
  if (cfgPollingEl) {
    cfgPollingEl.addEventListener('input', () => {
      const parsed = parsePollingValue(cfgPollingEl.value);
      const quickSelect = document.getElementById('quickPollingSelect');
      if (quickSelect && parsed) {
        quickSelect.value = String(parsed);
      }
    });
  }

  const btnExtract = document.getElementById('btnExtractSheetId');
  if (btnExtract) {
    btnExtract.addEventListener('click', () => {
      const input = document.getElementById('cfgSheetId');
      const val = input.value.trim();
      const match = val.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        input.value = match[1];
        scheduleAutoSave();
        showToast(`Extracted Sheet ID: ${match[1]}`, 'success');
      } else {
        showToast('Input is already a raw ID or unrecognized URL', 'info');
      }
    });
  }

  const btnToggleApiKey = document.getElementById('btnToggleApiKey');
  const cfgApiKey = document.getElementById('cfgApiKey');
  if (btnToggleApiKey && cfgApiKey) {
    btnToggleApiKey.addEventListener('click', () => {
      if (cfgApiKey.type === 'password') {
        cfgApiKey.type = 'text';
        btnToggleApiKey.textContent = 'Hide';
      } else {
        cfgApiKey.type = 'password';
        btnToggleApiKey.textContent = 'Show';
      }
    });
  }

  const btnToggleObsAuth = document.getElementById('btnToggleObsAuth');
  const cfgObsAuth = document.getElementById('cfgObsAuth');
  if (btnToggleObsAuth && cfgObsAuth) {
    btnToggleObsAuth.addEventListener('click', () => {
      if (cfgObsAuth.type === 'password') {
        cfgObsAuth.type = 'text';
        btnToggleObsAuth.textContent = 'Hide';
      } else {
        cfgObsAuth.type = 'password';
        btnToggleObsAuth.textContent = 'Show';
      }
    });
  }

  const btnToggleScriptToken = document.getElementById('btnToggleScriptToken');
  const cfgScriptToken = document.getElementById('cfgScriptToken');
  if (btnToggleScriptToken && cfgScriptToken) {
    btnToggleScriptToken.addEventListener('click', () => {
      const show = cfgScriptToken.type === 'password';
      cfgScriptToken.type = show ? 'text' : 'password';
      btnToggleScriptToken.textContent = show ? 'Hide' : 'Show';
    });
  }

  const cfgScriptUrl = document.getElementById('cfgScriptUrl');
  const cfgScriptUrlHint = document.getElementById('cfgScriptUrlHint');
  if (cfgScriptUrl && cfgScriptUrlHint) {
    const defaultHint = cfgScriptUrlHint.textContent;
    const checkUrl = () => {
      const v = cfgScriptUrl.value.trim();
      const ok = !v || /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(v);
      cfgScriptUrlHint.textContent = ok ? defaultHint : 'This does not look like a Web App URL. It must end in /exec (use the deployment URL, not the editor URL).';
      cfgScriptUrlHint.style.color = ok ? '' : 'var(--danger, #ef4444)';
    };
    cfgScriptUrl.addEventListener('input', checkUrl);
    cfgScriptUrl._checkUrl = checkUrl;
  }

  // Save, then test the Apps Script bridge with the saved profile settings
  const btnTestBridge = document.getElementById('btnTestBridge');
  const bridgeTestResult = document.getElementById('bridgeTestResult');
  if (btnTestBridge && bridgeTestResult) {
    btnTestBridge.addEventListener('click', async () => {
      bridgeTestResult.className = 'test-result-box';
      bridgeTestResult.textContent = 'Saving profile and contacting the Apps Script bridge…';
      bridgeTestResult.classList.remove('hidden');
      const saved = await saveConfig(false);
      if (!saved) {
        bridgeTestResult.className = 'test-result-box error';
        bridgeTestResult.textContent = 'Could not save the profile settings.';
        return;
      }
      try {
        const res = await fetch('/api/sheet-control/test', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          bridgeTestResult.className = 'test-result-box success';
          const v = String(data.version || '1.0.0').split('.').map(n => parseInt(n, 10) || 0);
          const outdated = v[0] < 1 || (v[0] === 1 && v[1] < 1);
          bridgeTestResult.innerHTML = `<strong>Bridge connected</strong><br>Spreadsheet: <strong>${escapeHtml(data.spreadsheet || '')}</strong> · bridge v${escapeHtml(data.version || '')}<br>Allowed tabs: ${escapeHtml((data.allowedTabs || []).join(', '))}` +
            (outdated ? `<br><strong style="color: var(--danger, #ef4444);">This bridge is out of date: dropdown lists (teams, subs, skins) can be up to 10 minutes stale. Paste the new WebApp.gs and publish it with Deploy › Manage deployments › ✏️ › Version: New version.</strong>` : '');
        } else {
          bridgeTestResult.className = 'test-result-box error';
          bridgeTestResult.innerHTML = `<strong>Bridge not connected</strong><br>${escapeHtml(data.error || 'Unknown error')}`;
        }
      } catch (err) {
        bridgeTestResult.className = 'test-result-box error';
        bridgeTestResult.textContent = `Error: ${err.message}`;
      }
    });
  }

  // Test OBS Connection
  const btnTestObs = document.getElementById('btnTestObsConn');
  const obsTestResult = document.getElementById('obsTestResult');
  if (btnTestObs) {
    btnTestObs.addEventListener('click', async () => {
      obsTestResult.className = 'test-result-box';
      obsTestResult.innerHTML = 'Testing connection to OBS WebSocket...';
      obsTestResult.classList.remove('hidden');

      const address = document.getElementById('cfgObsAddress').value.trim();
      const password = document.getElementById('cfgObsAuth').value;

      try {
        const res = await fetch('/api/test/obs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ obsaddress: address, obsauth: password })
        });
        const data = await res.json();
        if (data.success) {
          const pluginBadge = data.hasSourceSwitcherPlugin
            ? `<span style="color: #06d6a0; font-weight: 600;">Installed & Verified ✅</span>`
            : `<span style="color: var(--text-muted);">Not Installed (Optional)</span>`;

          obsTestResult.className = 'test-result-box success';
          obsTestResult.innerHTML = `
            <strong>Connection Successful!</strong><br>
            Connected to OBS WebSocket at <code>${escapeHtml(address)}</code><br>
            Roundtrip Latency: <strong>${data.latency}ms</strong> | OBS Version: <strong>${escapeHtml(data.obsVersion)}</strong> | Scenes: <strong>${data.scenesCount}</strong><br>
            <small style="margin-top: 4px; display: inline-block;">Source Switcher Plugin: ${pluginBadge}</small>
          `;
        } else {
          obsTestResult.className = 'test-result-box error';
          obsTestResult.innerHTML = `
            <strong>Connection Failed</strong><br>
            ${escapeHtml(data.error)}<br>
            <small>Check that OBS is open and "Tools &rarr; WebSocket Server Settings" is enabled on port 4455.</small>
          `;
        }
      } catch (err) {
        obsTestResult.className = 'test-result-box error';
        obsTestResult.innerHTML = `Error: ${escapeHtml(err.message)}`;
      }
    });
  }

  // Test Google Sheet Connection
  const btnTestSheet = document.getElementById('btnTestSheetConn');
  const sheetTestResult = document.getElementById('sheetTestResult');
  if (btnTestSheet) {
    btnTestSheet.addEventListener('click', async () => {
      sheetTestResult.className = 'test-result-box';
      sheetTestResult.innerHTML = 'Verifying Google Sheets API credentials and tab range...';
      sheetTestResult.classList.remove('hidden');

      const sheetId = document.getElementById('cfgSheetId').value.trim();
      const tabname = document.getElementById('cfgTabName').value.trim();
      const range = document.getElementById('cfgRange').value.trim();
      const apikey = document.getElementById('cfgApiKey').value.trim();
      const dimension = document.getElementById('cfgDimension').value.trim();

      try {
        const res = await fetch('/api/test/sheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheetId, tabname, range, apikey, dimension })
        });
        const data = await res.json();
        if (data.success) {
          sheetTestResult.className = 'test-result-box success';
          sheetTestResult.innerHTML = `
            <strong>Google Sheets Connection Verified!</strong><br>
            Successfully read tab "<strong>${escapeHtml(tabname)}</strong>" (${escapeHtml(range)})<br>
            Response Time: <strong>${data.latency}ms</strong> | Rows Fetched: <strong>${data.rowsCount}</strong>
          `;
        } else {
          sheetTestResult.className = 'test-result-box error';
          sheetTestResult.innerHTML = `
            <strong>Google Sheet Connection Failed</strong><br>
            ${escapeHtml(data.error)}<br>
            <small>Make sure the spreadsheet is shared as "Anyone with link can view" and your Google API key has Google Sheets API enabled.</small>
          `;
        }
      } catch (err) {
        sheetTestResult.className = 'test-result-box error';
        sheetTestResult.innerHTML = `Error: ${escapeHtml(err.message)}`;
      }
    });
  }
}

function parsePollingValue(val) {
  let p = parseInt(val, 10);
  if (!p || isNaN(p)) return 2000;
  if (p > 0 && p <= 60) return p * 1000;
  return Math.max(500, p);
}

function getCurrentFormConfig() {
  const sheetIdEl = document.getElementById('cfgSheetId');
  const tabNameEl = document.getElementById('cfgTabName');
  const rangeEl = document.getElementById('cfgRange');
  const apiKeyEl = document.getElementById('cfgApiKey');
  const obsAddressEl = document.getElementById('cfgObsAddress');
  const obsAuthEl = document.getElementById('cfgObsAuth');
  const pollingEl = document.getElementById('cfgPolling');
  const autoStartEl = document.getElementById('cfgAutoStart');
  const logVisEl = document.getElementById('cfgLogVisibilityOnlyOnChanges');
  const showVisEl = document.getElementById('cfgShowVisibilityLogs');
  const logMissingEl = document.getElementById('cfgLogMissingRowsOnlyOnChanges');
  const showMissingEl = document.getElementById('cfgShowMissingRowLogs');

  return {
    sheetId: sheetIdEl ? sheetIdEl.value.trim() : '',
    tabname: tabNameEl ? tabNameEl.value.trim() : 'Interface',
    range: rangeEl ? rangeEl.value.trim() : 'C2:D',
    apikey: apiKeyEl ? apiKeyEl.value.trim() : '',
    obsaddress: obsAddressEl ? obsAddressEl.value.trim() : 'ws://localhost:4455',
    obsauth: obsAuthEl ? obsAuthEl.value : '',
    polling: pollingEl ? parsePollingValue(pollingEl.value) : 2000,
    autoStart: autoStartEl ? autoStartEl.checked : false,
    logVisibilityOnlyOnChanges: logVisEl ? logVisEl.checked : true,
    showVisibilityLogs: showVisEl ? showVisEl.checked : true,
    logMissingRowsOnlyOnChanges: logMissingEl ? logMissingEl.checked : true,
    showMissingRowLogs: showMissingEl ? showMissingEl.checked : false,
    ...getControlSheetFormConfig()
  };
}

function getControlSheetFormConfig() {
  const out = {};
  const tab = document.getElementById('cfgControlTab');
  const poll = document.getElementById('cfgControlPoll');
  const url = document.getElementById('cfgScriptUrl');
  const token = document.getElementById('cfgScriptToken');
  const lan = document.getElementById('cfgAllowLanDashboard');
  if (tab) out.controlTabName = tab.value.trim() || 'Stream1';
  if (poll) out.controlPollMs = Math.max(2, parseInt(poll.value, 10) || 4) * 1000;
  if (url) out.scriptUrl = url.value.trim();
  if (token) out.scriptToken = token.value.trim();
  if (lan) out.allowLanDashboard = lan.checked;
  return out;
}

function populateControlSheetFields(config) {
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  set('cfgControlTab', el => { el.value = config.controlTabName || 'Stream1'; });
  set('cfgControlPoll', el => { el.value = Math.round((config.controlPollMs || 4000) / 1000); });
  set('cfgScriptUrl', el => { el.value = config.scriptUrl || ''; if (el._checkUrl) el._checkUrl(); });
  set('cfgScriptToken', el => { el.value = config.scriptToken || ''; });
  set('cfgAllowLanDashboard', el => { el.checked = !!config.allowLanDashboard; });
  const box = document.getElementById('bridgeTestResult');
  if (box) box.classList.add('hidden');
}

function populateFormFields(config) {
  const sheetIdEl = document.getElementById('cfgSheetId');
  const tabNameEl = document.getElementById('cfgTabName');
  const rangeEl = document.getElementById('cfgRange');
  const apiKeyEl = document.getElementById('cfgApiKey');
  const obsAddressEl = document.getElementById('cfgObsAddress');
  const obsAuthEl = document.getElementById('cfgObsAuth');
  const pollingEl = document.getElementById('cfgPolling');
  const autoStartEl = document.getElementById('cfgAutoStart');
  const logVisEl = document.getElementById('cfgLogVisibilityOnlyOnChanges');
  const showVisEl = document.getElementById('cfgShowVisibilityLogs');
  const logMissingEl = document.getElementById('cfgLogMissingRowsOnlyOnChanges');
  const showMissingEl = document.getElementById('cfgShowMissingRowLogs');

  if (sheetIdEl) sheetIdEl.value = config.sheetId || '';
  if (tabNameEl) tabNameEl.value = config.tabname || 'Interface';
  if (rangeEl) rangeEl.value = config.range || 'C2:D';
  if (apiKeyEl) apiKeyEl.value = config.apikey || '';
  if (obsAddressEl) obsAddressEl.value = config.obsaddress || 'ws://localhost:4455';
  if (obsAuthEl) obsAuthEl.value = config.obsauth || '';
  if (pollingEl) pollingEl.value = config.polling || 2000;
  if (autoStartEl) autoStartEl.checked = !!config.autoStart;
  if (logVisEl) logVisEl.checked = config.logVisibilityOnlyOnChanges !== false;
  if (showVisEl) showVisEl.checked = config.showVisibilityLogs !== false;
  if (logMissingEl) logMissingEl.checked = config.logMissingRowsOnlyOnChanges !== false;
  if (showMissingEl) showMissingEl.checked = config.showMissingRowLogs === true;
  populateControlSheetFields(config);

  const quickSelect = document.getElementById('quickPollingSelect');
  if (quickSelect) {
    quickSelect.value = String(config.polling || 2000);
  }
}

async function loadInitialConfig() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    
    appState.activeProfile = config.activeProfile || 'Default';
    appState.profilesList = config.profilesList || ['Default'];
    appState.selectedScenes = loadSelectedScenes(appState.activeProfile);

    // Experimental Control Sheet / Web Dashboard: hidden unless switched on (Personalization tab).
    applyExperimentalState(config.experimentalControlSheet === true, config.experimentalForced === true);

    populateProfileDropdowns(appState.profilesList, appState.activeProfile);
    populateFormFields(config);
    updateSceneDropdownUI();

    if (config.permissions && config.permissions.isWritable === false) {
      showPermissionModal(config.permissions);
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

async function loadInitialStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    updateStatusUI(data);
    if (data.sources) renderSourcesTable(data.sources);
    if (data.sheetData) renderSheetGrid(data.sheetData);

    const logRes = await fetch('/api/logs');
    const logs = await logRes.json();
    logs.forEach(l => appendLog(l));
  } catch (err) {
    console.error('Failed to load initial status:', err);
  }
}

async function saveConfig(showFeedback = true) {
  const config = getCurrentFormConfig();

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const result = await res.json();
    if (result.success) {
      if (showFeedback) {
        const seconds = ((result.config?.polling || config.polling) / 1000).toFixed(1);
        showToast(`Profile "${result.config?.activeProfile || appState.activeProfile}" settings saved! (${seconds}s poll)`, 'success');
      }
      const quickSelect = document.getElementById('quickPollingSelect');
      const savedPolling = result.config?.polling || config.polling;
      if (quickSelect) quickSelect.value = String(savedPolling);
      const pollingEl = document.getElementById('cfgPolling');
      if (pollingEl) pollingEl.value = savedPolling;
      return true;
    } else {
      if (result.code === 'WRITE_PERMISSION_DENIED') {
        showPermissionModal(result);
      } else if (showFeedback) {
        showToast(`Failed to save settings: ${result.error}`, 'error');
      }
      return false;
    }
  } catch (err) {
    if (showFeedback) {
      showToast(`Error saving settings: ${err.message}`, 'error');
    }
    return false;
  }
}

/* ==========================================================================
   PERMISSION ERROR MODAL
   ========================================================================== */
function showPermissionModal(errorData) {
  const existing = document.getElementById('permissionErrorModal');
  if (existing) existing.remove();

  const title = errorData?.title || 'Permission Denied: Unable to Save Settings';
  const msg = errorData?.message || errorData?.error || 'Windows prevented the app from writing settings to disk.';
  const solutions = errorData?.solutions || [
    'Right-click SheetsToOBS.exe and select "Run as administrator".',
    'Move the application folder out of "C:\\Program Files" to a user folder (e.g. C:\\SheetsToOBS or Documents).',
    'Right-click the application folder > Properties > Security > Edit > Grant "Full Control" to Users.'
  ];

  const modalHtml = `
    <div id="permissionErrorModal" class="modal-overlay">
      <div class="modal-card" style="border-left: 4px solid var(--danger, #ef4444); max-width: 540px;">
        <div class="modal-header">
          <h3 style="color: var(--danger, #ef4444); display: flex; align-items: center; gap: 8px;">
            <span>⚠️</span> ${escapeHtml(title)}
          </h3>
          <button class="modal-close-btn" data-action="close-permission-modal">&times;</button>
        </div>
        <div class="modal-body" style="padding: 16px;">
          <p style="font-size: 0.9rem; color: var(--text, #f1f5f9); margin-bottom: 12px; line-height: 1.5;">${escapeHtml(msg)}</p>
          <div style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 8px; padding: 12px 16px; margin: 12px 0;">
            <strong style="color: var(--danger, #ef4444); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em;">Recommended Solutions:</strong>
            <ul style="margin: 8px 0 0 16px; padding: 0; line-height: 1.6; font-size: 0.85rem; color: var(--text-muted, #94a3b8);">
              ${solutions.map(s => `<li style="margin-bottom: 4px;">${escapeHtml(s)}</li>`).join('')}
            </ul>
          </div>
        </div>
        <div class="modal-footer" style="padding: 12px 16px; justify-content: flex-end; gap: 8px;">
          <button class="btn btn-primary" data-action="close-permission-modal">Understood</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

/* ==========================================================================
   UTILITY HELPERS
   ========================================================================== */
function escapeHtml(str) {
  if (typeof str === 'number' || typeof str === 'boolean') str = String(str);
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Turns untrusted text (e.g. a sheet "Type" cell) into a safe CSS class fragment. */
function cssToken(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
}

/**
 * All dynamic click/change handlers go through data-action attributes instead of
 * inline onclick="..." so sheet text can never become script, and so the page can
 * run under a strict Content-Security-Policy (script-src 'self').
 */
/** Shows or hides everything that belongs to the experimental Control Sheet. */
function applyExperimentalState(enabled, forced) {
  document.body.classList.toggle('experimental-off', !enabled);
  const box = document.getElementById('chkExperimentalControlSheet');
  if (box) {
    box.checked = enabled;
    box.disabled = !!forced;
  }
  const hint = document.getElementById('experimentalForcedHint');
  if (hint) hint.classList.toggle('hidden', !forced);
}

function initExperimentalToggle() {
  const box = document.getElementById('chkExperimentalControlSheet');
  if (!box) return;
  box.addEventListener('change', async () => {
    const wanted = box.checked;
    try {
      const res = await fetch('/api/settings/experimental', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ controlSheet: wanted })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not save');
      applyExperimentalState(data.experimentalControlSheet === true, data.forcedByEnv === true);
      showToast(data.experimentalControlSheet ? 'Control Sheet (experimental) enabled' : 'Control Sheet disabled', 'success');
    } catch (err) {
      box.checked = !wanted;
      showToast(`Could not change experimental setting: ${err.message}`, 'error');
    }
  });
}

function initDelegatedActions() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    switch (action) {
      case 'copy-name':
        copyExpectedName(el.getAttribute('data-copy') || '', el);
        break;
      case 'open-source-modal':
        openSourceValueModal(parseInt(el.getAttribute('data-index'), 10));
        break;
      case 'open-sheet-modal':
        openSheetRowValueModal(parseInt(el.getAttribute('data-index'), 10));
        break;
      case 'reset-source-filters':
        resetSourceFilters();
        break;
      case 'clear-sheet-search': {
        const f = document.getElementById('filterSheetData');
        if (f) f.value = '';
        renderSheetGrid(appState.sheetData);
        break;
      }
      case 'close-permission-modal': {
        const m = document.getElementById('permissionErrorModal');
        if (m) m.remove();
        break;
      }
      case 'sort-source':
        handleSourceSort(el.getAttribute('data-sort-col'));
        break;
      case 'sort-sheet':
        handleSheetSort(el.getAttribute('data-sort-col'));
        break;
      default:
        break;
    }
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action="toggle-scene"]');
    if (el) toggleSceneSelection(el.getAttribute('data-scene') || '', el.checked);
  });
}

function escapeJs(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

window.copyExpectedName = function (text, btn) {
  if (!text) return;
  const doFeedback = () => {
    if (btn) {
      const origHtml = btn.innerHTML;
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!`;
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = origHtml;
        btn.classList.remove('copied');
      }, 1500);
    }
    showToast(`Copied "${text}" to clipboard!`, 'info');
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(doFeedback).catch(() => {
      fallbackCopy(text, doFeedback);
    });
  } else {
    fallbackCopy(text, doFeedback);
  }
};

function fallbackCopy(text, callback) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    if (callback) callback();
  } catch (e) {
    showToast(`Could not copy: ${e.message}`, 'error');
  }
  document.body.removeChild(textarea);
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

/* ==========================================================================
   FEATURE 1: LIVE SYNC DIFF DRAWER & VALUE TRACKER
   ========================================================================== */
function initLiveDiffPanel() {
  const btnToggle = document.getElementById('btnToggleDiffView');
  const container = document.getElementById('diffItemsContainer');

  if (btnToggle && container) {
    btnToggle.addEventListener('click', () => {
      const isCollapsed = container.classList.toggle('collapsed');
      btnToggle.textContent = isCollapsed ? 'Expand ▼' : 'Collapse ▲';
    });
  }
}

function renderSyncDiffs(diffs, timestamp) {
  const container = document.getElementById('diffItemsContainer');
  const badge = document.getElementById('diffTimeBadge');
  if (!container) return;

  if (timestamp && badge) {
    badge.textContent = `Updated: ${new Date(timestamp).toLocaleTimeString()}`;
  }

  if (!diffs || diffs.length === 0) {
    container.innerHTML = `<div class="diff-empty-msg">No value changes detected in the current session. Click "Sync Now" or update a sheet cell.</div>`;
    return;
  }

  container.innerHTML = diffs.map(d => {
    const timeStr = d.timestamp || '';
    const oldStr = d.oldValue ? `<span class="diff-val-old" title="Previous value: ${escapeHtml(d.oldValue)}">${escapeHtml(d.oldValue)}</span>` : '';
    const newStr = `<span class="diff-val-new" title="New value: ${escapeHtml(d.newValue)}">${escapeHtml(d.newValue || 'Updated')}</span>`;
    const flow = oldStr ? `${oldStr} <span class="diff-arrow">➔</span> ${newStr}` : newStr;

    return `
      <div class="diff-item-row">
        <div class="diff-source-tag" title="${escapeHtml(d.sourceName)}">
          <span style="opacity: 0.6; font-size: 0.65rem;">[${timeStr}]</span> ${escapeHtml(d.sourceName)}
        </div>
        <div class="diff-value-flow">
          ${flow}
        </div>
      </div>
    `;
  }).join('');
}

/* ==========================================================================
   FEATURE 2: SYNC PULSE & ACTIVITY INDICATOR
   ========================================================================== */
let lastSyncEpoch = 0;
let syncTickerTimer = null;

function triggerSyncPulse() {
  const btnSync = document.getElementById('btnSyncNow');
  const header = document.querySelector('.app-header');
  const dot = document.getElementById('diffPulseDot');

  if (btnSync) {
    btnSync.classList.remove('sync-pulse-active');
    void btnSync.offsetWidth; // Trigger reflow
    btnSync.classList.add('sync-pulse-active');
    setTimeout(() => btnSync.classList.remove('sync-pulse-active'), 850);
  }

  if (dot) {
    dot.style.transform = 'scale(1.5)';
    setTimeout(() => dot.style.transform = 'scale(1)', 400);
  }
}

function updateSyncTicker(timestamp) {
  if (timestamp) {
    lastSyncEpoch = typeof timestamp === 'number' ? timestamp : Date.now();
  }
  
  const tickerEl = document.getElementById('syncTimeTicker');
  if (!tickerEl) return;

  const now = Date.now();
  const diffSec = Math.floor((now - (lastSyncEpoch || now)) / 1000);

  if (diffSec <= 2) {
    tickerEl.textContent = 'Sync: Just now';
  } else if (diffSec < 60) {
    tickerEl.textContent = `Sync: ${diffSec}s ago`;
  } else {
    const mins = Math.floor(diffSec / 60);
    tickerEl.textContent = `Sync: ${mins}m ago`;
  }

  if (!syncTickerTimer) {
    syncTickerTimer = setInterval(() => {
      if (lastSyncEpoch > 0) {
        updateSyncTicker();
      }
    }, 1000);
  }
}

/* ==========================================================================
   FEATURE 3: ACCENT COLOR & THEME CUSTOMIZER
   ========================================================================== */
function initThemeCustomizer() {
  // 1. Swatch Buttons
  const swatches = document.querySelectorAll('.btn-theme-swatch');
  swatches.forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      if (color) {
        applyAccentTheme(color, true);
        showToast(`Theme updated to ${btn.querySelector('span:last-child').textContent}`, 'info');
      }
    });
  });

  // 2. Custom Color Picker
  const customPicker = document.getElementById('pickerCustomColor');
  if (customPicker) {
    customPicker.addEventListener('input', (e) => {
      applyAccentTheme(e.target.value, true);
    });
  }

  // 3. Header Theme Button
  const btnHeaderTheme = document.getElementById('btnHeaderTheme');
  if (btnHeaderTheme) {
    btnHeaderTheme.addEventListener('click', () => {
      // Switch to settings tab and scroll to theme section
      switchTab('tabSettings');
      setTimeout(() => {
        const themeGroup = document.querySelector('.theme-selector-group');
        if (themeGroup) {
          themeGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);
    });
  }

  // 4. Load Saved Theme on Boot
  try {
    const saved = localStorage.getItem('sheets_obs_accent');
    if (saved) {
      applyAccentTheme(saved, false);
    } else {
      applyAccentTheme('#06d6a0', false);
    }
  } catch (e) {
    applyAccentTheme('#06d6a0', false);
  }
}

function applyAccentTheme(hexColor, saveToStorage = true) {
  if (!hexColor) hexColor = '#06d6a0';

  let cleanHex = hexColor.replace('#', '').trim();
  if (cleanHex.length === 3) cleanHex = cleanHex.split('').map(c => c + c).join('');
  const r = parseInt(cleanHex.substring(0, 2), 16) || 6;
  const g = parseInt(cleanHex.substring(2, 4), 16) || 214;
  const b = parseInt(cleanHex.substring(4, 6), 16) || 160;

  document.documentElement.style.setProperty('--accent-color', hexColor);
  document.documentElement.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.35)`);
  document.documentElement.style.setProperty('--accent-subtle', `rgba(${r}, ${g}, ${b}, 0.12)`);
  document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);

  document.querySelectorAll('.btn-theme-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color && btn.dataset.color.toLowerCase() === hexColor.toLowerCase());
  });

  const picker = document.getElementById('pickerCustomColor');
  if (picker) picker.value = hexColor;

  if (saveToStorage) {
    try {
      localStorage.setItem('sheets_obs_accent', hexColor);
    } catch (e) {}
  }
}



/* ==========================================================================
   FEATURE 5: WINDOW POSITION & SIZE PERSISTENCE MEMORY
   ========================================================================== */
function initWindowStateAutoSave() {
  let debounceTimeout = null;

  const saveWindowState = () => {
    try {
      const state = {
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth || 580,
        height: window.outerHeight || 680,
        mode: appState.mode || 'simple',
        theme: localStorage.getItem('sheets_obs_accent') || '#06d6a0'
      };

      fetch('/api/window-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      }).catch(() => {});
    } catch (e) {}
  };

  window.addEventListener('resize', () => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(saveWindowState, 500);
  });

  window.addEventListener('beforeunload', saveWindowState);
}

/* ==========================================================================
   PERSONALIZATION & THEME STUDIO
   ========================================================================== */
function initPersonalizationTab() {
  const root = document.documentElement;

  function hexToRgb(hex) {
    const clean = hex.replace('#', '');
    const bigint = parseInt(clean, 16);
    if (isNaN(bigint)) return '6, 214, 160';
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `${r}, ${g}, ${b}`;
  }

  function applyAccentColor(hex, save = true) {
    if (!hex || !hex.startsWith('#') || (hex.length !== 4 && hex.length !== 7)) return;

    root.style.setProperty('--accent-blue', hex);
    root.style.setProperty('--border-focus', hex);
    root.style.setProperty('--badge-text-syncing', hex);
    root.style.setProperty('--accent-rgb', hexToRgb(hex));

    // Update active swatch state
    document.querySelectorAll('.btn-theme-swatch').forEach(swatch => {
      if (swatch.getAttribute('data-color').toLowerCase() === hex.toLowerCase()) {
        swatch.classList.add('active');
      } else {
        swatch.classList.remove('active');
      }
    });

    const picker = document.getElementById('pickerCustomColor');
    const inputHex = document.getElementById('inputCustomHex');
    const previewTag = document.getElementById('previewColorTag');

    if (picker) picker.value = hex;
    if (inputHex) inputHex.value = hex.toUpperCase();
    if (previewTag) previewTag.style.background = hex;

    if (save) {
      localStorage.setItem('sheets_obs_accent', hex);
    }
  }

  function applyBgMode(mode, save = true) {
    if (!mode) return;
    document.body.setAttribute('data-theme-bg', mode);

    document.querySelectorAll('.btn-bg-mode').forEach(btn => {
      if (btn.getAttribute('data-bg') === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    if (save) {
      localStorage.setItem('sheets_obs_bg_mode', mode);
    }
  }

  function applyDensity(density, save = true) {
    if (!density) return;
    document.body.setAttribute('data-density', density);

    document.querySelectorAll('.btn-density').forEach(btn => {
      if (btn.getAttribute('data-density') === density) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    if (save) {
      localStorage.setItem('sheets_obs_density', density);
    }
  }

  function applyDefaultLaunchMode(mode, save = true) {
    if (!mode) return;
    document.querySelectorAll('.btn-default-mode').forEach(btn => {
      if (btn.getAttribute('data-default-mode') === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    if (save) {
      localStorage.setItem('sheets_obs_default_mode', mode);
    }
  }

  // 1. Swatch Button Clicks
  document.querySelectorAll('.btn-theme-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      const color = swatch.getAttribute('data-color');
      applyAccentColor(color, true);
      const name = swatch.querySelector('.swatch-name')?.textContent || color;
      showToast(`Accent theme updated to ${name}`, 'success');
    });
  });

  // 2. Custom Color Picker & Hex Input
  const picker = document.getElementById('pickerCustomColor');
  const inputHex = document.getElementById('inputCustomHex');
  const btnApplyHex = document.getElementById('btnApplyCustomHex');

  if (picker) {
    picker.addEventListener('input', (e) => {
      applyAccentColor(e.target.value, true);
    });
  }

  if (btnApplyHex && inputHex) {
    btnApplyHex.addEventListener('click', () => {
      let val = inputHex.value.trim();
      if (!val.startsWith('#')) val = '#' + val;
      if (/^#[0-9A-Fa-f]{6}$/.test(val) || /^#[0-9A-Fa-f]{3}$/.test(val)) {
        applyAccentColor(val, true);
        showToast(`Custom accent color ${val.toUpperCase()} applied!`, 'success');
      } else {
        showToast('Invalid Hex color code. Example: #06D6A0', 'error');
      }
    });

    inputHex.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        btnApplyHex.click();
      }
    });
  }

  // 3. Background Atmosphere Buttons
  document.querySelectorAll('.btn-bg-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      const bg = btn.getAttribute('data-bg');
      applyBgMode(bg, true);
      const label = btn.querySelector('strong')?.textContent || bg;
      showToast(`Atmosphere updated: ${label}`, 'info');
    });
  });

  // 4. Density Buttons
  document.querySelectorAll('.btn-density').forEach(btn => {
    btn.addEventListener('click', () => {
      const density = btn.getAttribute('data-density');
      applyDensity(density, true);
      showToast(`Layout density set to ${density}`, 'info');
    });
  });

  // 5. Default Launch Mode Buttons
  document.querySelectorAll('.btn-default-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-default-mode');
      applyDefaultLaunchMode(mode, true);
      showToast(`Default launch view set to ${mode}`, 'info');
    });
  });

  // 6. Reset Button
  const btnReset = document.getElementById('btnResetPersonalization');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      applyAccentColor('#06d6a0', true);
      applyBgMode('carbon', true);
      applyDensity('standard', true);
      applyDefaultLaunchMode('simple', true);
      showToast('Personalization preferences reset to defaults.', 'success');
    });
  }

  // 7. Initial Load from LocalStorage
  const savedAccent = localStorage.getItem('sheets_obs_accent') || '#06d6a0';
  const savedBg = localStorage.getItem('sheets_obs_bg_mode') || 'carbon';
  const savedDensity = localStorage.getItem('sheets_obs_density') || 'standard';
  const savedDefaultMode = localStorage.getItem('sheets_obs_default_mode') || 'simple';

  applyAccentColor(savedAccent, false);
  applyBgMode(savedBg, false);
  applyDensity(savedDensity, false);
  applyDefaultLaunchMode(savedDefaultMode, false);
}



