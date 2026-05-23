# FreeNotez v2 — Bot-Free AI Meeting Notetaker Plan

## Overview

A Fathom-style meeting notetaker, but **without a bot joining the call**. The Chrome extension itself captures the Meet tab's **audio + video** (plus your mic), accepts a custom **master prompt** for how the summary/MoM should be structured, and includes a **Notes tab** where you type live notes during the meeting that are fed into the AI alongside the transcript.

You stay the only participant from your side — no second Google account, no Playwright, no BlackHole, no ffmpeg-on-host capture.

---

## What changed vs v1

| Area | v1 | v2 |
|------|----|----|
| Audio capture | Playwright bot + BlackHole + ffmpeg | Chrome extension `chrome.tabCapture` + `getUserMedia`, mixed via Web Audio API, recorded with `MediaRecorder` |
| Video capture | ffmpeg screen capture (avfoundation) | Chrome extension `chrome.tabCapture` (video track) — same recorder, single webm with A+V |
| Joiner identity | Bot Google account in the meeting | None — you're already in the meeting |
| Summary format | Hardcoded TL;DR / Decisions / Actions | User-defined **master prompt** (saved) + optional per-meeting override |
| User input during meeting | None | **Notes tab** in popup — markdown notes, auto-saved per Meet URL, sent to AI |
| Bot infrastructure | `bot/` dir, persistent profile, launchd | Removed entirely |
| Audio routing | Multi-Output Device + BlackHole | None — tabCapture handles it |

---

## Deployment Model

**Fully free. Everything runs on your Mac + your browser.**

| Component            | Where it runs                  | Why                                                                |
|----------------------|--------------------------------|--------------------------------------------------------------------|
| Chrome Extension     | Your browser                   | Captures Meet tab A+V + mic, holds Notes/Prompt UI, uploads blob   |
| Offscreen Document   | Hidden Chrome page (MV3)       | Hosts `MediaRecorder` so recording survives popup close            |
| Local Node.js Server | Your Mac                       | Receives upload, runs transcription → summary → email pipeline     |
| Transcription        | Sarvam AI (free tier)          | Free, handles Hindi + English well                                 |
| Summarization        | Gemini API (free tier)         | Free, accepts custom system instruction (master prompt)            |
| Email                | Gmail SMTP                     | Free                                                               |

---

## Architecture

```
You join a Google Meet call in Chrome
      ↓
  Click the FreeNotez extension icon
      ↓ popup opens with tabs: [Record] [Notes] [Prompt]
  Click "Record"
      ↓ background.js spawns an offscreen document
      ↓ offscreen.js:
        • chrome.tabCapture.getMediaStreamId(activeTabId) → tab A+V stream
        • navigator.mediaDevices.getUserMedia({ audio: true }) → mic stream
        • Web Audio API mixes both audio sources into one MediaStream
        • Combined: 1 video track (tab) + 1 mixed audio track → MediaRecorder
        • MediaRecorder starts (webm, vp9 video + opus audio, timeslice ~30s)
      ↓ tab audio is also routed back to speakers so you still hear the meeting
      ↓
  During the meeting:
        • You type into the "Notes" tab — auto-saved to chrome.storage.local
          (keyed by Meet URL so refreshing the popup keeps them)
        • Optionally edit "Prompt" tab for this meeting
      ↓
  Click "Stop" (or close the Meet tab — handled gracefully)
      ↓ offscreen.js finalizes MediaRecorder, gets the full A+V blob
      ↓ POST multipart/form-data to http://localhost:8000/upload
        fields: video (.webm — A+V), notes (.md), prompt (.txt), meta (.json — title, url, ts)
      ↓
  Local Node.js server:
      ↓ ffmpeg extracts audio track from .webm (A+V → A only) for STT
      ↓ Sarvam STT (chunked) → Transcript
      ↓ Gemini API (master prompt + notes + transcript) → Summary
      ↓ Gmail SMTP → Email to you
  (full A+V .webm + transcript saved to ~/FreeNotez/recordings/)
```

---

## Components

### 1. Chrome Extension (Manifest V3)

**Permissions:**
- `tabCapture` — capture tab audio + video
- `offscreen` — host MediaRecorder in a hidden document (popup closes lose state otherwise)
- `storage` — persist master prompt + per-meeting notes
- `activeTab`
- `host_permissions: ["http://localhost:8000/*", "https://meet.google.com/*"]`

**Popup UI (3 tabs):**

1. **Record tab**
   - Big Record / Stop button
   - Live duration timer
   - Status: `idle` / `recording` / `uploading` / `processing` / `done` / `error`
   - Mic toggle (default on) — include your voice or only tab audio
   - **Video toggle** (default on) — record A+V; off = audio-only (smaller files, faster upload)
   - **Quality picker** — `Low (480p / 500kbps)` / `Medium (720p / 1.5Mbps)` / `High (1080p / 3Mbps)` (default Medium)
   - Shows current Meet title (read by content script from DOM)
   - Estimated file size hint based on quality + elapsed time

2. **Notes tab**
   - Markdown textarea (full popup height)
   - Auto-save on every keystroke (debounced 500ms) to `chrome.storage.local`
   - Key: `notes:<meet_url>` so each meeting has its own notes
   - "Clear notes" button (per meeting)
   - Notes persist until 7 days after the meeting, then garbage collected

3. **Prompt tab**
   - **Master prompt** textarea — global default, used unless overridden
   - **Per-meeting prompt** textarea — overrides master prompt just for the active meeting
   - Both saved in `chrome.storage.local`
   - Includes a few **preset templates** (one click to load): "Standard MoM", "Engineering standup", "Sales call", "1:1 sync"

**Background service worker (`background.js`):**
- Listens for `start-recording` message from popup
- Creates offscreen document if not present (`chrome.offscreen.createDocument`)
- Forwards messages between popup and offscreen doc
- Listens for tab close events on the recording tab → triggers graceful stop

**Offscreen document (`offscreen.html` + `offscreen.js`):**
- Holds the long-lived recording context (popup closes don't kill it)
- Calls `chrome.tabCapture.getMediaStreamId({ targetTabId })`, then `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: 1280, maxHeight: 720, maxFrameRate: 15 } } })` — single call returns one MediaStream with both tracks
- Captures mic via standard `getUserMedia({ audio: true })` (only if mic toggle on)
- Web Audio API: creates `AudioContext`, two `MediaStreamSource` nodes (tab audio + mic), merges into one `MediaStreamDestination` for the audio track
- Builds final stream: `new MediaStream([videoTrack, mixedAudioTrack])` where `videoTrack` is the tab's video track (untouched) and `mixedAudioTrack` is the merged audio
- Pipes tab audio back to default output via a separate `audioContext.destination` connection so the user still hears the meeting (tabCapture mutes the original tab — this restores it)
- `MediaRecorder` records the combined stream — `audio/video` MIME: `video/webm;codecs=vp9,opus` (fallback `vp8,opus` if vp9 unavailable). Bitrate from quality picker
- If video toggle is off: skip the video track entirely, record `audio/webm;codecs=opus` only (same path as audio-only mode)
- `start(timeslice=30000)` so chunks fire every 30s — flushed into IndexedDB to avoid memory blow-up on long meetings (video chunks are bigger; flush more aggressively if storage quota nears limit)
- On stop: concatenates IndexedDB chunks → single Blob → uploads via multipart POST to `localhost:8000/upload`

**Content script (`content.js`):**
- Runs on `meet.google.com/*`
- Reads the meeting title from Meet's DOM (already exists in v1)
- Sends meta to popup so the popup shows the title
- Detects "You left the meeting" / call ended UI and notifies background to auto-stop

---

### 2. Local Node.js Server (Express)

**Endpoints:**
- `POST /upload` — multipart: `media` (webm — A or A+V), `notes` (text), `prompt` (text), `meta` (JSON: title, url, started_at, ended_at, has_video)
  - Saves blob to `~/FreeNotez/recordings/<ts>_<safe_title>.webm`
  - If `has_video`, runs `ffmpeg -i input.webm -vn -c:a copy audio.webm` to extract just the audio track for STT (faster, smaller for chunking)
  - Kicks off pipeline: transcribe → summarize → email
  - Returns immediately with a `job_id`; pipeline runs async
- `GET /status?job_id=...` — pipeline state per job
- `GET /status` (no id) — current top-level state, used by popup (`idle` / `processing` / `done`)
- `GET /settings` / `POST /settings` — optional, mirrors master prompt server-side for backup

**State:**
- One in-memory job map keyed by `job_id`
- Concurrent jobs allowed (different meetings) but extension only triggers one at a time

**No `/join` endpoint, no Playwright spawn.**

---

### 3. Transcription — Sarvam AI

Same as v1, plus an audio-extract pre-step when the upload is A+V:
- If video present: `ffmpeg -i recording.webm -vn -c:a libopus -b:a 64k audio.webm` → strip video, keep audio
- Chunk audio into ~10-min segments via ffmpeg (`child_process`)
- POST each chunk to Sarvam `/speech-to-text`
- Stitch results in order

(ffmpeg still needed server-side for chunking + audio extraction, not for capture.)

---

### 4. Summarization — Gemini API (with custom prompt)

**Inputs to Gemini:**
- **System instruction** = master prompt (or per-meeting override if present)
- **User content** =
  - Meeting metadata block (title, date, duration, URL)
  - User's live notes block (`## My notes during the meeting:\n<notes>`)
  - Transcript block (`## Transcript:\n<full transcript>`)

**Default master prompt (shipped as the initial value):**
```
You are an expert meeting note-taker. Given a transcript and the user's
live notes, produce a Minutes of Meeting document with:

1. TL;DR — 3 to 5 sentences
2. Attendees (if identifiable)
3. Key decisions
4. Action items — table with Owner | Action | Due date (infer if stated)
5. Open questions
6. Notable quotes (optional, max 3)

Treat the user's live notes as authoritative — if they conflict with
the transcript (e.g. clarify a name or decision), trust the notes.
Output Markdown. No preamble.
```

User can wipe and replace this entirely.

---

### 5. Email Delivery — Gmail SMTP

Same as v1. Body = generated MoM. Attachment = transcript `.txt` + the user's raw notes `.md`. **Video file is NOT attached** (too large for Gmail's 25MB limit on most calls); instead the email includes a local file path link to the `.webm` in `~/FreeNotez/recordings/` so you can open it directly.

---

## File Structure (v2)

```
FreeNotez/
├── extension/
│   ├── manifest.json
│   ├── popup.html              # 3-tab UI: Record / Notes / Prompt
│   ├── popup.js
│   ├── popup.css
│   ├── background.js           # Service worker — offscreen lifecycle
│   ├── offscreen.html
│   ├── offscreen.js            # MediaRecorder + tabCapture + mic mix
│   ├── content.js              # Meet DOM scraping (title, end-of-call)
│   ├── content.css
│   ├── storage.js              # chrome.storage.local helpers (notes, prompts)
│   └── media/
│       └── icon1.jpeg
├── server/
│   ├── index.js                # Express — /upload, /status, /settings
│   ├── transcribe.js           # Sarvam STT + chunking
│   ├── summarize.js            # Gemini with system instruction
│   ├── email.js                # Gmail SMTP
│   ├── audioUtils.js           # ffmpeg chunking
│   ├── config.js               # env vars
│   ├── package.json
│   └── recordings/             # uploaded blobs (or use ~/FreeNotez/recordings/)
├── plan.md                     # original v1 plan (kept for reference)
├── plan-v2.md                  # this file
├── setup.md
└── README.md
```

No `bot/` directory. No `infra/launchd plist` required (server is small enough to start manually or via Login Items).

---

## Tech Stack (v2)

| Layer                  | Tool                                                |
|------------------------|-----------------------------------------------------|
| Trigger + capture      | Chrome Extension MV3 (tabCapture + offscreen)       |
| Recording              | MediaRecorder (webm — vp9+opus or opus-only) in offscreen document |
| Audio mixing           | Web Audio API (`AudioContext`, `MediaStreamDestination`) |
| Local server           | Node.js + Express                                   |
| Storage (extension)    | `chrome.storage.local` + IndexedDB (audio chunks)   |
| Transcription          | Sarvam AI STT (free)                                |
| Summarization          | Gemini (free) with custom system instruction        |
| Email                  | Gmail SMTP + App Password                           |
| Persistence            | Local disk + browser IndexedDB                      |

---

## Build Order

1. **Sarvam integration** — transcribe a test webm, confirm output
2. **Gemini with custom system instruction** — pass a master prompt + sample transcript + sample notes, verify the summary respects the prompt
3. **Email** — Gmail SMTP test
4. **Express server** — `POST /upload` (multer for multipart), `GET /status`, save to disk, run pipeline
5. **Offscreen recording POC** — minimal extension that records the active tab's A+V + mic for 30s and downloads the webm
6. **Mix & playback fix** — confirm tab audio still plays out of speakers while being captured (the Web Audio routing trick), and that video track passes through untouched
7. **Popup UI shell** — 3 tabs, vanilla JS or a tiny framework, no build step
8. **Notes tab** — textarea + chrome.storage.local persistence keyed by Meet URL
9. **Prompt tab** — master + per-meeting fields, preset templates
10. **Wire upload** — on Stop, send audio + notes + prompt + meta to `/upload`
11. **End-to-end** — real Meet call, record 5 minutes, verify MoM email matches the master prompt and references the live notes

---

## Key Decisions & Notes

- **Why bot-free?** You're already in the meeting. A bot adds a visible second participant, requires a separate Google account, persistent Playwright profile, BlackHole virtual device, and ffmpeg device capture. tabCapture removes all of that.
- **Why offscreen document instead of recording in the popup?** The popup is destroyed the moment you click outside it. Offscreen documents are MV3's official way to keep a `MediaRecorder` alive in the background.
- **Why mix mic with tab audio?** Tab audio captures remote participants but not your own voice (Meet sends your mic out, doesn't render it back into your tab). Mixing your mic in gives a complete recording. User can toggle this off if they only want the other side.
- **Why Web Audio re-routing?** `chrome.tabCapture` mutes the captured tab by default. You need to feed the tab stream into an `AudioContext` and connect it to `audioContext.destination` so you still hear the meeting through your speakers.
- **Why IndexedDB for chunks?** A 2-hour `webm/opus` blob is ~50–80MB. Holding it in JS memory in an offscreen document is fine, but IndexedDB is safer for very long meetings and survives a browser crash mid-recording.
- **Why per-meeting prompt override?** Different meetings need different formats — a sales call MoM is structured nothing like a sprint retro. Master prompt covers the default, override handles the exception.
- **Why store notes by Meet URL?** Same meeting URL across reloads → same notes. Different meeting → fresh notes. No accidental cross-contamination.
- **Why send notes to the AI?** They're often more accurate than the transcript on names, decisions, and intent. Treating them as authoritative ground-truth fixes most transcript errors automatically.
- **Why record video too?** Lets you re-watch slides, screen-shares, and reactions. tabCapture already exposes the video track for free — no extra infra. Video is local-only (never uploaded anywhere external), and toggleable for users who only want audio.
- **Why webm/vp9 over mp4?** MediaRecorder in Chrome supports webm natively without re-encoding. mp4 would require ffmpeg post-processing for every recording. webm plays in any modern browser and QuickTime (with VLC fallback).

---

## Tradeoffs to be honest about

- **Tab must stay open.** Close the Meet tab and recording dies. Mitigation: background.js listens for `chrome.tabs.onRemoved` on the recording tab and does a graceful stop + upload of whatever was captured so far.
- **One recording at a time per browser.** tabCapture is single-tab-scoped. Fine for personal use.
- **Mac asleep / browser closed = recording stops.** Same constraint as v1.
- **No "I joined late and want the earlier audio".** Recording starts when you click Record, not retroactively. Same as v1.
- **Notes are not real-time-shared.** They're local to your browser. If you want collaborative notes, use a Google Doc and paste into the Notes tab before stopping.
- **Master prompt is plain text.** No template variables, no validation. If you write a bad prompt, you get a bad summary. Surface a "Restore default" button.
- **Browser memory.** Chunked IndexedDB writes mitigate, but a 4-hour meeting on a low-memory machine is still risky. Hard cap at 3 hours with auto-stop + warning.
- **Video files are heavy.** A 1-hour 720p webm is ~600MB–1GB depending on bitrate. IndexedDB has a per-origin quota (often 60% of free disk); long recordings can hit it. Mitigation: stream chunks to disk via the upload endpoint mid-recording (advanced) or warn at 80% quota.
- **Video upload latency.** Uploading a 1GB file to localhost is fast, but the offscreen → server transfer still ties up the popup. Consider chunked upload during recording rather than one big POST at the end.
- **Captured video shows whatever's in the Meet tab.** If you switch away from Meet to another tab, tabCapture keeps recording the Meet tab (good). But if you're screen-sharing your own screen, that share is captured too — be mindful for sensitive content.
- **Sarvam / Gemini free tiers** still rate-limit. Same as v1.

---

## Optional / Stretch Features

These are not required for v2 to ship. They sit on top of the core pipeline and can be toggled per-user from a **Settings tab** in the popup (4th tab) or via a feature flag in `chrome.storage.local`.

### Optional 1 — Speaker count via Meet DOM scraping

**Goal:** Know how many people are in the call (and ideally their names) so the summary can attribute action items and the email subject can include attendee count.

**How it works:**
- Lives in `content.js` (already runs on `meet.google.com/*` — no new permissions needed).
- Periodically (every ~10s while recording) reads Meet's DOM:
  - Participant tile container — Meet renders a grid of `[role="listitem"]` or similar tiles in the People panel.
  - Title attribute / `aria-label` of each tile usually contains the participant's display name.
  - Self-tile is marked with a "(You)" suffix or a specific class — filter that out if desired.
- Maintains a rolling set of unique names seen for the duration of the call.
- On Stop, content script sends `{ speakers: [...names], peakCount: N }` to `background.js`, which attaches it to the `/upload` payload as a new `speakers` field.
- Server passes the speaker list into the Gemini prompt as a metadata block:
  ```
  ## Attendees observed:
  - Alice
  - Bob
  - Charlie (you)
  ```
- Gemini uses this to fill the "Attendees" section of the MoM accurately and to attribute action items by name.

**Selectors are fragile.** Meet ships UI changes regularly. Strategy:
- Keep selectors in one file (`extension/meetDom.js`) — single source of truth.
- Try multiple selector fallbacks in order; log and silently skip if all fail.
- Treat speaker scraping as best-effort metadata, never block recording on it.

**Toggle:** off by default. Enable in Settings tab → "Auto-detect attendees from Meet UI".

**Tradeoffs:**
- Selectors break when Google redesigns Meet — needs occasional maintenance.
- Doesn't tell you who *spoke*, only who was in the room. Real speaker diarization needs Sarvam diarization (separate API) or post-processing — that's a different feature.
- Names from Meet DOM are display names, not emails — can't deterministically map to specific people.

---

### Optional 2 — Voice assistant (STT in, TTS out) for live note dictation

**Goal:** While the meeting is happening, you press a hotkey or click a mic button and say "Note: Bob owns the migration", and the assistant:
1. Captures your spoken instruction
2. Transcribes it (Sarvam STT, short-form)
3. Decides if it's a note to add or a question to answer
4. Either appends to the Notes tab automatically, or replies via TTS through your speakers (or both)

Despite the user's shorthand "TTS", this is a **STT → LLM → TTS** loop. Naming it "Assistant" in the UI to avoid confusion.

**Trigger:**
- Hotkey: `Cmd+Shift+J` (configurable). Push-to-talk: hold key, speak, release to send.
- Or "🎙 Assist" button in the popup's Record tab.
- IMPORTANT: assistant input uses a **separate** mic stream from the recording so the assistant audio doesn't get mixed into the meeting recording. Use a second `getUserMedia` call with `audio: { deviceId: ... }` if needed, or gate the recording's mic input briefly during assistant capture.

**Pipeline:**
```
You hold hotkey → record short clip (mic only) into a temp Blob
      ↓ release hotkey
  POST /assist  (multipart: audio + current notes + meeting context)
      ↓ server: Sarvam STT (short-form, no chunking)
      ↓ Gemini classifies intent:
          "note"     → returns the cleaned note text + where to insert
          "query"    → returns a spoken answer based on transcript-so-far + notes
          "command"  → e.g. "summarize so far", "list action items so far"
      ↓ for "note": server returns { type: "note", text }
        extension appends to Notes tab (auto-saved as usual)
      ↓ for "query"/"command": server runs Gemini on partial transcript + notes,
        returns { type: "speech", text: "Three action items so far. One ..." }
        extension uses Web Speech API `speechSynthesis.speak(text)` to play it back
        (or a higher-quality TTS like Sarvam TTS / Gemini TTS if quality matters)
```

**Why a server round-trip instead of doing it all in the extension?**
- Sarvam keys live server-side. Putting them in the extension exposes them.
- Gemini inputs include the live transcript-so-far, which the server has anyway.
- Keeps the extension thin.

**Partial transcript availability:**
- For the assistant to answer "what action items have come up so far?", the server needs the transcript-so-far. This means streaming or near-real-time transcription, not just batch-on-stop.
- Lightweight option: when the assistant is invoked, the extension flushes the latest IndexedDB chunks to the server immediately, server transcribes only what's new since the last flush, maintains a running transcript per `job_id`. Latency 5–15s, acceptable for an in-meeting assistant.
- This also benefits Optional 1 — the server can keep a live attendee+transcript state.

**TTS choice:**
- Default: browser `speechSynthesis` (built-in, free, instant, robotic).
- Optional upgrade: Sarvam TTS or Gemini TTS — better voices, costs API calls, slight latency.
- Volume note: TTS plays out of your speakers — other participants will hear it unless you wear headphones. Surface this as a warning in the Settings tab. Alternative: route TTS to a virtual sink the user doesn't broadcast (back to BlackHole-style territory — likely not worth it).

**UI for assistant:**
- Small "🎙 Assist" pill in the Record tab, glows red when listening.
- Last 3 assistant exchanges shown as a tiny chat log under the pill (collapsible).
- Each exchange: `🗣 You: "Note: Bob owns migration"  →  ✅ Added to notes` or `🗣 You: "What did we decide on pricing?"  →  🔊 "We agreed on $99/month tier."`

**Toggle:** off by default. Enable in Settings tab → "Voice assistant". Hotkey configurable.

**Tradeoffs:**
- Hotkey from a popup is unreliable when popup is closed. Need to use `chrome.commands` API in `background.js` and pipe events to the offscreen document.
- TTS playing through speakers can leak into the meeting (others hear the bot). Headphones recommended.
- Assistant invocations cost extra Sarvam + Gemini calls — heavier on the free-tier rate limits.
- Adds two new server endpoints (`POST /assist`, internal partial-transcribe loop) and noticeable complexity. Strictly optional.
- Web Speech API TTS quality is mediocre and varies by OS voice. Acceptable as v2.5, not as a polish surface.

---

## Updated Build Order (with optionals slotted in)

Core (1–11) unchanged. After core works:

12. **Optional 1 — Speaker scraping**: add `meetDom.js` selectors, attach speakers to `/upload`, plumb into Gemini prompt, ship behind a Settings toggle.
13. **Streaming/partial transcription** server-side: refactor `/upload` to also support incremental chunk uploads with a stable `job_id` and a running transcript. Required for Optional 2 to feel responsive.
14. **Optional 2a — Assistant intake**: hotkey via `chrome.commands`, push-to-talk recording in offscreen doc, `POST /assist`, intent classification, "note" path appending to Notes tab.
15. **Optional 2b — Assistant speech-out**: query/command path with `speechSynthesis` playback, in-popup chat log.
16. **Optional 2c — TTS upgrade** (only if Web Speech quality is unacceptable): swap to Sarvam/Gemini TTS, stream audio back to offscreen doc, play through speakers.
