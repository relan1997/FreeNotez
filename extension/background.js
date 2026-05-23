// =============================================================================
// FreeNotez — background service worker
// =============================================================================
//
// In Manifest V3, extensions don't have a persistent "background page" anymore.
// Instead, this file runs as a service worker: an event-driven script that
// Chrome wakes up when something happens (icon clicked, message received,
// tab closed) and may shut down again ~30s after going idle.
//
// What this file is responsible for:
//   1. Listening for the toolbar icon click — this is the ONLY way to start
//      tabCapture, because tabCapture requires "extension user activation"
//      which only fires from action.onClicked, popup interactions, or
//      chrome.commands shortcuts. A click on a button injected into the page
//      does NOT count.
//   2. Asking chrome.tabCapture for a streamId for the active Meet tab.
//   3. Spawning the offscreen document (a hidden HTML page) where the actual
//      MediaRecorder lives, because service workers can't call getUserMedia
//      or hold media streams.
//   4. Routing messages between the page-side content script (floating
//      button) and the offscreen recorder.
//   5. Cleaning up when the recording stops, errors out, or the tab closes.
//
// Tip when reading this file: think of it as a traffic controller. It never
// touches a microphone or a video frame itself — it only tells the offscreen
// document when to start, when to stop, and propagates status updates back to
// the floating button on the page.
// =============================================================================

// Path (relative to the extension root) to the hidden HTML page that hosts
// the MediaRecorder. The HTML itself is just a shell that loads offscreen.js.
const OFFSCREEN_PATH = "offscreen.html";

// In-memory snapshot of "are we recording?" plus which tab we're capturing.
// We mirror this to chrome.storage.session so that if the service worker is
// suspended and re-spun-up (Chrome may shut it down between events), we can
// restore the state on the next event by calling loadState() first.
let recordingState = {
  active: false,    // true while a MediaRecorder is running in offscreen.js
  tabId: null,      // id of the Meet tab being captured
  startedAt: null   // epoch ms — used by the floating button's elapsed timer
};

// Pull the persisted state back into the local variable. Always call this at
// the top of an event handler, because the in-memory `recordingState` may be
// stale after the worker was suspended and respawned.
async function loadState() {
  const stored = await chrome.storage.session.get("recordingState");
  if (stored.recordingState) recordingState = stored.recordingState;
}

// Persist the latest state. session storage is wiped when the browser closes,
// which is exactly what we want — recordings shouldn't survive a browser
// restart anyway.
async function saveState() {
  await chrome.storage.session.set({ recordingState });
}

// chrome.offscreen has no "doesItExist?" helper. We use chrome.runtime.getContexts
// (Chrome 116+) to enumerate active extension contexts and look for one of
// type OFFSCREEN_DOCUMENT. If only one offscreen doc exists, this is enough.
async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });
    return contexts.length > 0;
  }
  // Older Chrome — there's no clean API. Returning false means we'll try to
  // create the doc and rely on createDocument's "already exists" error.
  return false;
}

// Make sure an offscreen document is up before we send it a "start" message.
// Reasons + justification are required by the API; "USER_MEDIA" tells Chrome
// "we will be holding a getUserMedia stream" and keeps the doc alive instead
// of being garbage-collected.
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
    justification: "Recording Google Meet tab audio + video for note-taking"
  });
}

// Tear the offscreen document down once recording is fully finalized
// (i.e. after the upload completes or fails). Keeping it open forever would
// hold the AudioContext / MediaRecorder objects in memory unnecessarily.
async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

// Send a message to the content script in the recording tab so the floating
// button on the Meet page can update its label / colour / timer. The catch()
// silences "Receiving end does not exist" errors that happen when the tab
// has been closed by the time we try to send.
function notifyContent(tabId, payload) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => {
    // Tab may have closed or content script not yet ready — safe to ignore.
  });
}

// ---------------------------------------------------------------------------
// startRecording — entry point fired when the user clicks the toolbar icon.
// ---------------------------------------------------------------------------
// `tab` is the active tab object Chrome hands us (it has id, url, title etc).
// We do four things here, in order:
//   a) sanity-check we're not already recording and that this is a Meet tab
//   b) ask chrome.tabCapture for a streamId for that tab — this MUST happen
//      synchronously inside the user-gesture window, otherwise Chrome will
//      throw "Extension has not been invoked for the current page"
//   c) ensure the offscreen document exists and forward the streamId to it
//   d) update + persist the state and tell the content script "recording on"
async function startRecording(tab) {
  if (recordingState.active) {
    // Defensive: action.onClicked also routes through here — toggle behaviour
    // should already be handled by the caller, but bail out cleanly if not.
    console.log("[FreeNotez] already recording, ignoring start");
    return;
  }
  if (!tab || !tab.url || !tab.url.startsWith("https://meet.google.com/")) {
    // We deliberately gate to Meet URLs. Recording other tabs is possible
    // but outside this app's scope.
    console.log("[FreeNotez] not a Meet tab, ignoring");
    return;
  }

  // chrome.tabCapture.getMediaStreamId is a callback-style API. We wrap it
  // in a Promise so we can `await` and have proper try/catch around it.
  // Note: this call is the one that requires extension user activation.
  // If the user activation has expired (e.g. you await something before
  // calling this), the call will fail with "user gesture required".
  let streamId;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: tab.id },
        (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        }
      );
    });
  } catch (err) {
    // Common causes: not a Meet tab in focus, user activation expired,
    // tabCapture permission missing from manifest.
    console.error("[FreeNotez] failed to get streamId:", err);
    notifyContent(tab.id, { type: "recording-error", error: String(err) });
    return;
  }

  // Make sure the hidden recorder page exists, then hand it the streamId.
  // The streamId is a one-shot token — it can only be consumed once via
  // getUserMedia inside the offscreen document.
  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({
    type: "offscreen:start",
    streamId,
    tabId: tab.id
  });

  // Flip state to "recording" and persist before notifying the content
  // script — that way the content script's first state query (if it races)
  // sees the correct value.
  recordingState = {
    active: true,
    tabId: tab.id,
    startedAt: Date.now()
  };
  await saveState();

  notifyContent(tab.id, {
    type: "recording-started",
    startedAt: recordingState.startedAt
  });
}

// ---------------------------------------------------------------------------
// stopRecording — fires from either the toolbar icon (second click) or the
// floating button. Stopping does NOT need extension user activation, which
// is why a page-injected button can stop the recorder cleanly.
// ---------------------------------------------------------------------------
async function stopRecording() {
  if (!recordingState.active) {
    console.log("[FreeNotez] not recording, ignoring stop");
    return;
  }
  // Capture tabId before we wipe state — we still need it for the final UI
  // notification down below.
  const tabId = recordingState.tabId;

  // Ask the offscreen doc to flush its MediaRecorder, build the final blob,
  // and POST it to the local server. It'll send "offscreen:finished" back
  // once that's done (handled in the onMessage listener below).
  chrome.runtime.sendMessage({ type: "offscreen:stop" });

  // Mark state immediately. If the user mashes the icon, the second click
  // will see active=false and bail out instead of double-firing stop.
  // The offscreen doc is left open until we get "offscreen:finished" because
  // the upload still needs to happen.
  recordingState = { active: false, tabId: null, startedAt: null };
  await saveState();

  notifyContent(tabId, { type: "recording-stopped" });
}

// =============================================================================
// Event wiring — these listeners are what Chrome calls to wake the worker.
// =============================================================================

// Refresh the state cache when the worker spins up. Without these, the first
// event after a worker death would see a stale "active: true" state.
chrome.runtime.onStartup.addListener(loadState);
chrome.runtime.onInstalled.addListener(loadState);

// Toolbar icon click. This is the start (or toggle-off) entry point because
// it carries extension user activation, which tabCapture demands.
// If recording is already on, treat the click as a stop — single-button toggle.
chrome.action.onClicked.addListener(async (tab) => {
  await loadState();
  if (recordingState.active) {
    await stopRecording();
  } else {
    await startRecording(tab);
  }
});

// All other communication — content script <-> background <-> offscreen —
// flows through chrome.runtime.sendMessage. We use a single listener and
// dispatch on msg.type for simplicity.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // We need async work below (loadState, stopRecording, closeOffscreenDocument)
  // but the listener itself must return synchronously. The standard pattern:
  // wrap the async work in an IIFE and `return true` to keep the message
  // channel open until sendResponse is called.
  (async () => {
    await loadState();

    if (msg.type === "content:get-state") {
      // The floating button polls this on injection so it can render the
      // correct state if the page reloaded mid-recording.
      sendResponse({
        active: recordingState.active,
        startedAt: recordingState.startedAt
      });
      return;
    }

    if (msg.type === "content:stop-request") {
      // Floating button ("Stop" pill) was clicked. No user activation
      // requirement for stop, so we can honour this directly.
      await stopRecording();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "content:start-request") {
      // Floating button was clicked while idle. We CANNOT start tabCapture
      // from here — the click happened inside the page, not the extension,
      // so there's no extension user activation. Surface a UI hint pointing
      // the user at the toolbar icon.
      notifyContent(sender.tab?.id, {
        type: "recording-error",
        error: "Click the FreeNotez toolbar icon to start recording."
      });
      sendResponse({ ok: false, reason: "needs-toolbar-click" });
      return;
    }

    if (msg.type === "offscreen:finished") {
      // Sent by offscreen.js after the recording has been finalized AND the
      // upload to localhost:8000/upload either succeeded or failed. Either
      // way the recording lifecycle is over, so we tear the offscreen doc
      // down to free memory.
      console.log("[FreeNotez] offscreen reported finished:", msg);
      await closeOffscreenDocument();

      const tabId = recordingState.tabId;
      recordingState = { active: false, tabId: null, startedAt: null };
      await saveState();

      // Floating button shows a one-line toast with the result.
      notifyContent(tabId, {
        type: "recording-finished",
        ok: msg.ok,
        error: msg.error
      });
      return;
    }

    if (msg.type === "offscreen:error") {
      // Something blew up inside the offscreen doc (e.g. mic denied, tabCapture
      // stream couldn't be opened). Treat this as a fatal failure: kill the
      // doc, reset state, surface the error to the page.
      console.error("[FreeNotez] offscreen error:", msg.error);
      const tabId = recordingState.tabId;
      await closeOffscreenDocument();
      recordingState = { active: false, tabId: null, startedAt: null };
      await saveState();
      notifyContent(tabId, { type: "recording-error", error: msg.error });
      return;
    }
  })();
  // Keep the message channel open so async sendResponse calls work.
  return true;
});

// If the user closes the Meet tab while we're recording, gracefully stop
// instead of leaking an offscreen MediaRecorder that's reading from a dead
// tab stream. The offscreen doc will still flush whatever chunks it has.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadState();
  if (recordingState.active && recordingState.tabId === tabId) {
    console.log("[FreeNotez] recording tab closed, stopping");
    await stopRecording();
  }
});
