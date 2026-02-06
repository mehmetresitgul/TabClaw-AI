// TabClaw AI Background Service Worker
importScripts('categorizer.js');

let tabCategories = {};
let tabUrls       = {};
let tabIncognito  = {};
let activeTabId   = null;
let activeStart   = null;
let _isIdle       = false;

// ── Focus Block Domains (must be at top — referenced by isDistractionDomain) ──
const FOCUS_BLOCK_DOMAINS = [
  'twitter.com','x.com','instagram.com','facebook.com','fb.com',
  'messenger.com','whatsapp.com','telegram.org','discord.com',
  'linkedin.com','snapchat.com','tiktok.com','pinterest.com',
  'reddit.com','mastodon.social','threads.net','signal.org',
  'bereal.com','tumblr.com','skype.com','vk.com','ok.ru',
  'bsky.app','bluesky.social','slack.com','youtube.com','youtu.be',
  'twitch.tv','kick.com','rumble.com','netflix.com','primevideo.com',
  'disneyplus.com','hulu.com','max.com','9gag.com','imgur.com',
  'giphy.com','buzzfeed.com','boredpanda.com','miniclip.com',
  'poki.com','crazygames.com'
];
const FOCUS_RULE_BASE_ID  = 9000;
const CUSTOM_RULE_BASE_ID = 10000;

function _isCustomBlocked(url, list) {
  let h = '';
  try { h = new URL(url).hostname.replace(/^www\./, ''); } catch { return false; }
  return list.some(d => h === d || h.endsWith('.' + d));
}

// ── Missing function: classify tab by URL only (no page signals) ────
function classifyFromUrl(url, title, customCategories) {
  let hostname = '';
  try { if (url) hostname = new URL(url).hostname.replace(/^www\./, ''); } catch(e) {}
  const custom = customCategories || [];
  const all = [...custom, ...DEFAULT_CATEGORIES];
  // 1. Domain match
  if (hostname) {
    for (const cat of all) {
      if ((cat.domains || []).some(d => hostname === d || hostname.endsWith('.' + d)))
        return cat;
    }
  }
  // 2. Keyword scoring
  const text = ((url || '') + ' ' + (title || '')).toLowerCase();
  let best = null, top = 0;
  for (const cat of all) {
    let s = 0;
    for (const kw of (cat.keywords || [])) { if (text.includes(kw)) s += 2; }
    if (s > top) { top = s; best = cat; }
  }
  if (top >= 4) return best;
  return FALLBACK_CATEGORY;
}

// ── Missing function: check if a URL belongs to a distraction domain ─
function isDistractionDomain(url) {
  let hostname = '';
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch(e) { return false; }
  return FOCUS_BLOCK_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
}

// Restores active tab state when the service worker wakes up (MV3 suspend fix)
async function _restoreActiveState() {
  if (activeTabId !== null) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) {
      activeTabId = tab.id;
      activeStart = _isIdle ? null : Date.now();
      if (tab.url) tabUrls[tab.id] = tab.url;
      tabIncognito[tab.id] = tab.incognito || false;
      if (!tabCategories[tab.id] && tab.url) {
        const c = classifyFromUrl(tab.url);
        if (c) tabCategories[tab.id] = c.name;
      }
    }
  } catch(e) {}
}

// On every SW startup (including wake-ups) restore the pomodoro badge and alarm
(async () => {
  try {
    const { pomodoroState } = await chrome.storage.local.get('pomodoroState');
    if (!pomodoroState?.running) return;

    const remaining = pomodoroState.endTime - Date.now();
    if (remaining <= 0) return; // Time expired, alarm callback handles it

    // Show badge immediately with the correct value
    const mins  = Math.floor(remaining / 60000);
    const secs  = Math.floor((remaining % 60000) / 1000);
    const label = `${mins}:${String(secs).padStart(2,'0')}`;
    chrome.action.setBadgeText({ text: label.length > 4 ? `${mins}m` : label });
    chrome.action.setBadgeBackgroundColor({ color: pomodoroState.phase === 'work' ? '#00E5FF' : '#FF6B00' });

    // Re-create the alarm if it was lost (promise API avoids callback race condition)
    const existingAlarm = await chrome.alarms.get('pomodoro-tick');
    if (!existingAlarm) chrome.alarms.create('pomodoro-tick', { periodInMinutes: 1/60 });
  } catch(e) {}
})();

// Idle detection — tracking pauses after 30 seconds of idle
chrome.idle.setDetectionInterval(30);
chrome.idle.onStateChanged.addListener((state) => {
  const nowIdle = (state === 'idle' || state === 'locked');
  if (nowIdle && !_isIdle) {
    _isIdle = true;
    flushTime();
    activeStart = null;
  } else if (!nowIdle && _isIdle) {
    _isIdle = false;
    if (activeTabId) activeStart = Date.now();
  }
});

// ── Side Panel ──────────────────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.error('sidePanel.open failed:', e);
  }
});

// ── Time Tracking (100ms debounced batch write for real-time sync) ───
let _pendingStats = null;
let _statsFlushTimer = null;

function _flushStatsToStorage() {
  _statsFlushTimer = null;
  if (!_pendingStats) return;
  const p = _pendingStats;
  _pendingStats = null;
  chrome.storage.local.set(p);
}

function flushTime() {
  if (!activeTabId || !activeStart || _isIdle) return;
  if (tabIncognito[activeTabId]) return;

  const elapsed = Date.now() - activeStart;
  activeStart = Date.now();
  if (elapsed < 500) return;

  const url = tabUrls[activeTabId];
  if (!url?.startsWith('http')) return;

  let hostname = '';
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch(e) {}
  if (!hostname) return;

  const cat = tabCategories[activeTabId] || classifyFromUrl(url)?.name || 'General Browsing';
  const today = new Date().toISOString().slice(0, 10);

  function mergeInto(data) {
    const stats = data.stats || {};
    const siteStats = data.siteStats || {};
    const siteMeta = data.siteMeta || {};
    if (!stats[today]) stats[today] = {};
    stats[today][cat] = (stats[today][cat] || 0) + elapsed;
    if (!siteStats[today]) siteStats[today] = {};
    siteStats[today][hostname] = (siteStats[today][hostname] || 0) + elapsed;
    siteMeta[hostname] = cat;
    return { stats, siteStats, siteMeta };
  }

  if (_pendingStats) {
    _pendingStats = mergeInto(_pendingStats);
    // Flush immediately — MV3 service workers can be suspended; setTimeout is unreliable
    _flushStatsToStorage();
  } else {
    chrome.storage.local.get(['stats', 'siteStats', 'siteMeta'], (data) => {
      _pendingStats = mergeInto(data || {});
      _flushStatsToStorage();
    });
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  flushTime();
  activeTabId = tabId;
  activeStart = _isIdle ? null : Date.now();
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.url) tabUrls[tabId] = t.url;
    tabIncognito[tabId] = t.incognito || false;
    // If category is not yet known, infer it from the URL
    if (!tabCategories[tabId] && t.url) {
      const c = classifyFromUrl(t.url);
      if (c) tabCategories[tabId] = c.name;
    }
  } catch(e) {}
});

chrome.windows.onFocusChanged.addListener((wid) => {
  if (wid === chrome.windows.WINDOW_ID_NONE) { flushTime(); activeStart = null; }
  else if (!_isIdle) activeStart = Date.now();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) { flushTime(); activeStart = null; }
  delete tabCategories[tabId];
  delete tabUrls[tabId];
  delete tabIncognito[tabId];
});

// ── Pomodoro Alarms ─────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Periodic site tracking flush (every ~5 seconds)
  if (alarm.name === 'site-track-flush') {
    if (activeTabId === null) await _restoreActiveState();
    if (!_isIdle && activeTabId && activeStart) flushTime();
    return;
  }

  // ── Focus block restore (after 5-min whitelist expires) ──
  if (alarm.name === 'focus-block-restore') {
    const { focusMode } = await chrome.storage.local.get('focusMode');
    if (focusMode) _enableFocusBlocking();
    return;
  }

  // ── Dead link checker ──
  if (alarm.name === 'claw-dead-check') {
    await checkDeadLinks();
    return;
  }

  if (alarm.name !== 'pomodoro-tick') return;
  const { pomodoroState, activeTaskId, tasks } = await chrome.storage.local.get(['pomodoroState', 'activeTaskId', 'tasks']);
  if (!pomodoroState || !pomodoroState.running) return;

  const now       = Date.now();
  const remaining = pomodoroState.endTime - now;

  if (remaining <= 0) {
    chrome.alarms.clear('pomodoro-tick');
    chrome.action.setBadgeText({ text: '' });
    const taskList = tasks && Array.isArray(tasks) ? tasks : [];
    if (pomodoroState.phase === 'work' && activeTaskId) {
      const idx = taskList.findIndex(t => t && t.id === activeTaskId);
      if (idx >= 0) {
        taskList[idx] = { ...taskList[idx], done: true };
        await chrome.storage.local.set({ tasks: taskList, activeTaskId: null, pomodoroState: null });
      } else {
        await chrome.storage.local.set({ activeTaskId: null, pomodoroState: null });
      }
    } else {
      await chrome.storage.local.set({ activeTaskId: null, pomodoroState: null });
    }
    return;
  } else {
    const mins  = Math.floor(remaining / 60000);
    const secs  = Math.floor((remaining % 60000) / 1000);
    const label = `${mins}:${String(secs).padStart(2,'0')}`;
    chrome.action.setBadgeText({ text: label.length > 4 ? `${mins}m` : label });
    chrome.action.setBadgeBackgroundColor({ color: pomodoroState.phase === 'work' ? '#00E5FF' : '#FF6B00' });
  }

  // ── Whitelist expiry check ──
  const { whitelistedUntil, focusMode } = await chrome.storage.local.get(['whitelistedUntil', 'focusMode']);
  if (whitelistedUntil && Date.now() >= whitelistedUntil && focusMode) {
    await chrome.storage.local.remove('whitelistedUntil');
    // Scan all tabs and redirect any distraction sites
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.url && t.url.startsWith('http') && isDistractionDomain(t.url)) {
        const warningUrl = chrome.runtime.getURL(
          `distraction-warning.html?url=${encodeURIComponent(t.url)}&tab=${t.id}`
        );
        chrome.tabs.update(t.id, { url: warningUrl });
      }
    }
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'tabclaw-icon.png',
      title: 'TabClaw AI',
      message: 'Break is over, time to focus again!'
    });
  }
});

// ── Auto-group on tab load ──────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab.url) tabUrls[tabId] = tab.url;
  if (tab.incognito !== undefined) tabIncognito[tabId] = tab.incognito;
  // If the active tab's URL changed, flush time for the previous page
  if (tabId === activeTabId && changeInfo.url) {
    flushTime();
  }

  // ── Track focus-block tabs for cleanup on Focus Mode OFF ──
  if (changeInfo.url?.startsWith(chrome.runtime.getURL('focus-block.html'))) {
    chrome.storage.session.get(['focusBlockTabs'], ({ focusBlockTabs = [] }) => {
      if (!focusBlockTabs.includes(tabId))
        chrome.storage.session.set({ focusBlockTabs: [...focusBlockTabs, tabId] });
    });
  }

  // ── Distraction blocking during focus mode ──
  if (changeInfo.url && changeInfo.url.startsWith('http')) {
    const { customBlocklist: _cbl = [] } = await chrome.storage.local.get(['customBlocklist']);
    if (isDistractionDomain(changeInfo.url) || _isCustomBlocked(changeInfo.url, _cbl)) {
    const data = await chrome.storage.local.get(['focusMode', 'pomodoroState', 'whitelistedUntil']);
    if (data.focusMode && data.pomodoroState?.running) {
      const now = Date.now();
      // B17: Clean up expired whitelist so focus blocking resumes correctly
      if (data.whitelistedUntil && now >= data.whitelistedUntil) {
        chrome.storage.local.remove('whitelistedUntil');
        data.whitelistedUntil = null;
      }
      if (!data.whitelistedUntil) {
        // Redirect to warning page
        const warningUrl = chrome.runtime.getURL(
          `distraction-warning.html?url=${encodeURIComponent(changeInfo.url)}&tab=${tabId}`
        );
        chrome.tabs.update(tabId, { url: warningUrl });
        // B11: Increment daily counter sequentially to avoid concurrent-write data loss
        const today = new Date().toISOString().slice(0, 10);
        const d = await chrome.storage.local.get(['distractionsAvoided']);
        const counters = d.distractionsAvoided || {};
        counters[today] = (counters[today] || 0) + 1;
        chrome.storage.local.set({ distractionsAvoided: counters });
      }
    }
    } // closes isDistractionDomain || _isCustomBlocked check
  } // closes changeInfo.url.startsWith('http') check

  if (changeInfo.status !== 'complete') return;
  const { autoMode } = await chrome.storage.local.get(['autoMode']);
  if (!autoMode) return;
  if (!tab.url?.startsWith('http')) return;

  try {
    const { customCategories = [] } = await chrome.storage.local.get(['customCategories']);
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: _extractSignals });
    const signals = results?.[0]?.result;
    const cat     = signals
      ? classifyTab(signals, tab.url, customCategories)
      : classifyFromUrl(tab.url, "", customCategories);
    if (!cat) return;

    tabCategories[tabId] = cat.name;
    const allGroups = await chrome.tabGroups.query({ windowId: tab.windowId });
    const existing  = allGroups.find(g => g.title === cat.name);
    if (existing) await chrome.tabs.group({ tabIds: [tabId], groupId: existing.id });
    else {
      const gid = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(gid, { title: cat.name, color: cat.color });
    }
  } catch (e) {}
});

// Write active tab duration to storage every 5 seconds (crash recovery)
chrome.alarms.get('site-track-flush').then(alarm => {
  if (!alarm) chrome.alarms.create('site-track-flush', { periodInMinutes: 5/60 });
});

chrome.runtime.onInstalled.addListener(async () => {
  const [stAlarm, deadAlarm] = await Promise.all([
    chrome.alarms.get('site-track-flush'),
    chrome.alarms.get('claw-dead-check'),
  ]);
  if (!stAlarm) chrome.alarms.create('site-track-flush', { periodInMinutes: 5/60 });
  if (!deadAlarm) chrome.alarms.create('claw-dead-check', { periodInMinutes: 360 });
  chrome.contextMenus.create({
    id: "create-tabclaw-task",
    title: "TabClaw AI: Add task '%s'",
    contexts: ["selection"]
  });
  chrome.contextMenus.create({
    id: "save-claw",
    title: "TabClaw: Save this page",
    contexts: ["page"]
  });
});

// ── Messages ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  if (msg.type === 'SET_TAB_CAT') {
    tabCategories[msg.tabId] = msg.cat;
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'START_POMODORO') {
    chrome.alarms.get('pomodoro-tick').then(a => {
      if (!a) chrome.alarms.create('pomodoro-tick', { periodInMinutes: 1/60 });
    });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'STOP_POMODORO') {
    chrome.alarms.clear('pomodoro-tick');
    chrome.action.setBadgeText({ text: '' });
    chrome.storage.local.remove('whitelistedUntil');
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'FLUSH_STATS') {
    flushTime();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'WHITELIST_SITE') {
    // Temporarily lift all DNR rules for 5 minutes, then restore
    chrome.storage.local.get(['customBlocklist']).then(({ customBlocklist = [] }) => {
      chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [
          ...FOCUS_BLOCK_DOMAINS.map((_, i) => FOCUS_RULE_BASE_ID + i),
          ...customBlocklist.map((_, i) => CUSTOM_RULE_BASE_ID + i)
        ]
      }).then(() => {
        chrome.alarms.create('focus-block-restore', { delayInMinutes: 5 });
        sendResponse({ ok: true });
      });
    });
    return true; // async
  }
  return false;
});

// ── Bookmark Auto-Organize ──────────────────────────────────────────
const _BK_AUTO_RULES = [
  { name: 'AI Tools',     re: /openai\.com|anthropic\.com|claude\.ai|gemini\.google|copilot\.microsoft|midjourney\.com|huggingface\.co|perplexity\.ai|mistral\.ai|stability\.ai|together\.ai|poe\.com|grok\.com|leonardo\.ai|replicate\.com|groq\.com/ },
  { name: 'Development',  re: /github\.com|gitlab\.com|stackoverflow\.com|bitbucket\.org|npmjs\.com|pypi\.org|docker\.com|vercel\.com|netlify\.com|heroku\.com|aws\.amazon\.com|portal\.azure\.com|cloud\.google\.com|digitalocean\.com|cloudflare\.com|developer\.mozilla|devdocs\.io|codepen\.io|replit\.com|codesandbox\.io|railway\.app|supabase\.com/ },
  { name: 'Design',       re: /figma\.com|dribbble\.com|behance\.net|canva\.com|adobe\.com|sketch\.com|framer\.com|unsplash\.com|pexels\.com|coolors\.co|fontawesome\.com|fonts\.google\.com|awwwards\.com/ },
  { name: 'Social',       re: /twitter\.com|x\.com|instagram\.com|facebook\.com|linkedin\.com|reddit\.com|discord\.com|telegram\.org|whatsapp\.com|tiktok\.com|pinterest\.com|mastodon|threads\.net|bluesky\.social|bsky\.app/ },
  { name: 'Video',        re: /youtube\.com|youtu\.be|twitch\.tv|vimeo\.com|netflix\.com|primevideo\.com|disneyplus\.com|hulu\.com|max\.com|kick\.com|rumble\.com/ },
  { name: 'Finance',      re: /binance\.com|coinbase\.com|kraken\.com|kucoin\.com|tradingview\.com|investing\.com|bloomberg\.com|finance\.yahoo\.com|robinhood\.com|etoro\.com|paypal\.com|wise\.com|revolut\.com/ },
  { name: 'News',         re: /cnn\.com|bbc\.com|reuters\.com|apnews\.com|theguardian\.com|nytimes\.com|washingtonpost\.com|ft\.com|techcrunch\.com|theverge\.com|wired\.com|arstechnica\.com|medium\.com|substack\.com|milliyet\.com|hurriyet\.com|sabah\.com\.tr/ },
  { name: 'Shopping',     re: /amazon\.com|ebay\.com|etsy\.com|aliexpress\.com|temu\.com|shopify\.com|trendyol\.com|hepsiburada\.com|n11\.com|sahibinden\.com|walmart\.com|ikea\.com/ },
  { name: 'Learning',     re: /coursera\.org|udemy\.com|edx\.org|khanacademy\.org|pluralsight\.com|freecodecamp\.org|frontendmasters\.com|egghead\.io|linkedin\.com\/learning|skillshare\.com|brilliant\.org|codecademy\.com/ },
  { name: 'Productivity', re: /notion\.so|obsidian\.md|linear\.app|todoist\.com|trello\.com|asana\.com|monday\.com|clickup\.com|docs\.google\.com|sheets\.google\.com|airtable\.com|coda\.io|excalidraw\.com|miro\.com/ },
];

function _bkAutoCategorizeName(title, url) {
  const combo = (url + ' ' + title).toLowerCase();
  for (const rule of _BK_AUTO_RULES) {
    if (rule.re.test(combo)) return rule.name;
  }
  // title-based fallback
  if (/\b(bank|invest|stock|crypto|wallet|trading|finance|portfolio)\b/i.test(title)) return 'Finance';
  if (/\b(news|newsletter|weekly|digest)\b/i.test(title)) return 'News';
  return 'Other';
}

chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  if (!bookmark.url) return; // folder creation, skip
  const { bkAutoMode } = await chrome.storage.local.get('bkAutoMode');
  if (!bkAutoMode) return;

  const catName = _bkAutoCategorizeName(bookmark.title || '', bookmark.url || '');

  // Find the Bookmarks Bar (root child id '1')
  let tree;
  try { tree = await chrome.bookmarks.getTree(); } catch { return; }
  const rootChildren = tree?.[0]?.children || [];
  const bkBar = rootChildren.find(n => n.id === '1') || rootChildren[0];
  if (!bkBar) return;

  // Find or create category folder under Bookmarks Bar
  const existing = (bkBar.children || []).find(n => !n.url && n.title === catName);
  let folderId;
  if (existing) {
    folderId = existing.id;
  } else {
    try {
      const folder = await chrome.bookmarks.create({ parentId: bkBar.id, title: catName });
      folderId = folder.id;
    } catch { return; }
  }

  // Move the new bookmark into the category folder
  chrome.bookmarks.move(id, { parentId: folderId }, () => { void chrome.runtime.lastError; });
});

// Handler executed when a context menu item is clicked
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "create-tabclaw-task") {
    const selectedText = info.selectionText;
    const sourceUrl = tab.url;
    saveTaskLocally(selectedText, sourceUrl);
  }
  if (info.menuItemId === "save-claw") {
    // Write to pendingClaw; the popup will auto-save it when opened
    chrome.storage.local.set({ pendingClaw: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl } });
  }
});

function saveTaskLocally(text, url) {
  chrome.storage.local.get({ tasks: [] }, (result) => {
    const currentTasks = result.tasks;

    // Exactly matches the format expected by the UI
    const newTask = {
      id: Date.now().toString(),
      title: text,
      estimatedMin: 25, // Default 25 min (1 pomodoro) assigned to tasks added via right-click
      done: false,      // Required for the checkbox in the UI to function
      listId: 'default', // Required for the task to appear in the task list
      subtasks: [],     // Required for subtask rendering
      url: url,         // Store the original URL for future use
      createdAt: new Date().toISOString()
    };

    currentTasks.push(newTask);

    chrome.storage.local.set({ tasks: currentTasks }, () => {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'tabclaw-icon.png',
        title: 'TabClaw AI',
        message: 'Task added successfully!'
      });
    });
  });
}

// ── Shared classify functions ───────────────────────────────────────
function _extractSignals() {
  const get = s => document.querySelector(s)?.getAttribute('content') || '';
  return {
    title:       document.title || '',
    description: get('meta[name="description"]') || get('meta[property="og:description"]'),
    keywords:    get('meta[name="keywords"]'),
    ogSiteName:  get('meta[property="og:site_name"]'),
    h1:          document.querySelector('h1')?.textContent?.trim()?.slice(0, 200) || '',
  };
}

// ── Focus Mode Blocking (declarativeNetRequest) ──────────────────────
// FOCUS_BLOCK_DOMAINS and FOCUS_RULE_BASE_ID are defined at the top of the file

async function _enableFocusBlocking() {
  const { customBlocklist = [] } = await chrome.storage.local.get(['customBlocklist']);
  const hardRules = FOCUS_BLOCK_DOMAINS.map((domain, i) => ({
    id: FOCUS_RULE_BASE_ID + i,
    priority: 1,
    action: { type: 'redirect', redirect: { extensionPath: `/focus-block.html?site=${domain}` } },
    condition: { urlFilter: `||${domain}^`, resourceTypes: ['main_frame'] }
  }));
  const customRules = customBlocklist.map((domain, i) => ({
    id: CUSTOM_RULE_BASE_ID + i,
    priority: 1,
    action: { type: 'redirect', redirect: { extensionPath: `/focus-block.html?site=${domain}` } },
    condition: { urlFilter: `||${domain}^`, resourceTypes: ['main_frame'] }
  }));
  const removeIds = [
    ...FOCUS_BLOCK_DOMAINS.map((_, i) => FOCUS_RULE_BASE_ID + i),
    ...customBlocklist.map((_, i) => CUSTOM_RULE_BASE_ID + i)
  ];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules: [...hardRules, ...customRules]
  });
}

async function _disableFocusBlocking() {
  const { customBlocklist = [] } = await chrome.storage.local.get(['customBlocklist']);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [
      ...FOCUS_BLOCK_DOMAINS.map((_, i) => FOCUS_RULE_BASE_ID + i),
      ...customBlocklist.map((_, i) => CUSTOM_RULE_BASE_ID + i)
    ]
  });
  const { focusBlockTabs = [] } = await chrome.storage.session.get('focusBlockTabs');
  if (focusBlockTabs.length > 0) {
    try { await chrome.tabs.remove(focusBlockTabs); } catch(_) {}
    chrome.storage.session.remove('focusBlockTabs');
  }
}

// Sync: All contexts (popup, dashboard) listen to chrome.storage.onChanged directly.
// No need for runtime.sendMessage broadcast — chrome.storage.onChanged is the single sync mechanism.

// ═══════════════════════════════════════════════════════════════════════
// CLAW — Dead Link Checker
// ═══════════════════════════════════════════════════════════════════════

// Ensure alarm exists on startup
chrome.alarms.get('claw-dead-check').then(alarm => {
  if (!alarm) chrome.alarms.create('claw-dead-check', { periodInMinutes: 360 });
});

// NOTE: focus-block-restore and claw-dead-check handled in the main
// chrome.alarms.onAlarm listener above (consolidated — no duplicate listener).

async function checkDeadLinks() {
  const { claws = [] } = await chrome.storage.local.get(['claws']);
  if (claws.length === 0) return;

  let updated = false;
  const deadFound = [];

  for (const claw of claws) {
    if (!claw.url?.startsWith('http')) continue;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(claw.url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow'
      });
      clearTimeout(timeout);

      const isDead = resp.status === 404 || resp.status === 410 || resp.status === 500;
      if (isDead && !claw.deadLink) {
        claw.deadLink = true;
        deadFound.push(claw.title || claw.url);
        updated = true;
      } else if (!isDead && claw.deadLink) {
        claw.deadLink = false;
        updated = true;
      }
      claw.lastChecked = Date.now();
    } catch(e) {
      // Network error → mark as dead
      if (!claw.deadLink) {
        claw.deadLink = true;
        deadFound.push(claw.title || claw.url);
        updated = true;
      }
      claw.lastChecked = Date.now();
    }
  }

  if (updated) {
    await chrome.storage.local.set({ claws });
  }

  if (deadFound.length > 0) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'tabclaw-icon.png',
      title: 'TabClaw: Dead Link Detected',
      message: `${deadFound.length} saved page(s) are no longer accessible: ${deadFound.slice(0, 3).join(', ')}${deadFound.length > 3 ? '...' : ''}`
    });
  }
}

// ── Focus Mode: react to toggle + restore rules after service worker restart ──
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.focusMode) {
    changes.focusMode.newValue ? _enableFocusBlocking() : _disableFocusBlocking();
  }
  if (changes.customBlocklist) {
    chrome.storage.local.get(['focusMode'], ({ focusMode }) => {
      if (focusMode) _enableFocusBlocking();
    });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const { focusMode, pomodoroState } = await chrome.storage.local.get(['focusMode', 'pomodoroState']);
  if (focusMode) _enableFocusBlocking();
  // Restore pomodoro alarm and badge when Chrome restarts
  if (pomodoroState?.running) {
    const remaining = pomodoroState.endTime - Date.now();
    if (remaining > 0) {
      chrome.alarms.create('pomodoro-tick', { periodInMinutes: 1/60 });
      const mins  = Math.floor(remaining / 60000);
      const secs  = Math.floor((remaining % 60000) / 1000);
      const label = `${mins}:${String(secs).padStart(2,'0')}`;
      chrome.action.setBadgeText({ text: label.length > 4 ? `${mins}m` : label });
      chrome.action.setBadgeBackgroundColor({ color: pomodoroState.phase === 'work' ? '#00E5FF' : '#FF6B00' });
    }
  }
});
