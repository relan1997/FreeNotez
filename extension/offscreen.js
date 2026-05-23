// FreeNotez — offscreen recorder
// Lives in a hidden document so MediaRecorder survives popup/icon UI churn.
// Receives a tabCapture streamId from background.js, records A+V (+mic),
// and uploads the resulting webm to the local server on stop.

const SERVER_UPLOAD_URL = "http://localhost:8000/upload";

let mediaRecorder = null;
let recordedChunks = [];
let tabStream = null;
let micStream = null;
let audioContext = null;
let mixedStream = null;
let activeTabId = null;

async function startRecording(streamId, tabId) {
  if (mediaRecorder) {
    console.warn("[offscreen] already recording");
    return;
  }
  activeTabId = tabId;
  recordedChunks = [];

  try {
    // 1. Capture the tab's audio + video using the streamId from background.
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          maxWidth: 1280,
          maxHeight: 720,
          maxFrameRate: 15
        }
      }
    });

    // 2. Capture the user's mic separately (best-effort).
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false
      });
    } catch (micErr) {
      console.warn("[offscreen] mic unavailable, recording tab audio only:", micErr);
      micStream = null;
    }

    // 3. Mix tab audio + mic via Web Audio API into a single audio track.
    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();

    const tabAudioSource = audioContext.createMediaStreamSource(
      new MediaStream(tabStream.getAudioTracks())
    );
    tabAudioSource.connect(destination);
    // Also pipe tab audio back to speakers so the user still hears the meeting
    // (tabCapture mutes the original tab playback).
    tabAudioSource.connect(audioContext.destination);

    if (micStream) {
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(destination);
    }

    // 4. Build the final stream: video from tab + mixed audio.
    const videoTrack = tabStream.getVideoTracks()[0];
    const mixedAudioTrack = destination.stream.getAudioTracks()[0];
    mixedStream = new MediaStream([videoTrack, mixedAudioTrack]);

    // 5. MediaRecorder. Prefer vp9; fall back to vp8.
    const mimeCandidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";

    mediaRecorder = new MediaRecorder(mixedStream, {
      mimeType,
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = handleStop;
    mediaRecorder.onerror = (err) => {
      console.error("[offscreen] MediaRecorder error:", err);
      sendBackgroundMessage({ type: "offscreen:error", error: String(err.error || err) });
    };

    mediaRecorder.start(30_000); // 30s chunks
    console.log("[offscreen] recording started:", mimeType);
  } catch (err) {
    console.error("[offscreen] startRecording failed:", err);
    cleanupTracks();
    sendBackgroundMessage({ type: "offscreen:error", error: String(err.message || err) });
  }
}

function stopRecording() {
  if (!mediaRecorder) {
    console.warn("[offscreen] stopRecording called but no recorder");
    sendBackgroundMessage({ type: "offscreen:finished", ok: false, error: "not-recording" });
    return;
  }
  if (mediaRecorder.state !== "inactive") {
    mediaRecorder.stop(); // triggers onstop -> handleStop
  } else {
    handleStop();
  }
}

async function handleStop() {
  try {
    const mimeType = mediaRecorder?.mimeType || "video/webm";
    const blob = new Blob(recordedChunks, { type: mimeType });
    console.log(`[offscreen] recording stopped, blob size: ${blob.size} bytes`);

    cleanupTracks();

    // Upload to local server.
    const meta = {
      tab_id: activeTabId,
      mime: mimeType,
      ended_at: Date.now()
    };
    const fd = new FormData();
    fd.append("media", blob, `recording-${Date.now()}.webm`);
    fd.append("meta", JSON.stringify(meta));

    let ok = false;
    let error = null;
    try {
      const res = await fetch(SERVER_UPLOAD_URL, { method: "POST", body: fd });
      ok = res.ok;
      if (!ok) error = `Upload HTTP ${res.status}`;
    } catch (uploadErr) {
      error = String(uploadErr.message || uploadErr);
      console.error("[offscreen] upload failed:", uploadErr);
      // Fallback: trigger a download so the recording isn't lost.
      triggerLocalDownload(blob);
    }

    sendBackgroundMessage({ type: "offscreen:finished", ok, error });
  } catch (err) {
    console.error("[offscreen] handleStop failed:", err);
    sendBackgroundMessage({ type: "offscreen:finished", ok: false, error: String(err.message || err) });
  } finally {
    mediaRecorder = null;
    recordedChunks = [];
  }
}

function cleanupTracks() {
  try { tabStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { mixedStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioContext?.close(); } catch {}
  tabStream = null;
  micStream = null;
  mixedStream = null;
  audioContext = null;
}

function triggerLocalDownload(blob) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `freenotez-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    console.error("[offscreen] fallback download failed:", err);
  }
}

function sendBackgroundMessage(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "offscreen:start") {
    startRecording(msg.streamId, msg.tabId);
  } else if (msg.type === "offscreen:stop") {
    stopRecording();
  }
});

console.log("[offscreen] ready");
