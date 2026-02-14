// ── Motivational Quotes ─────────────────────────────────────────────
const QUOTES = [
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "Focus is the art of knowing what to ignore.", author: "James Clear" },
  { text: "Do what you can, with what you have, where you are.", author: "Theodore Roosevelt" },
  { text: "It does not matter how slowly you go as long as you do not stop.", author: "Confucius" },
  { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
  { text: "Start where you are. Use what you have. Do what you can.", author: "Arthur Ashe" },
  { text: "Small daily improvements over time lead to stunning results.", author: "Robin Sharma" },
  { text: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
  { text: "Discipline is choosing between what you want now and what you want most.", author: "Abraham Lincoln" },
  { text: "Success is the sum of small efforts repeated day in and day out.", author: "Robert Collier" },
  { text: "Deep work is the ability to focus without distraction on a cognitively demanding task.", author: "Cal Newport" },
  { text: "Productivity is never an accident. It is always the result of intelligent effort.", author: "Paul J. Meyer" },
  { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
  { text: "A river cuts through rock not because of its power, but its persistence.", author: "Jim Watkins" },
  { text: "What we fear doing most is usually what we most need to do.", author: "Tim Ferriss" },
];

// ── Parse URL params ────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const originalUrl = params.get('url') || '';
const tabId = parseInt(params.get('tab'), 10);

// ── Display blocked domain ──────────────────────────────────────────
try {
  const hostname = new URL(originalUrl).hostname.replace(/^www\./, '');
  document.getElementById('blockedDomain').textContent = hostname;
} catch (e) {
  document.getElementById('blockedDomain').textContent = originalUrl || '—';
}

// ── Display distraction counter ─────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
chrome.storage.local.get(['distractionsAvoided'], (data) => {
  const counters = data.distractionsAvoided || {};
  const count = counters[today] || 0;
  document.getElementById('counter').innerHTML =
    `<strong>${count}</strong> distractions blocked today`;
});

// ── Random quote ────────────────────────────────────────────────────
const q = QUOTES[Math.floor(Math.random() * QUOTES.length)];
document.getElementById('quoteText').textContent = `\u201C${q.text}\u201D`;
document.getElementById('quoteAuthor').textContent = `\u2014 ${q.author}`;

// ── "Odaklan" button — close the tab to return to work ──────────────
document.getElementById('focusBtn').addEventListener('click', () => {
  // Always close the tab to prevent infinite redirect loops
  // (history.back() would go to the blocked site and trigger the warning again)
  chrome.tabs.getCurrent((tab) => {
    if (tab) chrome.tabs.remove(tab.id);
  });
});

// ── "Sadece 5 Dakika" button — whitelist and navigate ───────────────
document.getElementById('bypassBtn').addEventListener('click', () => {
  const whitelistedUntil = Date.now() + 5 * 60 * 1000;
  chrome.storage.local.set({ whitelistedUntil }, () => {
    if (originalUrl) {
      location.href = originalUrl;
    }
  });
});
