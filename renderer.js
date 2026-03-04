'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const LOADERS = [
  { id:'vanilla',  name:'Vanilla'  },
  { id:'fabric',   name:'Fabric'   },
  { id:'quilt',    name:'Quilt'    },
  { id:'forge',    name:'Forge'    },
  { id:'neoforge', name:'NeoForge' },
];
const LOADER_MAP = Object.fromEntries(LOADERS.map(l => [l.id, l.name]));

// ── State ─────────────────────────────────────────────────────────────────────
let selectedVersion   = null;
let selectedLoader    = 'vanilla';
let useBestVersion    = true;
let ddRelease, ddSnapshot, ddLoaderVer, ddCustom;
let lastProgress      = 0;
let gameRunning       = false;
let lastPlayedLabel   = '—';
let activeMpId        = null;
let logOpen           = false;
let statusListenerAdded = false;
let customVersions    = [];
let selectedCustomId  = null;
let config            = { last: null, customVersions: [] };

// Modal state
let mddRelease = null, mddSnapshot = null, mddLoaderVer = null;
let modalSelectedVersion = null;
let modalSelectedLoader  = 'vanilla';
let modalUseBest         = true;

// ── Navigation ────────────────────────────────────────────────────────────────
const menuItems  = document.querySelectorAll('.menu-item');
const activeLine = document.getElementById('activeLine');

// Tab switch token — incremented on every tab change.
// Async load functions capture this value and bail out if it changed.
let _tabSeq = 0;
window._tabSeq = _tabSeq;

function moveLine(item) {
  const r = item.getBoundingClientRect(), pr = item.parentElement.getBoundingClientRect();
  const w = r.width * 0.76;
  activeLine.style.width = w + 'px';
  activeLine.style.left  = (r.left - pr.left + (r.width - w) / 2) + 'px';
}
menuItems.forEach(i => i.addEventListener('click', () => {
  menuItems.forEach(x => x.classList.remove('active'));
  i.classList.add('active');
  moveLine(i);
  _tabSeq = ((_tabSeq + 1) >>> 0);   // safe uint32 increment
  window._tabSeq = _tabSeq;
  loadTab(i.dataset.target);
}));
moveLine(document.querySelector('.menu-item.active'));

// ── Dropdown factory ──────────────────────────────────────────────────────────
function createDropdown(wrapperId, placeholder, items, onChange, opts = {}) {
  const wrap = document.getElementById(wrapperId);
  if (!wrap) return null;
  wrap.innerHTML = '';

  const trigger = document.createElement('div');
  trigger.className = 'dd-trigger';
  trigger.textContent = placeholder;

  const list    = document.createElement('div');  list.className = 'dd-list';
  if (opts.zIndex) list.style.zIndex = opts.zIndex;
  const searchW = document.createElement('div');  searchW.className = 'dd-search';
  const searchI = document.createElement('input');
  searchI.placeholder = t('search'); searchI.autocomplete = 'off';
  searchW.appendChild(searchI);
  const scroll = document.createElement('div'); scroll.className = 'dd-scroll';
  list.append(searchW, scroll);
  wrap.appendChild(trigger);
  document.body.appendChild(list);

  let selectedVal = null, allItems = [], disabled = false;

  function positionList() {
    const r = trigger.getBoundingClientRect();
    list.style.width = r.width + 'px';
    list.style.left  = r.left + 'px';
    const listH = Math.min(260, scroll.scrollHeight + 50);
    list.style.top = (window.innerHeight - r.bottom < listH + 8 && r.top > listH)
      ? (r.top - listH - 4) + 'px'
      : (r.bottom + 4) + 'px';
  }

  function renderItems(filter = '') {
    scroll.innerHTML = '';
    const q = filter.toLowerCase();
    const filtered = allItems.filter(it => it.label.toLowerCase().includes(q));
    if (!filtered.length) {
      const e = document.createElement('div');
      e.className = 'dd-empty'; e.textContent = t('dd_empty');
      scroll.appendChild(e);
    } else {
      filtered.forEach(it => {
        const el = document.createElement('div');
        el.className = 'dd-item' + (it.value === selectedVal ? ' selected' : '');
        if (opts.renderItem) opts.renderItem(it, el);
        else el.textContent = it.label;
        el.addEventListener('mousedown', e => {
          e.preventDefault(); e.stopPropagation();
          if (e.target.classList.contains('dd-item-dots')) return;
          selectedVal = it.value;
          trigger.textContent = it.label;
          trigger.classList.add('has-value');
          closeAllDropdowns();
          onChange?.(it.value, it);
        });
        scroll.appendChild(el);
      });
    }
    opts.extraActions?.forEach(a => {
      const el = document.createElement('div');
      el.className = 'dd-item dd-action'; el.textContent = a.label;
      el.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); closeAllDropdowns(); a.action(); });
      scroll.appendChild(el);
    });
  }

  searchI.addEventListener('input', () => renderItems(searchI.value));
  searchI.addEventListener('click', e => e.stopPropagation());
  searchI.addEventListener('mousedown', e => e.stopPropagation());

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    if (disabled) return;
    const isOpen = list.classList.contains('open');
    closeAllDropdowns();
    if (!isOpen) {
      searchI.value = '';
      renderItems('');
      positionList();
      list.classList.add('open');
      trigger.classList.add('open');
      setTimeout(() => searchI.focus(), 50);
    }
  });

  const setItems = arr => { allItems = arr; renderItems(searchI.value); };
  if (items?.length) setItems(items);

  return {
    setItems,
    getValue:       () => selectedVal,
    getLabel:       () => selectedVal ? (allItems.find(i => i.value === selectedVal)?.label ?? selectedVal) : null,
    setValue:       (v, label) => { selectedVal = v; trigger.textContent = label || allItems.find(i => i.value === v)?.label || v; trigger.classList.add('has-value'); },
    setPlaceholder: t  => { trigger.textContent = t; trigger.classList.remove('has-value'); selectedVal = null; },
    setDisabled:    v  => { disabled = v; trigger.classList.toggle('disabled', v); },
    reset:          () => { selectedVal = null; trigger.textContent = placeholder; trigger.classList.remove('has-value', 'open'); closeListAnimated(list); },
    destroy:        () => list.parentNode?.removeChild(list),
  };
}

// Close with animation
function closeListAnimated(list) {
  if (!list.classList.contains('open')) return;
  list.classList.add('closing');
  list.classList.remove('open');
  list.addEventListener('transitionend', () => list.classList.remove('closing'), { once: true });
}

function closeAllDropdowns() {
  document.querySelectorAll('.dd-list.open').forEach(closeListAnimated);
  document.querySelectorAll('.dd-trigger.open').forEach(el => el.classList.remove('open'));
}
document.addEventListener('click', closeAllDropdowns);

// ── Log ───────────────────────────────────────────────────────────────────────
function appendLog(msg) {
  const el = document.getElementById('logBody');
  if (!el) return;
  if (!el.querySelector('.log-line')) el.innerHTML = '';
  const isError = /^[⚠✗]|[Ee]rror/.test(msg);
  const span = document.createElement('span');
  span.className = isError ? 'log-line log-error' : 'log-line';
  span.textContent = msg + '\n';
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}
window.closeLog  = () => { logOpen = false; document.getElementById('logOverlay').classList.remove('open'); document.getElementById('logBtn')?.classList.remove('active'); };
function toggleLog() { logOpen = !logOpen; document.getElementById('logOverlay').classList.toggle('open', logOpen); document.getElementById('logBtn')?.classList.toggle('active', logOpen); }

// ── Modal ─────────────────────────────────────────────────────────────────────
window.closeModal = () => {
  document.getElementById('modalOverlay').classList.remove('open');
  [mddRelease, mddSnapshot, mddLoaderVer].forEach(dd => { try { dd?.destroy(); } catch {} });
  mddRelease = mddSnapshot = mddLoaderVer = null;
};

function setModalLoadersLocked(locked) {
  document.querySelectorAll('#modalLoaderGrid .loader-btn').forEach(b => {
    if (b.dataset.loader !== 'vanilla') {
      b.disabled = locked; b.style.opacity = locked ? '0.3' : ''; b.style.cursor = locked ? 'not-allowed' : '';
    }
  });
  if (locked && modalSelectedLoader !== 'vanilla') {
    modalSelectedLoader = 'vanilla';
    document.querySelectorAll('#modalLoaderGrid .loader-btn').forEach(b => b.classList.toggle('active', b.dataset.loader === 'vanilla'));
    try { mddLoaderVer?.destroy(); } catch {} mddLoaderVer = null;
    document.getElementById('modalLoaderVerCol').innerHTML =
      `<div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.08em;">${t('loader_ver')}</div>` +
      `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#353548;font-size:13px;">${t('loader_unavail')}</div>`;
  }
}

window.openCreateModal = async function() {
  modalSelectedVersion = null; modalSelectedLoader = 'vanilla'; modalUseBest = true;
  document.getElementById('modalName').value = '';
  document.getElementById('modalName').style.borderColor = '';
  document.getElementById('modalOverlay').classList.add('open');
  document.querySelectorAll('#modalLoaderGrid .loader-btn').forEach(b => b.classList.toggle('active', b.dataset.loader === 'vanilla'));
  setModalLoadersLocked(false);
  document.getElementById('modalLoaderVerCol').innerHTML =
    `<div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.08em;">${t('loader_ver')}</div>` +
    `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#353548;font-size:13px;">${t('loader_unavail')}</div>`;
  [mddRelease, mddSnapshot, mddLoaderVer].forEach(dd => { try { dd?.destroy(); } catch {} });
  mddRelease = mddSnapshot = mddLoaderVer = null;
  try {
    const data = await fetchVersionManifest();
    mddRelease  = createDropdown('mddReleaseWrap',  t('select_release'),   data.releases,  v => { modalSelectedVersion = v; mddSnapshot?.reset(); setModalLoadersLocked(false); modalRefreshLoaderVer(); });
    mddSnapshot = createDropdown('mddSnapshotWrap', t('select_snapshot'), data.snapshots, v => { modalSelectedVersion = v; mddRelease?.reset();   setModalLoadersLocked(true);  modalRefreshLoaderVer(); });
  } catch(e) { appendLog(t('err_load_versions') + ': ' + e.message); }
  setTimeout(() => document.getElementById('modalName').focus(), 100);
};

window.modalSelectLoader = function(id) {
  modalSelectedLoader = id;
  document.querySelectorAll('#modalLoaderGrid .loader-btn').forEach(b => b.classList.toggle('active', b.dataset.loader === id));
  try { mddLoaderVer?.destroy(); } catch {} mddLoaderVer = null;
  const col = document.getElementById('modalLoaderVerCol');
  if (id === 'vanilla') {
    col.innerHTML = `<div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.08em;">${t('loader_ver')}</div><div style="flex:1;display:flex;align-items:center;justify-content:center;color:#353548;font-size:13px;">${t('loader_unavail')}</div>`;
  } else {
    col.innerHTML = `<div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.08em;">${t('loader_ver')}: ${LOADER_MAP[id]||id}</div><div class="loaderv-inner"><div class="best-row on" id="mBestRow" onclick="modalToggleBest()"><input type="checkbox" id="mBestCheck" checked onclick="event.stopPropagation()"><span>${t('mp_best_ver')}</span></div><div id="mddLoaderVerWrap" class="dd-wrap"></div></div>`;
    modalUseBest = true;
    mddLoaderVer = createDropdown('mddLoaderVerWrap', t('select_custom'), [], null);
    mddLoaderVer.setDisabled(true);
    modalRefreshLoaderVer();
  }
};

window.modalToggleBest = function() {
  modalUseBest = !modalUseBest;
  document.getElementById('mBestCheck')?.toggleAttribute('checked', modalUseBest);
  document.getElementById('mBestRow')?.classList.toggle('on', modalUseBest);
  mddLoaderVer?.setDisabled(modalUseBest);
};

async function modalRefreshLoaderVer() {
  if (modalSelectedLoader === 'vanilla' || !modalSelectedVersion || !mddLoaderVer) return;
  mddLoaderVer.setPlaceholder(t('loading'));
  try {
    const versions = await window.electronAPI?.getLoaderVersions({ loader: modalSelectedLoader, mcVersion: modalSelectedVersion }) || [];
    if (versions.length) {
      mddLoaderVer.setItems(versions.map(v => ({ value: v, label: v })));
      mddLoaderVer.setPlaceholder(t('select_custom'));
      mddLoaderVer.setDisabled(modalUseBest);
    } else {
      try { mddLoaderVer?.destroy(); } catch {} mddLoaderVer = null;
      const col = document.getElementById('modalLoaderVerCol');
      if (col) col.innerHTML = `<div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.08em;">${t('loader_ver')}: ${LOADER_MAP[modalSelectedLoader]||modalSelectedLoader}</div><div style="flex:1;display:flex;align-items:center;justify-content:center;color:#353548;font-size:13px;">${t('loader_unavail')}</div>`;
    }
  } catch(e) { mddLoaderVer?.setPlaceholder(t('error_label') + ': ' + e.message); }
}

window.confirmCreateVersion = () => {
  const name = document.getElementById('modalName').value.trim();
  if (!name) { document.getElementById('modalName').style.borderColor = '#cc4444'; return; }
  if (!modalSelectedVersion) { document.getElementById('modalName').style.borderColor = '#cc8800'; appendLog(t('sel_mc_ver')); return; }
  document.getElementById('modalName').style.borderColor = '';
  const cv = {
    id:            Date.now(),
    name,
    version:       modalSelectedVersion,
    loader:        modalSelectedLoader,
    loaderVersion: (!modalUseBest && mddLoaderVer) ? mddLoaderVer.getValue() : null,
    versionType:   !!document.querySelector('#mddSnapshotWrap .dd-trigger.has-value') ? 'snapshot' : 'release',
  };
  customVersions.push(cv);
  saveConfig();
  closeModal();
  rebuildCustomDropdown();
  selectCustomVersion(cv.id);
};

// ── Config ────────────────────────────────────────────────────────────────────
function saveConfig() {
  config.customVersions = customVersions;
  window.electronAPI?.saveConfig({ customVersions });
}

function saveLastLaunch(label) {
  config.last = {
    version:       selectedVersion,
    loader:        selectedLoader,
    loaderVersion: (!useBestVersion && ddLoaderVer) ? ddLoaderVer.getValue() : null,
    versionType:   document.querySelector('#ddSnapshotWrap .dd-trigger.has-value') ? 'snapshot' : 'release',
    label,
  };
  window.electronAPI?.saveConfig({ last: config.last });
}

// ── Version edit popup ────────────────────────────────────────────────────────
let verEditCurrentId = null;
const verEditPopup   = document.getElementById('verEditPopup');

function positionVerEditPopup(anchor) {
  const r = anchor.getBoundingClientRect();
  verEditPopup.style.left = Math.max(4, r.right - 170) + 'px';
  verEditPopup.style.top  = (window.innerHeight - r.bottom < 140 ? r.top - 140 : r.bottom + 4) + 'px';
}

function openVersionEditPanel(idStr, anchor) {
  const cvId = Number(idStr);
  if (verEditPopup.classList.contains('open') && verEditCurrentId === cvId) { closeVerEditPopup(); return; }
  const cv = customVersions.find(v => v.id === cvId);
  if (!cv) return;
  verEditCurrentId = cvId;
  document.getElementById('verEditName').value = cv.name;
  positionVerEditPopup(anchor);
  verEditPopup.style.animation = 'none';
  verEditPopup.classList.add('open');
  requestAnimationFrame(() => { verEditPopup.style.animation = ''; });
  setTimeout(() => document.getElementById('verEditName').focus(), 30);
}

function closeVerEditPopup() {
  verEditPopup.classList.remove('open');
  verEditCurrentId = null;
}

document.getElementById('verEditSaveBtn').addEventListener('click', e => {
  e.stopPropagation();
  const cv = customVersions.find(v => v.id === verEditCurrentId);
  if (!cv) return;
  const name = document.getElementById('verEditName').value.trim();
  if (!name) return;
  cv.name = name;
  saveConfig();
  if (selectedCustomId === verEditCurrentId) updatePlaySub();
  closeVerEditPopup();
  rebuildCustomDropdown(true);
});

document.getElementById('verEditDeleteBtn').addEventListener('click', e => {
  e.stopPropagation();
  const cvId = verEditCurrentId;
  const cv = customVersions.find(v => v.id === cvId);
  const name = cv ? `«${cv.name}»` : t('this_version');
  const overlay = document.getElementById('stopConfirmOverlay');
  document.getElementById('scIcon').textContent  = '🗑️';
  document.getElementById('scTitle').textContent = `${t('delete_btn')} ${name}?`;
  document.getElementById('scDesc').innerHTML    = t('delete_version_desc');
  document.getElementById('scConfirmBtn').textContent = t('delete_btn');
  document.getElementById('scConfirmBtn').onclick = () => {
    customVersions = customVersions.filter(v => v.id !== cvId);
    if (selectedCustomId === cvId) { selectedCustomId = null; selectedVersion = null; updatePlaySub(); }
    saveConfig();
    closeVerEditPopup();
    rebuildCustomDropdown(true);
    closeStopConfirm();
    document.getElementById('scConfirmBtn').onclick = null;
  };
  document.getElementById('scCancelBtn').onclick = () => { closeStopConfirm(); document.getElementById('scConfirmBtn').onclick = null; };
  overlay.classList.add('open');
  closeVerEditPopup();
});

document.addEventListener('click', e => {
  if (verEditPopup.classList.contains('open') && !verEditPopup.contains(e.target) && !e.target.classList.contains('dd-item-dots'))
    closeVerEditPopup();
});

// ── Custom versions dropdown ──────────────────────────────────────────────────
function renderCustomItem(it, el) {
  el.style.cssText = 'display:flex;align-items:center;gap:4px;';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
  lbl.textContent = it.label;
  const dots = document.createElement('button');
  dots.className = 'dd-item-dots'; dots.title = t('edit_title'); dots.textContent = '⋯';
  dots.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openVersionEditPanel(it.value, dots); });
  el.append(lbl, dots);
}

function rebuildCustomDropdown(keepOpen) {
  const wrap = document.getElementById('ddCustomWrap');
  const row  = document.getElementById('customDdRow');
  const btn  = document.getElementById('btnCreateVersion');
  if (!wrap) return;

  const mpItems = modpacks.map(mp => ({ value: 'mp_' + mp.id, label: `${mp.name} — ${t('modpack_badge')}` }));
  const cvItems = customVersions.map(cv => ({ value: String(cv.id), label: cv.name }));
  const allItems = [...cvItems, ...mpItems];

  if (!allItems.length) {
    try { ddCustom?.destroy(); } catch {} ddCustom = null;
    if (row) row.style.display = 'none';
    if (btn) btn.style.display = '';
    return;
  }
  if (btn) btn.style.display = 'none';
  if (row) row.style.display = 'flex';

  if (ddCustom && keepOpen) {
    ddCustom.setItems(allItems);
    if (selectedCustomId) {
      const found = allItems.find(i => i.value === String(selectedCustomId));
      if (found) ddCustom.setValue(found.value, found.label);
    }
    return;
  }

  try { ddCustom?.destroy(); } catch {} ddCustom = null;
  ddCustom = createDropdown('ddCustomWrap', t('select_custom'), allItems, val => {
    if (val.startsWith('mp_')) {
      const mp = modpacks.find(m => 'mp_' + m.id === val);
      if (!mp) return;
      selectedCustomId = val;
      resetTopGrid();
      selectedVersion = mp.version;
      selectedLoader  = mp.loader;
      updatePlaySub();
    } else {
      selectCustomVersion(Number(val));
    }
  }, {
    extraActions: [{ label: t('create_ver_action'), action: openCreateModal }],
    renderItem: (it, el) => {
      if (it.value.startsWith('mp_')) {
        el.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size:9px;padding:1px 5px;border-radius:4px;background:#004dff18;color:#4477cc;border:1px solid #004dff33;flex-shrink:0;';
        badge.textContent = t('modpack_badge');
        const lbl = document.createElement('span');
        lbl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
        const mp = modpacks.find(m => 'mp_' + m.id === it.value);
        lbl.textContent = mp?.name || it.label;
        el.append(lbl, badge);
      } else {
        renderCustomItem(it, el);
      }
    },
  });
  if (selectedCustomId) {
    const found = allItems.find(i => i.value === String(selectedCustomId));
    if (found) ddCustom.setValue(found.value, found.label);
  }
}

function resetTopGrid() {
  ddRelease?.reset();
  ddSnapshot?.reset();
  ddLoaderVer?.reset();
  document.querySelectorAll('.loader-btn').forEach(b => b.classList.remove('active'));
  const card = document.getElementById('loaderVerCard');
  if (card) card.innerHTML = `<div class="card-title">${t('loader_ver')}</div><div class="unavail">${t('loader_first')}</div>`;
  selectedVersion = null;
  selectedLoader  = 'vanilla';
}

function selectCustomVersion(id) {
  const cv = customVersions.find(v => v.id === id);
  if (!cv) return;
  selectedCustomId = id;
  resetTopGrid();
  selectedVersion  = cv.version;
  selectedLoader   = cv.loader;
  updatePlaySub();
}

// ── Fetch version manifest (cached) ──────────────────────────────────────────
let _manifestCache = null;
async function fetchVersionManifest() {
  if (_manifestCache) return _manifestCache;
  // Use main-process IPC handler which caches to disk for 1hr
  // Falls back to direct fetch if IPC not available (dev mode without electron)
  let versions;
  if (window.electronAPI?.getManifest) {
    const data = await window.electronAPI.getManifest();
    versions = data.versions; // already slimmed: [{id, type, releaseTime}]
  } else {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const data = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', { signal: controller.signal }).then(r => r.json());
      versions = data.versions.map(v => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
    } finally {
      clearTimeout(timeoutId);
    }
  }
  const toItem = v => ({ value: v.id, label: v.id + (v.type !== 'release' ? ' (' + v.type + ')' : '') });
  // raw stores only slimmed versions (id, type, releaseTime) — not full manifest to save RAM
  _manifestCache = {
    releases:  versions.filter(v => v.type === 'release').map(toItem),
    snapshots: versions.filter(v => v.type !== 'release').map(toItem),
    raw:       { versions },
  };
  return _manifestCache;
}

// ── Launcher init ─────────────────────────────────────────────────────────────
async function loadLauncher() {
  const mySeq = _tabSeq;
  const content = document.getElementById('content');
  const loaderBtns = LOADERS.map(l =>
    `<button class="loader-btn${l.id==='vanilla'?' active':''}" data-loader="${l.id}" onclick="selectLoader('${l.id}')">${l.name}</button>`
  ).join('');

  content.innerHTML = `
    <div class="top-grid">
      <div class="card">
        <div class="card-title">${t('version_mc')}</div>
        <div class="ver-group">
          <div><div class="ver-label">${t('releases_label')}</div><div id="ddReleaseWrap" class="dd-wrap"></div></div>
          <div><div class="ver-label">${t('snapshots_label')}</div><div id="ddSnapshotWrap" class="dd-wrap"></div></div>
          <div id="launcherSnapNote" style="display:none;font-size:10.5px;color:#7a5a2a;margin-top:2px;padding:5px 8px;background:#1a1408;border:1px solid #3a2a0a;border-radius:6px;" data-i18n="mp_snap_note">* модлоадеры недоступны в снапшотах</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">${t('loader_label')}</div>
        <div class="loader-grid">${loaderBtns}</div>
      </div>
      <div class="card" id="loaderVerCard">
        <div class="card-title">${t('loader_ver')}</div>
        <div class="unavail">${t('loader_first')}</div>
      </div>
    </div>

    <div class="or-divider">${t('or_label')}</div>

    <div id="customVersionSection">
      <div class="custom-row" id="customDdRow" style="display:none;margin-bottom:8px;">
        <div id="ddCustomWrap" class="dd-wrap" style="flex:1;min-width:0;"></div>
      </div>
      <button class="btn-create-version" id="btnCreateVersion" onclick="openCreateModal()">${t('create_version')}</button>
      <div style="height:1px;background:#1e1e25;margin:10px 0 2px;"></div>
      <div class="play-row-wrap" style="margin-top:8px;">
        <div id="progressWrap"><div id="progressTrack"><div id="progressBar"></div></div><div id="progressLabel"></div></div>
        <div class="play-row-inner">
          <button id="playBtn">
            <div class="play-inner" style="margin-left:40px">
              <span class="play-label">${t('play')}</span>
              <span class="play-version" id="playSubText">—</span>
            </div>
          </button>
          <div class="play-row-side">
            <button id="cancelBtn" title="${t('stop_btn')}" onclick="stopGame()">✕</button>
            <button id="logBtn"    title="${t('log_title')}"         onclick="toggleLog()">&gt;_</button>
          </div>
        </div>
      </div>
    </div>

    <div id="newsWrap">
      <div class="news-col-title">${t('recent_versions')}</div>
      <div class="ver-list" id="verList"></div>
    </div>

  `;

  try {
    const data = await fetchVersionManifest();
    if (_tabSeq !== mySeq) return;  // tab changed while loading — discard
    ddRelease  = createDropdown('ddReleaseWrap',  t('select_release'),   data.releases,  v => { selectedVersion = v; selectedCustomId = null; ddSnapshot?.reset(); ddCustom?.reset(); setLoadersLocked(false); refreshLoaderVersions(); updatePlaySub(); document.getElementById('launcherSnapNote').style.display='none'; if (selectedLoader==='vanilla') { const c=document.getElementById('loaderVerCard'); if(c) c.innerHTML=`<div class="card-title">${t('loader_ver')}</div><div class="unavail">${t('loader_unavail')}</div>`; } });
    ddSnapshot = createDropdown('ddSnapshotWrap', t('select_snapshot'), data.snapshots, v => { selectedVersion = v; selectedCustomId = null; ddRelease?.reset();   ddCustom?.reset(); setLoadersLocked(true);  refreshLoaderVersions(); updatePlaySub(); document.getElementById('launcherSnapNote').style.display=''; });
    config.last ? restoreLastSession() : (selectedVersion = data.releases[0]?.value, ddRelease.setValue(data.releases[0].value, data.releases[0].label), updatePlaySub());
  } catch(e) { appendLog(t('err_load_versions') + ': ' + e.message); }

  customVersions = config.customVersions || [];
  rebuildCustomDropdown();
  loadNews();
  document.getElementById('playBtn').addEventListener('click', startGame);
  initElectronListeners();
}

// ── Versions panel ───────────────────────────────────────────────────────────
function loadNews() {
  const verList = document.getElementById('verList');
  if (!verList || !_manifestCache) return;
  const versions = _manifestCache.raw.versions
    .filter(v => v.type === 'release' || v.type === 'snapshot')
    .slice(0, 10);
  verList.innerHTML = '';
  versions.forEach(v => {
    const date = new Date(v.releaseTime).toLocaleDateString('ru-RU', { day:'numeric', month:'long', year:'numeric' });
    const row = document.createElement('div');
    row.className = 'ver-row';
    row.innerHTML = `
      <span class="ver-row-id">${v.id}</span>
      <span class="ver-row-type ${v.type}">${v.type === 'release' ? t('ver_release') : t('ver_snapshot')}</span>
      <span class="ver-row-date">${date}</span>
    `;
    verList.appendChild(row);
  });
}

// ── Loader control ────────────────────────────────────────────────────────────
function setLoadersLocked(locked) {
  document.querySelectorAll('.loader-btn').forEach(b => {
    if (b.dataset.loader !== 'vanilla') {
      b.disabled = locked; b.style.opacity = locked ? '0.3' : ''; b.style.cursor = locked ? 'not-allowed' : '';
    }
  });
  if (locked && selectedLoader !== 'vanilla') {
    selectedLoader = 'vanilla';
    document.querySelectorAll('.loader-btn').forEach(b => b.classList.toggle('active', b.dataset.loader === 'vanilla'));
    const card = document.getElementById('loaderVerCard');
    if (card) { try { ddLoaderVer?.destroy(); } catch {} ddLoaderVer = null; card.innerHTML = `<div class="card-title">${t('loader_ver')}</div><div class="unavail">${t('loader_unavail')}</div>`; }
  }
}

window.selectLoader = function(id, presetLoaderVer) {
  selectedLoader = id;
  if (selectedCustomId) selectedCustomId = null;
  document.querySelectorAll('.loader-btn').forEach(b => b.classList.toggle('active', b.dataset.loader === id));
  const card = document.getElementById('loaderVerCard');
  if (!card) return;
  if (id === 'vanilla') {
    try { ddLoaderVer?.destroy(); } catch {} ddLoaderVer = null;
    card.innerHTML = `<div class="card-title">${t('loader_ver')}</div><div class="unavail">${selectedVersion ? t('loader_unavail') : t('loader_first')}</div>`;
    updatePlaySub(); return;
  }
  card.innerHTML = `<div class="card-title">${t('loader_ver')}: ${LOADER_MAP[id]||id}</div><div class="loaderv-inner"><div class="best-row on" id="bestRow" onclick="toggleBest()"><input type="checkbox" id="bestCheck" checked onclick="event.stopPropagation()"><span>${t('mp_best_ver')}</span></div><div id="ddLoaderVerWrap" class="dd-wrap"></div></div>`;
  useBestVersion = true;
  ddLoaderVer = createDropdown('ddLoaderVerWrap', t('select_custom'), [], () => updatePlaySub());
  ddLoaderVer.setDisabled(true);
  refreshLoaderVersions(presetLoaderVer);
  updatePlaySub();
};

window.toggleBest = function() {
  useBestVersion = !useBestVersion;
  document.getElementById('bestCheck')?.toggleAttribute('checked', useBestVersion);
  document.getElementById('bestRow')?.classList.toggle('on', useBestVersion);
  ddLoaderVer?.setDisabled(useBestVersion);
  updatePlaySub();
};

async function refreshLoaderVersions(presetVal) {
  if (selectedLoader === 'vanilla' || !selectedVersion || !ddLoaderVer) return;
  ddLoaderVer.setPlaceholder(t('loading'));
  try {
    const versions = await window.electronAPI?.getLoaderVersions({ loader: selectedLoader, mcVersion: selectedVersion }) || [];
    if (versions.length) {
      ddLoaderVer.setItems(versions.map(v => ({ value: v, label: v })));
      presetVal ? ddLoaderVer.setValue(presetVal) : ddLoaderVer.setPlaceholder(t('select_custom'));
      ddLoaderVer.setDisabled(useBestVersion);
    } else {
      try { ddLoaderVer?.destroy(); } catch {} ddLoaderVer = null;
      const card = document.getElementById('loaderVerCard');
      if (card) card.innerHTML = `<div class="card-title">${t('loader_ver')}: ${LOADER_MAP[selectedLoader]||selectedLoader}</div><div class="unavail">${t('loader_unavail')}</div>`;
    }
  } catch { ddLoaderVer?.setPlaceholder(t('error_label')); }
}

function updatePlaySub() {
  const el = document.getElementById('playSubText');
  if (!el) return;
  if (selectedCustomId) {
    if (String(selectedCustomId).startsWith('mp_')) {
      const mpId = Number(String(selectedCustomId).replace('mp_', ''));
      el.textContent = modpacks.find(m => m.id === mpId)?.name || '—';
    } else {
      el.textContent = customVersions.find(v => v.id === selectedCustomId)?.name || '—';
    }
  } else if (selectedVersion) {
    el.textContent = selectedLoader !== 'vanilla' ? `${selectedVersion} ${LOADER_MAP[selectedLoader]||''}` : selectedVersion;
  } else {
    el.textContent = '—';
  }
}

function restoreLastSession() {
  const last = config.last;
  if (!last?.version) return;
  selectedVersion = last.version;
  selectedLoader  = last.loader || 'vanilla';
  (last.versionType === 'snapshot' ? ddSnapshot : ddRelease)?.setValue(last.version, last.version);
  document.querySelectorAll('.loader-btn').forEach(b => b.classList.toggle('active', b.dataset.loader === selectedLoader));
  selectLoader(selectedLoader, last.loaderVersion);
  updatePlaySub();
}

// ── Game launch ───────────────────────────────────────────────────────────────
function launchGame({ version, loader, loaderVersion, versionType, instanceName }) {
  if (!window.electronAPI) { appendLog('⚠ ' + t('npm_start_warn')); if (!logOpen) toggleLog(); return; }
  lastProgress = 0; gameRunning = true;
  // Save current version label so we can restore it after game exits
  lastPlayedLabel = document.getElementById('playSubText')?.textContent || version;
  const btn    = document.getElementById('playBtn');
  const cancel = document.getElementById('cancelBtn');
  const w      = document.getElementById('progressWrap');
  const b      = document.getElementById('progressBar');
  const l      = document.getElementById('progressLabel');
  if (btn) { btn.disabled = true; btn.innerHTML = `<div class="play-inner" style="margin-left:80px"><span class="play-label">${t('launching')}</span></div>`; }
  cancel?.classList.add('visible');
  if (w) { w.style.display = 'flex'; if (b) b.style.width = '0%'; if (l) l.textContent = t('preparing'); }
  window.electronAPI.launchMinecraft({ version, loader, loaderVersion, versionType, instanceName: instanceName || version, account: acCurrentAccount || null });
}

function startGame() {
  if (!selectedVersion) { appendLog('⚠ ' + t('select_ver_warn')); if (!logOpen) toggleLog(); return; }
  const loaderVer  = (!useBestVersion && ddLoaderVer) ? ddLoaderVer.getValue() : null;
  const isSnapshot = !!document.querySelector('#ddSnapshotWrap .dd-trigger.has-value');
  saveLastLaunch(document.getElementById('playSubText')?.textContent || selectedVersion);
  launchGame({ version: selectedVersion, loader: selectedLoader, loaderVersion: loaderVer, versionType: isSnapshot ? 'snapshot' : 'release' });
}

window.stopGame = function() {
  if (gameRunning) {
    const overlay = document.getElementById('stopConfirmOverlay');
    document.getElementById('scIcon').textContent  = '⚠️';
    document.getElementById('scTitle').textContent = t('stop_game_title');
    document.getElementById('scDesc').innerHTML    = t('stop_game_desc');
    document.getElementById('scConfirmBtn').textContent   = t('stop_btn');
    document.getElementById('scConfirmBtn').style.background = '#cc2222';
    overlay.classList.add('open');
  } else {
    document.getElementById('scIcon').textContent  = '⏹';
    document.getElementById('scTitle').textContent = t('stop_download_title');
    document.getElementById('scDesc').innerHTML    = t('stop_download_desc');
    document.getElementById('scConfirmBtn').textContent = t('stop_btn');
    document.getElementById('scConfirmBtn').style.background = '#cc2222';
    document.getElementById('stopConfirmOverlay').classList.add('open');
  }
};
window.closeStopConfirm = () => { document.getElementById('stopConfirmOverlay').classList.remove('open'); };
window.confirmStop = () => { closeStopConfirm(); (gameRunning ? window.electronAPI?.killProcess() : window.electronAPI?.cancelLaunch()); };
window.cancelLaunch = () => window.electronAPI?.cancelLaunch();

function resetPlayBtn() {
  gameRunning = false;
  const btn  = document.getElementById('playBtn');
  // Use saved label (DOM playSubText is gone while timer is showing)
  const sub  = lastPlayedLabel || '—';
  if (btn) { btn.disabled = false; btn.innerHTML = `<div class="play-inner" style="margin-left:40px"><span class="play-label">${t('play')}</span><span class="play-version" id="playSubText">${sub}</span></div>`; }
  document.getElementById('cancelBtn')?.classList.remove('visible');
  if (activeMpId !== null) { const _mpId = activeMpId; activeMpId = null; mpSetLaunching(_mpId, false); }
}

function initElectronListeners() {
  if (!window.electronAPI || statusListenerAdded) return;
  statusListenerAdded = true;
  let launchMode = 'download';

  window.electronAPI.onMode(mode => { launchMode = mode; });

  window.electronAPI.onCancelled(() => {
    resetPlayBtn();
    setTimeout(() => {
      const w = document.getElementById('progressWrap');
      const b = document.getElementById('progressBar');
      const l = document.getElementById('progressLabel');
      if (w) w.style.display = 'none';
      if (b) b.style.width = '0%';
      if (l) l.textContent = '';
      lastProgress = 0;
    }, 800);
  });

  window.electronAPI.onStatus(msg => {
    appendLog(msg);
    if (msg === t('game_started') || msg === 'Game launched!') {
      if (activeMpId !== null) { mpSetInGame(activeMpId); }
      const btn = document.getElementById('playBtn');
      if (btn) {
        const startTime = Date.now();
        // OPT: btn already captured above — no DOM query inside interval
        const _inGameLabel = t('in_game_label');
        const timer = setInterval(() => {
          if (!gameRunning) { clearInterval(timer); return; }
          const e  = Math.floor((Date.now() - startTime) / 1000);
          const hh = String(Math.floor(e / 3600)).padStart(2,'0');
          const mm = String(Math.floor(e % 3600 / 60)).padStart(2,'0');
          const ss = String(e % 60).padStart(2,'0');
          btn.innerHTML = `<div class="play-inner" style="margin-left:80px"><span class="play-label" style="font-size:13px;letter-spacing:0">${_inGameLabel} ${hh}:${mm}:${ss}</span></div>`;
        }, 1000);
      }
    }
    if (msg.startsWith(t('game_closed'))) {
      resetPlayBtn();
      setTimeout(() => {
        const w = document.getElementById('progressWrap');
        if (w) w.style.display = 'none';
        const b = document.getElementById('progressBar');
        if (b) b.style.width = '0%';
        const l = document.getElementById('progressLabel');
        if (l) l.textContent = '';
        lastProgress = 0;
      }, 1000);
    }
  });

  window.electronAPI.onProgress(perc => {
    const w = document.getElementById('progressWrap');
    const b = document.getElementById('progressBar');
    const l = document.getElementById('progressLabel');
    if (!b || perc <= lastProgress) return;
    lastProgress = perc;
    if (w) w.style.display = 'flex';
    b.style.width = perc + '%';
    if (!l) return;
    if (perc >= 100) {
      setTimeout(() => { if (w) w.style.display = 'none'; if (b) b.style.width = '0%'; if (l) l.textContent = ''; }, 600);
    } else {
      l.textContent = (launchMode === 'launch' ? t('launching') + ' ' : t('downloading') + ' ') + perc + '%';
    }
  });
}

// ── Mods page ─────────────────────────────────────────────────────────────────
const MODS_CATEGORIES = [
  { id:'mod',          labelKey:'tab_mod' },
  { id:'resourcepack', labelKey:'tab_resourcepack' },
  { id:'shader',       labelKey:'tab_shader' },
  { id:'modpack',      labelKey:'tab_modpack' },
  { id:'datapack',     labelKey:'tab_datapack' },
];
let modsCategory = 'mod';
let modsQuery    = '';
let modsOffset   = 0;
let modsLoading  = false;
let modsSource   = 'both';
let modsCFAvail  = null;
let modsView     = 'search';
let modpacks     = [];
let modsSort     = 'downloads';
let modsFilterVersion = '';
let modsFilterLoaders  = [];
let modsFilterCategories = [];
let modsFilterEnv = '';
const MODS_LIMIT = 20;
let _modsSearchTimer = null;

let mpVersionDD    = null;
let mpLoaderVerDD  = null;
let mpModalSelVer  = null;
let mpModalSelLoader = 'vanilla';
let mpModalIsSnap  = false;
let mpModalUseBest = true;

window.openMpModal = async function() {
  mpModalSelVer    = null;
  mpModalSelLoader = 'vanilla';
  mpModalIsSnap    = false;
  mpModalUseBest   = true;
  document.getElementById('mpModalName').value = '';
  document.getElementById('mpModalName').style.borderColor = '';
  document.getElementById('mpSnapNote').style.display = 'none';
  document.getElementById('mpLoaderField').style.display = 'none';
  document.getElementById('mpLoaderVerField').style.display = 'none';
  document.querySelectorAll('#mpLoaderGrid .loader-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.loader === 'vanilla');
    b.disabled = false; b.style.opacity = '';
  });
  [mpVersionDD, mpLoaderVerDD].forEach(dd => { try { dd?.destroy(); } catch {} });
  mpVersionDD = mpLoaderVerDD = null;
  document.getElementById('mpVersionWrap').innerHTML = '';
  document.getElementById('mpLoaderVerWrap').innerHTML = '';
  const oldHint = document.getElementById('mpVerFilterHint');
  if (oldHint) oldHint.remove();
  document.getElementById('mpModalOverlay').classList.add('open');
  updateStaticI18n();
  setTimeout(() => document.getElementById('mpModalName').focus(), 80);

  try {
    const data = await fetchVersionManifest();
    const allVers = [
      ...data.releases.map(v => ({ value: v.value, label: v.label, snap: false })),
      ...data.snapshots.map(v => ({ value: v.value, label: v.label, snap: true })),
    ];

    // If we're creating a modpack for a specific mod — filter versions to only supported ones
    const pendingVers = _pendingAddMod?.gameVersions?.filter(v => /^\d+\.\d+/.test(v)) || [];
    const filteredVers = pendingVers.length
      ? allVers.filter(v => pendingVers.includes(v.value))
      : allVers;

    // Show hint if versions are filtered
    const versionWrap = document.getElementById('mpVersionWrap');
    if (pendingVers.length) {
      let hint = document.getElementById('mpVerFilterHint');
      if (!hint) {
        hint = document.createElement('div');
        hint.id = 'mpVerFilterHint';
        hint.style.cssText = 'font-size:10.5px;color:#5588aa;margin-top:5px;padding:4px 8px;background:#080e18;border:1px solid #1a2a3a;border-radius:6px;';
        versionWrap.parentNode.insertBefore(hint, versionWrap.nextSibling);
      }
      hint.textContent = `🔒 ${t('ver_filter_hint_fmt')} (${filteredVers.length})`;
    }

    const needLoaderFilter = _pendingAddMod?.loaders?.length &&
      ['mod', 'datapack'].includes(_pendingAddMod.projectType || 'mod');
    const supportedLoaders = needLoaderFilter ? _pendingAddMod.loaders : null;

    function applyLoaderRestrictions(isSnap) {
      document.querySelectorAll('#mpLoaderGrid .loader-btn').forEach(b => {
        const loader = b.dataset.loader;
        if (loader === 'vanilla') { b.disabled = false; b.style.opacity = ''; b.title = ''; return; }
        const blockedBySnap = isSnap;
        const blockedByMod  = supportedLoaders && !supportedLoaders.includes(loader);
        b.disabled = blockedBySnap || blockedByMod;
        b.style.opacity = (blockedBySnap || blockedByMod) ? '0.3' : '';
        b.title = blockedByMod ? `${t('mod_no_support')} ${loader}` : '';
      });
      // If current selected loader is now blocked — reset to vanilla
      const activeBtn = document.querySelector(`#mpLoaderGrid .loader-btn[data-loader="${mpModalSelLoader}"]`);
      if (activeBtn?.disabled && mpModalSelLoader !== 'vanilla') {
        mpSelectLoader('vanilla');
      }
    }

    mpVersionDD = createDropdown('mpVersionWrap',
      filteredVers.length ? t('ver_select') : t('ver_no_compat'),
      filteredVers.map(v => ({ value: v.value, label: v.label })),
      val => {
        mpModalSelVer = val;
        const isSnap = filteredVers.find(v => v.value === val)?.snap || false;
        mpModalIsSnap = isSnap;
        document.getElementById('mpSnapNote').style.display = isSnap ? '' : 'none';
        document.getElementById('mpLoaderField').style.display = '';
        applyLoaderRestrictions(isSnap);
        if (!isSnap) mpRefreshLoaderVer();
      },
      { zIndex: 25000 }
    );
  } catch(e) {}
};

window.closeMpModal = function() {
  document.getElementById('mpModalOverlay').classList.remove('open');
  [mpVersionDD, mpLoaderVerDD].forEach(dd => { try { dd?.destroy(); } catch {} });
  mpVersionDD = mpLoaderVerDD = null;
  _pendingAddMod = null;
};

window.mpSelectLoader = function(id) {
  mpModalSelLoader = id;
  document.querySelectorAll('#mpLoaderGrid .loader-btn').forEach(b => b.classList.toggle('active', b.dataset.loader === id));
  if (id === 'vanilla') {
    document.getElementById('mpLoaderVerField').style.display = 'none';
    try { mpLoaderVerDD?.destroy(); } catch {} mpLoaderVerDD = null;
  } else {
    document.getElementById('mpLoaderVerField').style.display = '';
    mpModalUseBest = true;
    document.getElementById('mpBestCheck').checked = true;
    document.getElementById('mpBestRow').classList.add('on');
    try { mpLoaderVerDD?.destroy(); } catch {} mpLoaderVerDD = null;
    document.getElementById('mpLoaderVerWrap').innerHTML = '';
    mpLoaderVerDD = createDropdown('mpLoaderVerWrap', t('select_custom'), [], null, { zIndex: 25000 });
    mpLoaderVerDD.setDisabled(true);
    mpRefreshLoaderVer();
  }
};

window.mpToggleBest = function() {
  mpModalUseBest = !mpModalUseBest;
  document.getElementById('mpBestCheck').checked = mpModalUseBest;
  document.getElementById('mpBestRow').classList.toggle('on', mpModalUseBest);
  mpLoaderVerDD?.setDisabled(mpModalUseBest);
};

async function mpRefreshLoaderVer() {
  if (mpModalSelLoader === 'vanilla' || !mpModalSelVer || !mpLoaderVerDD) return;
  mpLoaderVerDD.setPlaceholder(t('loading'));
  try {
    const versions = await window.electronAPI?.getLoaderVersions({ loader: mpModalSelLoader, mcVersion: mpModalSelVer }) || [];
    if (versions.length) {
      mpLoaderVerDD.setItems(versions.map(v => ({ value: v, label: v })));
      mpLoaderVerDD.setPlaceholder(t('select_custom'));
      mpLoaderVerDD.setDisabled(mpModalUseBest);
    } else {
      mpLoaderVerDD.setPlaceholder(t('loader_unavail'));
    }
  } catch { mpLoaderVerDD.setPlaceholder(t('error_label')); }
}

let _pendingAddMod = null;

// ── Download helper: fetches latest version of a mod and downloads to modpack folder ──
async function downloadModForInstance(mod, mpName, category, mpVersion) {
  const safeInst = mpName.replace(/[\/\\:*?"<>|]/g, '_').trim();
  if (!mod.slug) {
    appendLog(t('dl_fail') + (mod.title||mod.name) + t('dl_no_slug'));
    return;
  }
  if (mod.source !== 'modrinth') {
    // CurseForge mods have a direct URL stored on the mod object — try it
    if (mod.url) {
      try {
        const filename = mod.url.split('/').pop().split('?')[0] || (mod.slug + '.jar');
        appendLog(t('dl_ing') + ' ' + (mod.title||mod.name) + ' → ' + safeInst + '/' + category + '/' + filename);
        await window.electronAPI?.downloadMod({ fileUrl: mod.url, filename, category: category || 'mod', instanceName: safeInst });
        appendLog('✓ ' + (mod.title||mod.name) + ' ' + t('dl_done'));
      } catch(e) { appendLog(t('dl_err') + ' ' + (mod.title||mod.name) + ': ' + e.message); }
    }
    return;
  }
  appendLog(t('dl_vers') + (mod.title||mod.name) + '»...');
  let versions;
  try {
    versions = await window.electronAPI?.getModVersions({ source: 'modrinth', slug: mod.slug });
  } catch(e) {
    appendLog(t('dl_ver_err') + (mod.title||mod.name) + '»: ' + e.message);
    return;
  }
  if (!versions?.length) {
    appendLog(t('dl_no_vers') + (mod.title||mod.name) + '»');
    return;
  }

  // Pick best matching version: prefer matching mpVersion, fallback to latest
  let best = versions[0];
  if (mpVersion) {
    const match = versions.find(v => v.gameVersions?.includes(mpVersion));
    if (match) best = match;
  }
  const file = best.files?.find(f => f.primary) || best.files?.[0];
  if (!file?.url) {
    appendLog(t('dl_no_file') + (mod.title||mod.name) + '»');
    return;
  }

  appendLog(t('dl_ing') + ' ' + file.filename + ' → ' + safeInst + '/' + (category||'mod') + '/');
  try {
    const result = await window.electronAPI?.downloadMod({
      fileUrl: file.url, filename: file.filename,
      category: category || 'mod',
      instanceName: safeInst,
    });
    if (result?.success) {
      appendLog('✓ ' + file.filename + ' ' + t('dl_saved') + ' ' + safeInst);
    } else {
      appendLog(t('dl_err') + ' ' + file.filename + (result?.error ? ': ' + result.error : ''));
    }
  } catch(e) {
    appendLog(t('dl_err') + ' ' + file.filename + ': ' + e.message);
  }
}

window.confirmCreateModpack = function() {
  const name = document.getElementById('mpModalName').value.trim();
  const inp  = document.getElementById('mpModalName');
  if (!name) { inp.style.borderColor='#cc4444'; setTimeout(()=>inp.style.borderColor='',1000); return; }
  if (!mpModalSelVer) { mpVersionDD && document.getElementById('mpVersionWrap').querySelector('.dd-trigger')?.classList.add('has-value'); alert(t('sel_mc_ver2')); return; }
  inp.style.borderColor='';
  const loaderVer = (!mpModalUseBest && mpLoaderVerDD) ? mpLoaderVerDD.getValue() : null;
  const mp = { id: Date.now(), name, version: mpModalSelVer, loader: mpModalSelLoader, loaderVersion: loaderVer, versionType: mpModalIsSnap ? 'snapshot' : 'release', mods: [] };
  // If we came from "create & add" — add the pending mod automatically and download it
  if (_pendingAddMod) {
    const mod = _pendingAddMod;
    _pendingAddMod = null;
    const category = mod._category || mod.projectType || 'mod';
    mp.mods.push({ name: mod.title, slug: mod.slug, source: mod.source, url: mod.url, category });
    // Trigger download asynchronously after modpack is created
    setTimeout(() => downloadModForInstance(mod, mp.name, category, mp.version), 200);
  }
  modpacks.push(mp);
  saveModpacks();
  closeMpModal();
  rebuildCustomDropdown(true);
  switchToMyModpacks();
};
function switchToMyModpacks() {
  // Switch top nav to "Моды"
  const modsMenuItem = document.querySelector('.menu-item[data-target="mods"]');
  if (modsMenuItem) {
    document.querySelectorAll('.menu-item').forEach(x => x.classList.remove('active'));
    modsMenuItem.classList.add('active');
    moveLine(modsMenuItem);
  }
  modsView = 'modpacks';
  loadMods(); // re-renders the mods page with modpacks tab active
}
function saveModpacks() { window.electronAPI?.saveConfig({ modpacks }); }
function mpChangeIcon(mpId) {
  const mp = modpacks.find(m => m.id === mpId);
  if (!mp) return;
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/gif,image/webp';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = e2 => {
      const img = new Image();
      img.onload = () => {
        const size = 80, canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#111115';
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(0,0,size,size,8); ctx.fill(); }
        else ctx.fillRect(0,0,size,size);
        ctx.drawImage(img,0,0,size,size);
        mp.icon = canvas.toDataURL('image/png');
        saveModpacks(); renderModpacksArea();
      };
      img.src = e2.target.result;
    };
    reader.readAsDataURL(file);
  };
  inp.click();
}

function renderModpacksArea() {
  const area = document.getElementById('modsModpacksArea');
  if (!area) return;
  area.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'mp-header';
  header.innerHTML = `<div class="mp-title">${t('my_modpacks')}</div><button class="mp-create-btn" onclick="openMpModal()">${t('mp_create')}</button>`;
  area.appendChild(header);

  if (!modpacks.length) {
    const empty = document.createElement('div');
    empty.className = 'mp-empty';
    empty.innerHTML = t('mp_empty');
    area.appendChild(empty);
    return;
  }

  const list = document.createElement('div'); list.className = 'mp-list';

  modpacks.forEach(mp => {
    const safeName = mp.name.replace(/[\/\\:*?"<>|]/g, '_').trim();
    const card = document.createElement('div'); card.className = 'mp-card';
    card.innerHTML = `
      <div class="mp-card-head">
        <div class="mp-card-icon" onclick="mpChangeIcon(${mp.id})">
          ${mp.icon ? `<img src="${mp.icon}" style="width:40px;height:40px;border-radius:8px;object-fit:cover;" onerror="this.style.display='none'">` : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity:.55"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`}
          <div class="mp-icon-edit"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></div>
        </div>
        <div class="mp-card-meta">
          <div class="mp-card-name-row">
            <div class="mp-card-name" data-nameel="${mp.id}">${mp.name}</div>
            <button class="mp-rename-btn" data-rename="${mp.id}" title="${t('rename')}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          </div>
          <div class="mp-card-sub">${mp.version} · ${LOADER_MAP[mp.loader]||mp.loader} · ${mp.mods.length} ${t('mods_count')}</div>
        </div>
        <div class="mp-card-actions">
          <button class="mp-collapse-btn" data-collapsebtn="${mp.id}" title="${t('mp_toggle')}">▾</button>
          <button class="mp-action-btn mp-folder-btn" title="${t('mp_open_folder')}" data-openfolder="${mp.id}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>
          <button class="mp-action-btn" data-play="${mp.id}">${t('mp_play')}</button>
          <button class="mp-action-btn danger" data-del="${mp.id}">✕</button>
        </div>
      </div>
      <div class="mp-mods-section">
        <div id="mpModList_${mp.id}"></div>
        <div class="mp-add-mod-row">
          <button class="mp-add-mod-btn" data-openaddmod="${mp.id}">${t('mp_add_mods')}</button>
        </div>
      </div>`;

    // Build sectioned mod list
    const modListEl = card.querySelector(`#mpModList_${mp.id}`);
    const sections = [
      { cat: 'mod',          icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`, labelKey: 'tab_mod'          },
      { cat: 'resourcepack', icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`, labelKey: 'tab_resourcepack' },
      { cat: 'shader',       icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`, labelKey: 'tab_shader'       },
      { cat: 'datapack',     icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`, labelKey: 'tab_datapack'     },
    ];
    sections.forEach(sec => {
      const items = mp.mods.map((mod, i) => ({ mod, i })).filter(({ mod }) => (mod.category || 'mod') === sec.cat);
      if (!items.length) return;
      // Section header
      const secHead = document.createElement('div');
      secHead.className = 'mp-section-head';
      secHead.innerHTML = `<span>${sec.icon} ${t(sec.labelKey)}</span><span class="mp-section-count">${items.length}</span>`;
      modListEl.appendChild(secHead);
      items.forEach(({ mod, i }) => {
        const el = document.createElement('div'); el.className = 'mp-mod-item';
        el.innerHTML = `<span class="mp-mod-name">${escHtml(mod.name)}</span><span class="mp-mod-source">${escHtml(mod.source||'')}</span><button class="mp-mod-del" data-delmod="${mp.id}" data-idx="${i}" title="${t('delete_btn')}">✕</button>`;
        modListEl.appendChild(el);
      });
    });

    card.querySelector(`[data-openaddmod]`)?.addEventListener('click', () => openMpAddMod(mp.id));
    card.querySelector(`[data-play]`)?.addEventListener('click', () => doMpPlay(mp.id));
    card.querySelector(`[data-openfolder]`)?.addEventListener('click', () => {
      window.electronAPI?.openMpFolder({ safeName });
    });
    card.querySelector(`[data-del]`)?.addEventListener('click', () => {
      if (activeMpId === mp.id) { appendLog('⚠ ' + t('mp_cant_delete_running')); if (!logOpen) toggleLog(); return; }
      doMpDelete(mp.id);
    });
    card.querySelectorAll('[data-delmod]').forEach(b => b.addEventListener('click', () => doDeleteMod(mp.id, +b.dataset.idx)));
    card.querySelector(`[data-collapsebtn]`)?.addEventListener('click', () => {
      card.classList.toggle('collapsed');
      const btn = card.querySelector('[data-collapsebtn]');
      if (btn) btn.textContent = card.classList.contains('collapsed') ? '▸' : '▾';
    });

    card.querySelector(`[data-rename]`)?.addEventListener('click', e => {
      e.stopPropagation();
      const nameRow = card.querySelector('.mp-card-name-row');
      const nameEl  = card.querySelector(`[data-nameel="${mp.id}"]`);
      const renBtn  = card.querySelector(`[data-rename="${mp.id}"]`);
      if (!nameEl || nameEl.tagName === 'INPUT') return;
      const oldName = mp.name;
      // Replace name div with input inline
      const inp = document.createElement('input');
      inp.className = 'mp-rename-input';
      inp.value = oldName;
      nameEl.replaceWith(inp);
      renBtn.style.opacity = '1';
      inp.focus(); inp.select();
      const commit = () => {
        const val = inp.value.trim() || oldName;
        const newNameEl = document.createElement('div');
        newNameEl.className = 'mp-card-name';
        newNameEl.dataset.nameel = mp.id;
        newNameEl.textContent = val;
        inp.replaceWith(newNameEl);
        renBtn.style.opacity = '';
        if (val !== oldName) { mp.name = val; saveModpacks(); rebuildCustomDropdown(); }
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
        if (ev.key === 'Escape') { inp.value = oldName; inp.blur(); }
      });
    });

    list.appendChild(card);
  });
  area.appendChild(list);
}

// ── Add mod overlay ────────────────────────────────────────────────────────────
let mpAddModTargetId = null;
let mpAddModCategory = 'mod';
let mpAddModQuery    = '';
let mpAddModOffset   = 0;
let mpAddModLoading  = false;
let mpAddModSource   = 'both';
let mpAddModCFAvail  = null;

const MP_ADD_CATEGORIES = [
  { id:'mod',          labelKey:'tab_mod' },
  { id:'resourcepack', labelKey:'tab_resourcepack' },
  { id:'shader',       labelKey:'tab_shader' },
  { id:'datapack',     labelKey:'tab_datapack', subtitleKey:'tab_datapack_sub' },
];

function mpUpdateSubtitle(catId) {
  const cat = MP_ADD_CATEGORIES.find(c => c.id === catId);
  let el = document.getElementById('mpAddModSubtitle');
  if (cat?.subtitle) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'mpAddModSubtitle';
      el.style.cssText = 'font-size:11.5px;color:#484860;margin:-4px 0 8px;padding:6px 10px;background:#0d0d12;border:1px solid #181820;border-radius:7px;line-height:1.5;flex-shrink:0;';
      const grid = document.getElementById('mpAddModGrid');
      grid?.parentNode.insertBefore(el, grid);
    }
    el.textContent = '💡 ' + cat.subtitle;
    el.style.display = '';
  } else if (el) {
    el.style.display = 'none';
  }
}

function openMpAddMod(mpId) {
  mpAddModTargetId = mpId;
  mpAddModQuery    = '';
  mpAddModOffset   = 0;
  mpAddModCategory = 'mod';
  mpAddModSource   = 'both';
  mpAddModCFAvail  = null;

  const mp = modpacks.find(m => m.id === mpId);
  document.getElementById('mpAddModTitle').textContent = `${t('mp_add_title')} → ${mp?.name||''}`;

  // Build category tabs
  const tabsEl = document.getElementById('mpAddModTabs');
  tabsEl.innerHTML = MP_ADD_CATEGORIES.map(c => {
    const isVanillaLocked = mp?.loader === 'vanilla' && c.id !== 'datapack' && c.id !== 'resourcepack' && c.id !== 'shader';
    return `<div class="mods-tab${c.id===mpAddModCategory?' active':''}${isVanillaLocked?' disabled-tab':''}" data-amcat="${c.id}" title="${isVanillaLocked?t('vanilla_no_mods'):''}">` +
      t(c.labelKey) + (isVanillaLocked ? ' 🔒' : '') + '</div>';
  }).join('');
  tabsEl.addEventListener('click', e => {
    const tab = e.target.closest('[data-amcat]');
    if (!tab) return;
    if (tab.classList.contains('disabled-tab')) return; // blocked for vanilla
    const newCat = tab.dataset.amcat;
    const mp = modpacks.find(m => m.id === mpAddModTargetId);
    // Remove old vanilla lock on grid
    const gridWrap = document.getElementById('mpAddModGrid').parentNode;
    gridWrap.classList.remove('vanilla-lock-wrap');
    gridWrap.querySelector('.vanilla-lock-overlay')?.remove();
    mpAddModCategory = newCat;
    tabsEl.querySelectorAll('.mods-tab').forEach(x => x.classList.toggle('active', x.dataset.amcat === mpAddModCategory));
    mpUpdateSubtitle(mpAddModCategory);
    mpAddModQuery = document.getElementById('mpAddModInput').value.trim();
    mpAddModDoSearch();
  });

  // Source toggle
  const srcToggle = document.getElementById('mpAddModSourceToggle');
  srcToggle.style.display = 'none';
  srcToggle.querySelectorAll('.src-btn').forEach(b => b.classList.toggle('active', b.dataset.src === 'both'));
  srcToggle.addEventListener('click', e => {
    const b = e.target.closest('.src-btn'); if (!b) return;
    mpAddModSource = b.dataset.src;
    srcToggle.querySelectorAll('.src-btn').forEach(x => x.classList.toggle('active', x.dataset.src === mpAddModSource));
    mpAddModDoSearch();
  });

  // Search
  document.getElementById('mpAddModInput').value = '';
  document.getElementById('mpAddModSearchBtn').onclick = () => { mpAddModQuery = document.getElementById('mpAddModInput').value.trim(); mpAddModDoSearch(); };
  document.getElementById('mpAddModInput').onkeydown = e => { if(e.key==='Enter') { mpAddModQuery = e.target.value.trim(); mpAddModDoSearch(); } };
  let _mpAddSearchTimer = null;
  document.getElementById('mpAddModInput').oninput = e => {
    clearTimeout(_mpAddSearchTimer);
    _mpAddSearchTimer = setTimeout(() => { mpAddModQuery = e.target.value.trim(); mpAddModDoSearch(); }, 350);
  };

  document.getElementById('mpAddModGrid').innerHTML = `<div class="mods-loading">${t('loading')}</div>`;
  document.getElementById('mpAddModOverlay').classList.add('open');
  mpUpdateSubtitle(mpAddModCategory);
  // For vanilla, auto-switch to datapack tab (mods tab is disabled)
  if (mp?.loader === 'vanilla') {
    mpAddModCategory = 'datapack';
    document.querySelectorAll('#mpAddModTabs .mods-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.amcat === 'datapack');
    });
  }
  mpAddModDoSearch();
}

window.closeMpAddMod = () => {
  document.getElementById('mpAddModOverlay').classList.remove('open');
  const sub = document.getElementById('mpAddModSubtitle');
  if (sub) sub.style.display = 'none';
  mpAddModTargetId = null;
  // Remove stale listeners by cloning
  const old = document.getElementById('mpAddModTabs');
  const clone = old.cloneNode(false);
  old.parentNode.replaceChild(clone, old);
};

async function mpAddModDoSearch(append = false) {
  if (mpAddModLoading) return;
  mpAddModLoading = true;
  const grid = document.getElementById('mpAddModGrid');
  if (!grid) { mpAddModLoading = false; return; }
  if (!append) {
    mpAddModOffset = 0;
    grid.innerHTML = `<div class="mods-loading">${t('loading')}</div>`;
  } else {
    document.getElementById('mpAddModLoadMore')?.remove();
    const sp = document.createElement('div');
    sp.className = 'mods-loading'; sp.id = 'mpAddModSpinner'; sp.textContent = t('loading');
    grid.appendChild(sp);
  }
  try {
    const res = await window.electronAPI?.searchMods({
      query: mpAddModQuery, category: mpAddModCategory,
      limit: MODS_LIMIT, offset: mpAddModOffset, gameVersion: '',
    }) || { items: [], cfAvailable: false };

    if (mpAddModCFAvail === null) {
      mpAddModCFAvail = res.cfAvailable;
      const toggle = document.getElementById('mpAddModSourceToggle');
      if (toggle) toggle.style.display = mpAddModCFAvail ? 'flex' : 'none';
    }

    let items = res.items || [];
    if (mpAddModSource === 'modrinth')   items = items.filter(m => m.source === 'modrinth');
    if (mpAddModSource === 'curseforge') items = items.filter(m => m.source === 'curseforge');

    if (!append) grid.innerHTML = '';
    document.getElementById('mpAddModSpinner')?.remove();

    if (!items.length && !append) {
      grid.innerHTML = `<div class="mods-empty">${t('dd_empty')}</div>`;
    } else {
      items.forEach(mod => grid.appendChild(renderModRowForAdd(mod)));
      if (items.length >= Math.floor(MODS_LIMIT / 2)) {
        const btn = document.createElement('button');
        btn.className = 'mods-load-more'; btn.id = 'mpAddModLoadMore';
        btn.textContent = t('load_more');
        btn.addEventListener('click', () => { mpAddModOffset += items.length; mpAddModDoSearch(true); });
        grid.appendChild(btn);
      }
    }
  } catch(e) {
    document.getElementById('mpAddModSpinner')?.remove();
    if (!append) grid.innerHTML = `<div class="mods-empty">${t('error_label')}: ${e.message}</div>`;
  }
  mpAddModLoading = false;
}

function checkModCompat(mod, mp) {
  if (!mp) return { ok: true };
  const catNeedsLoader = ['mod', 'shader'].includes(mpAddModCategory || mod.projectType || 'mod');
  const verOk    = !mod.gameVersions?.length || mod.gameVersions.includes(mp.version);
  const loaderOk = !catNeedsLoader || !mod.loaders?.length || mod.loaders.includes(mp.loader);
  if (verOk && loaderOk) return { ok: true };
  const parts = [];
  if (!verOk)    parts.push(`${t('compat_versions')}: ${(mod.gameVersions||[]).filter(v => !v.includes('w') && !v.includes('-')).slice(0,4).join(', ')||'—'}`);
  if (!loaderOk) parts.push(`${t('compat_loaders')}: ${(mod.loaders||[]).join(', ')||'—'}`);
  return { ok: false, msg: t('incompatible_label') + ' — ' + parts.join(', ') };
}

function renderModRowForAdd(mod) {
  const mp = modpacks.find(m => m.id === mpAddModTargetId);
  const alreadyAdded = mp?.mods.some(m => m.slug === mod.slug && m.source === mod.source);
  const compat = alreadyAdded ? {ok:true} : checkModCompat(mod, mp);

  const row = document.createElement('div');
  row.className = 'mod-row';
  const iconEl = mod.icon
    ? (() => { const i = document.createElement('img'); i.className='mod-row-icon'; i.alt=''; i.src=mod.icon; i.onerror=()=>{ const ph=document.createElement('div'); ph.className='mod-row-icon-ph'; ph.innerHTML=MOD_PH_SVG; i.replaceWith(ph); }; return i; })()
    : (() => { const ph=document.createElement('div'); ph.className='mod-row-icon-ph'; ph.innerHTML=MOD_PH_SVG; return ph; })();
  const date = mod.updated ? new Date(mod.updated).toLocaleDateString('ru-RU', { day:'numeric', month:'short', year:'numeric' }) : '';
  const meta = [mod.author||'', fmtDownloads(mod.downloads), date].filter(Boolean).join(' · ');
  row.innerHTML = `
    <div class="mod-row-icon-wrap"></div>
    <div class="mod-row-info" style="cursor:pointer">
      <div class="mod-row-title">${mod.title}</div>
      ${mod.desc ? `<div class="mod-row-desc">${mod.desc}</div>` : ''}
      <div class="mod-row-meta">${meta}</div>
    </div>
    <div class="mod-row-actions">
      <button class="mod-add-btn${alreadyAdded?' added':''}${!compat.ok?' incompat':''}">
        ${alreadyAdded ? t('added') : t('add_btn')}
      </button>
    </div>`;
  row.querySelector('.mod-row-info').addEventListener('click', () => openModDetail(mod));
  row.querySelector('.mod-row-icon-wrap').replaceWith(iconEl);
  const addBtn = row.querySelector('.mod-add-btn');
  if (!compat.ok) {
    addBtn.style.cssText = 'background:#1a0a08;border-color:#cc332233;color:#885555;cursor:not-allowed;';
    addBtn.title = compat.msg;
    addBtn.disabled = true;
  } else if (!alreadyAdded) {
    addBtn.addEventListener('click', async () => {
      const target = modpacks.find(m => m.id === mpAddModTargetId);
      if (!target) return;
      const category = mod.projectType || mpAddModCategory || 'mod';
      target.mods.push({ name: mod.title, slug: mod.slug, source: mod.source, url: mod.url, category });
      saveModpacks();
      addBtn.textContent = '⏳';
      addBtn.disabled = true;
      addBtn.className = 'mod-add-btn added';
      const sub = document.querySelector(`#mpModList_${target.id}`)?.closest('.mp-card')?.querySelector('.mp-card-sub');
      if (sub) sub.textContent = `${target.version} · ${LOADER_MAP[target.loader]||target.loader} · ${target.mods.length} ${t('mods_count')}`;
      await downloadModForInstance(mod, target.name, category, target.version);
      addBtn.textContent = t('added');
    });
  }
  return row;
}
function doDeleteMod(id, i) { const mp=modpacks.find(m=>m.id===id); if(!mp) return; mp.mods.splice(i,1); saveModpacks(); renderModpacksArea(); }
function doMpDelete(id) {
  const mp = modpacks.find(m => m.id === id);
  const name = mp ? `«${mp.name}»` : t('this_modpack');
  const overlay = document.getElementById('stopConfirmOverlay');
  document.getElementById('scIcon').textContent  = '🗑️';
  document.getElementById('scTitle').textContent = `${t('delete_btn')} ${name}?`;
  document.getElementById('scDesc').innerHTML    = t('delete_mp_desc');
  document.getElementById('scConfirmBtn').textContent = t('delete_btn');
  document.getElementById('scConfirmBtn').onclick = () => {
    modpacks = modpacks.filter(m => m.id !== id);
    saveModpacks();
    renderModpacksArea();
    rebuildCustomDropdown(true);
    closeStopConfirm();
    document.getElementById('scConfirmBtn').onclick = null;
  };
  document.getElementById('scCancelBtn').onclick = () => { closeStopConfirm(); document.getElementById('scConfirmBtn').onclick = null; };
  overlay.classList.add('open');
}

// ── Mod detail overlay ────────────────────────────────────────────────────────
let _detailMod = null;
let _detailData = null;
let _detailTab = 'desc';

function openLightbox(src, caption) {
  const lb = document.getElementById('imgLightbox');
  document.getElementById('imgLightboxImg').src = src;
  document.getElementById('imgLightboxCaption').textContent = caption;
  lb.style.display = 'flex';
}
function closeLightbox() {
  document.getElementById('imgLightbox').style.display = 'none';
  document.getElementById('imgLightboxImg').src = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

window.closeModDetail = () => {
  document.getElementById('modDetailOverlay').classList.remove('open');
  _detailMod = null; _detailData = null;
};
document.getElementById('modDetailOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modDetailOverlay')) closeModDetail();
});
document.getElementById('modDetailTabs').addEventListener('click', e => {
  const tab = e.target.closest('.md-tab'); if (!tab) return;
  _detailTab = tab.dataset.mdtab;
  document.querySelectorAll('.md-tab').forEach(x => x.classList.toggle('active', x.dataset.mdtab === _detailTab));
  renderDetailBody();
});

// ── Semantic version comparator (descending) ─────────────────────────────────
function semverDesc(a, b) {
  const pa = String(a).split('.').map(x => parseInt(x)||0);
  const pb = String(b).split('.').map(x => parseInt(x)||0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pb[i]||0) - (pa[i]||0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── Smart MC version display ──────────────────────────────────────────────────
function compressMcVersions(rawVersions) {
  // Filter out snapshots (contain letters like 'w', or '-')
  const releases = (rawVersions||[]).filter(v => /^\d+\.\d+(\.\d+)?$/.test(v));
  if (!releases.length) return [];
  // Group by minor (1.21, 1.20 etc)
  const groups = {};
  releases.forEach(v => {
    const m = v.match(/^(\d+\.\d+)/);
    if (!m) return;
    const minor = m[1];
    if (!groups[minor]) groups[minor] = [];
    groups[minor].push(v);
  });
  // Sort group keys descending (1.21 > 1.20 > 1.19 ...)
  const sortedMinors = Object.keys(groups).sort(semverDesc);
  const result = [];
  sortedMinors.forEach(minor => {
    const vers = groups[minor];
    const patches = vers.map(v => { const p = v.split('.')[2]; return p === undefined ? 0 : parseInt(p)||0; });
    const maxPatch = Math.max(...patches);
    const expected = Array.from({length: maxPatch + 1}, (_, i) => i === 0 ? minor : `${minor}.${i}`);
    const hasAll = expected.every(e => vers.includes(e));
    if (hasAll && vers.length >= 2) {
      result.push(minor + '.x');
    } else {
      vers.sort(semverDesc);
      result.push(...vers);
    }
  });
  return result;
}

// ── Env label helpers ─────────────────────────────────────────────────────────
const ENV_LABELS = {
  required:    { get label(){ return t('env_required'); }, cls: '' },
  optional:    { get label(){ return t('env_optional'); }, cls: '' },
  unsupported: { get label(){ return t('env_unsupported'); }, cls: '' },
  unknown:     { label: '—', cls: '' },
};
const MOD_PH_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="opacity:.45"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
const LOADER_ICONS = { fabric:'🧵', forge:'⚒', neoforge:'🔩', quilt:'🪡', vanilla:'🍦', datapack:'📦' };

// ── Category translations ─────────────────────────────────────────────────────
const CAT_RU = {
  // gameplay
  'adventure':          t('cat_adventure'),
  'combat':             t('cat_combat'),
  'decoration':         t('cat_decoration'),
  'economy':            t('cat_economy'),
  'equipment':          t('cat_equipment'),
  'food':               t('cat_food'),
  'game-mechanics':     t('cat_game_mechanics'),
  'library':            t('cat_library'),
  'magic':              t('cat_magic'),
  'management':         t('cat_management'),
  'minigame':           t('cat_minigame'),
  'mobs':               t('cat_mobs'),
  'optimization':       t('cat_optimization'),
  'social':             t('cat_social'),
  'storage':            t('cat_storage'),
  'technology':         t('cat_technology'),
  'transportation':     t('cat_transport'),
  'utility':            t('cat_utility'),
  'worldgen':           t('cat_worldgen'),
  'biomes':             t('cat_biome'),
  'structures':         t('cat_structure'),
  'dimensions':         t('cat_dimension'),
  'cursed':             t('cat_cursed'),
  'quests':             t('cat_quests'),
  'building':           t('cat_building'),
  'misc':               t('cat_misc'),
  // shaders / resource
  'atmosphere':         t('sh_atmosphere'),
  'bloom':              t('sh_bloom'),
  'cartoon':            t('sh_cartoon'),
  'colored-lighting':   t('sh_colored_light'),
  'fantasy':            t('sh_fantasy'),
  'foliage':            t('sh_foliage'),
  'high':               t('sh_high'),
  'low':                t('sh_low'),
  'medium':             t('sh_medium'),
  'path-tracing':       t('sh_path_tracing'),
  'pbr':                'PBR',
  'realistic':          t('sh_realism'),
  'reflections':        t('sh_reflections'),
  'semi-realistic':     t('sh_semi_realism'),
  'shadows':            t('sh_shadows'),
  'vanilla-like':       t('sh_vanilla'),
  // modpacks
  'hardcore':           t('sh_hardcore'),
  'lightweight':        t('sh_potato'),
  'multiplayer':        t('mp_multiplayer'),
  'singleplayer':       t('mp_singleplayer'),
  // extra
  'nope':               'Nope',
};
function translateCat(c) {
  const lang = settingsDraft?.language || config?.settings?.language || 'ru';
  const key = c.toLowerCase();
  if (lang === 'ru' || lang === 'uk') return CAT_RU[key] || (c.charAt(0).toUpperCase() + c.slice(1));
  // For other languages use English-formatted category names
  const CAT_EN = {
    'adventure':'Adventure','combat':'Combat','decoration':'Decoration',
    'economy':'Economy','equipment':'Equipment','food':'Food',
    'game-mechanics':'Game Mechanics','library':'Library','magic':'Magic',
    'management':'Management','minigame':'Minigame','mobs':'Mobs',
    'optimization':'Optimization','social':'Social','storage':'Storage',
    'technology':'Technology','transportation':'Transportation',
    'utility':'Utility','worldgen':'World Gen','biomes':'Biomes',
    'structures':'Structures','dimensions':'Dimensions','cursed':'Cursed',
    'quests':'Quests','building':'Building','misc':'Misc',
    'atmosphere':'Atmosphere','bloom':'Bloom','cartoon':'Cartoon',
    'colored-lighting':'Colored Lighting','fantasy':'Fantasy',
    'foliage':'Foliage','high':'High Quality','low':'Low Quality',
    'medium':'Medium Quality','path-tracing':'Path Tracing','pbr':'PBR',
    'realistic':'Realistic','reflections':'Reflections',
    'semi-realistic':'Semi-realistic','shadows':'Shadows',
    'vanilla-like':'Vanilla-like','hardcore':'Hardcore',
    'lightweight':'Lightweight','multiplayer':'Multiplayer','singleplayer':'Singleplayer',
  };
  return CAT_EN[key] || (c.charAt(0).toUpperCase() + c.slice(1));
}

// SVG icons for env display
const SVG_MONITOR = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-2px;margin-right:5px"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
const SVG_SERVER  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-2px;margin-right:5px"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="18" r="1" fill="currentColor" stroke="none"/></svg>`;
const SVG_BOTH    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-2px;margin-right:5px"><rect x="1" y="3" width="13" height="9" rx="1.5"/><line x1="4" y1="15" x2="10" y2="15"/><line x1="7" y1="12" x2="7" y2="15"/><rect x="16" y="2" width="7" height="5" rx="1"/><rect x="16" y="10" width="7" height="5" rx="1"/><circle cx="17.7" cy="4.5" r=".8" fill="currentColor" stroke="none"/><circle cx="17.7" cy="12.5" r=".8" fill="currentColor" stroke="none"/></svg>`;

function renderEnvSection(clientSide, serverSide) {
  if (!clientSide && !serverSide) return '';
  const cs = clientSide||'unknown', ss = serverSide||'unknown';
  let envTag = '', envCls = '', icon = SVG_MONITOR;
  if (cs === 'required' && ss === 'required')         { envTag = t('env_both');         envCls = 'both';   icon = SVG_BOTH; }
  else if (cs === 'required' && ss === 'unsupported') { envTag = t('env_client_only');            envCls = 'client'; icon = SVG_MONITOR; }
  else if (cs === 'unsupported' && ss === 'required') { envTag = t('env_server_only');            envCls = 'server'; icon = SVG_SERVER; }
  else if (cs === 'required')                          { envTag = t('env_client_optional'); envCls = 'client'; icon = SVG_MONITOR; }
  else if (ss === 'required')                          { envTag = t('env_server_optional'); envCls = 'server'; icon = SVG_SERVER; }
  else if (cs !== 'unsupported' || ss !== 'unsupported') { envTag = t('env_both_optional'); envCls = 'both'; icon = SVG_BOTH; }
  if (!envTag) return '';
  return `<div class="md-section-title">${t('filter_env')}</div>
    <div class="md-env-row"><span class="md-env-tag ${envCls}">${icon}${envTag}</span></div>`;
}

function renderDetailBody() {
  const body = document.getElementById('modDetailBody');
  if (!_detailData) { body.innerHTML = `<div class="mods-loading">${t('loading')}</div>`; return; }
  const d = _detailData;

  if (_detailTab === 'desc') {
    const loaders   = d.loaders || [];
    const loaderHTML = loaders.map(l => {
      const cls = l.toLowerCase();
      const icon = LOADER_ICONS[cls] || '🔧';
      return `<span class="md-loader-tag ${cls}">${icon} ${l.charAt(0).toUpperCase()+l.slice(1)}</span>`;
    }).join('');
    const catTags = (d.categories||[]).map(c => `<span class="md-tag">${translateCat(c)}</span>`).join('');
    const smartVers = compressMcVersions(d.gameVersions);
    const verSample = smartVers.slice(0,10).map(v =>
      v.endsWith('.x') ? `<span class="md-tag ver" style="font-weight:600">${v}</span>` : `<span class="md-tag ver">${v}</span>`
    ).join('');
    const moreVer = smartVers.length > 10 ? `<span class="md-tag">+${smartVers.length-10}</span>` : '';
    const envHtml = renderEnvSection(d.clientSide, d.serverSide);

    const isModpackType = d.projectType === 'modpack';
    body.innerHTML = `
      <div class="md-action-row">
        ${isModpackType
          ? `<button class="md-btn-primary" id="mdBtnAddToMp">${t('dl_modpack')}</button>`
          : `<button class="md-btn-primary" id="mdBtnAddToMp">${t('add_modpack')}</button>`}
        <button class="md-btn-secondary" id="mdBtnExternal">Открыть на Modrinth ↗</button>
      </div>
      ${loaderHTML ? `<div class="md-section-title">${t('platforms')}</div><div>${loaderHTML}</div>` : ''}
      ${envHtml}
      ${catTags ? `<div class="md-section-title">${t('categories')}</div><div>${catTags}</div>` : ''}
      ${verSample ? `<div class="md-section-title">${t('mc_versions2')}</div><div>${verSample}${moreVer}</div>` : ''}
      <div class="md-section-title">${t('description')}</div>
      <div class="md-desc">${d.description || '—'}</div>`;
    body.querySelector('#mdBtnAddToMp')?.addEventListener('click', () => {
      if (isModpackType) {
        const fakeBtn = body.querySelector('#mdBtnAddToMp');
        openModpackVersionPicker(_detailData, fakeBtn);
        return;
      }
      if (mpAddModTargetId) {
        // We're already inside the add-mod overlay — add directly
        const target = modpacks.find(m => m.id === mpAddModTargetId);
        if (!target) return;
        const mod = _detailMod;
        const category = mod.projectType || mpAddModCategory || 'mod';
        if (!target.mods.some(m => m.slug === mod.slug && m.source === mod.source)) {
          target.mods.push({ name: mod.title, slug: mod.slug, source: mod.source, url: mod.url, category });
          saveModpacks();
          downloadModForInstance(mod, target.name, category, target.version);
        }
        closeModDetail();
        // Refresh the grid row
        document.querySelectorAll('#mpAddModGrid .mod-add-btn').forEach(btn => {
          const row = btn.closest('.mod-row');
          if (row && btn.textContent.trim() !== t('added')) {
            // re-render will handle it on next search, just close
          }
        });
        mpAddModDoSearch();
      } else {
        openMpPicker(_detailMod);
      }
    });
    body.querySelector('#mdBtnExternal')?.addEventListener('click', () => window.electronAPI?.openExternal(d.url));

  } else if (_detailTab === 'versions') {
    if (!d._versions) {
      body.innerHTML = `<div class="mods-loading">${t('loading')}</div>`;
      window.electronAPI?.getModVersions({ source: d.source, slug: d.slug }).then(vers => {
        d._versions = vers || []; renderDetailBody();
      });
      return;
    }
    if (!d._versions.length) { body.innerHTML = `<div class="mods-empty">${t('no_versions')}</div>`; return; }

    const sortedVers = [...d._versions].sort((a, b) => semverDesc(a.name, b.name));

    // Header row
    body.innerHTML = `
      <div class="md-ver-row" style="background:transparent;border:none;padding:4px 14px;margin-bottom:2px;">
        <span style="font-size:10px;color:#404058;text-transform:uppercase;letter-spacing:.08em;flex:1">Версия</span>
        <span style="font-size:10px;color:#404058;text-transform:uppercase;letter-spacing:.08em;width:80px">Загрузчик</span>
        <span style="font-size:10px;color:#404058;text-transform:uppercase;letter-spacing:.08em;width:80px">Minecraft</span>
        <span style="width:130px"></span>
      </div>
      <div class="md-versions-list"></div>`;
    const list = body.querySelector('.md-versions-list');
    sortedVers.forEach(v => {
      const row = document.createElement('div'); row.className = 'md-ver-row';
      const releaseVers = (v.gameVersions||[]).filter(gv => /^\d+\.\d+(\.\d+)?$/.test(gv));
      const mcDisplay = releaseVers.slice(0,3).join(', ') || (v.gameVersions||[]).slice(0,2).join(', ') || '—';
      const isModpack = d.projectType === 'modpack';
      row.innerHTML = `
        <span class="md-ver-name" style="flex:1">${v.name}</span>
        <span class="md-ver-loaders" style="width:80px">${(v.loaders||[]).join(', ')||'—'}</span>
        <span class="md-ver-mc" style="width:80px">${mcDisplay}</span>
        <span class="md-ver-actions" style="width:130px;display:flex;gap:5px;justify-content:flex-end"></span>`;
      const actions = row.querySelector('.md-ver-actions');
      const file = (v.files||[]).find(f=>f.primary) || v.files?.[0];
      if (file) {
        if (isModpack) {
          // For modpacks: download button
          const dlBtn = document.createElement('button');
          dlBtn.className = 'mod-dl-btn'; dlBtn.style.fontSize='11px'; dlBtn.style.padding='4px 8px';
          dlBtn.textContent = t('download');
          dlBtn.addEventListener('click', () => mdVerDownloadModpack(d, v, dlBtn));
          actions.appendChild(dlBtn);
        } else {
          // For mods: download + add to modpack
          const dlBtn = document.createElement('button');
          dlBtn.className = 'mod-dl-btn'; dlBtn.style.fontSize='11px'; dlBtn.style.padding='4px 8px';
          dlBtn.textContent = t('download');
          dlBtn.addEventListener('click', async () => {
            dlBtn.textContent = '...'; dlBtn.disabled = true;
            try {
              dlBtn.dataset.dlfile = file.filename;
              // Download to modpack versioned folder if we're inside mpAddMod overlay
              const _mpName = mpAddModTargetId
                ? modpacks.find(m => m.id === mpAddModTargetId)?.name
                : null;
              const _safeMp = _mpName?.replace(/[\/\\:*?"<>|]/g, '_').trim() || null;
              await window.electronAPI?.downloadMod({
                fileUrl: file.url, filename: file.filename,
                category: mpAddModTargetId ? mpAddModCategory : modsCategory,
                ...(  _safeMp ? { instanceName: _safeMp } : {})
              });
              dlBtn.textContent = '✓'; dlBtn.className = 'mod-dl-btn done';
            } catch { dlBtn.textContent = '✗'; dlBtn.className = 'mod-dl-btn error'; dlBtn.disabled=false; }
          });
          const addBtn = document.createElement('button');
          addBtn.className = 'mod-dl-btn'; addBtn.style.fontSize='11px'; addBtn.style.padding='4px 8px';
          addBtn.textContent = t('add_modpack2');
          addBtn.addEventListener('click', () => {
            const modWithVer = { ...d, _specificVersion: v };
            openMpPicker(modWithVer);
          });
          actions.appendChild(dlBtn);
          actions.appendChild(addBtn);
        }
      }
      list.appendChild(row);
    });

  } else if (_detailTab === 'gallery') {
    if (!d.gallery?.length) { body.innerHTML = `<div class="mods-empty">${t('gallery_empty')}</div>`; return; }
    body.innerHTML = '<div class="md-gallery"></div>';
    const gal = body.querySelector('.md-gallery');
    d.gallery.forEach(img => {
      const el = document.createElement('img');
      el.src = img.url; el.title = img.title || '';
      el.addEventListener('click', () => openLightbox(img.url, img.title || ''));
      gal.appendChild(el);
    });
  } else if (_detailTab === 'changelog') {
    if (!d._versions) {
      body.innerHTML = `<div class="mods-loading">${t('loading')}</div>`;
      window.electronAPI?.getModVersions({ source: d.source, slug: d.slug }).then(vers => {
        d._versions = vers || []; renderDetailBody();
      });
      return;
    }
    if (!d._versions.length) { body.innerHTML = `<div class="mods-empty">${t('no_data')}</div>`; return; }
    const entries = d._versions.filter(v => v.changelog?.trim()).slice(0, 30);
    if (!entries.length) { body.innerHTML = `<div class="mods-empty">${t('changelog_na')}</div>`; return; }
    body.innerHTML = '<div class="md-changelog"></div>';
    const cl = body.querySelector('.md-changelog');
    entries.forEach(v => {
      const sec = document.createElement('div');
      sec.className = 'md-cl-entry';
      const date = v.datePublished ? new Date(v.datePublished).toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric'}) : '';
      const loaders = (v.loaders||[]).join(', ');
      const mcVers = (v.gameVersions||[]).filter(gv=>/^\d+\.\d+/.test(gv)).slice(0,4).join(', ');
      // Convert markdown-like changelog to HTML
      const clHtml = (v.changelog||'')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
        .replace(/^#{1,3}\s+(.+)$/gm,'<div class="md-cl-h">$1</div>')
        .replace(/^[-*]\s+(.+)$/gm,'<div class="md-cl-li">• $1</div>')
        .replace(/\n{2,}/g,'</p><p>')
        .replace(/\n/g,'<br>');
      sec.innerHTML = `<div class="md-cl-head">
        <span class="md-cl-ver">${v.name}</span>
        <span class="md-cl-date">${date}</span>
        <span class="md-cl-meta">${[loaders,mcVers].filter(Boolean).join(' · ')}</span>
      </div>
      <div class="md-cl-body"><p>${clHtml}</p></div>`;
      cl.appendChild(sec);
    });
  }
}

async function openModDetail(mod) {
  _detailMod = mod; _detailData = null; _detailTab = 'desc';
  document.querySelectorAll('.md-tab').forEach(el => el.classList.toggle('active', el.dataset.mdtab === 'desc'));
  const iconEl = document.getElementById('modDetailIcon');
  iconEl.src = mod.icon||''; iconEl.style.display = mod.icon ? '' : 'none';
  document.getElementById('modDetailTitle').textContent = mod.title;
  document.getElementById('modDetailAuthor').textContent = mod.author ? 'by ' + mod.author : '';
  document.getElementById('modDetailDownloads').textContent = fmtDownloads(mod.downloads);
  const upd = mod.updated ? new Date(mod.updated).toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric'}) : '';
  document.getElementById('modDetailUpdated').textContent = upd ? t('updated') + ' ' + upd : '';
  document.getElementById('modDetailBody').innerHTML = `<div class="mods-loading">${t('loading')}</div>`;
  document.getElementById('modDetailOverlay').classList.add('open');
  if (mod.source === 'modrinth') {
    const data = await window.electronAPI?.getModDetails?.({ source: mod.source, slug: mod.slug });
    if (!document.getElementById('modDetailOverlay').classList.contains('open')) return;
    _detailData = data ? { ...mod, ...data } : mod;
  } else {
    _detailData = mod;
  }
  renderDetailBody();
}

// ── Modpack picker ────────────────────────────────────────────────────────────
let _pickerMod = null;

function checkModCompatForMp(mod, mp) {
  const type = mod.projectType || 'mod';
  const isLoaderSensitive = ['mod', 'datapack'].includes(type);
  const isVersionSensitive = true; // all types respect version

  const verOk    = !mod.gameVersions?.length || mod.gameVersions.includes(mp.version);
  const loaderOk = !isLoaderSensitive || !mod.loaders?.length || mod.loaders.includes(mp.loader);

  return {
    ok: verOk && loaderOk,
    verOk,
    loaderOk,
    verMsg:    !verOk    ? `версии: ${(mod.gameVersions||[]).filter(v=>/^\d/.test(v)).slice(0,5).join(', ')||'—'}` : '',
    loaderMsg: !loaderOk ? (mod.loaders||[]).join(', ')||'—' : '',
  };
}

window.closeMpPicker = () => { document.getElementById('mpPickerOverlay').classList.remove('open'); _pickerMod = null; };
document.getElementById('mpPickerOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('mpPickerOverlay')) closeMpPicker();
});

function openMpPicker(mod) {
  _pickerMod = mod;
  // Close mod detail if open so it doesn't linger behind
  closeModDetail();
  document.getElementById('mpPickerTitle').textContent = t('add_mod_to_mp').replace('{name}', mod.title);
  const list = document.getElementById('mpPickerList');
  list.innerHTML = '';
  if (!modpacks.length) {
    list.innerHTML = `<div id="mpPickerEmpty">${t('picker_no_mp')}</div>`;
    document.getElementById('mpPickerOverlay').classList.add('open');
    return;
  }

  let anyShown = false;
  modpacks.forEach(mp => {
    const compat = checkModCompatForMp(mod, mp);
    const alreadyIn = mp.mods.some(m => m.slug === mod.slug && m.source === mod.source);

    // Version mismatch — skip entirely (hide from list)
    if (!compat.verOk && !alreadyIn) return;

    anyShown = true;
    // Loader mismatch — show red/disabled
    const loaderIncompat = !compat.loaderOk && !alreadyIn;

    const item = document.createElement('div');
    item.className = 'mp-picker-item' + (loaderIncompat ? ' loader-incompat' : '');
    item.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div class="mp-picker-name">${mp.name}</div>
        <div class="mp-picker-sub">${mp.version} · ${LOADER_MAP[mp.loader]||mp.loader} · ${mp.mods.length} мод${mp.mods.length===1?'':'ов'}</div>
        ${loaderIncompat ? `<div class="mp-picker-warn" style="color:#cc4444">${t('incompat_loader')} ${compat.loaderMsg}</div>` : ''}
      </div>
      <button class="mp-picker-add${alreadyIn?' added':''}${loaderIncompat?' disabled':''}"
        ${loaderIncompat ? `disabled title="${t('incompat_loader2')}"` : ''}
      >${alreadyIn?t('added'):loaderIncompat?t('incompatible_loader'):t('add_btn')}</button>`;
    const addBtn = item.querySelector('.mp-picker-add');
    if (!alreadyIn && !loaderIncompat) {
      addBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const category = mod.projectType || modsCategory || mpAddModCategory || 'mod';
        mp.mods.push({ name: mod.title, slug: mod.slug, source: mod.source, url: mod.url, category });
        saveModpacks();
        addBtn.textContent = '⏳';
        addBtn.disabled = true;
        addBtn.className = 'mp-picker-add added';
        await downloadModForInstance(mod, mp.name, category, mp.version);
        addBtn.textContent = t('added');
      });
    }
    list.appendChild(item);
  });

  if (!anyShown) {
    list.innerHTML = `<div id="mpPickerEmpty" style="color:#604040">${t('no_compat_ver')}<br><span style="font-size:11px;color:#484860">${t('filter_version')}: ` +
      (mod.gameVersions||[]).filter(v=>/^\d/.test(v)).slice(0,6).join(', ') + '</span></div>';
  }

  // Remove old "create & add" button if it exists (prevents duplication)
  const oldCreateItem = document.getElementById('mpPickerCreateAndAdd');
  if (oldCreateItem) oldCreateItem.closest('div')?.remove();

  // "Create and add" footer button
  const createItem = document.createElement('div');
  createItem.style.cssText = 'padding:10px 12px;border-top:1px solid #1a1a22;flex-shrink:0;';
  createItem.innerHTML = `<button style="width:100%;padding:8px 14px;border-radius:8px;font-size:12.5px;font-weight:600;background:#004dff1a;border:1.5px dashed #004dff44;color:#6688ff;cursor:pointer;transition:all .14s;" id="mpPickerCreateAndAdd">${t('mp_create_add')}</button>`;
  createItem.querySelector('#mpPickerCreateAndAdd').addEventListener('click', () => {
    closeMpPicker();
    _pendingAddMod = Object.assign({}, mod, { _category: mod.projectType || modsCategory || mpAddModCategory || 'mod' });
    openMpModal();
  });
  list.parentNode.appendChild(createItem);
  document.getElementById('mpPickerOverlay').classList.add('open');
}
function doMpPlay(id) {
  const mp = modpacks.find(m => m.id === id);
  if (!mp) return;
  if (!window.electronAPI) { appendLog('⚠ ' + t('npm_start_warn')); if (!logOpen) toggleLog(); return; }
  if (gameRunning) { appendLog(t('game_running')); return; }
  activeMpId = id;
  selectedVersion = mp.version;
  selectedLoader  = mp.loader;
  mpSetLaunching(id, true);
  // Switch to launcher tab so progress bar UI (progressWrap/Bar/Label) exists in DOM
  const launcherTab = document.querySelector('.menu-item[data-target="launcher"]');
  if (launcherTab && !launcherTab.classList.contains('active')) {
    launcherTab.click();
  }
  launchGame({ version: mp.version, loader: mp.loader, loaderVersion: mp.loaderVersion||null, versionType: mp.versionType||'release', instanceName: mp.name });
}

function mpSetLaunching(id, launching) {
  const playBtn = document.querySelector(`[data-play="${id}"]`);
  const delBtn  = document.querySelector(`[data-del="${id}"]`);
  if (launching) {
    if (playBtn) {
      playBtn.innerHTML = '<span class="mp-spin"></span> ' + t('loading');
      playBtn.disabled = false;
      playBtn.dataset.launching = '1';
      // Replace with a fresh clone to wipe ALL previous event listeners
      const fresh = playBtn.cloneNode(true);
      fresh.innerHTML = '<span class="mp-spin"></span> ' + t('loading');
      fresh.dataset.launching = '1';
      fresh.onclick = () => {
        window.electronAPI?.cancelLaunch();
        // resetPlayBtn will be called by onCancelled — don't reset manually here
        // Just update the button immediately for responsiveness
        fresh.innerHTML = `▶ ${t('mp_play')}`;
        fresh.disabled = false;
        delete fresh.dataset.launching;
        fresh.onclick = null;
        fresh.addEventListener('click', () => doMpPlay(id));
      };
      playBtn.parentNode.replaceChild(fresh, playBtn);
    }
    if (delBtn) { delBtn.disabled = true; delBtn.style.opacity = '0.3'; delBtn.title = t('cant_delete_mp'); }
  } else {
    // Find button again — it may have been replaced by cloneNode above
    const btn = document.querySelector(`[data-play="${id}"]`);
    if (btn) {
      btn.innerHTML = `▶ ${t('mp_play')}`;
      btn.disabled = false;
      delete btn.dataset.launching;
      // Wipe onclick and re-attach clean handler
      btn.onclick = null;
      const fresh = btn.cloneNode(true);
      fresh.innerHTML = `▶ ${t('mp_play')}`;
      fresh.onclick = null;
      fresh.addEventListener('click', () => doMpPlay(id));
      btn.parentNode.replaceChild(fresh, btn);
    }
    if (delBtn) { delBtn.disabled = false; delBtn.style.opacity = ''; delBtn.title = ''; }
  }
}

function mpSetInGame(id) {
  const playBtn = document.querySelector(`[data-play="${id}"]`);
  const delBtn  = document.querySelector(`[data-del="${id}"]`);
  if (playBtn) { playBtn.innerHTML = t('game_in'); playBtn.disabled = true; }
  if (delBtn)  { delBtn.disabled = true; delBtn.style.opacity = '0.3'; delBtn.title = t('cant_delete_mp'); }
}

window.electronAPI?.onModDownloadProgress(({ filename, pct }) => {
  const btn = document.querySelector(`[data-dlfile="${filename}"]`);
  if (btn) { btn.textContent = pct + '%'; btn.className = 'mod-dl-btn downloading'; }
});
window.electronAPI?.onModDownloadDone(({ filename, success }) => {
  const btn = document.querySelector(`[data-dlfile="${filename}"]`);
  if (!btn) return;
  if (success) { btn.textContent = t('downloaded'); btn.className = 'mod-dl-btn done'; btn.disabled = true; }
  else         { btn.textContent = t('err_short');   btn.className = 'mod-dl-btn error'; btn.disabled = false; }
});

function fmtDownloads(n) {
  if (!n) return '';
  if (n >= 1e6) return (n/1e6).toFixed(1) + t('dl_m');
  if (n >= 1e3) return Math.round(n/1e3) + t('dl_k');
  return n + ' ' + t('dl_n');
}

async function mdVerDownloadModpack(mod, ver, btn) {
  btn.textContent = t('importing'); btn.className = 'mod-dl-btn downloading'; btn.disabled = true;
  try {
    const gameVer = (ver.gameVersions||[]).filter(v => /^\d+\.\d+(\.\d+)?$/.test(v))[0] || '';
    const loaderHint = (ver.loaders||[]).find(l => ['fabric','forge','quilt','neoforge'].includes(l)) || 'vanilla';
    btn.textContent = t('loading_mods');
    const fetched = mod.source === 'modrinth'
      ? await window.electronAPI?.getModpackMods({ source: 'modrinth', slug: mod.slug, versionId: ver.id }) || []
      : [];
    const safeName = mod.title.replace(/[/\\:*?"<>|]/g,'_').trim();
    const mpName = safeName + (gameVer ? ' ' + gameVer : '');
    const mp = {
      id: Date.now(),
      name: mpName,
      version: gameVer || '1.21.1',
      loader: loaderHint,
      loaderVersion: null,
      versionType: 'release',
      mods: fetched.map(m => ({ name: m.name, slug: m.slug, source: 'modrinth', url: m.url, fileUrl: m.fileUrl, filename: m.filename })),
      icon: mod.icon || '',
    };
    modpacks.push(mp);
    saveModpacks();
    rebuildCustomDropdown(true);
    switchToMyModpacks();
    // Download mods/resourcepacks/shaders into their correct versioned folders
    // versions/<mpName>/mods | resourcepacks | shaderpacks | datapacks
    if (fetched.length) {
      btn.textContent = `${t('dl_ing')} 0/${fetched.length}...`;
      let done = 0;
      for (const m of fetched) {
        if (m.fileUrl) {
          // Determine category from mod type; modrinth modpack components are mostly mods
          const cat = m.category || m.projectType || 'mod';
          try {
            await window.electronAPI?.downloadMod({ fileUrl: m.fileUrl, filename: m.filename, category: cat, instanceName: mpName });
          } catch {}
          done++;
          btn.textContent = `${t('dl_ing')} ${done}/${fetched.length}...`;
        }
      }
    }
    btn.textContent = t('added_mods').replace('{n}', fetched.length);
    btn.className = 'mod-dl-btn done'; btn.disabled = true;
  } catch(e) {
    btn.textContent = t('err_short'); btn.className = 'mod-dl-btn error'; btn.disabled = false;
    setTimeout(() => { btn.textContent = t('modpack_add_mine'); btn.className = 'mod-dl-btn'; btn.disabled = false; }, 2000);
  }
}

async function openModpackVersionPicker(mod, btn) {
  // Show version picker overlay
  btn.textContent = t('loading_short'); btn.disabled = true;
  let versions = [];
  try {
    versions = await window.electronAPI?.getModVersions({ source: mod.source, slug: mod.slug }) || [];
  } catch {}
  btn.textContent = t('modpack_add_mine'); btn.disabled = false;
  if (!versions.length) { mdVerDownloadModpack(mod, {}, btn); return; }
  // Build simple picker popup
  const existing = document.getElementById('mpVerPickerOverlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'mpVerPickerOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:90000;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `<div style="background:#141418;border:1.5px solid #252535;border-radius:14px;padding:20px;min-width:360px;max-width:480px;max-height:70vh;display:flex;flex-direction:column;gap:10px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
      <div style="font-size:14px;font-weight:700;color:#c8c8e8;">Выбор версии модпака</div>
      <button onclick="document.getElementById('mpVerPickerOverlay').remove()" style="background:none;border:none;color:#555;font-size:18px;cursor:pointer;">✕</button>
    </div>
    <div style="font-size:12px;color:#505068;margin-bottom:4px;">${mod.title}</div>
    <div id="mpVerPickerList" style="overflow-y:auto;display:flex;flex-direction:column;gap:4px;flex:1;"></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  const list = overlay.querySelector('#mpVerPickerList');
  versions.forEach(v => {
    const releaseVers = (v.gameVersions||[]).filter(gv => /^\d+\.\d+/.test(gv)).slice(0,3).join(', ');
    const loaders = (v.loaders||[]).join(', ') || 'vanilla';
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;background:#111115;border:1px solid #1e1e28;border-radius:8px;padding:8px 12px;gap:10px;';
    item.innerHTML = `<div style="flex:1;min-width:0;">
      <div style="font-size:13px;color:#c0c0d8;font-weight:600;">${v.name}</div>
      <div style="font-size:11px;color:#505068;">${loaders} · MC ${releaseVers||'?'}</div>
    </div>
    <button class="mod-dl-btn" style="font-size:11px;padding:5px 10px;flex-shrink:0;">${t('download')}</button>`;
    const dlBtn = item.querySelector('button');
    dlBtn.addEventListener('click', () => {
      overlay.remove();
      mdVerDownloadModpack(mod, v, btn);
    });
    list.appendChild(item);
  });
}

async function modDownload(mod, btn) {
  // Special case: modpack category — show version picker
  if (modsCategory === 'modpack' || mod.projectType === 'modpack') {
    openModpackVersionPicker(mod, btn);
    return;
  }
  btn.textContent = t('getting_label');
  btn.className = 'mod-dl-btn downloading';
  btn.disabled = true;
  try {
    if (mod.source === 'modrinth') {
      const versions = await window.electronAPI?.getModVersions({ source: 'modrinth', slug: mod.slug }) || [];
      if (!versions.length || !versions[0].files?.length) throw new Error(t('no_files_err'));
      const file = versions[0].files.find(f => f.primary) || versions[0].files[0];
      btn.dataset.dlfile = file.filename;
      btn.textContent = '0%';
      // If we're inside the mpAddMod overlay, download to the modpack's versioned folder
      const mpName = mpAddModTargetId
        ? modpacks.find(m => m.id === mpAddModTargetId)?.name
        : null;
      const safeMpName = mpName?.replace(/[\/\\:*?"<>|]/g, '_').trim() || null;
      await window.electronAPI?.downloadMod({
        fileUrl: file.url, filename: file.filename, category: modsCategory,
        ...(safeMpName ? { instanceName: safeMpName } : {})
      });
    } else {
      window.electronAPI?.openExternal(mod.url);
      btn.textContent = t('opened_label');
      btn.className = 'mod-dl-btn done';
      btn.disabled = true;
    }
  } catch {
    btn.textContent = t('err_short');
    btn.className = 'mod-dl-btn error';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = t('download'); btn.className = 'mod-dl-btn'; btn.disabled = false; }, 2000);
  }
}

function renderModRow(mod) {
  const row = document.createElement('div');
  row.className = 'mod-row';
  const iconEl = mod.icon
    ? (() => { const i = document.createElement('img'); i.className='mod-row-icon'; i.alt=''; i.src=mod.icon; i.onerror=()=>{ const ph=document.createElement('div'); ph.className='mod-row-icon-ph'; ph.innerHTML=MOD_PH_SVG; i.replaceWith(ph); }; return i; })()
    : (() => { const ph=document.createElement('div'); ph.className='mod-row-icon-ph'; ph.innerHTML=MOD_PH_SVG; return ph; })();
  const date = mod.updated ? new Date(mod.updated).toLocaleDateString('ru-RU', { day:'numeric', month:'short', year:'numeric' }) : '';
  const meta = [mod.author || '', fmtDownloads(mod.downloads), date].filter(Boolean).join(' · ');
  row.innerHTML = `
    <div class="mod-row-icon-wrap"></div>
    <div class="mod-row-info" style="cursor:pointer">
      <div class="mod-row-title">${mod.title}</div>
      ${mod.desc ? `<div class="mod-row-desc">${mod.desc}</div>` : ''}
      <div class="mod-row-meta">${meta}</div>
    </div>
    <div class="mod-row-actions"><button class="mod-dl-btn">${mod.projectType === 'modpack' ? t('modpack_add_mine') : t('download')}</button></div>
  `;
  row.querySelector('.mod-row-icon-wrap').replaceWith(iconEl);
  row.querySelector('.mod-row-info').addEventListener('click', () => openModDetail(mod));
  row.querySelector('.mod-dl-btn').addEventListener('click', e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    if (mod.projectType === 'modpack') {
      modDownload(mod, btn);
    } else {
      openMpPicker(mod);
    }
  });
  return row;
}

async function modsDoSearch(append = false) {
  if (modsLoading) return;
  modsLoading = true;
  const mySeq = _tabSeq;
  const grid = document.getElementById('modsGrid');
  if (!grid) { modsLoading = false; return; }
  if (!append) {
    modsOffset = 0;
    grid.innerHTML = `<div class="mods-loading">${t('loading')}</div>`;
  } else {
    document.getElementById('modsLoadMore')?.remove();
    const sp = document.createElement('div');
    sp.className = 'mods-loading'; sp.id = 'modsSpinner'; sp.textContent = t('loading');
    grid.appendChild(sp);
  }
  try {
    const res = await window.electronAPI?.searchMods({
      query: modsQuery, category: modsCategory,
      limit: MODS_LIMIT, offset: modsOffset, gameVersion: modsFilterVersion, sort: modsSort,
      loaders: modsFilterLoaders, categories: modsFilterCategories, environment: modsFilterEnv,
    }) || { items: [], cfAvailable: false };
    if (_tabSeq !== mySeq) { modsLoading = false; return; }  // tab changed

    if (modsCFAvail === null) {
      modsCFAvail = res.cfAvailable;
      const toggle = document.getElementById('modsSourceToggle');
      if (toggle) toggle.style.display = modsCFAvail ? 'flex' : 'none';
    }

    let items = res.items || [];
    if (modsSource === 'modrinth')   items = items.filter(m => m.source === 'modrinth');
    if (modsSource === 'curseforge') items = items.filter(m => m.source === 'curseforge');

    if (!append) grid.innerHTML = '';
    document.getElementById('modsSpinner')?.remove();

    if (!items.length && !append) {
      grid.innerHTML = `<div class="mods-empty">${t('dd_empty')}</div>`;
    } else {
      items.forEach(mod => grid.appendChild(renderModRow(mod)));
      if (items.length >= Math.floor(MODS_LIMIT / 2)) {
        const btn = document.createElement('button');
        btn.className = 'mods-load-more'; btn.id = 'modsLoadMore';
        btn.textContent = t('load_more');
        btn.addEventListener('click', () => { modsOffset += items.length; modsDoSearch(true); });
        grid.appendChild(btn);
      }
    }
  } catch(e) {
    document.getElementById('modsSpinner')?.remove();
    if (!append) grid.innerHTML = `<div class="mods-empty">${t('error_label')}: ${e.message}</div>`;
  }
  modsLoading = false;
}

const LOADERS_FILTER = [
  { id:'fabric',   label:'Fabric' },
  { id:'forge',    label:'Forge'  },
  { id:'neoforge', label:'NeoForge' },
  { id:'quilt',    label:'Quilt'  },
];
const ENVS_FILTER = [
  { id:'client', labelKey:'env_client' },
  { id:'server', labelKey:'env_server' },
];
const MOD_CATEGORIES_FILTER = [
  'optimization','utility','technology','magic','adventure','mobs',
  'worldgen','decoration','food','equipment','library','storage',
  'quests','building','combat','misc',
].map(id => ({ id, get label(){ return translateCat(id); } }));

// Keep track of which sidebar groups are open across rebuilds
const _sfOpenGroups = new Set();

function buildSidebar() {
  // Get real release versions from manifest (patch versions, descending)
  const mcVersions = _manifestCache
    ? _manifestCache.raw.versions
        .filter(v => v.type === 'release')
        .map(v => v.id)
    : ['1.21.11','1.21.10','1.21.9','1.21.8','1.21.7','1.21.6','1.21.5','1.21.4',
       '1.21.3','1.21.2','1.21.1','1.21','1.20.6','1.20.4','1.20.2','1.20.1','1.20',
       '1.19.4','1.19.3','1.19.2','1.19.1','1.19','1.18.2','1.18.1','1.18',
       '1.17.1','1.17','1.16.5','1.16.4','1.16.3','1.16.2','1.16.1','1.16',
       '1.15.2','1.15.1','1.15','1.14.4','1.14.3','1.14.2','1.14.1','1.14',
       '1.13.2','1.13.1','1.13','1.12.2','1.12.1','1.12','1.11.2','1.11',
       '1.10.2','1.10','1.9.4','1.9.2','1.9','1.8.9','1.8.8','1.8',
       '1.7.10','1.7.9','1.7.8','1.7.5','1.7.4','1.7.2',
       '1.6.4','1.6.2','1.6.1','1.5.2','1.5.1','1.5',
       '1.4.7','1.4.6','1.4.5','1.4.4','1.4.2',
       '1.3.2','1.3.1','1.2.5','1.2.4','1.2.3','1.2.2','1.2.1',
       '1.1','1.0'];

  function sfGroup(id, title, items, type, scrollable) {
    const hasActive = type === 'radio'
      ? (id === 'version' ? !!modsFilterVersion : id === 'env' ? !!modsFilterEnv : false)
      : (id === 'loaders' ? modsFilterLoaders.length > 0 : modsFilterCategories.length > 0);
    // Open if: has active filter OR was manually opened
    const isOpen = hasActive || _sfOpenGroups.has(id);
    const dot = hasActive ? '<span class="sf-active-dot"></span>' : '';
    const rows = items.map(it => {
      let active = false;
      if (id === 'version') active = modsFilterVersion === it.id;
      else if (id === 'env') active = modsFilterEnv === it.id;
      else if (id === 'loaders') active = modsFilterLoaders.includes(it.id);
      else if (id === 'categories') active = modsFilterCategories.includes(it.id);
      if (type === 'radio') {
        const lbl = it.labelKey ? t(it.labelKey) : (it.label||it.id);
        return `<div class="sf-item${active?' active':''}" data-sfid="${id}" data-sfval="${it.id}">${lbl}</div>`;
      } else {
        const lbl = it.labelKey ? t(it.labelKey) : (it.label||it.id);
        return `<div class="sf-item${active?' active':''}" data-sfid="${id}" data-sfval="${it.id}"><input type="checkbox"${active?' checked':''}>${lbl}</div>`;
      }
    }).join('');
    const clearBtn = hasActive ? `<button class="sf-clear" data-sfclear="${id}">${t('reset_btn')}</button>` : '';
    const innerRows = scrollable
      ? `<div class="sf-body-scroll">${rows}</div>${clearBtn}`
      : `${rows}${clearBtn}`;
    return `<div class="sf-group${isOpen?' open':''}" id="sfGroup_${id}">
      <div class="sf-header" data-sftoggle="${id}">
        <span class="sf-title">${title}${dot}</span>
        <span class="sf-arrow">▾</span>
      </div>
      <div class="sf-body-wrap"><div class="sf-body">${innerRows}</div></div>
    </div>`;
  }

  const showLoaderFilter = ['mod', 'modpack', 'datapack'].includes(modsCategory);
  const html =
    sfGroup('version',    t('filter_version'), mcVersions.map(v=>({id:v,label:v})), 'radio', true) +
    (showLoaderFilter ? sfGroup('loaders', t('filter_loader'), LOADERS_FILTER, 'check', false) : '') +
    sfGroup('categories', t('filter_category'),   MOD_CATEGORIES_FILTER, 'check', true) +
    sfGroup('env',        t('filter_env'),       ENVS_FILTER, 'radio', false);

  const sb = document.getElementById('modsSidebar');
  if (!sb) return;
  sb.innerHTML = html;
}

function initSidebarEvents() {
  const sb = document.getElementById('modsSidebar');
  if (!sb) return;
  sb.addEventListener('click', e => {
    // Toggle group open/close
    const tog = e.target.closest('[data-sftoggle]');
    if (tog) {
      e.stopPropagation();
      const id = tog.dataset.sftoggle;
      const grp = document.getElementById('sfGroup_' + id);
      if (!grp) return;
      const willOpen = !grp.classList.contains('open');
      grp.classList.toggle('open', willOpen);
      if (willOpen) _sfOpenGroups.add(id); else _sfOpenGroups.delete(id);
      return;
    }
    // Clear filter button
    const clr = e.target.closest('[data-sfclear]');
    if (clr) {
      e.stopPropagation();
      const fid = clr.dataset.sfclear;
      if (fid === 'version') modsFilterVersion = '';
      else if (fid === 'env') modsFilterEnv = '';
      else if (fid === 'loaders') modsFilterLoaders = [];
      else if (fid === 'categories') modsFilterCategories = [];
      buildSidebar();
      modsDoSearch();
      return;
    }
    // Select filter item
    const item = e.target.closest('[data-sfid]');
    if (!item) return;
    e.stopPropagation();
    const fid = item.dataset.sfid, val = item.dataset.sfval;
    if (fid === 'version') {
      modsFilterVersion = modsFilterVersion === val ? '' : val;
    } else if (fid === 'env') {
      modsFilterEnv = modsFilterEnv === val ? '' : val;
    } else if (fid === 'loaders') {
      const idx = modsFilterLoaders.indexOf(val);
      idx >= 0 ? modsFilterLoaders.splice(idx, 1) : modsFilterLoaders.push(val);
    } else if (fid === 'categories') {
      const idx = modsFilterCategories.indexOf(val);
      idx >= 0 ? modsFilterCategories.splice(idx, 1) : modsFilterCategories.push(val);
    }
    buildSidebar();
    modsDoSearch();
  });
}

function loadMods() {
  const content = document.getElementById('content');
  modsQuery = ''; modsOffset = 0; modsCFAvail = null;
  const tabsHtml = MODS_CATEGORIES.map(c =>
    `<div class="mods-tab${c.id === modsCategory ? ' active' : ''}" data-cat="${c.id}">${t(c.labelKey)}</div>`
  ).join('');
  const SORT_OPTIONS = [
    { id:'downloads', label:t('sort_popular') },
    { id:'newest',    label:t('sort_newest') },
    { id:'relevance', label:t('sort_relevance') },
  ];
  const sortHtml = SORT_OPTIONS.map(s =>
    `<button class="mods-sort-btn${s.id===modsSort?' active':''}" data-sort="${s.id}">${s.label}</button>`
  ).join('');
  content.innerHTML = `
    <div class="mods-tabs" id="modsTabs">
      <div class="mods-tab${modsView==='modpacks'?' active':''}" id="modsTabModpacks" data-view="modpacks">${t('my_modpacks')}</div>
      <div class="mods-tabs-divider"></div>
      ${tabsHtml}
    </div>
    <div id="modsMainArea">
      <div class="mods-search-row">
        <input class="mods-search-input" id="modsSearchInput" placeholder="${t('search')}">
        <div class="mods-source-toggle" id="modsSourceToggle" style="display:none">
          <div class="src-btn both active" data-src="both" data-i18n="src_all">Все</div>
          <div class="src-btn mr" data-src="modrinth">Modrinth</div>
          <div class="src-btn cf" data-src="curseforge">CurseForge</div>
        </div>
      </div>
      <div class="mods-filters-row" id="mods-filters">
        <span class="mods-filter-label">${t('sort_by')}</span>
        ${sortHtml}
      </div>
      <div id="modsLayout">
        <div id="modsSidebar"></div>
        <div id="modsContent">
          <div class="mods-grid" id="modsGrid"><div class="mods-loading">${t('loading')}</div></div>
        </div>
      </div>
    </div>
    <div id="modsModpacksArea" style="display:none"></div>
  `;

  buildSidebar();
  initSidebarEvents();

  if (modsView === 'modpacks') {
    document.getElementById('modsMainArea').style.display = 'none';
    document.getElementById('modsModpacksArea').style.display = '';
    renderModpacksArea();
  }

  document.getElementById('modsTabs').addEventListener('click', e => {
    const vt = e.target.closest('[data-view]');
    if (vt) {
      modsView = 'modpacks';
      document.querySelectorAll('.mods-tab').forEach(x => x.classList.remove('active'));
      vt.classList.add('active');
      document.getElementById('modsMainArea').style.display = 'none';
      document.getElementById('modsModpacksArea').style.display = '';
      renderModpacksArea();
      return;
    }
    const tab = e.target.closest('.mods-tab[data-cat]');
    if (!tab) return;
    modsView = 'search';
    modsCategory = tab.dataset.cat;
    document.querySelectorAll('.mods-tab').forEach(x => x.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('modsMainArea').style.display = '';
    document.getElementById('modsModpacksArea').style.display = 'none';
    modsQuery = document.getElementById('modsSearchInput').value.trim();
    buildSidebar();
    modsDoSearch();
  });

  document.getElementById('mods-filters').addEventListener('click', e => {
    const b = e.target.closest('[data-sort]'); if (!b) return;
    modsSort = b.dataset.sort;
    document.querySelectorAll('.mods-sort-btn').forEach(x => x.classList.toggle('active', x.dataset.sort === modsSort));
    modsQuery = document.getElementById('modsSearchInput').value.trim();
    modsDoSearch();
  });

  document.getElementById('modsSourceToggle').addEventListener('click', e => {
    const b = e.target.closest('.src-btn'); if (!b) return;
    modsSource = b.dataset.src;
    document.querySelectorAll('.src-btn').forEach(x => x.classList.toggle('active', x.dataset.src === modsSource));
    modsQuery = document.getElementById('modsSearchInput').value.trim();
    modsDoSearch();
  });

  // Live search with debounce
  document.getElementById('modsSearchInput').addEventListener('input', e => {
    clearTimeout(_modsSearchTimer);
    _modsSearchTimer = setTimeout(() => {
      modsQuery = e.target.value.trim();
      modsDoSearch();
    }, 450); // OPT: slightly longer debounce = fewer API calls
  });

  if (modsView !== 'modpacks') modsDoSearch();
}
function loadFiles() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div id="fb-wrap" style="display:flex;flex-direction:column;height:calc(100vh - 148px);min-height:0;">
      <div id="fb-toolbar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-shrink:0;">
        <button class="fb-btn" id="fb-up" title="${t('fb_up_title')}">↑</button>
        <div id="fb-breadcrumb" style="flex:1;font-size:12px;color:#505070;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
        <button class="fb-btn" id="fb-add-file" title="${t('fb_add_file_title')}">${t('fb_add_file')}</button>
        <input type="file" id="fb-file-input" multiple style="display:none">
        <button class="fb-btn" id="fb-open-folder" title="${t('fb_open_folder_title')}">📂 ${t('fb_folder_label')}</button>
        <button class="fb-btn" id="fb-refresh" title="${t('fb_refresh_title')}">↻</button>
      </div>
      <div id="fb-drop-zone" style="flex:1;min-height:0;position:relative;display:flex;flex-direction:column;">
        <div id="fb-grid" style="flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;align-content:start;padding-bottom:4px;">
          <div style="color:#404055;font-size:12px;padding:20px;">${t('loading')}</div>
        </div>
        <div id="fb-drop-overlay" style="display:none;position:absolute;inset:0;background:rgba(0,77,255,.1);border:2px dashed #004dff77;border-radius:8px;z-index:100;pointer-events:none;flex-direction:column;align-items:center;justify-content:center;gap:8px;">
          <div style="font-size:32px;">📂</div>
          <div id="fb-drop-label" style="font-size:13px;color:#aac0ff;font-weight:500;">${t('fb_drop_label')}</div>
        </div>
      </div>
      <div id="fb-status" style="flex-shrink:0;font-size:11px;color:#505068;padding:5px 2px 2px;border-top:1px solid #1a1a22;margin-top:5px;"></div>
    </div>`;

  // Inject styles if not already present
  if (!document.getElementById('fb-styles')) {
    const s = document.createElement('style');
    s.id = 'fb-styles';
    s.textContent = `
      .fb-btn { padding:5px 10px; border-radius:7px; font-size:12px; font-weight:500;
        background:#111115; border:1.5px solid #1a1a22; color:#606080; cursor:pointer; transition:all .12s; }
      .fb-btn:hover { border-color:#252535; color:#ccc; }
      .fb-item { display:flex; flex-direction:column; align-items:center; gap:5px; padding:10px 6px 8px;
        border-radius:9px; border:1.5px solid transparent; cursor:pointer; transition:all .12s;
        background:transparent; min-width:0; }
      .fb-item:hover { background:#111116; border-color:#1e1e28; }
      .fb-item.selected { background:#080c1a; border-color:#004dff44; }
      .fb-icon { font-size:30px; line-height:1; user-select:none; }
      .fb-name { font-size:11px; color:#8888a8; text-align:center; word-break:break-all;
        max-width:100px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
      .fb-size { font-size:10px; color:#404058; }
      .fb-ctx { position:fixed; z-index:50000; background:#16161c; border:1.5px solid #2a2a38;
        border-radius:10px; box-shadow:0 8px 32px rgba(0,0,0,.75); padding:4px; min-width:180px; }
      .fb-ctx-item { padding:7px 11px; font-size:12.5px; color:#aaa; border-radius:7px; cursor:pointer; transition:background .1s; display:flex; align-items:center; gap:8px; }
      .fb-ctx-item .ctx-icon { width:16px; text-align:center; flex-shrink:0; font-size:13px; }
      .fb-ctx-item:hover { background:rgba(0,77,255,.18); color:#d8e4ff; }
      .fb-ctx-item.danger:hover { background:rgba(200,40,40,.15); color:#ff6666; }
      .fb-ctx-sep { height:1px; background:#252535; margin:3px 6px; }
      .fb-item.drag-over { background:#0a0e1a !important; border-color:#004dff88 !important; }
    `;
    document.head.appendChild(s);
  }

  const EXT_ICONS = {
    '.jar':'.jar 📦', '.zip':'📦', '.json':'📄', '.txt':'📄', '.log':'📋',
    '.png':'🖼', '.jpg':'🖼', '.jpeg':'🖼', '.gif':'🖼', '.webp':'🖼',
    '.nbt':'💾', '.dat':'💾', '.mca':'🗺', '.mcworld':'🌍',
    '.toml':'⚙', '.cfg':'⚙', '.properties':'⚙',
    '.mp3':'🎵', '.ogg':'🎵', '.wav':'🎵',
  };
  function getIcon(entry) {
    if (entry.isDir) return '📁';
    return EXT_ICONS[entry.ext]?.split(' ')[1] || EXT_ICONS[entry.ext] || '📄';
  }
  function fmtSize(b) {
    if (!b) return '';
    if (b > 1024*1024) return (b/1024/1024).toFixed(1) + ' ' + t('size_mb');
    if (b > 1024) return Math.round(b/1024) + ' ' + t('size_kb');
    return b + ' ' + t('size_b');
  }

  let currentPath = null;
  let currentData = null;
  let selectedEntry = null;

  function closeFbCtx() { document.querySelectorAll('.fb-ctx').forEach(el => el.remove()); }
  document.addEventListener('click', closeFbCtx, { passive: true }); // already passive

  function showCtx(e, entry) {
    closeFbCtx(); e.preventDefault();
    const menu = document.createElement('div'); menu.className = 'fb-ctx';
    const items = [];
    if (!entry.isDir) items.push({ icon:'▶', label:t('fb_open'), action:()=>window.electronAPI?.fsOpen(entry.path) });
    items.push({ icon:'📂', label:t('fb_show_explorer'), action:()=>window.electronAPI?.fsOpenFolder(entry.isDir?entry.path:path_dirname(entry.path)) });
    items.push({ sep:true });
    items.push({ icon:'🗑', label:t('delete_btn'), danger:true, action:()=>{
      document.getElementById('scIcon').textContent='🗑️';
      document.getElementById('scTitle').textContent=`${t('delete_btn')} «${entry.name}»?`;
      document.getElementById('scDesc').innerHTML=entry.isDir?t('delete_folder_desc'):t('delete_file_desc');
      document.getElementById('scConfirmBtn').textContent=t('delete_btn');
      document.getElementById('scConfirmBtn').onclick=()=>{window.electronAPI?.fsDelete(entry.path).then(r=>{if(r?.success)navigateTo(currentPath);closeStopConfirm();});document.getElementById('scConfirmBtn').onclick=null;};
      document.getElementById('scCancelBtn').onclick=()=>{closeStopConfirm();document.getElementById('scConfirmBtn').onclick=null;};
      document.getElementById('stopConfirmOverlay').classList.add('open');
    }});
    items.forEach(it=>{
      if(it.sep){const s=document.createElement('div');s.className='fb-ctx-sep';menu.appendChild(s);return;}
      const el=document.createElement('div');
      el.className='fb-ctx-item'+(it.danger?' danger':'');
      el.innerHTML=`<span class="ctx-icon">${it.icon}</span><span>${it.label}</span>`;
      el.addEventListener('click',e2=>{e2.stopPropagation();closeFbCtx();it.action();});
      menu.appendChild(el);
    });
    menu.style.left=Math.min(e.clientX,window.innerWidth-190)+'px';
    menu.style.top=Math.min(e.clientY,window.innerHeight-120)+'px';
    document.body.appendChild(menu);
  }

  function path_dirname(p) { return p.replace(/[\\/][^\\/]+$/, '') || p; }

  async function navigateTo(dir) {
    const grid = document.getElementById('fb-grid');
    if (!grid) return;
    grid.innerHTML = `<div style="color:#404055;font-size:12px;padding:20px;">${t('loading')}</div>`;
    let data;
    try {
      if (!window.electronAPI?.fsList) {
        grid.innerHTML = `<div style="color:#884444;font-size:12px;padding:20px;">${t('fb_preload_err')}</div>`;
        return;
      }
      data = await window.electronAPI.fsList(dir || null);
    } catch(e) {
      grid.innerHTML = `<div style="color:#884444;font-size:12px;padding:20px;">${t('error_label')}: ${e.message}</div>`;
      return;
    }
    if (!data || data.error) {
      grid.innerHTML = `<div style="color:#884444;font-size:12px;padding:20px;">${t('error_label')}: ${data?.error || t('fb_no_response')}</div>`;
      return;
    }
    currentData = data;
    currentPath = data.path;

    // Breadcrumb
    const bc = document.getElementById('fb-breadcrumb');
    if (bc) {
      const rootName = (data.mcRoot||'').split(/[\\/]/).filter(Boolean).pop()||'minecraft';
      const rel = currentPath.startsWith(data.mcRoot) ? currentPath.slice(data.mcRoot.length) : '';
      bc.textContent = [rootName,...rel.split(/[\\/]/).filter(Boolean)].join(' › ');
    }
    const upBtn = document.getElementById('fb-up');
    if (upBtn) upBtn.disabled = !!data.isRoot;
    const dirs = data.entries.filter(e=>e.isDir).length, files2 = data.entries.filter(e=>!e.isDir).length;
    const st = document.getElementById('fb-status');
    if (st) st.textContent = `${dirs} ${t('fb_folders')}, ${files2} ${t('fb_files')}`;

    // Render entries
    grid.innerHTML = '';
    if (!data.entries.length) {
      grid.innerHTML = `<div style="color:#404055;font-size:12px;padding:20px;">${t('fb_empty_dir')}</div>`;
      return;
    }
    data.entries.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'fb-item';
      item.dataset.path = entry.path;
      item.dataset.isDir = entry.isDir ? '1' : '0';
      item.innerHTML = `
        <div class="fb-icon">${getIcon(entry)}</div>
        <div class="fb-name">${entry.name}</div>
        ${!entry.isDir ? `<div class="fb-size">${fmtSize(entry.size)}</div>` : ''}`;
      item.addEventListener('click', e => {
        document.querySelectorAll('.fb-item.selected').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        selectedEntry = entry;
      });
      item.addEventListener('dblclick', () => {
        if (entry.isDir) { navigateTo(entry.path); }
        else { window.electronAPI?.fsOpen(entry.path); }
      });
      item.addEventListener('contextmenu', e => showCtx(e, entry));
      grid.appendChild(item);
    });
  }

  document.getElementById('fb-up')?.addEventListener('click', () => {
    if (!currentData?.isRoot && currentData?.parent) navigateTo(currentData.parent);
  });
  document.getElementById('fb-refresh')?.addEventListener('click', () => navigateTo(currentPath));
  document.getElementById('fb-open-folder')?.addEventListener('click', () => window.electronAPI?.fsOpenFolder(currentPath));
  document.getElementById('fb-add-file')?.addEventListener('click', () => document.getElementById('fb-file-input')?.click());
  document.getElementById('fb-file-input')?.addEventListener('change', async e => {
    const fs2 = Array.from(e.target.files||[]); if (fs2.length) await fbUpload(fs2, currentPath); e.target.value='';
  });
  let fbN=0, fbDt=null;
  const dz=document.getElementById('fb-drop-zone'), dov=document.getElementById('fb-drop-overlay'), dlbl=document.getElementById('fb-drop-label');
  function fbShow(p){fbDt=p;const n=(p||'').split(/[\\/]/).pop()||t('fb_folder_label');if(dlbl)dlbl.textContent=`${t('fb_drop_into')} «${n}»`;if(dov)dov.style.display='flex';}
  function fbHide(){fbDt=null;if(dov)dov.style.display='none';document.querySelectorAll('.fb-item.drag-over').forEach(el=>el.classList.remove('drag-over'));}
  dz?.addEventListener('dragenter',e=>{e.preventDefault();if(++fbN===1)fbShow(currentPath);});
  dz?.addEventListener('dragleave',()=>{if(--fbN<=0){fbN=0;fbHide();}});
  dz?.addEventListener('dragover',e=>{e.preventDefault();const it=e.target.closest?.('.fb-item[data-is-dir="1"]');if(it&&it.dataset.path!==fbDt){document.querySelectorAll('.fb-item.drag-over').forEach(el=>el.classList.remove('drag-over'));it.classList.add('drag-over');fbShow(it.dataset.path);}else if(!it&&fbDt!==currentPath){document.querySelectorAll('.fb-item.drag-over').forEach(el=>el.classList.remove('drag-over'));fbShow(currentPath);}});
  dz?.addEventListener('drop',async e=>{e.preventDefault();fbN=0;const dpath=fbDt||currentPath;fbHide();const fs3=Array.from(e.dataTransfer?.files||[]);if(fs3.length)await fbUpload(fs3,dpath);});
  async function fbUpload(files,destDir){const s=document.getElementById('fb-status');let d=0;for(const f of files){if(s)s.textContent=`${t('fb_copying')} ${f.name}...`;const r=await window.electronAPI?.fsCopyFile({srcPath:f.path,destDir}).catch(()=>null);if(r?.success)d++;}if(s)s.textContent=`${t('fb_added')}: ${d} ${t('fb_files_suffix')}`;navigateTo(currentPath);}

  navigateTo(null);
}
// ══════════════════════════════════════════════════════════════════
// FRIENDS SYSTEM
// ══════════════════════════════════════════════════════════════════
let _socialToken    = null;
let _socialUser     = null;
let _socialWS       = null;
let _socialFriends  = [];
let _socialPending  = [];
let _socialOnline   = new Map();
let _chatTarget     = null;
let _chatMessages   = [];
let _friendsView    = 'login'; // login | setup_avatar | main


// ── Session persist ───────────────────────────────────────────────
function socialSaveSession(token, user) {
  _socialToken = token; _socialUser = user;
  try { localStorage.setItem('social_token', token); localStorage.setItem('social_user', JSON.stringify(user)); } catch {}
}
function socialLoadSession() {
  try {
    const t = localStorage.getItem('social_token');
    const u = localStorage.getItem('social_user');
    if (t && u) { _socialToken = t; _socialUser = JSON.parse(u); return true; }
  } catch {}
  return false;
}
function socialClearSession() {
  _socialToken = null; _socialUser = null;
  try { localStorage.removeItem('social_token'); localStorage.removeItem('social_user'); } catch {}
}

// ── Avatar helpers ────────────────────────────────────────────────
function frGetAvatar() { try { return localStorage.getItem('social_avatar') || null; } catch { return null; } }
function frSaveAvatar(d) { try { localStorage.setItem('social_avatar', d); } catch {} }
function frClearAvatar() { try { localStorage.removeItem('social_avatar'); } catch {} }

async function frBuildHeadFromSkin(skinDataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
      const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 64, 64);
      ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 64, 64);
      res(cv.toDataURL('image/png'));
    };
    img.onerror = rej;
    img.src = skinDataUrl;
  });
}

async function frAutoSetMCAvatar() {
  if (frGetAvatar()) return;
  try {
    const acc = typeof acCurrentAccount !== 'undefined' ? acCurrentAccount : null;
    if (!acc || acc.type === 'local') return;
    const skin = await window.electronAPI?.fetchSkin({ username: acc.username, type: acc.type });
    if (!skin) return;
    const head = await frBuildHeadFromSkin(skin);
    frSaveAvatar(head);
    frRefreshMeAvatar(head);
  } catch {}
}

function frRefreshMeAvatar(dataUrl) {
  const el = document.getElementById('frMeAvatar');
  if (!el) return;
  const initial = (_socialUser?.displayName || _socialUser?.username || '?')[0].toUpperCase();
  el.innerHTML = dataUrl
    ? `<img src="${dataUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
    : initial;
}

window.frClickAvatar = function() {
  document.querySelectorAll('.fr-avatar-menu').forEach(m => m.remove());
  const av = document.getElementById('frMeAvatar');
  if (!av) return;
  const menu = document.createElement('div');
  menu.className = 'fr-avatar-menu';
  menu.innerHTML = `
    <button onclick="frAvatarFromMC()">Скин Minecraft</button>
    <button onclick="frAvatarUpload()">Загрузить фото</button>
    <button onclick="frAvatarReset()" style="color:#e05858;">${t('soc_reset_avatar')}</button>`;
  av.parentElement.style.position = 'relative';
  av.after(menu);
  const close = (e) => { if (!menu.contains(e.target) && e.target !== av) { menu.remove(); document.removeEventListener('click', close); }};
  setTimeout(() => document.addEventListener('click', close), 10);
};

window.frAvatarFromMC = async function() {
  document.querySelectorAll('.fr-avatar-menu').forEach(m => m.remove());
  try {
    const acc = typeof acCurrentAccount !== 'undefined' ? acCurrentAccount : null;
    if (!acc) { alert(t('soc_no_mc')); return; }
    const skin = await window.electronAPI?.fetchSkin({ username: acc.username, type: acc.type });
    if (!skin) { alert(t('soc_skin_fail')); return; }
    const head = await frBuildHeadFromSkin(skin);
    frSaveAvatar(head); frRefreshMeAvatar(head);
  } catch(e) { alert(t('soc_err') + ' ' + e.message); }
};

window.frAvatarUpload = function() {
  document.querySelectorAll('.fr-avatar-menu').forEach(m => m.remove());
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => { frSaveAvatar(e.target.result); frRefreshMeAvatar(e.target.result); };
    reader.readAsDataURL(file);
  };
  input.click();
};

window.frAvatarReset = function() {
  document.querySelectorAll('.fr-avatar-menu').forEach(m => m.remove());
  frClearAvatar(); frRefreshMeAvatar(null);
};

// ── Deep link auto-login ──────────────────────────────────────────
if (window.electronAPI?.onDeeplinkVerify) {
  window.electronAPI.onDeeplinkVerify(async (token) => {
    try {
      _socialToken = token;
      const me = await socialAPI('socialMe', { token });
      socialSaveSession(token, me);
      if (!me.username) { _friendsView = 'setup_username'; }
      else { _socialUser = me; _friendsView = 'main'; await socialLoadFriendList(); socialConnect(); }
      document.querySelectorAll('.menu-item').forEach(el => el.classList.toggle('active', el.dataset.target === 'friends'));
      loadFriends();
    } catch(e) { console.error('[deeplink]', e.message); }
  });
}

// ── WebSocket ─────────────────────────────────────────────────────
const SOCIAL_WS = 'wss://weqeecharm8y5g-production.up.railway.app';

function socialConnect() {
  if (!_socialToken) return;
  if (_socialWS && _socialWS.readyState === WebSocket.OPEN) return;
  try { _socialWS = new WebSocket(SOCIAL_WS); } catch { return; }
  _socialWS.onopen  = () => { _socialWS.send(JSON.stringify({ type:'auth', token:_socialToken })); };
  _socialWS.onmessage = (ev) => { let msg; try { msg = JSON.parse(ev.data); } catch { return; } socialHandleWS(msg); };
  let _wsReconnectDelay = 5000;
  _socialWS.onclose = () => {
    // OPT: exponential backoff — don't hammer server on repeated disconnects
    setTimeout(() => { if (_socialToken) { _wsReconnectDelay = Math.min(_wsReconnectDelay * 1.5, 60000); socialConnect(); } }, _wsReconnectDelay);
  };
  _socialWS.onopen = (_orig => function() { _wsReconnectDelay = 5000; _orig && _orig.call(this); })(_socialWS.onopen);
  _socialWS.onerror = () => {};
}

function socialSendWS(obj) {
  if (_socialWS && _socialWS.readyState === WebSocket.OPEN) _socialWS.send(JSON.stringify(obj));
}

function socialHandleWS(msg) {
  if (msg.type === 'auth_ok') {
    msg.friends?.forEach(f => { if (f.online) _socialOnline.set(f.id, f.presence || {}); });
    // OPT: use pendingRequests from server payload — skip extra HTTP call
    if (msg.pendingRequests?.length) _socialPending = msg.pendingRequests;
    socialRefreshFriendsList(); return;
  }
  if (msg.type === 'friend_online')   { _socialOnline.set(msg.userId, {}); updateFriendCard(msg.userId); return; }
  if (msg.type === 'friend_offline')  { _socialOnline.delete(msg.userId); updateFriendCard(msg.userId); return; }
  if (msg.type === 'presence')        { _socialOnline.set(msg.userId, msg.data||{}); updateFriendCard(msg.userId); return; }
  // OPT: For friend_request, use sender data from server payload if available
  //      avoiding a full HTTP re-fetch on every notification
  if (msg.type === 'friend_request') {
    if (msg.sender) {
      _socialPending = [...(_socialPending || []), { ...msg.sender, requestId: null }];
      socialRefreshFriendsList();
    } else {
      socialLoadFriendList().then(socialRefreshFriendsList);
    }
    return;
  }
  if (msg.type === 'friend_accepted') { socialLoadFriendList().then(socialRefreshFriendsList); return; }
  if (msg.type === 'friend_removed')  { socialLoadFriendList().then(socialRefreshFriendsList); return; }
  if (msg.type === 'message') {
    if (_chatTarget?.id === msg.fromId || _chatTarget?.id === msg.toId) {
      _chatMessages.push(msg); renderChatMessages();
    } else {
      const badge = document.querySelector(`[data-friend-id="${msg.fromId}"] .fr-unread`);
      if (badge) badge.style.display = '';
    }
  }
}

const api = window.electronAPI;
async function socialAPI(method, ...args) {
  const _api = window.electronAPI;
  if (!_api || !_api[method]) throw new Error('API unavailable — запусти через npm start');
  const res = await _api[method](...args);
  // Status 0 = network/connection error (returned by main process catch)
  if (res && res.status === 0 && res.data?.error) throw new Error(res.data.error);
  if (res && res.status && res.status >= 400) { let errMsg; if (typeof res.data === "object") { errMsg = res.data?.error || res.data?.message || JSON.stringify(res.data); } else { errMsg = String(res.data || "").slice(0, 200) || ("Server error " + res.status); } /* OPT: suppress hot-path log */ throw new Error(errMsg || "Server error " + res.status); }
  return res.data ?? res;
}

async function socialLoadFriendList() {
  try {
    const res = await socialAPI('socialFriends', { token: _socialToken });
    _socialFriends = res.accepted || [];
    _socialPending = res.pending  || [];
  } catch(e) { /* OPT: suppress non-critical log */ }
}

// ── Friends list rendering ────────────────────────────────────────
function socialRefreshFriendsList() {
  const container = document.getElementById('frFriendsList');
  if (!container) return;
  const pendingCount = _socialPending.length;
  const pendingTab = document.getElementById('frPendingTab');
  if (pendingTab) pendingTab.innerHTML = `${t('soc_pending')}${pendingCount > 0 ? ` <span class="fr-badge">${pendingCount}</span>` : ''}`;
  const tab = document.getElementById('frFriendsTabActive');
  const activeTab = tab?.dataset.tab || 'friends';
  if (activeTab === 'friends') renderFriendsList(container);
  else if (activeTab === 'pending') renderPendingList(container);
  else if (activeTab === 'account') renderAccountTab(container);
}

function renderFriendsList(container) {
  if (!_socialFriends.length) {
    container.innerHTML = `<div class="fr-empty">${t('soc_no_friends')}<br><span style="font-size:11px;color:var(--text4)">${t('soc_add_hint')}</span></div>`;
    return;
  }
  container.innerHTML = '';
  _socialFriends.forEach(f => {
    const online = _socialOnline.has(f.id);
    const presence = _socialOnline.get(f.id) || {};
    const card = document.createElement('div');
    card.className = 'fr-friend-card';
    card.dataset.friendId = f.id;
    card.innerHTML = `
      ${presence.mods?.length
        ? `<div class="fr-mods-toggle" onclick="frToggleMods(this)">
             <span>📦 ${presence.mods.length} модов</span><span class="fr-toggle-arrow">▶</span>
           </div>
           <div class="fr-mods-list" style="display:none">${presence.mods.map(m=>`<div class="fr-mod-item">${m}</div>`).join('')}</div>`
        : ''}
      <div class="fr-avatar">${(f.displayName||f.username||'?')[0].toUpperCase()}</div>
      <div class="fr-info">
        <div class="fr-name">${f.displayName||f.username}<span class="fr-username">@${f.username}</span></div>
        <div class="fr-status ${online?'online':'offline'}">${online ? (presence.server ? '🎮 '+presence.server : t('soc_online')) : t('soc_offline')}</div>
      </div>
      <div class="fr-actions">
        ${online && presence.server
          ? `<button class="fr-btn fr-join-btn" onclick="frJoin('${f.id}')" title="${t('soc_connect')}">Join</button>` : ''}
        <button class="fr-btn fr-chat-btn" onclick="frOpenChat('${f.id}','${f.username}','${(f.displayName||f.username).replace(/'/g,"\\'")}')">💬</button>
        <button class="fr-btn fr-remove-btn" onclick="frRemove('${f.id}')" title="${t('soc_remove_friend')}">✕</button>
        <button class="fr-btn fr-block-btn" onclick="frBlock('${f.id}','${f.username}')" title="${t('soc_block')}">⊘</button>
        <button class="fr-btn fr-report-btn" onclick="frReport('${f.id}','${f.username}')" title="${t('soc_report')}">!</button>
        <span class="fr-unread" style="display:none">●</span>
      </div>`;
    container.appendChild(card);
  });
}

function renderPendingList(container) {
  if (!_socialPending.length) { container.innerHTML = `<div class="fr-empty">${t('soc_no_pending')}</div>`; return; }
  container.innerHTML = '';
  _socialPending.forEach(f => {
    const card = document.createElement('div');
    card.className = 'fr-friend-card';
    card.innerHTML = `
      <div class="fr-avatar">${(f.displayName||f.username||'?')[0].toUpperCase()}</div>
      <div class="fr-info">
        <div class="fr-name">${f.displayName||f.username}<span class="fr-username">@${f.username}</span></div>
        <div class="fr-status">Хочет добавить тебя в друзья</div>
      </div>
      <div class="fr-actions">
        <button class="fr-btn fr-accept-btn" onclick="frAccept('${f.id}')">✓ Принять</button>
        <button class="fr-btn fr-remove-btn" onclick="frRemove('${f.id}')">✕</button>
      </div>`;
    container.appendChild(card);
  });
}

function updateFriendCard(userId) {
  const card = document.querySelector(`[data-friend-id="${userId}"]`);
  if (!card) { socialRefreshFriendsList(); return; }
  const online  = _socialOnline.has(userId);
  const presence = _socialOnline.get(userId) || {};
  const statusEl  = card.querySelector('.fr-status');
  const actionsEl = card.querySelector('.fr-actions');
  if (statusEl) {
    statusEl.className = 'fr-status ' + (online ? 'online' : 'offline');
    statusEl.textContent = online ? (presence.server ? '🎮 '+presence.server : t('soc_online')) : t('soc_offline');
  }
  const modsToggle = card.querySelector('.fr-mods-toggle');
  const modsList   = card.querySelector('.fr-mods-list');
  if (presence.mods?.length) {
    if (!modsToggle) {
      const info = card.querySelector('.fr-info');
      const mt = document.createElement('div'); mt.className = 'fr-mods-toggle'; mt.onclick = () => frToggleMods(mt);
      const ml = document.createElement('div'); ml.className = 'fr-mods-list'; ml.style.display = 'none';
      mt.innerHTML = `<span>📦 ${presence.mods.length} модов</span><span class="fr-toggle-arrow">▶</span>`;
      ml.innerHTML = presence.mods.map(m=>`<div class="fr-mod-item">${m}</div>`).join('');
      info?.after(ml); info?.after(mt);
    } else {
      if (modsList) modsList.innerHTML = presence.mods.map(m=>`<div class="fr-mod-item">${m}</div>`).join('');
    }
  }
  if (actionsEl && online !== undefined) {
    const old = actionsEl.querySelector('.fr-join-btn');
    if (online && presence.server) {
      if (!old) {
        const btn = document.createElement('button');
        btn.className = 'fr-btn fr-join-btn'; btn.title = t('soc_connect');
        btn.textContent = '⚡ Join'; btn.onclick = () => frJoin(userId);
        actionsEl.prepend(btn);
      }
    } else { if (old) old.remove(); }
  }
}

window.frToggleMods = function(el) {
  const arr  = el.querySelector('.fr-toggle-arrow');
  const list = el.nextElementSibling;
  if (!list) return;
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : '';
  if (arr) arr.textContent = open ? '▶' : '▼';
};

window.frSwitchTab = function(tab) {
  document.querySelectorAll('.fr-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const el = document.getElementById('frFriendsTabActive');
  if (el) el.dataset.tab = tab;
  const container = document.getElementById('frFriendsList');
  if (!container) return;
  if (tab === 'friends') renderFriendsList(container);
  else if (tab === 'pending') renderPendingList(container);
  else if (tab === 'account') renderAccountTab(container);
};

function renderAccountTab(container) {
  const acc = typeof acCurrentAccount !== 'undefined' ? acCurrentAccount : null;
  const linked = _socialUser?.linkedAccounts || [];
  const isAdmin = _socialUser?.isAdmin === true;
  const linkedMs    = linked.find(l => l.type === 'microsoft');
  const linkedElyby = linked.find(l => l.type === 'elyby');
  const canLinkMs    = acc && acc.type === 'microsoft' && !linkedMs;
  const canLinkElyby = acc && acc.type === 'elyby' && !linkedElyby;

  container.innerHTML = `
    <div style="padding:12px;display:flex;flex-direction:column;gap:14px;">
      <div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">Смена ника</div>
        <input id="frChangeUsernameInput" class="fr-input" type="text" placeholder="${t('soc_new_nick')}" maxlength="64"
          value="${_socialUser?.username || ''}"
          onkeydown="if(event.key==='Enter')frChangeUsername()">
        <div class="fr-err" id="frChangeUsernameErr" style="margin-top:4px;font-size:11px;"></div>
        <button id="frChangeUsernameBtn" class="fr-submit" style="margin-top:8px;" onclick="frChangeUsername()">Сменить ник</button>
        <div style="font-size:10px;color:var(--text4);margin-top:4px;">Можно менять раз в 2 часа</div>
      </div>

      <div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">Отображаемое имя</div>
        <input id="frChangeDisplayNameInput" class="fr-input" type="text" placeholder="${t('soc_display_name')}" maxlength="32"
          value="${_socialUser?.displayName || ''}"
          onkeydown="if(event.key==='Enter')frChangeDisplayName()">
        <div class="fr-err" id="frChangeDisplayNameErr" style="margin-top:4px;font-size:11px;"></div>
        <button id="frChangeDisplayNameBtn" class="fr-submit" style="margin-top:8px;" onclick="frChangeDisplayName()">Изменить имя</button>
      </div>

      <div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">Привязанные аккаунты</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg3);padding:8px 10px;border-radius:8px;border:1px solid var(--border2);">
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--text);">Microsoft</div>
              <div style="font-size:10px;color:var(--text4);">${linkedMs ? linkedMs.external_username || t('soc_linked') : t('soc_not_linked')}</div>
            </div>
            ${linkedMs
              ? `<button onclick="frUnlinkAccount('microsoft')" style="font-size:11px;background:none;border:1px solid #cc4444;color:#cc4444;padding:4px 10px;border-radius:6px;cursor:pointer;">${t('soc_unlink')}</button>`
              : canLinkMs
                ? `<button onclick="frLinkAccount('microsoft')" style="font-size:11px;background:var(--accent);border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;">${t('soc_link')}</button>`
                : `<span style="font-size:10px;color:var(--text4);">${t('soc_link_ms')}</span>`
            }
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg3);padding:8px 10px;border-radius:8px;border:1px solid var(--border2);">
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--text);">Ely.by</div>
              <div style="font-size:10px;color:var(--text4);">${linkedElyby ? linkedElyby.external_username || t('soc_linked') : t('soc_not_linked')}</div>
            </div>
            ${linkedElyby
              ? `<button onclick="frUnlinkAccount('elyby')" style="font-size:11px;background:none;border:1px solid #cc4444;color:#cc4444;padding:4px 10px;border-radius:6px;cursor:pointer;">${t('soc_unlink')}</button>`
              : canLinkElyby
                ? `<button onclick="frLinkAccount('elyby')" style="font-size:11px;background:var(--accent);border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;">${t('soc_link')}</button>`
                : `<span style="font-size:10px;color:var(--text4);">${t('soc_link_ely')}</span>`
            }
          </div>
        </div>
        <div class="fr-err" id="frLinkErr" style="margin-top:6px;font-size:11px;"></div>
        <div id="frLinkSuccess" style="margin-top:6px;font-size:11px;color:#44cc88;"></div>
      </div>

      <div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">Пароль</div>
        <input id="frNewPassInput" class="fr-input" type="password" placeholder="${t('soc_new_pass')}" autocomplete="new-password">
        <input id="frNewPass2Input" class="fr-input" type="password" placeholder="${t('soc_repeat_pass')}" style="margin-top:6px;" autocomplete="new-password">
        <div class="fr-err" id="frChangePassErr" style="margin-top:4px;font-size:11px;"></div>
        <button id="frChangePassBtn" class="fr-submit" style="margin-top:8px;" onclick="frChangePassword()">Установить / сменить пароль</button>
      </div>

      ${isAdmin ? `
      <div style="margin-top:4px;padding:12px;background:linear-gradient(135deg,#1a0a2e,#0d1a3a);border:1px solid #6644aa;border-radius:12px;">
        <div style="font-size:11px;color:#aa88ff;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">${t('adm_panel')}</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button onclick="frAdminPanel()" style="width:100%;padding:9px;border:none;background:linear-gradient(135deg,#6644aa,#4422ee);color:#fff;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;transition:.15s;" onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">Управление пользователями</button>
          <button onclick="frAdminStats()" style="width:100%;padding:9px;border:none;background:rgba(102,68,170,.2);border:1px solid #6644aa44;color:#aa88ff;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:.15s;" onmouseover="this.style.background='rgba(102,68,170,.35)'" onmouseout="this.style.background='rgba(102,68,170,.2)'">Статистика сервера</button>
        </div>
      </div>` : ''}

      <div style="margin-top:8px;padding-top:14px;border-top:1px solid var(--border);">
        <button onclick="frDeleteAccount()" style="width:100%;padding:10px;border:none;background:#cc2222;color:#fff;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;transition:.15s;" onmouseover="this.style.background='#aa1a1a'" onmouseout="this.style.background='#cc2222'">Удалить аккаунт</button>
      </div>
    </div>`;
}

window.frJoin = function(userId) {
  const presence = _socialOnline.get(userId);
  if (presence?.server) { appendLog(t('soc_connecting') + ' ' + presence.server); }
};

window.frOpenChat = async function(id, username, displayName) {
  _chatTarget   = { id, username, displayName };
  _chatMessages = [];
  const main  = document.getElementById('frMain');
  const sidebar = main?.querySelector('.fr-sidebar');
  const chat  = document.getElementById('frChat');
  if (!chat) return;
  const badge = document.querySelector(`[data-friend-id="${id}"] .fr-unread`);
  if (badge) badge.style.display = 'none';
  document.getElementById('frChatName').textContent    = displayName || username;
  document.getElementById('frChatSubname').textContent = '@' + username;
  const av = document.getElementById('frChatAvatar');
  if (av) av.textContent = (displayName||username||'?')[0].toUpperCase();
  if (sidebar) sidebar.style.display = 'none';
  chat.style.display = 'flex';
  try {
    const msgs = await socialAPI('socialMessages', { token: _socialToken, friendId: id });
    _chatMessages = Array.isArray(msgs) ? msgs : [];
  } catch {}
  renderChatMessages();
};

window.frCloseChat = function() {
  _chatTarget = null;
  const main    = document.getElementById('frMain');
  const sidebar = main?.querySelector('.fr-sidebar');
  const chat    = document.getElementById('frChat');
  if (sidebar) sidebar.style.display = '';
  if (chat) chat.style.display = 'none';
};

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderChatMessages() {
  const container = document.getElementById('frChatMessages');
  if (!container) return;
  container.innerHTML = '';
  _chatMessages.forEach(m => {
    const mine = m.fromId === _socialUser?.id;
    const d = document.createElement('div');
    d.className = 'fr-msg ' + (mine ? 'fr-msg-mine' : 'fr-msg-theirs');
    const date = new Date((m.ts||0)*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    d.innerHTML = `<span class="fr-msg-text">${escHtml(m.content)}</span><span class="fr-msg-time">${date}</span>`;
    container.appendChild(d);
  });
  container.scrollTop = container.scrollHeight;
}

window.frSendMessage = async function() {
  const input = document.getElementById('frChatInput');
  const text = input?.value.trim();
  if (!text || !_chatTarget) return;
  input.value = '';
  socialSendWS({ type:'message', toId:_chatTarget.id, content:text });
};

window.frAddFriend = async function() {
  const input = document.getElementById('frAddInput');
  const val   = input?.value.trim().replace(/^@/, '');
  const err   = document.getElementById('frAddError');
  if (!val) return;
  if (err) err.textContent = '';
  try {
    await socialAPI('socialAddFriend', { token:_socialToken, username:val });
    if (input) input.value = '';
    await socialLoadFriendList();
    socialRefreshFriendsList();
  } catch(e) { if (err) err.textContent = e.message; }
};

// ── Block ────────────────────────────────────────────────────────────────────
window.frBlock = function(userId, username) {
  frConfirmModal({
    icon: null,
    title: t('soc_block_user') + username + '?',
    subtitle: 'Пользователь будет удалён из друзей и заблокирован. Вы не сможете получать сообщения от него.',
    confirmLabel: t('soc_block'),
    confirmClass: 'danger',
    requirePassword: false,
    onConfirm: async () => {
      await socialAPI('socialBlock', { token: _socialToken, userId });
      _socialFriends = _socialFriends.filter(f => f.id !== userId);
      socialRefreshFriendsList();
    }
  });
};

// ── Report ───────────────────────────────────────────────────────────────────
window.frReport = function(userId, username) {
  // Показываем модалку с полем причины
  document.getElementById('frConfirmModalOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'frConfirmModalOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;';

  const box = document.createElement('div');
  box.style.cssText = 'background:#13131a;border:1px solid #2a2a3a;border-radius:20px;padding:28px 32px;width:340px;display:flex;flex-direction:column;gap:14px;box-shadow:0 24px 80px rgba(0,0,0,.8);animation:frBoxIn .22s cubic-bezier(.34,1.56,.64,1);';
  box.innerHTML = `
    <div style="font-size:16px;font-weight:800;color:#e8e8f0;">Пожаловаться на @${username}</div>
    <select id="frReportReason" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);padding:9px 12px;font-size:13px;outline:none;">
      <option value="spam">Спам / флуд</option>
      <option value="insult">Оскорбления / харассмент</option>
      <option value="cheat">Читерство в игре</option>
      <option value="other">Другое</option>
    </select>
    <textarea id="frReportText" placeholder="${t('soc_report_desc')}" style="width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);padding:9px 12px;font-size:13px;outline:none;resize:vertical;min-height:80px;font-family:inherit;"></textarea>
    <div id="frReportErr" style="font-size:12px;color:#cc4444;min-height:14px;"></div>
    <div style="display:flex;gap:10px;">
      <button id="frReportCancelBtn" style="flex:1;padding:11px;border:1px solid var(--border2);border-radius:9px;background:var(--bg3);color:var(--text2);font-weight:600;font-size:13px;cursor:pointer;">Отмена</button>
      <button id="frReportSendBtn" style="flex:1;padding:11px;border:none;border-radius:9px;background:#cc6622;color:#fff;font-weight:700;font-size:13px;cursor:pointer;">Отправить</button>
    </div>`;

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('frReportCancelBtn').onclick = () => overlay.remove();
  document.getElementById('frReportSendBtn').onclick = async () => {
    const reason = document.getElementById('frReportReason').value;
    const text   = document.getElementById('frReportText').value.trim();
    const errEl  = document.getElementById('frReportErr');
    const btn    = document.getElementById('frReportSendBtn');
    btn.disabled = true; btn.textContent = t('soc_sending');
    try {
      await socialAPI('socialReport', { token: _socialToken, userId, reason, text });
      overlay.remove();
      // Показать уведомление
      const toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:300000;background:#1a2a1a;border:1px solid #44cc88;border-radius:12px;padding:12px 18px;color:#44cc88;font-size:13px;font-weight:600;animation:frFadeIn .2s ease;';
      toast.textContent = t('soc_report_sent');
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    } catch(e) {
      errEl.textContent = e.message;
      btn.disabled = false; btn.textContent = t('soc_send');
    }
  };
};

window.frAccept = async function(userId) {
  try { await socialAPI('socialAccept', { token:_socialToken, userId }); await socialLoadFriendList(); socialRefreshFriendsList(); }
  catch(e) { console.error(e.message); }
};

window.frRemove = async function(userId) {
  try { await socialAPI('socialRemove', { token:_socialToken, userId }); await socialLoadFriendList(); socialRefreshFriendsList(); }
  catch(e) { console.error(e.message); }
};

// ── Auth handlers ─────────────────────────────────────────────────
window.frLogin = async function() {
  const username = document.getElementById('frLoginUsername')?.value.trim();
  const pass     = document.getElementById('frLoginPass')?.value;
  const err      = document.getElementById('frLoginErr');
  const btn      = document.getElementById('frLoginBtn');
  if (!username || !pass) { if (err) err.textContent = t('soc_fill_fields'); return; }
  if (btn) btn.disabled = true;
  try {
    const res = await socialAPI('socialLogin', { username, password:pass });
    socialSaveSession(res.token, res.user);
    _friendsView = 'main';
    await socialLoadFriendList(); socialConnect(); loadFriends();
  } catch(e) {
    if (err) err.textContent = e.message;
  } finally { if (btn) btn.disabled = false; }
};

window.frLoginOAuth = function(type) {
  frShowAccountPicker(type, async (acc) => {
    const err = document.getElementById('frLoginErr');
    // Find oauth login button and show loading
    const btns = document.querySelectorAll('.fr-submit');
    let oauthBtn = null;
    btns.forEach(b => { if (b.textContent.includes(type === 'elyby' ? 'Ely.by' : 'Microsoft') && b.textContent.includes(t('soc_login'))) oauthBtn = b; });
    if (oauthBtn) { oauthBtn.disabled = true; oauthBtn.textContent = t('soc_wait'); }
    try {
      if (!acc.uuid) {
        if (err) err.textContent = 'UUID не найден — перевойди в Minecraft аккаунт';
        if (oauthBtn) { oauthBtn.disabled = false; oauthBtn.textContent = t('soc_login_via') + ' ' + (type === 'elyby' ? 'Ely.by' : 'Microsoft'); }
        return;
      }
      const res = await socialAPI('socialOAuthLogin', { type, externalId: acc.uuid, externalUsername: acc.username });
      socialSaveSession(res.token, res.user);
      _friendsView = 'main';
      await socialLoadFriendList(); socialConnect(); loadFriends();
    } catch(e) {
      if (err) err.textContent = e.message;
      if (oauthBtn) { oauthBtn.disabled = false; oauthBtn.textContent = t('soc_login_via') + ' ' + (type === 'elyby' ? 'Ely.by' : 'Microsoft'); }
    }
  });
};

// Shows an overlay with accounts of the given type and a "Select" button, then calls callback(acc)
function frShowAccountPicker(type, onSelect) {
  const accs = (typeof acAllAccounts !== 'undefined' ? acAllAccounts : []).filter(a => a.type === type);
  if (accs.length === 1) { onSelect(accs[0]); return; }
  if (accs.length === 0) {
    const err = document.getElementById('frRegErr') || document.getElementById('frLoginErr');
    if (err) { err.style.color='#cc4444'; err.textContent = t('soc_no_accounts') + ' ' + (type === 'elyby' ? 'Ely.by' : 'Microsoft') + t('soc_login_mc'); }
    return;
  }

  document.getElementById('frConfirmModalOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'frConfirmModalOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;animation:frOverlayIn .18s ease;';

  const box = document.createElement('div');
  box.style.cssText = 'background:#13131a;border:1px solid #2a2a3a;border-radius:20px;padding:28px 32px;width:340px;display:flex;flex-direction:column;gap:14px;box-shadow:0 24px 80px rgba(0,0,0,.8);animation:frBoxIn .22s cubic-bezier(.34,1.56,.64,1);';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:16px;font-weight:800;color:#e8e8f0;text-align:center;';
  title.textContent = t('soc_choose_acc') + ' ' + (type === 'elyby' ? 'Ely.by' : 'Microsoft');
  box.appendChild(title);

  accs.forEach(acc => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;background:#1a1a24;border:1px solid #2a2a3a;border-radius:12px;padding:10px 14px;gap:10px;';
    row.innerHTML = `<div><div style="font-size:14px;font-weight:600;color:#d0d0e8;">${escHtml(acc.username)}</div><div style="font-size:11px;color:#555570;">${type === 'elyby' ? 'Ely.by' : 'Microsoft'}</div></div>`;
    const btn = document.createElement('button');
    btn.textContent = t('soc_select');
    btn.className = 'fr-submit';
    btn.style.cssText = 'width:auto;padding:7px 16px;font-size:12px;flex-shrink:0;';
    btn.onclick = () => { overlay.remove(); onSelect(acc); };
    row.appendChild(btn);
    box.appendChild(row);
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = t('soc_cancel');
  cancelBtn.style.cssText = 'background:none;border:none;color:#555570;font-size:12px;cursor:pointer;text-align:center;padding:4px;';
  cancelBtn.onclick = () => overlay.remove();
  box.appendChild(cancelBtn);

  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  if (!document.getElementById('frConfirmModalStyles')) {
    const s = document.createElement('style');
    s.id = 'frConfirmModalStyles';
    s.textContent = '@keyframes frOverlayIn{from{opacity:0}to{opacity:1}}@keyframes frBoxIn{from{opacity:0;transform:scale(.88) translateY(16px)}to{opacity:1;transform:none}}';
    document.head.appendChild(s);
  }
}

window.frRegisterOAuth = function(type) {
  frShowAccountPicker(type, async (acc) => {
    const err = document.getElementById('frRegErr');
    // Find the oauth button that was clicked and show loading
    const btns = document.querySelectorAll('.fr-submit');
    let oauthBtn = null;
    btns.forEach(b => { if (b.textContent.includes(type === 'elyby' ? 'Ely.by' : 'Microsoft') && b.textContent.includes(t('soc_reg_short'))) oauthBtn = b; });
    if (oauthBtn) { oauthBtn.disabled = true; oauthBtn.textContent = t('soc_wait'); }
    if (err) { err.style.color = '#cc4444'; err.textContent = ''; }
    if (!acc.uuid) {
      if (err) err.textContent = 'UUID не найден — перевойди в Minecraft аккаунт';
      if (oauthBtn) { oauthBtn.disabled = false; oauthBtn.textContent = t('soc_reg_via') + ' ' + (type === 'elyby' ? 'Ely.by' : 'Microsoft'); }
      return;
    }
    try {
      // Try login first (account might already exist)
      try {
        const loginRes = await socialAPI('socialOAuthLogin', { type, externalId: acc.uuid, externalUsername: acc.username });
        socialSaveSession(loginRes.token, loginRes.user);
        _friendsView = 'main';
        await socialLoadFriendList(); socialConnect(); loadFriends();
        return;
      } catch { /* not registered yet, proceed to create */ }

      const baseUsername = (acc.username || 'user').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24);
      const username = baseUsername.length >= 3 ? baseUsername : baseUsername + '_mc';
      const res = await socialAPI('socialRegister', { username, displayName: acc.username, password: uuidv4Simple() });
      await socialAPI('socialLink', { token: res.token, type, externalId: acc.uuid, externalUsername: acc.username }).catch(() => {});
      socialSaveSession(res.token, res.user);
      _friendsView = 'setup_avatar';
      loadFriends();
    } catch(e) {
      if (err) err.textContent = e.message;
      if (oauthBtn) { oauthBtn.disabled = false; oauthBtn.textContent = t('soc_reg_via') + ' ' + (type === 'elyby' ? 'Ely.by' : 'Microsoft'); }
    }
  });
};

function uuidv4Simple() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

window.frRegister = async function() {
  const username = document.getElementById('frRegUsername')?.value.trim();
  const displayName = document.getElementById('frRegDisplayName')?.value.trim() || '';
  const pass     = document.getElementById('frRegPass')?.value;
  const pass2    = document.getElementById('frRegPass2')?.value;
  const err      = document.getElementById('frRegErr');
  const btn      = document.getElementById('frRegBtn');
  if (err) { err.style.color = '#cc4444'; err.textContent = ''; }
  if (!username || !pass) { if (err) err.textContent = t('soc_fill_fields'); return; }
  if (username.length < 1 || username.length > 64) { if (err) err.textContent = t('soc_nick_len'); return; }
  if (pass.length < 6) { if (err) err.textContent = t('soc_pass_min'); return; }
  if (pass !== pass2)  { if (err) err.textContent = t('soc_pass_mismatch'); return; }
  if (btn) btn.disabled = true;
  try {
    const res = await socialAPI('socialRegister', { username, displayName: displayName || username, password:pass });
    socialSaveSession(res.token, res.user);
    // Сразу привязываем текущий MC аккаунт если он не локальный
    const acc = typeof acCurrentAccount !== 'undefined' ? acCurrentAccount : null;
    if (acc && acc.type !== 'local' && acc.uuid) {
      await socialAPI('socialLink', { token: res.token, type: acc.type, externalId: acc.uuid, externalUsername: acc.username }).catch(() => {});
    }
    _friendsView = 'setup_avatar';
    loadFriends();
  } catch(e) {
    if (err) { err.style.color = '#cc4444'; err.textContent = e.message; err.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
  } finally { if (btn) btn.disabled = false; }
};

window.frChangeUsername = async function() {
  const uname = document.getElementById('frChangeUsernameInput')?.value.trim();
  const err   = document.getElementById('frChangeUsernameErr');
  const btn   = document.getElementById('frChangeUsernameBtn');
  if (!uname) { if (err) err.textContent = t('soc_enter_nick'); return; }
  if (uname.length > 64) { if (err) err.textContent = t('soc_nick_long'); return; }
  if (btn) btn.disabled = true;
  try {
    const res = await socialAPI('socialChangeUsername', { token:_socialToken, username:uname });
    if (!res || !res.user) throw new Error(t('soc_server_err'));
    socialSaveSession(_socialToken, res.user);
    _socialUser = res.user;
    if (err) { err.style.color = '#44cc88'; err.textContent = t('soc_nick_changed') + ' ' + res.user.username; }
  } catch(e) {
    if (err) { err.style.color = '#cc4444'; err.textContent = e.message; }
  } finally { if (btn) btn.disabled = false; }
};

window.frChangeDisplayName = async function() {
  const dname = document.getElementById('frChangeDisplayNameInput')?.value.trim();
  const err   = document.getElementById('frChangeDisplayNameErr');
  const btn   = document.getElementById('frChangeDisplayNameBtn');
  if (!dname) { if (err) { err.style.color='#cc4444'; err.textContent = t('soc_enter_dname'); } return; }
  if (dname.length > 32) { if (err) { err.style.color='#cc4444'; err.textContent = t('soc_dname_long'); } return; }
  if (btn) btn.disabled = true;
  try {
    const res = await socialAPI('socialChangeDisplayName', { token:_socialToken, displayName:dname });
    if (!res || !res.user) throw new Error(t('soc_server_err2'));
    socialSaveSession(_socialToken, res.user);
    _socialUser = res.user;
    if (err) { err.style.color = '#44cc88'; err.textContent = t('soc_dname_changed') + ' ' + res.user.displayName; }
  } catch(e) {
    if (err) { err.style.color = '#cc4444'; err.textContent = e.message; }
  } finally { if (btn) btn.disabled = false; }
};

window.frChangePassword = async function() {
  const pass  = document.getElementById('frNewPassInput')?.value;
  const pass2 = document.getElementById('frNewPass2Input')?.value;
  const err   = document.getElementById('frChangePassErr');
  const btn   = document.getElementById('frChangePassBtn');
  if (err) { err.style.color = '#cc4444'; err.textContent = ''; }
  if (!pass) { if (err) err.textContent = t('soc_enter_pass'); return; }
  if (pass.length < 6) { if (err) err.textContent = t('soc_pass_min'); return; }
  if (pass !== pass2) { if (err) err.textContent = t('soc_pass_mismatch'); return; }
  if (btn) btn.disabled = true;
  try {
    await socialAPI('socialChangePassword', { token: _socialToken, password: pass });
    _socialUser._hasPassword = true;
    if (err) { err.style.color = '#44cc88'; err.textContent = t('soc_pass_set'); }
    if (document.getElementById('frNewPassInput')) document.getElementById('frNewPassInput').value = '';
    if (document.getElementById('frNewPass2Input')) document.getElementById('frNewPass2Input').value = '';
  } catch(e) {
    if (err) { err.style.color = '#cc4444'; err.textContent = e.message; }
  } finally { if (btn) btn.disabled = false; }
};

window.frLinkAccount = async function(type) {
  const err = document.getElementById('frLinkErr');
  const ok  = document.getElementById('frLinkSuccess');
  if (err) err.textContent = '';
  if (ok)  ok.textContent  = '';
  try {
    const acc = typeof acCurrentAccount !== 'undefined' ? acCurrentAccount : null;
    if (!acc || !acc.uuid) { if (err) { err.style.color='#cc4444'; err.textContent=t('soc_no_active'); } return; }
    if (acc.type !== type) { if (err) { err.style.color='#cc4444'; err.textContent=`${t('soc_no_active')} (${type === 'microsoft' ? 'Microsoft' : 'Ely.by'})`; } return; }
    const res = await socialAPI('socialLink', { token:_socialToken, type, externalId:acc.uuid, externalUsername:acc.username });
    _socialUser = { ..._socialUser, linkedAccounts: res.linkedAccounts };
    socialSaveSession(_socialToken, _socialUser);
    // Остаёмся на вкладке аккаунта — перерисовываем только её
    const container = document.getElementById('frFriendsList');
    if (container) renderAccountTab(container);
    if (ok) { ok.textContent = `${type === 'microsoft' ? 'Microsoft' : 'Ely.by'} ${t('soc_acc_linked')}`; }
  } catch(e) {
    if (err) { err.style.color='#cc4444'; err.textContent=e.message; }
  }
};

// ── Admin panel functions ─────────────────────────────────────────
// ── Вкладки админ-панели ────────────────────────────────────────────────────
let _adminTab = 'users';

window.frAdminPanel = async function(tab) {
  _adminTab = tab || 'users';
  const container = document.getElementById('frFriendsList');
  if (!container) return;
  container.innerHTML = `<div style="padding:12px;display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
      <div style="font-size:13px;font-weight:800;color:#aa88ff;">${t('adm_panel')}</div>
      <button onclick="frSwitchTab('account')" style="background:none;border:none;color:var(--text4);font-size:18px;cursor:pointer;line-height:1;">✕</button>
    </div>
    <div style="display:flex;gap:4px;flex-shrink:0;">
      <button onclick="frAdminPanel('users')" style="flex:1;padding:7px;border:none;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;transition:.15s;${_adminTab==='users'?'background:linear-gradient(135deg,#6644aa,#4422ee);color:#fff;':'background:var(--bg3);border:1px solid var(--border2);color:var(--text3);'}">${t('adm_users')}</button>
      <button onclick="frAdminPanel('reports')" style="flex:1;padding:7px;border:none;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;transition:.15s;${_adminTab==='reports'?'background:linear-gradient(135deg,#6644aa,#4422ee);color:#fff;':'background:var(--bg3);border:1px solid var(--border2);color:var(--text3);'}">${t('adm_reports')}</button>
      <button onclick="frAdminStats()" style="flex:1;padding:7px;border:none;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;background:var(--bg3);border:1px solid var(--border2);color:var(--text3);transition:.15s;">${t('adm_stats')}</button>
    </div>
    ${_adminTab === 'users' ? `
    <input id="frAdminSearchInput" class="fr-input" placeholder="${t('soc_search_nick')}" oninput="frAdminDoSearch(this.value)" style="flex-shrink:0;">` : ''}
    <div id="frAdminContent" style="display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex:1;">
      <div style="color:var(--text4);font-size:12px;text-align:center;padding:16px;">${t('adm_loading')}</div>
    </div>
  </div>`;

  if (_adminTab === 'users') {
    try {
      const users = await socialAPI('socialAdminUsers', { token: _socialToken, query: '' });
      frRenderAdminUsers(users);
    } catch(e) {
      const c = document.getElementById('frAdminContent');
      if (c) c.innerHTML = `<div style="color:#cc4444;font-size:12px;">${e.message}</div>`;
    }
  } else if (_adminTab === 'reports') {
    try {
      const reports = await socialAPI('socialAdminReports', { token: _socialToken });
      frRenderAdminReports(reports);
    } catch(e) {
      const c = document.getElementById('frAdminContent');
      if (c) c.innerHTML = `<div style="color:#cc4444;font-size:12px;">${e.message}</div>`;
    }
  }
};

window.frAdminDoSearch = async function(q) {
  try {
    const users = await socialAPI('socialAdminUsers', { token: _socialToken, query: q || '' });
    frRenderAdminUsers(users);
  } catch {}
};

function frAdminUserIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
}

function frAdminCrownSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="#aa88ff" style="display:inline-block;vertical-align:middle;margin-bottom:1px;"><path d="M2 19l3-10 4 5 3-8 3 8 4-5 3 10H2z"/></svg>`;
}

function frRenderAdminUsers(users) {
  const list = document.getElementById('frAdminContent');
  if (!list) return;
  if (!users || !users.length) { list.innerHTML = `<div style="color:var(--text4);font-size:12px;text-align:center;padding:16px;">${t('adm_no_users')}</div>`; return; }
  const isDev = _socialUser?.username?.toLowerCase() === 'dev';
  list.innerHTML = users.map(u => {
    const adminBtnStyle = u.isAdmin
      ? `background:#3a1a6e;border:1px solid #aa88ff;color:#aa88ff;`
      : `background:none;border:1px solid #441133;color:#cc4466;`;
    const btnBase = `font-size:10px;padding:5px 7px;border-radius:5px;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;width:28px;height:28px;box-sizing:border-box;`;
    return `
    <div style="background:var(--bg3);padding:8px 10px;border-radius:8px;border:1px solid ${u.banned?'#aa2222':u.isAdmin?'#6644aa55':'var(--border2)'};animation:frFadeIn .18s ease;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="min-width:0;flex:1;">
          <div style="font-size:12px;font-weight:600;color:${u.banned?'#cc4444':u.isAdmin?'#aa88ff':'var(--text)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${u.isAdmin ? frAdminCrownSvg()+' ' : ''}${u.displayName || u.username}${u.banned?` <span style="font-size:9px;color:#cc4444;">${t('adm_banned')}</span>`:''}
          </div>
          <div style="font-size:10px;color:var(--text4);">@${u.username} · <span style="font-family:monospace;cursor:pointer;text-decoration:underline dotted;" onclick="frAdminCopyId('${u.id}')" title="${t('adm_copy_id')}">${u.id.slice(0,10)}</span></div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,28px);gap:3px;flex-shrink:0;">
          <button onclick="frAdminViewUser('${u.id}','${u.username}','${(u.displayName||u.username).replace(/'/g,"\\'")}','${u.isAdmin}')" title="${t('adm_view')}" style="${btnBase}background:none;border:1px solid var(--border2);color:var(--text3);">${frAdminUserIconSvg()}</button>
          <button onclick="frAdminChangeId('${u.id}','${u.username}')" title="${t('adm_change_id')}" style="${btnBase}background:none;border:1px solid #4488cc;color:#4488cc;font-size:9px;font-weight:700;">ID</button>
          ${isDev ? `<button onclick="${u.isAdmin?`frAdminRevokeAdmin('${u.id}','${u.username}')`:`frAdminGrantAdmin('${u.id}','${u.username}')`}" title="${u.isAdmin?t('adm_revoke_admin'):t('adm_grant_admin_btn')}" style="${btnBase}${adminBtnStyle}font-size:8px;font-weight:900;line-height:1.1;">${u.isAdmin?t('adm_revoke'):t('adm_grant')}</button>` : `<div></div>`}
          ${u.banned
            ? `<button onclick="frAdminUnban('${u.id}','${u.username}')" title="${t('adm_unban')}" style="${btnBase}background:none;border:1px solid #44cc88;color:#44cc88;font-size:14px;">↑</button>`
            : `<button onclick="frAdminBan('${u.id}','${u.username}')" title="${t('adm_ban')}" style="${btnBase}background:none;border:1px solid #cc8822;color:#cc8822;font-size:14px;">⊘</button>`
          }
        </div>
        <button onclick="frAdminDeleteUser('${u.id}','${u.username}')" title="${t('adm_delete')}" style="${btnBase}background:none;border:1px solid #cc4444;color:#cc4444;font-size:14px;flex-shrink:0;">✕</button>
      </div>
    </div>`;
  }).join('');
}

function frRenderAdminReports(reports) {
  const list = document.getElementById('frAdminContent');
  if (!list) return;
  if (!reports || !reports.length) { list.innerHTML = `<div style="color:var(--text4);font-size:12px;text-align:center;padding:16px;">${t('adm_no_reports')}</div>`; return; }
  const reasons = { spam:t('adm_spam'), insult:t('adm_abuse'), cheat:t('adm_cheat'), other:t('adm_other') };
  list.innerHTML = reports.map(r => `
    <div style="background:var(--bg3);padding:10px;border-radius:8px;border:1px solid var(--border2);animation:frFadeIn .18s ease;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--text);">На: @${r.reported_username}</div>
          <div style="font-size:10px;color:var(--text4);">От: @${r.reporter_username} · ${reasons[r.reason]||r.reason}</div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button onclick="frAdminBan('${r.reported_id}','${r.reported_username}')" style="font-size:10px;background:none;border:1px solid #cc8822;color:#cc8822;padding:3px 8px;border-radius:5px;cursor:pointer;">Бан</button>
          <button onclick="frAdminDismissReport('${r.id}')" style="font-size:10px;background:none;border:1px solid var(--border2);color:var(--text3);padding:3px 8px;border-radius:5px;cursor:pointer;">Закрыть</button>
        </div>
      </div>
      ${r.text ? `<div style="font-size:11px;color:var(--text3);background:var(--bg);padding:6px 8px;border-radius:6px;">${r.text}</div>` : ''}
    </div>`).join('');
}

window.frAdminBan = function(userId, username) {
  frConfirmModal({
    icon: null,
    title: t('adm_ban_title') + username + '?',
    subtitle: t('adm_ban_desc'),
    confirmLabel: t('adm_ban'),
    confirmClass: 'danger',
    requirePassword: false,
    onConfirm: async () => {
      await socialAPI('socialAdminBan', { token: _socialToken, userId });
      frAdminPanel(_adminTab);
    }
  });
};

window.frAdminUnban = function(userId, username) {
  frConfirmModal({
    icon: null,
    title: t('adm_unban_title') + username + '?',
    subtitle: t('adm_unban_desc'),
    confirmLabel: t('adm_unban'),
    confirmClass: '',
    requirePassword: false,
    onConfirm: async () => {
      await socialAPI('socialAdminUnban', { token: _socialToken, userId });
      frAdminPanel(_adminTab);
    }
  });
};

window.frAdminDeleteUser = function(userId, username) {
  frConfirmModal({
    icon: null,
    title: t('adm_delete_title') + username + '?',
    subtitle: t('adm_delete_desc'),
    confirmLabel: t('adm_delete'),
    confirmClass: 'danger',
    requirePassword: false,
    onConfirm: async () => {
      await socialAPI('socialAdminDeleteUser', { token: _socialToken, userId });
      frAdminPanel(_adminTab);
    }
  });
};

window.frAdminDismissReport = async function(reportId) {
  try {
    await socialAPI('socialAdminDismissReport', { token: _socialToken, reportId });
    frAdminPanel('reports');
  } catch(e) { console.error(e); }
};

window.frAdminCopyId = function(userId) {
  navigator.clipboard?.writeText(userId).catch(() => {});
};

window.frAdminViewUser = function(userId, username, displayName, isAdmin) {
  document.getElementById('frConfirmModalOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'frConfirmModalOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99999;display:flex;align-items:center;justify-content:center;animation:frOverlayIn .15s ease;';
  const adminBadge = (isAdmin === 'true' || isAdmin === true)
    ? `<span style="font-size:10px;background:linear-gradient(135deg,#6644aa,#4422ee);color:#fff;padding:2px 8px;border-radius:10px;font-weight:700;">ADMIN</span>` : '';
  overlay.innerHTML = `
    <div style="background:#1a1a2e;border:1px solid #6644aa55;border-radius:14px;padding:24px;min-width:280px;max-width:360px;animation:frBoxIn .18s ease;text-align:center;">
      <div style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#6644aa,#4422ee);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:26px;font-weight:800;color:#fff;">
        ${(displayName||username||'?')[0].toUpperCase()}
      </div>
      <div style="font-size:16px;font-weight:800;color:#e8e8f0;margin-bottom:4px;">${displayName}</div>
      <div style="font-size:12px;color:#8888aa;margin-bottom:8px;">@${username}</div>
      <div style="font-size:10px;font-family:monospace;color:#666688;margin-bottom:10px;cursor:pointer;" onclick="navigator.clipboard?.writeText('${userId}')" title="${t('adm_copy')}">ID: ${userId}</div>
      ${adminBadge}
      <div style="margin-top:16px;">
        <button onclick="document.getElementById('frConfirmModalOverlay').remove()" style="padding:8px 24px;border:1px solid var(--border2);background:none;color:var(--text3);border-radius:8px;cursor:pointer;font-size:13px;">Закрыть</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
};

window.frAdminChangeId = function(userId, username) {
  frInputModal({
    title: t('adm_change_id_title') + username,
    subtitle: t('adm_change_id_desc'),
    placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    confirmLabel: t('adm_change_id_btn'),
    confirmClass: 'danger',
    validate: v => v.length < 1 ? 'ID не может быть пустым' : null,
    onConfirm: async (newId) => {
      try {
        await socialAPI('socialAdminChangeId', { token: _socialToken, userId, newId });
        frAdminPanel(_adminTab);
      } catch(e) {
        alert(t('adm_change_id_err') + ' ' + e.message);
      }
    }
  });
};

window.frAdminGrantAdmin = function(userId, username) {
  frConfirmModal({
    icon: null,
    title: `${t('adm_grant_title').replace('@','@' + username + ' ')}`,
    subtitle: t('adm_grant_desc'),
    confirmLabel: t('adm_grant_btn'),
    confirmClass: '',
    requirePassword: false,
    onConfirm: async () => {
      const res = await socialAPI('socialAdminGrantAdmin', { token: _socialToken, userId });
      if (res && res.error) { alert(res.error); return; }
      frAdminPanel(_adminTab);
    }
  });
};

window.frAdminRevokeAdmin = function(userId, username) {
  frConfirmModal({
    icon: null,
    title: t('adm_revoke_title') + username + '?',
    subtitle: t('adm_revoke_desc'),
    confirmLabel: t('adm_revoke_admin'),
    confirmClass: 'danger',
    requirePassword: false,
    onConfirm: async () => {
      const res = await socialAPI('socialAdminRevokeAdmin', { token: _socialToken, userId });
      if (res && res.error) { alert(res.error); return; }
      frAdminPanel(_adminTab);
    }
  });
};

window.frAdminStats = async function() {
  const container = document.getElementById('frFriendsList');
  if (!container) return;
  container.innerHTML = `<div style="padding:12px;display:flex;flex-direction:column;gap:10px;">
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div style="font-size:13px;font-weight:800;color:#aa88ff;">Статистика</div>
      <button onclick="frSwitchTab('account')" style="background:none;border:none;color:var(--text4);font-size:18px;cursor:pointer;">✕</button>
    </div>
    <div id="frAdminStatsContent" style="display:flex;flex-direction:column;gap:8px;">
      <div style="color:var(--text4);font-size:12px;text-align:center;padding:16px;">${t('adm_loading')}</div>
    </div>
  </div>`;
  try {
    const stats = await socialAPI('socialAdminStats', { token: _socialToken });
    const sc = document.getElementById('frAdminStatsContent');
    if (sc) sc.innerHTML = [
      { label: t('adm_stat_users'), value: stats.users },
      { label: t('adm_stat_friends'), value: stats.friends },
      { label: t('adm_stat_msgs'), value: stats.messages },
      { label: t('adm_stat_online'), value: stats.online },
    ].map(s => `<div style="display:flex;justify-content:space-between;align-items:center;background:var(--bg3);padding:10px 14px;border-radius:9px;border:1px solid var(--border2);animation:frFadeIn .2s ease;">
      <div style="font-size:12px;color:var(--text3);">${s.label}</div>
      <div style="font-size:18px;font-weight:800;color:#aa88ff;">${s.value ?? '—'}</div>
    </div>`).join('');
  } catch(e) {
    const sc = document.getElementById('frAdminStatsContent');
    if (sc) sc.innerHTML = `<div style="color:#cc4444;font-size:12px;">${e.message}</div>`;
  }
};

window.frUnlinkAccount = async function(type) {
  const err = document.getElementById('frLinkErr');
  try {
    const res = await socialAPI('socialUnlink', { token:_socialToken, type });
    _socialUser = { ..._socialUser, linkedAccounts: res.linkedAccounts };
    socialSaveSession(_socialToken, _socialUser);
    // Остаёмся на вкладке аккаунта
    const container = document.getElementById('frFriendsList');
    if (container) renderAccountTab(container);
  } catch(e) {
    if (err) { err.style.color='#cc4444'; err.textContent=e.message; }
  }
};

window.frSetupAvatar = async function() {
  // Triggered from setup step: use MC skin
  try {
    const acc = typeof acCurrentAccount !== 'undefined' ? acCurrentAccount : null;
    if (!acc) { frSkipAvatar(); return; }
    const skin = await window.electronAPI?.fetchSkin({ username:acc.username, type:acc.type });
    if (!skin) { frSkipAvatar(); return; }
    const head = await frBuildHeadFromSkin(skin);
    frSaveAvatar(head);
  } catch {}
  _friendsView = 'main';
  await socialLoadFriendList(); socialConnect(); loadFriends();
};

window.frUploadAvatarSetup = function() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      frSaveAvatar(e.target.result);
      _friendsView = 'main';
      await socialLoadFriendList(); socialConnect(); loadFriends();
    };
    reader.readAsDataURL(file);
  };
  input.click();
};

window.frSkipAvatar = async function() {
  _friendsView = 'main';
  await socialLoadFriendList(); socialConnect(); loadFriends();
};

// ── Styled 2FA / confirm modal ────────────────────────────────────────────────
function frConfirmModal({ icon, title, subtitle, confirmLabel, confirmClass, requirePassword, onConfirm }) {
  // Remove existing
  document.getElementById('frConfirmModalOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'frConfirmModalOverlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:200000;
    background:rgba(0,0,0,.7);backdrop-filter:blur(6px);
    display:flex;align-items:center;justify-content:center;
    animation:frOverlayIn .18s ease;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background:#13131a;border:1px solid #2a2a3a;border-radius:20px;
    padding:32px 36px;width:360px;display:flex;flex-direction:column;gap:18px;
    box-shadow:0 24px 80px rgba(0,0,0,.8);
    animation:frBoxIn .22s cubic-bezier(.34,1.56,.64,1);
  `;

  const iconEl = document.createElement('div');
  iconEl.style.cssText = `font-size:36px;text-align:center;`;
  iconEl.textContent = icon || '';
  if (!icon) iconEl.style.display = 'none';

  const titleEl = document.createElement('div');
  titleEl.style.cssText = `text-align:center;`;
  titleEl.innerHTML = `
    <div style="font-size:17px;font-weight:800;color:#e8e8f0;margin-bottom:6px;">${title}</div>
    <div style="font-size:12px;color:#666680;line-height:1.5;">${subtitle || ''}</div>
  `;

  let passInput = null;
  if (requirePassword) {
    passInput = document.createElement('input');
    passInput.type = 'password';
    passInput.placeholder = t('soc_confirm_pass');
    passInput.className = 'fr-input';
    passInput.style.cssText = `text-align:center;font-size:14px;letter-spacing:2px;`;
    passInput.autocomplete = 'current-password';
  }

  const errEl = document.createElement('div');
  errEl.style.cssText = `font-size:12px;color:#cc4444;text-align:center;min-height:16px;`;

  const btnRow = document.createElement('div');
  btnRow.style.cssText = `display:flex;gap:10px;`;

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = t('soc_cancel');
  cancelBtn.className = 'fr-submit';
  cancelBtn.style.cssText = `background:var(--bg3);border:1px solid var(--border2);color:var(--text2);flex:1;`;

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = confirmLabel || t('soc_confirm');
  confirmBtn.className = 'fr-submit';
  if (confirmClass === 'danger') {
    confirmBtn.style.cssText = `flex:1;background:#cc2222;color:#fff;border:none;`;
  } else {
    confirmBtn.style.cssText = `flex:1;`;
  }

  cancelBtn.onclick = () => overlay.remove();
  confirmBtn.onclick = async () => {
    const pass = passInput ? passInput.value : null;
    if (requirePassword && !pass) { errEl.textContent = t('soc_enter_pass2'); return; }
    confirmBtn.disabled = true; cancelBtn.disabled = true;
    confirmBtn.textContent = '...';
    try {
      await onConfirm(pass);
      overlay.remove();
    } catch(e) {
      errEl.textContent = e.message || t('err_short');
      confirmBtn.disabled = false; cancelBtn.disabled = false;
      confirmBtn.textContent = confirmLabel || t('soc_confirm');
    }
  };

  if (passInput) {
    passInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmBtn.click(); });
  }

  btnRow.append(cancelBtn, confirmBtn);
  box.append(iconEl, titleEl);
  if (passInput) box.append(passInput);
  box.append(errEl, btnRow);
  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  if (passInput) setTimeout(() => passInput.focus(), 50);

  // Add keyframes once
  if (!document.getElementById('frConfirmModalStyles')) {
    const s = document.createElement('style');
    s.id = 'frConfirmModalStyles';
    s.textContent = `
      @keyframes frOverlayIn { from { opacity:0; } to { opacity:1; } }
      @keyframes frBoxIn { from { opacity:0;transform:scale(.88) translateY(16px); } to { opacity:1;transform:none; } }
    `;
    document.head.appendChild(s);
  }
}

function frInputModal({ title, subtitle, placeholder, confirmLabel, confirmClass, validate, onConfirm }) {
  document.getElementById('frConfirmModalOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'frConfirmModalOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99999;display:flex;align-items:center;justify-content:center;animation:frOverlayIn .15s ease;';
  overlay.innerHTML = `
    <div style="background:#1a1a2e;border:1px solid #6644aa55;border-radius:14px;padding:22px 24px;min-width:320px;max-width:420px;animation:frBoxIn .18s ease;">
      <div style="font-size:15px;font-weight:800;color:#e8e8f0;margin-bottom:6px;">${title}</div>
      ${subtitle ? `<div style="font-size:12px;color:#8888aa;margin-bottom:14px;">${subtitle}</div>` : ''}
      <input id="frInputModalField" class="fr-input" placeholder="${placeholder||''}" style="width:100%;margin-bottom:6px;box-sizing:border-box;">
      <div id="frInputModalErr" style="font-size:11px;color:#cc4444;min-height:16px;margin-bottom:8px;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="frInputModalCancel" style="padding:8px 18px;border:1px solid var(--border2);background:none;color:var(--text3);border-radius:8px;cursor:pointer;font-size:13px;">Отмена</button>
        <button id="frInputModalConfirm" style="padding:8px 18px;border:none;background:${confirmClass==='danger'?'#cc3333':'linear-gradient(135deg,#6644aa,#4422ee)'};color:#fff;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;">${confirmLabel||t('soc_confirm')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const inp = document.getElementById('frInputModalField');
  const err = document.getElementById('frInputModalErr');
  setTimeout(() => inp.focus(), 50);
  document.getElementById('frInputModalCancel').onclick = () => overlay.remove();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.getElementById('frInputModalConfirm').onclick = async () => {
    const val = inp.value.trim();
    if (validate) { const msg = validate(val); if (msg) { err.textContent = msg; return; } }
    overlay.remove();
    await onConfirm(val);
  };
  inp.onkeydown = e => { if (e.key === 'Enter') document.getElementById('frInputModalConfirm')?.click(); };
}

window.frLogout = function() {
  frConfirmModal({
    icon: null,
    title: t('soc_logout_title'),
    subtitle: t('soc_logout_desc'),
    confirmLabel: t('soc_logout'),
    requirePassword: false,
    onConfirm: async () => {
      if (_socialWS) { try { _socialWS.close(); } catch {} _socialWS = null; }
      socialClearSession();
      frClearAvatar();
      _socialFriends = []; _socialPending = []; _socialOnline.clear();
      _friendsView = 'login';
      loadFriends();
    }
  });
};

window.frDeleteAccount = function() {
  // Проверяем зарегистрирован ли юзер через OAuth (без пароля)
  const isOAuthOnly = _socialUser && (!_socialUser._hasPassword);
  frConfirmModal({
    icon: null,
    title: t('soc_delete_title'),
    subtitle: isOAuthOnly
      ? t('soc_delete_full')
      : t('soc_delete_full'),
    confirmLabel: t('soc_delete_confirm'),
    confirmClass: 'danger',
    requirePassword: !isOAuthOnly,
    onConfirm: async (password) => {
      // OAuth-юзеры удаляются без пароля — передаём пустую строку
      const res = await socialAPI('socialDeleteAccount', { token: _socialToken, password: password || '__oauth_delete__' });
      if (!res || !res.ok) throw new Error(res?.error || t('soc_delete_err'));
      if (_socialWS) { try { _socialWS.close(); } catch {} _socialWS = null; }
      socialClearSession();
      frClearAvatar();
      _socialFriends = []; _socialPending = []; _socialOnline.clear();
      _friendsView = 'login';
      loadFriends();
    }
  });
};

// ── Wizard step helper ────────────────────────────────────────────
function frWizardStep(step, total, label) {
  return `<div class="fr-wizard-steps">
    ${Array.from({length:total},(_,i)=>`<div class="fr-wizard-dot ${i<step?'done':i===step?'active':''}"></div>`).join('')}
    <span class="fr-wizard-label">${label}</span>
  </div>`;
}

// ── Main render ───────────────────────────────────────────────────
async function loadFriends() {
  const mySeq = _tabSeq;
  const content = document.getElementById('content');

  if (_friendsView === 'login' && socialLoadSession()) {
    try {
      const me = await socialAPI('socialMe', { token:_socialToken });
      if (_tabSeq !== mySeq) return;
      _socialUser = me; _friendsView = 'main'; await socialLoadFriendList(); socialConnect();
    } catch { socialClearSession(); _friendsView = 'login'; }
  }
  if (_tabSeq !== mySeq) return;

  // ── Login / Register view ──────────────────────────────────────
  if (_friendsView === 'login') {
    content.style.overflow = 'auto'; content.style.padding = '0'; content.style.margin = '0'; content.style.maxHeight = 'none'; content.style.height = 'calc(100vh - 98px)'; content.style.opacity = '1'; content.style.pointerEvents = ''; content.style.userSelect = '';
    const acc = typeof acCurrentAccount !== 'undefined' ? acCurrentAccount : null;
    const allAccs = typeof acAllAccounts !== 'undefined' ? acAllAccounts : [];
    const hasMs    = allAccs.some(a => a.type === 'microsoft') || (acc && acc.type === 'microsoft');
    const hasElyby = allAccs.some(a => a.type === 'elyby') || (acc && acc.type === 'elyby');
    // OAuth buttons are always shown; if no linked MC account, they show an error
    const oauthLoginMs    = hasMs    ? "frLoginOAuth('microsoft')"    : "frOAuthNoAccount('login','Microsoft')";
    const oauthLoginElyby = hasElyby ? "frLoginOAuth('elyby')"        : "frOAuthNoAccount('login','Ely.by')";
    const oauthRegMs      = hasMs    ? "frRegisterOAuth('microsoft')" : "frOAuthNoAccount('register','Microsoft')";
    const oauthRegElyby   = hasElyby ? "frRegisterOAuth('elyby')"     : "frOAuthNoAccount('register','Ely.by')";
    const oauthBtnStyle   = (type) => hasMs && type==='ms' || hasElyby && type==='ely'
      ? 'background:var(--bg3);border:1px solid var(--border2);color:var(--text2);'
      : 'background:var(--bg3);border:1px solid var(--border2);color:#556;opacity:.65;';
    content.innerHTML = `
      <div class="fr-auth-wrap" style="min-height:100%;box-sizing:border-box;">
        <div class="fr-auth-box">
          <div class="fr-auth-logo">MidLauncher <span style="color:var(--accent)">Social</span></div>
          <div class="fr-auth-tabs">
            <button class="fr-auth-tab active" onclick="frAuthTab('login',this)">${t('soc_login')}</button>
            <button class="fr-auth-tab" onclick="frAuthTab('register',this)">${t('soc_reg_short')}</button>
          </div>
          <div id="frAuthLogin">
            <input id="frLoginUsername" class="fr-input" type="text" placeholder="${t('soc_nick_ph')}" autocomplete="username">
            <input id="frLoginPass" class="fr-input" type="password" placeholder="${t('soc_pass_ph')}" autocomplete="current-password"
              onkeydown="if(event.key==='Enter')frLogin()">
            <div class="fr-err" id="frLoginErr"></div>
            <button id="frLoginBtn" class="fr-submit" onclick="frLogin()">${t('soc_login')}</button>
            <div class="fr-oauth-divider"><span>${t('or_label')}</span></div>
            <button class="fr-submit" style="${oauthBtnStyle('ms')}" onclick="${oauthLoginMs}">${t('soc_login_ms')}</button>
            <button class="fr-submit" style="${oauthBtnStyle('ely')}" onclick="${oauthLoginElyby}">${t('soc_login_ely')}</button>
          </div>
          <div id="frAuthRegister" style="display:none">
            <input id="frRegUsername" class="fr-input" type="text" placeholder="${t('soc_nick_ph2')}" autocomplete="username" maxlength="64">
            <input id="frRegDisplayName" class="fr-input" type="text" placeholder="${t('soc_dname_ph')}" maxlength="32" style="margin-top:6px;">
            <input id="frRegPass"  class="fr-input" type="password" placeholder="${t('soc_pass_ph2')}" autocomplete="new-password">
            <input id="frRegPass2" class="fr-input" type="password" placeholder="${t('soc_repeat_pass')}" autocomplete="new-password"
              onkeydown="if(event.key==='Enter')frRegister()">
            <div class="fr-err" id="frRegErr"></div>
            <button id="frRegBtn" class="fr-submit" onclick="frRegister()">${t('soc_register')}</button>
            <div class="fr-oauth-divider"><span>${t('soc_reg_via')}</span></div>
            <button class="fr-submit" style="${oauthBtnStyle('ms')}" onclick="${oauthRegMs}">${t('soc_reg_via')} Microsoft</button>
            <button class="fr-submit" style="${oauthBtnStyle('ely')}" onclick="${oauthRegElyby}">${t('soc_reg_via')} Ely.by</button>
          </div>
        </div>
      </div>`;
    window.frOAuthNoAccount = function(action, service) {
  const errId = action === 'login' ? 'frLoginErr' : 'frRegErr';
  const el = document.getElementById(errId);
  if (el) {
    el.style.color = '#cc8822';
    el.textContent = t('soc_no_acc_service').replace('{service}', service);
    setTimeout(() => { if (el) el.textContent = ''; }, 5000);
  }
};

window.frAuthTab = function(tab, el) {
      document.querySelectorAll('.fr-auth-tab').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('frAuthLogin').style.display    = tab==='login'    ? '' : 'none';
      document.getElementById('frAuthRegister').style.display = tab==='register' ? '' : 'none';
    };
    return;
  }

  // ── Setup avatar view ─────────────────────────────────────────
  if (_friendsView === 'setup_avatar') {
    content.style.overflow = 'auto'; content.style.padding = '0'; content.style.margin = '0'; content.style.maxHeight = 'none'; content.style.height = 'calc(100vh - 98px)'; content.style.opacity = '1';
    const acc_av = typeof acCurrentAccount !== 'undefined' ? acCurrentAccount : null;
    const hasMC = acc_av && acc_av.type !== 'local';
    content.innerHTML = `
      <div class="fr-auth-wrap" style="min-height:100%;box-sizing:border-box;">
        <div class="fr-auth-box" style="gap:14px;">
          <div class="fr-auth-logo">Выбери аватарку</div>
          <div class="fr-avatar-preview" id="frAvatarPreview">
            ${(_socialUser?.displayName||_socialUser?.username||'?')[0].toUpperCase()}
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${hasMC ? `<button class="fr-submit" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);" onclick="frSetupAvatarPreviewMC()">${t('soc_use_skin')}</button>` : ''}
            <button class="fr-submit" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);" onclick="frUploadAvatarSetup()">Загрузить фото</button>
            <button class="fr-submit" onclick="frConfirmAvatarSetup()">Готово →</button>
            <button onclick="frSkipAvatar()" style="background:none;border:none;color:var(--text4);font-size:12px;cursor:pointer;text-decoration:underline;padding:4px;">Пропустить</button>
          </div>
        </div>
      </div>`;
    return;
  }

  // ── Main view ─────────────────────────────────────────────────
  content.style.overflow = 'hidden';
  content.style.padding  = '0';
  content.style.margin   = '0';
  content.style.maxHeight = '100%';
  content.style.height   = 'calc(100vh - 98px)';

  const _av      = frGetAvatar();
  const _initial = (_socialUser?.displayName || _socialUser?.username || '?')[0].toUpperCase();
  const _shortId = _socialUser?.id ? _socialUser.id.replace(/-/g,'').slice(0, 12) : '';

  content.innerHTML = `
    <div class="fr-root" id="frMain">
      <div class="fr-sidebar">
        <div class="fr-me">
          <div class="fr-me-avatar" id="frMeAvatar" onclick="frClickAvatar()" title="${t('soc_change_avatar')}" style="cursor:pointer;position:relative;">
            ${_av ? `<img src="${_av}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : _initial}
          </div>
          <div class="fr-me-info">
            <div class="fr-me-name" style="display:flex;align-items:center;gap:5px;">
              ${_socialUser?.displayName || _socialUser?.username || '—'}
              ${_socialUser?.username?.toLowerCase() === 'dev' ? '<span style="font-size:9px;background:linear-gradient(135deg,#6644aa,#4422ee);color:#fff;padding:1px 6px;border-radius:10px;font-weight:700;letter-spacing:.3px;">DEV</span>' : ''}
            </div>
            <div class="fr-me-tag">@${_socialUser?.username || '—'}</div>
            <div class="fr-me-id" title="${t('soc_your_id')}" onclick="navigator.clipboard?.writeText('${_shortId}');this.textContent=t('soc_id_copied');setTimeout(()=>this.textContent='ID: ${_shortId}',1500);" style="cursor:pointer;">ID: ${_shortId}</div>
          </div>
          <button class="fr-logout-btn" onclick="frLogout()" title="${t('soc_logout')}">⇥</button>
        </div>

        <div class="fr-tabs">
          <div id="frFriendsTabActive" data-tab="friends" style="display:none"></div>
          <button class="fr-tab-btn active" data-tab="friends" onclick="frSwitchTab('friends')">Друзья</button>
          <button class="fr-tab-btn" data-tab="pending" id="frPendingTab" onclick="frSwitchTab('pending')">${t('soc_pending')}</button>
          <button class="fr-tab-btn" data-tab="account" onclick="frSwitchTab('account')">Аккаунт</button>
        </div>

        <div class="fr-friends-list" id="frFriendsList"></div>

        <div class="fr-add-section">
          <div style="font-size:11px;color:var(--text3);margin-bottom:6px;">Добавить друга</div>
          <div style="display:flex;gap:6px;">
            <input id="frAddInput" class="fr-input fr-add-input" placeholder="@username или ID" autocomplete="off"
              onkeydown="if(event.key==='Enter')frAddFriend()">
            <button class="fr-add-btn" onclick="frAddFriend()">+</button>
          </div>
          <div class="fr-err" id="frAddError" style="margin-top:6px;"></div>
        </div>
      </div>

      <div class="fr-chat-panel" id="frChat" style="display:none;flex-direction:column;">
        <div class="fr-chat-header">
          <button class="fr-back-btn" onclick="frCloseChat()">←</button>
          <div class="fr-chat-avatar" id="frChatAvatar">?</div>
          <div>
            <div id="frChatName"    style="font-weight:700;color:var(--text);font-size:14px;"></div>
            <div id="frChatSubname" style="font-size:11px;color:var(--text3);"></div>
          </div>
        </div>
        <div class="fr-chat-messages" id="frChatMessages"></div>
        <div class="fr-chat-input-row">
          <input id="frChatInput" class="fr-input" placeholder="${t('soc_msg_placeholder')}" style="flex:1;"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){frSendMessage();event.preventDefault();}">
          <button class="fr-send-btn" onclick="frSendMessage()">↑</button>
        </div>
      </div>
    </div>`;

  socialRefreshFriendsList();
  frAutoSetMCAvatar();
}

window.frSetupAvatarPreviewMC = async function() {
  try {
    const acc = typeof acCurrentAccount !== 'undefined' ? acCurrentAccount : null;
    if (!acc) return;
    const skin = await window.electronAPI?.fetchSkin({ username:acc.username, type:acc.type });
    if (!skin) return;
    const head = await frBuildHeadFromSkin(skin);
    const prev = document.getElementById('frAvatarPreview');
    if (prev) prev.innerHTML = `<img src="${head}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
    prev._pendingAvatar = head;
  } catch {}
};

window.frConfirmAvatarSetup = async function() {
  const prev = document.getElementById('frAvatarPreview');
  if (prev?._pendingAvatar) frSaveAvatar(prev._pendingAvatar);
  await frSkipAvatar();
};

function loadTab(tab) {
  const c = document.getElementById('content');
  if (c) {
    // Always restore opacity (set during boot init)
    c.style.opacity  = '1';
    if (tab !== 'friends') {
      // Reset only properties we set in friends view
      c.style.overflow  = '';
      c.style.padding   = '';
      c.style.margin    = '';
      c.style.maxHeight = '';
      c.style.height    = '';
    }
  }
  ({ launcher:loadLauncher, mods:loadMods, files:loadFiles, settings:loadSettings, friends:loadFriends }[tab] || loadLauncher)();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════
let settingsTab = 'minecraft';
let settingsDraft = {};

const SETTINGS_DEFAULTS = {
  gameDir: '',
  javaType: 'recommended',
  javaPath: '',
  javaArgs: '',
  javaOptArgs: 'default',
  minecraftArgs: '',
  javaWrapCmd: '',
  memoryMb: 4096,
  memoryAuto: false,
  windowWidth: 925,
  windowHeight: 530,
  showConsole: false,
  hideOnLaunch: 'hide',
  language: 'ru',
  backgroundType: 'plain',
  theme: 'dark',
};

const LANGUAGES = [
  ['ru','Русский'],['en','English'],['de','Deutsch'],['fr','Français'],
  ['es','Español'],['it','Italiano'],['pt','Português'],['pl','Polski'],
  ['uk','Українська'],['tr','Türkçe'],['zh','中文'],['ja','日本語'],['ko','한국어'],
  ['nl','Nederlands'],['cs','Čeština'],['sv','Svenska'],['fi','Suomi'],
  ['hu','Magyar'],['ro','Română'],['sk','Slovenčina'],
];

const GC_OPTIONS = () => [
  ['default',     t('gc_default')],
  ['off',         t('gc_off')],
  ['cms',         t('gc_cms')],
  ['g1gc',        t('gc_g1gc')],
  ['shenandoah',  t('gc_shenandoah')],
  ['zgc',         t('gc_zgc')],
];

function loadSettings() {
  const s = Object.assign({}, SETTINGS_DEFAULTS, config.settings || {});
  settingsDraft = JSON.parse(JSON.stringify(s));
  renderSettingsPage();
}

function renderSettingsPage() {
  const content = document.getElementById('content');
  content.innerHTML = `
<div style="display:flex;flex-direction:column;min-height:calc(100vh - 140px);box-sizing:border-box;">
  <div class="settings-tabs">
    <div class="settings-tab${settingsTab==='minecraft'?' active':''}" onclick="switchSettingsTab('minecraft')">${t('settings_tab_mc')}</div>
    <div class="settings-tab${settingsTab==='launcher'?' active':''}" onclick="switchSettingsTab('launcher')">${t('settings_tab_launcher')}</div>
  </div>
  <div id="settingsBody" style="flex:1;"></div>
  <div class="settings-footer" style="padding-top:16px;padding-bottom:4px;margin-top:auto;">
    <button class="settings-save-btn main" onclick="saveSettings()">${t('settings_save')}</button>
    <button class="settings-save-btn default" onclick="resetSettings()">${t('settings_reset')}</button>
  </div>
</div>`;
  renderSettingsTab();
}

function switchSettingsTab(tab) {
  settingsTab = tab;
  document.querySelectorAll('.settings-tab').forEach(el => el.classList.toggle('active', el.textContent === (tab==='minecraft'?t('settings_tab_mc'):t('settings_tab_launcher'))));
  renderSettingsTab();
}

function renderSettingsTab() {
  const body = document.getElementById('settingsBody');
  if (!body) return;
  body.innerHTML = settingsTab === 'minecraft' ? buildMinecraftTab() : buildLauncherTab();
  bindSettingsEvents();
}

function buildMinecraftTab() {
  const s = settingsDraft;
  const ramPct = ((s.memoryMb - 1024) / (32768 - 1024) * 100).toFixed(1);

  // RAM ticks
  let ticks = '';
  for (let i = 1; i <= 32; i++) {
    const label = (i % 8 === 0 || i === 1) ? (i+t('size_gb')) : '';
    ticks += `<div class="ram-tick"><div class="ram-tick-line"></div><div class="ram-tick-label">${label}</div></div>`;
  }

  // Java dropdown
  const javaLabels = { recommended:t('java_recommended'), current:t('java_current'), custom:t('java_custom') };

  return `
<div class="settings-section">

  <div class="settings-row">
    <div class="settings-label">${t('settings_gamedir')}<small>${t('settings_gamedir_hint')}</small></div>
    <div class="settings-control" style="flex-direction:column;align-items:stretch;gap:5px">
      <div style="display:flex;gap:8px;align-items:center">
        <input class="settings-input wide" id="set-gameDir" value="${s.gameDir || ''}" placeholder="${t('settings_gamedir_ph')}" oninput="onGameDirInput(this)">
        <button class="settings-btn" onclick="pickGameDir()">${t('settings_browse')}</button>
        ${s.gameDir ? '<button class="settings-btn" onclick="clearGameDir()">✕</button>' : ''}
      </div>
      <div id="gameDirError" style="display:none;font-size:11.5px;color:#cc4444;padding:4px 8px;background:#1a0808;border:1px solid #3a1a1a;border-radius:6px;"></div>
    </div>
  </div>

  <div class="settings-row">
    <div class="settings-label">${t('settings_java')}</div>
    <div class="settings-control">
      <div class="dd-wrap" style="flex:1">
        <div class="dd-trigger" id="javaTypeTrigger" onclick="toggleJavaDD(event)">${javaLabels[s.javaType]||t('java_recommended')}</div>
        <div class="dd-list" id="javaTypeList">
          <div class="dd-scroll">
            ${Object.entries(javaLabels).map(([k,v])=>`<div class="dd-item${s.javaType===k?' selected':''}" onclick="setJavaType('${k}')">${v}</div>`).join('')}
          </div>
        </div>
      </div>
      <button class="settings-btn" onclick="openJavaDetail()">${t('java_details')}</button>
    </div>
  </div>

  <div class="settings-row col">
    <div class="settings-label" style="min-width:unset">${t('settings_ram')}</div>
    <div class="ram-wrap">
      <div class="ram-row">
        <div class="ram-slider-wrap" style="flex:1">
          <input type="range" class="ram-slider" id="ramSlider"
            min="1024" max="32768" step="1024"
            value="${s.memoryAuto ? Math.round(window.navigator?.deviceMemory*1024/2)||4096 : s.memoryMb}"
            style="--pct:${ramPct}%"
            ${s.memoryAuto ? 'disabled' : ''}
            oninput="onRamSlider(this)">
          <div class="ram-ticks">${ticks}</div>
        </div>
        <input class="settings-input ram-mb-input" id="ramMbInput" type="number"
          value="${s.memoryMb}" min="512" max="32768" step="512"
          ${s.memoryAuto ? 'disabled' : ''}
          oninput="onRamMb(this)"> <span style="font-size:12px;color:#555">${t('size_mb_label')}</span>
        <label class="ram-auto-row">
          <input type="checkbox" id="ramAutoCheck" ${s.memoryAuto?'checked':''} onchange="onRamAuto(this)"> ${t('settings_ram_auto')}
        </label>
      </div>
      <div class="ram-warning${s.memoryMb >= 24576 && !s.memoryAuto ? ' show' : ''}" id="ramWarning">
        ⚠ Выделение 24+ ГБ может вызвать проблемы с производительностью
      </div>
    </div>
  </div>

</div>`;
}

function buildLauncherTab() {
  const s = settingsDraft;
  const hideOpts = [['hide',t('hide_hide')],['close',t('hide_close')],['keep',t('hide_keep')]];
  const langOpts = LANGUAGES.map(([k,v]) => `<option value="${k}"${s.language===k?' selected':''}>${v}</option>`).join('');

  return `
<div class="settings-section">

  <div class="settings-row">
    <div class="settings-label">${t('settings_winsize')}</div>
    <div class="settings-control" style="gap:8px">
      <input class="settings-input" id="set-winW" type="number" value="${s.windowWidth||925}" style="width:90px" oninput="settingsDraft.windowWidth=+this.value">
      <span style="color:#444;font-size:14px">×</span>
      <input class="settings-input" id="set-winH" type="number" value="${s.windowHeight||530}" style="width:90px" oninput="settingsDraft.windowHeight=+this.value">
      <span style="font-size:12px;color:#555">${t('settings_winsize_px')}</span>
    </div>
  </div>

  <div class="settings-row">
    <div class="settings-label">${t('settings_console')}<small>${t('settings_console_hint')}</small></div>
    <div class="settings-control">
      <label class="settings-toggle">
        <input type="checkbox" id="set-showConsole" ${s.showConsole?'checked':''} onchange="settingsDraft.showConsole=this.checked">
        <span>${t('settings_console_label')}</span>
      </label>
    </div>
  </div>

  <div class="settings-row">
    <div class="settings-label">${t('settings_onlaunch')}</div>
    <div class="settings-control">
      <div class="dd-wrap" style="flex:1;max-width:300px">
        <div class="dd-trigger" id="hideLaunchTrigger" onclick="toggleHideDD(event)">
          ${hideOpts.find(o=>o[0]===s.hideOnLaunch)?.[1] || hideOpts[0][1]}
        </div>
        <div class="dd-list" id="hideLaunchList">
          <div class="dd-scroll">
            ${hideOpts.map(([k,v])=>`<div class="dd-item${s.hideOnLaunch===k?' selected':''}" onclick="setHideOnLaunch('${k}','${v}')">${v}</div>`).join('')}
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="settings-row">
    <div class="settings-label">${t('settings_lang')}</div>
    <div class="settings-control">
      <div class="dd-wrap" style="flex:1;max-width:240px">
        <div class="dd-trigger" id="langTrigger" onclick="toggleLangDD(event)">
          ${LANGUAGES.find(l=>l[0]===s.language)?.[1] || LANGUAGES[0][1]}
        </div>
        <div class="dd-list" id="langList" style="max-height:220px">
          <div class="dd-scroll" style="max-height:210px">
            ${LANGUAGES.map(([k,v])=>`<div class="dd-item${s.language===k?' selected':''}" data-val="${k}" onclick="setLang('${k}','${v}')">${v}</div>`).join('')}
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="settings-row">
    <div class="settings-label">${t('bg_label')}</div>
    <div class="settings-control">
      <div class="dd-wrap" style="flex:1;max-width:240px">
        <div class="dd-trigger" id="bgTypeTrigger" onclick="toggleBgTypeDD(event)">
          ${s.backgroundType === 'animated' ? t('bg_animated') : t('bg_static')}
        </div>
        <div class="dd-list" id="bgTypeList">
          <div class="dd-scroll">
            <div class="dd-item${s.backgroundType!=='animated'?' selected':''}" data-val="plain" onclick="setBgType('plain',t('bg_static'))">${t('bg_static')}</div>
            <div class="dd-item${s.backgroundType==='animated'?' selected':''}" data-val="animated" onclick="setBgType('animated',t('bg_animated'))">${t('bg_animated')}</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="settings-row">
    <div class="settings-label">${t('theme_label')}</div>
    <div class="settings-control">
      <div class="dd-wrap" style="flex:1;max-width:240px">
        <div class="dd-trigger" id="themeTrigger" onclick="toggleThemeDD(event)">
          ${s.theme === 'light' ? t('theme_light') : t('theme_dark')}
        </div>
        <div class="dd-list" id="themeList">
          <div class="dd-scroll">
            <div class="dd-item${s.theme!=='light'?' selected':''}" data-val="dark"  onclick="setTheme('dark',t('theme_dark'))">${t('theme_dark')}</div>
            <div class="dd-item${s.theme==='light'?' selected':''}" data-val="light" onclick="setTheme('light',t('theme_light'))">${t('theme_light')}</div>
          </div>
        </div>
      </div>
    </div>
  </div>

</div>`;
}

function bindSettingsEvents() {
  // Close dropdowns on outside click - handled globally
}

// ─── Settings dropdown helper ────────────────────────
function toggleSettingsDD(event, listId, triggerId) {
  event.stopPropagation();
  const list    = document.getElementById(listId);
  const trigger = document.getElementById(triggerId);
  const isOpen  = list.classList.contains('open');
  // Close all other dropdowns first
  document.querySelectorAll('.dd-list.open').forEach(l => { if (l.id !== listId) l.classList.remove('open'); });
  document.querySelectorAll('.dd-trigger.open').forEach(el => { if (el.id !== triggerId) el.classList.remove('open'); });
  list.classList.toggle('open', !isOpen);
  if (trigger) trigger.classList.toggle('open', !isOpen);
}

// ─── Java type ───────────────────────────────────────
window.toggleJavaDD = function(e) { toggleSettingsDD(e, 'javaTypeList', 'javaTypeTrigger'); }
window.setJavaType = function(type) {
  settingsDraft.javaType = type;
  const trigger = document.getElementById('javaTypeTrigger');
  if (trigger) { trigger.textContent = {recommended:t('java_recommended'),current:t('java_current'),custom:t('java_custom')}[type]||t('java_recommended'); trigger.classList.remove('open'); }
  const list = document.getElementById('javaTypeList');
  if (list) list.classList.remove('open');
  document.querySelectorAll('#javaTypeList .dd-item').forEach(i => i.classList.toggle('selected', i.textContent === labels[type]));
}

// ─── Hide on launch ──────────────────────────────────
window.toggleHideDD = function(e) { toggleSettingsDD(e, 'hideLaunchList', 'hideLaunchTrigger'); }
window.setHideOnLaunch = function(val, label) {
  settingsDraft.hideOnLaunch = val;
  const trigger = document.getElementById('hideLaunchTrigger');
  if (trigger) { trigger.textContent = label; trigger.classList.remove('open'); }
  const list = document.getElementById('hideLaunchList');
  if (list) list.classList.remove('open');
  document.querySelectorAll('#hideLaunchList .dd-item').forEach(i => i.classList.toggle('selected', i.dataset.val === val));
}

// ─── Language ────────────────────────────────────────
window.toggleLangDD = function(e) { toggleSettingsDD(e, 'langList', 'langTrigger'); }
window.setLang = function(val, label) {
  settingsDraft.language = val;
  const trigger = document.getElementById('langTrigger');
  if (trigger) { trigger.textContent = label; trigger.classList.remove('open'); }
  const list = document.getElementById('langList');
  if (list) list.classList.remove('open');
  document.querySelectorAll('#langList .dd-item').forEach(i => i.classList.toggle('selected', i.dataset.val === val));
  // NOTE: language is only applied when user clicks "Save"
}

// ─── Background type ─────────────────────────────────
window.toggleBgTypeDD = function(e) { toggleSettingsDD(e, 'bgTypeList', 'bgTypeTrigger'); };
window.setBgType = function(val, label) {
  settingsDraft.backgroundType = val;
  const trigger = document.getElementById('bgTypeTrigger');
  if (trigger) { trigger.textContent = label; trigger.classList.remove('open'); }
  const list = document.getElementById('bgTypeList');
  if (list) list.classList.remove('open');
  document.querySelectorAll('#bgTypeList .dd-item').forEach(i => i.classList.toggle('selected', i.dataset.val === val));
};

// ─── Theme ───────────────────────────────────────────
function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
}
window.toggleThemeDD = function(e) { toggleSettingsDD(e, 'themeList', 'themeTrigger'); };
window.setTheme = function(val, label) {
  settingsDraft.theme = val;
  const trigger = document.getElementById('themeTrigger');
  if (trigger) { trigger.textContent = label; trigger.classList.remove('open'); }
  const list = document.getElementById('themeList');
  if (list) list.classList.remove('open');
  document.querySelectorAll('#themeList .dd-item').forEach(i => i.classList.toggle('selected', i.dataset.val === val));
  // Тема применяется только при сохранении настроек
};

// ─── Game dir ────────────────────────────────────────
window.onGameDirInput = function(el) {
  const val = el.value.trim();
  settingsDraft.gameDir = val;
  const errEl = document.getElementById('gameDirError');
  if (!errEl) return;
  if (!val) { errEl.style.display = 'none'; return; }
  // Validate via fs-list (check if it's a folder)
  window.electronAPI?.fsList(val).then(result => {
    if (result && result.error) {
      const reason = result.error.includes('ENOENT') ? t('dir_not_found') :
                     result.error.includes('ENOTDIR') ? t('dir_not_dir') :
                     result.error.includes('EACCES') ? t('dir_no_access') :
                     result.error;
      errEl.textContent = '✗ ' + reason;
      errEl.style.display = '';
      el.style.borderColor = '#cc4444';
    } else {
      errEl.style.display = 'none';
      el.style.borderColor = '#1bd96a55';
    }
  }).catch(() => {
    errEl.textContent = '✗ ' + t('dir_check_fail');
    errEl.style.display = '';
    el.style.borderColor = '#cc4444';
  });
}
window.pickGameDir = async function() {
  const p = await window.electronAPI?.selectFolder();
  if (p) {
    settingsDraft.gameDir = p;
    renderSettingsTab();
  }
}
window.clearGameDir = function() {
  settingsDraft.gameDir = '';
  renderSettingsTab();
}

// ─── RAM ─────────────────────────────────────────────
window.onRamSlider = function(el) {
  const mb = +el.value;
  settingsDraft.memoryMb = mb;
  const pct = ((mb - 1024) / (32768 - 1024) * 100).toFixed(1);
  el.style.setProperty('--pct', pct + '%');
  const inp = document.getElementById('ramMbInput');
  if (inp) inp.value = mb;
  const warn = document.getElementById('ramWarning');
  if (warn) warn.classList.toggle('show', mb >= 24576);
}
window.onRamMb = function(el) {
  let mb = Math.max(512, Math.min(32768, +el.value || 512));
  mb = Math.round(mb / 512) * 512;
  settingsDraft.memoryMb = mb;
  const slider = document.getElementById('ramSlider');
  if (slider) {
    slider.value = mb;
    const pct = ((mb - 1024) / (32768 - 1024) * 100).toFixed(1);
    slider.style.setProperty('--pct', pct + '%');
  }
  const warn = document.getElementById('ramWarning');
  if (warn) warn.classList.toggle('show', mb >= 24576);
}
window.onRamAuto = function(el) {
  settingsDraft.memoryAuto = el.checked;
  renderSettingsTab();
}

// ─── Java detail modal ───────────────────────────────
window.openJavaDetail = function() {
  const s = settingsDraft;
  const modal = document.getElementById('javaDetailModal');
  if (!modal) return;
  const types = [
    { k:'recommended', name:t('java_recommended'), desc:t('java_rec_desc') },
    { k:'current',     name:t('java_current'),     desc:t('java_cur_desc'), warn:t('java_cur_warn') },
    { k:'custom',      name:t('java_custom'),       desc:t('java_cust_desc') },
  ];
  modal.querySelector('#jdTypeGrid').innerHTML = types.map(tp => `
    <div class="java-type-btn${s.javaType===tp.k?' active':''}" onclick="setJdType('${tp.k}')">
      <div class="jt-name">${tp.name}</div>
      <div class="jt-desc">${tp.desc}</div>
      ${tp.warn?`<div class="jt-warn">${tp.warn}</div>`:''}
    </div>`).join('');
  updateJdCustomSection();
  modal.classList.add('open');
  updateJdLabels();
}
function updateJdLabels() {
  const el = id => document.getElementById(id);
  if(el('jd-label-path')) el('jd-label-path').textContent = t('java_path_label');
  if(el('jd-label-jargs')) el('jd-label-jargs').textContent = t('java_args_label');
  if(el('jd-label-optargs')) el('jd-label-optargs').textContent = t('java_opt_args_label');
  if(el('jd-label-mcargs')) el('jd-label-mcargs').textContent = t('java_mc_args_label');
  if(el('jd-label-wrap')) el('jd-label-wrap').textContent = t('java_wrap_cmd_label');
  if(el('jd-label-adv')) el('jd-label-adv').textContent = t('java_show_advanced');
  if(el('jd-cancel-btn')) el('jd-cancel-btn').textContent = t('cancel');
  if(el('jd-apply-btn')) el('jd-apply-btn').textContent = t('java_apply');
  // GC options
  const gc = el('jdOptArgs');
  if (gc) { GC_OPTIONS().forEach(([v,l]) => { const opt = gc.querySelector(`option[value="${v}"]`); if(opt) opt.textContent = l; }); }
}
window.closeJavaDetail = function() { document.getElementById('javaDetailModal').classList.remove('open'); }
window.setJdType = function(type) {
  settingsDraft.javaType = type;
  document.querySelectorAll('.java-type-btn').forEach(b => b.classList.toggle('active', b.onclick?.toString().includes(`'${type}'`)));
  // Easier: re-render
  openJavaDetail();
  updateJdCustomSection();
  // Sync main dd
  const trigger = document.getElementById('javaTypeTrigger');
  if (trigger) trigger.textContent = {recommended:t('java_recommended'),current:t('java_current'),custom:t('java_custom')}[type]||'';
}
function updateJdCustomSection() {
  const s = settingsDraft;
  const cust = document.getElementById('jdCustomSection');
  const args = document.getElementById('jdArgsSection');
  if (cust) cust.classList.toggle('show', s.javaType === 'custom');
  if (args) args.classList.toggle('show', s.javaType === 'custom' && !!document.getElementById('jdShowArgs')?.checked);
  // populate fields
  const jp = document.getElementById('jdJavaPath');
  if (jp) jp.value = s.javaPath || '';
  const ja = document.getElementById('jdJavaArgs');
  if (ja) ja.value = s.javaArgs || '';
  const ma = document.getElementById('jdMcArgs');
  if (ma) ma.value = s.minecraftArgs || '';
  const wc = document.getElementById('jdWrapCmd');
  if (wc) wc.value = s.javaWrapCmd || '';
  const gc = document.getElementById('jdOptArgs');
  if (gc) gc.value = s.javaOptArgs || 'default';
}
window.pickJavaPath = async function() {
  const p = await window.electronAPI?.selectJava();
  if (p) {
    settingsDraft.javaPath = p;
    const inp = document.getElementById('jdJavaPath');
    if (inp) inp.value = p;
  }
}
window.toggleJdArgs = function(el) {
  settingsDraft._showArgs = el.checked;
  const args = document.getElementById('jdArgsSection');
  if (args) args.classList.toggle('show', el.checked);
}
window.saveJavaDetail = function() {
  // collect all fields
  const jp = document.getElementById('jdJavaPath');
  if (jp) settingsDraft.javaPath = jp.value;
  const ja = document.getElementById('jdJavaArgs');
  if (ja) settingsDraft.javaArgs = ja.value;
  const ma = document.getElementById('jdMcArgs');
  if (ma) settingsDraft.minecraftArgs = ma.value;
  const wc = document.getElementById('jdWrapCmd');
  if (wc) settingsDraft.javaWrapCmd = wc.value;
  const gc = document.getElementById('jdOptArgs');
  if (gc) settingsDraft.javaOptArgs = gc.value;
  closeJavaDetail();
}

// ─── Save / Reset ─────────────────────────────────────
// ─── Translations ────────────────────────────────────
// t() reads settingsDraft so language change is instant on save+re-render
function t(key) {
  const lang = config?.settings?.language || 'ru';
  return T?.[lang]?.[key] ?? T?.ru?.[key] ?? key;
}

var T = {
  ru: {
    nav_launcher:'Лаунчер', nav_mods:'Моды', nav_files:'Файлы', nav_settings:'Настройки', nav_friends:'Друзья',
    play:'Играть', stop:'Стоп', cancel:'Отмена',
    loading:'Загрузка...', search:'Поиск...', search_mods:'Поиск модов...',
    my_modpacks:'Мои модпаки', tab_mod:'Моды', tab_resourcepack:'Ресурс паки',
    tab_shader:'Шейдеры', tab_modpack:'Модпаки', tab_datapack:'Датапаки',
    sort_by:'Сортировка:', sort_popular:'По популярности', sort_newest:'По новизне', sort_relevance:'По релевантности',
    settings_save:'Сохранить', settings_reset:'По умолчанию', settings_saved:'✓ Настройки сохранены',
    settings_tab_mc:'Minecraft', settings_tab_launcher:'Лаунчер',
    settings_gamedir:'Папка игры', settings_gamedir_hint:'Папка где хранятся версии,<br>моды, миры и прочее',
    settings_gamedir_ph:'По умолчанию: папка лаунчера/minecraft',
    settings_browse:'Обзор...', settings_java:'Java / JRE', settings_ram:'Оперативная память (ОЗУ)',
    settings_ram_auto:'Авто', settings_ram_warn:'⚠ Выделение 24+ ГБ может вызвать проблемы с производительностью',
    settings_winsize:'Размер окна', settings_winsize_px:'пикс.',
    settings_console:'Командная строка', settings_console_hint:'Показывать CMD при запуске игры',
    settings_console_label:'Включить командную строку при запуске',
    settings_onlaunch:'При запуске игры', settings_lang:'Язык',
    java_recommended:'Рекомендуемая', java_current:'Текущая', java_custom:'Пользовательская',
    java_details:'••• Подробности',
    hide_hide:'Скрывать окно лаунчера', hide_close:'Закрывать окно лаунчера', hide_keep:'Оставлять лаунчер как есть',
    mp_create:'+ Создать', mp_add_mods:'+ Добавить моды', mp_play:'▶ Играть', mp_mods_in:'Моды в сборке',
    mp_empty:'<h3>Нет модпаков</h3><p>Нажмите «+ Создать» чтобы добавить первый модпак</p>',
    mp_new_title:'Новый модпак', mp_new_name:'Название', mp_new_name_ph:'Зомби модпак',
    mp_new_version:'Версия Minecraft', mp_new_loader:'Модлоадер', mp_new_loader_ver:'Версия загрузчика',
    mp_new_confirm:'Создать', mp_best_ver:'Использовать лучшую версию',
    mp_snap_note:'* модлоадеры недоступны в снапшотах',
    mp_add_title:'Добавить моды', mp_create_add:'+ Создать новый модпак и добавить',
    filter_version:'Версия игры', filter_loader:'Загрузчик', filter_category:'Категория', filter_env:'Среда',
    env_client:'Клиент', env_server:'Сервер',
    ver_select:'— выбрать версию —', ver_no_compat:'— нет совместимых версий —',
    ver_filter_hint:'🔒 Показаны только версии, поддерживаемые модом',
    add_to_mp:'+ В модпак', open_mr:'Открыть на Modrinth ↗', download:'↓ Скачать',
    add_btn:'+ Добавить', added:'✓ Добавлено', incompatible_loader:'✗ Несовместимо',
    no_compat_ver:'Нет модпаков с совместимой версией игры.',
    create_version:'+ Создать свою версию', version_mc:'Версия Minecraft',
    loader_ver:'Версия загрузчика', loader_first:'Сначала выберите версию игры', loader_unavail:'Версии недоступны',
    platforms:'Платформы', categories:'Категории', mc_versions:'Версии Minecraft', description:'Описание',
    versions:'Версии', gallery:'Галерея', changelog:'Ченджлог',
    sort_loader:'Загрузчик', sort_mc:'Minecraft',
    modpack_download:'↓ Скачать модпак', modpack_add_mine:'+ Добавить в мои модпаки',
    no_mods:'Моды не найдены', no_mods_sub:'Попробуйте изменить запрос или фильтры',
    load_more:'Загрузить ещё',
    picker_no_mp:'Нет модпаков. Создайте в разделе «Модпаки»',
  
    dd_empty:'Ничего не найдено',
    fb_up_title:'На уровень выше',
    fb_add_file_title:'Добавить файлы',
    fb_add_file:'+ Файл',
    fb_open_folder_title:'Открыть в проводнике',
    fb_folder_label:'Папка',
    fb_refresh_title:'Обновить',
    fb_drop_label:'Перенесите файлы для добавления',
    fb_drop_into:'Перенесите файлы в',
    fb_open:'Открыть',
    fb_show_explorer:'Показать в проводнике',
    fb_delete:'Удалить',
    fb_empty_dir:'Папка пуста',
    fb_preload_err:'Обновите preload.js — API не найден',
    fb_no_response:'нет ответа от main.js',
    fb_folders:'папок',
    fb_files:'файлов',
    fb_copying:'Копирование',
    fb_added:'Добавлено',
    fb_files_suffix:'файл(ов)',
    gc_default:'По умолчанию (CMS или G1 GC) — рекомендуется',
    gc_off:'Отключить (не рекомендуется)',
    gc_cms:'Использовать CMS GC',
    gc_g1gc:'Использовать G1 GC',
    gc_shenandoah:'Использовать Shenandoah GC (меньше пауз)',
    gc_zgc:'Использовать ZGC (лучше на мощных ПК)',
    java_path_label:'Путь к Java',
    java_args_label:'Аргументы Java',
    java_opt_args_label:'Оптимизированные аргументы',
    java_mc_args_label:'Аргументы Minecraft',
    java_wrap_cmd_label:'Команда — обёртка',
    java_show_advanced:'Дополнительные параметры',
    java_apply:'Применить',
    java_rec_desc:'Автоматически установит нужную версию Java',
    java_cur_desc:'Java которая поддерживает этот лаунчер',
    java_cur_warn:'(некоторые версии могут не запуститься!)',
    java_cust_desc:'Укажи путь к java.exe вручную',
    ver_release:'Релиз',
    ver_snapshot:'Снапшот',
    recent_versions:'Последние версии Minecraft',
    releases_label:'Релизы',
    snapshots_label:'Снапшоты',
    select_release:'— выбрать релиз —',
    select_snapshot:'— выбрать снапшот —',
    select_custom:'Выбрать свою версию',
    create_ver_action:'+ Создать версию',
    or_label:'или',
    modpack_badge:'модпак',
    loader_label:'Модлоадер',
    launching:'Запуск...',
    in_game_label:'В игре',
    preparing:'Подготовка...',
    downloading:'Скачивание...',
    select_ver_warn:'Выбери версию!',
    stop_download_title:'Остановить загрузку?',
    stop_download_desc:'Скачивание будет прервано.',
    stop_game_title:'Остановить игру?',
    stop_game_desc:'Майнкрафт получит сигнал корректного завершения —<br>ваши миры <strong style="color:#c8d0ff">автоматически сохранятся</strong>.',
    stop_btn:'Остановить',
    delete_btn:'Удалить',
    delete_version_desc:'Будут <strong style="color:#ff8888">безвозвратно удалены</strong> все миры в этой версии и сама версия.',
    delete_folder_desc:'Папка и всё её содержимое будут <strong style="color:#ff8888">удалены безвозвратно</strong>.',
    delete_file_desc:'Файл будет <strong style="color:#ff8888">удалён безвозвратно</strong>.',
    getting_label:'Получение...',
    no_files_err:'Нет файлов',
    opened_label:'Открыто →',
    error_label:'Ошибка',
    size_mb:'МБ',
    size_kb:'КБ',
    size_b:'Б',
    size_gb:'ГБ',
    size_mb_label:'МБ',
    npm_start_warn:'Запусти через npm start',
    err_load_versions:'Ошибка загрузки версий',
    opening_browser:'Открываю браузер...',
    login_elyby:'Sign in via Ely.by',
    opening_login:'Открываю окно входа...',
    auth_error:'Ошибка авторизации',
    login_ms:'Sign in via Microsoft',
    local_enter_nick:'Введите никнейм',
    local_min_chars:'Минимум 3 символа',
    dir_not_found:'Папка не найдена',
    dir_not_dir:'Указанный путь не является папкой',
    dir_no_access:'Нет прав доступа к этой папке',
    dir_check_fail:'Не удалось проверить путь',
  
    edit_title:'Редактировать',
    log_title:'Лог',
    log_empty:'Лог пуст...',
    ac_no_accounts:'Нет аккаунтов.<br>Добавьте через вкладку «+ Добавить»',
    ac_logged_via:'Авторизован через',
    ver_filter_hint_fmt:'Показаны только версии, поддерживаемые модом',
  
    tab_datapack_sub:'Моды для ванильного Minecraft, не требующие модлоадера',
    mod_no_support:'Мод не поддерживает',
    mp_toggle:'Свернуть/Развернуть',
    mp_cant_delete_running:'Нельзя удалить — модпак сейчас запущен',
    mp_open_folder:'Открыть папку модпака',
    ac_type_local:'Офлайн',
  
    this_version:'эту версию',
    this_modpack:'этот модпак',
    delete_mp_desc:'Будут <strong style="color:#ff8888">безвозвратно удалены</strong> все файлы модпака и его настройки.',
    compat_versions:'поддерживаемые версии',
    compat_loaders:'поддерживаемые модлоадеры',
    incompatible_label:'Несовместимо',
  
    env_required:'Обязательно',
    env_optional:'Опционально',
    env_unsupported:'Не поддерживается',
  
    mods_count:'мод.',
    vanilla_no_mods:'Недоступно для Vanilla — только датапаки',
  
    splash_greeting:'Приветствую',
    splash_hi:'Привет, ',
    ac_title:'Аккаунт',
    ac_tab_accounts:'Аккаунты',
    ac_tab_add:'+ Добавить',
    ac_available:'Доступные аккаунты',
    ac_add_account:'Добавить аккаунт',
    ac_elyby_sub:'Авторизация через браузер',
    ac_ms_sub:'Лицензионный аккаунт Minecraft',
    ac_local_sub:'Без авторизации',
    ac_elyby_hint:'Откроется браузер для входа',
    ac_ms_hint:'Откроется окно входа Microsoft',
    ac_offline_warn:'⚠ Возможны ошибки с игрой на серверах',
    ac_nickname:'Никнейм',
    play_offline:'Играть офлайн',
    log_empty:'Лог пуст...',
    ver_save_name:'✓ Сохранить название',
    ver_delete:'🗑 Удалить версию',
    modal_create_ver_title:'Создать свою версию',
    modal_name_ph:'Например: Выживание с Fabric',
    search_btn:'Найти',
    enter_query:'Введите запрос для поиска',
    src_all:'Все',
    ac_type_local:'Офлайн',

    // Social / Friends
    soc_friends:'Друзья', soc_pending:'Заявки', soc_account:'Аккаунт',
    soc_online:'Онлайн', soc_offline:'Офлайн', soc_connect:'Войти',
    soc_remove_friend:'Удалить друга', soc_block:'Заблокировать', soc_report:'Пожаловаться',
    soc_no_friends:'Друзей пока нет.', soc_add_hint:'Добавь по @username или ID',
    soc_no_pending:'Нет входящих заявок',
    soc_new_nick:'Новый никнейм', soc_display_name:'Отображаемое имя',
    soc_linked:'Привязан', soc_not_linked:'Не привязан',
    soc_unlink:'Отвязать', soc_link:'Привязать',
    soc_link_ms:'Авторизируйся через Microsoft', soc_link_ely:'Авторизируйся через Ely.by',
    soc_new_pass:'Новый пароль (мин. 6 символов)', soc_repeat_pass:'Повторите пароль',
    soc_connecting:'⚡ Подключение к',
    soc_report_desc:'Опишите проблему (необязательно)...', soc_sending:'Отправка...',
    soc_report_sent:'Жалоба отправлена', soc_send:'Отправить',
    soc_fill_fields:'Заполните все поля',
    soc_login:'Войти', soc_wait:'⏳ Подождите...',
    soc_login_via:'Войти через', soc_reg_via:'Регистрация через',
    soc_no_accounts:'Нет аккаунтов', soc_login_mc:'. Войдите в аккаунт Minecraft.',
    soc_choose_acc:'Выберите аккаунт', soc_select:'Выбрать', soc_cancel:'Отмена',
    soc_nick_len:'Никнейм: 1–64 символа', soc_pass_min:'Пароль минимум 6 символов',
    soc_pass_mismatch:'Пароли не совпадают',
    soc_enter_nick:'Введите новый никнейм', soc_nick_long:'Никнейм не может превышать 64 символа',
    soc_server_err:'Ошибка сервера: нет данных пользователя',
    soc_nick_changed:'Никнейм изменён на', soc_enter_dname:'Введите отображаемое имя',
    soc_dname_long:'Максимум 32 символа', soc_server_err2:'Ошибка сервера',
    soc_dname_changed:'Имя изменено на', soc_enter_pass:'Введите новый пароль',
    soc_pass_set:'Пароль успешно установлен!', soc_no_active:'Нет активного аккаунта',
    soc_acc_linked:'} успешно привязан!',
    soc_msg_placeholder:'Сообщение...',
    soc_change_avatar:'Изменить аватар', soc_your_id:'Ваш ID (нажмите для копирования)',
    soc_id_copied:'ID: скопировано!', soc_no_mc:'Нет активного аккаунта Minecraft',
    soc_skin_fail:'Не удалось загрузить скин', soc_err:'Ошибка:',
    soc_block_user:'Заблокировать @', soc_search_nick:'Поиск по никнейму...',
    soc_use_skin:'Использовать скин Minecraft', soc_reset_avatar:'Сбросить аватар',
    soc_upload_photo:'Загрузить фото', soc_mc_skin:'Скин Minecraft',
    soc_login_ms:'Войти через Microsoft', soc_login_ely:'Войти через Ely.by',
    soc_register:'Зарегистрироваться', soc_reg_short:'Регистрация',
    soc_nick_ph:'Никнейм', soc_pass_ph:'Пароль',
    soc_nick_ph2:'Никнейм (до 64 символов)', soc_dname_ph:'Отображаемое имя (необязательно)',
    soc_pass_ph2:'Пароль (мин. 6 символов)',
    soc_logout_title:'Выйти?', soc_logout_desc:'Вы выйдете из MidLauncher Social.<br>Друзья увидят вас офлайн.',
    soc_logout:'Выйти',
    soc_delete_title:'Удалить аккаунт?', soc_delete_err:'Ошибка удаления',
    soc_delete_desc:'>irreversible</b>.<br>All data, friends and messages will be deleted.',
    soc_delete_confirm:'Удалить навсегда',
    soc_confirm_pass:'Введите пароль для подтверждения', soc_confirm:'Подтвердить',
    soc_enter_pass2:'Введите пароль',
    soc_no_acc_service:'Сначала войди в {service} аккаунт в разделе «Аккаунты» лаунчера', soc_delete_full:'Это действие <b style="color:#cc4444;">необратимо</b>.<br>Все данные, друзья и сообщения будут удалены.',
    // Admin panel
    adm_panel:'Админ-панель', adm_users:'Пользователи', adm_reports:'Жалобы', adm_stats:'Статистика',
    adm_loading:'Загрузка...', adm_no_users:'Нет пользователей', adm_no_reports:'Жалоб нет',
    adm_copy_id:'Скопировать ID', adm_view:'Просмотр', adm_change_id:'Изменить ID',
    adm_revoke:'Снять', adm_grant:'Админ', adm_unban:'Разбанить', adm_ban:'Бан',
    adm_delete:'Удалить', adm_ban_title:'Бан @', adm_ban_desc:'Пользователь не сможет войти.',
    adm_unban_title:'Разбан @', adm_unban_desc:'Пользователь снова сможет войти.',
    adm_delete_title:'Удалить @', adm_delete_desc:'Аккаунт будет удалён безвозвратно.',
    adm_change_id_title:'Изменить ID для @',
    adm_change_id_desc:'Введите новый ID (любые символы). Внимание — это изменит основной идентификатор.',
    adm_change_id_btn:'Изменить', adm_change_id_err:'Ошибка изменения ID:',
    adm_grant_title:'Сделать @ администратором?', adm_grant_admin:'администратором?',
    adm_grant_desc:'Пользователь получит доступ к панели администратора.', adm_grant_btn:'Сделать админом',
    adm_revoke_title:'Снять права администратора у @',
    adm_revoke_desc:'Пользователь потеряет доступ к панели администратора.',
    adm_copy:'Скопировать', adm_close:'Закрыть',
    adm_stat_users:'👥 Пользователей', adm_stat_friends:'🤝 Friendships',
    adm_stat_msgs:'💬 Сообщений', adm_stat_online:'🟢 Online',
    adm_banned:'[БАН]', adm_revoke_admin:'Снять права администратора',
    adm_grant_admin_btn:'Выдать права администратора',
    adm_spam:'Спам', adm_abuse:'Abuse', adm_cheat:'Читерство', adm_other:'Другое',
    // Game/launcher misc
    game_started:'Игра запущена!', game_closed:'Игра закрыта',
    game_running:'⚠ Игра уже запущена', game_in:'● В игре',
    sel_mc_ver:'Выбери версию MC', sel_mc_ver2:'Выберите версию Minecraft',
    rename:'Переименовать',
    dl_fail:'⚠ Не удалось скачать «', dl_no_slug:'»: нет slug',
    dl_ing:'⬇ Скачивание', dl_done:'скачано', dl_err:'✗ Ошибка загрузки',
    dl_vers:'⬇ Получение версий для «', dl_ver_err:'✗ Ошибка getModVersions для «',
    dl_no_vers:'⚠ Нет версий для «', dl_no_file:'⚠ Нет файла в версии «',
    dl_saved:'сохранено в', launch_err:'Ошибка запуска:',
    cant_delete_mp:'Нельзя удалить — модпак запущен',
    downloaded:'✓ Скачано', err_short:'Ошибка',
    dl_m:'М скач.', dl_k:'К скач.', dl_n:'скач.',
    importing:'Импорт...', loading_mods:'Загрузка модов...',
    loading_short:'Загрузка...',
    added_mods:'✓ Добавлен ({n} модов)',
    // Mod details
    dl_modpack:'↓ Скачать модпак', add_modpack:'+ В модпак',
    platforms:'Платформы', categories:'Категории', mc_versions2:'Версии Minecraft',
    no_versions:'Нет доступных версий', add_modpack2:'+ В модпак',
    gallery_empty:'Галерея пуста', no_data:'Нет данных', changelog_na:'Ченджлог недоступен',
    updated:'Обновлено', incompat_loader:'✗ Несовместимый загрузчик — поддерживается:',
    incompat_loader2:'Несовместимый загрузчик модов',
    add_mod_to_mp:'Добавить «{name}» в модпак',
    // Mod categories
    cat_adventure:'Приключения', cat_combat:'Боевые', cat_decoration:'Декорации',
    cat_economy:'Экономика', cat_equipment:'Снаряжение', cat_food:'Еда',
    cat_game_mechanics:'Механики', cat_library:'Библиотеки', cat_magic:'Магия',
    cat_management:'Управление', cat_minigame:'Мини-игры', cat_mobs:'Мобы',
    cat_optimization:'Оптимизация', cat_social:'Социальное', cat_storage:'Хранилище',
    cat_technology:'Технологии', cat_transport:'Транспорт', cat_utility:'Утилиты',
    cat_worldgen:'Генерация мира', cat_biome:'Биомы', cat_structure:'Структуры',
    cat_dimension:'Измерения', cat_cursed:'Проклятые', cat_quests:'Квесты',
    cat_building:'Строительство', cat_misc:'Разное',
    // Shader categories
    sh_atmosphere:'Атмосфера', sh_bloom:'Свечение', sh_cartoon:'Мультяшный',
    sh_colored_light:'Цветное освещение', sh_fantasy:'Фэнтези', sh_foliage:'Листва',
    sh_high:'Высокое качество', sh_low:'Низкое качество', sh_medium:'Среднее качество',
    sh_path_tracing:'Трассировка путей', sh_realism:'Реализм', sh_reflections:'Отражения',
    sh_semi_realism:'Полу-реализм', sh_shadows:'Тени', sh_vanilla:'Ванильный',
    sh_hardcore:'Хардкор', sh_potato:'Картошка',
    // Multiplayer/singleplayer
    mp_multiplayer:'Мультиплеер', mp_singleplayer:'Одиночная',
    env_both:'Клиент и сервер', env_client_only:'Только клиент', env_server_only:'Только сервер',
    env_client_optional:'Клиент (+ опц. сервер)', env_server_optional:'Сервер (+ опц. клиент)',
    env_both_optional:'Клиент и сервер (опц.)',
    // Settings misc
    bg_label:'Фон', theme_label:'Тема оформления', theme_light:'Светлая', theme_dark:'Тёмная', bg_animated:'Анимированный фон', bg_static:'Обычный фон',
    reset_btn:'✕ Сбросить',
  },
  en: {
    nav_launcher:'Launcher', nav_mods:'Mods', nav_files:'Files', nav_settings:'Settings', nav_friends:'Friends',
    play:'Play', stop:'Stop', cancel:'Cancel',
    loading:'Loading...', search:'Search...', search_mods:'Search mods...',
    my_modpacks:'My Modpacks', tab_mod:'Mods', tab_resourcepack:'Resource Packs',
    tab_shader:'Shaders', tab_modpack:'Modpacks', tab_datapack:'Datapacks',
    sort_by:'Sort:', sort_popular:'By popularity', sort_newest:'Newest', sort_relevance:'By relevance',
    settings_save:'Save', settings_reset:'Reset to defaults', settings_saved:'✓ Settings saved',
    settings_tab_mc:'Minecraft', settings_tab_launcher:'Launcher',
    settings_gamedir:'Game folder', settings_gamedir_hint:'Folder for versions,<br>mods, worlds and more',
    settings_gamedir_ph:'Default: launcher folder/minecraft',
    settings_browse:'Browse...', settings_java:'Java / JRE', settings_ram:'RAM Memory',
    settings_ram_auto:'Auto', settings_ram_warn:'⚠ Allocating 24+ GB may cause performance issues',
    settings_winsize:'Window size', settings_winsize_px:'px',
    settings_console:'Console window', settings_console_hint:'Show CMD when launching game',
    settings_console_label:'Enable console window on launch',
    settings_onlaunch:'On game launch', settings_lang:'Language',
    java_recommended:'Recommended', java_current:'Current', java_custom:'Custom',
    java_details:'••• Details',
    hide_hide:'Hide launcher window', hide_close:'Close launcher window', hide_keep:'Keep launcher open',
    mp_create:'+ Create', mp_add_mods:'+ Add mods', mp_play:'▶ Play', mp_mods_in:'Mods in pack',
    mp_empty:'<h3>No modpacks</h3><p>Click «+ Create» to add your first modpack</p>',
    mp_new_title:'New modpack', mp_new_name:'Name', mp_new_name_ph:'Zombie modpack',
    mp_new_version:'Minecraft version', mp_new_loader:'Mod loader', mp_new_loader_ver:'Loader version',
    mp_new_confirm:'Create', mp_best_ver:'Use best version',
    mp_snap_note:'* mod loaders unavailable for snapshots',
    mp_add_title:'Add mods', mp_create_add:'+ Create new modpack and add',
    filter_version:'Game version', filter_loader:'Loader', filter_category:'Category', filter_env:'Environment',
    env_client:'Client', env_server:'Server',
    ver_select:'— select version —', ver_no_compat:'— no compatible versions —',
    ver_filter_hint:'🔒 Showing only versions supported by the mod',
    add_to_mp:'+ To modpack', open_mr:'Open on Modrinth ↗', download:'↓ Download',
    add_btn:'+ Add', added:'✓ Added', incompatible_loader:'✗ Incompatible',
    no_compat_ver:'No modpacks with compatible game version.',
    create_version:'+ Create custom version', version_mc:'Minecraft version',
    loader_ver:'Loader version', loader_first:'Select game version first', loader_unavail:'No versions available',
    platforms:'Platforms', categories:'Categories', mc_versions:'Minecraft Versions', description:'Description',
    versions:'Versions', gallery:'Gallery', changelog:'Changelog',
    sort_loader:'Loader', sort_mc:'Minecraft',
    modpack_download:'↓ Download modpack', modpack_add_mine:'+ Add to my modpacks',
    no_mods:'No mods found', no_mods_sub:'Try changing your query or filters',
    load_more:'Load more',
    picker_no_mp:'No modpacks. Create one in the «Modpacks» section',
  
    dd_empty:'Nothing found',
    fb_up_title:'Go up',
    fb_add_file_title:'Add files',
    fb_add_file:'+ File',
    fb_open_folder_title:'Open in explorer',
    fb_folder_label:'Folder',
    fb_refresh_title:'Refresh',
    fb_drop_label:'Drop files here to add',
    fb_drop_into:'Drop files into',
    fb_open:'Open',
    fb_show_explorer:'Show in explorer',
    fb_delete:'Delete',
    fb_empty_dir:'Folder is empty',
    fb_preload_err:'Update preload.js — API not found',
    fb_no_response:'no response from main.js',
    fb_folders:'folders',
    fb_files:'files',
    fb_copying:'Copying',
    fb_added:'Added',
    fb_files_suffix:'file(s)',
    gc_default:'Default (CMS or G1 GC) — recommended',
    gc_off:'Disabled (not recommended)',
    gc_cms:'Use CMS GC',
    gc_g1gc:'Use G1 GC',
    gc_shenandoah:'Use Shenandoah GC (fewer pauses)',
    gc_zgc:'Use ZGC (better on powerful PCs)',
    java_path_label:'Java path',
    java_args_label:'Java arguments',
    java_opt_args_label:'Optimized arguments',
    java_mc_args_label:'Minecraft arguments',
    java_wrap_cmd_label:'Wrapper command',
    java_show_advanced:'Show advanced options',
    java_apply:'Apply',
    java_rec_desc:'Automatically installs the required Java version',
    java_cur_desc:'Java that supports this launcher',
    java_cur_warn:'(some versions may not launch!)',
    java_cust_desc:'Specify path to java.exe manually',
    ver_release:'Release',
    ver_snapshot:'Snapshot',
    recent_versions:'Latest Minecraft Versions',
    releases_label:'Releases',
    snapshots_label:'Snapshots',
    select_release:'— select release —',
    select_snapshot:'— select snapshot —',
    select_custom:'Select custom version',
    create_ver_action:'+ Create version',
    or_label:'or',
    modpack_badge:'modpack',
    loader_label:'Mod Loader',
    launching:'Launching...',
    in_game_label:'In game',
    preparing:'Preparing...',
    downloading:'Downloading...',
    select_ver_warn:'Select a version first!',
    stop_download_title:'Stop download?',
    stop_download_desc:'Download will be interrupted.',
    stop_game_title:'Stop game?',
    stop_game_desc:'Minecraft will receive a graceful shutdown signal —<br>your worlds will <strong style="color:#c8d0ff">be saved automatically</strong>.',
    stop_btn:'Stop',
    delete_btn:'Delete',
    delete_version_desc:'All worlds in this version will be <strong style="color:#ff8888">permanently deleted</strong>.',
    delete_folder_desc:'The folder and all its contents will be <strong style="color:#ff8888">permanently deleted</strong>.',
    delete_file_desc:'The file will be <strong style="color:#ff8888">permanently deleted</strong>.',
    getting_label:'Fetching...',
    no_files_err:'No files',
    opened_label:'Opened →',
    error_label:'Error',
    size_mb:'MB',
    size_kb:'KB',
    size_b:'B',
    size_gb:'GB',
    size_mb_label:'MB',
    npm_start_warn:'Run via npm start',
    err_load_versions:'Error loading versions',
    opening_browser:'Opening browser...',
    login_elyby:'Login with Ely.by',
    opening_login:'Opening login window...',
    auth_error:'Authentication error',
    login_ms:'Login with Microsoft',
    local_enter_nick:'Enter a username',
    local_min_chars:'Minimum 3 characters',
    dir_not_found:'Folder not found',
    dir_not_dir:'Path is not a folder',
    dir_no_access:'No access to this folder',
    dir_check_fail:'Could not verify path',
  
    edit_title:'Edit',
    log_title:'Log',
    log_empty:'Log is empty...',
    ac_no_accounts:'No accounts.<br>Add one via the «+ Add» tab',
    ac_logged_via:'Logged in via',
    ver_filter_hint_fmt:'Showing only versions supported by the mod',
  
    tab_datapack_sub:'Mods for vanilla Minecraft, no mod loader required',
    mod_no_support:'Mod does not support',
    mp_toggle:'Collapse/Expand',
    mp_cant_delete_running:'Cannot delete — modpack is currently running',
    mp_open_folder:'Open modpack folder',
    ac_type_local:'Offline',
  
    this_version:'this version',
    this_modpack:'this modpack',
    delete_mp_desc:'All modpack files and settings will be <strong style="color:#ff8888">permanently deleted</strong>.',
    compat_versions:'supported versions',
    compat_loaders:'supported loaders',
    incompatible_label:'Incompatible',
  
    env_required:'Required',
    env_optional:'Optional',
    env_unsupported:'Unsupported',
  
    mods_count:'mods',
    vanilla_no_mods:'Not available for Vanilla — datapacks only',
  
    splash_greeting:'Welcome',
    splash_hi:'Hey, ',
    ac_title:'Account',
    ac_tab_accounts:'Accounts',
    ac_tab_add:'+ Add',
    ac_available:'Available accounts',
    ac_add_account:'Add account',
    ac_elyby_sub:'Browser-based login',
    ac_ms_sub:'Licensed Minecraft account',
    ac_local_sub:'No authentication',
    ac_elyby_hint:'A browser will open for login',
    ac_ms_hint:'A Microsoft login window will open',
    ac_offline_warn:'⚠ May cause issues on online servers',
    ac_nickname:'Username',
    play_offline:'Play offline',
    log_empty:'Log is empty...',
    ver_save_name:'✓ Save name',
    ver_delete:'🗑 Delete version',
    modal_create_ver_title:'Create custom version',
    modal_name_ph:'E.g.: Survival with Fabric',
    search_btn:'Search',
    enter_query:'Enter a query to search',
    src_all:'All',
    ac_type_local:'Offline',

    soc_friends:'Friends', soc_pending:'Requests', soc_account:'Account',
    soc_online:'Online', soc_offline:'Offline', soc_connect:'Join',
    soc_remove_friend:'Remove friend', soc_block:'Block', soc_report:'Report',
    soc_no_friends:'No friends yet.', soc_add_hint:'Add by @username or ID',
    soc_no_pending:'No incoming requests',
    soc_new_nick:'New username', soc_display_name:'Display name',
    soc_linked:'Linked', soc_not_linked:'Not linked',
    soc_unlink:'Unlink', soc_link:'Link',
    soc_link_ms:'Sign in via Microsoft', soc_link_ely:'Sign in via Ely.by',
    soc_new_pass:'New password (min. 6 chars)', soc_repeat_pass:'Repeat password',
    soc_connecting:'⚡ Connecting to',
    soc_report_desc:'Describe the issue (optional)...', soc_sending:'Sending...',
    soc_report_sent:'Report sent', soc_send:'Send',
    soc_fill_fields:'Fill in all fields',
    soc_login:'Sign in', soc_wait:'⏳ Please wait...',
    soc_login_via:'Sign in via', soc_reg_via:'Register via',
    soc_no_accounts:'No accounts', soc_login_mc:'. Sign in to a Minecraft account.',
    soc_choose_acc:'Choose account', soc_select:'Select', soc_cancel:'Cancel',
    soc_nick_len:'Username: 1–64 characters', soc_pass_min:'Password minimum 6 characters',
    soc_pass_mismatch:'Passwords do not match',
    soc_enter_nick:'Enter new username', soc_nick_long:'Username cannot exceed 64 characters',
    soc_server_err:'Server error: no user data',
    soc_nick_changed:'Username changed to', soc_enter_dname:'Enter display name',
    soc_dname_long:'Max 32 characters', soc_server_err2:'Server error',
    soc_dname_changed:'Name changed to', soc_enter_pass:'Enter new password',
    soc_pass_set:'Password set successfully!', soc_no_active:'No active account',
    soc_acc_linked:'} successfully linked!',
    soc_msg_placeholder:'Message...',
    soc_change_avatar:'Change avatar', soc_your_id:'Your ID (click to copy)',
    soc_id_copied:'ID: copied!', soc_no_mc:'No active Minecraft account',
    soc_skin_fail:'Could not load skin', soc_err:'Error:',
    soc_block_user:'Block @', soc_search_nick:'Search by username...',
    soc_use_skin:'Use Minecraft skin', soc_reset_avatar:'Reset avatar',
    soc_upload_photo:'Upload photo', soc_mc_skin:'Minecraft skin',
    soc_login_ms:'Sign in via Microsoft', soc_login_ely:'Sign in via Ely.by',
    soc_register:'Register', soc_reg_short:'Register',
    soc_nick_ph:'Username', soc_pass_ph:'Password',
    soc_nick_ph2:'Username (up to 64 chars)', soc_dname_ph:'Display name (optional)',
    soc_pass_ph2:'Password (min. 6 chars)',
    soc_logout_title:'Sign out?', soc_logout_desc:'You will sign out of MidLauncher Social.<br>Friends will see you offline.',
    soc_logout:'Sign out',
    soc_delete_title:'Delete account?', soc_delete_err:'Delete error',
    soc_delete_desc:'>irreversible</b>.<br>All data, friends and messages will be deleted.', soc_delete_full:'This action is <b style="color:#cc4444;">irreversible</b>.<br>All data, friends and messages will be deleted.',
    soc_delete_confirm:'Delete permanently',
    soc_confirm_pass:'Enter password to confirm', soc_confirm:'Confirm',
    soc_enter_pass2:'Enter password',
    soc_no_acc_service:'First sign in to your {service} account in the "Accounts" section',
    adm_panel:'Admin panel', adm_users:'Users', adm_reports:'Reports', adm_stats:'Statistics',
    adm_loading:'Loading...', adm_no_users:'No users', adm_no_reports:'No reports',
    adm_copy_id:'Copy ID', adm_view:'View', adm_change_id:'Change ID',
    adm_revoke:'Revoke', adm_grant:'Admin', adm_unban:'Unban', adm_ban:'Ban',
    adm_delete:'Delete', adm_ban_title:'Ban @', adm_ban_desc:'User will not be able to sign in.',
    adm_unban_title:'Unban @', adm_unban_desc:'User will be able to sign in again.',
    adm_delete_title:'Delete @', adm_delete_desc:'Account will be permanently deleted.',
    adm_change_id_title:'Change ID for @',
    adm_change_id_desc:'Enter new ID (any characters). Warning — this changes the primary identifier.',
    adm_change_id_btn:'Change', adm_change_id_err:'ID change error:',
    adm_grant_title:'Make @ an administrator?', adm_grant_admin:'administrator?',
    adm_grant_desc:'User will get access to the admin panel.', adm_grant_btn:'Make admin',
    adm_revoke_title:'Remove admin rights from @',
    adm_revoke_desc:'User will lose access to the admin panel.',
    adm_copy:'Copy', adm_close:'Close',
    adm_stat_users:'👥 Users', adm_stat_friends:'🤝 Friendships',
    adm_stat_msgs:'💬 Messages', adm_stat_online:'🟢 Online',
    adm_banned:'[BANNED]', adm_revoke_admin:'Revoke admin', adm_grant_admin_btn:'Grant admin',
    adm_spam:'Spam', adm_abuse:'Abuse', adm_cheat:'Cheating', adm_other:'Other',
    game_started:'Game started!', game_closed:'Game closed',
    game_running:'⚠ Game already running', game_in:'● In game',
    sel_mc_ver:'Select MC version', sel_mc_ver2:'Select Minecraft version',
    rename:'Rename',
    dl_fail:'⚠ Could not download «', dl_no_slug:'»: no slug',
    dl_ing:'⬇ Downloading', dl_done:'downloaded', dl_err:'✗ Download error',
    dl_vers:'⬇ Getting versions for «', dl_ver_err:'✗ getModVersions error for «',
    dl_no_vers:'⚠ No versions for «', dl_no_file:'⚠ No file in version «',
    dl_saved:'saved to', launch_err:'Launch error:',
    cant_delete_mp:'Cannot delete — modpack is running',
    downloaded:'✓ Downloaded', err_short:'Error',
    dl_m:'M dls', dl_k:'K dls', dl_n:'dls',
    importing:'Importing...', loading_mods:'Loading mods...',
    loading_short:'Loading...',
    added_mods:'✓ Added ({n} mods)',
    dl_modpack:'↓ Download modpack', add_modpack:'+ To modpack',
    platforms:'Platforms', categories:'Categories', mc_versions2:'Minecraft versions',
    no_versions:'No versions available', add_modpack2:'+ Modpack',
    gallery_empty:'Gallery empty', no_data:'No data', changelog_na:'Changelog unavailable',
    updated:'Updated', incompat_loader:'✗ Incompatible loader — supported:',
    incompat_loader2:'Incompatible mod loader',
    add_mod_to_mp:'Add "{name}" to modpack',
    cat_adventure:'Adventure', cat_combat:'Combat', cat_decoration:'Decoration',
    cat_economy:'Economy', cat_equipment:'Equipment', cat_food:'Food',
    cat_game_mechanics:'Game Mechanics', cat_library:'Library', cat_magic:'Magic',
    cat_management:'Management', cat_minigame:'Mini-Game', cat_mobs:'Mobs',
    cat_optimization:'Optimization', cat_social:'Social', cat_storage:'Storage',
    cat_technology:'Technology', cat_transport:'Transport', cat_utility:'Utility',
    cat_worldgen:'World Generation', cat_biome:'Biomes', cat_structure:'Structures',
    cat_dimension:'Dimensions', cat_cursed:'Cursed', cat_quests:'Quests',
    cat_building:'Building', cat_misc:'Miscellaneous',
    sh_atmosphere:'Atmosphere', sh_bloom:'Bloom', sh_cartoon:'Cartoon',
    sh_colored_light:'Colored Lighting', sh_fantasy:'Fantasy', sh_foliage:'Foliage',
    sh_high:'High Quality', sh_low:'Low Quality', sh_medium:'Medium Quality',
    sh_path_tracing:'Path Tracing', sh_realism:'Realism', sh_reflections:'Reflections',
    sh_semi_realism:'Semi-Realism', sh_shadows:'Shadows', sh_vanilla:'Vanilla-like',
    sh_hardcore:'Hardcore', sh_potato:'Potato',
    mp_multiplayer:'Multiplayer', mp_singleplayer:'Singleplayer',
    env_both:'Client and server', env_client_only:'Client only', env_server_only:'Server only',
    env_client_optional:'Client (+ opt. server)', env_server_optional:'Server (+ opt. client)',
    env_both_optional:'Client and server (opt.)',
    bg_label:'Background', theme_label:'Theme', theme_light:'Light', theme_dark:'Dark', bg_animated:'Animated background', bg_static:'Static background',
    reset_btn:'✕ Reset',
  },
  de: {
    nav_launcher:'Launcher', nav_mods:'Mods', nav_files:'Dateien', nav_settings:'Einstellungen', nav_friends:'Freunde',
    play:'Spielen', stop:'Stop', cancel:'Abbrechen',
    loading:'Laden...', search:'Suchen...', search_mods:'Mods suchen...',
    my_modpacks:'Meine Modpacks', tab_mod:'Mods', tab_resourcepack:'Ressourcenpakete',
    tab_shader:'Shader', tab_modpack:'Modpacks', tab_datapack:'Datenpakete',
    sort_by:'Sortierung:', sort_popular:'Nach Beliebtheit', sort_newest:'Neueste', sort_relevance:'Nach Relevanz',
    settings_save:'Speichern', settings_reset:'Zurücksetzen', settings_saved:'✓ Einstellungen gespeichert',
    settings_tab_mc:'Minecraft', settings_tab_launcher:'Launcher',
    settings_gamedir:'Spielordner', settings_gamedir_hint:'Ordner für Versionen,<br>Mods, Welten und mehr',
    settings_gamedir_ph:'Standard: Launcher-Ordner/minecraft',
    settings_browse:'Durchsuchen...', settings_java:'Java / JRE', settings_ram:'Arbeitsspeicher (RAM)',
    settings_ram_auto:'Auto', settings_ram_warn:'⚠ 24+ GB können Leistungsprobleme verursachen',
    settings_winsize:'Fenstergröße', settings_winsize_px:'px',
    settings_console:'Konsolenfenster', settings_console_hint:'CMD beim Start anzeigen',
    settings_console_label:'Konsolenfenster beim Start aktivieren',
    settings_onlaunch:'Beim Spielstart', settings_lang:'Sprache',
    java_recommended:'Empfohlen', java_current:'Aktuell', java_custom:'Benutzerdefiniert',
    java_details:'••• Details',
    hide_hide:'Launcher ausblenden', hide_close:'Launcher schließen', hide_keep:'Launcher offen lassen',
    mp_create:'+ Erstellen', mp_add_mods:'+ Mods hinzufügen', mp_play:'▶ Spielen', mp_mods_in:'Mods im Pack',
    mp_empty:'<h3>Keine Modpacks</h3><p>Klicke «+ Erstellen» um das erste Modpack hinzuzufügen</p>',
    mp_new_title:'Neues Modpack', mp_new_name:'Name', mp_new_name_ph:'Zombie-Modpack',
    mp_new_version:'Minecraft-Version', mp_new_loader:'Mod-Loader', mp_new_loader_ver:'Loader-Version',
    mp_new_confirm:'Erstellen', mp_best_ver:'Beste Version verwenden',
    mp_snap_note:'* Mod-Loader für Snapshots nicht verfügbar',
    mp_add_title:'Mods hinzufügen', mp_create_add:'+ Neues Modpack erstellen und hinzufügen',
    filter_version:'Spielversion', filter_loader:'Loader', filter_category:'Kategorie', filter_env:'Umgebung',
    env_client:'Client', env_server:'Server',
    ver_select:'— Version wählen —', ver_no_compat:'— keine kompatiblen Versionen —',
    ver_filter_hint:'🔒 Nur vom Mod unterstützte Versionen',
    add_to_mp:'+ Zum Modpack', open_mr:'Auf Modrinth öffnen ↗', download:'↓ Herunterladen',
    add_btn:'+ Hinzufügen', added:'✓ Hinzugefügt', incompatible_loader:'✗ Inkompatibel',
    no_compat_ver:'Keine Modpacks mit kompatibler Spielversion.',
    create_version:'+ Eigene Version erstellen', version_mc:'Minecraft-Version',
    loader_ver:'Loader-Version', loader_first:'Zuerst Spielversion wählen', loader_unavail:'Keine Versionen verfügbar',
    platforms:'Plattformen', categories:'Kategorien', mc_versions:'Minecraft-Versionen', description:'Beschreibung',
    versions:'Versionen', gallery:'Galerie', changelog:'Änderungsprotokoll',
    sort_loader:'Loader', sort_mc:'Minecraft',
    modpack_download:'↓ Modpack herunterladen', modpack_add_mine:'+ Zu meinen Modpacks',
    no_mods:'Keine Mods gefunden', no_mods_sub:'Versuche Suche oder Filter zu ändern',
    load_more:'Mehr laden',
    picker_no_mp:'Keine Modpacks. Erstelle eines im Bereich «Modpacks»',
  
    dd_empty:'Nichts gefunden',
    fb_up_title:'Eine Ebene höher',
    fb_add_file_title:'Dateien hinzufügen',
    fb_add_file:'+ Datei',
    fb_open_folder_title:'Im Explorer öffnen',
    fb_folder_label:'Ordner',
    fb_refresh_title:'Aktualisieren',
    fb_drop_label:'Dateien hier ablegen',
    fb_drop_into:'Dateien ablegen in',
    fb_open:'Öffnen',
    fb_show_explorer:'Im Explorer anzeigen',
    fb_delete:'Löschen',
    fb_empty_dir:'Ordner ist leer',
    fb_preload_err:'preload.js aktualisieren — API nicht gefunden',
    fb_no_response:'keine Antwort von main.js',
    fb_folders:'Ordner',
    fb_files:'Dateien',
    fb_copying:'Kopieren',
    fb_added:'Hinzugefügt',
    fb_files_suffix:'Datei(en)',
    gc_default:'Standard (CMS oder G1 GC) — empfohlen',
    gc_off:'Deaktiviert (nicht empfohlen)',
    gc_cms:'CMS GC verwenden',
    gc_g1gc:'G1 GC verwenden',
    gc_shenandoah:'Shenandoah GC verwenden',
    gc_zgc:'ZGC verwenden (besser auf leistungsstarken PCs)',
    java_path_label:'Java-Pfad',
    java_args_label:'Java-Argumente',
    java_opt_args_label:'Optimierte Argumente',
    java_mc_args_label:'Minecraft-Argumente',
    java_wrap_cmd_label:'Wrapper-Befehl',
    java_show_advanced:'Erweiterte Optionen anzeigen',
    java_apply:'Anwenden',
    java_rec_desc:'Installiert automatisch die benötigte Java-Version',
    java_cur_desc:'Java, das diesen Launcher unterstützt',
    java_cur_warn:'(einige Versionen starten möglicherweise nicht!)',
    java_cust_desc:'Pfad zu java.exe manuell angeben',
    ver_release:'Release',
    ver_snapshot:'Snapshot',
    recent_versions:'Neueste Minecraft-Versionen',
    releases_label:'Releases',
    snapshots_label:'Snapshots',
    select_release:'— Release wählen —',
    select_snapshot:'— Snapshot wählen —',
    select_custom:'Eigene Version wählen',
    create_ver_action:'+ Version erstellen',
    or_label:'oder',
    modpack_badge:'Modpack',
    loader_label:'Mod-Loader',
    launching:'Starte...',
    in_game_label:'Im Spiel',
    preparing:'Vorbereiten...',
    downloading:'Herunterladen...',
    select_ver_warn:'Bitte erst eine Version wählen!',
    stop_download_title:'Download stoppen?',
    stop_download_desc:'Der Download wird abgebrochen.',
    stop_game_title:'Spiel stoppen?',
    stop_game_desc:'Minecraft erhält ein sauberes Beendigungssignal —<br>deine Welten werden <strong style="color:#c8d0ff">automatisch gespeichert</strong>.',
    stop_btn:'Stoppen',
    delete_btn:'Löschen',
    delete_version_desc:'Alle Welten dieser Version werden <strong style="color:#ff8888">dauerhaft gelöscht</strong>.',
    delete_folder_desc:'Der Ordner und sein Inhalt werden <strong style="color:#ff8888">dauerhaft gelöscht</strong>.',
    delete_file_desc:'Die Datei wird <strong style="color:#ff8888">dauerhaft gelöscht</strong>.',
    getting_label:'Lade...',
    no_files_err:'Keine Dateien',
    opened_label:'Geöffnet →',
    error_label:'Fehler',
    size_mb:'MB',
    size_kb:'KB',
    size_b:'B',
    size_gb:'GB',
    size_mb_label:'MB',
    npm_start_warn:'Starte über npm start',
    err_load_versions:'Fehler beim Laden der Versionen',
    opening_browser:'Browser öffnen...',
    login_elyby:'Mit Ely.by anmelden',
    opening_login:'Anmeldefenster öffnen...',
    auth_error:'Authentifizierungsfehler',
    login_ms:'Mit Microsoft anmelden',
    local_enter_nick:'Benutzernamen eingeben',
    local_min_chars:'Mindestens 3 Zeichen',
    dir_not_found:'Ordner nicht gefunden',
    dir_not_dir:'Pfad ist kein Ordner',
    dir_no_access:'Kein Zugriff auf diesen Ordner',
    dir_check_fail:'Pfad konnte nicht überprüft werden',
  
    edit_title:'Bearbeiten',
    log_title:'Protokoll',
    log_empty:'Protokoll ist leer...',
    ac_no_accounts:'Keine Konten.<br>Über den Tab «+ Hinzufügen» hinzufügen',
    ac_logged_via:'Angemeldet über',
    ver_filter_hint_fmt:'Nur vom Mod unterstützte Versionen werden angezeigt',
  
    tab_datapack_sub:'Mods für Vanilla Minecraft, kein Mod-Loader nötig',
    mod_no_support:'Mod unterstützt nicht',
    mp_toggle:'Ein-/Ausklappen',
    mp_cant_delete_running:'Kann nicht löschen — Modpack wird gerade ausgeführt',
    mp_open_folder:'Modpack-Ordner öffnen',
    ac_type_local:'Offline',
  
    this_version:'diese Version',
    this_modpack:'dieses Modpack',
    delete_mp_desc:'Alle Modpack-Dateien werden <strong style="color:#ff8888">dauerhaft gelöscht</strong>.',
    compat_versions:'unterstützte Versionen',
    compat_loaders:'unterstützte Loader',
    incompatible_label:'Inkompatibel',
  
    env_required:'Erforderlich',
    env_optional:'Optional',
    env_unsupported:'Nicht unterstützt',
  
    mods_count:'Mods',
    vanilla_no_mods:'Nicht für Vanilla — nur Datenpakete',
  
    splash_greeting:'Willkommen',
    splash_hi:'Hey, ',
    ac_title:'Konto',
    ac_tab_accounts:'Konten',
    ac_tab_add:'+ Hinzufügen',
    ac_available:'Verfügbare Konten',
    ac_add_account:'Konto hinzufügen',
    ac_elyby_sub:'Browser-Anmeldung',
    ac_ms_sub:'Lizenziertes Minecraft-Konto',
    ac_local_sub:'Ohne Authentifizierung',
    ac_elyby_hint:'Ein Browser öffnet sich zur Anmeldung',
    ac_ms_hint:'Ein Microsoft-Anmeldefenster öffnet sich',
    ac_offline_warn:'⚠ Kann Probleme auf Online-Servern verursachen',
    ac_nickname:'Benutzername',
    play_offline:'Offline spielen',
    log_empty:'Protokoll ist leer...',
    ver_save_name:'✓ Name speichern',
    ver_delete:'🗑 Version löschen',
    modal_create_ver_title:'Eigene Version erstellen',
    modal_name_ph:'z.B.: Überleben mit Fabric',
    search_btn:'Suchen',
    enter_query:'Suchanfrage eingeben',
    src_all:'Alle',
    ac_type_local:'Offline',

    soc_friends:'Freunde', soc_pending:'Anfragen', soc_account:'Konto',
    soc_online:'Online', soc_offline:'Offline', soc_connect:'Beitreten',
    soc_remove_friend:'Freund entfernen', soc_block:'Blockieren', soc_report:'Melden',
    soc_no_friends:'Noch keine Freunde.', soc_add_hint:'Hinzufügen per @username oder ID',
    soc_no_pending:'Keine eingehenden Anfragen',
    soc_new_nick:'Neuer Benutzername', soc_display_name:'Anzeigename',
    soc_linked:'Verknüpft', soc_not_linked:'Nicht verknüpft',
    soc_unlink:'Trennen', soc_link:'Verknüpfen',
    soc_link_ms:'Mit Microsoft anmelden', soc_link_ely:'Mit Ely.by anmelden',
    soc_new_pass:'Neues Passwort (mind. 6 Zeichen)', soc_repeat_pass:'Passwort wiederholen',
    soc_connecting:'⚡ Verbinde mit',
    soc_report_desc:'Problem beschreiben (optional)...', soc_sending:'Senden...',
    soc_report_sent:'Meldung gesendet', soc_send:'Senden',
    soc_fill_fields:'Alle Felder ausfüllen',
    soc_login:'Anmelden', soc_wait:'⏳ Bitte warten...',
    soc_login_via:'Anmelden via', soc_reg_via:'Registrieren via',
    soc_no_accounts:'Keine Konten', soc_login_mc:'. Melde dich bei einem Minecraft-Konto an.',
    soc_choose_acc:'Konto wählen', soc_select:'Wählen', soc_cancel:'Abbrechen',
    soc_nick_len:'Benutzername: 1–64 Zeichen', soc_pass_min:'Passwort mind. 6 Zeichen',
    soc_pass_mismatch:'Passwörter stimmen nicht überein',
    soc_enter_nick:'Neuen Benutzernamen eingeben', soc_nick_long:'Benutzername max. 64 Zeichen',
    soc_server_err:'Serverfehler: keine Benutzerdaten',
    soc_nick_changed:'Benutzername geändert zu', soc_enter_dname:'Anzeigenamen eingeben',
    soc_dname_long:'Max. 32 Zeichen', soc_server_err2:'Serverfehler',
    soc_dname_changed:'Name geändert zu', soc_enter_pass:'Neues Passwort eingeben',
    soc_pass_set:'Passwort erfolgreich gesetzt!', soc_no_active:'Kein aktives Konto',
    soc_acc_linked:'} erfolgreich verknüpft!',
    soc_msg_placeholder:'Nachricht...', soc_change_avatar:'Avatar ändern',
    soc_your_id:'Deine ID (Klicken zum Kopieren)', soc_id_copied:'ID: kopiert!',
    soc_no_mc:'Kein aktives Minecraft-Konto', soc_skin_fail:'Skin konnte nicht geladen werden',
    soc_err:'Fehler:', soc_block_user:'Blockieren @', soc_search_nick:'Nach Benutzername suchen...',
    soc_use_skin:'Minecraft-Skin verwenden', soc_reset_avatar:'Avatar zurücksetzen',
    soc_upload_photo:'Foto hochladen', soc_mc_skin:'Minecraft-Skin',
    soc_login_ms:'Mit Microsoft anmelden', soc_login_ely:'Mit Ely.by anmelden',
    soc_register:'Registrieren', soc_reg_short:'Registrierung',
    soc_nick_ph:'Benutzername', soc_pass_ph:'Passwort',
    soc_nick_ph2:'Benutzername (bis 64 Zeichen)', soc_dname_ph:'Anzeigename (optional)',
    soc_pass_ph2:'Passwort (mind. 6 Zeichen)',
    soc_logout_title:'Abmelden?', soc_logout_desc:'Du meldest dich von MidLauncher Social ab.<br>Freunde sehen dich offline.',
    soc_logout:'Abmelden',
    soc_delete_title:'Konto löschen?', soc_delete_err:'Löschfehler',
    soc_delete_desc:'>unwiderruflich</b>.<br>Alle Daten, Freunde und Nachrichten werden gelöscht.', soc_delete_full:'Diese Aktion ist <b style="color:#cc4444;">unwiderruflich</b>.<br>Alle Daten, Freunde und Nachrichten werden gelöscht.',
    soc_delete_confirm:'Dauerhaft löschen',
    soc_confirm_pass:'Passwort zur Bestätigung eingeben', soc_confirm:'Bestätigen',
    soc_enter_pass2:'Passwort eingeben',
    soc_no_acc_service:'Zuerst im {service}-Konto im Bereich „Konten" anmelden',
    adm_panel:'Admin-Panel', adm_users:'Benutzer', adm_reports:'Meldungen', adm_stats:'Statistik',
    adm_loading:'Laden...', adm_no_users:'Keine Benutzer', adm_no_reports:'Keine Meldungen',
    adm_copy_id:'ID kopieren', adm_view:'Ansehen', adm_change_id:'ID ändern',
    adm_revoke:'Entziehen', adm_grant:'Admin', adm_unban:'Entsperren', adm_ban:'Sperren',
    adm_delete:'Löschen', adm_ban_title:'Sperren @', adm_ban_desc:'Benutzer kann sich nicht mehr anmelden.',
    adm_unban_title:'Entsperren @', adm_unban_desc:'Benutzer kann sich wieder anmelden.',
    adm_delete_title:'Löschen @', adm_delete_desc:'Konto wird dauerhaft gelöscht.',
    adm_change_id_title:'ID ändern für @',
    adm_change_id_desc:'Neue ID eingeben (beliebige Zeichen). Achtung — ändert den Primärschlüssel.',
    adm_change_id_btn:'Ändern', adm_change_id_err:'ID-Änderungsfehler:',
    adm_grant_title:'@ zum Administrator machen?', adm_grant_admin:'Administrator?',
    adm_grant_desc:'Benutzer erhält Zugang zum Admin-Panel.', adm_grant_btn:'Admin machen',
    adm_revoke_title:'Admin-Rechte entziehen von @',
    adm_revoke_desc:'Benutzer verliert Zugang zum Admin-Panel.',
    adm_copy:'Kopieren', adm_close:'Schließen',
    adm_stat_users:'👥 Benutzer', adm_stat_friends:'🤝 Freundschaften',
    adm_stat_msgs:'💬 Nachrichten', adm_stat_online:'🟢 Online',
    adm_banned:'[GESPERRT]', adm_revoke_admin:'Admin entziehen', adm_grant_admin_btn:'Admin vergeben',
    adm_spam:'Spam', adm_abuse:'Beleidigung', adm_cheat:'Cheating', adm_other:'Sonstiges',
    game_started:'Spiel gestartet!', game_closed:'Spiel beendet',
    game_running:'⚠ Spiel läuft bereits', game_in:'● Im Spiel',
    sel_mc_ver:'MC-Version wählen', sel_mc_ver2:'Minecraft-Version wählen',
    rename:'Umbenennen',
    dl_fail:'⚠ Konnte «', dl_no_slug:'» nicht herunterladen: kein Slug',
    dl_ing:'⬇ Lade herunter', dl_done:'heruntergeladen', dl_err:'✗ Download-Fehler',
    dl_vers:'⬇ Versionen abrufen für «', dl_ver_err:'✗ getModVersions-Fehler für «',
    dl_no_vers:'⚠ Keine Versionen für «', dl_no_file:'⚠ Keine Datei in Version «',
    dl_saved:'gespeichert in', launch_err:'Startfehler:',
    cant_delete_mp:'Kann nicht löschen — Modpack läuft',
    downloaded:'✓ Heruntergeladen', err_short:'Fehler',
    dl_m:'M Dls', dl_k:'K Dls', dl_n:'Dls',
    importing:'Importieren...', loading_mods:'Mods laden...', loading_short:'Laden...',
    added_mods:'✓ Hinzugefügt ({n} Mods)',
    dl_modpack:'↓ Modpack herunterladen', add_modpack:'+ Zum Modpack',
    platforms:'Plattformen', categories:'Kategorien', mc_versions2:'Minecraft-Versionen',
    no_versions:'Keine Versionen verfügbar', add_modpack2:'+ Modpack',
    gallery_empty:'Galerie leer', no_data:'Keine Daten', changelog_na:'Changelog nicht verfügbar',
    updated:'Aktualisiert', incompat_loader:'✗ Inkompatibler Loader — unterstützt:',
    incompat_loader2:'Inkompatibler Mod-Loader', add_mod_to_mp:'„{name}" zum Modpack hinzufügen',
    cat_adventure:'Abenteuer', cat_combat:'Kampf', cat_decoration:'Dekoration',
    cat_economy:'Wirtschaft', cat_equipment:'Ausrüstung', cat_food:'Essen',
    cat_game_mechanics:'Spielmechanik', cat_library:'Bibliothek', cat_magic:'Magie',
    cat_management:'Verwaltung', cat_minigame:'Minispiel', cat_mobs:'Mobs',
    cat_optimization:'Optimierung', cat_social:'Soziales', cat_storage:'Lagerung',
    cat_technology:'Technologie', cat_transport:'Transport', cat_utility:'Hilfsprogramme',
    cat_worldgen:'Weltgenerierung', cat_biome:'Biome', cat_structure:'Strukturen',
    cat_dimension:'Dimensionen', cat_cursed:'Verflucht', cat_quests:'Quests',
    cat_building:'Bauen', cat_misc:'Verschiedenes',
    sh_atmosphere:'Atmosphäre', sh_bloom:'Bloom', sh_cartoon:'Cartoon',
    sh_colored_light:'Farbiges Licht', sh_fantasy:'Fantasy', sh_foliage:'Laub',
    sh_high:'Hohe Qualität', sh_low:'Niedrige Qualität', sh_medium:'Mittlere Qualität',
    sh_path_tracing:'Pfadverfolgung', sh_realism:'Realismus', sh_reflections:'Reflexionen',
    sh_semi_realism:'Semi-Realismus', sh_shadows:'Schatten', sh_vanilla:'Vanilla-Stil',
    sh_hardcore:'Hardcore', sh_potato:'Potato',
    mp_multiplayer:'Mehrspieler', mp_singleplayer:'Einzelspieler',
    env_both:'Client und Server', env_client_only:'Nur Client', env_server_only:'Nur Server',
    env_client_optional:'Client (+ opt. Server)', env_server_optional:'Server (+ opt. Client)',
    env_both_optional:'Client und Server (opt.)',
    bg_label:'Hintergrund', theme_label:'Thema', theme_light:'Hell', theme_dark:'Dunkel', bg_animated:'Animierter Hintergrund', bg_static:'Statischer Hintergrund',
    reset_btn:'✕ Zurücksetzen',
  },
  fr: {
    nav_launcher:'Launcher', nav_mods:'Mods', nav_files:'Fichiers', nav_settings:'Paramètres', nav_friends:'Amis',
    play:'Jouer', stop:'Arrêter', cancel:'Annuler',
    loading:'Chargement...', search:'Rechercher...', search_mods:'Rechercher des mods...',
    my_modpacks:'Mes Modpacks', tab_mod:'Mods', tab_resourcepack:'Packs de ressources',
    tab_shader:'Shaders', tab_modpack:'Modpacks', tab_datapack:'Datapacks',
    sort_by:'Tri:', sort_popular:'Par popularité', sort_newest:'Plus récents', sort_relevance:'Par pertinence',
    settings_save:'Enregistrer', settings_reset:'Réinitialiser', settings_saved:'✓ Paramètres sauvegardés',
    settings_tab_mc:'Minecraft', settings_tab_launcher:'Launcher',
    settings_gamedir:'Dossier du jeu', settings_gamedir_hint:'Dossier pour versions,<br>mods, mondes et plus',
    settings_gamedir_ph:'Par défaut: dossier launcher/minecraft',
    settings_browse:'Parcourir...', settings_java:'Java / JRE', settings_ram:'Mémoire RAM',
    settings_ram_auto:'Auto', settings_ram_warn:'⚠ Allouer 24+ Go peut causer des problèmes',
    settings_winsize:'Taille de fenêtre', settings_winsize_px:'px',
    settings_console:'Console', settings_console_hint:'Afficher CMD au lancement',
    settings_console_label:'Activer la console au lancement',
    settings_onlaunch:'Au lancement du jeu', settings_lang:'Langue',
    java_recommended:'Recommandé', java_current:'Actuel', java_custom:'Personnalisé',
    java_details:'••• Détails',
    hide_hide:'Masquer le launcher', hide_close:'Fermer le launcher', hide_keep:'Garder le launcher ouvert',
    mp_create:'+ Créer', mp_add_mods:'+ Ajouter des mods', mp_play:'▶ Jouer', mp_mods_in:'Mods dans le pack',
    mp_empty:'<h3>Aucun modpack</h3><p>Cliquez «+ Créer» pour ajouter votre premier modpack</p>',
    mp_new_title:'Nouveau modpack', mp_new_name:'Nom', mp_new_name_ph:'Modpack Zombie',
    mp_new_version:'Version Minecraft', mp_new_loader:'Mod loader', mp_new_loader_ver:'Version du loader',
    mp_new_confirm:'Créer', mp_best_ver:'Utiliser la meilleure version',
    mp_snap_note:'* mod loaders indisponibles pour les snapshots',
    mp_add_title:'Ajouter des mods', mp_create_add:'+ Créer un nouveau modpack et ajouter',
    filter_version:'Version du jeu', filter_loader:'Loader', filter_category:'Catégorie', filter_env:'Environnement',
    env_client:'Client', env_server:'Serveur',
    ver_select:'— choisir une version —', ver_no_compat:'— aucune version compatible —',
    ver_filter_hint:'🔒 Versions supportées par le mod uniquement',
    add_to_mp:'+ Au modpack', open_mr:'Ouvrir sur Modrinth ↗', download:'↓ Télécharger',
    add_btn:'+ Ajouter', added:'✓ Ajouté', incompatible_loader:'✗ Incompatible',
    no_compat_ver:'Aucun modpack avec une version de jeu compatible.',
    create_version:'+ Créer une version personnalisée', version_mc:'Version Minecraft',
    loader_ver:'Version du loader', loader_first:"Choisissez d'abord la version du jeu", loader_unavail:'Aucune version disponible',
    platforms:'Plateformes', categories:'Catégories', mc_versions:'Versions Minecraft', description:'Description',
    versions:'Versions', gallery:'Galerie', changelog:'Changelog',
    sort_loader:'Loader', sort_mc:'Minecraft',
    modpack_download:'↓ Télécharger le modpack', modpack_add_mine:'+ Ajouter à mes modpacks',
    no_mods:'Aucun mod trouvé', no_mods_sub:'Essayez de changer votre requête ou les filtres',
    load_more:'Charger plus',
    picker_no_mp:'Aucun modpack. Créez-en un dans la section «Modpacks»',
  
    dd_empty:'Rien trouvé',
    fb_up_title:'Niveau supérieur',
    fb_add_file_title:'Ajouter des fichiers',
    fb_add_file:'+ Fichier',
    fb_open_folder_title:"Ouvrir dans l'explorateur",
    fb_folder_label:'Dossier',
    fb_refresh_title:'Actualiser',
    fb_drop_label:'Déposez des fichiers ici',
    fb_drop_into:'Déposer dans',
    fb_open:'Ouvrir',
    fb_show_explorer:"Afficher dans l'explorateur",
    fb_delete:'Supprimer',
    fb_empty_dir:'Dossier vide',
    fb_preload_err:'Mettez à jour preload.js — API introuvable',
    fb_no_response:'pas de réponse de main.js',
    fb_folders:'dossiers',
    fb_files:'fichiers',
    fb_copying:'Copie',
    fb_added:'Ajouté',
    fb_files_suffix:'fichier(s)',
    gc_default:'Par défaut (CMS ou G1 GC) — recommandé',
    gc_off:'Désactivé (non recommandé)',
    gc_cms:'Utiliser CMS GC',
    gc_g1gc:'Utiliser G1 GC',
    gc_shenandoah:'Utiliser Shenandoah GC',
    gc_zgc:'Utiliser ZGC',
    java_path_label:'Chemin Java',
    java_args_label:'Arguments Java',
    java_opt_args_label:'Arguments optimisés',
    java_mc_args_label:'Arguments Minecraft',
    java_wrap_cmd_label:'Commande wrapper',
    java_show_advanced:'Options avancées',
    java_apply:'Appliquer',
    java_rec_desc:'Installe automatiquement la version Java requise',
    java_cur_desc:'Java supportant ce launcher',
    java_cur_warn:'(certaines versions peuvent ne pas démarrer!)',
    java_cust_desc:'Indiquer le chemin vers java.exe manuellement',
    ver_release:'Release',
    ver_snapshot:'Snapshot',
    recent_versions:'Dernières versions Minecraft',
    releases_label:'Releases',
    snapshots_label:'Snapshots',
    select_release:'— choisir release —',
    select_snapshot:'— choisir snapshot —',
    select_custom:'Choisir version personnalisée',
    create_ver_action:'+ Créer version',
    or_label:'ou',
    modpack_badge:'modpack',
    loader_label:'Mod Loader',
    launching:'Lancement...',
    in_game_label:'En jeu',
    preparing:'Préparation...',
    downloading:'Téléchargement...',
    select_ver_warn:"Choisissez d'abord une version!",
    stop_download_title:'Arrêter le téléchargement?',
    stop_download_desc:'Le téléchargement sera interrompu.',
    stop_game_title:'Arrêter le jeu?',
    stop_game_desc:'Minecraft recevra un signal d\'arrêt —<br>vos mondes seront <strong style="color:#c8d0ff">sauvegardés automatiquement</strong>.',
    stop_btn:'Arrêter',
    delete_btn:'Supprimer',
    delete_version_desc:'Tous les mondes seront <strong style="color:#ff8888">définitivement supprimés</strong>.',
    delete_folder_desc:'Le dossier sera <strong style="color:#ff8888">définitivement supprimé</strong>.',
    delete_file_desc:'Le fichier sera <strong style="color:#ff8888">définitivement supprimé</strong>.',
    getting_label:'Récupération...',
    no_files_err:'Aucun fichier',
    opened_label:'Ouvert →',
    error_label:'Erreur',
    size_mb:'Mo',
    size_kb:'Ko',
    size_b:'o',
    size_gb:'Go',
    size_mb_label:'Mo',
    npm_start_warn:'Lancer via npm start',
    err_load_versions:'Erreur chargement versions',
    opening_browser:'Ouverture du navigateur...',
    login_elyby:'Se connecter via Ely.by',
    opening_login:'Ouverture de la fenêtre...',
    auth_error:"Erreur d'authentification",
    login_ms:'Se connecter via Microsoft',
    local_enter_nick:'Entrez un pseudo',
    local_min_chars:'Minimum 3 caractères',
    dir_not_found:'Dossier introuvable',
    dir_not_dir:"Ce chemin n'est pas un dossier",
    dir_no_access:'Accès refusé',
    dir_check_fail:'Impossible de vérifier le chemin',
  
    edit_title:'Modifier',
    log_title:'Journal',
    log_empty:'Journal vide...',
    ac_no_accounts:"Aucun compte.<br>Ajoutez-en un via l'onglet «+ Ajouter»",
    ac_logged_via:'Connecté via',
    ver_filter_hint_fmt:'Seules les versions supportées par le mod sont affichées',
  
    tab_datapack_sub:'Mods pour Minecraft vanilla, sans mod loader',
    mod_no_support:'Le mod ne supporte pas',
    mp_toggle:'Réduire/Développer',
    mp_cant_delete_running:"Impossible de supprimer — le modpack est en cours d'exécution",
    mp_open_folder:'Ouvrir le dossier du modpack',
    ac_type_local:'Hors ligne',
  
    this_version:'cette version',
    this_modpack:'ce modpack',
    delete_mp_desc:'Tous les fichiers du modpack seront <strong style="color:#ff8888">définitivement supprimés</strong>.',
    compat_versions:'versions supportées',
    compat_loaders:'loaders supportés',
    incompatible_label:'Incompatible',
  
    env_required:'Requis',
    env_optional:'Optionnel',
    env_unsupported:'Non supporté',
  
    mods_count:'mods',
    vanilla_no_mods:'Non disponible pour Vanilla — datapacks uniquement',
  
    splash_greeting:'Bienvenue',
    splash_hi:'Salut, ',
    ac_title:'Compte',
    ac_tab_accounts:'Comptes',
    ac_tab_add:'+ Ajouter',
    ac_available:'Comptes disponibles',
    ac_add_account:'Ajouter un compte',
    ac_elyby_sub:'Connexion via navigateur',
    ac_ms_sub:'Compte Minecraft sous licence',
    ac_local_sub:'Sans authentification',
    ac_elyby_hint:"Un navigateur s'ouvrira pour la connexion",
    ac_ms_hint:"Une fenêtre Microsoft s'ouvrira",
    ac_offline_warn:'⚠ Peut causer des problèmes sur les serveurs',
    ac_nickname:'Pseudo',
    play_offline:'Jouer hors ligne',
    log_empty:'Journal vide...',
    ver_save_name:'✓ Sauvegarder le nom',
    ver_delete:'🗑 Supprimer la version',
    modal_create_ver_title:'Créer une version personnalisée',
    modal_name_ph:'Ex: Survie avec Fabric',
    search_btn:'Rechercher',
    enter_query:'Entrez une requête pour rechercher',
    src_all:'Tous',
    ac_type_local:'Hors ligne',

    soc_friends:'Amis', soc_pending:'Demandes', soc_account:'Compte',
    soc_online:'En ligne', soc_offline:'Hors ligne', soc_connect:'Rejoindre',
    soc_remove_friend:'Supprimer ami', soc_block:'Bloquer', soc_report:'Signaler',
    soc_no_friends:'Pas encore d\'amis.', soc_add_hint:'Ajouter par @username ou ID',
    soc_no_pending:'Aucune demande entrante',
    soc_new_nick:'Nouveau pseudo', soc_display_name:'Nom d\'affichage',
    soc_linked:'Lié', soc_not_linked:'Non lié',
    soc_unlink:'Délier', soc_link:'Lier',
    soc_link_ms:'Se connecter via Microsoft', soc_link_ely:'Se connecter via Ely.by',
    soc_new_pass:'Nouveau mot de passe (min. 6 car.)', soc_repeat_pass:'Répéter le mot de passe',
    soc_connecting:'⚡ Connexion à',
    soc_report_desc:'Décrire le problème (optionnel)...', soc_sending:'Envoi...',
    soc_report_sent:'Signalement envoyé', soc_send:'Envoyer',
    soc_fill_fields:'Remplir tous les champs',
    soc_login:'Se connecter', soc_wait:'⏳ Veuillez patienter...',
    soc_login_via:'Se connecter via', soc_reg_via:'S\'inscrire via',
    soc_no_accounts:'Aucun compte', soc_login_mc:'. Connectez-vous à un compte Minecraft.',
    soc_choose_acc:'Choisir un compte', soc_select:'Sélectionner', soc_cancel:'Annuler',
    soc_nick_len:'Pseudo : 1–64 caractères', soc_pass_min:'Mot de passe min. 6 caractères',
    soc_pass_mismatch:'Les mots de passe ne correspondent pas',
    soc_enter_nick:'Entrer un nouveau pseudo', soc_nick_long:'Pseudo max. 64 caractères',
    soc_server_err:'Erreur serveur : pas de données utilisateur',
    soc_nick_changed:'Pseudo changé en', soc_enter_dname:'Entrer le nom d\'affichage',
    soc_dname_long:'Max. 32 caractères', soc_server_err2:'Erreur serveur',
    soc_dname_changed:'Nom changé en', soc_enter_pass:'Entrer un nouveau mot de passe',
    soc_pass_set:'Mot de passe défini avec succès !', soc_no_active:'Aucun compte actif',
    soc_acc_linked:'} lié avec succès !',
    soc_msg_placeholder:'Message...', soc_change_avatar:'Changer l\'avatar',
    soc_your_id:'Votre ID (cliquer pour copier)', soc_id_copied:'ID : copié !',
    soc_no_mc:'Aucun compte Minecraft actif', soc_skin_fail:'Impossible de charger le skin',
    soc_err:'Erreur :', soc_block_user:'Bloquer @', soc_search_nick:'Rechercher par pseudo...',
    soc_use_skin:'Utiliser le skin Minecraft', soc_reset_avatar:'Réinitialiser l\'avatar',
    soc_upload_photo:'Télécharger une photo', soc_mc_skin:'Skin Minecraft',
    soc_login_ms:'Se connecter via Microsoft', soc_login_ely:'Se connecter via Ely.by',
    soc_register:'S\'inscrire', soc_reg_short:'Inscription',
    soc_nick_ph:'Pseudo', soc_pass_ph:'Mot de passe',
    soc_nick_ph2:'Pseudo (jusqu\'à 64 car.)', soc_dname_ph:'Nom d\'affichage (optionnel)',
    soc_pass_ph2:'Mot de passe (min. 6 car.)',
    soc_logout_title:'Se déconnecter ?', soc_logout_desc:'Vous serez déconnecté de MidLauncher Social.<br>Les amis vous verront hors ligne.',
    soc_logout:'Se déconnecter',
    soc_delete_title:'Supprimer le compte ?', soc_delete_err:'Erreur de suppression',
    soc_delete_desc:'>irréversible</b>.<br>Toutes les données, amis et messages seront supprimés.', soc_delete_full:'Cette action est <b style="color:#cc4444;">irréversible</b>.<br>Toutes les données, amis et messages seront supprimés.',
    soc_delete_confirm:'Supprimer définitivement',
    soc_confirm_pass:'Entrer le mot de passe pour confirmer', soc_confirm:'Confirmer',
    soc_enter_pass2:'Entrer le mot de passe',
    soc_no_acc_service:'Connectez-vous d\'abord à votre compte {service} dans la section «Comptes»',
    adm_panel:'Panneau admin', adm_users:'Utilisateurs', adm_reports:'Signalements', adm_stats:'Statistiques',
    adm_loading:'Chargement...', adm_no_users:'Aucun utilisateur', adm_no_reports:'Aucun signalement',
    adm_copy_id:'Copier ID', adm_view:'Voir', adm_change_id:'Changer ID',
    adm_revoke:'Retirer', adm_grant:'Admin', adm_unban:'Débannir', adm_ban:'Bannir',
    adm_delete:'Supprimer', adm_ban_title:'Bannir @', adm_ban_desc:'L\'utilisateur ne pourra plus se connecter.',
    adm_unban_title:'Débannir @', adm_unban_desc:'L\'utilisateur pourra à nouveau se connecter.',
    adm_delete_title:'Supprimer @', adm_delete_desc:'Le compte sera supprimé définitivement.',
    adm_change_id_title:'Changer l\'ID de @',
    adm_change_id_desc:'Entrer un nouvel ID (tous caractères). Attention — modifie l\'identifiant principal.',
    adm_change_id_btn:'Changer', adm_change_id_err:'Erreur changement ID :',
    adm_grant_title:'Faire @ administrateur ?', adm_grant_admin:'administrateur ?',
    adm_grant_desc:'L\'utilisateur aura accès au panneau admin.', adm_grant_btn:'Rendre admin',
    adm_revoke_title:'Retirer les droits admin de @',
    adm_revoke_desc:'L\'utilisateur perdra l\'accès au panneau admin.',
    adm_copy:'Copier', adm_close:'Fermer',
    adm_stat_users:'👥 Utilisateurs', adm_stat_friends:'🤝 Amitiés',
    adm_stat_msgs:'💬 Messages', adm_stat_online:'🟢 En ligne',
    adm_banned:'[BANNI]', adm_revoke_admin:'Retirer admin', adm_grant_admin_btn:'Accorder admin',
    adm_spam:'Spam', adm_abuse:'Abus', adm_cheat:'Triche', adm_other:'Autre',
    game_started:'Jeu démarré !', game_closed:'Jeu fermé',
    game_running:'⚠ Jeu déjà en cours', game_in:'● En jeu',
    sel_mc_ver:'Choisir version MC', sel_mc_ver2:'Choisir version Minecraft',
    rename:'Renommer',
    dl_fail:'⚠ Impossible de télécharger «', dl_no_slug:'» : pas de slug',
    dl_ing:'⬇ Téléchargement', dl_done:'téléchargé', dl_err:'✗ Erreur téléchargement',
    dl_vers:'⬇ Récupération versions pour «', dl_ver_err:'✗ Erreur getModVersions pour «',
    dl_no_vers:'⚠ Pas de versions pour «', dl_no_file:'⚠ Pas de fichier dans la version «',
    dl_saved:'enregistré dans', launch_err:'Erreur de lancement :',
    cant_delete_mp:'Impossible de supprimer — modpack en cours',
    downloaded:'✓ Téléchargé', err_short:'Erreur',
    dl_m:'M téléch.', dl_k:'K téléch.', dl_n:'téléch.',
    importing:'Import...', loading_mods:'Chargement mods...', loading_short:'Chargement...',
    added_mods:'✓ Ajouté ({n} mods)',
    dl_modpack:'↓ Télécharger modpack', add_modpack:'+ Au modpack',
    platforms:'Plateformes', categories:'Catégories', mc_versions2:'Versions Minecraft',
    no_versions:'Aucune version disponible', add_modpack2:'+ Modpack',
    gallery_empty:'Galerie vide', no_data:'Aucune donnée', changelog_na:'Journal des modifications indisponible',
    updated:'Mis à jour', incompat_loader:'✗ Loader incompatible — pris en charge :',
    incompat_loader2:'Mod loader incompatible', add_mod_to_mp:'Ajouter «{name}» au modpack',
    cat_adventure:'Aventure', cat_combat:'Combat', cat_decoration:'Décoration',
    cat_economy:'Économie', cat_equipment:'Équipement', cat_food:'Nourriture',
    cat_game_mechanics:'Mécaniques de jeu', cat_library:'Bibliothèque', cat_magic:'Magie',
    cat_management:'Gestion', cat_minigame:'Mini-jeu', cat_mobs:'Mobs',
    cat_optimization:'Optimisation', cat_social:'Social', cat_storage:'Stockage',
    cat_technology:'Technologie', cat_transport:'Transport', cat_utility:'Utilitaires',
    cat_worldgen:'Génération du monde', cat_biome:'Biomes', cat_structure:'Structures',
    cat_dimension:'Dimensions', cat_cursed:'Maudit', cat_quests:'Quêtes',
    cat_building:'Construction', cat_misc:'Divers',
    sh_atmosphere:'Atmosphère', sh_bloom:'Bloom', sh_cartoon:'Cartoon',
    sh_colored_light:'Lumière colorée', sh_fantasy:'Fantaisie', sh_foliage:'Feuillage',
    sh_high:'Haute qualité', sh_low:'Basse qualité', sh_medium:'Qualité moyenne',
    sh_path_tracing:'Ray tracing', sh_realism:'Réalisme', sh_reflections:'Réflexions',
    sh_semi_realism:'Semi-réalisme', sh_shadows:'Ombres', sh_vanilla:'Style vanilla',
    sh_hardcore:'Hardcore', sh_potato:'Potato',
    mp_multiplayer:'Multijoueur', mp_singleplayer:'Solo',
    env_both:'Client et serveur', env_client_only:'Client seulement', env_server_only:'Serveur seulement',
    env_client_optional:'Client (+ opt. serveur)', env_server_optional:'Serveur (+ opt. client)',
    env_both_optional:'Client et serveur (opt.)',
    bg_label:'Fond', theme_label:'Thème', theme_light:'Clair', theme_dark:'Sombre', bg_animated:'Fond animé', bg_static:'Fond statique',
    reset_btn:'✕ Réinitialiser',
  },
  es: {
    nav_launcher:'Launcher', nav_mods:'Mods', nav_files:'Archivos', nav_settings:'Ajustes', nav_friends:'Amigos',
    play:'Jugar', stop:'Detener', cancel:'Cancelar',
    loading:'Cargando...', search:'Buscar...', search_mods:'Buscar mods...',
    my_modpacks:'Mis Modpacks', tab_mod:'Mods', tab_resourcepack:'Paquetes de recursos',
    tab_shader:'Shaders', tab_modpack:'Modpacks', tab_datapack:'Datapacks',
    sort_by:'Orden:', sort_popular:'Por popularidad', sort_newest:'Más recientes', sort_relevance:'Por relevancia',
    settings_save:'Guardar', settings_reset:'Restablecer', settings_saved:'✓ Ajustes guardados',
    settings_tab_mc:'Minecraft', settings_tab_launcher:'Launcher',
    settings_gamedir:'Carpeta del juego', settings_gamedir_hint:'Carpeta para versiones,<br>mods, mundos y más',
    settings_gamedir_ph:'Por defecto: carpeta launcher/minecraft',
    settings_browse:'Examinar...', settings_java:'Java / JRE', settings_ram:'Memoria RAM',
    settings_ram_auto:'Auto', settings_ram_warn:'⚠ Asignar 24+ GB puede causar problemas',
    settings_winsize:'Tamaño ventana', settings_winsize_px:'px',
    settings_console:'Consola', settings_console_hint:'Mostrar CMD al iniciar',
    settings_console_label:'Activar consola al iniciar',
    settings_onlaunch:'Al iniciar el juego', settings_lang:'Idioma',
    java_recommended:'Recomendado', java_current:'Actual', java_custom:'Personalizado',
    java_details:'••• Detalles',
    hide_hide:'Ocultar launcher', hide_close:'Cerrar launcher', hide_keep:'Mantener launcher abierto',
    mp_create:'+ Crear', mp_add_mods:'+ Añadir mods', mp_play:'▶ Jugar', mp_mods_in:'Mods en el pack',
    mp_empty:'<h3>Sin modpacks</h3><p>Haz clic en «+ Crear» para añadir tu primer modpack</p>',
    mp_new_title:'Nuevo modpack', mp_new_name:'Nombre', mp_new_name_ph:'Modpack Zombie',
    mp_new_version:'Versión Minecraft', mp_new_loader:'Mod loader', mp_new_loader_ver:'Versión del loader',
    mp_new_confirm:'Crear', mp_best_ver:'Usar la mejor versión',
    mp_snap_note:'* mod loaders no disponibles en snapshots',
    mp_add_title:'Añadir mods', mp_create_add:'+ Crear nuevo modpack y añadir',
    filter_version:'Versión del juego', filter_loader:'Loader', filter_category:'Categoría', filter_env:'Entorno',
    env_client:'Cliente', env_server:'Servidor',
    ver_select:'— seleccionar versión —', ver_no_compat:'— sin versiones compatibles —',
    ver_filter_hint:'🔒 Solo versiones compatibles con el mod',
    add_to_mp:'+ Al modpack', open_mr:'Abrir en Modrinth ↗', download:'↓ Descargar',
    add_btn:'+ Añadir', added:'✓ Añadido', incompatible_loader:'✗ Incompatible',
    no_compat_ver:'Sin modpacks con versión de juego compatible.',
    create_version:'+ Crear versión personalizada', version_mc:'Versión Minecraft',
    loader_ver:'Versión loader', loader_first:'Selecciona primero la versión del juego', loader_unavail:'Sin versiones disponibles',
    platforms:'Plataformas', categories:'Categorías', mc_versions:'Versiones Minecraft', description:'Descripción',
    versions:'Versiones', gallery:'Galería', changelog:'Changelog',
    sort_loader:'Loader', sort_mc:'Minecraft',
    modpack_download:'↓ Descargar modpack', modpack_add_mine:'+ Añadir a mis modpacks',
    no_mods:'No se encontraron mods', no_mods_sub:'Intenta cambiar la búsqueda o los filtros',
    load_more:'Cargar más',
    picker_no_mp:'Sin modpacks. Crea uno en la sección «Modpacks»',
  
    dd_empty:'No se encontró nada',
    fb_up_title:'Subir nivel',
    fb_add_file_title:'Añadir archivos',
    fb_add_file:'+ Archivo',
    fb_open_folder_title:'Abrir en explorador',
    fb_folder_label:'Carpeta',
    fb_refresh_title:'Actualizar',
    fb_drop_label:'Suelta archivos aquí',
    fb_drop_into:'Soltar en',
    fb_open:'Abrir',
    fb_show_explorer:'Mostrar en explorador',
    fb_delete:'Eliminar',
    fb_empty_dir:'Carpeta vacía',
    fb_preload_err:'Actualiza preload.js — API no encontrada',
    fb_no_response:'sin respuesta de main.js',
    fb_folders:'carpetas',
    fb_files:'archivos',
    fb_copying:'Copiando',
    fb_added:'Añadido',
    fb_files_suffix:'archivo(s)',
    gc_default:'Por defecto (CMS o G1 GC) — recomendado',
    gc_off:'Desactivado (no recomendado)',
    gc_cms:'Usar CMS GC',
    gc_g1gc:'Usar G1 GC',
    gc_shenandoah:'Usar Shenandoah GC',
    gc_zgc:'Usar ZGC',
    java_path_label:'Ruta Java',
    java_args_label:'Argumentos Java',
    java_opt_args_label:'Argumentos optimizados',
    java_mc_args_label:'Argumentos Minecraft',
    java_wrap_cmd_label:'Comando wrapper',
    java_show_advanced:'Opciones avanzadas',
    java_apply:'Aplicar',
    java_rec_desc:'Instala automáticamente la versión Java necesaria',
    java_cur_desc:'Java que soporta este launcher',
    java_cur_warn:'(¡algunas versiones pueden no iniciar!)',
    java_cust_desc:'Especificar ruta a java.exe manualmente',
    ver_release:'Release',
    ver_snapshot:'Snapshot',
    recent_versions:'Últimas versiones de Minecraft',
    releases_label:'Releases',
    snapshots_label:'Snapshots',
    select_release:'— seleccionar release —',
    select_snapshot:'— seleccionar snapshot —',
    select_custom:'Seleccionar versión personalizada',
    create_ver_action:'+ Crear versión',
    or_label:'o',
    modpack_badge:'modpack',
    loader_label:'Mod Loader',
    launching:'Iniciando...',
    in_game_label:'En juego',
    preparing:'Preparando...',
    downloading:'Descargando...',
    select_ver_warn:'¡Selecciona una versión primero!',
    stop_download_title:'¿Detener descarga?',
    stop_download_desc:'La descarga será interrumpida.',
    stop_game_title:'¿Detener juego?',
    stop_game_desc:'Minecraft recibirá señal de cierre —<br>tus mundos se <strong style="color:#c8d0ff">guardarán automáticamente</strong>.',
    stop_btn:'Detener',
    delete_btn:'Eliminar',
    delete_version_desc:'Los mundos serán <strong style="color:#ff8888">eliminados permanentemente</strong>.',
    delete_folder_desc:'La carpeta será <strong style="color:#ff8888">eliminada permanentemente</strong>.',
    delete_file_desc:'El archivo será <strong style="color:#ff8888">eliminado permanentemente</strong>.',
    getting_label:'Obteniendo...',
    no_files_err:'Sin archivos',
    opened_label:'Abierto →',
    error_label:'Error',
    size_mb:'MB',
    size_kb:'KB',
    size_b:'B',
    size_gb:'GB',
    size_mb_label:'MB',
    npm_start_warn:'Ejecuta con npm start',
    err_load_versions:'Error cargando versiones',
    opening_browser:'Abriendo navegador...',
    login_elyby:'Iniciar sesión con Ely.by',
    opening_login:'Abriendo ventana...',
    auth_error:'Error de autenticación',
    login_ms:'Iniciar sesión con Microsoft',
    local_enter_nick:'Ingresa un nombre de usuario',
    local_min_chars:'Mínimo 3 caracteres',
    dir_not_found:'Carpeta no encontrada',
    dir_not_dir:'La ruta no es una carpeta',
    dir_no_access:'Sin acceso a esta carpeta',
    dir_check_fail:'No se pudo verificar la ruta',
  
    edit_title:'Editar',
    log_title:'Registro',
    log_empty:'Registro vacío...',
    ac_no_accounts:'Sin cuentas.<br>Añade una en la pestaña «+ Añadir»',
    ac_logged_via:'Conectado vía',
    ver_filter_hint_fmt:'Solo versiones compatibles con el mod',
  
    tab_datapack_sub:'Mods para Minecraft vanilla, sin mod loader',
    mod_no_support:'El mod no soporta',
    mp_toggle:'Colapsar/Expandir',
    mp_cant_delete_running:'No se puede eliminar — el modpack está en ejecución',
    mp_open_folder:'Abrir carpeta del modpack',
    ac_type_local:'Sin conexión',
  
    this_version:'esta versión',
    this_modpack:'este modpack',
    delete_mp_desc:'Todos los archivos del modpack serán <strong style="color:#ff8888">eliminados permanentemente</strong>.',
    compat_versions:'versiones compatibles',
    compat_loaders:'loaders compatibles',
    incompatible_label:'Incompatible',
  
    env_required:'Requerido',
    env_optional:'Opcional',
    env_unsupported:'No soportado',
  
    mods_count:'mods',
    vanilla_no_mods:'No disponible para Vanilla — solo datapacks',
  
    splash_greeting:'Bienvenido',
    splash_hi:'¡Hola, ',
    ac_title:'Cuenta',
    ac_tab_accounts:'Cuentas',
    ac_tab_add:'+ Añadir',
    ac_available:'Cuentas disponibles',
    ac_add_account:'Añadir cuenta',
    ac_elyby_sub:'Inicio de sesión via navegador',
    ac_ms_sub:'Cuenta Minecraft con licencia',
    ac_local_sub:'Sin autenticación',
    ac_elyby_hint:'Se abrirá un navegador para iniciar sesión',
    ac_ms_hint:'Se abrirá una ventana de Microsoft',
    ac_offline_warn:'⚠ Puede causar problemas en servidores online',
    ac_nickname:'Nombre de usuario',
    play_offline:'Jugar sin conexión',
    log_empty:'Registro vacío...',
    ver_save_name:'✓ Guardar nombre',
    ver_delete:'🗑 Eliminar versión',
    modal_create_ver_title:'Crear versión personalizada',
    modal_name_ph:'Ej: Supervivencia con Fabric',
    search_btn:'Buscar',
    enter_query:'Ingresa una consulta para buscar',
    src_all:'Todos',
    ac_type_local:'Sin conexión',

    soc_friends:'Amigos', soc_pending:'Solicitudes', soc_account:'Cuenta',
    soc_online:'En línea', soc_offline:'Desconectado', soc_connect:'Unirse',
    soc_remove_friend:'Eliminar amigo', soc_block:'Bloquear', soc_report:'Reportar',
    soc_no_friends:'Aún no hay amigos.', soc_add_hint:'Añadir por @usuario o ID',
    soc_no_pending:'No hay solicitudes entrantes',
    soc_new_nick:'Nuevo nombre de usuario', soc_display_name:'Nombre a mostrar',
    soc_linked:'Vinculado', soc_not_linked:'No vinculado',
    soc_unlink:'Desvincular', soc_link:'Vincular',
    soc_link_ms:'Iniciar sesión con Microsoft', soc_link_ely:'Iniciar sesión con Ely.by',
    soc_new_pass:'Nueva contraseña (mín. 6 car.)', soc_repeat_pass:'Repetir contraseña',
    soc_connecting:'⚡ Conectando a',
    soc_report_desc:'Describe el problema (opcional)...', soc_sending:'Enviando...',
    soc_report_sent:'Reporte enviado', soc_send:'Enviar',
    soc_fill_fields:'Rellena todos los campos',
    soc_login:'Iniciar sesión', soc_wait:'⏳ Por favor espera...',
    soc_login_via:'Iniciar sesión con', soc_reg_via:'Registrarse con',
    soc_no_accounts:'Sin cuentas', soc_login_mc:'. Inicia sesión en una cuenta de Minecraft.',
    soc_choose_acc:'Elegir cuenta', soc_select:'Seleccionar', soc_cancel:'Cancelar',
    soc_nick_len:'Usuario: 1–64 caracteres', soc_pass_min:'Contraseña mínimo 6 caracteres',
    soc_pass_mismatch:'Las contraseñas no coinciden',
    soc_enter_nick:'Ingresa nuevo usuario', soc_nick_long:'Usuario máx. 64 caracteres',
    soc_server_err:'Error de servidor: sin datos de usuario',
    soc_nick_changed:'Usuario cambiado a', soc_enter_dname:'Ingresa nombre a mostrar',
    soc_dname_long:'Máx. 32 caracteres', soc_server_err2:'Error de servidor',
    soc_dname_changed:'Nombre cambiado a', soc_enter_pass:'Ingresa nueva contraseña',
    soc_pass_set:'¡Contraseña establecida!', soc_no_active:'Sin cuenta activa',
    soc_acc_linked:'} vinculado con éxito!',
    soc_msg_placeholder:'Mensaje...', soc_change_avatar:'Cambiar avatar',
    soc_your_id:'Tu ID (clic para copiar)', soc_id_copied:'ID: ¡copiado!',
    soc_no_mc:'Sin cuenta activa de Minecraft', soc_skin_fail:'No se pudo cargar el skin',
    soc_err:'Error:', soc_block_user:'Bloquear @', soc_search_nick:'Buscar por usuario...',
    soc_use_skin:'Usar skin de Minecraft', soc_reset_avatar:'Restablecer avatar',
    soc_upload_photo:'Subir foto', soc_mc_skin:'Skin de Minecraft',
    soc_login_ms:'Iniciar sesión con Microsoft', soc_login_ely:'Iniciar sesión con Ely.by',
    soc_register:'Registrarse', soc_reg_short:'Registro',
    soc_nick_ph:'Usuario', soc_pass_ph:'Contraseña',
    soc_nick_ph2:'Usuario (hasta 64 car.)', soc_dname_ph:'Nombre a mostrar (opcional)',
    soc_pass_ph2:'Contraseña (mín. 6 car.)',
    soc_logout_title:'¿Cerrar sesión?', soc_logout_desc:'Cerrarás sesión en MidLauncher Social.<br>Los amigos te verán desconectado.',
    soc_logout:'Cerrar sesión',
    soc_delete_title:'¿Eliminar cuenta?', soc_delete_err:'Error al eliminar',
    soc_delete_desc:'>irreversible</b>.<br>Todos los datos, amigos y mensajes serán eliminados.', soc_delete_full:'Esta acción es <b style="color:#cc4444;">irreversible</b>.<br>Todos los datos, amigos y mensajes serán eliminados.',
    soc_delete_confirm:'Eliminar permanentemente',
    soc_confirm_pass:'Ingresa contraseña para confirmar', soc_confirm:'Confirmar',
    soc_enter_pass2:'Ingresa contraseña',
    soc_no_acc_service:'Primero inicia sesión en tu cuenta de {service} en la sección «Cuentas»',
    adm_panel:'Panel de admin', adm_users:'Usuarios', adm_reports:'Reportes', adm_stats:'Estadísticas',
    adm_loading:'Cargando...', adm_no_users:'Sin usuarios', adm_no_reports:'Sin reportes',
    adm_copy_id:'Copiar ID', adm_view:'Ver', adm_change_id:'Cambiar ID',
    adm_revoke:'Revocar', adm_grant:'Admin', adm_unban:'Desbanear', adm_ban:'Banear',
    adm_delete:'Eliminar', adm_ban_title:'Banear @', adm_ban_desc:'El usuario no podrá iniciar sesión.',
    adm_unban_title:'Desbanear @', adm_unban_desc:'El usuario podrá iniciar sesión nuevamente.',
    adm_delete_title:'Eliminar @', adm_delete_desc:'La cuenta será eliminada permanentemente.',
    adm_change_id_title:'Cambiar ID de @',
    adm_change_id_desc:'Ingresa nuevo ID (cualquier carácter). Atención — cambia el identificador principal.',
    adm_change_id_btn:'Cambiar', adm_change_id_err:'Error al cambiar ID:',
    adm_grant_title:'¿Hacer @ administrador?', adm_grant_admin:'¿administrador?',
    adm_grant_desc:'El usuario tendrá acceso al panel de admin.', adm_grant_btn:'Hacer admin',
    adm_revoke_title:'Revocar derechos de admin de @',
    adm_revoke_desc:'El usuario perderá acceso al panel de admin.',
    adm_copy:'Copiar', adm_close:'Cerrar',
    adm_stat_users:'👥 Usuarios', adm_stat_friends:'🤝 Amistades',
    adm_stat_msgs:'💬 Mensajes', adm_stat_online:'🟢 En línea',
    adm_banned:'[BANEADO]', adm_revoke_admin:'Revocar admin', adm_grant_admin_btn:'Otorgar admin',
    adm_spam:'Spam', adm_abuse:'Abuso', adm_cheat:'Trampa', adm_other:'Otro',
    game_started:'¡Juego iniciado!', game_closed:'Juego cerrado',
    game_running:'⚠ El juego ya está ejecutándose', game_in:'● En juego',
    sel_mc_ver:'Seleccionar versión MC', sel_mc_ver2:'Seleccionar versión Minecraft',
    rename:'Renombrar',
    dl_fail:'⚠ No se pudo descargar «', dl_no_slug:'»: sin slug',
    dl_ing:'⬇ Descargando', dl_done:'descargado', dl_err:'✗ Error de descarga',
    dl_vers:'⬇ Obteniendo versiones para «', dl_ver_err:'✗ Error getModVersions para «',
    dl_no_vers:'⚠ Sin versiones para «', dl_no_file:'⚠ Sin archivo en versión «',
    dl_saved:'guardado en', launch_err:'Error de lanzamiento:',
    cant_delete_mp:'No se puede eliminar — modpack en ejecución',
    downloaded:'✓ Descargado', err_short:'Error',
    dl_m:'M desc.', dl_k:'K desc.', dl_n:'desc.',
    importing:'Importando...', loading_mods:'Cargando mods...', loading_short:'Cargando...',
    added_mods:'✓ Añadido ({n} mods)',
    dl_modpack:'↓ Descargar modpack', add_modpack:'+ Al modpack',
    platforms:'Plataformas', categories:'Categorías', mc_versions2:'Versiones Minecraft',
    no_versions:'Sin versiones disponibles', add_modpack2:'+ Modpack',
    gallery_empty:'Galería vacía', no_data:'Sin datos', changelog_na:'Registro de cambios no disponible',
    updated:'Actualizado', incompat_loader:'✗ Loader incompatible — soportado:',
    incompat_loader2:'Mod loader incompatible', add_mod_to_mp:'Añadir «{name}» al modpack',
    cat_adventure:'Aventura', cat_combat:'Combate', cat_decoration:'Decoración',
    cat_economy:'Economía', cat_equipment:'Equipamiento', cat_food:'Comida',
    cat_game_mechanics:'Mecánicas', cat_library:'Biblioteca', cat_magic:'Magia',
    cat_management:'Gestión', cat_minigame:'Minijuego', cat_mobs:'Mobs',
    cat_optimization:'Optimización', cat_social:'Social', cat_storage:'Almacenamiento',
    cat_technology:'Tecnología', cat_transport:'Transporte', cat_utility:'Utilidades',
    cat_worldgen:'Generación del mundo', cat_biome:'Biomas', cat_structure:'Estructuras',
    cat_dimension:'Dimensiones', cat_cursed:'Maldito', cat_quests:'Misiones',
    cat_building:'Construcción', cat_misc:'Miscelánea',
    sh_atmosphere:'Atmósfera', sh_bloom:'Bloom', sh_cartoon:'Caricatura',
    sh_colored_light:'Luz de colores', sh_fantasy:'Fantasía', sh_foliage:'Follaje',
    sh_high:'Alta calidad', sh_low:'Baja calidad', sh_medium:'Calidad media',
    sh_path_tracing:'Trazado de rutas', sh_realism:'Realismo', sh_reflections:'Reflejos',
    sh_semi_realism:'Semi-realismo', sh_shadows:'Sombras', sh_vanilla:'Estilo vainilla',
    sh_hardcore:'Hardcore', sh_potato:'Potato',
    mp_multiplayer:'Multijugador', mp_singleplayer:'Un jugador',
    env_both:'Cliente y servidor', env_client_only:'Solo cliente', env_server_only:'Solo servidor',
    env_client_optional:'Cliente (+ opt. servidor)', env_server_optional:'Servidor (+ opt. cliente)',
    env_both_optional:'Cliente y servidor (opt.)',
    bg_label:'Fondo', theme_label:'Tema', theme_light:'Claro', theme_dark:'Oscuro', bg_animated:'Fondo animado', bg_static:'Fondo estático',
    reset_btn:'✕ Restablecer',
  },
  uk: {
    nav_launcher:'Лаунчер', nav_mods:'Моди', nav_files:'Файли', nav_settings:'Налаштування', nav_friends:'Друзі',
    play:'Грати', stop:'Стоп', cancel:'Скасувати',
    loading:'Завантаження...', search:'Пошук...', search_mods:'Пошук модів...',
    my_modpacks:'Мої модпаки', tab_mod:'Моди', tab_resourcepack:'Ресурс паки',
    tab_shader:'Шейдери', tab_modpack:'Модпаки', tab_datapack:'Датапаки',
    sort_by:'Сортування:', sort_popular:'За популярністю', sort_newest:'Новіші', sort_relevance:'За релевантністю',
    settings_save:'Зберегти', settings_reset:'За замовчуванням', settings_saved:'✓ Налаштування збережено',
    settings_tab_mc:'Minecraft', settings_tab_launcher:'Лаунчер',
    settings_gamedir:'Папка гри', settings_gamedir_hint:'Папка для версій,<br>модів, світів тощо',
    settings_gamedir_ph:'За замовчуванням: папка лаунчера/minecraft',
    settings_browse:'Огляд...', settings_java:'Java / JRE', settings_ram:"Оперативна пам'ять (ОЗП)",
    settings_ram_auto:'Авто', settings_ram_warn:'⚠ Виділення 24+ ГБ може спричинити проблеми',
    settings_winsize:'Розмір вікна', settings_winsize_px:'пікс.',
    settings_console:'Командний рядок', settings_console_hint:'Показувати CMD при запуску',
    settings_console_label:'Увімкнути командний рядок при запуску',
    settings_onlaunch:'При запуску гри', settings_lang:'Мова',
    java_recommended:'Рекомендована', java_current:'Поточна', java_custom:'Користувацька',
    java_details:'••• Подробиці',
    hide_hide:'Сховати вікно лаунчера', hide_close:'Закрити вікно лаунчера', hide_keep:'Залишити лаунчер',
    mp_create:'+ Створити', mp_add_mods:'+ Додати моди', mp_play:'▶ Грати', mp_mods_in:'Моди у збірці',
    mp_empty:'<h3>Немає модпаків</h3><p>Натисніть «+ Створити» щоб додати перший модпак</p>',
    mp_new_title:'Новий модпак', mp_new_name:'Назва', mp_new_name_ph:'Зомбі модпак',
    mp_new_version:'Версія Minecraft', mp_new_loader:'Мод лоадер', mp_new_loader_ver:'Версія завантажувача',
    mp_new_confirm:'Створити', mp_best_ver:'Використовувати найкращу версію',
    mp_snap_note:'* модлоадери недоступні у снапшотах',
    mp_add_title:'Додати моди', mp_create_add:'+ Створити новий модпак і додати',
    filter_version:'Версія гри', filter_loader:'Завантажувач', filter_category:'Категорія', filter_env:'Середовище',
    env_client:'Клієнт', env_server:'Сервер',
    ver_select:'— обрати версію —', ver_no_compat:'— немає сумісних версій —',
    ver_filter_hint:'🔒 Показані лише версії підтримувані модом',
    add_to_mp:'+ У модпак', open_mr:'Відкрити на Modrinth ↗', download:'↓ Завантажити',
    add_btn:'+ Додати', added:'✓ Додано', incompatible_loader:'✗ Несумісний',
    no_compat_ver:'Немає модпаків із сумісною версією гри.',
    create_version:'+ Створити власну версію', version_mc:'Версія Minecraft',
    loader_ver:'Версія завантажувача', loader_first:'Спочатку оберіть версію гри', loader_unavail:'Версії недоступні',
    platforms:'Платформи', categories:'Категорії', mc_versions:'Версії Minecraft', description:'Опис',
    versions:'Версії', gallery:'Галерея', changelog:'Список змін',
    sort_loader:'Завантажувач', sort_mc:'Minecraft',
    modpack_download:'↓ Завантажити модпак', modpack_add_mine:'+ До моїх модпаків',
    no_mods:'Моди не знайдено', no_mods_sub:'Спробуйте змінити запит або фільтри',
    load_more:'Завантажити ще',
    picker_no_mp:'Немає модпаків. Створіть у розділі «Модпаки»',
  
    dd_empty:'Нічого не знайдено',
    fb_up_title:'На рівень вище',
    fb_add_file_title:'Додати файли',
    fb_add_file:'+ Файл',
    fb_open_folder_title:'Відкрити в провіднику',
    fb_folder_label:'Тека',
    fb_refresh_title:'Оновити',
    fb_drop_label:'Перетягніть файли для додавання',
    fb_drop_into:'Перетягніть файли в',
    fb_open:'Відкрити',
    fb_show_explorer:'Показати в провіднику',
    fb_delete:'Видалити',
    fb_empty_dir:'Тека порожня',
    fb_preload_err:'Оновіть preload.js — API не знайдено',
    fb_no_response:'немає відповіді від main.js',
    fb_folders:'тек',
    fb_files:'файлів',
    fb_copying:'Копіювання',
    fb_added:'Додано',
    fb_files_suffix:'файл(ів)',
    gc_default:'За замовчуванням (CMS або G1 GC) — рекомендується',
    gc_off:'Вимкнути (не рекомендується)',
    gc_cms:'Використовувати CMS GC',
    gc_g1gc:'Використовувати G1 GC',
    gc_shenandoah:'Використовувати Shenandoah GC',
    gc_zgc:'Використовувати ZGC',
    java_path_label:'Шлях до Java',
    java_args_label:'Аргументи Java',
    java_opt_args_label:'Оптимізовані аргументи',
    java_mc_args_label:'Аргументи Minecraft',
    java_wrap_cmd_label:'Команда — обгортка',
    java_show_advanced:'Розширені параметри',
    java_apply:'Застосувати',
    java_rec_desc:'Автоматично встановить потрібну версію Java',
    java_cur_desc:'Java що підтримує цей лаунчер',
    java_cur_warn:'(деякі версії можуть не запуститись!)',
    java_cust_desc:'Вкажи шлях до java.exe вручну',
    ver_release:'Реліз',
    ver_snapshot:'Снапшот',
    recent_versions:'Останні версії Minecraft',
    releases_label:'Релізи',
    snapshots_label:'Снапшоти',
    select_release:'— обрати реліз —',
    select_snapshot:'— обрати снапшот —',
    select_custom:'Обрати свою версію',
    create_ver_action:'+ Створити версію',
    or_label:'або',
    modpack_badge:'модпак',
    loader_label:'Мод лоадер',
    launching:'Запуск...',
    in_game_label:'У грі',
    preparing:'Підготовка...',
    downloading:'Завантаження...',
    select_ver_warn:'Оберіть версію!',
    stop_download_title:'Зупинити завантаження?',
    stop_download_desc:'Завантаження буде перервано.',
    stop_game_title:'Зупинити гру?',
    stop_game_desc:'Minecraft отримає сигнал коректного завершення —<br>ваші світи <strong style="color:#c8d0ff">автоматично збережуться</strong>.',
    stop_btn:'Зупинити',
    delete_btn:'Видалити',
    delete_version_desc:'Всі світи у цій версії будуть <strong style="color:#ff8888">безповоротно видалені</strong>.',
    delete_folder_desc:'Тека та її вміст будуть <strong style="color:#ff8888">видалені безповоротно</strong>.',
    delete_file_desc:'Файл буде <strong style="color:#ff8888">видалений безповоротно</strong>.',
    getting_label:'Отримання...',
    no_files_err:'Немає файлів',
    opened_label:'Відкрито →',
    error_label:'Помилка',
    size_mb:'МБ',
    size_kb:'КБ',
    size_b:'Б',
    size_gb:'ГБ',
    size_mb_label:'МБ',
    npm_start_warn:'Запусти через npm start',
    err_load_versions:'Помилка завантаження версій',
    opening_browser:'Відкриваю браузер...',
    login_elyby:'Увійти через Ely.by',
    opening_login:'Відкриваю вікно входу...',
    auth_error:'Помилка авторизації',
    login_ms:'Увійти через Microsoft',
    local_enter_nick:'Введіть нікнейм',
    local_min_chars:'Мінімум 3 символи',
    dir_not_found:'Теку не знайдено',
    dir_not_dir:'Вказаний шлях не є текою',
    dir_no_access:'Немає доступу до цієї теки',
    dir_check_fail:'Не вдалося перевірити шлях',
  
    edit_title:'Редагувати',
    log_title:'Журнал',
    log_empty:'Журнал порожній...',
    ac_no_accounts:'Немає акаунтів.<br>Додайте через вкладку «+ Додати»',
    ac_logged_via:'Авторизований через',
    ver_filter_hint_fmt:'Показані лише версії, підтримувані модом',
  
    tab_datapack_sub:'Моди для ванільного Minecraft без мод лоадера',
    mod_no_support:'Мод не підтримує',
    mp_toggle:'Згорнути/Розгорнути',
    mp_cant_delete_running:'Не можна видалити — модпак зараз запущений',
    mp_open_folder:'Відкрити папку модпака',
    ac_type_local:'Офлайн',
  
    this_version:'цю версію',
    this_modpack:'цей модпак',
    delete_mp_desc:'Всі файли модпака будуть <strong style="color:#ff8888">безповоротно видалені</strong>.',
    compat_versions:'підтримувані версії',
    compat_loaders:'підтримувані лоадери',
    incompatible_label:'Несумісно',
  
    env_required:"Обов'язково",
    env_optional:'Опціонально',
    env_unsupported:'Не підтримується',
  
    mods_count:'мод.',
    vanilla_no_mods:'Недоступно для Vanilla — лише датапаки',
  
    splash_greeting:'Ласкаво просимо',
    splash_hi:'Привіт, ',
    ac_title:'Акаунт',
    ac_tab_accounts:'Акаунти',
    ac_tab_add:'+ Додати',
    ac_available:'Доступні акаунти',
    ac_add_account:'Додати акаунт',
    ac_elyby_sub:'Авторизація через браузер',
    ac_ms_sub:'Ліцензійний акаунт Minecraft',
    ac_local_sub:'Без авторизації',
    ac_elyby_hint:'Відкриється браузер для входу',
    ac_ms_hint:'Відкриється вікно входу Microsoft',
    ac_offline_warn:'⚠ Можливі помилки на серверах',
    ac_nickname:'Нікнейм',
    play_offline:'Грати офлайн',
    log_empty:'Журнал порожній...',
    ver_save_name:'✓ Зберегти назву',
    ver_delete:'🗑 Видалити версію',
    modal_create_ver_title:'Створити свою версію',
    modal_name_ph:'Наприклад: Виживання з Fabric',
    search_btn:'Знайти',
    enter_query:'Введіть запит для пошуку',
    src_all:'Всі',
    ac_type_local:'Офлайн',

    soc_friends:'Друзі', soc_pending:'Заявки', soc_account:'Акаунт',
    soc_online:'В мережі', soc_offline:'Не в мережі', soc_connect:'Підключитися',
    soc_remove_friend:'Видалити з друзів', soc_block:'Заблокувати', soc_report:'Поскаржитися',
    soc_no_friends:'Друзів поки немає.', soc_add_hint:'Додай за @username або ID',
    soc_no_pending:'Немає вхідних заявок',
    soc_new_nick:'Новий нікнейм', soc_display_name:'Ім\'я для відображення',
    soc_linked:'Прив\'язано', soc_not_linked:'Не прив\'язано',
    soc_unlink:'Від\'язати', soc_link:'Прив\'язати',
    soc_link_ms:'Авторизуйся через Microsoft', soc_link_ely:'Авторизуйся через Ely.by',
    soc_new_pass:'Новий пароль (мін. 6 символів)', soc_repeat_pass:'Repeat password',
    soc_connecting:'⚡ Підключення до',
    soc_report_desc:'Опиши проблему (необов\'язково)...', soc_sending:'Надсилаємо...',
    soc_report_sent:'Скаргу надіслано', soc_send:'Надіслати',
    soc_fill_fields:'Заповни всі поля',
    soc_login:'Увійти', soc_wait:'⏳ Зачекайте...',
    soc_login_via:'Увійти через', soc_reg_via:'Зареєструватися через',
    soc_no_accounts:'Немає акаунтів', soc_login_mc:'. Увійди в потрібний акаунт Minecraft.',
    soc_choose_acc:'Вибери акаунт', soc_select:'Вибрати', soc_cancel:'Скасувати',
    soc_nick_len:'Нік: від 1 до 64 символів', soc_pass_min:'Пароль мінімум 6 символів',
    soc_pass_mismatch:'Паролі не збігаються',
    soc_enter_nick:'Введи новий нік', soc_nick_long:'Нік не повинен перевищувати 64 символи',
    soc_server_err:'Помилка сервера: немає даних користувача',
    soc_nick_changed:'Нік змінено на', soc_enter_dname:'Введи ім\'я для відображення',
    soc_dname_long:'Не більше 32 символів', soc_server_err2:'Помилка сервера',
    soc_dname_changed:'Ім\'я змінено на', soc_enter_pass:'Введи новий пароль',
    soc_pass_set:'Пароль успішно встановлено!', soc_no_active:'Немає активного акаунту',
    soc_acc_linked:'} успішно прив\'язано!',
    soc_msg_placeholder:'Повідомлення...', soc_change_avatar:'Змінити аватар',
    soc_your_id:'Ваш ID (клацни для копіювання)', soc_id_copied:'ID: скопійовано!',
    soc_no_mc:'Немає активного акаунту Minecraft', soc_skin_fail:'Не вдалося завантажити скін',
    soc_err:'Помилка:', soc_block_user:'Заблокувати @', soc_search_nick:'Пошук за ніком...',
    soc_use_skin:'Використати скін Minecraft', soc_reset_avatar:'Скинути аватар',
    soc_upload_photo:'Завантажити фото', soc_mc_skin:'Скін Minecraft',
    soc_login_ms:'Увійти через Microsoft', soc_login_ely:'Увійти через Ely.by',
    soc_register:'Зареєструватися', soc_reg_short:'Реєстрація',
    soc_nick_ph:'Нік', soc_pass_ph:'Password',
    soc_nick_ph2:'Нік (до 64 символів)', soc_dname_ph:'Ім\'я для відображення (необов\'язково)',
    soc_pass_ph2:'Пароль (мін. 6 символів)',
    soc_logout_title:'Вийти з акаунту?', soc_logout_desc:'Ти вийдеш з MidLauncher Social.<br>Друзі побачать тебе офлайн.',
    soc_logout:'Вийти',
    soc_delete_title:'Видалити акаунт?', soc_delete_err:'Помилка видалення',
    soc_delete_desc:'>незворотно</b>.<br>Всі дані, друзі та повідомлення будуть видалені.', soc_delete_full:'Ця дія є <b style="color:#cc4444;">незворотною</b>.<br>Всі дані, друзі та повідомлення будуть видалені.',
    soc_delete_confirm:'Видалити назавжди',
    soc_confirm_pass:'Введи пароль для підтвердження', soc_confirm:'Підтвердити',
    soc_enter_pass2:'Enter password',
    soc_no_acc_service:'Спочатку увійди в акаунт {service} у розділі «Акаунти» лаунчера',
    adm_panel:'Адмін-панель', adm_users:'Користувачі', adm_reports:'Скарги', adm_stats:'Статистика',
    adm_loading:'Завантаження...', adm_no_users:'Немає користувачів', adm_no_reports:'Скарг немає',
    adm_copy_id:'Скопіювати ID', adm_view:'Перегляд', adm_change_id:'Змінити ID',
    adm_revoke:'Зняти', adm_grant:'Адмін', adm_unban:'Розбанити', adm_ban:'Забанити',
    adm_delete:'Видалити', adm_ban_title:'Забанити @', adm_ban_desc:'Користувач не зможе увійти в акаунт.',
    adm_unban_title:'Розбанити @', adm_unban_desc:'Користувач знову зможе увійти.',
    adm_delete_title:'Видалити @', adm_delete_desc:'Акаунт буде видалено назавжди.',
    adm_change_id_title:'Змінити ID для @',
    adm_change_id_desc:'Введи новий ID (будь-які символи). Обережно — це змінить ідентифікатор.',
    adm_change_id_btn:'Змінити', adm_change_id_err:'Помилка зміни ID:',
    adm_grant_title:'Зробити @ адміністратором?', adm_grant_admin:'адміністратором?',
    adm_grant_desc:'Користувач отримає доступ до панелі управління.', adm_grant_btn:'Зробити адміном',
    adm_revoke_title:'Зняти права адміністратора у @',
    adm_revoke_desc:'Користувач втратить доступ до панелі управління.',
    adm_copy:'Скопіювати', adm_close:'Закрити',
    adm_stat_users:'👥 Користувачів', adm_stat_friends:'🤝 Friendships',
    adm_stat_msgs:'💬 Повідомлень', adm_stat_online:'🟢 Online',
    adm_banned:'[БАН]', adm_revoke_admin:'Зняти адміна', adm_grant_admin_btn:'Видати адміна',
    adm_spam:'Spam', adm_abuse:'Образи', adm_cheat:'Cheating', adm_other:'Інше',
    game_started:'Гру розпочато!', game_closed:'Гру закрито',
    game_running:'⚠ Гра вже запущена', game_in:'● У грі',
    sel_mc_ver:'Обери версію MC', sel_mc_ver2:'Обери версію Minecraft',
    rename:'Перейменувати',
    dl_fail:'⚠ Не вдалося завантажити «', dl_no_slug:'»: немає slug',
    dl_ing:'⬇ Завантажую', dl_done:'завантажено', dl_err:'✗ Помилка завантаження',
    dl_vers:'⬇ Отримую версії «', dl_ver_err:'✗ Помилка getModVersions для «',
    dl_no_vers:'⚠ Немає версій для «', dl_no_file:'⚠ Немає файлу у версії «',
    dl_saved:'збережено в', launch_err:'Помилка запуску:',
    cant_delete_mp:'Не можна видалити — модпак запущено',
    downloaded:'✓ Завантажено', err_short:'Помилка',
    dl_m:'M завант.', dl_k:'K завант.', dl_n:'завант.',
    importing:'Імпорт...', loading_mods:'Завантажую моди...', loading_short:'Завантаження...',
    added_mods:'✓ Додано ({n} модів)',
    dl_modpack:'↓ Завантажити модпак', add_modpack:'+ До модпаку',
    platforms:'Платформи', categories:'Категорії', mc_versions2:'Версії Minecraft',
    no_versions:'Немає доступних версій', add_modpack2:'+ Modpack',
    gallery_empty:'Галерея порожня', no_data:'Немає даних', changelog_na:'Журнал змін недоступний',
    updated:'Оновлено', incompat_loader:'✗ Несумісний завантажувач — підтримується:',
    incompat_loader2:'Несумісний мод-завантажувач', add_mod_to_mp:'Додати «{name}» до модпаку',
    cat_adventure:'Пригоди', cat_combat:'Бій', cat_decoration:'Декорації',
    cat_economy:'Економіка', cat_equipment:'Спорядження', cat_food:'Їжа',
    cat_game_mechanics:'Механіки гри', cat_library:'Бібліотека', cat_magic:'Магія',
    cat_management:'Управління', cat_minigame:'Міні-гра', cat_mobs:'Моби',
    cat_optimization:'Оптимізація', cat_social:'Соціальне', cat_storage:'Сховище',
    cat_technology:'Технології', cat_transport:'Transport', cat_utility:'Утиліти',
    cat_worldgen:'Генерація світу', cat_biome:'Біоми', cat_structure:'Структури',
    cat_dimension:'Виміри', cat_cursed:'Прокляте', cat_quests:'Квести',
    cat_building:'Будівництво', cat_misc:'Різне',
    sh_atmosphere:'Atmosphere', sh_bloom:'Свічення', sh_cartoon:'Мультяшний',
    sh_colored_light:'Кольорове освітлення', sh_fantasy:'Фентезі', sh_foliage:'Рослинність',
    sh_high:'Висока якість', sh_low:'Низька якість', sh_medium:'Середня якість',
    sh_path_tracing:'Трасування шляху', sh_realism:'Реалізм', sh_reflections:'Відображення',
    sh_semi_realism:'Напівреалізм', sh_shadows:'Тіні', sh_vanilla:'Ванільний стиль',
    sh_hardcore:'Hardcore', sh_potato:'Легкий',
    mp_multiplayer:'Мультиплеєр', mp_singleplayer:'Одиночна',
    env_both:'Клієнт і сервер', env_client_only:'Тільки клієнт', env_server_only:'Тільки сервер',
    env_client_optional:'Клієнт (+ опц. сервер)', env_server_optional:'Сервер (+ опц. клієнт)',
    env_both_optional:'Клієнт і сервер (опц.)',
    bg_label:'Фон', theme_label:'Тема оформлення', theme_light:'Світла', theme_dark:'Темна', bg_animated:'Анімований фон', bg_static:'Звичайний фон',
    reset_btn:'✕ Скинути',
  },
};

// For remaining languages — copy English as base, patch key strings
const _langPatches = {
  it:{nav_mods:'Mod',nav_files:'File',nav_settings:'Impostazioni',play:'Gioca',stop:'Ferma',loading:'Caricamento...',search:'Cerca...',my_modpacks:'I Miei Modpack',tab_mod:'Mod',tab_resourcepack:'Pacchetti risorse',tab_shader:'Shader',tab_modpack:'Modpack',tab_datapack:'Datapack',sort_popular:'Per popolarità',sort_newest:'Più recenti',sort_relevance:'Per rilevanza',settings_save:'Salva',settings_reset:'Ripristina',settings_saved:'✓ Impostazioni salvate',settings_tab_launcher:'Launcher',settings_gamedir:'Cartella del gioco',settings_browse:'Sfoglia...',settings_ram:'Memoria RAM',settings_ram_auto:'Auto',settings_onlaunch:'Al lancio del gioco',settings_lang:'Lingua',java_recommended:'Consigliato',java_current:'Attuale',java_custom:'Personalizzato',java_details:'••• Dettagli',hide_hide:'Nascondi launcher',hide_close:'Chiudi launcher',hide_keep:'Mantieni launcher aperto',mp_create:'+ Crea',mp_add_mods:'+ Aggiungi mod',mp_play:'▶ Gioca',mp_mods_in:'Mod nel pack',mp_new_title:'Nuovo modpack',mp_new_name:'Nome',mp_new_name_ph:'Modpack Zombie',mp_new_version:'Versione Minecraft',mp_new_loader:'Mod loader',mp_new_confirm:'Crea',mp_open_folder:'Apri cartella modpack',filter_version:'Versione del gioco',filter_category:'Categoria',filter_env:'Ambiente',env_client:'Client',env_server:'Server',add_to_mp:'+ Al modpack',download:'↓ Scarica',add_btn:'+ Aggiungi',added:'✓ Aggiunto',load_more:'Carica altro',description:'Descrizione',versions:'Versioni',gallery:'Galleria'},
  pt:{nav_mods:'Mods',nav_files:'Ficheiros',nav_settings:'Definições',play:'Jogar',stop:'Parar',loading:'A carregar...',search:'Pesquisar...',my_modpacks:'Meus Modpacks',tab_resourcepack:'Pacotes de recursos',settings_save:'Guardar',settings_reset:'Redefinir',settings_saved:'✓ Definições guardadas',settings_lang:'Língua',settings_browse:'Procurar...',settings_onlaunch:'Ao iniciar o jogo',java_recommended:'Recomendado',java_current:'Atual',java_custom:'Personalizado',mp_create:'+ Criar',mp_add_mods:'+ Adicionar mods',mp_play:'▶ Jogar',mp_new_title:'Novo modpack',mp_new_name_ph:'Modpack Zombie',mp_new_version:'Versão Minecraft',mp_new_confirm:'Criar',mp_open_folder:'Abrir pasta do modpack',add_to_mp:'+ Ao modpack',download:'↓ Baixar',add_btn:'+ Adicionar',added:'✓ Adicionado',load_more:'Carregar mais',description:'Descrição',versions:'Versões',gallery:'Galeria'},
  pl:{nav_mods:'Mody',nav_files:'Pliki',nav_settings:'Ustawienia',play:'Graj',stop:'Stop',loading:'Ładowanie...',search:'Szukaj...',my_modpacks:'Moje Modpacki',tab_mod:'Mody',tab_resourcepack:'Paczki zasobów',tab_shader:'Shadery',tab_modpack:'Modpacki',tab_datapack:'Datapaki',settings_save:'Zapisz',settings_reset:'Przywróć',settings_saved:'✓ Ustawienia zapisane',settings_lang:'Język',settings_browse:'Przeglądaj...',settings_onlaunch:'Przy uruchomieniu gry',java_recommended:'Zalecana',java_current:'Aktualna',java_custom:'Niestandardowa',mp_create:'+ Utwórz',mp_add_mods:'+ Dodaj mody',mp_play:'▶ Graj',mp_new_title:'Nowy modpack',mp_new_name_ph:'Modpack Zombie',mp_new_version:'Wersja Minecraft',mp_new_confirm:'Utwórz',mp_open_folder:'Otwórz folder modpacka',add_to_mp:'+ Do modpacka',download:'↓ Pobierz',add_btn:'+ Dodaj',added:'✓ Dodano',load_more:'Załaduj więcej',description:'Opis',versions:'Wersje',gallery:'Galeria'},
  tr:{nav_launcher:'Başlatıcı',nav_mods:'Modlar',nav_files:'Dosyalar',nav_settings:'Ayarlar',play:'Oyna',stop:'Durdur',loading:'Yükleniyor...',search:'Ara...',my_modpacks:'Modpaketlerim',tab_mod:'Modlar',tab_resourcepack:'Kaynak paketleri',tab_shader:'Shaderlar',tab_modpack:'Modpaketleri',tab_datapack:'Veri paketleri',settings_save:'Kaydet',settings_reset:'Sıfırla',settings_saved:'✓ Ayarlar kaydedildi',settings_lang:'Dil',settings_browse:'Gözat...',settings_onlaunch:'Oyun başlatıldığında',java_recommended:'Önerilen',java_current:'Mevcut',java_custom:'Özel',mp_create:'+ Oluştur',mp_add_mods:'+ Mod ekle',mp_play:'▶ Oyna',mp_new_title:'Yeni modpaket',mp_new_name_ph:'Zombi Modpaketi',mp_new_version:'Minecraft Sürümü',mp_new_confirm:'Oluştur',mp_open_folder:'Modpaket klasörünü aç',add_to_mp:'+ Modpaketine',download:'↓ İndir',add_btn:'+ Ekle',added:'✓ Eklendi',load_more:'Daha fazla yükle',description:'Açıklama',versions:'Sürümler',gallery:'Galeri'},
  zh:{nav_launcher:'启动器',nav_mods:'模组',nav_files:'文件',nav_settings:'设置',play:'开始游戏',stop:'停止',loading:'加载中...',search:'搜索...',my_modpacks:'我的整合包',tab_mod:'模组',tab_resourcepack:'资源包',tab_shader:'光影',tab_modpack:'整合包',tab_datapack:'数据包',settings_save:'保存',settings_reset:'恢复默认',settings_saved:'✓ 设置已保存',settings_lang:'语言',settings_browse:'浏览...',settings_onlaunch:'启动游戏时',java_recommended:'推荐',java_current:'当前',java_custom:'自定义',mp_create:'+ 创建',mp_add_mods:'+ 添加模组',mp_play:'▶ 游戏',mp_new_title:'新整合包',mp_new_name_ph:'僵尸整合包',mp_new_version:'Minecraft 版本',mp_new_confirm:'创建',mp_open_folder:'打开整合包文件夹',add_to_mp:'+ 到整合包',download:'↓ 下载',add_btn:'+ 添加',added:'✓ 已添加',load_more:'加载更多',description:'描述',versions:'版本',gallery:'画廊'},
  ja:{nav_launcher:'ランチャー',nav_mods:'Mod',nav_files:'ファイル',nav_settings:'設定',play:'プレイ',stop:'停止',loading:'読み込み中...',search:'検索...',my_modpacks:'マイModpack',tab_mod:'Mod',tab_resourcepack:'リソースパック',tab_shader:'シェーダー',tab_modpack:'Modpack',tab_datapack:'データパック',settings_save:'保存',settings_reset:'デフォルトに戻す',settings_saved:'✓ 設定を保存しました',settings_lang:'言語',settings_browse:'参照...',settings_onlaunch:'ゲーム起動時',java_recommended:'推奨',java_current:'現在',java_custom:'カスタム',mp_create:'+ 作成',mp_add_mods:'+ Modを追加',mp_play:'▶ プレイ',mp_new_title:'新しいModpack',mp_new_name_ph:'ゾンビModpack',mp_new_version:'Minecraftバージョン',mp_new_confirm:'作成',mp_open_folder:'Modpackフォルダを開く',add_to_mp:'+ Modpackへ',download:'↓ ダウンロード',add_btn:'+ 追加',added:'✓ 追加済み',load_more:'さらに読み込む',description:'説明',versions:'バージョン',gallery:'ギャラリー'},
  ko:{nav_launcher:'런처',nav_mods:'모드',nav_files:'파일',nav_settings:'설정',play:'플레이',stop:'정지',loading:'로딩 중...',search:'검색...',my_modpacks:'내 모드팩',tab_mod:'모드',tab_resourcepack:'리소스팩',tab_shader:'셰이더',tab_modpack:'모드팩',tab_datapack:'데이터팩',settings_save:'저장',settings_reset:'초기화',settings_saved:'✓ 설정이 저장되었습니다',settings_lang:'언어',settings_browse:'찾아보기...',settings_onlaunch:'게임 실행 시',java_recommended:'권장',java_current:'현재',java_custom:'사용자 정의',mp_create:'+ 만들기',mp_add_mods:'+ 모드 추가',mp_play:'▶ 플레이',mp_new_title:'새 모드팩',mp_new_name_ph:'좀비 모드팩',mp_new_version:'Minecraft 버전',mp_new_confirm:'만들기',mp_open_folder:'모드팩 폴더 열기',add_to_mp:'+ 모드팩에 추가',download:'↓ 다운로드',add_btn:'+ 추가',added:'✓ 추가됨',load_more:'더 불러오기',description:'설명',versions:'버전',gallery:'갤러리'},
  nl:{nav_mods:'Mods',nav_files:'Bestanden',nav_settings:'Instellingen',play:'Spelen',stop:'Stoppen',loading:'Laden...',search:'Zoeken...',my_modpacks:'Mijn Modpacks',tab_resourcepack:'Resourcepacks',settings_save:'Opslaan',settings_reset:'Herstellen',settings_saved:'✓ Instellingen opgeslagen',settings_lang:'Taal',mp_create:'+ Aanmaken',mp_add_mods:'+ Mods toevoegen',mp_play:'▶ Spelen',mp_new_confirm:'Aanmaken',mp_open_folder:'Modpack-map openen',download:'↓ Downloaden',add_btn:'+ Toevoegen',added:'✓ Toegevoegd',load_more:'Meer laden'},
  cs:{nav_mods:'Mody',nav_files:'Soubory',nav_settings:'Nastavení',play:'Hrát',stop:'Stop',loading:'Načítání...',search:'Hledat...',my_modpacks:'Moje Modpacky',tab_mod:'Mody',tab_resourcepack:'Balíčky zdrojů',tab_shader:'Shadery',tab_modpack:'Modpacky',tab_datapack:'Datapacky',settings_save:'Uložit',settings_reset:'Obnovit',settings_saved:'✓ Nastavení uloženo',settings_lang:'Jazyk',mp_create:'+ Vytvořit',mp_add_mods:'+ Přidat mody',mp_play:'▶ Hrát',mp_new_confirm:'Vytvořit',mp_open_folder:'Otevřít složku modpacku',download:'↓ Stáhnout',add_btn:'+ Přidat',added:'✓ Přidáno',load_more:'Načíst více'},
  sv:{nav_mods:'Mods',nav_files:'Filer',nav_settings:'Inställningar',play:'Spela',stop:'Stoppa',loading:'Laddar...',search:'Sök...',my_modpacks:'Mina Modpacks',tab_resourcepack:'Resurspaket',tab_datapack:'Datapaket',settings_save:'Spara',settings_reset:'Återställ',settings_saved:'✓ Inställningar sparade',settings_lang:'Språk',mp_create:'+ Skapa',mp_add_mods:'+ Lägg till mods',mp_play:'▶ Spela',mp_new_confirm:'Skapa',mp_open_folder:'Öppna modpack-mapp',download:'↓ Ladda ner',add_btn:'+ Lägg till',added:'✓ Tillagd',load_more:'Ladda mer'},
  fi:{nav_mods:'Modit',nav_files:'Tiedostot',nav_settings:'Asetukset',play:'Pelaa',stop:'Lopeta',loading:'Ladataan...',search:'Hae...',my_modpacks:'Omat Modpackit',tab_mod:'Modit',tab_resourcepack:'Resurssipaketit',tab_shader:'Varjostimet',tab_modpack:'Modpackit',tab_datapack:'Datapaketit',settings_save:'Tallenna',settings_reset:'Palauta',settings_saved:'✓ Asetukset tallennettu',settings_lang:'Kieli',mp_create:'+ Luo',mp_add_mods:'+ Lisää modeja',mp_play:'▶ Pelaa',mp_new_confirm:'Luo',mp_open_folder:'Avaa modpack-kansio',download:'↓ Lataa',add_btn:'+ Lisää',added:'✓ Lisätty',load_more:'Lataa lisää'},
  hu:{nav_mods:'Modok',nav_files:'Fájlok',nav_settings:'Beállítások',play:'Játék',stop:'Leállítás',loading:'Betöltés...',search:'Keresés...',my_modpacks:'Modpackjaim',tab_mod:'Modok',tab_resourcepack:'Erőforráscsomagok',tab_shader:'Shaderek',tab_modpack:'Modpackok',tab_datapack:'Adatcsomagok',settings_save:'Mentés',settings_reset:'Alapértelmezett',settings_saved:'✓ Beállítások mentve',settings_lang:'Nyelv',mp_create:'+ Létrehozás',mp_add_mods:'+ Mod hozzáadása',mp_play:'▶ Játék',mp_new_confirm:'Létrehozás',mp_open_folder:'Modpack mappa megnyitása',download:'↓ Letöltés',add_btn:'+ Hozzáadás',added:'✓ Hozzáadva',load_more:'Több betöltése'},
  ro:{nav_mods:'Moduri',nav_files:'Fișiere',nav_settings:'Setări',play:'Joacă',stop:'Oprește',loading:'Se încarcă...',search:'Caută...',my_modpacks:'Modpack-urile mele',tab_mod:'Moduri',tab_resourcepack:'Pachete de resurse',tab_shader:'Shadere',tab_modpack:'Modpack-uri',tab_datapack:'Pachete de date',settings_save:'Salvează',settings_reset:'Resetează',settings_saved:'✓ Setări salvate',settings_lang:'Limbă',mp_create:'+ Creează',mp_add_mods:'+ Adaugă moduri',mp_play:'▶ Joacă',mp_new_confirm:'Creează',mp_open_folder:'Deschide dosarul modpackului',download:'↓ Descarcă',add_btn:'+ Adaugă',added:'✓ Adăugat',load_more:'Încarcă mai mult'},
  sk:{nav_mods:'Mody',nav_files:'Súbory',nav_settings:'Nastavenia',play:'Hrať',stop:'Stop',loading:'Načítava sa...',search:'Hľadať...',my_modpacks:'Moje Modpacky',tab_mod:'Mody',tab_resourcepack:'Balíky zdrojov',tab_shader:'Shadery',tab_modpack:'Modpacky',tab_datapack:'Datapacky',settings_save:'Uložiť',settings_reset:'Obnoviť',settings_saved:'✓ Nastavenia uložené',settings_lang:'Jazyk',mp_create:'+ Vytvoriť',mp_add_mods:'+ Pridať mody',mp_play:'▶ Hrať',mp_new_confirm:'Vytvoriť',mp_open_folder:'Otvoriť priečinok modpacku',download:'↓ Stiahnuť',add_btn:'+ Pridať',added:'✓ Pridané',load_more:'Načítať viac'},
};
Object.entries(_langPatches).forEach(([lang, patch]) => {
  T[lang] = Object.assign({}, T.en, patch);
});

// ─── Update static HTML elements with translations ───
function updateStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const val = t(key);
    if (el.tagName === 'INPUT') el.placeholder = val;
    else el.textContent = val;
  });
  // Update elements that need special handling
  const mpModalTitleEl = document.getElementById('mpModalTitleEl');
  if (mpModalTitleEl) mpModalTitleEl.textContent = t('mp_new_title');
  const mpModalName = document.getElementById('mpModalName');
  if (mpModalName) mpModalName.placeholder = t('mp_new_name_ph');
}

window.saveSettings = async function() {
  config.settings = JSON.parse(JSON.stringify(settingsDraft));
  await window.electronAPI?.saveConfig({ settings: config.settings });
  applyBackgroundType(config.settings.backgroundType || 'plain');
  applyTheme(config.settings.theme || 'dark');
  // Apply translations to all static DOM elements
  applyI18n();
  // Re-render active tab so all dynamic t() calls update
  const activeItem = document.querySelector('.menu-item.active');
  if (activeItem) loadTab(activeItem.dataset.target);
  const tEl = document.createElement('div');
  tEl.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#004dff;color:#fff;padding:8px 20px;border-radius:8px;font-size:13px;z-index:99999;animation:splashIn .3s both';
  tEl.textContent = t('settings_saved');
  document.body.appendChild(tEl);
  setTimeout(() => tEl.remove(), 2000);
}
window.resetSettings = function() {
  settingsDraft = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
  renderSettingsTab();
};

// ── Particle Background System ────────────────────────────────────────────────
(function() {
  const canvas = document.getElementById('particleBg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let animId = null;
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let running = false;

  const PARTICLE_COUNT = 55;   // OPT: fewer particles
  const CONNECT_DIST   = 100;  // OPT: shorter range = O(n²) savings
  const BASE_SPEED     = 0.35;
  const MOUSE_RADIUS   = 120;
  const LERP_SPEED     = 0.07;

  class Particle {
    constructor() { this.glow = 0; this.reset(); }
    reset() {
      this.x    = Math.random() * canvas.width;
      this.y    = Math.random() * canvas.height;
      this.vx   = (Math.random() - 0.5) * BASE_SPEED * 2;
      this.vy   = (Math.random() - 0.5) * BASE_SPEED * 2;
      this.r    = Math.random() * 1.8 + 0.8;
      this.alpha = Math.random() * 0.5 + 0.3;
    }
    update() {
      const spd = Math.sqrt(this.vx*this.vx + this.vy*this.vy);
      if (spd > BASE_SPEED * 2.5) { this.vx = this.vx/spd * BASE_SPEED*2.5; this.vy = this.vy/spd * BASE_SPEED*2.5; }
      this.x += this.vx;
      this.y += this.vy;
      if (this.x < -10) this.x = canvas.width + 10;
      if (this.x > canvas.width + 10) this.x = -10;
      if (this.y < -10) this.y = canvas.height + 10;
      if (this.y > canvas.height + 10) this.y = -10;
      // Smoothly lerp glow toward target proximity
      const mdx = mouseX - this.x, mdy = mouseY - this.y;
      const mdist2 = mdx*mdx + mdy*mdy;
      const raw = mdist2 < MOUSE_RADIUS * MOUSE_RADIUS  // OPT: skip sqrt
        ? Math.max(0, 1 - Math.sqrt(mdist2) / MOUSE_RADIUS) : 0;
      const target = raw * raw * (3 - 2 * raw); // smoothstep
      this.glow += (target - this.glow) * LERP_SPEED;
    }
  }

  // Particles created AFTER first resize so canvas has real dimensions
  let particles = [];

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    // Re-scatter existing particles across the new size
    if (particles.length === 0) {
      particles = Array.from({ length: PARTICLE_COUNT }, () => new Particle());
    } else {
      particles.forEach(p => {
        p.x = Math.random() * canvas.width;
        p.y = Math.random() * canvas.height;
      });
    }
  }
  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    // OPT: debounce resize — avoid thrashing canvas during window drag
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(resize, 100);
  }, { passive: true });
  resize();

  let _mouseThrottle = 0;
  document.addEventListener('mousemove', e => {
    const now = Date.now();
    if (now - _mouseThrottle < 16) return; // OPT: cap at ~60fps
    _mouseThrottle = now;
    mouseX = e.clientX; mouseY = e.clientY;
  }, { passive: true });

  function isLightTheme() { return document.body.classList.contains('light'); }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const light = isLightTheme();
    for (let i = 0; i < particles.length; i++) {
      particles[i].update();
      const p = particles[i];
      const g = p.glow; // smoothed 0..1

      // Subtle highlight: small radius bump + modest alpha boost
      const glowAlpha  = p.alpha + g * 0.28;
      const glowRadius = p.r    + g * 1.4;

      // Soft outer halo — only when noticeably highlighted
      if (g > 0.08) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, glowRadius + 2.0, 0, Math.PI*2);
        ctx.fillStyle = light
          ? `rgba(60,120,255,${g * 0.10})`
          : `rgba(100,180,255,${g * 0.12})`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, glowRadius, 0, Math.PI*2);
      ctx.fillStyle = light
        ? `rgba(30,80,200,${Math.min(1, glowAlpha + 0.25)})`
        : `rgba(80,160,255,${Math.min(1, glowAlpha)})`;
      ctx.fill();

      // Connections — modest boost on highlighted lines
      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j];
        const dx = p.x - q.x, dy = p.y - q.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < CONNECT_DIST * CONNECT_DIST) { // OPT: avoid sqrt per pair
          const d  = Math.sqrt(d2);
          const baseOpacity = (1 - d / CONNECT_DIST);
          const lineGlow    = (g + q.glow) * 0.5;
          const lineAlpha   = baseOpacity * (light ? 0.28 : 0.18) + lineGlow * (light ? 0.22 : 0.20);
          const lineWidth   = 0.8 + lineGlow * 0.7;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = light
            ? `rgba(30,80,200,${Math.min(1, lineAlpha)})`
            : `rgba(80,160,255,${Math.min(1, lineAlpha)})`;
          ctx.lineWidth = lineWidth;
          ctx.stroke();
        }
      }
    }
    animId = requestAnimationFrame(draw);
  }

  window.startParticles = function() {
    if (running) return;
    running = true;
    draw();
  };
  window.stopParticles = function() {
    running = false;
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
  // OPT: pause particles when window is hidden (game running, user alt-tabbed)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
    } else if (running) {
      if (!animId) animId = requestAnimationFrame(draw);
    }
  });
})();

function applyBackgroundType(type) {
  if (type === 'animated') {
    document.body.classList.add('bg-animated');
    window.startParticles?.();
  } else {
    document.body.classList.remove('bg-animated');
    window.stopParticles?.();
  }
}

async function init() {
  // Show splash
  const splash = document.getElementById('splashScreen');
  const greetEl = document.getElementById('splashGreeting');
  const subEl = document.getElementById('splashSub');

  try {
    if (window.electronAPI) {
      config = await window.electronAPI.getConfig() || { last: null, customVersions: [] };
      acAllAccounts = config.accounts?.length ? config.accounts : (config.account ? [config.account] : []);
      if (config.account) { acCurrentAccount = config.account; acUpdateAccountBtn(acCurrentAccount); }
      modpacks = config.modpacks || [];
      acPreloadSkins();
      // Apply background preference
      applyBackgroundType(config.settings?.backgroundType || 'plain');
      applyTheme(config.settings?.theme || 'dark');
    }
    // ── Show greeting FIRST, right after config loaded ──
    applyI18n();
    const name = acCurrentAccount?.username;
    greetEl.textContent = name ? t('splash_hi') + name + '!' : t('splash_greeting');
    greetEl.style.opacity = '1';
    // ── Then load the rest ──
    await loadLauncher();
    updateStaticI18n();
    // Update nav with saved language
    const navMap = { launcher:'nav_launcher', mods:'nav_mods', files:'nav_files', settings:'nav_settings', friends:'nav_friends' };
    document.querySelectorAll('.menu-item[data-target]').forEach(el => {
      el.textContent = t(navMap[el.dataset.target]);
    });
  } catch(e) {
    console.error('init error:', e);
    subEl.textContent = t('launch_err') + ' ' + e.message;
  } finally {
    document.getElementById('content').style.opacity = '1';
    // Hide splash with delay so it's visible for at least a moment
    setTimeout(() => {
      splash.classList.add('hidden');
      splash.style.opacity = '0';
      splash.style.visibility = 'hidden';
      splash.style.pointerEvents = 'none';
      setTimeout(() => { splash.style.display = 'none'; }, 700);
    }, 600);
  }

  // Sync account tokens when main process refreshes MS token on launch
  window.electronAPI?.onAccountUpdated?.(updated => {
    if (!updated) return;
    const idx = acAllAccounts.findIndex(a => a.username === updated.username && a.type === updated.type);
    if (idx >= 0) acAllAccounts[idx] = updated;
    if (acCurrentAccount?.username === updated.username) acCurrentAccount = updated;
  });
}

// ── Account Panel ─────────────────────────────────────────────────────────────
let acCurrentAccount = null;
let acAllAccounts    = [];
let acCurrentTab     = 'accounts';
const acSkinCache    = {};
// Cache drawn face pixels (key = "username:type:size") to avoid re-drawing on every panel open
const acFacePixelCache = new Map();
const TYPE_LABELS    = { elyby:'Ely.by', ms:'Microsoft', get local(){ return t('ac_type_local'); } };

function openAccountPanel() {
  document.getElementById('accountOverlay').classList.add('open');
  document.getElementById('accountPanel').classList.add('open');
  acRenderPanel();
}
function closeAccountPanel() {
  document.getElementById('accountOverlay').classList.remove('open');
  document.getElementById('accountPanel').classList.remove('open');
}
document.getElementById('accountBtn').addEventListener('click', e => { e.stopPropagation(); openAccountPanel(); });

function acShowTab(tab) {
  acCurrentTab = tab;
  document.getElementById('acTabBodyAccounts').style.display = tab === 'accounts' ? '' : 'none';
  document.getElementById('acTabBodyAdd').style.display      = tab === 'add'      ? '' : 'none';
  document.querySelectorAll('.ac-tab').forEach((t, i) => t.classList.toggle('active', (i === 0) === (tab === 'accounts')));
  if (tab === 'accounts') acRenderAccountList();
}

function acToggleMethod(id) {
  const el = document.getElementById('acMethod' + id.charAt(0).toUpperCase() + id.slice(1));
  if (!el) return;
  const wasExpanded = el.classList.contains('expanded');
  document.querySelectorAll('.ac-method').forEach(m => m.classList.remove('expanded'));
  if (!wasExpanded) el.classList.add('expanded');
}

async function acPreloadSkins() {
  if (!window.electronAPI?.fetchSkin) return;
  if (!acSkinCache['__steve__']) {
    try { const d = await window.electronAPI.fetchSkin({ username:'Steve', type:'local' }); if (d) acSkinCache['__steve__'] = d; } catch {}
  }
  for (const acc of acAllAccounts) {
    const key = acc.username + ':' + acc.type;
    if (acc.type === 'local') { acSkinCache[key] = acSkinCache['__steve__'] || 'logo'; continue; }
    if (acSkinCache[key]) continue;
    try { const d = await window.electronAPI.fetchSkin({ username: acc.username, type: acc.type }); if (d) acSkinCache[key] = d; } catch {}
  }
}

function acDrawFace(canvas, dataUrl, cacheKey) {
  if (!dataUrl || dataUrl === 'logo') return;
  const key = (cacheKey || dataUrl.slice(-32)) + ':' + canvas.width;
  // Use cached pixel data if available
  if (acFacePixelCache.has(key)) {
    canvas.getContext('2d').putImageData(acFacePixelCache.get(key), 0, 0);
    return;
  }
  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 40, 8, 8, 8, 0, 0, canvas.width, canvas.height);
    // Cache the result
    try { acFacePixelCache.set(key, ctx.getImageData(0, 0, canvas.width, canvas.height)); } catch {}
  };
  img.src = dataUrl;
}

function acGetSkin(acc, callback) {
  const key = acc.username + ':' + acc.type;
  if (acc.type === 'local') {
    if (acSkinCache['__steve__']) { callback(acSkinCache['__steve__']); return; }
    if (window.electronAPI?.fetchSkin) {
      window.electronAPI.fetchSkin({ username:'Steve', type:'local' }).then(d => {
        if (d) { acSkinCache['__steve__'] = d; acSkinCache[key] = d; callback(d); } else callback('logo');
      }).catch(() => callback('logo'));
    } else callback('logo');
    return;
  }
  if (acSkinCache[key]) { callback(acSkinCache[key]); return; }
  if (!window.electronAPI?.fetchSkin) return;
  window.electronAPI.fetchSkin({ username: acc.username, type: acc.type }).then(d => {
    if (d) { acSkinCache[key] = d; callback(d); }
  });
}

function acUpdateAccountBtn(acc) {
  const canvas = document.getElementById('accountBtnCanvas');
  const letter = document.getElementById('accountBtnLetter');
  if (!acc) { canvas.style.display = 'none'; letter.style.display = 'flex'; letter.textContent = (_socialUser?.displayName || _socialUser?.username || '?')[0].toUpperCase(); return; }
  letter.style.display = 'flex'; letter.textContent = acc.username.charAt(0).toUpperCase(); canvas.style.display = 'none';
  acGetSkin(acc, dataUrl => {
    if (!dataUrl || dataUrl === 'logo') return;
    acDrawFace(canvas, dataUrl);
    const img = new Image();
    img.onload = () => { canvas.style.display = 'block'; letter.style.display = 'none'; };
    img.src = dataUrl;
  });
}

function acRenderAccountList() {
  const list = document.getElementById('acAccountList');
  if (!acAllAccounts.length) {
    list.innerHTML = `<div class="ac-empty">${t('ac_no_accounts')}</div>`;
    document.getElementById('acActiveSkinWrap').style.display = 'none';
    return;
  }
  if (acCurrentAccount) {
    document.getElementById('acActiveSkinWrap').style.display = 'flex';
    document.getElementById('acActiveName').textContent = acCurrentAccount.username;
    document.getElementById('acActiveType').textContent = t('ac_logged_via') + ' ' + (TYPE_LABELS[acCurrentAccount.type] || acCurrentAccount.type);
    const c3d = document.getElementById('acActiveSkinCanvas3d');
    c3d.innerHTML = '';
    const bigCanvas = document.createElement('canvas');
    bigCanvas.width = bigCanvas.height = 52;
    bigCanvas.style.cssText = 'width:52px;height:52px;image-rendering:pixelated;border-radius:5px;display:block;';
    c3d.appendChild(bigCanvas);
    acGetSkin(acCurrentAccount, d => acDrawFace(bigCanvas, d, acCurrentAccount.username + ':' + acCurrentAccount.type));
    acUpdateAccountBtn(acCurrentAccount);
  }
  list.innerHTML = '';
  acAllAccounts.forEach((acc, i) => {
    const isActive = acCurrentAccount && acc.username === acCurrentAccount.username && acc.type === acCurrentAccount.type;
    const div = document.createElement('div');
    div.className = 'ac-account-item' + (isActive ? ' active-account' : '');
    div.innerHTML = `<div class="ac-account-skin" id="acSkinThumb_${i}"></div><div class="ac-account-info"><div class="ac-account-name">${escHtml(acc.username)}</div><div class="ac-account-type">${escHtml(TYPE_LABELS[acc.type]||acc.type)}</div></div><button class="ac-account-del" onclick="acRemoveAccount(${i})" title="${t('adm_delete')}">✕</button>`;
    div.addEventListener('click', e => { if (!e.target.classList.contains('ac-account-del')) acSetActive(i); });
    list.appendChild(div);
    const thumb = document.getElementById(`acSkinThumb_${i}`);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 36;
    canvas.style.cssText = 'width:36px;height:36px;image-rendering:pixelated;display:block;';
    thumb.appendChild(canvas);
    acGetSkin(acc, d => acDrawFace(canvas, d, acc.username + ':' + acc.type));
  });
}

function acSetActive(i)     { acCurrentAccount = acAllAccounts[i]; acSaveAccounts(); acRenderAccountList(); }
function acRemoveAccount(i) {
  acAllAccounts.splice(i, 1);
  if (acCurrentAccount && !acAllAccounts.find(a => a.username === acCurrentAccount.username && a.type === acCurrentAccount.type))
    acCurrentAccount = acAllAccounts[0] || null;
  acSaveAccounts(); acRenderAccountList();
}
function acAddAccount(acc) {
  const idx = acAllAccounts.findIndex(a => a.username === acc.username && a.type === acc.type);
  // Clear face pixel cache for this account on re-add (skin may have changed)
  for (const k of acFacePixelCache.keys()) { if (k.startsWith(acc.username + ':')) acFacePixelCache.delete(k); }
  idx >= 0 ? acAllAccounts[idx] = acc : acAllAccounts.push(acc);
  acCurrentAccount = acc;
  acSaveAccounts(); acShowTab('accounts'); acRenderAccountList();
}
function acSaveAccounts() { window.electronAPI?.saveConfig({ account: acCurrentAccount, accounts: acAllAccounts }); }
function acRenderPanel()  { acShowTab(acCurrentTab); }

function acShowError(id, msg) { const el = document.getElementById(id); if (el) { el.textContent = msg; el.classList.add('show'); } }
function acClearError(id)     { const el = document.getElementById(id); if (el) { el.textContent = ''; el.classList.remove('show'); } }

async function acLoginElyby() {
  acClearError('elybyError');
  const btn = document.querySelector('#acBodyElyby .ac-method-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('opening_browser'); }
  try {
    if (!window.electronAPI?.elybyOAuth) throw new Error(t('npm_start_warn'));
    const result = await window.electronAPI.elybyOAuth();
    if (result.error) throw new Error(result.error);
    acAddAccount({ type:'elyby', username:result.username, accessToken:result.accessToken, uuid:result.uuid });
  } catch(e) { acShowError('elybyError', e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = t('login_elyby'); } }
}

function acLoginMs() {
  acClearError('msError');
  const btn = document.querySelector('#acBodyMs .ac-method-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('opening_login'); }
  if (!window.electronAPI?.msOAuth) { acShowError('msError', t('npm_start_warn')); if (btn) { btn.disabled = false; btn.textContent = t('soc_login_ms'); } return; }
  window.electronAPI.msOAuth()
    .then(result => { if (result.error) { acShowError('msError', result.error); return; } acAddAccount({ type:'ms', username:result.username, accessToken:result.accessToken, uuid:result.uuid, refreshToken:result.refreshToken }); })
    .catch(() => acShowError('msError', t('auth_error')))
    .finally(() => { if (btn) { btn.disabled = false; btn.textContent = t('login_ms'); } });
}

function acLoginLocal() {
  acClearError('localError');
  const name = document.getElementById('localUsername').value.trim();
  if (!name) { acShowError('localError', t('local_enter_nick')); return; }
  if (name.length < 3) { acShowError('localError', t('local_min_chars')); return; }
  acAddAccount({ type:'local', username:name });
  document.getElementById('localUsername').value = '';
}

// ── Apply translations to static DOM elements ─────────────────────────────────
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  const snapNote = document.getElementById('launcherSnapNote');
  if (snapNote) snapNote.textContent = t('mp_snap_note');
}
init();
function initStopConfirmButtons() {
  const cancel = document.getElementById('scCancelBtn');
  const confirm = document.getElementById('scConfirmBtn');
  if(cancel && !cancel.textContent) cancel.textContent = t('cancel');
  if(confirm && !confirm.textContent) confirm.textContent = t('stop_btn');
}
initStopConfirmButtons();