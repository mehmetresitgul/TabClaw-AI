# TabClaw AI: Tab Organizer & Focus Engine

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-v3.0.0-blue.svg?logo=googlechrome)](https://chromewebstore.google.com/detail/tabclaw-ai-tab-organizer/ccllmiaggagemdfndhcfjjmbnmaobiao)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Privacy First](https://img.shields.io/badge/Privacy-100%25_Local-purple.svg)]()

> Clear browser chaos & regain control. Your AI tab organizer and focus engine to manage bookmarks, track tasks, and stay productive.

Available on the [Chrome Web Store](https://chromewebstore.google.com/detail/tabclaw-ai-tab-organizer/ccllmiaggagemdfndhcfjjmbnmaobiao).

---

## ⚡ Core Features

- 🤖 **Smart Offline Tab Categorization**: Automatically categorizes open browser tabs into intuitive groups (Work, Social, AI/ML, Design, Finance, Media, Docs, etc.) using an offline scoring engine (OpenGraph metadata + Schema.org + keyword analysis).
- ⏱️ **Focus Engine & Pomodoro Timer**: Integrated Pomodoro timer (chrome.alarms) with custom work/break intervals, active session badges, and optional distraction-blocking overlays for selected websites.
- 📊 **Productivity Analytics & Stats**: Real-time tracking of active tab usage broken down by day, category, and domain.
- 🔖 **Intelligent Bookmark Manager (Claws)**: Save, search, categorize, and automatically detect broken links (404/500 check) in your saved bookmarks.
- 🔒 **100% Privacy-First Architecture**: No cloud servers, no user tracking, no accounts required. All data remains local inside chrome.storage.local.

---

## 🚀 Installation

### Option 1: Chrome Web Store (Recommended)
Install directly from the official store:
👉 **[TabClaw AI on Chrome Web Store](https://chromewebstore.google.com/detail/tabclaw-ai-tab-organizer/ccllmiaggagemdfndhcfjjmbnmaobiao)**

### Option 2: Load Unpacked (Developer Mode)
1. Clone this repository:
   `ash
   git clone https://github.com/mehmetresitgul/TabClaw-AI.git
   `
2. Open Chrome and navigate to chrome://extensions.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the repository directory.

---

## 🏗️ Architecture & Tech Stack

- **Manifest Version**: Manifest V3
- **Background Worker**: ackground.js (Service Worker handling time tracking, alarms, and badge updates)
- **UI Logic**: popup.js & popup.html (Tab Organizer, Focus Timer, Category Manager, Analytics)
- **Categorization Engine**: categorizer.js (Client-side scoring engine with custom category multiplier)
- **Storage**: chrome.storage.local

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
