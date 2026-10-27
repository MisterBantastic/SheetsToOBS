/**
 * SheetsToOBS Control Sheet (Web Dashboard)
 *
 * Renders the Stream control tab from control-layout.json, keeps it in sync with
 * the Google Sheet (polling /api/sheet-control/snapshot) and writes operator
 * edits back through /api/sheet-control/write (Apps Script bridge).
 *
 * Everything shown here is real data: nothing is simulated.
 * Sheet values are always rendered with textContent / .value (never innerHTML).
 */
(function () {
  'use strict';

  const SCRIPT_INFO = {
    fetchActiveLeagues: 'Refresh API_Info (tournaments list)',
    fetchAllStats: 'Player / team / champion stats for active leagues',
    refreshShowData: 'Schedule, then every stream\'s live stats (one click during a show)',
    fetchSchedule: 'Schedule + scores of every active league → API_Schedule',
    fetchLiveStatsForStreams: 'Finds each stream\'s match and imports its live stats → API_LiveStats1/2/3',
    auditSheet: 'Health check: lists every #REF!/#N/A cell, marks NEW and FIXED since last check → Audit tab',
    fetchPlayerInfo: 'Rosters, pronouns, Riot IDs + alt accounts → API_PlayerInfo (≈1–3 min)',
    fetchLiveStats: 'Live stats from the link pasted in BANSTATS!AP4 (manual)',
    importChampionDataAndSkins: 'Champion + skin data from CommunityDragon (≈1 min)'
  };
  const CDRAGON = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1';

  const state = {
    layout: null,
    settings: null,
    isLocal: true,
    tab: null,
    mode: 'offline',
    cells: {},
    options: {},
    readAt: null,
    lastError: null,
    controllers: new Map(), // A1 -> [controller]
    focused: new Set(), // A1 currently being edited
    saving: new Set(),
    pollTimer: null,
    pollFailures: 0,
    champions: new Map(), // lower-case name -> { id, name }
    sources: [],
    engineRunning: false,
    edits: [],
    view: 'sheet',
    focusSection: null,
    findQuery: '',
    findEditable: true,
    findApply: null
  };

  // ---------------------------------------------------------------------------
  // Small DOM helpers
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    (children || []).forEach((c) => {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function toast(message, type = 'info') {
    const t = el('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status', text: message });
    $('toasts').appendChild(t);
    setTimeout(() => {
      t.classList.add('toast-out');
      setTimeout(() => t.remove(), 300);
    }, type === 'error' ? 6000 : 3200);
  }

  // Other devices on the network must send the access code shown in the
  // dashboard settings on the SheetsToOBS PC. Kept for this browser tab only.
  function getAccessCode() {
    try { return sessionStorage.getItem('s2o.accessCode') || ''; } catch (e) { return ''; }
  }
  function setAccessCode(code) {
    try { sessionStorage.setItem('s2o.accessCode', code); } catch (e) { /* ignore */ }
  }

  async function api(path, opts = {}, retried = false) {
    const headers = {};
    if (opts.body) headers['Content-Type'] = 'application/json';
    const code = getAccessCode();
    if (code) headers['X-Access-Code'] = code;
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (res.status === 401 && data.code === 'ACCESS_CODE_REQUIRED' && !retried) {
      const entered = window.prompt(`${data.error}\n\nAccess code:`, '');
      if (entered) {
        setAccessCode(entered.trim());
        return api(path, opts, true);
      }
    }
    if (!res.ok || data.success === false) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function canEdit() {
    return state.mode === 'bridge';
  }

  function cellValue(a1) {
    const v = state.cells[a1];
    return v === undefined || v === null ? '' : v;
  }

  // ---------------------------------------------------------------------------
  // Field widgets
  // ---------------------------------------------------------------------------
  function register(a1, controller) {
    if (!state.controllers.has(a1)) state.controllers.set(a1, []);
    state.controllers.get(a1).push(controller);
  }

  function optionList(field) {
    const fromSheet = state.options[field.cell];
    if (Array.isArray(fromSheet) && fromSheet.length) return fromSheet;
    if (Array.isArray(field.options)) return field.options;
    return null;
  }

  function setStatus(wrapper, status, message) {
    wrapper.dataset.status = status || '';
    wrapper.title = message || wrapper.dataset.baseTitle || '';
  }

  function makeField(field, ariaLabel) {
    const a1 = field.cell;
    const wrap = el('div', { class: `field field-${field.type}`, 'data-cell': a1 });
    wrap.dataset.baseTitle = `${state.tab || ''}!${a1}`;
    wrap.title = wrap.dataset.baseTitle;
    const label = ariaLabel || field.label || a1;

    if (field.type === 'readonly') {
      const out = el('output', { class: 'ro', 'aria-label': label });
      wrap.appendChild(out);
      register(a1, { field, wrap, set: (v) => { out.textContent = v === '' ? '—' : String(v); out.classList.toggle('ro-empty', v === ''); } });
      return wrap;
    }

    if (field.type === 'bool') {
      const input = el('input', { type: 'checkbox', class: 'toggle', 'aria-label': label });
      input.addEventListener('change', () => commit(a1, input.checked, wrap, () => { input.checked = !input.checked; }));
      wrap.appendChild(input);
      register(a1, {
        field, wrap, input,
        set: (v) => { input.checked = v === true; },
        enable: (on) => { input.disabled = !on; }
      });
      return wrap;
    }

    if (field.type === 'select') {
      const select = el('select', { class: 'input', 'aria-label': label });
      const fill = (current) => {
        const opts = optionList(field) || [];
        const list = opts.slice();
        const cur = String(current);
        if (cur !== '' && !list.includes(cur)) list.unshift(cur);
        const sig = list.join('\u0001');
        if (select.dataset.sig !== sig) {
          select.textContent = '';
          select.appendChild(el('option', { value: '', text: '—' }));
          list.forEach((o) => select.appendChild(el('option', { value: o, text: o })));
          select.dataset.sig = sig;
        }
        select.value = cur;
        // Flag a value the sheet's own list no longer offers (e.g. a team from the
        // previous league after B3 changed) instead of silently showing it.
        const known = Array.isArray(state.options[field.cell]) && state.options[field.cell].length > 0;
        const stale = known && cur !== '' && !state.options[field.cell].includes(cur);
        if (!['saving', 'error'].includes(wrap.dataset.status)) {
          if (stale) setStatus(wrap, 'warn', `"${cur}" is not in the sheet's list any more. Pick a new value.`);
          else if (wrap.dataset.status === 'warn') setStatus(wrap, '');
        }
        select.classList.toggle('not-in-list', stale);
      };
      select.addEventListener('focus', () => state.focused.add(a1));
      select.addEventListener('blur', () => state.focused.delete(a1));
      select.addEventListener('change', () => {
        const prev = cellValue(a1);
        commit(a1, select.value, wrap, () => { select.value = String(prev); });
      });
      wrap.appendChild(select);
      register(a1, {
        field, wrap, input: select,
        set: (v) => fill(v),
        enable: (on) => { select.disabled = !on; }
      });
      return wrap;
    }

    // text / url / textarea / champion
    const isArea = field.type === 'textarea';
    const input = isArea
      ? el('textarea', { class: 'input', rows: 2, 'aria-label': label, spellcheck: 'false' })
      : el('input', {
          class: 'input', type: 'text', 'aria-label': label, spellcheck: 'false',
          list: field.type === 'champion' ? 'championList' : null
        });
    let icon = null;
    let link = null;
    if (field.type === 'champion') {
      icon = el('img', { class: 'champ-icon', alt: '', loading: 'lazy' });
      wrap.appendChild(icon);
    }
    wrap.appendChild(input);
    if (field.type === 'url') {
      link = el('a', { class: 'open-link', target: '_blank', rel: 'noopener noreferrer', title: 'Open link', text: '↗' });
      wrap.appendChild(link);
    }

    const refreshDecor = (v) => {
      if (icon) {
        const champ = state.champions.get(String(v).trim().toLowerCase());
        if (champ) { icon.src = `${CDRAGON}/champion-icons/${champ.id}.png`; icon.hidden = false; } else { icon.removeAttribute('src'); icon.hidden = true; }
      }
      if (link) {
        const ok = /^https?:\/\//i.test(String(v));
        if (ok) link.href = String(v); else link.removeAttribute('href');
        link.classList.toggle('disabled', !ok);
      }
    };

    const save = () => {
      const prev = String(cellValue(a1));
      const next = input.value;
      if (next === prev) { wrap.classList.remove('dirty'); return; }
      if (field.type === 'champion' && next && state.champions.size && !state.champions.has(next.trim().toLowerCase())) {
        setStatus(wrap, 'warn', 'Not a known champion name: the sheet lookup may show nothing.');
      }
      commit(a1, next, wrap, () => { input.value = prev; refreshDecor(prev); });
    };
    input.addEventListener('focus', () => state.focused.add(a1));
    input.addEventListener('input', () => {
      wrap.classList.toggle('dirty', input.value !== String(cellValue(a1)));
      refreshDecor(input.value);
    });
    input.addEventListener('blur', () => { state.focused.delete(a1); save(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!isArea || e.ctrlKey || e.metaKey)) { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') {
        input.value = String(cellValue(a1));
        wrap.classList.remove('dirty');
        refreshDecor(input.value);
        input.blur();
      }
    });
    register(a1, {
      field, wrap, input,
      set: (v) => { input.value = String(v); refreshDecor(v); },
      enable: (on) => { input.readOnly = !on; input.classList.toggle('is-readonly', !on); }
    });
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------
  async function commit(a1, value, wrap, revert) {
    if (!canEdit()) {
      revert();
      toast('Read-only mode: connect the Apps Script bridge (⚙) to edit the sheet.', 'warn');
      return;
    }
    const expect = state.cells[a1];
    state.saving.add(a1);
    setStatus(wrap, 'saving', 'Saving…');
    try {
      const res = await api('/api/sheet-control/write', {
        method: 'POST',
        body: { tab: state.tab, updates: [{ cell: a1, value, expect: expect === undefined ? undefined : String(expect) }] }
      });
      const skipped = (res.skipped || [])[0];
      if (skipped) {
        revert();
        if (skipped.reason === 'conflict') {
          setStatus(wrap, 'error', 'Someone changed this cell in the sheet. Showing the latest value.');
          toast(`${a1} was changed in the sheet meanwhile. Not overwritten; reloaded the latest value.`, 'warn');
        } else if (skipped.reason === 'formula') {
          setStatus(wrap, 'error', 'This cell holds a formula in the sheet and was not overwritten.');
          toast(`${a1} holds a formula in the sheet, so it was not overwritten.`, 'warn');
        } else {
          setStatus(wrap, 'error', skipped.reason);
        }
        refresh({ fresh: true });
        return;
      }
      state.cells[a1] = value;
      lastWriteAt = Date.now();
      wrap.classList.remove('dirty');
      setStatus(wrap, 'saved', 'Saved to sheet');
      setTimeout(() => { if (wrap.dataset.status === 'saved') setStatus(wrap, ''); }, 1600);
      logEdit(a1, value);
      // Formula cells (sides, codes, stats…) and dependent dropdown lists
      // (league -> teams, team -> subs, champion -> skins) follow the edit: re-read both.
      refresh({ fresh: true, withOptions: true });
    } catch (err) {
      revert();
      setStatus(wrap, 'error', err.message);
      toast(`Could not save ${a1}: ${err.message}`, 'error');
    } finally {
      state.saving.delete(a1);
    }
  }

  function labelFor(a1) {
    const ctrl = (state.controllers.get(a1) || [])[0];
    const input = ctrl && (ctrl.input || ctrl.wrap.querySelector('[aria-label]'));
    return (input && input.getAttribute('aria-label')) || a1;
  }

  function logEdit(a1, value) {
    state.edits.unshift({ a1, value, at: new Date(), label: labelFor(a1) });
    state.edits = state.edits.slice(0, 25);
    const list = $('editLog');
    list.textContent = '';
    state.edits.forEach((e) => {
      list.appendChild(el('li', null, [
        el('span', { class: 'edit-time', text: e.at.toLocaleTimeString() }),
        el('span', { class: 'edit-label', text: e.label }),
        el('span', { class: 'edit-val', text: typeof e.value === 'boolean' ? (e.value ? 'ON' : 'OFF') : (String(e.value) || '(empty)') })
      ]));
    });
  }

  // ---------------------------------------------------------------------------
  // Rendering the layout
  // ---------------------------------------------------------------------------
  // The same live data can be shown four ways. Every view is built from
  // control-layout.json and shares the same widgets, saving and conflict checks.
  const VIEWS = {
    sheet: { label: 'Sheet', hint: 'Every section, laid out like the Stream tab' },
    board: { label: 'Switchboard', hint: 'Big on-air toggles and the live essentials on one screen' },
    focus: { label: 'Focus', hint: 'One section at a time, no scrolling between sections' },
    find: { label: 'Find', hint: 'Every cell in a searchable list' }
  };

  function renderLayout() {
    state.controllers.clear();
    const root = $('sections');
    root.textContent = '';
    root.className = `sections view-${state.view}`;
    const ribbon = $('ribbon');
    ribbon.textContent = '';
    ribbon.classList.toggle('hidden', state.view === 'board' || state.view === 'find');
    document.querySelectorAll('.view-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
    ({ sheet: renderSheetView, board: renderBoardView, focus: renderFocusView, find: renderFindView }[state.view] || renderSheetView)(root, ribbon);
  }

  function renderSection(section) {
    const sec = el('section', { class: `sheet-section sec-${section.color}`, id: `sec-${section.id}` });
    sec.appendChild(el('header', { class: 'section-head' }, [
      el('h2', { text: section.title }),
      section.note ? el('p', { class: 'section-note', text: section.note }) : null,
      el('span', { class: 'section-ref', text: `${state.tab}!${section.range}`, 'data-range': section.range })
    ]));
    const body = el('div', { class: 'section-body' });
    section.groups.forEach((g) => body.appendChild(renderGroup(g)));
    sec.appendChild(body);
    return sec;
  }

  // View 1: Sheet. All sections in sheet order, ribbon jumps between them.
  function renderSheetView(root, ribbon) {
    state.layout.sections.forEach((section) => {
      ribbon.appendChild(el('a', { class: `chip chip-${section.color}`, href: `#sec-${section.id}`, text: section.title }));
      root.appendChild(renderSection(section));
    });
  }

  // View 2: Focus. The ribbon becomes tabs; only the chosen section is shown.
  function renderFocusView(root, ribbon) {
    const ids = state.layout.sections.map((s) => s.id);
    if (!ids.includes(state.focusSection)) state.focusSection = ids[0];
    state.layout.sections.forEach((section, i) => {
      ribbon.appendChild(el('button', {
        class: `chip chip-${section.color}${section.id === state.focusSection ? ' chip-active' : ''}`,
        type: 'button',
        title: `Shortcut: ${i + 1}`,
        'aria-pressed': String(section.id === state.focusSection),
        onclick: () => { state.focusSection = section.id; savePref('focus', section.id); renderLayout(); applySnapshot(); },
        text: `${i + 1}. ${section.title}`
      }));
    });
    const section = state.layout.sections.find((s) => s.id === state.focusSection);
    root.appendChild(renderSection(section));
  }

  // Walks the layout and returns every field with a readable label + where it lives.
  function fieldCatalog() {
    const out = [];
    const push = (field, section, group, label) => out.push({ field, section, group, label });
    state.layout.sections.forEach((section) => {
      section.groups.forEach((group) => {
        if (group.toggle) push(group.toggle, section, group, `${group.title}: ${group.toggle.label || 'On'}`);
        if (group.kind === 'fields') group.fields.forEach((f) => push(f, section, group, f.label || f.cell));
        if (group.kind === 'scoreboard') {
          ['team1', 'team2'].forEach((k, i) => {
            const t = group[k];
            push(t.name, section, group, t.name.label);
            push(t.code, section, group, `Team ${i ? 'two' : 'one'} code`);
            push(t.score, section, group, `Team ${i ? 'two' : 'one'} score`);
          });
        }
        if (group.meta) group.meta.forEach((f) => push(f, section, group, `${group.title}: ${f.label}`));
        if (group.kind === 'table') {
          const cols = group.columns.map((c) => (typeof c === 'string' ? c : c.label));
          group.rows.forEach((row) => {
            const rowName = row[0] && row[0].static !== undefined ? row[0].static : '';
            row.forEach((cell, i) => {
              if (cell && cell.cell) push(cell, section, group, [group.title, rowName, cols[i]].filter(Boolean).join(' · '));
            });
          });
        }
      });
    });
    return out;
  }

  // A big on/off tile for a checkbox cell (Switchboard view).
  function makeTile(entry) {
    const { field, section, label } = entry;
    const a1 = field.cell;
    const btn = el('button', { type: 'button', class: `tile sec-${section.color}`, 'aria-pressed': 'false', 'data-cell': a1, 'aria-label': label });
    const name = el('span', { class: 'tile-label', text: label.replace(/: (On air|Show|Use|Override|Section on|Enabled)$/i, '') });
    const where = el('span', { class: 'tile-where', text: section.title });
    const stateEl = el('span', { class: 'tile-state', text: 'OFF' });
    btn.append(stateEl, name, where);
    const wrap = el('div', { class: 'field field-tile', 'data-cell': a1 }, [btn]);
    wrap.dataset.baseTitle = `${state.tab}!${a1}`;
    const set = (v) => {
      const on = v === true;
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('on', on);
      stateEl.textContent = on ? 'ON' : 'OFF';
    };
    btn.addEventListener('click', () => {
      const next = !(cellValue(a1) === true);
      set(next);
      commit(a1, next, wrap, () => set(cellValue(a1) === true));
    });
    register(a1, { field, wrap, input: btn, set, enable: (on) => { btn.disabled = !on; } });
    return wrap;
  }

  // View 3: Switchboard. What an operator touches during a live show.
  function renderBoardView(root) {
    const catalog = fieldCatalog();
    const find = (a1) => catalog.find((e) => e.field.cell === a1);
    const match = state.layout.sections.find((s) => s.id === 'match');
    const scoreboard = match && match.groups.find((g) => g.kind === 'scoreboard');

    const top = el('div', { class: 'board-top' });
    if (scoreboard) top.appendChild(el('div', { class: 'group group-scoreboard board-score' }, [renderScoreboard(scoreboard)]));
    const essentials = el('div', { class: 'group board-essentials' }, [el('div', { class: 'group-head' }, [el('h3', { text: 'Live essentials' })])]);
    const grid = el('div', { class: 'field-grid' });
    ['B3', 'F39', 'F40', 'X41', 'N75', 'N78', 'P81'].forEach((a1) => {
      const e = find(a1);
      if (e) grid.appendChild(el('label', { class: 'field-cell' }, [el('span', { class: 'field-label', text: e.label }), makeField(e.field, e.label)]));
    });
    essentials.appendChild(grid);
    top.appendChild(essentials);
    root.appendChild(top);

    // Every checkbox on the tab, grouped by sheet section, as large tiles.
    const tiles = catalog.filter((e) => e.field.type === 'bool');
    const bySection = new Map();
    tiles.forEach((e) => {
      if (!bySection.has(e.section)) bySection.set(e.section, []);
      bySection.get(e.section).push(e);
    });
    for (const [section, list] of bySection) {
      const box = el('section', { class: `board-section sec-${section.color}` }, [
        el('h2', { class: 'board-title', text: `${section.title}` }),
        el('div', { class: 'tile-grid' }, list.map(makeTile))
      ]);
      root.appendChild(box);
    }

    const msg = ['E76', 'E77'].map(find).filter(Boolean);
    if (msg.length) {
      const g = el('div', { class: 'group board-ragebait' }, [el('div', { class: 'group-head' }, [el('h3', { text: 'Ragebait message' })])]);
      const fg = el('div', { class: 'field-grid' });
      msg.forEach((e) => fg.appendChild(el('label', { class: `field-cell${e.field.type === 'textarea' ? ' wide' : ''}` }, [el('span', { class: 'field-label', text: e.field.label || e.label }), makeField(e.field, e.label)])));
      g.appendChild(fg);
      root.appendChild(g);
    }
  }

  // View 4: Find. Every cell as one searchable list.
  function renderFindView(root) {
    const catalog = fieldCatalog();
    const bar = el('div', { class: 'find-bar' });
    const q = el('input', { class: 'input find-input', type: 'search', placeholder: 'Search label, cell or value… (e.g. "skin", "Q97", "Ahri")', 'aria-label': 'Search cells', value: state.findQuery || '' });
    const onlyEditable = el('input', { type: 'checkbox', id: 'findEditable' });
    onlyEditable.checked = state.findEditable !== false;
    const count = el('span', { class: 'muted find-count' });
    bar.append(q, el('label', { class: 'find-opt' }, [onlyEditable, el('span', { text: 'Editable only' })]), count);
    root.appendChild(bar);

    const table = el('table', { class: 'grid-table find-table' });
    table.appendChild(el('thead', null, [el('tr', null, ['Section', 'Field', 'Cell', 'Value'].map((h) => el('th', { scope: 'col', text: h })))]));
    const tbody = el('tbody');
    const rows = catalog.map((e) => {
      const tr = el('tr', { class: `sec-${e.section.color}` }, [
        el('td', null, [el('span', { class: 'find-sec', text: e.section.title })]),
        el('td', { class: 'find-label', text: e.label }),
        el('td', null, [el('code', { class: 'find-cell', text: e.field.cell })]),
        el('td', { class: 'find-value' }, [makeField(e.field, e.label)])
      ]);
      tbody.appendChild(tr);
      return { tr, e, text: `${e.section.title} ${e.label} ${e.field.cell}`.toLowerCase() };
    });
    table.appendChild(tbody);
    root.appendChild(el('div', { class: 'table-scroll find-wrap' }, [table]));

    const apply = () => {
      state.findQuery = q.value;
      state.findEditable = onlyEditable.checked;
      const term = q.value.trim().toLowerCase();
      let shown = 0;
      rows.forEach(({ tr, e, text }) => {
        const val = String(cellValue(e.field.cell)).toLowerCase();
        const ok = (!onlyEditable.checked || e.field.type !== 'readonly') && (!term || text.includes(term) || val.includes(term));
        tr.hidden = !ok;
        if (ok) shown++;
      });
      count.textContent = `${shown} of ${rows.length} cells`;
    };
    state.findApply = apply;
    q.addEventListener('input', apply);
    onlyEditable.addEventListener('change', apply);
    apply();
    setTimeout(() => q.focus(), 0);
  }

  function savePref(key, value) {
    try { localStorage.setItem(`s2o.dashboard.${key}`, value); } catch (e) { /* ignore */ }
  }
  function loadPref(key) {
    try { return localStorage.getItem(`s2o.dashboard.${key}`); } catch (e) { return null; }
  }

  function setView(view) {
    if (!VIEWS[view] || view === state.view) return;
    state.view = view;
    savePref('view', view);
    renderLayout();
    applySnapshot();
    window.scrollTo(0, 0);
  }

  function groupHeader(group) {
    const head = el('div', { class: 'group-head' }, [el('h3', { text: group.title })]);
    if (group.toggle) {
      const t = makeField(group.toggle, `${group.title}: ${group.toggle.label || 'on'}`);
      head.appendChild(el('label', { class: 'group-toggle' }, [t, el('span', { text: group.toggle.label || 'On' })]));
    }
    return head;
  }

  function renderGroup(group) {
    const card = el('div', { class: `group group-${group.kind}${group.accent ? ' accent-' + group.accent : ''}` });
    card.appendChild(groupHeader(group));

    if (group.kind === 'fields') {
      const grid = el('div', { class: 'field-grid' });
      group.fields.forEach((f) => {
        grid.appendChild(el('label', { class: `field-cell${f.type === 'textarea' ? ' wide' : ''}` }, [
          el('span', { class: 'field-label', text: f.label || f.cell }),
          makeField(f, f.label),
          f.hint ? el('span', { class: 'field-hint', text: f.hint }) : null
        ]));
      });
      card.appendChild(grid);
    } else if (group.kind === 'scoreboard') {
      card.appendChild(renderScoreboard(group));
    } else if (group.kind === 'table') {
      if (group.meta) {
        const meta = el('div', { class: 'meta-row' });
        group.meta.forEach((f) => meta.appendChild(el('div', { class: 'meta-item' }, [el('span', { class: 'field-label', text: f.label }), makeField(f, f.label)])));
        card.appendChild(meta);
      }
      card.appendChild(renderTable(group));
    }
    return card;
  }

  function renderTable(group) {
    const table = el('table', { class: 'grid-table' });
    const headRow = el('tr');
    const colNames = group.columns.map((c) => (typeof c === 'string' ? c : c.label));
    group.columns.forEach((c) => {
      const th = el('th', { scope: 'col' });
      if (typeof c === 'object' && c.cell) {
        const span = el('span', { class: 'th-cell', text: c.label });
        register(c.cell, { field: { cell: c.cell, type: 'header' }, wrap: th, set: (v) => { span.textContent = v ? String(v) : c.label; } });
        th.appendChild(span);
      } else {
        th.textContent = typeof c === 'string' ? c : c.label;
      }
      headRow.appendChild(th);
    });
    table.appendChild(el('thead', null, [headRow]));

    const tbody = el('tbody');
    group.rows.forEach((row) => {
      const tr = el('tr');
      const rowName = row[0] && row[0].static ? row[0].static : '';
      row.forEach((cell, i) => {
        if (cell && cell.static !== undefined) {
          tr.appendChild(el('th', { scope: 'row', class: 'row-head', text: cell.static }));
        } else if (cell && cell.cell) {
          tr.appendChild(el('td', null, [makeField(cell, `${group.title} ${rowName} ${colNames[i] || ''}`.trim())]));
        } else {
          tr.appendChild(el('td'));
        }
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return el('div', { class: 'table-scroll' }, [table]);
  }

  function renderScoreboard(group) {
    const board = el('div', { class: 'scoreboard' });
    const team = (t, side) => {
      const scoreField = t.score;
      const display = el('output', { class: 'score-num', 'aria-live': 'polite' });
      const hidden = makeField(scoreField, `${side} score`);
      hidden.classList.add('score-select');
      const step = (delta) => {
        const opts = optionList(scoreField) || ['0', '1', '2', '3', '4', '5'];
        const cur = parseInt(cellValue(scoreField.cell), 10) || 0;
        const next = String(Math.min(Math.max(cur + delta, parseInt(opts[0], 10) || 0), parseInt(opts[opts.length - 1], 10) || 5));
        if (next === String(cellValue(scoreField.cell))) return;
        commit(scoreField.cell, next, hidden, () => display.textContent = String(cellValue(scoreField.cell) || 0));
        display.textContent = next;
      };
      register(scoreField.cell, { field: scoreField, wrap: display, set: (v) => { display.textContent = v === '' ? '0' : String(v); } });
      const minus = el('button', { class: 'btn btn-step', 'aria-label': `${side} score minus one`, onclick: () => step(-1), text: '−' });
      const plus = el('button', { class: 'btn btn-step', 'aria-label': `${side} score plus one`, onclick: () => step(1), text: '+' });
      register(scoreField.cell + '#steppers', { field: { type: 'stepper' }, wrap: board, set: () => {}, enable: (on) => { minus.disabled = !on; plus.disabled = !on; } });
      return el('div', { class: `team team-${side}` }, [
        el('div', { class: 'team-name' }, [el('span', { class: 'field-label', text: t.name.label }), makeField(t.name, t.name.label)]),
        el('div', { class: 'team-code' }, [makeField(t.code, `${t.name.label} code`)]),
        el('div', { class: 'score-ctl' }, [minus, display, plus]),
        hidden
      ]);
    };
    board.appendChild(team(group.team1, 'one'));
    board.appendChild(el('div', { class: 'vs', text: 'vs' }));
    board.appendChild(team(group.team2, 'two'));
    return board;
  }

  // ---------------------------------------------------------------------------
  // Applying data
  // ---------------------------------------------------------------------------
  function applySnapshot() {
    const editable = canEdit();
    for (const [a1, ctrls] of state.controllers) {
      const baseCell = a1.split('#')[0];
      ctrls.forEach((c) => {
        if (c.enable) c.enable(editable);
        if (state.focused.has(baseCell) || state.saving.has(baseCell)) return;
        if (c.wrap.classList && c.wrap.classList.contains('dirty')) return;
        if (c.field.type === 'stepper') return;
        c.set(cellValue(baseCell));
      });
    }
    document.querySelectorAll('.section-ref').forEach((n) => { n.textContent = `${state.tab}!${n.dataset.range}`; });
    if (state.view === 'find' && state.findApply) state.findApply();
    // Datalist for champion inputs (sheet validation list wins, CDragon as fallback)
    const champCell = Object.keys(state.options).find((k) => {
      const ctrl = (state.controllers.get(k) || [])[0];
      return ctrl && ctrl.field.type === 'champion' && Array.isArray(state.options[k]);
    });
    const names = champCell ? state.options[champCell] : Array.from(state.champions.values()).map((c) => c.name);
    const dl = $('championList');
    if (dl.dataset.count !== String(names.length)) {
      dl.textContent = '';
      names.forEach((n) => dl.appendChild(el('option', { value: n })));
      dl.dataset.count = String(names.length);
    }
  }

  function updateModeUi() {
    const badge = $('modeBadge');
    const labels = {
      bridge: ['LIVE · READ/WRITE', 'Connected through the Apps Script bridge. Edits are written to the sheet.'],
      readonly: ['READ-ONLY', 'Reading with the Sheets API key. Connect the Apps Script bridge to edit.'],
      offline: ['OFFLINE', 'No Google Sheet connection configured.']
    };
    const [text, title] = labels[state.mode] || labels.offline;
    badge.textContent = text;
    badge.title = title;
    badge.className = `mode-badge mode-${state.mode}`;
    document.body.classList.toggle('is-readonly', state.mode !== 'bridge');

    const banner = $('banner');
    if (state.lastError) {
      banner.className = 'banner banner-error';
      banner.textContent = '';
      banner.appendChild(el('span', { text: `Can't read the sheet: ${state.lastError}` }));
      if (state.isLocal) banner.appendChild(el('button', { class: 'btn btn-xs', onclick: openDrawer, text: 'Connection settings' }));
    } else if (state.mode === 'bridge' && state.bridgeOutdated) {
      banner.className = 'banner banner-error';
      banner.textContent = '';
      banner.appendChild(el('span', {
        text: `The Apps Script bridge on this sheet is out of date (v${state.bridgeVersion || '1.0.0'}): dropdown lists can be up to 10 minutes stale (e.g. teams not following the league). ` +
          'Paste the new apps-script/WebApp.gs, then Deploy › Manage deployments › ✏️ › Version: New version › Deploy.'
      }));
    } else if (state.mode === 'readonly') {
      banner.className = 'banner banner-info';
      banner.textContent = '';
      banner.appendChild(el('span', { text: 'Read-only: values are live from the sheet, but edits need the Apps Script bridge.' }));
      if (state.isLocal) banner.appendChild(el('button', { class: 'btn btn-xs', onclick: openDrawer, text: 'Set up editing' }));
    } else {
      banner.className = 'banner hidden';
    }

    const scriptsOk = state.mode === 'bridge' && state.isLocal;
    $('scriptsHint').textContent = scriptsOk
      ? 'Runs the function inside your sheet (same as running it in the Apps Script editor).'
      : (state.isLocal ? 'Needs the Apps Script bridge.' : 'Only available on the SheetsToOBS PC.');
    document.querySelectorAll('.btn-run').forEach((b) => { b.disabled = !scriptsOk || b.classList.contains('running'); });
    updateLiveStatsButton();
  }

  function updateFreshness() {
    const f = $('freshness');
    if (!state.readAt) { f.textContent = '—'; return; }
    const secs = Math.round((Date.now() - state.readAt) / 1000);
    f.textContent = secs < 2 ? 'just read' : `read ${secs}s ago`;
    // Apps Script calls take 1-3 s on their own, so allow a generous margin before warning.
    const stale = secs * 1000 > Math.max((state.settings ? state.settings.pollMs : 4000) * 3, 20000);
    f.classList.toggle('stale', stale);
    f.title = stale ? 'The sheet has not been read recently. Check the connection.' : 'Time since the sheet was last read';
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------
  // One in-flight read at a time per "kind"; responses that arrive out of order
  // (an older poll finishing after a newer read) are ignored.
  let refreshing = null; // { promise, options, startedAt }
  let refreshSeq = 0;
  let appliedSeq = 0;
  let lastWriteAt = 0;
  async function refresh({ fresh = false, withOptions = false } = {}) {
    if (refreshing && refreshing.startedAt >= lastWriteAt && (refreshing.options || !withOptions)) {
      return refreshing.promise; // an equal or better read is already on its way
    }
    const seq = ++refreshSeq;
    if (withOptions) document.body.classList.add('lists-updating');
    const run = (async () => {
      try {
        const q = new URLSearchParams({ tab: state.tab });
        if (fresh) q.set('fresh', '1');
        if (withOptions) q.set('options', '1');
        const data = await api(`/api/sheet-control/snapshot?${q}`);
        if (state.settings && data.profile !== undefined && data.profile !== state.settings.profile) {
          // The active profile was switched in the main app: reload connection + layout.
          toast(`Profile switched to "${data.profile}"`, 'warn');
          setTimeout(() => loadLayout(true), 0); // not awaited: avoids waiting on this same read
          return;
        }
        if (data.tab !== state.tab || seq < appliedSeq) return;
        appliedSeq = seq;
        state.cells = data.cells || {};
        if (data.options && Object.keys(data.options).length) state.options = data.options;
        state.mode = data.mode;
        state.bridgeVersion = data.bridgeVersion;
        state.bridgeOutdated = !!data.bridgeOutdated;
        state.readAt = Date.now();
        state.lastError = null;
        state.pollFailures = 0;
        applySnapshot();
        if (state.metaBase) $('sheetMeta').textContent = state.metaBase + (data.bridgeVersion ? ` · bridge v${data.bridgeVersion}` : '');
      } catch (err) {
        state.lastError = err.message;
        state.pollFailures++;
        if (state.settings) state.mode = state.settings.mode;
      } finally {
        updateModeUi();
        updateFreshness();
      }
    })();
    const entry = { promise: run, options: withOptions, startedAt: Date.now() };
    refreshing = entry;
    try {
      await run;
    } finally {
      if (refreshing === entry) refreshing = null;
      if (withOptions && (!refreshing || !refreshing.options)) document.body.classList.remove('lists-updating');
    }
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    const base = state.settings ? state.settings.pollMs : 4000;
    const backoff = Math.min(60000, base * Math.pow(2, Math.min(state.pollFailures, 4)));
    const delay = document.hidden ? Math.max(backoff, base * 3) : backoff;
    state.pollTimer = setTimeout(async () => {
      if (state.settings && state.settings.mode !== 'offline') await refresh();
      schedulePoll();
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Engine status, sources, log (SSE)
  // ---------------------------------------------------------------------------
  function setPill(id, valId, cls, text) {
    $(id).className = `pill ${cls}`;
    $(valId).textContent = text;
  }

  function onStatus(s) {
    if (!s) return;
    const obs = s.obs || {};
    const obsText = obs.state === 'connected' ? `${obs.latency || 0}ms` : (obs.state || 'off');
    setPill('pillObs', 'obsVal', obs.state === 'connected' ? 'ok' : (obs.state === 'error' ? 'bad' : 'idle'), obsText);
    state.engineRunning = !!s.running;
    setPill('pillEngine', 'engineVal', s.running ? (s.simulation ? 'warn' : 'ok') : 'idle', s.running ? (s.simulation ? 'demo' : 'running') : 'stopped');
    const btn = $('btnEngine');
    btn.textContent = s.running ? 'Stop engine' : 'Start engine';
    btn.classList.toggle('is-running', !!s.running);
  }

  function renderSources() {
    const list = $('srcList');
    const q = $('srcFilter').value.trim().toLowerCase();
    const rows = state.sources.filter((s) => !q || `${s.sourceName} ${s.sceneName} ${s.cleanValue}`.toLowerCase().includes(q));
    $('srcCount').textContent = String(state.sources.length);
    list.textContent = '';
    if (!state.sources.length) {
      list.appendChild(el('div', { class: 'muted', text: 'Start the sync engine to see mapped sources.' }));
      return;
    }
    rows.slice(0, 300).forEach((s) => {
      list.appendChild(el('div', { class: `src src-${s.syncStatus || 'idle'}`, title: s.error || s.warning || '' }, [
        el('span', { class: `vis ${s.sceneItemEnabled === false ? 'off' : 'on'}`, title: s.sceneItemEnabled === false ? 'Hidden in OBS' : 'Visible in OBS' }),
        el('span', { class: 'src-name', text: s.sourceName }),
        el('span', { class: 'src-type', text: s.sourceType }),
        el('span', { class: 'src-val', text: s.cleanValue || '' })
      ]));
    });
  }

  function addLog(entry) {
    const log = $('log');
    const level = (entry.level || 'info').toLowerCase();
    const line = el('div', { class: `log-line lvl-${level}` }, [
      el('span', { class: 'log-time', text: entry.timestamp || new Date().toLocaleTimeString() }),
      el('span', { class: 'log-msg', text: entry.message || '' })
    ]);
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.appendChild(line);
    while (log.childElementCount > 250) log.firstChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function connectEvents() {
    if (!window.EventSource) return;
    const code = getAccessCode();
    const es = new EventSource(code ? `/api/events?code=${encodeURIComponent(code)}` : '/api/events');
    es.addEventListener('status', (e) => { try { onStatus(JSON.parse(e.data)); } catch (err) { /* ignore */ } });
    es.addEventListener('log', (e) => { try { addLog(JSON.parse(e.data)); } catch (err) { /* ignore */ } });
    es.addEventListener('sources:mapped', (e) => {
      try { state.sources = JSON.parse(e.data) || []; renderSources(); } catch (err) { /* ignore */ }
    });
    es.addEventListener('control:changed', (e) => {
      try {
        const msg = JSON.parse(e.data);
        // Our own saves already trigger a re-read; only react to other operators' edits.
        if (msg.tab !== state.tab || state.saving.size || Date.now() - lastWriteAt < 1500) return;
        refresh({ fresh: true, withOptions: true });
      } catch (err) { /* ignore */ }
    });
    setInterval(() => { fetch('/api/heartbeat').catch(() => {}); }, 15000);
  }

  // ---------------------------------------------------------------------------
  // Apps Script runner
  // ---------------------------------------------------------------------------
  function renderScripts(runnable) {
    const list = $('scriptList');
    list.textContent = '';
    runnable.forEach((fn) => {
      const btn = el('button', { class: 'btn btn-run', 'data-fn': fn }, [
        el('span', { class: 'fn', text: `${fn}()` }),
        el('span', { class: 'fn-desc', text: SCRIPT_INFO[fn] || '' })
      ]);
      btn.addEventListener('click', async () => {
        if (fn === 'fetchPlayerInfo' && !window.confirm('Rebuild API_PlayerInfo now? It reads every player profile and can take 1–3 minutes.')) return;
        if (fn === 'importChampionDataAndSkins' && !window.confirm('Re-import all champion and skin data now? It takes about a minute. The old data stays in place until the new data is ready.')) return;
        btn.classList.add('running');
        btn.disabled = true;
        try {
          const res = await api('/api/sheet-control/run', { method: 'POST', body: { fn } });
          toast(`${fn}() finished in ${(res.ms / 1000).toFixed(1)}s`, 'success');
          refresh({ fresh: true, withOptions: true });
        } catch (err) {
          toast(`${fn}() failed: ${err.message}`, 'error');
        } finally {
          btn.classList.remove('running');
          updateModeUi();
        }
      });
      list.appendChild(btn);
    });
  }

  // ---------------------------------------------------------------------------
  // Settings drawer
  // ---------------------------------------------------------------------------
  function openDrawer() {
    if (!state.isLocal) return;
    const s = state.settings || {};
    $('setTab').value = s.tab || '';
    $('setUrl').value = '';
    $('setUrl').placeholder = s.scriptUrlSet ? `Saved: ${s.scriptUrlPreview} (leave empty to keep)` : 'https://script.google.com/macros/s/…/exec';
    $('setToken').value = '';
    $('tokenState').textContent = s.tokenSet ? '(saved)' : '(not set)';
    $('setPoll').value = Math.round((s.pollMs || 4000) / 1000);
    $('setLan').checked = !!s.allowLanDashboard;
    $('testResult').textContent = '';
    renderLanUrls();
    $('drawer').classList.remove('hidden');
    $('drawerBackdrop').classList.remove('hidden');
    $('setUrl').focus();
  }
  function closeDrawer() {
    $('drawer').classList.add('hidden');
    $('drawerBackdrop').classList.add('hidden');
  }
  function renderLanUrls() {
    const box = $('lanUrls');
    box.textContent = '';
    (state.lanUrls || []).forEach((u) => box.appendChild(el('code', { text: u })));
    if (state.lanAccessCode) {
      box.appendChild(el('div', { class: 'muted', text: 'Other devices must enter this access code:' }));
      box.appendChild(el('code', { text: state.lanAccessCode }));
      box.appendChild(el('button', {
        class: 'btn btn-xs',
        text: 'New code',
        onclick: async () => {
          try {
            const r = await api('/api/sheet-control/rotate-code', { method: 'POST' });
            state.lanAccessCode = r.lanAccessCode;
            renderLanUrls();
            toast('New access code created. Other devices must enter it again.', 'success');
          } catch (e) { toast(e.message, 'error'); }
        }
      }));
    }
    if (state.lanRestartRequired) {
      box.appendChild(el('div', { class: 'muted', text: 'Restart SheetsToOBS to apply the network access setting.' }));
    }
  }

  async function saveSettings(extra = {}) {
    const body = {
      controlTabName: $('setTab').value.trim(),
      allowLanDashboard: $('setLan').checked,
      controlPollMs: (parseInt($('setPoll').value, 10) || 4) * 1000,
      ...extra
    };
    const url = $('setUrl').value.trim();
    if (url) body.scriptUrl = url;
    const token = $('setToken').value.trim();
    if (token) body.scriptToken = token;
    try {
      const saved = await api('/api/sheet-control/settings', { method: 'POST', body });
      toast('Connection settings saved', 'success');
      if (saved.restartRequired) toast('Restart SheetsToOBS to apply the network access change.', 'info');
      await loadLayout(true);
      closeDrawer();
    } catch (err) {
      $('testResult').textContent = err.message;
      $('testResult').className = 'test-result bad';
    }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function loadChampions() {
    try {
      const res = await fetch(`${CDRAGON}/champion-summary.json`);
      const list = await res.json();
      list.filter((c) => c.id > 0).forEach((c) => state.champions.set(c.name.toLowerCase(), { id: c.id, name: c.name }));
      applySnapshot();
    } catch (e) {
      // Offline or blocked: champion icons are optional.
    }
  }

  function renderViewSwitcher() {
    const box = $('viewSwitch');
    box.textContent = '';
    Object.entries(VIEWS).forEach(([key, v], i) => {
      box.appendChild(el('button', {
        type: 'button', class: 'view-btn', 'data-view': key, title: `${v.hint} (Alt+${i + 1})`,
        'aria-pressed': String(key === state.view), onclick: () => setView(key), text: v.label
      }));
    });
  }

  // "Live stats" button: refreshes ONLY the open stream's live stats (Stream2 -> fetchLiveStatsStream2).
  function streamNumber() {
    const m = /^Stream(\d)$/.exec(state.tab || '');
    return m ? m[1] : null;
  }
  function updateLiveStatsButton() {
    const btn = $('btnLiveStats');
    const n = streamNumber();
    btn.hidden = !n || !state.isLocal;
    btn.disabled = state.mode !== 'bridge' || btn.classList.contains('running');
    btn.title = n ? `Re-import live stats for ${state.tab} only (API_LiveStats${n}). Other streams are not touched.` : '';
  }
  async function runStreamLiveStats() {
    const n = streamNumber();
    if (!n) return;
    const btn = $('btnLiveStats');
    btn.classList.add('running');
    btn.disabled = true;
    btn.textContent = `Live stats ${state.tab}…`;
    try {
      const res = await api('/api/sheet-control/run', { method: 'POST', body: { fn: `fetchLiveStatsStream${n}` } });
      toast(`${state.tab} live stats refreshed (${(res.ms / 1000).toFixed(1)}s)`, 'success');
      refresh({ fresh: true });
    } catch (err) {
      toast(`${state.tab} live stats failed: ${err.message}`, 'error');
    } finally {
      btn.classList.remove('running');
      btn.textContent = '↻ Live stats';
      updateLiveStatsButton();
    }
  }

  async function loadLayout(keepTab) {
    const data = await api('/api/sheet-control/layout');
    state.baseLayout = data.layout;
    state.layouts = data.layouts || {};
    state.settings = data.settings;
    state.isLocal = data.isLocal;
    state.lanUrls = data.lanUrls || [];
    state.lanAccessCode = data.lanAccessCode || '';
    state.lanRestartRequired = !!data.lanRestartRequired;
    state.mode = data.settings.mode;
    if (!keepTab || !state.tab || !data.settings.tabs.includes(state.tab)) {
      const saved = (() => { try { return localStorage.getItem('s2o.dashboard.tab'); } catch (e) { return null; } })();
      state.tab = data.settings.tabs.includes(saved) ? saved : data.settings.tab;
    }
    document.body.classList.toggle('is-remote', !state.isLocal);

    const sel = $('tabSelect');
    sel.textContent = '';
    data.settings.tabs.forEach((t) => sel.appendChild(el('option', { value: t, text: t })));
    sel.value = state.tab;
    state.layout = state.layouts[state.tab] || state.baseLayout;
    $('sheetMeta').textContent = `Profile: ${data.settings.profile || '—'} · ${state.layout.sections.length} sections`;
    state.metaBase = $('sheetMeta').textContent;

    const savedView = loadPref('view');
    if (savedView && VIEWS[savedView]) state.view = savedView;
    state.focusSection = state.focusSection || loadPref('focus');
    renderViewSwitcher();
    renderLayout();
    renderScripts(data.runnable || []);
    updateModeUi();
    if (state.mode !== 'offline') await refresh({ fresh: true, withOptions: true });
    else applySnapshot();
  }

  function bindUi() {
    $('tabSelect').addEventListener('change', async (e) => {
      state.tab = e.target.value;
      try { localStorage.setItem('s2o.dashboard.tab', state.tab); } catch (err) { /* ignore */ }
      state.cells = {};
      state.options = {};
      state.readAt = null;
      state.layout = state.layouts[state.tab] || state.baseLayout;
      renderLayout();
      await refresh({ fresh: true, withOptions: true });
    });
    $('btnRefresh').addEventListener('click', () => refresh({ fresh: true, withOptions: true }));
    $('btnSyncNow').addEventListener('click', async () => {
      try { await api('/api/control/sync-now', { method: 'POST' }); toast('Pushing sheet to OBS…'); } catch (e) { toast(e.message, 'error'); }
    });
    $('btnEngine').addEventListener('click', async () => {
      const path = state.engineRunning ? '/api/control/stop' : '/api/control/start';
      try { await api(path, { method: 'POST' }); } catch (e) { toast(e.message, 'error'); }
    });
    $('btnLiveStats').addEventListener('click', runStreamLiveStats);
    $('btnSettings').addEventListener('click', openDrawer);
    $('btnCloseDrawer').addEventListener('click', closeDrawer);
    $('drawerBackdrop').addEventListener('click', closeDrawer);
    $('btnSaveSettings').addEventListener('click', () => saveSettings());
    $('btnDisconnect').addEventListener('click', () => {
      if (window.confirm('Remove the saved Web App URL and token? The dashboard falls back to read-only.')) saveSettings({ scriptUrl: '', clearToken: true });
    });
    $('btnTestBridge').addEventListener('click', async () => {
      const out = $('testResult');
      out.className = 'test-result';
      out.textContent = 'Testing…';
      try {
        const r = await api('/api/sheet-control/test', { method: 'POST' });
        out.className = 'test-result ok';
        out.textContent = `Connected to "${r.spreadsheet}" · bridge v${r.version} · tabs: ${(r.allowedTabs || []).join(', ')}`;
      } catch (err) {
        out.className = 'test-result bad';
        out.textContent = err.message;
      }
    });
    $('srcFilter').addEventListener('input', renderSources);
    $('btnClearLog').addEventListener('click', () => { $('log').textContent = ''; });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('drawer').classList.contains('hidden')) closeDrawer();
      if (e.altKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); setView(Object.keys(VIEWS)[parseInt(e.key, 10) - 1]); return; }
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'r') refresh({ fresh: true });
      if (state.view === 'focus' && /^[1-9]$/.test(e.key) && state.layout) {
        const sec = state.layout.sections[parseInt(e.key, 10) - 1];
        if (sec) { state.focusSection = sec.id; savePref('focus', sec.id); renderLayout(); applySnapshot(); }
      }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('beforeunload', (e) => {
      if (document.querySelector('.field.dirty') || state.saving.size) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindUi();
    connectEvents();
    try {
      await loadLayout(false);
    } catch (err) {
      $('sections').textContent = '';
      $('sections').appendChild(el('div', { class: 'empty-state', text: `Could not load the control layout: ${err.message}` }));
    }
    fetch('/api/status').then((r) => r.json()).then((s) => {
      onStatus(s);
      state.sources = s.sources || [];
      renderSources();
    }).catch(() => {});
    fetch('/api/logs').then((r) => r.json()).then((logs) => (logs || []).slice(-80).forEach(addLog)).catch(() => {});
    loadChampions();
    setInterval(updateFreshness, 1000);
    schedulePoll();
  });
})();
