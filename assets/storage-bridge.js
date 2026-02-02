// Chrome Storage Bridge — syncs React dashboard ↔ extension (side panel) via chrome.storage.local
// Event-driven: chrome.storage.onChanged = single source of truth. No polling.
// Offline: chrome.storage.local is local; data is cached in __csCache. Works offline.
//
// Dashboard React usage:
//   Mount: await window.__csReady then __csGet(key) or __csGetMany(keys) for fresh data.
//   Lists: __csGet('dashLists') — derived from taskLists+tasks (synced with extension).
//   Stats/Reports: __csGet('stats'), __csGet('siteStats'), __csGet('siteMeta') or __csGet('dashReports') for dailyData, weeklyData, todaySites.
//   Subscribe: const unsub = window.__csSubscribe((detail) => { setState(...); });
//   Unmount: unsub() to remove listener (no memory leak).
// Write: __csSet({ key: value }) batched 100ms; __csSetImmediate({ key: value }) for instant.
(function() {
  var CS = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  // Single source of truth — extension (popup/background) must use same keys for data consistency
  var KEYS = [
    'focusMode', 'autoMode', 'soundEnabled',
    'focusTask', 'pomodoroState', 'activeTaskId',
    'tasks', 'taskLists', 'activeListId',
    'customCategories',
    'stats', 'siteStats', 'siteMeta',
    'claws', 'clawFolders', 'pendingClaw',
    'dashLists', 'dashFocusEnabled', 'dashWhitelist', 'dashBlacklist',
    'dashBlockingEnabled', 'dashTheme'
  ];
  window.__csKEYS = KEYS;

  // Extension format: taskLists[], tasks[] (task.listId, task.done, task.title, task.estimatedMin)
  // Dashboard format: dashLists[] with list.tasks[] (task.completed, task.name, task.estimate)
  // Single source of truth = tasks + taskLists. dashLists is always derived for dashboard.
  function computeDashLists(taskLists, tasks) {
    taskLists = taskLists || [];
    tasks = tasks || [];
    if (!taskLists.length && tasks.length) taskLists = [{ id: 'default', name: 'My Tasks', color: '#00E5FF', order: 0 }];
    return taskLists.map(function(list) {
      var listTasks = tasks.filter(function(t) { return (t.listId || 'default') === list.id; });
      return {
        id: list.id,
        name: list.name,
        color: list.color || '#00E5FF',
        order: list.order != null ? list.order : 0,
        icon: list.icon || 'grid',
        archived: list.archived || false,
        tasks: listTasks.map(function(t) {
          return { id: t.id, name: t.title, completed: !!t.done, estimate: t.estimatedMin != null ? t.estimatedMin : 25 };
        })
      };
    });
  }

  function dashListsToStorage(dashLists) {
    if (!dashLists || !dashLists.length) return { taskLists: [], tasks: [] };
    var taskLists = dashLists.map(function(l) {
      return { id: l.id, name: l.name, color: l.color || '#00E5FF', order: l.order != null ? l.order : 0, icon: l.icon || 'grid', archived: !!l.archived };
    });
    var tasks = [];
    dashLists.forEach(function(l) {
      (l.tasks || []).forEach(function(t) {
        tasks.push({
          id: t.id,
          title: t.name,
          listId: l.id,
          done: !!t.completed,
          estimatedMin: t.estimate != null ? t.estimate : 25
        });
      });
    });
    return { taskLists: taskLists, tasks: tasks };
  }

  // Stats/reports: extension stores stats[date][category]=ms, siteStats[date][hostname]=ms, siteMeta[hostname]=category.
  // dashReports = derived view for dashboard Raporlar (daily, weekly, todaySites).
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var REPORT_COLORS = ['#8B5CF6', '#EF4444', '#F59E0B', '#3B82F6', '#10B981', '#EC4899', '#6366F1', '#14B8A6', '#84CC16', '#6B7280'];

  function countTasksDoneOnDate(tasks, dateStr) {
    if (!tasks || !tasks.length) return 0;
    var count = 0;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].done && tasks[i].doneDate === dateStr) count++;
    }
    return count;
  }

  function computeDashReports(stats, siteStats, siteMeta, tasks) {
    stats = stats || {};
    siteStats = siteStats || {};
    siteMeta = siteMeta || {};
    tasks = tasks || [];
    var today = new Date().toISOString().slice(0, 10);
    var dailyData = [];
    var weeklyData = [];
    var i, d, date, dayMs, totalMs, weekMs;
    var todayMs = 0;
    var categoryTotals = {};

    // Last 7 days
    for (i = 6; i >= 0; i--) {
      d = new Date();
      d.setDate(d.getDate() - i);
      date = d.toISOString().slice(0, 10);
      dayMs = 0;
      if (stats[date]) {
        for (var c in stats[date]) {
          dayMs += stats[date][c];
          if (date === today) {
            categoryTotals[c] = (categoryTotals[c] || 0) + stats[date][c];
          }
        }
      }
      if (date === today) todayMs = dayMs;
      dailyData.push({
        day: DAY_NAMES[d.getDay()],
        focus: Math.round((dayMs / 3600000) * 10) / 10,
        tasks: countTasksDoneOnDate(tasks, date)
      });
    }

    // Last 4 weeks
    for (i = 3; i >= 0; i--) {
      d = new Date();
      d.setDate(d.getDate() - (i + 1) * 7 + 1);
      weekMs = 0;
      var weekTasks = 0;
      for (var j = 0; j < 7; j++) {
        var dd = new Date(d);
        dd.setDate(dd.getDate() + j);
        date = dd.toISOString().slice(0, 10);
        if (stats[date]) {
          for (var cat in stats[date]) weekMs += stats[date][cat];
        }
        weekTasks += countTasksDoneOnDate(tasks, date);
      }
      weeklyData.push({
        week: 'Week ' + (4 - i),
        focus: Math.round((weekMs / 3600000) * 10) / 10,
        tasks: weekTasks
      });
    }

    // Hourly activity estimate from today's total (simple distribution)
    var HOURS = ['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00'];
    var hourlyData = [];
    var nowHour = new Date().getHours();
    for (i = 0; i < HOURS.length; i++) {
      var h = parseInt(HOURS[i]);
      var activity = 0;
      if (todayMs > 0 && h <= nowHour) {
        // Spread today's total as a rough activity percentage (scale 0-100)
        activity = Math.min(100, Math.round((todayMs / 3600000 / Math.max(1, nowHour - 8)) * 100 / 1));
        // Add some variance so it's not flat
        activity = Math.max(0, Math.min(100, activity + ((h * 7 + 13) % 21 - 10)));
      }
      hourlyData.push({ hour: HOURS[i], activity: activity });
    }

    // Site breakdown for today
    var todaySites = [];
    var todaySiteMs = siteStats[today] || {};
    totalMs = 0;
    for (var host in todaySiteMs) totalMs += todaySiteMs[host];
    var idx = 0;
    for (var sh in todaySiteMs) {
      var ms = todaySiteMs[sh];
      var pct = totalMs > 0 ? Math.round((ms / totalMs) * 100) : 0;
      todaySites.push({
        name: sh,
        value: pct,
        color: REPORT_COLORS[idx % REPORT_COLORS.length]
      });
      idx++;
    }
    todaySites.sort(function(a, b) { return b.value - a.value; });

    // Focus hours formatted
    var totalFocusMs = todayMs;
    var focusH = Math.floor(totalFocusMs / 3600000);
    var focusM = Math.round((totalFocusMs % 3600000) / 60000);
    var totalFocusHours = focusH > 0 ? focusH + 'h ' + focusM + 'm' : focusM + 'm';

    return {
      dailyData: dailyData,
      weeklyData: weeklyData,
      hourlyData: hourlyData,
      todaySites: todaySites,
      totalFocusMs: totalFocusMs,
      totalFocusHours: totalFocusHours,
      categoryTotals: categoryTotals,
      stats: stats,
      siteStats: siteStats,
      siteMeta: siteMeta
    };
  }

  // In-memory cache — local cache for instant reads; syncs via onChanged
  window.__csCache = {};

  // Debounce batch write (100ms) — rapid updates from dashboard are batched
  var _writeQueue = {};
  var _writeTimer = null;
  var DEBOUNCE_MS = 100;
  var _pendingSelfWrites = new Set(); // tracks self-writes to prevent double re-renders in onChanged

  function flushWrite() {
    if (_writeTimer) clearTimeout(_writeTimer);
    _writeTimer = null;
    if (Object.keys(_writeQueue).length === 0) return;
    var payload = {};
    for (var k in _writeQueue) {
      if (k === 'dashLists') {
        var converted = dashListsToStorage(_writeQueue[k]);
        payload.taskLists = converted.taskLists;
        payload.tasks = converted.tasks;
      } else {
        payload[k] = _writeQueue[k];
      }
    }
    _writeQueue = {};
    payload._storageUpdatedAt = Date.now();
    _pendingSelfWrites.add(payload._storageUpdatedAt);
    Object.assign(window.__csCache, payload);
    window.__csCache.dashLists = computeDashLists(window.__csCache.taskLists, window.__csCache.tasks);
    if (payload.tasks !== undefined || payload.stats !== undefined || payload.siteStats !== undefined || payload.siteMeta !== undefined) {
      window.__csCache.dashReports = computeDashReports(window.__csCache.stats, window.__csCache.siteStats, window.__csCache.siteMeta, window.__csCache.tasks);
    }
    // Do NOT dispatch cs-changed here — the In() setter already applied n(s) optimistically.
    // A second dispatch 100ms later causes double-render flicker on task button clicks.
    // External writes (background.js etc.) arrive via onChanged below and are not deduplicated.
    if (CS) CS.set(payload);
  }

  // Write: batched (100ms). dashLists from dashboard is converted to taskLists+tasks.
  window.__csSet = function(data) {
    for (var key in data) {
      if (key === '_storageUpdatedAt') continue;
      if (key === 'dashLists') {
        var c = dashListsToStorage(data.dashLists);
        _writeQueue.taskLists = c.taskLists;
        _writeQueue.tasks = c.tasks;
      } else {
        _writeQueue[key] = data[key];
      }
    }
    if (!_writeTimer) {
      _writeTimer = setTimeout(flushWrite, DEBOUNCE_MS);
    }
  };

  // Immediate write (e.g. single toggle) — no debounce
  window.__csSetImmediate = function(data) {
    if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
    for (var key in _writeQueue) { if (data[key] === undefined) data[key] = _writeQueue[key]; }
    _writeQueue = {};
    if (data.dashLists != null) {
      var c = dashListsToStorage(data.dashLists);
      data.taskLists = c.taskLists;
      data.tasks = c.tasks;
      delete data.dashLists;
    }
    data._storageUpdatedAt = Date.now();
    _pendingSelfWrites.add(data._storageUpdatedAt);
    Object.assign(window.__csCache, data);
    window.__csCache.dashLists = computeDashLists(window.__csCache.taskLists, window.__csCache.tasks);
    if (data.tasks !== undefined || data.stats !== undefined || data.siteStats !== undefined || data.siteMeta !== undefined) {
      window.__csCache.dashReports = computeDashReports(window.__csCache.stats, window.__csCache.siteStats, window.__csCache.siteMeta, window.__csCache.tasks);
    }
    // Dispatch immediately so React updates without waiting for chrome.storage.onChanged round-trip
    var siDetail = {};
    for (var sik in data) {
      if (sik !== '_storageUpdatedAt') siDetail[sik] = window.__csCache[sik];
    }
    siDetail.dashLists = window.__csCache.dashLists;
    if (window.__csCache.dashReports !== undefined) siDetail.dashReports = window.__csCache.dashReports;
    if (Object.keys(siDetail).length) {
      window.dispatchEvent(new CustomEvent('cs-changed', { detail: siDetail }));
    }
    if (CS) CS.set(data);
  };

  window.__csReady = new Promise(function(resolve) {
    if (!CS) { resolve({}); return; }
    CS.get(KEYS, function(data) {
      if (data && data._storageUpdatedAt) delete data._storageUpdatedAt;
      window.__csCache = data || {};
      window.__csCache.dashLists = computeDashLists(window.__csCache.taskLists, window.__csCache.tasks);
      window.__csCache.dashReports = computeDashReports(window.__csCache.stats, window.__csCache.siteStats, window.__csCache.siteMeta, window.__csCache.tasks);
      // Ask background to flush any pending stats so dashboard gets fresh data
      try { chrome.runtime.sendMessage({ type: 'FLUSH_STATS' }); } catch(e) {}
      resolve(window.__csCache);
    });
  });

  window.__csGet = function(key) {
    if (key === '_storageUpdatedAt') return undefined;
    if (key === 'dashLists') return computeDashLists(window.__csCache.taskLists, window.__csCache.tasks);
    if (key === 'dashReports') return computeDashReports(window.__csCache.stats, window.__csCache.siteStats, window.__csCache.siteMeta, window.__csCache.tasks);
    return window.__csCache[key];
  };

  window.__csGetMany = function(keys) {
    var result = {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === '_storageUpdatedAt') continue;
      if (k === 'dashLists') result[k] = computeDashLists(window.__csCache.taskLists, window.__csCache.tasks);
      else if (k === 'dashReports') result[k] = computeDashReports(window.__csCache.stats, window.__csCache.siteStats, window.__csCache.siteMeta, window.__csCache.tasks);
      else result[k] = window.__csCache[k];
    }
    return result;
  };

  // Real-time sync: any change from extension/background updates cache and notifies React
  if (CS) {
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area !== 'local') return;
      // Skip if this is our own write bouncing back — already dispatched immediately in flushWrite/__csSetImmediate
      if (changes._storageUpdatedAt && _pendingSelfWrites.has(changes._storageUpdatedAt.newValue)) {
        _pendingSelfWrites.delete(changes._storageUpdatedAt.newValue);
        return;
      }
      var detail = {};
      for (var key in changes) {
        var nv = changes[key].newValue;
        if (key !== '_storageUpdatedAt') {
          window.__csCache[key] = nv;
          detail[key] = nv;
        }
      }
      if (changes.tasks || changes.taskLists) {
        window.__csCache.dashLists = computeDashLists(window.__csCache.taskLists, window.__csCache.tasks);
        detail.dashLists = window.__csCache.dashLists;
      }
      if (changes.stats || changes.siteStats || changes.siteMeta || changes.tasks) {
        window.__csCache.dashReports = computeDashReports(window.__csCache.stats, window.__csCache.siteStats, window.__csCache.siteMeta, window.__csCache.tasks);
        detail.dashReports = window.__csCache.dashReports;
        detail.stats = window.__csCache.stats;
        detail.siteStats = window.__csCache.siteStats;
        detail.siteMeta = window.__csCache.siteMeta;
      }
      if (Object.keys(detail).length) {
        window.dispatchEvent(new CustomEvent('cs-changed', { detail: detail }));
      }
    });
  }

  // Subscribe to storage changes (use in React: mount = __csReady + __csSubscribe, unmount = unsubscribe)
  window.__csSubscribe = function(callback) {
    function handler(e) { callback(e.detail); }
    window.addEventListener('cs-changed', handler);
    return function unsubscribe() { window.removeEventListener('cs-changed', handler); };
  };
})();
