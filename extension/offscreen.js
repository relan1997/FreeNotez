// FreeNotez — offscreen recorder
// Lives in a hidden document so MediaRecorder survives popup/icon UI churn.
// Receives a tabCapture streamId from background.js, records A+V (+mic).
//
// On stop:
//   - Video (A+V webm) → browser download, stays local, never hits the server.
//   - Audio-only (opus webm) → POST to localhost:8000/upload, saved to disk there.

const SERVER_UPLOAD_URL = "http://localhost:8000/upload";

// Two separate recorders — one for video, one for audio.
let videoRecorder = null;
let audioRecorder = null;
let videoChunks = [];
let audioChunks = [];

let tabStream = null;
let micStream = null;
let audioContext = null;
let activeTabId = null;

async function startRecording(streamId, tabId) {
  if (videoRecorder || audioRecorder) {
    console.warn("[offscreen] already recording");
    return;
  }
  activeTabId = tabId;
  videoChunks = [];
  audioChunks = [];

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

    // 2. Capture the user's mic separately. This is critical — without the
    //    mic, the recording only contains everyone else's voices, not yours.
    //    Note: offscreen documents cannot show permission prompts. The
    //    extension must already have mic permission via the visible
    //    permission.html page (opened on install). If permission was never
    //    granted, getUserMedia rejects with NotAllowedError immediately.
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false
      });
    } catch (micErr) {
      console.error("[offscreen] mic capture failed:", micErr);
      // Make this loud — caller will see a toast and know to grant permission.
      sendBackgroundMessage({
        type: "offscreen:mic-denied",
        error: String(micErr.name || micErr.message || micErr)
      });
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

    const mixedAudioTrack = destination.stream.getAudioTracks()[0];
    const videoTrack = tabStream.getVideoTracks()[0];

    // 4a. VIDEO recorder — tab video + mixed audio, saved locally via download.
    //     Never sent to the server.
    const videoMimeCandidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];
    const videoMime = videoMimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
    const videoStream = new MediaStream([videoTrack, mixedAudioTrack]);

    videoRecorder = new MediaRecorder(videoStream, {
      mimeType: videoMime,
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000
    });
    videoRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) videoChunks.push(e.data);
    };
    videoRecorder.onerror = (err) => {
      console.error("[offscreen] videoRecorder error:", err);
      sendBackgroundMessage({ type: "offscreen:error", error: String(err.error || err) });
    };

    // 4b. AUDIO recorder — mixed audio only, uploaded to the server.
    const audioMime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const audioOnlyStream = new MediaStream([mixedAudioTrack]);

    audioRecorder = new MediaRecorder(audioOnlyStream, {
      mimeType: audioMime,
      audioBitsPerSecond: 96_000
    });
    audioRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };
    audioRecorder.onerror = (err) => {
      console.error("[offscreen] audioRecorder error:", err);
    };

    // 5. Start both. Use a Promise to wait for both onstop events before
    //    finalizing, since .stop() is async and fires onstop when fully flushed.
    const videoStopped = new Promise((res) => (videoRecorder.onstop = res));
    const audioStopped = new Promise((res) => (audioRecorder.onstop = res));

    videoRecorder.start(30_000);
    audioRecorder.start(30_000);

    // Stash the stop-promises so handleStop can await them.
    videoRecorder._stopped = videoStopped;
    audioRecorder._stopped = audioStopped;

    console.log("[offscreen] recording started — video:", videoMime, "| audio:", audioMime);
  } catch (err) {
    console.error("[offscreen] startRecording failed:", err);
    cleanupTracks();
    sendBackgroundMessage({ type: "offscreen:error", error: String(err.message || err) });
  }
}

function stopRecording() {
  if (!videoRecorder && !audioRecorder) {
    console.warn("[offscreen] stopRecording called but no recorder");
    sendBackgroundMessage({ type: "offscreen:finished", ok: false, error: "not-recording" });
    return;
  }
  // Stop both recorders. Each fires its onstop Promise (stored in _stopped).
  // handleStop awaits both before finalizing.
  if (videoRecorder && videoRecorder.state !== "inactive") videoRecorder.stop();
  if (audioRecorder && audioRecorder.state !== "inactive") audioRecorder.stop();
  handleStop();
}

async function handleStop() {
  try {
    // Wait for both recorders to fully flush their last chunk.
    await Promise.all([
      videoRecorder?._stopped,
      audioRecorder?._stopped
    ]);

    const videoMime = videoRecorder?.mimeType || "video/webm";
    const audioMime = audioRecorder?.mimeType || "audio/webm";

    const videoBlob = new Blob(videoChunks, { type: videoMime });
    const audioBlob = new Blob(audioChunks, { type: audioMime });

    console.log(`[offscreen] video blob: ${videoBlob.size} bytes | audio blob: ${audioBlob.size} bytes`);

    cleanupTracks();

    // --- VIDEO: download locally, never sent to server ---
    triggerLocalDownload(videoBlob, `freenotez-video-${Date.now()}.webm`);

    // --- AUDIO: upload to local server ---
    const meta = {
      tab_id: activeTabId,
      mime: audioMime,
      ended_at: Date.now()
    };
    const fd = new FormData();
    fd.append("media", audioBlob, `recording-audio-${Date.now()}.webm`);
    fd.append("meta", JSON.stringify(meta));

    let ok = false;
    let error = null;
    try {
      const res = await fetch(SERVER_UPLOAD_URL, { method: "POST", body: fd });
      ok = res.ok;
      if (!ok) error = `Upload HTTP ${res.status}`;
    } catch (uploadErr) {
      error = String(uploadErr.message || uploadErr);
      console.error("[offscreen] audio upload failed:", uploadErr);
      // Fallback: download the audio locally too so it isn't lost.
      triggerLocalDownload(audioBlob, `freenotez-audio-${Date.now()}.webm`);
    }

    sendBackgroundMessage({ type: "offscreen:finished", ok, error });
  } catch (err) {
    console.error("[offscreen] handleStop failed:", err);
    sendBackgroundMessage({ type: "offscreen:finished", ok: false, error: String(err.message || err) });
  } finally {
    videoRecorder = null;
    audioRecorder = null;
    videoChunks = [];
    audioChunks = [];
  }
}

function cleanupTracks() {
  try { tabStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioContext?.close(); } catch {}
  tabStream = null;
  micStream = null;
  audioContext = null;
}

function triggerLocalDownload(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
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
