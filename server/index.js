const express = require("express");
const cors = require("cors");
const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.json());

app.post("/join", (req, res) => {
  console.log("helloo");
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`FreeNotez server running on http://localhost:${PORT}`);
});
