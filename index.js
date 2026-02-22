import express from "express";
import { runEngine } from "./engine/runEngine.js";

const app = express();
app.use(express.json());

// Endpoint to get trade signal
app.post("/analyze", (req, res) => {
  const { ticks } = req.body;
  const result = runEngine(ticks);
  res.json(result);
});

// Basic test endpoint
app.get("/", (req, res) => {
  res.send("Berlin-Parlemo Engine Running");
});

app.listen(3000, () => console.log("Server running on port 3000"));
