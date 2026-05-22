# FreeNotez — AI Meeting Notetaker Plan

## Overview

A Fathom-style meeting notetaker. You join a Google Meet call, click a Chrome extension button, and a recorder bot joins the same meeting. It records audio locally, transcribes using Sarvam AI, summarizes with Gemini, and emails you the notes.

---

## Deployment Model

**Fully free — no paid resources. Everything runs on your Mac.**

| Component            | Where it runs                         | Why                                                                 |
|----------------------|---------------------------------------|---------------------------------------------------------------------|
| Chrome Extension     | Your browser                          | One-click trigger — detects Meet URL and tells local server to join |
| Local Node.js Server | Your Mac                              | Receives trigger from extension, launches Playwright bot            |
| Playwright Bot       | Your Mac (headed Chromium)            | Joins Meet as a real browser session (signed in as bot account)     |
| Audio + Video Recording | Your Mac disk (via ffmpeg + BlackHole)| Permanent local `.mp4` in `~/FreeNotez/recordings/`                 |
| Transcription        | Sarvam AI (free tier)                 | Free, handles Hindi + English well                                  |
| Summarization        | Gemini API (free tier)                | Free                                                                |
| Email                | Gmail SMTP                            | Free                                                                |

---

## Architecture

```
You join a Google Meet call in your browser
      ↓
  Click the FreeNotez Chrome extension button
      ↓ extension reads the Meet URL from the active tab
  Extension POSTs { meeting_url } to http://localhost:8000/join
      ↓
  Local Node.js server (on your Mac) receives /join
      ↓ launches Playwright
  Playwright opens headed Chromium, signs in as bot account
      ↓ joins Meet (real browser session, not headless)
  ffmpeg captures system audio (BlackHole virtual device) + video
      ↓ writes to ~/FreeNotez/recordings/<timestamp>_<title>.mp4
      ↓ on meeting end (all participants left / bot kicked / you click Stop):
  Sarvam STT API → Transcript
      ↓
  Gemini API (free tier) → Summary
      ↓
  Gmail SMTP → Email to you
  (recording stays on disk permanently)
```

---

## Components

### 1. Chrome Extension (Your browser — Manifest V3)

**How it works:**
- You're in a Google Meet call in Chrome
- Click the FreeNotez extension icon (or use a keyboard shortcut)
- Extension reads the current tab URL (must be `meet.google.com/*`)
- POSTs `{ meeting_url }` to `http://localhost:8000/join`
- Shows a small popup: "Bot joining..." → "Recording" → "Done"
- Also has a **Stop** button to manually end the recording early

**Extension details:**
- Manifest V3, minimal permissions: `activeTab`, `host_permissions: ["http://localhost:8000/*"]`
- No background service worker needed — popup.js handles the single POST
- Popup UI shows recording status by polling `GET http://localhost:8000/status`
- No login, no auth — it only talks to localhost

---

### 2. Local Node.js Server (Your Mac — Express)
- Always-running on your Mac (started via launchd / Login Items)
- Built with **Express.js** (lightweight, minimal deps)
- Endpoints:
  - `POST /join` — receives `{ meeting_url }` from the Chrome extension, spawns the Playwright bot as a child process
  - `POST /stop` — manually stop the current recording (extension Stop button calls this)
  - `GET /status` — returns current state: `idle` / `joining` / `recording` / `processing`
  - `POST /process` — internal endpoint called by the bot when recording finishes; runs transcription → summary → email
- No auth needed — only listens on `localhost:8000`, not exposed to the internet
- Manages one recording at a time (queues or rejects if already recording)

---

### 3. Playwright Bot (Your Mac — headed Chromium)
- Triggered by the Node.js server when `/join` fires
- Launches a **headed** Chromium (Meet detects and blocks headless)
- Uses a persistent Playwright user-data-dir signed in to a **secondary Google account** (the bot account) — avoids re-login every time
- Navigates to the meeting URL, dismisses camera/mic prompts, clicks "Join now" / "Ask to join"
- Mutes mic and turns off camera before joining (no disruption)
- Sets a display name like `FreeNotez Bot` so attendees know what it is
- While in the call, runs `ffmpeg` as a subprocess to capture:
  - **Audio**: from BlackHole 2ch virtual device (system audio routed through it)
  - **Video**: screen capture of the Meet tab via `avfoundation`
- Output: `~/FreeNotez/recordings/<timestamp>_<title>.mp4` (or `.webm`)
- End-of-meeting detection:
  - Polls participant count via DOM — if bot is alone for >2 min, leaves
  - Hard cap: 3 hours max per recording (safety)
  - Watches for "You've been removed" / "Meeting ended" UI states
- On exit: stops ffmpeg cleanly, closes Chromium, POSTs to local `/process` with the recording path

**BlackHole audio routing setup (one-time):**
- Install: `brew install blackhole-2ch`
- Create a Multi-Output Device in macOS Audio MIDI Setup: speakers + BlackHole (so you still hear the meeting)
- ffmpeg captures from BlackHole as input device

---

### 4. Transcription — Sarvam AI (free tier)
- Endpoint: `POST /speech-to-text` (Sarvam API)
- Audio chunked into ~10-minute segments using `ffmpeg` (via `child_process`) before sending (Sarvam ~25MB limit)
- Chunks sent sequentially, stitched back in order
- Handles Hindi + English well (Sarvam's strength)
- Free tier rate limits apply — fine for personal use

---

### 5. Summarization — Gemini API (free tier)
- Input: full transcript + meeting metadata (title, attendees, date/time)
- Output format:
  - TL;DR (3–5 sentences)
  - Key decisions made
  - Action items (with owner if detectable from transcript)
  - Open questions / follow-ups

---

### 6. Email Delivery — Gmail SMTP (free)
- Uses your Gmail account with an **App Password** (not your main password)
- Uses `nodemailer` over SSL (port 465) or STARTTLS (port 587)
- Subject: `[FreeNotez] <Meeting Title> — <Date>`
- Body: Full summary
- Attachment: transcript as `.txt`
- Audio is NOT attached (stays local only)

---

## File Structure

```
FreeNotez/
├── extension/
│   ├── manifest.json              # Manifest V3
│   ├── popup.html                 # Extension popup UI (Record / Stop / Status)
│   ├── popup.js                   # POSTs to localhost:8000, polls status
│   └── icons/                     # Extension icons (16, 48, 128)
├── server/
│   ├── index.js                   # Express server (runs on your Mac)
│   ├── transcribe.js              # Sarvam STT + chunking
│   ├── summarize.js               # Gemini summarization
│   ├── email.js                   # Gmail SMTP (nodemailer)
│   ├── audioUtils.js              # ffmpeg chunking helpers
│   ├── config.js                  # env var loading
│   └── package.json               # Express, nodemailer, etc.
├── bot/
│   ├── joinMeeting.js             # Playwright bot — joins Meet, manages lifecycle
│   ├── recorder.js                # ffmpeg child_process wrapper (BlackHole capture)
│   ├── meetDom.js                 # Meet UI selectors + end-of-meeting detection
│   └── user_data/                 # Persistent Playwright profile (bot Google login)
├── infra/
│   └── com.freenotez.server.plist  # launchd plist for local server autostart
├── plan.md
└── README.md
```

Local recordings saved to: `~/FreeNotez/recordings/` (outside repo)

---

## Tech Stack

| Layer               | Tool                                       |
|---------------------|--------------------------------------------|
| Trigger             | Chrome Extension (Manifest V3)             |
| Local server        | Node.js + Express (on your Mac)            |
| Bot                 | Playwright (headed Chromium)               |
| Audio + video capture | ffmpeg + BlackHole 2ch (macOS virtual dev) |
| Transcription       | Sarvam AI STT (free tier)                  |
| Summarization       | Gemini 1.5 / 2.0 (free tier)              |
| Email               | Gmail SMTP + App Password (free)           |
| Auth                | Bot Google account (secondary, free)       |
| Persistence         | Local disk (`~/FreeNotez/recordings/`)     |

---

## Build Order

1. **Sarvam integration** — transcribe a test `.wav` file, confirm output
2. **Summarization** — Gemini API prompt on a sample transcript, tune output format
3. **Email** — Gmail SMTP + App Password setup, send a test summary email
4. **Local Express server** — `/join`, `/stop`, `/status`, `/process` endpoints
5. **BlackHole + ffmpeg** — install BlackHole, configure Multi-Output Device, record a 1-min test clip via ffmpeg
6. **Playwright bot — manual** — script that joins a Meet URL with a bot Google account (persistent profile), confirm it gets in
7. **Bot recording integration** — bot launches ffmpeg, records, stops cleanly on meeting end, saves to `~/FreeNotez/recordings/`
8. **Bot → /process handoff** — bot calls local `/process` with the recording path for transcription pipeline
9. **Chrome extension** — popup UI with Record/Stop button, POSTs to `localhost:8000/join`, polls `/status`
10. **End-to-end test** — join a real Meet call, click extension, watch the full pipeline fire

---

## Key Decisions & Notes

- **Why a Chrome extension trigger instead of automatic?** Simpler, no cron, no calendar API, no tunnel. You're already in the meeting — one click is all it takes. No GitHub Actions, no Cloudflare, no OAuth tokens to manage.
- **Why a Playwright bot instead of recording from the extension itself?** A bot account joining as a real participant captures the entire meeting audio reliably (all speakers). Extension-based `tabCapture` only works while your tab is focused and has quirks with Meet's audio routing. The bot is independent of your browser state.
- **Why a separate bot Google account?** Avoids polluting your participant list with your own name twice, and avoids recording prompts on Workspace accounts. The bot has a clear name so attendees know what it is.
- **Why BlackHole + ffmpeg over Playwright recording?** Playwright's built-in `recordVideo` only captures the page video, not system audio. BlackHole routes Meet's audio output into a virtual input device that ffmpeg can read — gives clean audio capture without microphone pickup.
- **Why localhost-only Express server?** The extension talks to `localhost:8000` — no internet exposure, no auth needed, no tunnel needed. Dead simple.
- **Sarvam chunking** — meetings longer than ~15 min exceed Sarvam's per-request limit. Split into 10-min chunks with `ffmpeg`, send sequentially, stitch transcript back.
- **No paid services anywhere** — Sarvam, Gemini, Gmail SMTP all free tier. Only cost is electricity for your Mac.

---

## Tradeoffs to be honest about

- Your Mac must be on and awake during meetings (it already is — you're in the meeting).
- Local Node.js server must be running — handle via launchd / Login Items so it auto-starts.
- The bot joins as a **visible participant** under the bot Google account. Meet shows it in the participant list. There's no way to be truly invisible without breaking Meet's ToS.
- Sarvam / Gemini free tiers have rate limits — fine for personal volume, would break at scale.
- BlackHole routing means meeting audio goes through a virtual device — you'll set up a Multi-Output Device so you still hear the meeting normally. One-time setup.
- Not automatic — you must click the extension button. Tradeoff for massive simplicity gain (no cron, no calendar API, no tunnel).
