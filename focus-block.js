const params  = new URLSearchParams(location.search);
const site    = params.get('site') || 'this site';
let   _ticker = null;

// ── Populate static content ──────────────────────────────────────────
document.getElementById('site').textContent = site;

chrome.storage.local.get(['focusTask', 'pomodoroState'], ({ focusTask, pomodoroState }) => {
  const task = focusTask?.trim() || 'your priorities';

  // Build message safely to avoid HTML injection
  const msgEl = document.getElementById('msg');
  msgEl.textContent = '';
  msgEl.appendChild(document.createTextNode('Future you will thank you for prioritizing '));
  const strong = document.createElement('strong');
  strong.textContent = task;
  msgEl.appendChild(strong);
  msgEl.appendChild(document.createTextNode('.'));

  document.getElementById('sub').textContent =
    `${site} can wait a bit.`;

  _startTimer(pomodoroState);
});

// ── Timer ────────────────────────────────────────────────────────────
function _startTimer(state) {
  if (!state?.running) return;

  const block  = document.getElementById('timerBlock');
  const valEl  = document.getElementById('timerValue');
  const phaseEl = document.getElementById('timerPhase');

  block.classList.remove('hidden');
  phaseEl.textContent = state.phase === 'work' ? 'Focus' : 'Break';
  phaseEl.className   = 'timer-phase ' + (state.phase === 'work' ? 'work' : 'break');

  function tick() {
    const remaining = Math.max(0, state.endTime - Date.now());
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    valEl.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    if (remaining <= 0) clearInterval(_ticker);
  }

  tick();
  _ticker = setInterval(tick, 1000);
}

// Keep timer in sync if pomodoro state changes while page is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pomodoroState) return;
  clearInterval(_ticker);
  _startTimer(changes.pomodoroState.newValue);
});

// ── Buttons ──────────────────────────────────────────────────────────

// "Back to building" — go back to the previous real page
document.getElementById('btnBack').addEventListener('click', () => {
  chrome.tabs.getCurrent(tab => chrome.tabs.remove(tab.id));
});

// "I actually need this for my task" — whitelist for 5 min (same mechanic as distraction-warning)
document.getElementById('btnNeed').addEventListener('click', () => {
  chrome.storage.local.set({ whitelistedUntil: Date.now() + 5 * 60 * 1000 }, () => {
    // Temporarily remove DNR rules so this navigation goes through
    chrome.runtime.sendMessage({ type: 'WHITELIST_SITE', site }, () => {
      window.location.href = 'https://' + site;
    });
  });
});
