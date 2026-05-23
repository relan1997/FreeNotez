# FreeNotez — Learnings

A running log of non-obvious things picked up while building the extension. Written in the order they came up so the context isn't lost.

---

## 1. Why does `offscreen.html` exist?

### Background

Manifest V3 changed how Chrome extensions run code in the background. In MV2, an extension could ship a "background page": a hidden HTML document that lived forever and behaved like a normal web page. It could do anything — play audio, run `MediaRecorder`, hold WebSocket connections, call `getUserMedia`, etc.

MV3 replaced that with a **service worker**. Service workers are great for events but come with hard restrictions:

- They get killed by Chrome after roughly **30 seconds of idle** to save memory.
- They have **no DOM**. No `<audio>`, no `<video>`, no `document`.
- Critically: **no access to `navigator.mediaDevices.getUserMedia`** — that API only exists in window/document contexts.

### The problem

How do you record audio/video in MV3 if the only "background" thing you have can't even call `getUserMedia`?

### Chrome's answer: the Offscreen API

You ship a hidden HTML document with your extension. Your service worker calls:

```js
chrome.offscreen.createDocument({
  url: "offscreen.html",
  reasons: ["USER_MEDIA"],
  justification: "Recording Google Meet tab audio + video for note-taking"
});
```

Chrome quietly creates that page in the background — invisible, no tab, no window. Because it is a real document, it has full DOM access and can run `getUserMedia`, `MediaRecorder`, `AudioContext`, IndexedDB, all of it. It also stays alive as long as it's doing one of the declared `reasons` (in our case `USER_MEDIA`), so the service worker dying does not kill the recording.

### What `offscreen.html` actually contains

It's just a host. It exists purely so Chrome has something to load into a DOM context. The body of the file is essentially:

```html
<!doctype html>
<html>
  <body>
    <script src="offscreen.js"></script>
  </body>
</html>
```

The HTML file itself does no work — it's the container Chrome needs in order to give us a DOM.

---

## 2. What is `offscreen.js`?

It's the **actual recording engine**. It lives inside the offscreen document and does all the work the service worker can't.

### What it does, step by step

1. **Receives a `streamId` from `background.js`.** The service worker can't call `getUserMedia`, but it can ask `chrome.tabCapture` for a stream ID and forward it.
2. **Captures the Meet tab's A+V** with:
   ```js
   navigator.mediaDevices.getUserMedia({
     audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
     video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, ... } }
   });
   ```
3. **Captures the user's mic** with a separate `getUserMedia({ audio: true })` call.
4. **Builds an `AudioContext`** to mix tab audio + mic into a single audio track, and re-routes the tab audio back to the speakers (because `tabCapture` mutes the original tab playback by default).
5. **Combines tab video + mixed audio** into one final `MediaStream` and feeds it to a `MediaRecorder`.
6. **On stop**, concatenates the recorded chunks into a `.webm` Blob and POSTs it to `http://localhost:8000/upload`.

### Mental model

> Service worker = traffic controller. `offscreen.js` = the part that actually makes a recording.

The two communicate via `chrome.runtime.sendMessage`. The service worker tells the offscreen doc "start" / "stop"; the offscreen doc tells the service worker "finished" / "error".

---

## 3. Why does the floating button exist if it can't even start the recording?

`chrome.tabCapture.getMediaStreamId()` requires **extension user activation**. That activation is granted only by:

- A click on the extension's toolbar icon (`chrome.action.onClicked`).
- A user interaction inside the extension's popup.
- A `chrome.commands` keyboard shortcut.

A click on a button injected into the page (via a content script) is a gesture in the **page**, not in the **extension**. Chrome rejects `tabCapture` calls made under that activation.

### So why have the floating button at all?

- **Stopping does not need extension user activation.** The floating button is a perfect "Stop" surface — large, always visible, doesn't require finding the toolbar icon mid-meeting.
- **Live status display.** The button shows the elapsed timer and a pulsing red indicator without making the user open the popup.
- **Hint surface.** When clicked while idle, it shows a toast directing the user to the toolbar icon.

The flow that works:

```
Click toolbar icon → start recording (carries activation)
                  → background creates offscreen doc, calls tabCapture
                  → notifies content script → floating button turns red
Click floating button → background.stopRecording()
                     → offscreen flushes + uploads
                     → notifies content script → button goes idle
```

---

## 4. The MV3 file map (for FreeNotez specifically)

| File | Lives in | Job |
|------|----------|-----|
| `manifest.json` | extension root | Declares permissions, action, content scripts, background worker |
| `background.js` | service worker | Traffic controller — toolbar clicks, offscreen lifecycle, messaging |
| `offscreen.html` | offscreen doc shell | Tiny container so Chrome gives us a DOM context |
| `offscreen.js` | offscreen doc | Actual recorder — `getUserMedia`, `AudioContext`, `MediaRecorder`, upload |
| `content.js` | injected into Meet pages | Floating button UI + state sync with background |
| `content.css` | injected into Meet pages | Floating button + hint toast styling |

These four execution contexts (page, content script, service worker, offscreen doc) are isolated from each other. They communicate through `chrome.runtime.sendMessage` and `chrome.tabs.sendMessage`.

---

## 5. Permissions that turned out to matter

Adding these to `manifest.json` was non-optional once we started recording:

- `"tabCapture"` — required by `chrome.tabCapture.getMediaStreamId`.
- `"offscreen"` — required by `chrome.offscreen.createDocument`.
- `"storage"` — used for `chrome.storage.session` to persist recording state across service worker suspensions.
- `"scripting"` — needed if/when we want to programmatically inject scripts (kept for future expansion).
- `"activeTab"` — gives temporary access to the active tab when the user invokes the extension.

Without `tabCapture` or `offscreen`, recording silently fails or throws cryptic errors. Worth checking the manifest first when something doesn't work.

---

## 6. State has to survive the service worker dying

A service worker can be killed at any moment when idle. If you keep your "are we recording?" flag in a plain JS variable, the next event will see a fresh worker with `recordingState.active === false` even though the offscreen doc is still busy recording.

Fix:

- Mirror the state to `chrome.storage.session` (`saveState()`).
- At the top of every event handler, call `await loadState()` before reading the flag.
- `chrome.storage.session` is wiped when the browser closes — fine, recordings shouldn't survive a browser restart anyway.

---

## 7. Why the audio gets mixed via Web Audio API

`tabCapture` gives you the tab's audio and video tracks. But:

- **Tab audio captures remote participants only.** Meet sends your mic out, but does not render it back into your tab. So tab audio = everyone else.
- **Mic audio captures only you.**

To get a recording that contains the whole conversation, you have to mix both. `MediaRecorder` only accepts a single audio track per stream, so the mix has to happen upstream.

The pattern:

```js
const ctx = new AudioContext();
const dest = ctx.createMediaStreamDestination();

ctx.createMediaStreamSource(tabAudioOnlyStream).connect(dest);
ctx.createMediaStreamSource(micStream).connect(dest);

// Also re-route tab audio to speakers — tabCapture mutes the original tab.
ctx.createMediaStreamSource(tabAudioOnlyStream).connect(ctx.destination);

const finalStream = new MediaStream([
  tabStream.getVideoTracks()[0],
  dest.stream.getAudioTracks()[0]
]);
```

The reroute-to-speakers step is non-obvious. Without it, the meeting goes silent in the user's headphones the moment recording starts.

---

## 8. The `streamId` is single-use and time-sensitive

`chrome.tabCapture.getMediaStreamId({ targetTabId })` returns a token that:

- Can only be consumed once via `getUserMedia` (subsequent calls fail).
- Expires if you `await` too much before passing it to the offscreen document — extension user activation has a short lifetime.

Practical consequence: don't put long async work between `getMediaStreamId` and forwarding the streamId to offscreen. Get the ID, ensure the offscreen doc, send the message, and only then update state.

---

## 9. `background.js` annotation map (quick reference)

For when re-reading the file:

| Lines | What's there |
|-------|--------------|
| 1–25 | File-level header — what role this file plays in MV3 |
| 31–43 | In-memory + persisted state model, why we mirror to `chrome.storage.session` |
| 65–88 | Offscreen document detection, creation, teardown, and what `reasons` does |
| 110–186 | `startRecording` — user-activation rule, streamId handoff, state ordering |
| 192–217 | `stopRecording` — why a page-injected button can stop but not start |
| 224–308 | Per-message dispatch with comments on each `msg.type` |
| 314–321 | The tab-closed safety net |

---

## 10. Open questions to revisit

- **IndexedDB chunked storage** — currently `recordedChunks` is a JS array in the offscreen doc. For 2-hour meetings this is fine on a healthy Mac but risks an OOM. Move to IndexedDB with periodic flushes.
- **Streaming upload mid-recording** — instead of one big POST at the end, chunk the upload as recording progresses. Reduces memory pressure and recovers gracefully if the browser crashes.
- **Hotkey via `chrome.commands`** — would let the user start/stop without reaching for the toolbar icon. Same activation rules apply, so it should work.
- **Per-meeting state keyed by Meet URL** — right now state is global. If a user opens two Meet tabs, the floating buttons need to know which one is recording.


---

## 11. Offscreen documents cannot prompt for permissions

When the recorder didn't capture the user's voice, the symptom was: tab audio was fine, but the mic side of the mix was empty. The cause: `getUserMedia({ audio: true })` inside `offscreen.js` was rejecting with `NotAllowedError`, and the original code swallowed it with a `try/catch`.

The deeper reason: **offscreen documents are hidden, and Chrome will not pop a permission dialog from a hidden context.** If the user has never granted mic permission to the extension origin via a visible UI, every `getUserMedia` call from the offscreen doc fails immediately.

### Fix shape

1. Ship a **visible** permission page (`permission.html` + `permission.js`) that calls `getUserMedia({ audio: true })`, immediately stops the tracks, and shows status. Permission is granted to the extension origin and is then shared with the offscreen document.
2. Open this page automatically on `chrome.runtime.onInstalled` with `reason === "install"`.
3. Stop swallowing the mic error in `offscreen.js`. Send `offscreen:mic-denied` back to the service worker so the floating button can surface it as a toast and the permission page can be re-opened.
4. List `permission.html` and `permission.js` in `web_accessible_resources` so they're loadable by URL (`chrome-extension://<id>/permission.html`) for re-grant flows.

### Things this also clarifies

- **`chrome.tabCapture` for tab audio doesn't need mic permission.** It's a separate path. That's why tab audio worked without any prompt while mic kept failing silently.
- **`navigator.permissions.query({ name: "microphone" })`** is a useful pre-check on the permission page to detect "already granted" and skip the prompt.
- **The grant only happens once per extension install.** Reloading the extension keeps the permission. Uninstalling and reinstalling resets it.
- **Don't try to silently fall back to "tab audio only".** Make the missing-mic case loud — otherwise users get half-recordings and never realize why.
