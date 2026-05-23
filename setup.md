# FreeNotez — Chrome Extension Setup

## Loading the extension in Brave

1. Open Brave and go to `brave://extensions`
2. Toggle **Developer mode** ON (top-right corner)
3. Click **Load unpacked**
4. Navigate to and select the `extension/` folder inside this project
5. The extension is now installed — you'll see "FreeNotez" in your extensions list

## Testing it

1. Join any Google Meet call (or open any `https://meet.google.com/...` URL)
2. A red **📝 FreeNotez** button appears at the bottom-right of the page
3. Click it — you should see an alert popup

## Updating after code changes

Whenever you edit files in `extension/`:
1. Go back to `brave://extensions`
2. Click the **reload** icon (↻) on the FreeNotez card
3. Refresh the Meet tab

## Troubleshooting

- **Button not showing up?** Make sure the URL starts with `https://meet.google.com/`. The content script only injects on Meet pages.
- **Extension not listed?** Confirm you selected the `extension/` folder (the one containing `manifest.json`), not the parent `FreeNotez/` folder.
- **Changes not reflecting?** You must reload the extension AND refresh the Meet tab after every code change.

## Starting the local server

1. Open a terminal and navigate to the server folder:
   ```
   cd server
   ```
2. Install dependencies (first time only):
   ```
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```
4. You should see: `FreeNotez server running on http://localhost:8000`

The server must be running before you click the FreeNotez button in a Meet call. When you click the button, you'll see `helloo` printed in this terminal.


---

## Recording a Google Meet (audio + video)

### One-time prep

1. **Start the local server** (it receives the recording when you stop):
   ```
   cd server
   npm install      # first time only
   npm start
   ```
   You should see:
   ```
   FreeNotez server running on http://localhost:8000
   Recordings → /Users/<you>/FreeNotez/recordings
   ```
   Leave this terminal open.

2. **Pin the FreeNotez icon to the toolbar** so you can find it during a meeting:
   - Click the puzzle-piece (Extensions) icon next to the address bar.
   - Find FreeNotez and click the pin icon. The FreeNotez icon now stays in the toolbar.

3. **Grant microphone access (one-time, required for your voice in the recording).**
   - On first install, a tab titled "FreeNotez — Microphone Permission" opens automatically. Click **Grant microphone access** and choose **Allow** in the browser prompt. Close the tab once you see "Granted".
   - If you missed it, open the page manually:
     1. Go to `chrome://extensions` (or `brave://extensions`).
     2. Find FreeNotez, click **Details**, then "Extension options" or copy the extension ID.
     3. Visit `chrome-extension://<extension-id>/permission.html` directly.
   - You can also open `chrome://settings/content/microphone` and explicitly allow the FreeNotez extension origin.
   - **Why this is needed:** Chrome's MV3 offscreen documents are hidden, so they can't display a permission prompt. The visible permission page handles the one-time grant, after which the offscreen recorder inherits the access. Without this, the recording will contain everyone else's voices but not yours.

### Recording flow

1. Join your Google Meet call as you normally would.
2. Once the meeting page loads, you'll see a small **floating FreeNotez button** at the top-right of the Meet page. Don't click it yet to start — clicking the floating button when idle only shows a hint, because tab capture must be initiated from the extension itself (this is a Chrome restriction).
3. **Click the FreeNotez icon in the Chrome/Brave toolbar.** This is the only way to start. The first time, the browser may prompt for microphone permission — allow it (the mic is mixed into the recording so your voice is captured too; tab audio alone wouldn't include you).
4. The floating button on the Meet page turns red and shows an elapsed timer (e.g. `02:14`). A pulsing dot indicates recording is live.
5. Continue your meeting normally. The recording captures:
   - Meet tab audio (everyone else's voices)
   - Your microphone (your voice)
   - The Meet tab's video (the gallery / shared screen / whoever is pinned)

### Stopping the recording

You can stop in any of these ways — they all do the same thing:

- Click the **red floating button** on the Meet page (easiest).
- Click the **FreeNotez toolbar icon** again (it toggles).
- **Close the Meet tab** — the extension detects the tab closing and finalizes the recording gracefully.

After stopping, the floating button shows `Stopping & uploading…` then `Recording uploaded.` once the server confirms.

### Where the recording goes

- File: `~/FreeNotez/recordings/<timestamp>.webm`
- Format: WebM container, VP9 video + Opus audio (falls back to VP8 if VP9 isn't supported)
- Plays in: Chrome, Brave, Firefox, VLC. QuickTime needs the VLC plugin or a webm-to-mp4 conversion.

To open the latest recording quickly:
```
open ~/FreeNotez/recordings
```

### Troubleshooting recording

- **Floating button shows but icon click does nothing.** Make sure the active tab is the Meet tab when you click the toolbar icon. Tab capture is bound to the active tab.
- **"Click the FreeNotez toolbar icon to start recording" toast keeps appearing.** You're clicking the floating button while idle — that won't start recording. Use the toolbar icon for the first click.
- **Recording stops immediately or never starts.** Open `chrome://extensions`, find FreeNotez, click "service worker" / "Inspect views" to see background console logs. Common causes:
  - `tabCapture` permission missing — reload the extension after the manifest update.
  - User gesture expired — happens if you Alt-Tab between the click and the capture. Click the icon while the Meet tab is focused.
- **Your voice is missing from the recording but other voices are fine.** Mic permission was never granted to the extension origin. The offscreen recorder cannot prompt for it because it's hidden. Open `chrome-extension://<extension-id>/permission.html` (the page that opened on first install) and grant access there, or visit `chrome://settings/content/microphone` and allow the FreeNotez extension. Then start a new recording.
- **Meeting goes silent in your headphones the moment recording starts.** Should not happen with the current code (Web Audio re-routes tab audio back to speakers), but if it does, restart the recording — the offscreen `AudioContext` likely failed to initialize.
- **Upload fails with "Upload HTTP …" toast.** The local server isn't running or crashed. Restart it with `npm start` in `server/`. The recording isn't lost — the offscreen recorder triggers a browser download as fallback.
- **File is huge.** A 1-hour 720p recording is ~600MB–1GB. Reduce by setting a lower `videoBitsPerSecond` in `extension/offscreen.js`, or record audio-only by stripping the `video:` constraint from the `getUserMedia` call.

### Hard limits to know

- The Meet tab must stay open throughout the recording. Closing it stops the recording (gracefully — what was captured so far is uploaded).
- One recording at a time per browser. Tab capture is single-tab-scoped.
- The Mac must stay awake. If the system sleeps, recording pauses and may end up with gaps.
- Recordings keep growing on disk forever. Clean up `~/FreeNotez/recordings/` periodically — there's no auto-prune yet.
