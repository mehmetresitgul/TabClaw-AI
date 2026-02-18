// ── Stats state (must be declared before switchPanel is called) ──────
let _statsFilter = 'today';
let _statsSort   = 'time';
let _statsLiveInterval = null;

// ── Constants ──────────────────────────────────────────────────────
const DOT_HEX = {
  red:'#f87171', blue:'#60a5fa', purple:'#a78bfa', cyan:'#00E5FF',
  teal:'#2dd4bf', yellow:'#fbbf24', green:'#4ade80', orange:'#FF6B00',
  pink:'#f472b6', grey:'#6b7280'
};
const BAR_GRAD = {
  red:   'linear-gradient(90deg,#f87171,#fb923c)',
  blue:  'linear-gradient(90deg,#60a5fa,#818cf8)',
  purple:'linear-gradient(90deg,#a78bfa,#e879f9)',
  cyan:  'linear-gradient(90deg,#00E5FF,#33EBFF)',
  teal:  'linear-gradient(90deg,#2dd4bf,#22d3ee)',
  yellow:'linear-gradient(90deg,#fbbf24,#fb923c)',
  green: 'linear-gradient(90deg,#4ade80,#22d3ee)',
  orange:'linear-gradient(90deg,#FF6B00,#FF8533)',
  pink:  'linear-gradient(90deg,#f472b6,#e879f9)',
  grey:  'linear-gradient(90deg,#6b7280,#9ca3af)'
};

// ── Storage write: 100ms debounce for rapid updates; event-driven sync with dashboard
const STORAGE_BATCH_KEYS = ['tasks','taskLists','stats','siteStats','siteMeta','customCategories','customBlocklist'];
let _storageBatch = {};
let _storageFlushTimer = null;
const _rawStorageSet = chrome.storage?.local?.set?.bind(chrome.storage.local);
function _flushStorageBatch() {
  if (_storageFlushTimer) clearTimeout(_storageFlushTimer);
  _storageFlushTimer = null;
  if (Object.keys(_storageBatch).length === 0) return;
  const payload = { ..._storageBatch };
  _storageBatch = {};
  if (_rawStorageSet) _rawStorageSet(payload);
}
async function storageSet(data) {
  const batch = {};
  const imm = {};
  for (const k in data) {
    if (STORAGE_BATCH_KEYS.includes(k)) batch[k] = data[k];
    else imm[k] = data[k];
  }
  if (Object.keys(imm).length > 0 && _rawStorageSet) await new Promise((res) => _rawStorageSet(imm, res));
  if (Object.keys(batch).length > 0) {
    Object.assign(_storageBatch, batch);
    if (!_storageFlushTimer) _storageFlushTimer = setTimeout(_flushStorageBatch, 100);
  }
}

// ── Dashboard Navigation Helper ─────────────────────────────────────
function openDashboard(hash) {
  const base = chrome.runtime.getURL('dashboard.html');
  const targetUrl = hash ? base + '#/' + hash.replace(/^#?\/?/, '') : base;

  chrome.tabs.query({}, tabs => {
    const existing = tabs.find(t => t.url && t.url.startsWith(base));
    if (existing) {
      chrome.tabs.update(existing.id, { url: targetUrl, active: true });
      chrome.tabs.highlight({ tabs: [existing.index] });
      chrome.windows.update(existing.windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: targetUrl });
    }
  });
}

// ── Panel Switching ─────────────────────────────────────────────────
document.querySelectorAll('.icon-btn[data-p]').forEach(btn => {
  btn.addEventListener('click', () => switchPanel(btn.dataset.p));
});


function switchPanel(name) {
  document.querySelectorAll('.icon-btn[data-p]').forEach(b =>
    b.classList.toggle('active', b.dataset.p === name)
  );
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + name)?.classList.add('active');
  if (name === 'stats') {
    chrome.storage.local.get(['stats', 'siteStats', 'siteMeta'], () => {
      renderStats();
      _startStatsLive();
    });
  } else {
    _stopStatsLive();
  }
  if (name === 'organize') {
    renderOrganizePanel();
  }
  if (name === 'tasks') {
    chrome.storage.local.get(['tasks', 'taskLists', 'activeListId'], (d) => {
      _allTasks = d?.tasks || [];
      _taskLists = d?.taskLists || [];
      _activeListId = d?.activeListId || 'default';
      renderListSelector();
      loadDashStats();
      renderTasks();
    });
  }
  if (name === 'bookmarks') {
    initBookmarksPanel();
    renderBookmarks();
  }
}


// ── Startup: render organize panel on first open ────────────────────────
switchPanel('organize');

// ── Home (Dashboard) Button ─────────────────────────────────────────
document.getElementById('homeBtn').addEventListener('click', () => openDashboard());

// ── Bottom Nav ──────────────────────────────────────────────────────
document.getElementById('allTabsBtn').addEventListener('click', () => switchPanel('organize'));
document.getElementById('historyBtn').addEventListener('click',  () => switchPanel('stats'));

// ── Toggles ─────────────────────────────────────────────────────────
const autoToggle  = document.getElementById('autoToggle');
const focusToggle = document.getElementById('focusToggle');

chrome.storage.local.get(['autoMode', 'focusMode'], ({ autoMode, focusMode }) => {
  if (autoMode)  autoToggle.classList.add('on');
  if (focusMode) focusToggle.classList.add('on');
});
autoToggle.addEventListener('click', async () => {
  const isOn = autoToggle.classList.toggle('on');
  storageSet({ autoMode: isOn });
  if (isOn) {
    // Immediately group all currently open tabs
    const { customCategories = [] } = await chrome.storage.local.get(['customCategories']);
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const grouped = {};
    tabs.forEach(tab => {
      if (!tab.url?.startsWith('http')) return;
      const cat = classifyTabFast(tab.url, tab.title, customCategories);
      if (!grouped[cat.name]) grouped[cat.name] = { cat, tabIds: [] };
      grouped[cat.name].tabIds.push(tab.id);
    });
    for (const { cat, tabIds } of Object.values(grouped).filter(g => g.tabIds.length)) {
      try {
        const allGroups = await chrome.tabGroups.query({ windowId: tabs[0].windowId });
        const existing = allGroups.find(g => g.title === cat.name);
        if (existing) {
          await chrome.tabs.group({ tabIds, groupId: existing.id });
        } else {
          const gid = await chrome.tabs.group({ tabIds });
          await chrome.tabGroups.update(gid, { title: cat.name, color: cat.color, collapsed: false });
        }
        tabIds.forEach(id => chrome.runtime.sendMessage({ type: 'SET_TAB_CAT', tabId: id, cat: cat.name }));
      } catch(e) {}
    }
    // Only re-render organize panel if it's currently visible
    const orgPanel = document.getElementById('panel-organize');
    if (orgPanel && orgPanel.classList.contains('active')) {
      await renderOrganizePanel();
    }
  }
});
focusToggle.addEventListener('click', () => {
  storageSet({ focusMode: focusToggle.classList.toggle('on') });
});

// ── Custom Blocklist ─────────────────────────────────────────────────
document.getElementById('blocklistAddBtn').addEventListener('click', _addBlocklistDomain);
document.getElementById('blocklistInp').addEventListener('keydown', e => {
  if (e.key === 'Enter') _addBlocklistDomain();
});
renderCustomBlocklist();

// ── Tasks ───────────────────────────────────────────────────────────
let tickInterval = null;
let ctrlModeOn   = false;
let _pendingEnterTaskId = null;
let _pendingDoneTaskId  = null;
let _needsStaggerAnim   = true;
let _expandedTaskIds    = new Set();
let _collapsedSubIds    = new Set();
let _activeListId = 'default';
let _taskLists = [];
let _allTasks = [];
let _dragTaskId = null;

const DEFAULT_LIST = { id: 'default', name: 'My Tasks', color: '#00E5FF', order: 0 };

// ── Task Lists Migration & CRUD ─────────────────────────────────────
async function migrateTaskLists() {
  const data = await chrome.storage.local.get(['taskLists', 'activeListId', 'tasks']);
  let { taskLists, activeListId, tasks = [] } = data;
  let dirty = false;
  if (!taskLists || !taskLists.length) {
    taskLists = [{ ...DEFAULT_LIST }];
    dirty = true;
  }
  if (!activeListId) {
    activeListId = 'default';
    dirty = true;
  }
  // Migrate tasks without listId or with a listId pointing to a deleted list
  let tasksDirty = false;
  const validListIds = new Set(taskLists.map(l => l.id));
  tasks.forEach(t => {
    if (!t.listId || !validListIds.has(t.listId)) { t.listId = 'default'; tasksDirty = true; }
  });
  if (dirty || tasksDirty) {
    await storageSet({ taskLists, activeListId, tasks });
  }
  _taskLists = taskLists;
  _activeListId = activeListId;
  _allTasks = tasks;
  return { taskLists, activeListId, tasks };
}

async function getTaskLists() {
  const { taskLists = [{ ...DEFAULT_LIST }] } = await chrome.storage.local.get(['taskLists']);
  _taskLists = taskLists;
  return taskLists;
}

async function getActiveListId() {
  const { activeListId = 'default' } = await chrome.storage.local.get(['activeListId']);
  _activeListId = activeListId;
  return activeListId;
}

async function setActiveListId(id) {
  _activeListId = id;
  await storageSet({ activeListId: id });
  await renderListSelector();
  await renderTasks();
}

async function getAllTasks() {
  const { tasks = [] } = await chrome.storage.local.get(['tasks']);
  _allTasks = tasks;
  return tasks;
}

async function getTasks() {
  const allTasks = await getAllTasks();
  return allTasks.filter(t => t.listId === _activeListId);
}

function getTaskCountForList(listId) {
  return _allTasks.filter(t => t.listId === listId && !t.done).length;
}

async function createTaskList(name, color) {
  const lists = await getTaskLists();
  const newList = {
    id: Date.now().toString(),
    name,
    color,
    order: lists.length
  };
  lists.push(newList);
  await storageSet({ taskLists: lists });
  _taskLists = lists;
  return newList;
}

async function renameTaskList(id, newName) {
  const lists = await getTaskLists();
  const list = lists.find(l => l.id === id);
  if (!list) return;
  list.name = newName;
  await storageSet({ taskLists: lists });
  _taskLists = lists;
  await renderListSelector();
}

async function changeListColor(id, newColor) {
  const lists = await getTaskLists();
  const list = lists.find(l => l.id === id);
  if (!list) return;
  list.color = newColor;
  await storageSet({ taskLists: lists });
  _taskLists = lists;
  await renderListSelector();
}

async function deleteTaskList(id, moveTasks) {
  if (id === 'default') return; // Can't delete default
  const lists = await getTaskLists();
  const allTasks = await getAllTasks();
  if (moveTasks) {
    allTasks.forEach(t => { if (t.listId === id) t.listId = 'default'; });
  } else {
    const filtered = allTasks.filter(t => t.listId !== id);
    allTasks.length = 0;
    allTasks.push(...filtered);
  }
  const newLists = lists.filter(l => l.id !== id);
  await storageSet({ taskLists: newLists, tasks: allTasks });
  _taskLists = newLists;
  _allTasks = allTasks;
  if (_activeListId === id) {
    await setActiveListId('default');
  } else {
    await renderListSelector();
    await renderTasks();
  }
}

async function moveTaskToList(taskId, targetListId) {
  const allTasks = await getAllTasks();
  const task = allTasks.find(t => t.id === taskId);
  if (!task || task.listId === targetListId) return;
  // If moving the active task, stop timer
  const { activeTaskId } = await chrome.storage.local.get(['activeTaskId']);
  if (taskId === activeTaskId) {
    stopTick();
    chrome.runtime.sendMessage({ type: 'STOP_POMODORO' });
    ctrlModeOn = false;
    await storageSet({ activeTaskId: null, pomodoroState: null });
  }
  task.listId = targetListId;
  await storageSet({ tasks: allTasks });
  _allTasks = allTasks;
  await renderListSelector();
  await renderTasks();
}

// ── List Selector UI ────────────────────────────────────────────────
async function renderListSelector() {
  const lists = await getTaskLists();
  await getAllTasks(); // refresh _allTasks
  const activeList = lists.find(l => l.id === _activeListId) || lists[0] || DEFAULT_LIST;

  const dot   = document.getElementById('listSelDot');
  const name  = document.getElementById('listSelName');
  const count = document.getElementById('listSelCount');
  if (dot)   dot.style.background = activeList.color;
  if (name)  name.textContent = activeList.name;
  const activeCount = _allTasks.filter(t => t.listId === _activeListId && !t.done).length;
  if (count) count.textContent = activeCount;
}

function renderListDropdown() {
  const dd = document.getElementById('listDropdown');
  if (!dd) return;

  const menuSvg = '<svg fill="none" viewBox="0 0 16 16"><circle cx="8" cy="3.5" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="12.5" r="1.2" fill="currentColor"/></svg>';

  dd.innerHTML = _taskLists.map(list => {
    const cnt = getTaskCountForList(list.id);
    const isActive = list.id === _activeListId;
    return `<div class="list-dd-item${isActive ? ' active' : ''}" data-list-id="${list.id}">
      <div class="list-dd-dot" style="background:${list.color}"></div>
      <span class="list-dd-name">${list.name}</span>
      <span class="list-dd-count">${cnt}</span>
      <button class="list-dd-menu-btn" data-list-menu="${list.id}" title="Menu">${menuSvg}</button>
    </div>`;
  }).join('') +
  `<div class="list-dd-sep"></div>
   <div class="list-dd-new" id="listDdNew">
     <svg fill="none" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
     New List
   </div>`;

  // Events
  dd.querySelectorAll('.list-dd-item').forEach(item => {
    // Click to switch list
    item.addEventListener('click', (e) => {
      if (e.target.closest('.list-dd-menu-btn')) return;
      const listId = item.dataset.listId;
      toggleListDropdown(false);
      setActiveListId(listId);
    });

    // Drag-drop target
    item.addEventListener('dragover', e => {
      e.preventDefault();
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });
    item.addEventListener('drop', e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (_dragTaskId) {
        moveTaskToList(_dragTaskId, item.dataset.listId);
        _dragTaskId = null;
        toggleListDropdown(false);
      }
    });

    // Menu button
    const menuBtn = item.querySelector('.list-dd-menu-btn');
    if (menuBtn) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showListContextMenu(menuBtn.dataset.listMenu, item);
      });
    }
  });

  // New list button
  const newBtn = dd.querySelector('#listDdNew');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      toggleListDropdown(false);
      showListModal('create');
    });
  }
}

function toggleListDropdown(forceState) {
  const dd = document.getElementById('listDropdown');
  const sel = document.getElementById('listSelector');
  if (!dd) return;
  const isOpen = typeof forceState === 'boolean' ? forceState : !dd.classList.contains('open');
  dd.classList.toggle('open', isOpen);
  sel?.classList.toggle('open', isOpen);
  if (isOpen) {
    renderListDropdown();
  }
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dd = document.getElementById('listDropdown');
  if (dd?.classList.contains('open') && !e.target.closest('.list-selector') && !e.target.closest('.list-dropdown') && !e.target.closest('.list-ctx-menu')) {
    toggleListDropdown(false);
  }
  // Close context menus
  document.querySelectorAll('.list-ctx-menu.open').forEach(m => m.classList.remove('open'));
});

// List selector click
document.getElementById('listSelector')?.addEventListener('click', () => {
  toggleListDropdown();
});

// ── List Context Menu ───────────────────────────────────────────────
function showListContextMenu(listId, anchorEl) {
  // Remove existing menus
  document.querySelectorAll('.list-ctx-menu').forEach(m => m.remove());

  const isDefault = listId === 'default';
  const renameSvg = '<svg fill="none" viewBox="0 0 14 14"><path d="M8.5 2.5l3 3M2 9l6.5-6.5 3 3L5 12H2V9z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const colorSvg  = '<svg fill="none" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="2.5" fill="currentColor" opacity="0.4"/></svg>';
  const deleteSvg = '<svg fill="none" viewBox="0 0 14 14"><path d="M3.5 4.5h7M5 4.5V3.5a1 1 0 011-1h2a1 1 0 011 1v1M5.5 6.5v4M8.5 6.5v4M4.5 4.5l.5 7h4l.5-7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const menu = document.createElement('div');
  menu.className = 'list-ctx-menu';
  menu.innerHTML = `
    <div class="list-ctx-item" data-ctx="rename">${renameSvg} Rename</div>
    <div class="list-ctx-item" data-ctx="color">${colorSvg} Change Color</div>
    ${!isDefault ? `<div class="list-ctx-item danger" data-ctx="delete">${deleteSvg} Delete</div>` : ''}
  `;

  anchorEl.style.position = 'relative';
  anchorEl.appendChild(menu);
  requestAnimationFrame(() => menu.classList.add('open'));

  menu.querySelectorAll('.list-ctx-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = item.dataset.ctx;
      menu.classList.remove('open');
      setTimeout(() => menu.remove(), 150);
      toggleListDropdown(false);

      if (action === 'rename') showListModal('rename', listId);
      if (action === 'color')  showListModal('color', listId);
      if (action === 'delete') showListModal('delete', listId);
    });
  });
}

// ── List Modal ──────────────────────────────────────────────────────
function showListModal(mode, listId) {
  const overlay = document.getElementById('listModalOverlay');
  const title   = document.getElementById('listModalTitle');
  const body    = document.getElementById('listModalBody');
  const actions = document.getElementById('listModalActions');
  if (!overlay) return;

  const list = _taskLists.find(l => l.id === listId);
  const colors = Object.values(DOT_HEX);
  let selectedColor = list?.color || colors[0];

  function colorGrid() {
    return `<div class="list-color-label">Color</div>
    <div class="list-color-grid">${colors.map(c =>
      `<div class="list-color-opt${c === selectedColor ? ' selected' : ''}" data-color="${c}" style="background:${c}"></div>`
    ).join('')}</div>`;
  }

  function wireColorGrid() {
    body.querySelectorAll('.list-color-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        body.querySelectorAll('.list-color-opt').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        selectedColor = opt.dataset.color;
      });
    });
  }

  if (mode === 'create') {
    title.textContent = 'New List';
    body.innerHTML = `<input class="list-modal-input" id="listModalInput" placeholder="List name..." autocomplete="off"/>${colorGrid()}`;
    actions.innerHTML = `<button class="list-modal-btn cancel" id="listModalCancel">Cancel</button><button class="list-modal-btn primary" id="listModalOk">Create</button>`;
    wireColorGrid();
    const okBtn = document.getElementById('listModalOk');
    const inp   = document.getElementById('listModalInput');
    okBtn.addEventListener('click', async () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      const newList = await createTaskList(name, selectedColor);
      closeListModal();
      await setActiveListId(newList.id);
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') okBtn.click(); if (e.key === 'Escape') closeListModal(); });
    setTimeout(() => inp.focus(), 100);
  }

  if (mode === 'rename') {
    title.textContent = 'Rename List';
    body.innerHTML = `<input class="list-modal-input" id="listModalInput" value="${list?.name || ''}" autocomplete="off"/>`;
    actions.innerHTML = `<button class="list-modal-btn cancel" id="listModalCancel">Cancel</button><button class="list-modal-btn primary" id="listModalOk">Save</button>`;
    const okBtn = document.getElementById('listModalOk');
    const inp   = document.getElementById('listModalInput');
    okBtn.addEventListener('click', async () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      await renameTaskList(listId, name);
      closeListModal();
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') okBtn.click(); if (e.key === 'Escape') closeListModal(); });
    setTimeout(() => { inp.focus(); inp.select(); }, 100);
  }

  if (mode === 'color') {
    title.textContent = 'Change Color';
    body.innerHTML = colorGrid();
    actions.innerHTML = `<button class="list-modal-btn cancel" id="listModalCancel">Cancel</button><button class="list-modal-btn primary" id="listModalOk">Save</button>`;
    wireColorGrid();
    document.getElementById('listModalOk').addEventListener('click', async () => {
      await changeListColor(listId, selectedColor);
      closeListModal();
    });
  }

  if (mode === 'delete') {
    const taskCount = _allTasks.filter(t => t.listId === listId).length;
    title.textContent = 'Delete List';
    body.innerHTML = `<div class="list-modal-msg">Are you sure you want to delete "<strong>${list?.name || ''}</strong>"?${taskCount > 0 ? ` This list has <strong>${taskCount}</strong> task(s).` : ''}</div>`;
    actions.innerHTML = taskCount > 0
      ? `<button class="list-modal-btn cancel" id="listModalCancel">Cancel</button><button class="list-modal-btn primary" id="listModalMove">Move Tasks</button><button class="list-modal-btn danger" id="listModalDelAll">Delete All</button>`
      : `<button class="list-modal-btn cancel" id="listModalCancel">Cancel</button><button class="list-modal-btn danger" id="listModalDelAll">Delete</button>`;

    document.getElementById('listModalMove')?.addEventListener('click', async () => {
      await deleteTaskList(listId, true);
      closeListModal();
    });
    document.getElementById('listModalDelAll')?.addEventListener('click', async () => {
      await deleteTaskList(listId, false);
      closeListModal();
    });
  }

  // Cancel button
  document.getElementById('listModalCancel')?.addEventListener('click', closeListModal);
  // Backdrop close
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeListModal(); });

  overlay.classList.add('open');
}

function closeListModal() {
  document.getElementById('listModalOverlay')?.classList.remove('open');
}

function calcRemaining(ps) {
  if (!ps) return 0;
  if (ps.running) return Math.max(0, ps.endTime - Date.now());
  return ps.remainingMs ?? (ps.workDuration * 60000);
}


async function renderTasks() {
  const [tasks, { activeTaskId, pomodoroState: ps }] = await Promise.all([
    getTasks(),
    chrome.storage.local.get(['activeTaskId', 'pomodoroState'])
  ]);

  const list = document.getElementById('taskList');

  if (!tasks.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon"><svg fill="none" viewBox="0 0 18 18"><rect x="2" y="2" width="14" height="14" rx="3" stroke="currentColor" stroke-width="1.3"/><path d="M6 9h6M6 6.5h6M6 11.5h3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></div>
      <div class="empty-text">No tasks yet.<br>Add one to get started.</div>
    </div>`;
    updateProgress(tasks);
    return;
  }

  list.innerHTML = tasks.map(task => {
    const isActive   = task.id === activeTaskId;
    const isExpanded = _expandedTaskIds.has(task.id);
    const subCollapsed = _collapsedSubIds.has(task.id);
    const cls = ['task-card', isActive ? 'active' : '', task.done ? 'done' : '', isExpanded ? 'expanded' : ''].filter(Boolean).join(' ');

    let timeStr  = fmtEstTimeDisplay(task.estimatedMin) || '25min';
    let isPaused = false;
    if (isActive && ps) {
      const rem = calcRemaining(ps);
      const m = Math.floor(rem / 60000), s = Math.floor((rem % 60000) / 1000);
      timeStr  = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      isPaused = !ps.running;
    }

    const pauseIcon = isPaused
      ? '<svg fill="none" viewBox="0 0 16 16"><path d="M5.5 3L12.5 8L5.5 13V3Z" fill="currentColor"/></svg>'
      : '<svg fill="none" viewBox="0 0 16 16"><rect x="3.5" y="3" width="3" height="10" rx="0.8" fill="currentColor"/><rect x="9.5" y="3" width="3" height="10" rx="0.8" fill="currentColor"/></svg>';
    const chkSvg  = '<svg fill="none" viewBox="0 0 11 11"><path d="M2 5.8L4.5 8L9 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const delSvg  = '<svg fill="none" viewBox="0 0 14 14"><path d="M3.5 4.5h7M5 4.5V3.5a1 1 0 011-1h2a1 1 0 011 1v1M5.5 6.5v4M8.5 6.5v4M4.5 4.5l.5 7h4l.5-7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const stopSvg = '<svg fill="none" viewBox="0 0 14 14"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
    const playSvg = '<svg fill="none" viewBox="0 0 16 16"><path d="M4.5 3.2L13 8L4.5 12.8V3.2Z" fill="currentColor"/></svg>';
    const dragSvg = '<svg fill="none" viewBox="0 0 10 16"><circle cx="3" cy="4.5" r="1.2" fill="currentColor"/><circle cx="7" cy="4.5" r="1.2" fill="currentColor"/><circle cx="3" cy="8" r="1.2" fill="currentColor"/><circle cx="7" cy="8" r="1.2" fill="currentColor"/><circle cx="3" cy="11.5" r="1.2" fill="currentColor"/><circle cx="7" cy="11.5" r="1.2" fill="currentColor"/></svg>';
    const chevSvg = '<svg fill="none" viewBox="0 0 12 12"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const pinSvg = '<svg fill="none" viewBox="0 0 12 12"><circle cx="6" cy="3.5" r="1.8" stroke="currentColor" stroke-width="1.2"/><path d="M5.2 5.2L6 10l.8-4.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const linkSvg = '<svg fill="none" viewBox="0 0 16 16"><path d="M6.5 9.5a3.5 3.5 0 004.95 0l2-2a3.5 3.5 0 00-4.95-4.95l-1 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M9.5 6.5a3.5 3.5 0 00-4.95 0l-2 2a3.5 3.5 0 004.95 4.95l1-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

    // Subtasks
    const subtasks  = task.subtasks || [];
    const doneSubs  = subtasks.filter(s => s.done).length;
    const totalSubs = subtasks.length;
    const subtasksHtml = subtasks.map(sub => `
      <div class="task-sub-item${sub.done ? ' sub-done' : ''}" data-sub-id="${sub.id}">
        <button class="task-sub-chk">${sub.done ? chkSvg : ''}</button>
        <input class="task-sub-title" type="text" value="${escHtml(sub.title)}"${sub.done ? ' readonly' : ''}>
        <button class="task-sub-del" data-sub-id="${sub.id}"><svg fill="none" viewBox="0 0 10 10"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
      </div>`).join('');

    // Attach
    let attachedHostname = '';
    if (task.attachedUrl) { try { attachedHostname = new URL(task.attachedUrl).hostname; } catch { attachedHostname = escHtml(task.attachedUrl); } }
    const attachHtml = task.attachedUrl && safeUrl(task.attachedUrl)
      ? `<div class="task-attached">${linkSvg}<a class="task-attached-link" href="${safeUrl(task.attachedUrl)}" target="_blank" title="${escHtml(task.attachedUrl)}">${escHtml(task.attachedTitle || attachedHostname)}</a><button class="task-detach-btn">×</button></div>`
      : `<button class="task-attach-btn">${linkSvg}<span>Attach current tab</span></button>`;

    // AI Resource URLs
    const resourceUrls = task.resourceUrls || [];
    const resourceUrlsHtml = resourceUrls.length
      ? `<div class="task-resources">
          <div class="task-resources-hdr">${linkSvg}<span>Resources</span></div>
          ${resourceUrls.map(r => {
            let host = r.url;
            try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
            return `<a class="task-resource-link" href="${safeUrl(r.url)}" target="_blank" title="${escHtml(r.url)}"><span class="task-resource-label">${escHtml(r.title)}</span><span class="task-resource-host">${escHtml(host)}</span></a>`;
          }).join('')}
        </div>`
      : '';

    return `<div class="${cls}" data-id="${task.id}" draggable="true">
      <div class="task-main">
        <div class="task-drag-handle">${dragSvg}</div>
        <button class="task-chk" data-id="${task.id}">${chkSvg}</button>
        <div class="task-info">
          <input class="task-title" type="text" value="${escHtml(task.title)}" title="${escHtml(task.title)}"${task.done ? ' readonly' : ''}>
        </div>
        <div class="task-time-slot">
          <span class="paused-tag" ${!isPaused ? 'style="visibility:hidden" aria-hidden="true"' : ''}>PAUSED</span>
          <span class="task-time" id="td-${task.id}">${timeStr}</span>
        </div>
        <div class="task-btn-row">
          <span class="task-expand-btn${isExpanded ? ' open' : ''}" title="Pin">${pinSvg}</span>
          <span class="task-del" data-id="${task.id}" title="${isActive ? 'Stop' : 'Delete'}">${isActive ? stopSvg : delSvg}</span>
          <span class="task-start${!isActive && !task.done ? '' : ' task-start-hidden'}" data-id="${task.id}" title="Start">${playSvg}</span>
        </div>
      </div>
      <div class="task-detail">
        <div class="task-detail-inner">
          <div class="task-subtasks-section">
            <div class="task-subtasks-hdr">
              <span class="task-subtasks-count"><svg class="sub-ring" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2"/><circle cx="10" cy="10" r="8" fill="none" stroke="var(--cyan)" stroke-width="2" stroke-linecap="round" stroke-dasharray="${2 * Math.PI * 8}" stroke-dashoffset="${totalSubs ? 2 * Math.PI * 8 * (1 - doneSubs / totalSubs) : 2 * Math.PI * 8}" style="transform:rotate(-90deg);transform-origin:center;transition:stroke-dashoffset 0.3s"/></svg>${doneSubs}/${totalSubs} Subtasks</span>
              <button class="task-add-sub-btn" title="Add subtask"><svg fill="none" viewBox="0 0 12 12"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
              <button class="task-toggle-subs-btn${subCollapsed ? ' collapsed' : ''}" title="Toggle">${chevSvg}</button>
            </div>
            <div class="task-subtasks-list${subCollapsed ? ' sub-hidden' : ''}">
              ${subtasksHtml}
              <div class="task-sub-input-row" style="display:none">
                <input class="task-sub-input" placeholder="Subtask name..." maxlength="100"/>
                <button class="task-sub-input-ok">${chkSvg}</button>
              </div>
            </div>
          </div>
          <div class="task-attach-section">${attachHtml}</div>
          ${resourceUrlsHtml}
        </div>
      </div>
      <div class="task-ctrls">
        <button class="ctrl-btn" data-action="break" title="Break"><svg fill="none" viewBox="0 0 16 16"><path d="M3 3h7v5.5a3.5 3.5 0 01-3.5 3.5h0A3.5 3.5 0 013 8.5V3z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M10 5h1.5a2 2 0 010 4H10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M4 14h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
        <button class="ctrl-btn" data-action="pause" title="${isPaused ? 'Resume' : 'Pause'}">${pauseIcon}</button>
        <button class="ctrl-btn" data-action="skip" title="Skip"><svg fill="none" viewBox="0 0 16 16"><path d="M3 3l6 5-6 5V3z" fill="currentColor"/><rect x="11" y="3" width="2" height="10" rx="0.5" fill="currentColor"/></svg></button>
        <button class="ctrl-btn del-ctrl-btn" data-action="delete" title="Delete">${delSvg}</button>
        <button class="ctrl-btn done-btn" data-action="done" title="Complete"><svg fill="none" viewBox="0 0 16 16"><path d="M3 8.5L6.5 12L13 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>`;
  }).join('');

  // ── Post-render animations ──

  // Staggered entrance on initial load (all cards slide in sequentially)
  if (_needsStaggerAnim) {
    const cards = list.querySelectorAll('.task-card');
    cards.forEach((card, i) => {
      card.style.animationDelay = `${i * 70 + 30}ms`;
      card.classList.add('stagger-in');
      card.addEventListener('animationend', () => {
        card.classList.remove('stagger-in');
        card.style.animationDelay = '';
      }, { once: true });
    });
    _needsStaggerAnim = false;
  }

  // Single new task entering
  if (_pendingEnterTaskId) {
    const el = list.querySelector(`[data-id="${_pendingEnterTaskId}"]`);
    if (el) {
      el.classList.add('entering');
      el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });
    }
    _pendingEnterTaskId = null;
  }

  // Done task flash
  if (_pendingDoneTaskId) {
    const el = list.querySelector(`[data-id="${_pendingDoneTaskId}"]`);
    if (el) {
      el.classList.add('card-done-flash');
      el.addEventListener('animationend', () => el.classList.remove('card-done-flash'), { once: true });
    }
    _pendingDoneTaskId = null;
  }

  // Attach events
  list.querySelectorAll('.task-card').forEach(card => {
    const id       = card.dataset.id;
    const isActive = id === activeTaskId;

    // Drag events for moving between lists
    card.addEventListener('dragstart', (e) => {
      _dragTaskId = id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Open dropdown so user can drop on a list
      setTimeout(() => toggleListDropdown(true), 200);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      _dragTaskId = null;
    });

    card.querySelector('.task-chk').addEventListener('click', e => {
      e.stopPropagation();
      if (!card.classList.contains('done')) {
        const chk = card.querySelector('.task-chk');
        chk.classList.remove('pop');
        void chk.offsetWidth; // restart animation
        chk.classList.add('pop');
        card.classList.add('card-done-flash');
        _pendingDoneTaskId = id;
        launchConfetti(chk);
        playSound('complete');
        setTimeout(() => toggleDone(id), 200);
      } else {
        toggleDone(id);
      }
    });

    // Start button
    const startBtn = card.querySelector('.task-start');
    if (startBtn) {
      startBtn.addEventListener('click', e => { e.stopPropagation(); startTaskTimer(id); });
    }

    // Expand/collapse detail
    card.querySelector('.task-expand-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      if (_expandedTaskIds.has(id)) { _expandedTaskIds.delete(id); card.classList.remove('expanded'); card.querySelector('.task-expand-btn').classList.remove('open'); }
      else { _expandedTaskIds.add(id); card.classList.add('expanded'); card.querySelector('.task-expand-btn').classList.add('open'); }
    });

    // Add subtask
    card.querySelector('.task-add-sub-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const row = card.querySelector('.task-sub-input-row');
      if (row) { row.style.display = 'flex'; row.querySelector('.task-sub-input')?.focus(); }
    });

    // Subtask input confirm
    const subInput = card.querySelector('.task-sub-input');
    if (subInput) {
      const confirmSub = () => { const t = subInput.value.trim(); if (t) addSubtask(id, t); };
      card.querySelector('.task-sub-input-ok')?.addEventListener('click', e => { e.stopPropagation(); confirmSub(); });
      subInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.stopPropagation(); confirmSub(); } });
      subInput.addEventListener('click', e => e.stopPropagation());
    }

    // Toggle subtask list
    card.querySelector('.task-toggle-subs-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const lst = card.querySelector('.task-subtasks-list');
      const btn = card.querySelector('.task-toggle-subs-btn');
      if (_collapsedSubIds.has(id)) { _collapsedSubIds.delete(id); lst?.classList.remove('sub-hidden'); btn.classList.remove('collapsed'); }
      else { _collapsedSubIds.add(id); lst?.classList.add('sub-hidden'); btn.classList.add('collapsed'); }
    });

    // Subtask checkboxes
    card.querySelectorAll('.task-sub-chk').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); const subId = btn.closest('.task-sub-item')?.dataset.subId; if (subId) toggleSubtask(id, subId); });
    });
    card.querySelectorAll('.task-sub-del').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); if (btn.dataset.subId) deleteSubtask(id, btn.dataset.subId); });
    });

    // Inline-edit: task title
    const titleInp = card.querySelector('.task-title');
    if (titleInp && !card.classList.contains('done')) {
      const origTitle = tasks.find(t => t.id === id)?.title || '';
      titleInp.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter')  { e.preventDefault(); titleInp.blur(); }
        if (e.key === 'Escape') { titleInp.value = origTitle; titleInp.blur(); }
      });
      titleInp.addEventListener('blur', async () => {
        const newTitle = titleInp.value.trim();
        if (!newTitle || newTitle === origTitle) { titleInp.value = origTitle; return; }
        titleInp.title = newTitle;
        await renameTask(id, newTitle);
      });
    }

    // Inline-edit: subtask titles
    card.querySelectorAll('.task-sub-title').forEach(inp => {
      if (inp.readOnly) return;
      const subId = inp.closest('.task-sub-item')?.dataset.subId;
      if (!subId) return;
      const origSubTitle = tasks.find(t => t.id === id)?.subtasks?.find(s => s.id === subId)?.title || '';
      inp.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter')  { e.preventDefault(); inp.blur(); }
        if (e.key === 'Escape') { inp.value = origSubTitle; inp.blur(); }
      });
      inp.addEventListener('blur', async () => {
        const newTitle = inp.value.trim();
        if (!newTitle || newTitle === origSubTitle) { inp.value = origSubTitle; return; }
        await renameSubtask(id, subId, newTitle);
      });
    });

    // Attach / detach tab
    card.querySelector('.task-attach-btn')?.addEventListener('click', e => { e.stopPropagation(); attachTab(id); });
    card.querySelector('.task-detach-btn')?.addEventListener('click', e => { e.stopPropagation(); detachTab(id); });
    card.querySelector('.task-attached-link')?.addEventListener('click', e => e.stopPropagation());

    // Delete button
    const delBtn = card.querySelector('.task-del');
    if (delBtn) {
      delBtn.addEventListener('click', async e => {
        e.stopPropagation();
        if (isActive) {
          stopTick();
          chrome.runtime.sendMessage({ type: 'STOP_POMODORO' });
          await storageSet({ activeTaskId: null, pomodoroState: null });
          await renderTasks();
        } else {
          card.style.pointerEvents = 'none';
          deleteTask(id);
        }
      });
    }

    // getBoundingClientRect-based hover — bypasses browser hover system entirely.
    // A single mousemove on the container checks which button physically contains
    // the cursor. No mouseenter/mouseleave on individual buttons, no flicker.
    const btnRow  = card.querySelector('.task-btn-row');
    const rowBtns = Array.from(btnRow.querySelectorAll('.task-expand-btn, .task-del, .task-start'));
    const chkBtn  = card.querySelector('.task-chk');

    const BTN_HIGHLIGHT = {
      'task-start':      { color: 'var(--cyan)',   background: 'rgba(0,229,255,0.08)' },
      'task-expand-btn': { color: 'var(--text-2)', background: 'rgba(255,255,255,0.05)' },
      'task-del':        { color: 'var(--red)',     background: 'rgba(239,68,68,0.08)' },
    };

    const showRowBtns = () => rowBtns.forEach(b => {
      if (!b.classList.contains('task-start-hidden')) b.style.opacity = '1';
    });
    const hideRowBtns = () => {
      if (!card.classList.contains('expanded')) rowBtns.forEach(b => { b.style.opacity = '0'; });
    };
    const clearAllHighlights = () => rowBtns.forEach(b => { b.style.color = ''; b.style.background = ''; });

    card.addEventListener('mouseenter', showRowBtns);
    card.addEventListener('mouseleave', () => { hideRowBtns(); clearAllHighlights(); });

    btnRow.addEventListener('mousemove', e => {
      const mx = e.clientX, my = e.clientY;
      for (const btn of rowBtns) {
        const r = btn.getBoundingClientRect();
        if (mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom) {
          const key = [...btn.classList].find(c => BTN_HIGHLIGHT[c]);
          if (key) { btn.style.color = BTN_HIGHLIGHT[key].color; btn.style.background = BTN_HIGHLIGHT[key].background; }
        } else {
          btn.style.color = ''; btn.style.background = '';
        }
      }
    });
    btnRow.addEventListener('mouseleave', clearAllHighlights);

    // stopPropagation on mouseenter/mouseleave for every action button
    rowBtns.forEach(btn => {
      btn.addEventListener('mouseenter', e => e.stopPropagation());
      btn.addEventListener('mouseleave', e => e.stopPropagation());
    });

    // Checkbox — separate element, mouseenter/mouseleave is fine (no sibling layout shift)
    chkBtn.addEventListener('mouseenter', e => {
      e.stopPropagation();
      chkBtn.style.borderColor = 'var(--cyan)';
      chkBtn.style.background  = 'rgba(0,229,255,0.08)';
      const svg = chkBtn.querySelector('svg'); if (svg) svg.style.opacity = '0.4';
    });
    chkBtn.addEventListener('mouseleave', e => {
      e.stopPropagation();
      chkBtn.style.borderColor = ''; chkBtn.style.background = '';
      const svg = chkBtn.querySelector('svg'); if (svg) svg.style.opacity = '';
    });

    // Initialise visibility for cards already expanded or done at render time
    if (card.classList.contains('expanded')) showRowBtns();
    if (card.classList.contains('done')) {
      const d = card.querySelector('.task-del'); if (d) d.style.opacity = '0.5';
    }

    if (card.classList.contains('done')) return;

    if (isActive) {
      card.querySelector('.task-main').addEventListener('click', () => {
        ctrlModeOn = !ctrlModeOn;
        card.classList.toggle('ctrl-mode', ctrlModeOn);
      });
      card.querySelectorAll('.ctrl-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const a = btn.dataset.action;
          if (a === 'break') handleBreak();
          if (a === 'pause') handlePauseResume();
          if (a === 'skip')  handleSkip();
          if (a === 'delete') deleteTask(id);
          if (a === 'done') { _pendingDoneTaskId = id; launchConfetti(btn); playSound('complete'); completeTask(id); }
        });
      });
      if (ctrlModeOn) card.classList.add('ctrl-mode');
    } else {
      card.addEventListener('click', e => {
        if (e.target.closest('.task-chk') || e.target.closest('.task-del') || e.target.closest('.task-start') || e.target.closest('.task-expand-btn') || e.target.closest('.task-detail') || e.target.closest('.task-title')) return;
        startTaskTimer(id);
      });
    }
  });

  updateProgress(tasks);
  loadDashStats();
}

async function startTaskTimer(taskId) {
  const tasks = await getTasks();
  const task  = tasks.find(t => t.id === taskId);
  if (!task) return;

  stopTick();
  chrome.runtime.sendMessage({ type: 'STOP_POMODORO' });
  ctrlModeOn = false;

  const ps = {
    phase: 'work', workDuration: task.estimatedMin, breakDuration: 5,
    endTime: Date.now() + task.estimatedMin * 60000, running: true, sessions: 0,
    sessionStartTime: Date.now()
  };
  await storageSet({ activeTaskId: taskId, pomodoroState: ps });
  chrome.runtime.sendMessage({ type: 'START_POMODORO' });
  await renderTasks();
  const _startCard = document.querySelector('.task-card.active');
  if (_startCard) {
    _startCard.classList.add('anim-start');
    _startCard.addEventListener('animationend', () => _startCard.classList.remove('anim-start'), { once: true });
  }
  playSound('start');
  startTick();
}

function startTick() {
  stopTick();
  tickInterval = setInterval(tick, 1000);
}
function stopTick() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

async function tick() {
  const { pomodoroState: ps, activeTaskId } = await chrome.storage.local.get(['pomodoroState', 'activeTaskId']);
  if (!ps || !activeTaskId) return;

  const el = document.getElementById(`td-${activeTaskId}`);
  if (!el) return;

  // Always show remaining time (running or paused)
  const rem = calcRemaining(ps);
  const m   = Math.floor(rem / 60000);
  const s   = Math.floor((rem % 60000) / 1000);
  el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

  // Urgency: cyan → accent when under 5 min
  if (ps.running && rem <= 300000) {
    el.style.color = '#FF6B00';
    el.style.textShadow = '0 0 18px rgba(255,107,0,0.45)';
  } else {
    el.style.color = '';
    el.style.textShadow = '';
  }

  // When time expires: work → complete task; break → stop timer (do not auto-start new work)
  const expired = ps.endTime - Date.now() <= 0;
  if (expired) {
    if (ps.phase === 'work') {
      el.textContent = '00:00';
      el.style.color = '';
      el.style.textShadow = '';
      stopTick();
      chrome.runtime.sendMessage({ type: 'STOP_POMODORO' });
      playSound('complete');
      await finishTaskWithCelebration(activeTaskId);
    } else {
      // break ended — stop timer, do not auto-start a new work session
      stopTick();
      chrome.runtime.sendMessage({ type: 'STOP_POMODORO' });
      await storageSet({ activeTaskId: null, pomodoroState: null });
      await renderTasks();
    }
  }
}

async function handlePauseResume() {
  const { pomodoroState: ps } = await chrome.storage.local.get(['pomodoroState']);
  if (!ps) return;
  let wasPausing = false;
  if (ps.running) {
    wasPausing = true;
    const { activeTaskId } = await chrome.storage.local.get(['activeTaskId']);
    if (ps.sessionStartTime && activeTaskId) await updateTaskTime(activeTaskId, Date.now() - ps.sessionStartTime);
    const remaining = Math.max(0, ps.endTime - Date.now());
    await storageSet({ pomodoroState: { ...ps, running: false, remainingMs: remaining, sessionStartTime: null } });
    chrome.runtime.sendMessage({ type: 'STOP_POMODORO' });
    stopTick();
  } else {
    const newEnd = Date.now() + (ps.remainingMs ?? ps.workDuration * 60000);
    await storageSet({ pomodoroState: { ...ps, running: true, endTime: newEnd, sessionStartTime: Date.now() } });
    chrome.runtime.sendMessage({ type: 'START_POMODORO' });
    startTick();
  }
  await renderTasks();
  const _animCard = document.querySelector('.task-card.active');
  if (_animCard) {
    const cls = wasPausing ? 'anim-pause' : 'anim-start';
    _animCard.classList.remove('anim-start', 'anim-pause');
    void _animCard.offsetWidth;
    _animCard.classList.add(cls);
    _animCard.addEventListener('animationend', () => _animCard.classList.remove(cls), { once: true });
  }
  playSound(wasPausing ? 'pause' : 'start');
}

async function handleSkip() {
  const { pomodoroState: ps } = await chrome.storage.local.get(['pomodoroState']);
  if (!ps) return;
  // Flush time for current phase before skipping
  if (ps.phase === 'work' && ps.sessionStartTime) {
    const { activeTaskId } = await chrome.storage.local.get(['activeTaskId']);
    if (activeTaskId) await updateTaskTime(activeTaskId, Date.now() - ps.sessionStartTime);
  }
  const wasWork  = ps.phase === 'work';
  const sessions = wasWork ? (ps.sessions || 0) + 1 : (ps.sessions || 0);
  const next     = wasWork ? 'break' : 'work';
  const dur      = next === 'work' ? ps.workDuration : ps.breakDuration;
  await storageSet({
    pomodoroState: { ...ps, phase: next, sessions, endTime: Date.now() + dur * 60000, running: true, sessionStartTime: Date.now() }
  });
  await renderTasks();
}

async function handleBreak() {
  const { pomodoroState: ps, activeTaskId } = await chrome.storage.local.get(['pomodoroState', 'activeTaskId']);
  if (!ps) return;
  // B6: Save elapsed work time before manually switching to break
  if (ps.phase === 'work' && ps.sessionStartTime && activeTaskId) {
    await updateTaskTime(activeTaskId, Date.now() - ps.sessionStartTime);
  }
  await storageSet({
    pomodoroState: { ...ps, phase: 'break', endTime: Date.now() + ps.breakDuration * 60000, running: true, sessionStartTime: null }
  });
  await renderTasks();
}

async function updateTaskTime(taskId, ms) {
  if (!ms || ms < 1000) return;
  const tasks = await getAllTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const today = new Date().toISOString().slice(0, 10);
  tasks[idx].workMs = (tasks[idx].workMs || 0) + ms;
  if (tasks[idx].todayDate === today) {
    tasks[idx].todayMs = (tasks[idx].todayMs || 0) + ms;
  } else {
    tasks[idx].todayDate = today;
    tasks[idx].todayMs = ms;
  }
  await storageSet({ tasks });
  _allTasks = tasks;
}

async function addSubtask(taskId, title) {
  const tasks = await getAllTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  if (!tasks[idx].subtasks) tasks[idx].subtasks = [];
  tasks[idx].subtasks.push({ id: Date.now().toString(36), title, done: false });
  await storageSet({ tasks });
  _allTasks = tasks;
  _expandedTaskIds.add(taskId);
  await renderTasks();
}

async function toggleSubtask(taskId, subtaskId) {
  const tasks = await getAllTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const sub = (tasks[idx].subtasks || []).find(s => s.id === subtaskId);
  if (sub) sub.done = !sub.done;
  await storageSet({ tasks });
  _allTasks = tasks;
  _expandedTaskIds.add(taskId);
  await renderTasks();
}

async function deleteSubtask(taskId, subtaskId) {
  const tasks = await getAllTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  tasks[idx].subtasks = (tasks[idx].subtasks || []).filter(s => s.id !== subtaskId);
  await storageSet({ tasks });
  _allTasks = tasks;
  _expandedTaskIds.add(taskId);
  await renderTasks();
}

async function attachTab(taskId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;
  const tasks = await getAllTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  tasks[idx].attachedUrl   = tab.url;
  tasks[idx].attachedTitle = tab.title || tab.url;
  await storageSet({ tasks });
  _allTasks = tasks;
  _expandedTaskIds.add(taskId);
  await renderTasks();
}

async function detachTab(taskId) {
  const tasks = await getAllTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  delete tasks[idx].attachedUrl;
  delete tasks[idx].attachedTitle;
  await storageSet({ tasks });
  _allTasks = tasks;
  _expandedTaskIds.add(taskId);
  await renderTasks();
}

async function renameTask(taskId, newTitle) {
  const tasks = await getAllTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1 || !newTitle) return;
  tasks[idx].title = newTitle;
  await storageSet({ tasks });
  _allTasks = tasks;
}

async function renameSubtask(taskId, subtaskId, newTitle) {
  const tasks = await getAllTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1 || !newTitle) return;
  const sub = (tasks[idx].subtasks || []).find(s => s.id === subtaskId);
  if (!sub) return;
  sub.title = newTitle;
  await storageSet({ tasks });
  _allTasks = tasks;
}

async function finishTaskWithCelebration(taskId) {
  // Grab card before renderTasks removes it
  const card = document.querySelector(`.task-card[data-id="${taskId}"]`);

  // Confetti burst centered on the card
  if (card && typeof burstConfetti === 'function') {
    burstConfetti(card);
  }

  // Completion message overlay on the card
  if (card) {
    const msg = document.createElement('div');
    msg.className = 'task-complete-msg';
    msg.textContent = 'Task complete! 🎉';
    card.appendChild(msg);
    // Trigger transition on next frame
    requestAnimationFrame(() => requestAnimationFrame(() => msg.classList.add('visible')));
  }

  // Let the celebration breathe, then finalize
  await new Promise(r => setTimeout(r, 1800));
  await completeTask(taskId);
}

async function completeTask(taskId) {
  const { pomodoroState: ps } = await chrome.storage.local.get(['pomodoroState']);
  if (ps?.sessionStartTime) await updateTaskTime(taskId, Date.now() - ps.sessionStartTime);
  const tasks = await getAllTasks();
  const idx   = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  tasks[idx].done = true;
  await storageSet({ tasks, activeTaskId: null, pomodoroState: null });
  _allTasks = tasks;
  stopTick();
  chrome.runtime.sendMessage({ type: 'STOP_POMODORO' });
  ctrlModeOn = false;
  await renderListSelector();
  await renderTasks();
  checkAllTasksDone();
}

async function toggleDone(taskId) {
  const tasks                = await getAllTasks();
  const idx                  = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const { activeTaskId }     = await chrome.storage.local.get(['activeTaskId']);
  if (!tasks[idx].done && taskId === activeTaskId) { await completeTask(taskId); return; }
  const wasDone = tasks[idx].done;
  tasks[idx].done = !tasks[idx].done;
  await storageSet({ tasks });
  _allTasks = tasks;
  await renderListSelector();
  await renderTasks();
  if (!wasDone) checkAllTasksDone();
}

// ── Break/Relax Suggestion ──
function checkAllTasksDone() {
  const tasks = _allTasks.filter(t => t.listId === _activeListId);
  if (tasks.length === 0) return;
  const allDone = tasks.every(t => t.done);
  if (allDone) {
    setTimeout(() => showBreakOverlay(), 600);
  }
}

let _breakInterval = null;

function showBreakOverlay() {
  // Don't show if already visible
  if (document.getElementById('breakOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'breakOverlay';
  overlay.className = 'break-overlay';
  overlay.innerHTML = `
    <div class="break-card">
      <div class="break-emoji">🎉</div>
      <div class="break-title">All tasks completed!</div>
      <div class="break-sub">Great work! Would you like to take a short break?</div>
      <div class="break-timer-display" id="breakTimerDisplay" style="display:none;">
        <span id="breakTimerText">15:00</span>
      </div>
      <div class="break-actions" id="breakActions">
        <button class="break-btn break-btn-yes" id="breakBtnYes">
          <svg fill="none" viewBox="0 0 20 20" width="16" height="16"><path d="M10 2a8 8 0 100 16 8 8 0 000-16z" stroke="currentColor" stroke-width="1.4"/><path d="M10 6v4l2.5 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          15 min Break
        </button>
        <button class="break-btn break-btn-no" id="breakBtnNo">Continue</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  document.getElementById('breakBtnYes').addEventListener('click', () => startBreakTimer(overlay));
  document.getElementById('breakBtnNo').addEventListener('click', () => closeBreakOverlay(overlay));
}

function startBreakTimer(overlay) {
  const actions = document.getElementById('breakActions');
  const timerDisplay = document.getElementById('breakTimerDisplay');
  const timerText = document.getElementById('breakTimerText');

  actions.style.display = 'none';
  timerDisplay.style.display = 'flex';

  // Update subtitle
  overlay.querySelector('.break-sub').textContent = 'Relax, your break has started.';
  overlay.querySelector('.break-emoji').textContent = '☕';

  let remaining = 15 * 60; // 15 minutes in seconds

  function updateTimer() {
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    timerText.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

    if (remaining <= 0) {
      clearInterval(_breakInterval);
      _breakInterval = null;
      timerText.textContent = '00:00';
      overlay.querySelector('.break-emoji').textContent = '🔔';
      overlay.querySelector('.break-title').textContent = 'Break over!';
      overlay.querySelector('.break-sub').textContent = 'Energy restored. Ready for new tasks!';
      timerDisplay.style.display = 'none';
      actions.style.display = 'flex';
      actions.innerHTML = '<button class="break-btn break-btn-yes" id="breakBtnDone">OK</button>';
      document.getElementById('breakBtnDone').addEventListener('click', () => closeBreakOverlay(overlay));
      playSound('complete');
      return;
    }
    remaining--;
  }

  // Show the first tick immediately, then decrement every second
  updateTimer();
  _breakInterval = setInterval(updateTimer, 1000);
}

function closeBreakOverlay(overlay) {
  if (_breakInterval) {
    clearInterval(_breakInterval);
    _breakInterval = null;
  }
  overlay.classList.remove('open');
  setTimeout(() => overlay.remove(), 300);
}

async function deleteTask(taskId) {
  const tasks = await getAllTasks();
  const { activeTaskId } = await chrome.storage.local.get(['activeTaskId']);
  // If deleting the active task, stop the timer first
  if (taskId === activeTaskId) {
    stopTick();
    chrome.runtime.sendMessage({ type: 'STOP_POMODORO' });
    ctrlModeOn = false;
    await storageSet({ activeTaskId: null, pomodoroState: null });
  }

  // Animate card out before removing
  const cardEl = document.querySelector(`.task-card[data-id="${taskId}"]`);
  if (cardEl) {
    // Lock current pixel height so we can transition from it to 0
    const h = cardEl.offsetHeight;
    cardEl.classList.add('deleting');
    cardEl.style.height = h + 'px';
    // Force reflow so browser registers the start state
    void cardEl.offsetHeight;
    // Transition to fully collapsed — margin-bottom absorbs the 6px flex gap
    cardEl.style.transition = 'height 250ms ease-in, opacity 250ms ease-in, transform 250ms ease-in, margin-bottom 250ms ease-in';
    cardEl.style.height      = '0';
    cardEl.style.opacity     = '0';
    cardEl.style.transform   = 'translateX(20px)';
    cardEl.style.marginBottom = '-6px';
    await new Promise(r => {
      const onEnd = e => {
        if (e.propertyName === 'height') {
          cardEl.removeEventListener('transitionend', onEnd);
          r();
        }
      };
      cardEl.addEventListener('transitionend', onEnd);
    });
  }

  const filtered = tasks.filter(t => t.id !== taskId);
  await storageSet({ tasks: filtered });
  _allTasks = filtered;
  await renderListSelector();
  await renderTasks();
}

function updateProgress(tasks) {
  const total    = tasks.length;
  const done     = tasks.filter(t => t.done).length;
  const totalMin = tasks.reduce((s, t) => s + (t.estimatedMin || 0), 0);
  const pct      = total ? done / total : 0;

  const estEl   = document.getElementById('estLbl');
  const doneEl  = document.getElementById('doneLbl');
  const ringN   = document.getElementById('ringDoneN');
  const ringD   = document.getElementById('ringTotalD');
  const ringFil = document.getElementById('dashRingFill');

  if (estEl)   estEl.textContent  = totalMin > 0 ? `Est: ${fmtEstTime(totalMin)}` : 'Est: —';
  if (doneEl)  doneEl.textContent = `${done}/${total}`;
  if (ringN)   ringN.textContent  = done;
  if (ringD)   ringD.textContent  = `/${total}`;

  // r=22, circumference = 2 * π * 22 ≈ 138.23
  if (ringFil) {
    const circ = 2 * Math.PI * 22;
    ringFil.style.strokeDashoffset = circ * (1 - pct);
    // Green ring when all done
    ringFil.style.stroke = pct >= 1 ? '#FF6B00' : '';
    ringFil.style.filter = pct >= 1
      ? 'drop-shadow(0 0 8px rgba(255,107,0,0.6))'
      : 'drop-shadow(0 0 8px rgba(0,229,255,0.55))';
  }
}

// ── Dashboard Stats Strip ────────────────────────────────────────────
async function loadDashStats() {
  const today = new Date().toISOString().slice(0, 10);
  const { stats = {}, tasks = [] } = await chrome.storage.local.get(['stats', 'tasks']);
  const listTasks  = tasks.filter(t => t.listId === _activeListId);
  const todayDone  = listTasks.filter(t => t.done).length;
  const todayStats = stats[today] || {};
  const focusMs    = Object.values(todayStats).reduce((s, v) => s + v, 0);
  // Energy: 0–100% capped at 4h of focus time
  const energyPct  = Math.min(100, Math.round((focusMs / (4 * 3600000)) * 100));

  const dChip  = document.getElementById('todayDoneChip');
  const fChip  = document.getElementById('todayFocusChip');
  const eFill  = document.getElementById('energyFill');

  if (dChip) dChip.innerHTML = `<svg width="10" height="10" fill="none" viewBox="0 0 10 10"><path d="M2 5.5L4 7.5L8 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> ${todayDone}`;
  if (fChip) fChip.innerHTML = `<svg width="10" height="10" fill="none" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.5" stroke="currentColor" stroke-width="1.2"/><path d="M5 3.2V5L6.2 6.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg> ${fmtTime(focusMs)}`;
  const topbarFocus = document.getElementById('topbarFocusVal');
  if (topbarFocus) topbarFocus.textContent = fmtTime(focusMs);
  if (eFill) {
    eFill.style.width = energyPct + '%';
    // background-position shifts the gradient: left=orange, right=green
    eFill.style.backgroundPosition = `${100 - energyPct}% 0`;
  }
}

// ── Add Task ────────────────────────────────────────────────────────
function openAddSheet() {
  document.getElementById('panel-tasks').classList.add('form-open');
  document.getElementById('addSheet').classList.add('open');
  document.getElementById('atbTxt').textContent = 'CANCEL';
  document.getElementById('newTaskTitle').focus();
}
function closeAddSheet() {
  document.getElementById('panel-tasks').classList.remove('form-open');
  document.getElementById('addSheet').classList.remove('open');
  document.getElementById('atbTxt').textContent = 'ADD TASK';
  document.getElementById('newTaskTitle').value = '';
  const timeInp = document.getElementById('newTaskMin');
  timeInp.value = '';
  timeInp.classList.remove('invalid');
}
function parseEstTime(val) {
  const s = (val || '').trim();
  if (!s) return null; // empty = optional
  const match = s.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const h = parseInt(match[1], 10) || 0;
    const m = parseInt(match[2], 10) || 0;
    if (h > 23 || m > 59) return null;
    const total = h * 60 + m;
    return total > 0 ? total : null;
  }
  // Partial input like "5" → treat as 5 min
  const num = parseInt(s, 10);
  if (!isNaN(num) && num > 0) return Math.min(num, 1439);
  return null;
}

function fmtWorkTime(ms) {
  if (!ms || ms < 60000) return '0min';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}hrs ${m}min` : `${m}min`;
}

function fmtEstTime(minutes) {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function fmtEstTimeDisplay(minutes) {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function isValidTimeInput(val) {
  const s = (val || '').trim();
  if (!s) return true; // empty is valid (optional)
  // Allow partial typing: "1", "12", "12:", "12:3", "12:30"
  if (/^\d{0,2}$/.test(s)) return true;
  if (/^\d{1,2}:$/.test(s)) return true;
  if (/^\d{1,2}:\d{1,2}$/.test(s)) {
    const [h, m] = s.split(':').map(Number);
    if (h > 23) return false;
    if (s.split(':')[1].length === 2 && m > 59) return false;
    return true;
  }
  return false;
}

// ── HH:MM Input Mask ────────────────────────────────────────────────
(function initTimeInputMask() {
  const inp = document.getElementById('newTaskMin');
  if (!inp) return;

  inp.addEventListener('keydown', e => {
    // Allow navigation, delete, tab, enter, escape
    if (['Backspace','Delete','ArrowLeft','ArrowRight','Home','End','Tab'].includes(e.key)) return;
    if (e.key === 'Enter') { document.getElementById('saveTaskBtn').click(); return; }
    if (e.key === 'Escape') { closeAddSheet(); return; }

    // Block non-digit keys (except : which we auto-insert)
    if (!/^\d$/.test(e.key)) {
      e.preventDefault();
      return;
    }

    const val = inp.value;
    const pos = inp.selectionStart;

    // If there's a selection, let it replace
    if (inp.selectionStart !== inp.selectionEnd) return;

    // Block if already at max length
    if (val.length >= 5) {
      e.preventDefault();
      return;
    }

    // Auto-insert colon after 2 digits (if no colon yet)
    if (val.length === 2 && !val.includes(':') && pos === 2) {
      // Validate hours
      if (parseInt(val, 10) > 23) {
        e.preventDefault();
        inp.classList.add('invalid');
        setTimeout(() => inp.classList.remove('invalid'), 600);
        return;
      }
      inp.value = val + ':';
      // Don't prevent - the digit will be added after the colon
      return;
    }

    // Validate hours part while typing
    if (pos === 0 && val.length === 0 && parseInt(e.key, 10) > 2) {
      // Single digit hour > 2 → auto-format as 0X:
      e.preventDefault();
      inp.value = '0' + e.key + ':';
      return;
    }

    if (pos === 1 && !val.includes(':')) {
      const h = parseInt(val[0] + e.key, 10);
      if (h > 23) {
        e.preventDefault();
        inp.classList.add('invalid');
        setTimeout(() => inp.classList.remove('invalid'), 600);
        return;
      }
    }

    // Validate minutes part
    if (val.includes(':')) {
      const parts = val.split(':');
      const minPart = parts[1] || '';
      if (pos > val.indexOf(':')) {
        if (minPart.length === 0 && parseInt(e.key, 10) > 5) {
          // First minute digit > 5 → invalid
          e.preventDefault();
          inp.classList.add('invalid');
          setTimeout(() => inp.classList.remove('invalid'), 600);
          return;
        }
        if (minPart.length >= 2) {
          e.preventDefault();
          return;
        }
      }
    }
  });

  // Real-time validation on input
  inp.addEventListener('input', () => {
    const val = inp.value;
    if (!val) {
      inp.classList.remove('invalid');
      return;
    }
    if (!isValidTimeInput(val)) {
      inp.classList.add('invalid');
    } else {
      inp.classList.remove('invalid');
    }
  });

  // Auto-correct on blur
  inp.addEventListener('blur', () => {
    const val = inp.value.trim();
    if (!val) { inp.classList.remove('invalid'); return; }

    const parsed = parseEstTime(val);
    if (parsed !== null) {
      inp.value = fmtEstTime(parsed);
      inp.classList.remove('invalid');
    } else {
      inp.classList.add('invalid');
    }
  });
})();

document.getElementById('addTaskBtn').addEventListener('click', () => {
  const isOpen = document.getElementById('panel-tasks').classList.contains('form-open');
  isOpen ? closeAddSheet() : openAddSheet();
});

document.getElementById('saveTaskBtn').addEventListener('click', async () => {
  const title = document.getElementById('newTaskTitle').value.trim();
  const timeInp = document.getElementById('newTaskMin');
  const timeVal = timeInp.value.trim();
  if (!title) { document.getElementById('newTaskTitle').focus(); return; }
  // Validate time if provided
  let min = 25; // default
  if (timeVal) {
    const parsed = parseEstTime(timeVal);
    if (parsed === null) {
      timeInp.classList.add('invalid');
      timeInp.focus();
      return;
    }
    min = parsed;
  }
  const tasks = await getAllTasks();
  const newId = Date.now().toString();
  _pendingEnterTaskId = newId;
  tasks.push({ id: newId, title, estimatedMin: min, done: false, listId: _activeListId });
  await storageSet({ tasks });
  _allTasks = tasks;
  closeAddSheet();
  const addBtn = document.getElementById('addTaskBtn');
  const addTxt = document.getElementById('atbTxt');
  addBtn.classList.add('success');
  addTxt.textContent = 'TASK ADDED';
  setTimeout(() => { addBtn.classList.remove('success'); addTxt.textContent = 'ADD TASK'; }, 1800);
  await renderListSelector();
  await renderTasks();
});

document.getElementById('newTaskTitle').addEventListener('keydown', e => {
  if (e.key === 'Enter')  document.getElementById('saveTaskBtn').click();
  if (e.key === 'Escape') closeAddSheet();
});

// ── Title-based content classifier ──────────────────────────────────
// Maps title keywords to a fixed category — ALWAYS returns a category, never null.
function _classifyByTitle(title) {
  const t = (title || '').toLowerCase();
  const _f = name => DEFAULT_CATEGORIES.find(c => c.name === name) || FALLBACK_CATEGORY;
  if (/video|watch|film|movie|stream|episode|season|trailer|anime|twitch|netflix/.test(t))
    return _f('Video Streaming & Movies');
  if (/music|song|playlist|podcast|audio|spotify|soundcloud/.test(t))
    return _f('Music & Audio');
  if (/game|gaming|esport|twitch|steam|playstation|xbox/.test(t))
    return _f('Gaming & Esports');
  if (/shop|store|buy|cart|checkout|price|order|deal|coupon|shipping|product/.test(t))
    return _f('E-Commerce & Shopping');
  if (/\bnews\b|breaking|headline|editorial|magazine|press/.test(t))
    return _f('News & World Media');
  if (/tech\s*news|hacker\s*news|techcrunch|verge|wired/.test(t))
    return _f('Tech News & Blogs');
  if (/\bai\b|gpt|llm|claude|gemini|copilot|assistant|chatbot|prompt|mistral|midjourney/.test(t))
    return _f('LLMs & AI Chatbots');
  if (/stable\s*diffusion|dall.e|midjourney|image\s*gen|ai\s*art/.test(t))
    return _f('AI Image, Audio & Video');
  if (/copilot|cursor|codeium|tabnine|ai\s*cod/.test(t))
    return _f('AI Coding Assistants');
  if (/react|vue|angular|svelte|nextjs|tailwind|css|html|frontend|component/.test(t))
    return _f('React & Next.js Ecosystem');
  if (/node|express|fastapi|django|rails|backend|server\s*side/.test(t))
    return _f('Node.js & Server Frameworks');
  if (/docker|kubernetes|container|orchestrat/.test(t))
    return _f('Containers & Orchestration');
  if (/aws|azure|gcp|cloud\s*provider|heroku|vercel|netlify/.test(t))
    return _f('Cloud Providers');
  if (/devops|ci\/cd|pipeline|terraform|deploy|jenkins|github\s*actions/.test(t))
    return _f('DevOps & CI/CD');
  if (/design|figma|\bui\b|\bux\b|mockup|wireframe|prototype/.test(t))
    return _f('UI/UX Design Tools');
  if (/illustration|graphic|photoshop|canva|sketch/.test(t))
    return _f('Graphic Design & Illustration');
  if (/finance|trading|invest|stock|market|bank|wallet|exchange|portfolio/.test(t))
    return _f('Finance & Banking');
  if (/crypto|bitcoin|ethereum|blockchain|nft|defi|token|web3/.test(t))
    return _f('Crypto & Web3');
  if (/social|messaging|\bchat\b|direct\s*message|\bdm\b|post|feed|follow|tweet/.test(t))
    return _f('Social Media & Messaging');
  if (/startup|founder|indie\s*hacker|producthunt|indiehacker/.test(t))
    return _f('Startups & Indie Hackers');
  if (/venture|vc\b|funding|seed|series\s*[abc]/.test(t))
    return _f('Venture Capital & Funding');
  if (/\bseo\b|organic\s*growth|keyword\s*research|backlink/.test(t))
    return _f('SEO & Organic Growth');
  if (/marketing|campaign|ads|advertising|funnel|conversion|ppc/.test(t))
    return _f('Paid Advertising & PPC');
  if (/data\s*science|dataset|pandas|jupyter|tableau|power\s*bi|kaggle/.test(t))
    return _f('Data Science & Research');
  if (/security|hack|vulnerabilit|malware|firewall|encryption|pentest|ctf/.test(t))
    return _f('Cybersecurity & Pentesting');
  if (/privacy|identity|vpn|2fa|password/.test(t))
    return _f('Privacy & Identity');
  if (/course|tutorial|mooc|udemy|coursera|learn|lesson|curriculum/.test(t))
    return _f('Online Courses & MOOCs');
  if (/language\s*learn|duolingo|vocab|grammar|translate/.test(t))
    return _f('Language Learning');
  if (/university|school|lms|canvas|blackboard|academic|thesis|research/.test(t))
    return _f('Academic Research');
  if (/fitness|workout|exercise|gym|running|training/.test(t))
    return _f('Fitness & Exercise');
  if (/mental\s*health|meditation|mindful|therapy|anxiety|wellbeing/.test(t))
    return _f('Mental Health & Meditation');
  if (/medical|healthcare|doctor|symptom|hospital|clinic/.test(t))
    return _f('Medical & Healthcare');
  if (/travel|flight|hotel|vacation|trip|airport|destination/.test(t))
    return _f('Travel & Flights');
  if (/map|navigation|direction|gps|route/.test(t))
    return _f('Maps & Navigation');
  if (/email|inbox|mail|compose|gmail|outlook|calendar/.test(t))
    return _f('Email & Calendar');
  if (/zoom|meet|teams|webinar|conference|video\s*call/.test(t))
    return _f('Video Conferencing');
  if (/slack|discord|teams|chat|messaging|collaboration/.test(t))
    return _f('Team Chat & Collaboration');
  if (/project|task|sprint|jira|asana|trello|kanban|roadmap/.test(t))
    return _f('Project Management');
  if (/note|notion|obsidian|roam|logseq|knowledge\s*base|wiki/.test(t))
    return _f('Note-Taking & PKM');
  if (/blog|writing|newsletter|content\s*creat|substack|medium/.test(t))
    return _f('Blogging & Writing');
  if (/github|gitlab|bitbucket|version\s*control|repository|commit/.test(t))
    return _f('Git & Version Control');
  if (/recruit|hiring|job|career|linkedin|resume|talent/.test(t))
    return _f('HR & Recruiting');
  if (/food|recipe|cooking|restaurant|delivery/.test(t))
    return _f('Food & Recipes');
  if (/sport|football|basketball|soccer|tennis|nba|nfl/.test(t))
    return _f('Sports & Outdoors');
  // STRICT FALLBACK — never return null/undefined
  return FALLBACK_CATEGORY;
}

// ── Instant classifier — url + title only, zero network, zero injection ──
// Always returns a group from the fixed category list — never a dynamic domain/title name.
function classifyTabFast(url, title, custom = []) {
  let hostname = '';
  try { if (url) hostname = new URL(url).hostname.replace(/^www\./, ''); } catch(e) {}
  const text = ((url || '') + ' ' + (title || '')).toLowerCase();

  // 1. Custom categories — domain match, then keyword
  for (const cat of (custom || [])) {
    if ((cat.domains || []).some(d => hostname === d || hostname.endsWith('.' + d)))
      return cat;
    if ((cat.keywords || []).some(kw => text.includes(kw.toLowerCase())))
      return cat;
  }

  // 2. DEFAULT_CATEGORIES — fast domain lookup via _DOMAIN_MAP (from categorizer.js)
  // Note: Since we reverted, we need to rebuild _DOMAIN_MAP locally or iterate
  // For simplicity in this revert, we iterate.
  for (const cat of DEFAULT_CATEGORIES) {
      if ((cat.domains || []).some(d => hostname === d || hostname.endsWith('.' + d)))
        return cat;
  }

  // 3. Keyword scoring against DEFAULT_CATEGORIES
  let best = null, top = 0;
  for (const cat of DEFAULT_CATEGORIES) {
    let score = 0;
    for (const kw of (cat.keywords || [])) { if (text.includes(kw)) score += 2; }
    if (score > top) { top = score; best = cat; }
  }
  if (top >= 4) return best;

  // 4. Fallback — analyze title content, always returns a fixed category name
  return _classifyByTitle(title);
}

// ── Organize ─────────────────────────────────────────────────────────

async function renderOrganizePanel() {
  const res = document.getElementById('resultArea');
  if (!res) return;

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const httpTabs = tabs.filter(t => t.url?.startsWith('http'));

  if (!httpTabs.length) {
    res.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg fill="none" viewBox="0 0 18 18"><rect x="2" y="3" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M2 6h14" stroke="currentColor" stroke-width="1.3"/></svg></div><div class="empty-text">No web tabs open.</div></div>`;
    return;
  }

  let chromeGroups = [];
  try { chromeGroups = await chrome.tabGroups.query({}); } catch(e) {}

  function buildTabRow(tab) {
    const fav = tab.favIconUrl
      ? `<img class="sg-tfav" src="${tab.favIconUrl.replace(/"/g,'&quot;')}" onerror="this.style.visibility='hidden'">`
      : `<span class="sg-tfav-ph"></span>`;
    return `<div class="sg-trow" data-tabid="${tab.id}" title="${escHtml(tab.title || '')}">
      <span class="sg-tsel"></span>
      ${fav}
      <span class="sg-ttitle">${escHtml(tab.title || '')}</span>
    </div>`;
  }

  const ungrouped = httpTabs.filter(t => t.groupId === -1);
  let html = '';

  for (const grp of chromeGroups) {
    const grpTabs = httpTabs.filter(t => t.groupId === grp.id);
    if (!grpTabs.length) continue;
    // Auto-name untitled groups based on common domain
    if (!grp.title) {
      const domains = grpTabs.map(t => { try { return new URL(t.url).hostname.replace(/^www\./,''); } catch { return ''; } }).filter(Boolean);
      const freq = {};
      domains.forEach(d => { freq[d] = (freq[d] || 0) + 1; });
      const topDomain = Object.entries(freq).sort((a,b) => b[1] - a[1])[0]?.[0] || '';
      const autoName = topDomain ? topDomain.split('.')[0].charAt(0).toUpperCase() + topDomain.split('.')[0].slice(1) : `Group ${grpTabs.length}`;
      try { chrome.tabGroups.update(grp.id, { title: autoName }); } catch(e) {}
      grp.title = autoName;
    }
    const hex = DOT_HEX[grp.color] || '#6b7280';
    const tabRowsHtml = grpTabs.map(buildTabRow).join('');
    html += `<div class="sg-group-card" id="gc-${grp.id}">
      <div class="sg-group-row" data-gid="${grp.id}">
        <button class="sg-drag"><svg width="10" height="14" fill="currentColor" viewBox="0 0 10 14"><circle cx="3" cy="2" r="1.2"/><circle cx="7" cy="2" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="12" r="1.2"/><circle cx="7" cy="12" r="1.2"/></svg></button>
        <div class="sg-gdot" style="background:${hex};box-shadow:0 0 5px ${hex}88"></div>
        <span class="sg-gname">${grp.title || 'Group'}</span>
        <span class="sg-gcnt">${grpTabs.length}</span>
        <button class="sg-garr open"><svg width="10" height="10" fill="none" viewBox="0 0 10 10"><path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <div class="sg-tlist open" id="tl-${grp.id}">${tabRowsHtml}</div>
    </div>`;
  }

  if (ungrouped.length) {
    const uRowsHtml = ungrouped.map(buildTabRow).join('');
    html += `<div class="sg-group-card" id="gc-ungrouped">
      <div class="sg-group-row" data-gid="ungrouped">
        <button class="sg-drag"><svg width="10" height="14" fill="currentColor" viewBox="0 0 10 14"><circle cx="3" cy="2" r="1.2"/><circle cx="7" cy="2" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="12" r="1.2"/><circle cx="7" cy="12" r="1.2"/></svg></button>
        <div class="sg-gdot" style="background:#a855f7;box-shadow:0 0 5px rgba(168,85,247,0.45)"></div>
        <span class="sg-gname sg-gname-u">Ungrouped Tabs</span>
        <span class="sg-gcnt">${ungrouped.length}</span>
        <button class="sg-garr open"><svg width="10" height="10" fill="none" viewBox="0 0 10 10"><path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <div class="sg-tlist open" id="tl-ungrouped">${uRowsHtml}</div>
    </div>`;
  }

  if (!html) {
    res.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg fill="none" viewBox="0 0 18 18"><rect x="1.5" y="1.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2"/><rect x="10.5" y="1.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2"/><rect x="1.5" y="10.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2"/><rect x="10.5" y="10.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2"/></svg></div><div class="empty-text">No groups yet.<br>Click Organize to group your tabs.</div></div>`;
    return;
  }

  res.innerHTML = html;
  sgAttachEvents(res);
}

function sgAttachEvents(container) {
  container.querySelectorAll('.sg-group-row').forEach(row => {
    const gid  = row.dataset.gid;
    const list = document.getElementById(`tl-${gid}`);
    const arr  = row.querySelector('.sg-garr');
    let open   = true;
    row.addEventListener('click', () => {
      open = !open;
      list.classList.toggle('open', open);
      arr.classList.toggle('open', open);
    });
  });
  container.querySelectorAll('.sg-trow').forEach(row => {
    row.addEventListener('click', e => {
      e.stopPropagation();
      chrome.tabs.update(+row.dataset.tabid, { active: true });
    });
  });
}

document.getElementById('organizeBtn').addEventListener('click', async () => {
  const btn = document.getElementById('organizeBtn');
  btn.disabled = true;
  btn.textContent = '...';

  try {
    const { customCategories = [] } = await chrome.storage.local.get(['customCategories']);
    const tabs = await chrome.tabs.query({ currentWindow: true });

    const grouped = {};
    tabs.forEach(tab => {
      if (!tab.url?.startsWith('http')) return;
      const cat = classifyTabFast(tab.url, tab.title, customCategories);
      if (!cat) return;
      if (!grouped[cat.name]) grouped[cat.name] = { cat, tabIds: [] };
      grouped[cat.name].tabIds.push(tab.id);
    });

    for (const { cat, tabIds } of Object.values(grouped).filter(g => g.tabIds.length)) {
      try {
        const gid = await chrome.tabs.group({ tabIds });
        await chrome.tabGroups.update(gid, { title: cat.name, color: cat.color, collapsed: false });
        tabIds.forEach(id => chrome.runtime.sendMessage({ type: 'SET_TAB_CAT', tabId: id, cat: cat.name }));
      } catch(e) {}
    }
  } catch(e) {
    console.error('Organize failed:', e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Organize';
    await renderOrganizePanel();
  }
});

document.getElementById('ungroupAllBtn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const groupedIds = tabs.filter(t => t.groupId && t.groupId !== -1).map(t => t.id);
  if (groupedIds.length) {
    try { await chrome.tabs.ungroup(groupedIds); } catch(e) {}
  }
  await renderOrganizePanel();
});

document.getElementById('sgSearch').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#resultArea .sg-group-card').forEach(card => {
    if (!q) {
      card.style.display = '';
      card.querySelectorAll('.sg-trow').forEach(r => r.style.display = '');
      return;
    }
    let visible = false;
    const catName = (card.querySelector('.sg-gname')?.textContent || '').toLowerCase();
    if (catName.includes(q)) {
      visible = true;
      card.querySelectorAll('.sg-trow').forEach(r => r.style.display = '');
    } else {
      card.querySelectorAll('.sg-trow').forEach(r => {
        const match = (r.querySelector('.sg-ttitle')?.textContent || '').toLowerCase().includes(q);
        r.style.display = match ? '' : 'none';
        if (match) visible = true;
      });
    }
    card.style.display = visible ? '' : 'none';
    if (visible) {
      const list = card.querySelector('.sg-tlist');
      if (list) list.classList.add('open');
      const arr  = card.querySelector('.sg-garr');
      if (arr)  arr.classList.add('open');
    }
  });
});

// ── Smart Groups Grid Toggle ─────────────────────────────────────────
let sgGridMode = false;
document.getElementById('sgGridToggle').addEventListener('click', () => {
  sgGridMode = !sgGridMode;
  document.getElementById('resultArea').classList.toggle('grid-mode', sgGridMode);
  document.getElementById('sgGridToggle').classList.toggle('grid-on', sgGridMode);
});

// ── Stats ───────────────────────────────────────────────────────────
function fmtTime(ms) {
  if (!ms || ms < 0) return '0min';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function _startStatsLive() {
  _stopStatsLive();
  if (_statsFilter === 'today') {
    _statsLiveInterval = setInterval(() => {
      const panel = document.getElementById('panel-stats');
      if (panel && panel.classList.contains('active')) renderStats(false);
      else _stopStatsLive();
    }, 3000);
  }
}
function _stopStatsLive() {
  if (_statsLiveInterval) { clearInterval(_statsLiveInterval); _statsLiveInterval = null; }
}

function _getStatsDateKeys(allDates) {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (_statsFilter === 'today') return allDates.filter(d => d === todayStr);
  if (_statsFilter === 'week') {
    const cutoff = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    return allDates.filter(d => d >= cutoff);
  }
  if (_statsFilter === 'month') {
    const cutoff = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    return allDates.filter(d => d >= cutoff);
  }
  return allDates; // 'all'
}

async function renderStats(animate = true) {
  try { await chrome.runtime.sendMessage({ type: 'FLUSH_STATS' }); } catch(e) {}
  const data = await chrome.storage.local.get(['stats', 'siteStats', 'siteMeta']);
  const allStats    = data.stats    || {};
  const allSites    = data.siteStats || {};
  const siteMeta    = data.siteMeta  || {};

  // Filtered date range
  const filteredStatDates = _getStatsDateKeys(Object.keys(allStats));
  const filteredSiteDates = _getStatsDateKeys(Object.keys(allSites));

  // Aggregate site durations (compatible with new and legacy schema)
  const siteTotals = {};
  for (const date of filteredSiteDates) {
    const dayData = allSites[date] || {};
    for (const [key, val] of Object.entries(dayData)) {
      if (typeof val === 'number') {
        // New schema: key=hostname, val=ms
        siteTotals[key] = (siteTotals[key] || 0) + val;
      } else if (typeof val === 'object') {
        // Legacy schema: key=category, val={hostname:ms}
        for (const [host, ms] of Object.entries(val || {})) {
          if (typeof ms === 'number') siteTotals[host] = (siteTotals[host] || 0) + ms;
        }
      }
    }
  }

  // Aggregate category durations
  const catTotals = {};
  for (const date of filteredStatDates) {
    for (const [cat, ms] of Object.entries(allStats[date] || {})) {
      catTotals[cat] = (catTotals[cat] || 0) + ms;
    }
  }

  const totalMs = Object.values(catTotals).reduce((s, v) => s + v, 0);
  const topCatEntry = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0];
  const topCat = topCatEntry?.[0]?.split(' ')?.[0] || '—';

  document.getElementById('statTime').textContent = fmtTime(totalMs);
  document.getElementById('statTop').textContent  = topCat;

  // ── Top 10 siteler ──────────────────────────────────────────────────
  let siteEntries = Object.entries(siteTotals);
  if (_statsSort === 'time') siteEntries.sort((a, b) => b[1] - a[1]);
  else siteEntries.sort((a, b) => a[0].localeCompare(b[0]));

  const top10   = siteEntries.slice(0, 10);
  const maxSite = top10[0]?.[1] || 1;
  const topList = document.getElementById('topSitesList');

  if (!top10.length) {
    topList.innerHTML = '<div class="stats-empty">No site data yet. Start browsing to see your stats.</div>';
  } else {
    topList.innerHTML = top10.map(([hostname, ms], i) => {
      const pct     = Math.round((ms / maxSite) * 100);
      const catName = siteMeta[hostname] || '';
      const catObj  = DEFAULT_CATEGORIES.find(c => c.name === catName);
      const grad    = i === 0 ? 'linear-gradient(90deg,#f97316,#fb923c)' : (BAR_GRAD[catObj?.color] || 'linear-gradient(90deg,#6b7280,#9ca3af)');
      return `<div class="top-site-card">
        <div class="top-site-rank">${i + 1}</div>
        <img class="top-site-fav" src="https://www.google.com/s2/favicons?sz=32&domain=${hostname}" onerror="this.style.opacity='0'"/>
        <div class="top-site-info">
          <div class="top-site-domain">${hostname}</div>
          <div class="top-site-bar-wrap">
            <div class="top-site-bar" style="width:${animate ? '0%' : pct + '%'};background:${grad}" data-w="${pct}%"></div>
          </div>
        </div>
        <div class="top-site-time">${fmtTime(ms)}</div>
      </div>`;
    }).join('');
    if (animate) {
      setTimeout(() => {
        topList.querySelectorAll('.top-site-bar').forEach(el => { el.style.width = el.dataset.w; });
      }, 60);
    }
  }

  // ── Category breakdown (site details always expanded) ──────────────
  const barList   = document.getElementById('barList');
  const catEntries = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);

  if (!catEntries.length) {
    barList.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg fill="none" viewBox="0 0 18 18"><rect x="1" y="9" width="3.5" height="7.5" rx="1" fill="currentColor" opacity="0.6"/><rect x="7.25" y="5" width="3.5" height="11.5" rx="1" fill="currentColor" opacity="0.6"/><rect x="13.5" y="1.5" width="3.5" height="15" rx="1" fill="currentColor" opacity="0.6"/></svg></div><div class="empty-text">Organize your tabs<br>and start tracking time.</div></div>`;
    return;
  }

  const maxCat = catEntries[0][1];
  barList.innerHTML = catEntries.slice(0, 10).map(([name, ms], i) => {
    const pct  = Math.round((ms / maxCat) * 100);
    const cat  = DEFAULT_CATEGORIES.find(c => c.name === name);
    const grad = i === 0 ? 'linear-gradient(90deg,#f97316,#fb923c)' : (BAR_GRAD[cat?.color] || 'linear-gradient(90deg,#00E5FF,#33EBFF)');

    // Sites belonging to this category (filter from siteMeta)
    const catSites = siteEntries
      .filter(([host]) => (siteMeta[host] || '') === name)
      .slice(0, 6);

    const sitesHtml = catSites.map(([host, hms]) =>
      `<div class="site-row">
        <img class="site-fav" src="https://www.google.com/s2/favicons?sz=16&domain=${host}" onerror="this.style.visibility='hidden'"/>
        <span class="site-domain">${host}</span>
        <span class="site-time">${fmtTime(hms)}</span>
      </div>`
    ).join('');

    return `<div class="bar-block">
      <div class="bar-meta">
        <span class="bar-name">${name}</span>
        <span class="bar-time">${fmtTime(ms)}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${animate ? '0%' : pct + '%'};background:${grad}" data-w="${pct}%"></div>
      </div>
      ${sitesHtml ? `<div class="sites-list">${sitesHtml}</div>` : ''}
    </div>`;
  }).join('');

  if (animate) {
    setTimeout(() => {
      barList.querySelectorAll('.bar-fill').forEach(el => { el.style.width = el.dataset.w; });
    }, 60);
  }
}

// ── Stats event listeners ────────────────────────────────────────────
document.querySelectorAll('.stats-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _statsFilter = btn.dataset.filter;
    document.querySelectorAll('.stats-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderStats();
    _startStatsLive();
  });
});

document.getElementById('statsSortSel')?.addEventListener('change', (e) => {
  _statsSort = e.target.value;
  renderStats();
});

document.getElementById('clearBtn').addEventListener('click', () => {
  if (confirm('Are you sure you want to clear all statistics?')) {
    chrome.storage.local.remove(['stats', 'siteStats', 'siteMeta'], renderStats);
  }
});

document.getElementById('statsExportBtn')?.addEventListener('click', () => {
  chrome.storage.local.get(['stats', 'siteStats', 'siteMeta'], (data) => {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `tabclaw-stats-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
});

// ── Sound System ────────────────────────────────────────────────────
let _audioCtx = null;
let soundOn = true; // will be loaded from chrome.storage.local

function _getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || /** @type {any} */(window).webkitAudioContext)();
  return _audioCtx;
}

function playSound(type) {
  if (!soundOn) return;
  try {
    const ctx  = _getAudioCtx();
    const play = (freq, start, dur, vol = 0.10, wave = 'sine') => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = wave;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.02);
    };
    if (type === 'complete') {
      // Ascending arpeggio: C5 → E5 → G5 → C6
      play(523,  0,    0.13, 0.10);
      play(659,  0.10, 0.13, 0.10);
      play(784,  0.20, 0.13, 0.10);
      play(1047, 0.30, 0.26, 0.11);
    } else if (type === 'start') {
      play(440, 0,    0.09, 0.09);
      play(660, 0.08, 0.14, 0.09);
    } else if (type === 'pause') {
      play(660, 0,    0.09, 0.09);
      play(440, 0.08, 0.14, 0.08);
    } else if (type === 'add') {
      play(587, 0,    0.10, 0.08);
      play(880, 0.09, 0.15, 0.07);
    } else if (type === 'check') {
      play(660, 0,    0.08, 0.08);
      play(880, 0.07, 0.11, 0.07);
    }
  } catch(_) {}
}

// Sound toggle button — synced via chrome.storage.local
const sndBtn = document.getElementById('sndBtn');
chrome.storage.local.get(['soundEnabled'], ({ soundEnabled }) => {
  soundOn = soundEnabled !== false; // default true
  if (sndBtn) sndBtn.classList.toggle('on', soundOn);
});
if (sndBtn) {
  sndBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    storageSet({ soundEnabled: soundOn });
    sndBtn.classList.toggle('on', soundOn);
    playSound('check');
  });
}

// ── Confetti ─────────────────────────────────────────────────────────
const _CONF_COLORS = ['#00E5FF','#33EBFF','#FF6B00','#FF8533','#FF8533','#60a5fa','#a78bfa','#f472b6'];

function launchConfetti(fromEl) {
  const rect = fromEl?.getBoundingClientRect?.() ?? { left: 200, top: 200, width: 0, height: 0 };
  const ox   = rect.left + rect.width  / 2;
  const oy   = rect.top  + rect.height / 2;
  const n    = 24;
  for (let i = 0; i < n; i++) {
    const el    = document.createElement('span');
    el.className = 'confetti-piece';
    const angle = (Math.PI * 2 * i / n) + (Math.random() - 0.5) * 0.7;
    const dist  = 55 + Math.random() * 95;
    const cx    = Math.round(Math.cos(angle) * dist);
    const cy    = Math.round(Math.sin(angle) * dist - 25); // upward bias
    const cr    = Math.round((Math.random() - 0.5) * 580) + 'deg';
    const cd    = (0.60 + Math.random() * 0.55).toFixed(2) + 's';
    el.style.cssText =
      `left:${ox}px;top:${oy}px;` +
      `background:${_CONF_COLORS[i % _CONF_COLORS.length]};` +
      `--cx:${cx}px;--cy:${cy}px;--cr:${cr};--cd:${cd};` +
      `border-radius:${Math.random() > 0.45 ? '50%' : '2px'};`;
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }
}

// ── Init ────────────────────────────────────────────────────────────
async function init() {
  await migrateTaskLists();
  await renderListSelector();
  await renderTasks();
  await loadDashStats();
  const { activeTaskId, pomodoroState } = await chrome.storage.local.get(['activeTaskId', 'pomodoroState']);
  // If work session ended while popup was closed — complete the task (do not transition to break)
  if (activeTaskId && pomodoroState && pomodoroState.phase === 'work' && pomodoroState.endTime - Date.now() <= 0) {
    chrome.runtime.sendMessage({ type: 'STOP_POMODORO' });
    await finishTaskWithCelebration(activeTaskId);
  } else if (activeTaskId && pomodoroState?.running) {
    startTick();
  }
}

init();

// ── Task title marquee on hover ──────────────────────────────────────
(function initTaskTitleMarquee() {
  const taskList = document.getElementById('taskList');
  if (!taskList) return;

  // Cubic ease-out: starts fast, decelerates toward end — fluid feel
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  // Cubic ease-in-out: for return scroll
  function easeInOutCubic(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }

  function animateScroll(el, from, to, duration, easeFn) {
    cancelAnimationFrame(el._maqRaf);
    let start = null;
    function step(ts) {
      if (!start) start = ts;
      const t = Math.min((ts - start) / duration, 1);
      el.scrollLeft = from + (to - from) * easeFn(t);
      el._maqRaf = t < 1 ? requestAnimationFrame(step) : null;
    }
    el._maqRaf = requestAnimationFrame(step);
  }

  function tryMarquee(el) {
    if (!el || el._maqPending || el.classList.contains('is-scrolling')) return;
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 4) return;
    el._maqPending = setTimeout(() => {
      el._maqPending = null;
      el.classList.add('is-scrolling');
      const dur = Math.max(2000, Math.min(overflow * 40, 5000));
      animateScroll(el, 0, overflow, dur, easeOutCubic);
    }, 350);
  }

  function resetMarquee(el) {
    if (!el) return;
    clearTimeout(el._maqPending);
    el._maqPending = null;
    const cur = el.scrollLeft;
    el.classList.remove('is-scrolling');
    if (cur > 0) animateScroll(el, cur, 0, Math.max(400, cur * 7), easeInOutCubic);
  }

  taskList.addEventListener('mouseover', e => {
    const card = e.target.closest('.task-card:not(.done):not(.active)');
    if (!card) return;
    tryMarquee(card.querySelector('.task-title'));
    tryMarquee(e.target.closest('.task-sub-title'));
  });

  // mouseout bubbles; relatedTarget check ensures we only reset when truly leaving the card
  taskList.addEventListener('mouseout', e => {
    const card = e.target.closest('.task-card');
    if (!card || card.contains(e.relatedTarget)) return;
    card.querySelectorAll('.task-title.is-scrolling, .task-sub-title.is-scrolling').forEach(resetMarquee);
  });
})();

// ── Utility ──────────────────────────────────────────────────────────────────────

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _normalizeDomain(raw) {
  return raw.trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

async function renderCustomBlocklist() {
  const today = new Date().toISOString().slice(0, 10);
  const data = await chrome.storage.local.get(['customBlocklist', 'distractionsAvoided']);
  const list  = data.customBlocklist || [];
  const count = (data.distractionsAvoided || {})[today] || 0;

  const chip = document.getElementById('focusStatsChip');
  if (chip) chip.textContent = `${count} blocked today`;

  const container = document.getElementById('blocklistList');
  if (!container) return;
  if (!list.length) {
    container.innerHTML = `<div class="blocklist-empty">No custom sites blocked</div>`;
    return;
  }
  container.innerHTML = list.map((domain, i) =>
    `<div class="blocklist-item">
       <span class="blocklist-domain">${escHtml(domain)}</span>
       <button class="del-btn" data-idx="${i}" title="Remove">
         <svg fill="none" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
       </button>
     </div>`
  ).join('');

  container.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { customBlocklist: cur = [] } = await chrome.storage.local.get(['customBlocklist']);
      await storageSet({ customBlocklist: cur.filter((_, i) => i !== +btn.dataset.idx) });
      renderCustomBlocklist();
    });
  });
}

async function _addBlocklistDomain() {
  const inp = document.getElementById('blocklistInp');
  const domain = _normalizeDomain(inp.value);
  if (!domain || domain.length < 3 || !domain.includes('.')) return;
  const { customBlocklist: cur = [] } = await chrome.storage.local.get(['customBlocklist']);
  if (cur.includes(domain) || cur.length >= 200) { inp.value = ''; return; }
  await storageSet({ customBlocklist: [...cur, domain] });
  inp.value = '';
  renderCustomBlocklist();
}

// Sanitize URL — only allow http/https to prevent javascript: injection
function safeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return url;
  } catch(_) {}
  return '';
}

// ── Chrome Storage Sync ──────────────────────────────────────────────
// Event-driven: onChanged from any context (dashboard, background) → instant UI update
let _syncRenderTimer = null;
let _syncStatsTimer  = null;

function _onStorageChanged(changes, areaName) {
  if (areaName !== 'local') return;

  // ── Toggles (update immediately, no render needed) ──
  if (changes.focusMode) {
    const focusToggle = document.getElementById('focusToggle');
    if (focusToggle) {
      changes.focusMode.newValue
        ? focusToggle.classList.add('on')
        : focusToggle.classList.remove('on');
    }
  }

  if (changes.autoMode) {
    const autoToggle = document.getElementById('autoToggle');
    if (autoToggle) {
      changes.autoMode.newValue
        ? autoToggle.classList.add('on')
        : autoToggle.classList.remove('on');
    }
  }

  // ── Sound setting sync ──
  if (changes.soundEnabled) {
    soundOn = changes.soundEnabled.newValue !== false;
    const sndBtn = document.getElementById('sndBtn');
    if (sndBtn) sndBtn.classList.toggle('on', soundOn);
  }

  // ── Pomodoro state → timer UI ──
  if (changes.pomodoroState) {
    const ps = changes.pomodoroState.newValue;
    if (ps?.running) {
      startTick();
    } else {
      stopTick();
    }
    // Render tasks to reflect timer state change
    _debouncedRenderTasks();
  }

  // ── Active task change ──
  if (changes.activeTaskId) {
    const newId = changes.activeTaskId.newValue;
    if (!newId) {
      stopTick();
      ctrlModeOn = false;
    }
    _debouncedRenderTasks();
  }

  // ── Tasks changed (task CRUD) ──
  if (changes.tasks) {
    _allTasks = changes.tasks.newValue || [];
    _debouncedRenderTasks();
  }

  // ── Task lists changed ──
  if (changes.taskLists) {
    _taskLists = changes.taskLists.newValue || [];
    renderListSelector();
    _debouncedRenderTasks();
  }

  // ── Active list changed ──
  if (changes.activeListId) {
    _activeListId = changes.activeListId.newValue || 'default';
    renderListSelector();
    _debouncedRenderTasks();
  }

  // ── Stats ──
  if (changes.stats || changes.siteStats || changes.siteMeta) {
    clearTimeout(_syncStatsTimer);
    _syncStatsTimer = setTimeout(() => {
      loadDashStats();
      const statsPanel = document.getElementById('panel-stats');
      if (statsPanel?.classList.contains('active')) renderStats(false);
    }, 150);
  }

  // ── Category rules ──
  if (changes.customCategories) {
    renderOrganizePanel();
  }


  // ── Focus task sync ──
  if (changes.focusTask) {
    // Update focusTask UI in popup if present (future use)
  }

  // ── Custom blocklist + distraction stats ──
  if (changes.customBlocklist) {
    renderCustomBlocklist();
  }
  if (changes.distractionsAvoided) {
    const today = new Date().toISOString().slice(0, 10);
    const count = (changes.distractionsAvoided.newValue || {})[today] || 0;
    const chip = document.getElementById('focusStatsChip');
    if (chip) chip.textContent = `${count} blocked today`;
  }

  // ── Dashboard settings (dashTheme, dashBlockingEnabled, etc.) ──
  // These are listened to on the Dashboard side; popup just passes them through
}
chrome.storage.onChanged.addListener(_onStorageChanged);

// ═══════════════════════════════════════════════════════════════════════
// BROWSER BOOKMARKS PANEL
// ═══════════════════════════════════════════════════════════════════════

let _bkSearchQ = '';
let _bkToggled = new Set(); // folderIds whose state differs from the default
let _bkInited = false;
let _bkDragId = null; // id of the bookmark being dragged

function _bkEscHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _bkEscAttr(str) {
  return String(str || '').replace(/"/g,'&quot;');
}

function _bkCountItems(node) {
  let n = 0;
  function walk(nd) { if (nd.url) n++; if (nd.children) nd.children.forEach(walk); }
  walk(node);
  return n;
}

function _bkFavUrl(url) {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=16`; } catch { return ''; }
}

function _bkNormalizeTitle(title, id) {
  // B18: Use node ID for root folder detection — title is locale-dependent
  if (id === '1') return 'Bookmarks Bar';
  if (id === '2') return 'Other Bookmarks';
  if (id === '3') return 'Mobile Bookmarks';
  return title || '';
}

function _bkBuildItem(node, showPath, depth) {
  const fav = _bkFavUrl(node.url);
  const pl = depth > 0 ? `padding-left:${depth * 20 + 8}px;` : '';
  const favHtml = fav
    ? `<div class="bk-fav-wrap"><div class="bk-fav-skeleton"></div><img class="bk-fav" src="${fav}" loading="lazy"/></div>`
    : '<span class="bk-fav-ph"></span>';
  return `<div class="bk-item" draggable="true" data-bid="${node.id}" data-url="${_bkEscAttr(node.url)}" style="${pl}">
    <span class="bk-drag-handle"><svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="2" r="1.2"/><circle cx="7" cy="2" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="12" r="1.2"/><circle cx="7" cy="12" r="1.2"/></svg></span>
    ${favHtml}
    <div class="bk-item-info">
      ${showPath && node._path ? `<span class="bk-item-path">${_bkEscHtml(node._path)}</span>` : ''}
      <span class="bk-item-title" data-bid="${node.id}">${_bkEscHtml(node.title || node.url)}</span>
      <span class="bk-item-url" data-bid="${node.id}" title="${_bkEscAttr(node.url)}">${_bkEscHtml(node.url)}</span>
    </div>
    <div class="bk-item-acts">
      <button class="bk-item-open" data-url="${_bkEscAttr(node.url)}" title="Open in new tab">
        <svg fill="none" viewBox="0 0 12 12"><path d="M5 2H2a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1V8M8 1h3m0 0v3M11 1L5.5 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="bk-item-del" data-bid="${node.id}" title="Delete">
        <svg fill="none" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
    </div>
  </div>`;
}

function _bkBuildFolder(node, depth) {
  const isDefaultOpen = depth === 0;
  const isToggled = _bkToggled.has(node.id);
  const isOpen = isToggled ? !isDefaultOpen : isDefaultOpen;
  
  const cnt = _bkCountItems(node);
  const isSub = depth > 0;
  const indent = isSub ? `margin-left:${depth * 16}px;` : '';
  const children = node.children || [];
  const childHtml = children.map(c => _bkBuildNode(c, depth + 1)).join('');
  const displayTitle = _bkNormalizeTitle(node.title, node.id) || 'Folder';
  return `<div class="bk-folder ${isSub ? 'bk-subfolder' : ''}" data-fid="${node.id}" data-depth="${depth}" style="${indent}">
    <div class="bk-folder-hdr" data-fid="${node.id}">
      <span class="bk-farr ${isOpen ? 'open' : ''}">
        <svg fill="none" viewBox="0 0 10 10"><path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
      <span class="bk-folder-ico">
        <svg fill="none" viewBox="0 0 14 14"><path d="M1 4.5a1 1 0 011-1h3l1.5 1.5H12a1 1 0 011 1V11a1 1 0 01-1 1H2a1 1 0 01-1-1V4.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
      </span>
      <span class="bk-folder-name">${_bkEscHtml(displayTitle)}</span>
      <span class="bk-folder-cnt" data-count="${cnt}">0</span>
      <div class="bk-folder-acts">
        <button class="bk-folder-del" data-fid="${node.id}" title="Delete folder">
          <svg fill="none" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>
    <div class="bk-folder-children ${isOpen ? 'open' : ''}">
      <div class="bk-fc-inner">
        ${childHtml || '<div class="bk-folder-empty-msg">Empty folder</div>'}
      </div>
    </div>
  </div>`;
}

function _bkBuildNode(node, depth) {
  if (node.url) return _bkBuildItem(node, false, depth);
  return _bkBuildFolder(node, depth);
}

function _bkCollectAll(nodes, path, out) {
  for (const node of nodes) {
    if (node.url) {
      const t = (node.title || '').toLowerCase();
      const u = (node.url || '').toLowerCase();
      if (t.includes(_bkSearchQ) || u.includes(_bkSearchQ)) {
        out.push({ ...node, _path: path });
      }
    }
    if (node.children) {
      const sub = path ? path + ' / ' + _bkNormalizeTitle(node.title, node.id) : _bkNormalizeTitle(node.title, node.id);
      _bkCollectAll(node.children, sub, out);
    }
  }
}

// ── Count-up animation for folder badges ──────────────────────────────────────
function _bkRunCountUp(container) {
  container.querySelectorAll('.bk-folder-cnt[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count, 10) || 0;
    if (!target) { el.textContent = '0'; return; }
    const dur = Math.min(700, 80 + target * 16);
    const start = performance.now();
    function step(now) {
      const p = Math.min(1, (now - start) / dur);
      el.textContent = Math.round((1 - Math.pow(1 - p, 3)) * target);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

// ── Add-form animated show/hide ───────────────────────────────────────────────
function _bkOpenForm() {
  const form = document.getElementById('bkAddForm');
  form.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => form.classList.add('open')));
}
function _bkCloseForm() {
  const form = document.getElementById('bkAddForm');
  form.classList.remove('open');
  // Fallback: if transitionend never fires (no transition / reduced motion), hide after 350ms
  let handled = false;
  const hide = () => {
    if (handled) return;
    handled = true;
    if (!form.classList.contains('open')) form.style.display = 'none';
  };
  form.addEventListener('transitionend', hide, { once: true });
  setTimeout(hide, 350);
}

async function renderBookmarks() {
  const container = document.getElementById('bkTree');
  if (!container) return;

  container.innerHTML = `<div class="bk-empty" style="color:var(--text-4);padding:20px">Loading bookmarks…</div>`;

  // Guard: permission might not be active until extension is reloaded
  if (!chrome.bookmarks) {
    console.warn('[TabClaw] chrome.bookmarks API not available — reload the extension at chrome://extensions');
    container.innerHTML = `<div class="bk-empty">Bookmarks API unavailable.<br>Reload the extension at <em>chrome://extensions</em>.</div>`;
    return;
  }

  let tree;
  try {
    tree = await new Promise((resolve, reject) => {
      chrome.bookmarks.getTree(result => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  } catch (err) {
    console.error('[TabClaw] chrome.bookmarks.getTree error:', err);
    container.innerHTML = `<div class="bk-empty">Could not load bookmarks:<br>${_bkEscHtml(err.message)}</div>`;
    return;
  }

  const topLevel = (tree && tree[0]?.children) || [];

  if (!topLevel.length) {
    container.innerHTML = `<div class="bk-empty">No bookmarks found.</div>`;
    return;
  }

  if (_bkSearchQ) {
    const results = [];
    _bkCollectAll(topLevel, '', results);
    if (!results.length) {
      container.innerHTML = `<div class="bk-empty">No results for "<strong>${_bkEscHtml(_bkSearchQ)}</strong>"</div>`;
    } else {
      container.innerHTML = `<div class="bk-folder-children open">${results.map(n => _bkBuildItem(n, true, 0)).join('')}</div>`;
    }
  } else {
    container.innerHTML = topLevel.map(n => _bkBuildNode(n, 0)).join('');
  }

  _bkAttachEvents(container);

  // Count-up badges
  _bkRunCountUp(container);

  // Stagger-in items that are already visible (open folders + search results)
  container.querySelectorAll('.bk-folder-children.open .bk-item').forEach((item, i) => {
    item.animate([
      { opacity: '0', transform: 'translateY(5px)' },
      { opacity: '1', transform: 'translateY(0)'   }
    ], { duration: 200, delay: Math.min(i, 16) * 18, fill: 'both', easing: 'cubic-bezier(0.4,0,0.2,1)' });
  });
}

function _bkAttachEvents(container) {
  // Favicon load/error (inline handlers blocked by CSP)
  container.querySelectorAll('.bk-fav').forEach(img => {
    img.addEventListener('load', function() {
      this.classList.add('loaded');
      if (this.previousElementSibling) this.previousElementSibling.style.display = 'none';
    });
    img.addEventListener('error', function() {
      if (this.parentElement) this.parentElement.innerHTML = '<span class="bk-fav-ph"></span>';
    });
    // Already loaded from cache
    if (img.complete && img.naturalWidth > 0) {
      img.classList.add('loaded');
      if (img.previousElementSibling) img.previousElementSibling.style.display = 'none';
    }
  });

  // Folder toggle
  container.querySelectorAll('.bk-folder-hdr').forEach(hdr => {
    hdr.addEventListener('click', e => {
      if (e.target.closest('.bk-folder-del')) return;
      const fid = hdr.dataset.fid;
      const folder = hdr.closest('.bk-folder');
      const children = folder.querySelector('.bk-folder-children');
      const arr = hdr.querySelector('.bk-farr');
      const opening = !children.classList.contains('open');
      const isDefaultOpen = folder.dataset.depth === "0";
      
      if (opening !== isDefaultOpen) { 
        _bkToggled.add(fid); 
      } else { 
        _bkToggled.delete(fid); 
      }
      
      children.classList.toggle('open', opening);
      arr.classList.toggle('open', opening);
      // Staggered entrance when opening
      if (opening) {
        const items = children.querySelectorAll('.bk-item');
        items.forEach((item, i) => {
          item.animate([
            { opacity: '0', transform: 'translateY(7px)' },
            { opacity: '1', transform: 'translateY(0)'   }
          ], { duration: 240, delay: Math.min(i, 14) * 28, fill: 'both', easing: 'cubic-bezier(0.34,1.56,0.64,1)' });
        });
      }
    });
  });

  // Folder delete
  container.querySelectorAll('.bk-folder-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const fid = btn.dataset.fid;
      const name = btn.closest('.bk-folder-hdr').querySelector('.bk-folder-name').textContent;
      if (!confirm(`Delete "${name}" and all its bookmarks?`)) return;
      await new Promise(r => chrome.bookmarks.removeTree(fid, r));
      renderBookmarks();
    });
  });

  // Item open
  container.querySelectorAll('.bk-item-open').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      chrome.tabs.create({ url: btn.dataset.url });
    });
  });

  // Item delete
  container.querySelectorAll('.bk-item-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await new Promise(r => chrome.bookmarks.remove(btn.dataset.bid, r));
      renderBookmarks();
    });
  });

  // Item body click → open URL (excludes editable spans to avoid conflict with dblclick-edit)
  container.querySelectorAll('.bk-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.bk-item-acts')) return;
      if (e.target.closest('.bk-drag-handle')) return;
      if (e.target.closest('.bk-item-title')) return;
      if (e.target.closest('.bk-item-url')) return;
      if (e.target.tagName === 'INPUT') return;
      const url = item.dataset.url;
      if (url) chrome.tabs.create({ url });
    });
  });

  // Inline edit — title (double-click); single-click opens URL via debounce
  container.querySelectorAll('.bk-item-title').forEach(span => {
    let _t = null;
    span.addEventListener('click', e => {
      e.stopPropagation();
      if (span.querySelector('input')) return;
      clearTimeout(_t);
      _t = setTimeout(() => {
        const url = span.closest('.bk-item')?.dataset?.url;
        if (url) chrome.tabs.create({ url });
      }, 250);
    });
    span.addEventListener('dblclick', e => {
      e.stopPropagation();
      clearTimeout(_t);
      if (span.querySelector('input')) return;
      const bid = span.dataset.bid;
      const inp = document.createElement('input');
      inp.className = 'bk-inline-inp';
      inp.value = span.textContent === '(no title)' ? '' : span.textContent;
      span.replaceWith(inp);
      inp.focus(); inp.select();
      async function save() {
        const newTitle = inp.value.trim() || '(no title)';
        await new Promise(r => chrome.bookmarks.update(bid, { title: newTitle }, r));
        renderBookmarks();
      }
      inp.addEventListener('blur', save);
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); inp.removeEventListener('blur', save); save(); }
        if (ev.key === 'Escape') renderBookmarks();
      });
    });
  });

  // Inline edit — URL (double-click)
  container.querySelectorAll('.bk-item-url').forEach(span => {
    span.addEventListener('click', e => { e.stopPropagation(); }); // block item body click
    span.addEventListener('dblclick', e => {
      e.stopPropagation();
      if (span.querySelector('input')) return;
      const bid = span.dataset.bid;
      const inp = document.createElement('input');
      inp.className = 'bk-inline-inp url';
      inp.value = span.textContent;
      span.replaceWith(inp);
      inp.focus(); inp.select();
      async function save() {
        const newUrl = inp.value.trim();
        if (newUrl) await new Promise(r => chrome.bookmarks.update(bid, { url: newUrl }, r));
        renderBookmarks();
      }
      inp.addEventListener('blur', save);
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); inp.removeEventListener('blur', save); save(); }
        if (ev.key === 'Escape') renderBookmarks();
      });
    });
  });

  // ── Drag & Drop ──────────────────────────────────────────────────────────────
  function _clearDragIndicators() {
    container.querySelectorAll('.drag-over-top, .drag-over-bottom, .drag-over-folder')
      .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-folder'));
  }

  // Items: drag source + drop target (reorder / move)
  container.querySelectorAll('.bk-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      _bkDragId = item.dataset.bid;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', _bkDragId);
      setTimeout(() => item.classList.add('is-dragging'), 0);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('is-dragging');
      _bkDragId = null;
      _clearDragIndicators();
    });

    item.addEventListener('dragover', e => {
      if (!_bkDragId || item.dataset.bid === _bkDragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = item.getBoundingClientRect();
      const isTop = e.clientY < rect.top + rect.height / 2;
      item.classList.toggle('drag-over-top', isTop);
      item.classList.toggle('drag-over-bottom', !isTop);
    });

    item.addEventListener('dragleave', e => {
      if (!item.contains(e.relatedTarget))
        item.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    item.addEventListener('drop', async e => {
      e.preventDefault();
      const rect = item.getBoundingClientRect();
      const insertBefore = e.clientY < rect.top + rect.height / 2;
      item.classList.remove('drag-over-top', 'drag-over-bottom');
      const dragId = _bkDragId;
      _bkDragId = null;
      if (!dragId || item.dataset.bid === dragId) return;

      const results = await new Promise(resolve => {
        chrome.bookmarks.get(item.dataset.bid, r => { void chrome.runtime.lastError; resolve(r); });
      });
      if (!results || !results[0]) return;

      const destIndex = insertBefore ? results[0].index : results[0].index + 1;
      await new Promise(resolve => {
        chrome.bookmarks.move(dragId, { parentId: results[0].parentId, index: destIndex }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
      renderBookmarks();
    });
  });

  // Folder headers: drop target (move bookmark into folder, append to end)
  container.querySelectorAll('.bk-folder-hdr').forEach(hdr => {
    hdr.addEventListener('dragover', e => {
      if (!_bkDragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      hdr.classList.add('drag-over-folder');
    });

    hdr.addEventListener('dragleave', e => {
      if (!hdr.contains(e.relatedTarget)) hdr.classList.remove('drag-over-folder');
    });

    hdr.addEventListener('drop', async e => {
      e.preventDefault();
      hdr.classList.remove('drag-over-folder');
      const fid = hdr.dataset.fid;
      const dragId = _bkDragId;
      _bkDragId = null;
      if (!dragId || !fid) return;
      await new Promise(resolve => {
        chrome.bookmarks.move(dragId, { parentId: fid }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
      renderBookmarks();
    });
  });
}

async function _bkGetDefaultFolderId() {
  const tree = await new Promise(r => chrome.bookmarks.getTree(r));
  const root = tree && tree[0];
  if (!root || !root.children) return '1';
  // Prefer "Other Bookmarks" (typically id "2"), fall back to first available folder
  const otherBk = root.children.find(n => n.id === '2' || (n.title && /other/i.test(n.title)));
  return (otherBk || root.children[0] || root).id;
}

async function _bkCreateBookmark() {
  const titleEl = document.getElementById('bkNewTitle');
  const urlEl   = document.getElementById('bkNewUrl');
  const title = titleEl.value.trim();
  let url = urlEl.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const parentId = await _bkGetDefaultFolderId();
  await new Promise(r => chrome.bookmarks.create({ parentId, title: title || url, url }, r));
  titleEl.value = ''; urlEl.value = '';
  _bkCloseForm();
  renderBookmarks();
}

// ── Auto-Organize ─────────────────────────────────────────────────────────────
// Category dictionary and _bkCategorize() are defined in bk-categorizer.js

function _bkCollectAllItems(nodes, out) {
  for (const node of nodes) {
    if (node.url) out.push(node);
    if (node.children) _bkCollectAllItems(node.children, out);
  }
}

function _bkOrgSetStatus(html) {
  const bar = document.getElementById('bkOrgBar');
  if (!bar) return;
  bar.hidden = false;
  bar.innerHTML = `<div class="bk-org-working"><span class="bk-org-spinner"></span><span>${html}</span></div>`;
}

function _bkOrgSetError(html) {
  const bar = document.getElementById('bkOrgBar');
  if (!bar) return;
  bar.hidden = false;
  bar.innerHTML = `<div class="bk-org-working"><span>${html}</span><button class="bk-org-close-btn" title="Dismiss"><svg fill="none" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></div>`;
  bar.querySelector('.bk-org-close-btn').addEventListener('click', () => { bar.hidden = true; });
}

function _bkOrgShowDone(count, catCount) {
  const bar = document.getElementById('bkOrgBar');
  if (!bar) return;
  bar.hidden = false;
  bar.innerHTML = `<div class="bk-org-done">
    <span class="bk-org-done-ico">✓</span>
    <span class="bk-org-summary">${count} bookmark${count !== 1 ? 's' : ''} organized into ${catCount} categor${catCount !== 1 ? 'ies' : 'y'}</span>
    <button class="bk-org-undo-btn" id="bkOrgUndo">Undo</button>
    <button class="bk-org-close-btn" id="bkOrgDismiss" title="Dismiss">
      <svg fill="none" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
    </button>
  </div>`;
  document.getElementById('bkOrgUndo').addEventListener('click', _bkUndoOrganize);
  document.getElementById('bkOrgDismiss').addEventListener('click', () => {
    document.getElementById('bkOrgBar').hidden = true;
  });
}

async function _bkAutoOrganize() {
  if (!chrome.bookmarks) return;
  const btn = document.getElementById('bkOrgBtn');
  if (btn) btn.disabled = true;

  _bkOrgSetStatus('Analyzing bookmarks…');

  let tree;
  try {
    tree = await new Promise((resolve, reject) => {
      chrome.bookmarks.getTree(r => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(r);
      });
    });
  } catch (err) {
    _bkOrgSetError(`Error: ${_bkEscHtml(err.message)}`);
    if (btn) btn.disabled = false;
    return;
  }

  const rootChildren = (tree && tree[0]?.children) || [];

  // Use Bookmarks Bar (id "1") as the parent for category folders
  const bkBarNode = rootChildren.find(n => n.id === '1') || rootChildren[0];
  if (!bkBarNode) {
    _bkOrgSetError('Bookmarks bar not found.');
    if (btn) btn.disabled = false;
    return;
  }
  const createParentId = bkBarNode.id;

  // Collect all bookmark items from ALL root children (Bookmarks Bar + Other + etc.)
  const allItems = [];
  _bkCollectAllItems(rootChildren, allItems);

  if (!allItems.length) {
    _bkOrgSetError('No bookmarks found.');
    if (btn) btn.disabled = false;
    return;
  }

  _bkOrgSetStatus(`Categorizing ${allItems.length} bookmark${allItems.length !== 1 ? 's' : ''}…`);

  // Categorize each bookmark
  const buckets = new Map();
  for (const item of allItems) {
    const cat = _bkCategorize(item.title || '', item.url || '');
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat).push(item);
  }

  // Sort by count desc; 'Other' always last
  const sortedCats = [...buckets.entries()].sort((a, b) => {
    if (a[0] === 'Other') return 1;
    if (b[0] === 'Other') return -1;
    return b[1].length - a[1].length;
  });

  // Save snapshot of original positions for undo
  const snapshot = {
    version: 1,
    createdAt: Date.now(),
    count: allItems.length,
    categories: sortedCats.length,
    items: allItems.map(n => ({ id: n.id, parentId: n.parentId })),
    catFolderIds: [],
  };

  _bkOrgSetStatus('Creating folders…');

  // Load existing children of the target parent once, to enable find-or-create logic
  let existingChildren = [];
  try {
    existingChildren = await new Promise((resolve, reject) => {
      chrome.bookmarks.getChildren(createParentId, nodes => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(nodes || []);
      });
    });
  } catch { /* non-fatal — fall back to always creating */ }

  // Build a name→id map of existing folders so we never create duplicates
  const existingFolderMap = new Map();
  for (const child of existingChildren) {
    if (!child.url) existingFolderMap.set(child.title, child.id);
  }

  // Create category folders directly on the Bookmarks Bar and move bookmarks into them
  let moved = 0;
  for (const [catName, items] of sortedCats) {
    let catFolder;
    if (existingFolderMap.has(catName)) {
      // Reuse the existing folder — no duplicate created
      catFolder = { id: existingFolderMap.get(catName) };
    } else {
      // Double-check with chrome.bookmarks.search before creating to prevent duplicates
      let folderId = null;
      try {
        const searchResults = await new Promise((resolve, reject) => {
          chrome.bookmarks.search({ title: catName }, nodes => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(nodes || []);
          });
        });
        // Only match a folder that lives directly under our target parent with an exact title
        const match = searchResults.find(n => !n.url && n.parentId === createParentId && n.title === catName);
        if (match) folderId = match.id;
      } catch { /* non-fatal — proceed to create */ }

      if (folderId) {
        // Existing folder found via search — reuse it, register for later iterations
        catFolder = { id: folderId };
        existingFolderMap.set(catName, folderId);
      } else {
        try {
          catFolder = await new Promise((resolve, reject) => {
            chrome.bookmarks.create({ parentId: createParentId, title: catName }, node => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(node);
            });
          });
          // Register the newly created folder so later iterations can reuse it too
          existingFolderMap.set(catName, catFolder.id);
        } catch {
          continue;
        }
      }
    }
    snapshot.catFolderIds.push(catFolder.id);

    for (const item of items) {
      await new Promise(resolve => {
        chrome.bookmarks.move(item.id, { parentId: catFolder.id }, () => {
          void chrome.runtime.lastError; // consume to avoid unchecked-error warning
          resolve();
        });
      });
      moved++;
      if (moved % 25 === 0) {
        _bkOrgSetStatus(`Moving bookmarks (${moved}/${allItems.length})…`);
      }
    }
  }

  // Persist snapshot for undo
  await new Promise(r => chrome.storage.local.set({ bkOrgSnapshot: snapshot }, r));

  if (btn) btn.disabled = false;
  _bkOrgShowDone(moved, sortedCats.length);
  renderBookmarks();
}

async function _bkUndoOrganize() {
  const undoBtn = document.getElementById('bkOrgUndo');
  if (undoBtn) undoBtn.disabled = true;

  _bkOrgSetStatus('Restoring original structure…');

  const { bkOrgSnapshot } = await new Promise(r => chrome.storage.local.get('bkOrgSnapshot', r));
  if (!bkOrgSnapshot) {
    document.getElementById('bkOrgBar').hidden = true;
    renderBookmarks();
    return;
  }

  // Move each bookmark back to its original parent
  let restored = 0;
  for (const item of bkOrgSnapshot.items) {
    await new Promise(resolve => {
      chrome.bookmarks.move(item.id, { parentId: item.parentId }, () => {
        void chrome.runtime.lastError; // consume; item may be deleted or parent gone
        resolve();
      });
    });
    restored++;
    if (restored % 25 === 0) {
      _bkOrgSetStatus(`Restoring (${restored}/${bkOrgSnapshot.items.length})…`);
    }
  }

  // Remove the auto-created category folders (now empty after moving items back)
  for (const fid of (bkOrgSnapshot.catFolderIds || [])) {
    await new Promise(resolve => {
      chrome.bookmarks.removeTree(fid, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  // Clear snapshot
  await new Promise(r => chrome.storage.local.remove('bkOrgSnapshot', r));

  document.getElementById('bkOrgBar').hidden = true;
  renderBookmarks();
}

function initBookmarksPanel() {
  if (_bkInited) return;
  _bkInited = true;

  const searchEl = document.getElementById('bkSearch');
  const clearEl  = document.getElementById('bkSearchClear');

  searchEl.addEventListener('input', () => {
    _bkSearchQ = searchEl.value.trim().toLowerCase();
    clearEl.style.display = _bkSearchQ ? 'block' : 'none';
    renderBookmarks();
  });
  clearEl.addEventListener('click', () => {
    searchEl.value = ''; _bkSearchQ = '';
    clearEl.style.display = 'none';
    renderBookmarks();
  });

  document.getElementById('bkFormCancel').addEventListener('click', () => {
    _bkCloseForm();
    document.getElementById('bkNewTitle').value = '';
    document.getElementById('bkNewUrl').value = '';
  });

  document.getElementById('bkFormSave').addEventListener('click', _bkCreateBookmark);
  document.getElementById('bkNewUrl').addEventListener('keydown', e => {
    if (e.key === 'Enter') _bkCreateBookmark();
  });
  document.getElementById('bkNewTitle').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('bkNewUrl').focus();
  });

  document.getElementById('bkSaveTabBtn').addEventListener('click', async () => {
    const [tab] = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
    if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) return;
    const parentId = await _bkGetDefaultFolderId();
    await new Promise(r => chrome.bookmarks.create({ parentId, title: tab.title || tab.url, url: tab.url }, r));
    const btn = document.getElementById('bkSaveTabBtn');
    btn.classList.add('pulse-once');
    setTimeout(() => btn.classList.remove('pulse-once'), 2000);
    renderBookmarks();
  });

  document.getElementById('bkOrgBtn').addEventListener('click', _bkAutoOrganize);

  // ── Auto toggle ──────────────────────────────────────────────────────
  const bkAutoToggleEl = document.getElementById('bkAutoToggle');
  chrome.storage.local.get('bkAutoMode', r => {
    if (r.bkAutoMode) bkAutoToggleEl.classList.add('on');
  });
  bkAutoToggleEl.addEventListener('click', () => {
    const on = bkAutoToggleEl.classList.toggle('on');
    chrome.storage.local.set({ bkAutoMode: on });
  });

  // Restore undo bar if a snapshot exists from a previous organize
  chrome.storage.local.get('bkOrgSnapshot', r => {
    if (r.bkOrgSnapshot) _bkOrgShowDone(r.bkOrgSnapshot.count, r.bkOrgSnapshot.categories);
  });
}

// Unload: remove listener and timers to avoid memory leaks (e.g. when side panel closes)
function _storageSyncCleanup() {
  chrome.storage.onChanged.removeListener(_onStorageChanged);
  clearTimeout(_syncRenderTimer);
  _syncRenderTimer = null;
  clearTimeout(_syncStatsTimer);
  _syncStatsTimer = null;
  if (_storageFlushTimer) { clearTimeout(_storageFlushTimer); _storageFlushTimer = null; }
  // B20: clear break overlay interval if popup closes mid-break
  if (_breakInterval) { clearInterval(_breakInterval); _breakInterval = null; }
}
window.addEventListener('pagehide', _storageSyncCleanup);
window.addEventListener('beforeunload', _storageSyncCleanup);

function _debouncedRenderTasks() {
  clearTimeout(_syncRenderTimer);
  _syncRenderTimer = setTimeout(async () => {
    await renderListSelector();
    await renderTasks();
  }, 80);
}