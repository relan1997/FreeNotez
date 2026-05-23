// FreeNotez — one-time microphone permission grant page.
// Offscreen documents are hidden and can't trigger permission prompts.
// This visible HTML page IS allowed to prompt, and once the user grants mic
// access to the extension origin, that permission is shared with the offscreen
// document going forward.

const btn = document.getElementById("grant");
const status = document.getElementById("status");

function setStatus(msg, kind) {
  status.textContent = msg;
  status.classList.remove("ok", "fail", "idle");
  status.classList.add(kind);
}

async function checkExisting() {
  try {
    const result = await navigator.permissions.query({ name: "microphone" });
    if (result.state === "granted") {
      setStatus("Already granted — you're good to go. You can close this tab.", "ok");
      btn.disabled = true;
    }
  } catch {
    // permissions.query may not support "microphone" everywhere — ignore.
  }
}

async function requestMic() {
  btn.disabled = true;
  setStatus("Requesting permission…", "idle");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Immediately stop the tracks — we only need the permission, not the stream.
    stream.getTracks().forEach((t) => t.stop());
    setStatus("Granted. You can close this tab and start recording from the toolbar icon.", "ok");
  } catch (err) {
    setStatus(`Denied or failed: ${err.name || err.message || err}. Open chrome://settings/content/microphone to enable manually.`, "fail");
    btn.disabled = false;
  }
}

btn.addEventListener("click", requestMic);
checkExisting();
