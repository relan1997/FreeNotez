const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");

const app = express();
const PORT = 8000;

// Recordings live outside the repo, in ~/FreeNotez/recordings/
const RECORDINGS_DIR = path.join(os.homedir(), "FreeNotez", "recordings");
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RECORDINGS_DIR),
  filename: (_req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `${ts}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 } // 4GB cap, generous for long meetings
});

app.use(cors());
app.use(express.json());

app.post("/upload", upload.single("media"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "no media file" });
  }
  let meta = {};
  try { meta = JSON.parse(req.body.meta || "{}"); } catch {}
  console.log(`[upload] saved ${req.file.path} (${req.file.size} bytes)`, meta);
  res.json({
    ok: true,
    path: req.file.path,
    size: req.file.size,
    meta
  });
});

app.get("/status", (_req, res) => {
  res.json({ status: "idle" });
});

app.listen(PORT, () => {
  console.log(`FreeNotez server running on http://localhost:${PORT}`);
  console.log(`Recordings → ${RECORDINGS_DIR}`);
});
