// TabClaw AI Knowledge Base v1.0
const KNOWLEDGE_BASE = `
# TabClaw AI Knowledge Base

## Product Overview
TabClaw AI is a privacy-first Chrome extension for intelligent tab management, focus productivity, bookmarks, and statistics. All data stays on your device — no cloud, no accounts, no tracking.

### Core Features
- **Smart Tab Organization**: Automatically categorizes 15+ tab types (coding, social, news, AI, shopping, etc.) using keyword + meta tag scoring algorithm
- **Focus Mode**: Pomodoro timer with task tracking, energy bar, distraction blocking (social media blocker + stay focused screen)
- **Bookmarks (Claw)**: Instant save, auto-categorization, folder management, drag-drop, search
- **Statistics**: Real-time site tracking, category analytics, daily/weekly reports
- **Privacy**: Local storage only, encrypted chrome.storage, no account required, GDPR compliant

## Tab Management
### How Auto-Categorization Works
The scoring algorithm analyzes each tab:
1. Open Graph meta tags (+15 points)
2. Schema.org structured data (+12 points)
3. URL/title keyword matching (+2 points each)
4. Custom category multiplier (1.5×)
5. Minimum threshold: 2 points

### Categories (15+)
Social Media, Video & Entertainment, News & Media, Coding & Development, Frontend Development, Backend & DevOps, AI & Automation, Daily Productivity, Education & Learning, Shopping & E-Commerce, Finance & Banking, Communication & Email, Design & Creative, Gaming, Health & Fitness, Travel, Food & Recipes, Music & Audio, Sports, Science & Research

### Smart Groups
- Click "Organize" button to auto-group all tabs
- Manual grouping: select tabs → create group
- Custom groups with colors
- Drag-drop reordering
- Grid or list view

## Focus Mode
### Pomodoro Timer
- Default: 25 min work / 5 min break
- Customizable durations
- Session counter tracks completed pomodoros
- Badge shows remaining time on extension icon
- Audio notification on session end

### Task System
- Create tasks with estimated time
- Subtasks support
- Drag-drop reordering
- Active task timer tracking
- Energy bar shows daily productivity
- Task completion animations

### Distraction Blocking
- Detects social media tabs during focus sessions
- Shows "Stay Focused" warning overlay
- Option to proceed or return to work
- Configurable blocked sites

## Bookmarks (Claw)
- One-click save current tab
- Auto-categorizes by URL keywords
- Folder organization with drag-drop
- Search across all bookmarks
- AI-powered summaries and tags
- Grid or list view
- Rediscovery suggestions for old bookmarks

## Statistics
- Real-time tab usage tracking (500ms granularity)
- Per-site time breakdown
- Category-level analytics
- Daily activity chart
- Top sites ranking
- Category distribution pie
- Historical data comparison

## Privacy & Security
- **All data stored locally** in chrome.storage.local
- **No cloud sync** — your data never leaves your device
- **No account required** — works immediately after install
- **No browsing history collected** — only active tab time
- **No external API calls** for user data
- **GDPR compliant** — full data control
- **Open source** — verifiable code

## Keyboard Shortcuts
- Click extension icon → opens popup
- Tab management via popup panels
- Quick task add from dashboard

## Troubleshooting
### Extension Not Working
1. Go to chrome://extensions
2. Find TabClaw AI
3. Click refresh icon
4. If persists, remove and re-load unpacked

### Categories Not Accurate
- Algorithm needs page to fully load
- Custom categories override defaults (1.5× multiplier)
- Add specific keywords to improve matching

### Performance
- Extension uses minimal memory
- Background service worker suspends when idle
- Statistics tracking is lightweight (500ms intervals)

## User Workflows
### Daily Productivity Routine
1. Open TabClaw AI
2. Check task dashboard
3. Start focus session (Pomodoro)
4. Use "Organize" to clean up tabs periodically
5. Review statistics at end of day

### Project-Based Tab Management
1. Open all project-related tabs
2. Click "Organize" or manually group
3. Name the group by project
4. Color-code for quick identification

### Research Session
1. Start focus mode
2. Open research tabs
3. Save important pages to Claw bookmarks
4. AI auto-tags and categorizes
5. Review saved items later
`;
