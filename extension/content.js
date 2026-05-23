// FreeNotez — content script
// Injects a floating button on Google Meet that:
//   - When idle: prompts the user to click the toolbar icon (tabCapture
//     requires extension user activation, which a page-injected click
//     cannot provide).
//   - When recording: shows a red "Stop" pill that stops via background.
// Also keeps the button in sync with background recording state.

(function () {
  if (window.location.pathname === "/landing" || window.location.pathname === "/") return;

  const meetingCodePattern = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

  let isRecording = false;
  let startedAt = null;
  let timerInterval = null;

  function ensureButton() {
    let btn = document.getElementById("freenotez-btn");
    if (btn) return btn;

    btn = document.createElement("button");
    btn.id = "freenotez-btn";
    btn.type = "button";

    const icon = document.createElement("img");
    icon.id = "freenotez-btn-icon";
    icon.src = chrome.runtime.getURL("media/icon1.jpeg");
    icon.alt = "FreeNotez";
    btn.appendChild(icon);

    const label = document.createElement("span");
    label.id = "freenotez-btn-label";
    btn.appendChild(label);

    btn.addEventListener("click", onButtonClick);

    document.body.appendChild(btn);
    return btn;
  }

  function onButtonClick() {
    if (isRecording) {
      chrome.runtime.sendMessage({ type: "content:stop-request" }).catch(() => {});
    } else {
      // Cannot start tabCapture from a page-originated click — show hint.
      chrome.runtime.sendMessage({ type: "content:start-request" }).catch(() => {});
      flashHint("Click the FreeNotez icon in the Chrome toolbar to start.");
    }
  }

  function setIdle() {
    isRecording = false;
    startedAt = null;
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    const btn = ensureButton();
    btn.classList.remove("freenotez-recording");
    const label = btn.querySelector("#freenotez-btn-label");
    if (label) label.textContent = "";
    btn.title = "FreeNotez — click the toolbar icon to start recording";
  }

  function setRecording(ts) {
    isRecording = true;
    startedAt = ts || Date.now();
    const btn = ensureButton();
    btn.classList.add("freenotez-recording");
    btn.title = "Recording — click to stop";
    updateTimer();
    if (!timerInterval) {
      timerInterval = setInterval(updateTimer, 1000);
    }
  }

  function updateTimer() {
    const btn = document.getElementById("freenotez-btn");
    if (!btn || !startedAt) return;
    const label = btn.querySelector("#freenotez-btn-label");
    if (!label) return;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    label.textContent = `${mm}:${ss}`;
  }

  function flashHint(text) {
    let hint = document.getElementById("freenotez-hint");
    if (!hint) {
      hint = document.createElement("div");
      hint.id = "freenotez-hint";
      document.body.appendChild(hint);
    }
    hint.textContent = text;
    hint.classList.add("freenotez-hint-visible");
    clearTimeout(flashHint._t);
    flashHint._t = setTimeout(() => {
      hint.classList.remove("freenotez-hint-visible");
    }, 4000);
  }

  function injectIfMeetingPage() {
    if (meetingCodePattern.test(window.location.pathname)) {
      ensureButton();
      // Sync state from background in case we got reloaded mid-recording.
      chrome.runtime.sendMessage({ type: "content:get-state" })
        .then((state) => {
          if (state?.active) setRecording(state.startedAt);
          else setIdle();
        })
        .catch(() => setIdle());
    }
  }

  injectIfMeetingPage();

  // Re-inject across SPA navigation and Meet's React re-renders.
  let lastPath = window.location.pathname;
  const observer = new MutationObserver(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      injectIfMeetingPage();
    } else if (meetingCodePattern.test(lastPath) && !document.getElementById("freenotez-btn")) {
      // Meet wiped the button during a re-render — put it back.
      ensureButton();
      if (isRecording) setRecording(startedAt);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Listen for state updates from the background.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "recording-started") {
      setRecording(msg.startedAt);
    } else if (msg.type === "recording-stopped") {
      setIdle();
      flashHint("Stopping & uploading…");
    } else if (msg.type === "recording-finished") {
      setIdle();
      flashHint(msg.ok ? "Recording uploaded." : `Upload failed: ${msg.error || "unknown"}`);
    } else if (msg.type === "recording-warning") {
      flashHint(msg.error || "Recording warning");
    } else if (msg.type === "recording-error") {
      setIdle();
      flashHint(msg.error || "Recording error");
    }
  });
})();
