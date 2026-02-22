/**
 * BERLIN PARLEMO — Probability Engine Backend
 * Node.js + WebSocket server connecting to Deriv API
 */

const WebSocket = require("ws");
const http = require("http");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Config ────────────────────────────────────────────────────────────────────
const DERIV_WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";
const MARKETS = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const TICK_BUFFER_SIZE = 10000;
const ROLLING_WINDOWS = [50, 100, 300, 1000];

// ── Global State ──────────────────────────────────────────────────────────────
const marketData = {};
MARKETS.forEach((m) => {
  marketData[m] = {
    ticks: [],          // { digit, timestamp, price, interval }
    lastPrice: null,
    lastTime: null,
    derivSocket: null,
    isConnected: false,
  };
});

// ── Probability Engine ────────────────────────────────────────────────────────

function getLastDigit(price) {
  const str = price.toString().replace(".", "");
  return parseInt(str[str.length - 1]);
}

function computeFrequency(ticks, window = null) {
  const source = window ? ticks.slice(-window) : ticks;
  const freq = Array(10).fill(0);
  source.forEach((t) => freq[t.digit]++);
  const total = source.length || 1;
  return freq.map((f) => f / total);
}

function computeZScores(freq) {
  const expected = 0.1;
  const n = freq.reduce((a, b) => a + b, 0); // sum of raw counts approx
  // std dev for binomial: sqrt(p*(1-p)/n) approximated
  const stdDev = Math.sqrt(expected * 0.9 / (freq.length * 50 || 50));
  return freq.map((f) => (f - expected) / stdDev);
}

function computeStreakModel(ticks, targetDigit) {
  if (!ticks.length) return { currentStreak: 0, percentile: 0 };
  let streak = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (ticks[i].digit !== targetDigit) streak++;
    else break;
  }
  // Geometric distribution: P(streak >= k) = 0.9^k for "not digit"
  const expectedProb = Math.pow(0.9, streak);
  const percentile = Math.round((1 - expectedProb) * 100);
  return { currentStreak: streak, percentile, meanReversionPressure: percentile / 100 };
}

function buildMarkovMatrix(ticks) {
  const matrix = Array.from({ length: 10 }, () => Array(10).fill(0));
  const counts = Array(10).fill(0);
  for (let i = 1; i < ticks.length; i++) {
    const from = ticks[i - 1].digit;
    const to = ticks[i].digit;
    matrix[from][to]++;
    counts[from]++;
  }
  // Normalize
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      matrix[i][j] = counts[i] ? matrix[i][j] / counts[i] : 0.1;
    }
  }
  return matrix;
}

function computeMarkovEntropy(row) {
  // Shannon entropy — high entropy = random state
  return -row.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0);
}

function detectMarketState(ticks) {
  if (ticks.length < 100) return "INSUFFICIENT_DATA";
  const recent = ticks.slice(-100);
  const freq = computeFrequency(recent);
  const maxFreq = Math.max(...freq);
  const minFreq = Math.min(...freq);
  const spread = maxFreq - minFreq;
  // Compute tick speed variance
  const intervals = recent.slice(1).map((t, i) => t.interval || 1000);
  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance = intervals.reduce((s, i) => s + Math.pow(i - avgInterval, 2), 0) / intervals.length;

  if (spread > 0.15) return "TRENDING"; // one digit dominating
  if (spread < 0.05 && variance < 500) return "RANDOM";
  return "MEAN_REVERSION"; // sweet spot
}

function computeTickSpeedState(ticks) {
  if (ticks.length < 5) return { avg: 1000, state: "NORMAL" };
  const recent = ticks.slice(-10);
  const intervals = recent.slice(1).map((t) => t.interval || 1000);
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  return {
    avg: Math.round(avg),
    state: avg < 400 ? "FAST_NOISE" : avg > 1500 ? "SLOW_EDGE" : "NORMAL",
  };
}

function generateSignals(market) {
  const data = marketData[market];
  const ticks = data.ticks;
  if (ticks.length < 300) return [];

  const signals = [];
  const markov = buildMarkovMatrix(ticks.slice(-1000));
  const lastDigit = ticks[ticks.length - 1]?.digit;
  const marketState = detectMarketState(ticks);
  const tickSpeed = computeTickSpeedState(ticks);

  // Block if market is random or tick speed is noise
  if (marketState === "RANDOM" || tickSpeed.state === "FAST_NOISE") {
    return [{ type: "NO_TRADE_ZONE", reason: `${marketState} / ${tickSpeed.state}`, confidence: 0 }];
  }

  const freq100 = computeFrequency(ticks, 100);
  const freq300 = computeFrequency(ticks, 300);
  const zScores = computeZScores(freq100);

  for (let digit = 0; digit <= 9; digit++) {
    const streak = computeStreakModel(ticks, digit);
    const markovRow = lastDigit !== undefined ? markov[lastDigit] : Array(10).fill(0.1);
    const markovProbForDigit = markovRow[digit];
    const markovEntropy = computeMarkovEntropy(markovRow);
    const z = zScores[digit];

    // DIGIT MATCH signal
    if (freq100[digit] < 0.06 && streak.percentile > 80 && markovProbForDigit > 0.12) {
      const confidence = Math.min(95,
        50 + Math.abs(z) * 5 + streak.percentile * 0.2 + (markovProbForDigit - 0.1) * 200
      );
      if (confidence >= 65) {
        signals.push({
          type: "DIGIT_MATCH",
          digit,
          confidence: Math.round(confidence),
          zScore: z.toFixed(2),
          streak: streak.currentStreak,
          streakPercentile: streak.percentile,
          markovProb: (markovProbForDigit * 100).toFixed(1),
          marketState,
          tickSpeed: tickSpeed.state,
          freq100: (freq100[digit] * 100).toFixed(1),
          action: `BUY MATCH ${digit}`,
          risk: confidence >= 80 ? "LOW" : confidence >= 72 ? "MED" : "HIGH",
        });
      }
    }

    // DIGIT DIFF signal (digit overrepresented)
    if (freq100[digit] > 0.16 && z > 2.5) {
      const confidence = Math.min(92,
        50 + z * 4 + (freq100[digit] - 0.1) * 200
      );
      if (confidence >= 65) {
        signals.push({
          type: "DIGIT_DIFF",
          digit,
          confidence: Math.round(confidence),
          zScore: z.toFixed(2),
          freq100: (freq100[digit] * 100).toFixed(1),
          marketState,
          tickSpeed: tickSpeed.state,
          action: `BUY DIFFERS ${digit}`,
          risk: confidence >= 78 ? "LOW" : "MED",
        });
      }
    }
  }

  // OVER/UNDER signal from distribution skew
  const lowDigitsFreq = freq100.slice(0, 5).reduce((a, b) => a + b, 0);
  const highDigitsFreq = freq100.slice(5).reduce((a, b) => a + b, 0);
  if (lowDigitsFreq > 0.60) {
    signals.push({
      type: "OVER_5",
      confidence: Math.round(50 + (lowDigitsFreq - 0.5) * 200),
      action: "BUY OVER 4",
      marketState,
      skew: (lowDigitsFreq * 100).toFixed(1),
      risk: "MED",
    });
  } else if (highDigitsFreq > 0.60) {
    signals.push({
      type: "UNDER_5",
      confidence: Math.round(50 + (highDigitsFreq - 0.5) * 200),
      action: "BUY UNDER 5",
      marketState,
      skew: (highDigitsFreq * 100).toFixed(1),
      risk: "MED",
    });
  }

  // EVEN/ODD parity imbalance
  const evenFreq = [0, 2, 4, 6, 8].reduce((s, d) => s + freq100[d], 0);
  const oddFreq = [1, 3, 5, 7, 9].reduce((s, d) => s + freq100[d], 0);
  if (Math.abs(evenFreq - 0.5) > 0.12) {
    signals.push({
      type: evenFreq < 0.38 ? "EVEN_REBOUND" : "ODD_REBOUND",
      confidence: Math.round(50 + Math.abs(evenFreq - 0.5) * 200),
      action: evenFreq < 0.38 ? "BUY EVEN" : "BUY ODD",
      marketState,
      paritySkew: (evenFreq * 100).toFixed(1),
      risk: "MED",
    });
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}

function getFullAnalysis(market) {
  const data = marketData[market];
  const ticks = data.ticks;
  if (!ticks.length) return null;

  const freq50 = computeFrequency(ticks, 50);
  const freq100 = computeFrequency(ticks, 100);
  const freq300 = computeFrequency(ticks, 300);
  const freq1000 = computeFrequency(ticks, 1000);
  const zScores = computeZScores(freq100);
  const marketState = detectMarketState(ticks);
  const tickSpeed = computeTickSpeedState(ticks);
  const markov = buildMarkovMatrix(ticks.slice(-1000));
  const lastDigit = ticks[ticks.length - 1]?.digit;
  const markovRow = lastDigit !== undefined ? markov[lastDigit] : Array(10).fill(0.1);
  const markovEntropy = computeMarkovEntropy(markovRow);
  const signals = generateSignals(market);

  // Streak data for all digits
  const streaks = Array.from({ length: 10 }, (_, d) => computeStreakModel(ticks, d));

  // Recent ticks (last 20 for display)
  const recentTicks = ticks.slice(-50).map((t) => t.digit);

  return {
    market,
    tickCount: ticks.length,
    lastDigit,
    lastPrice: data.lastPrice,
    marketState,
    tickSpeed,
    markovEntropy: markovEntropy.toFixed(3),
    frequencies: { f50: freq50, f100: freq100, f300: freq300, f1000: freq1000 },
    zScores,
    streaks,
    markovMatrix: markov,
    markovNextProbs: markovRow,
    signals,
    recentTicks,
    timestamp: Date.now(),
  };
}

// ── Deriv Connection per Market ───────────────────────────────────────────────

function connectMarket(market) {
  const ws = new WebSocket(DERIV_WS_URL);
  marketData[market].derivSocket = ws;

  ws.on("open", () => {
    marketData[market].isConnected = true;
    ws.send(JSON.stringify({ ticks: market, subscribe: 1 }));
    console.log(`[BERLIN] Connected to ${market}`);
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.tick) {
        const price = msg.tick.quote;
        const digit = getLastDigit(price);
        const now = Date.now();
        const interval = marketData[market].lastTime ? now - marketData[market].lastTime : 1000;

        marketData[market].ticks.push({ digit, price, timestamp: now, interval });
        if (marketData[market].ticks.length > TICK_BUFFER_SIZE) {
          marketData[market].ticks.shift();
        }
        marketData[market].lastPrice = price;
        marketData[market].lastTime = now;

        // Broadcast to all frontend clients
        broadcastTick(market, digit, price, interval);
      }
    } catch (e) {}
  });

  ws.on("close", () => {
    marketData[market].isConnected = false;
    console.log(`[BERLIN] ${market} disconnected. Reconnecting in 3s...`);
    setTimeout(() => connectMarket(market), 3000);
  });

  ws.on("error", () => {
    ws.close();
  });
}

// ── Frontend WS Broadcast ─────────────────────────────────────────────────────

const frontendClients = new Set();
let analysisBroadcastInterval = null;

function broadcastTick(market, digit, price, interval) {
  const msg = JSON.stringify({ type: "TICK", market, digit, price, interval, ts: Date.now() });
  frontendClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function broadcastAnalysis() {
  MARKETS.forEach((market) => {
    const analysis = getFullAnalysis(market);
    if (!analysis) return;
    const msg = JSON.stringify({ type: "ANALYSIS", ...analysis });
    frontendClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  });
}

wss.on("connection", (ws) => {
  frontendClients.add(ws);
  console.log(`[BERLIN] Frontend client connected. Total: ${frontendClients.size}`);

  // Send current analysis immediately
  MARKETS.forEach((market) => {
    const analysis = getFullAnalysis(market);
    if (analysis) ws.send(JSON.stringify({ type: "ANALYSIS", ...analysis }));
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "GET_ANALYSIS") {
        const analysis = getFullAnalysis(msg.market);
        if (analysis) ws.send(JSON.stringify({ type: "ANALYSIS", ...analysis }));
      }
      // Auto-trade execution via Deriv API
      if (msg.type === "EXECUTE_TRADE") {
        executeTrade(ws, msg);
      }
    } catch (e) {}
  });

  ws.on("close", () => {
    frontendClients.delete(ws);
  });
});

// ── Auto-Trade Execution ──────────────────────────────────────────────────────

const activeTradeTokens = new Map();

function executeTrade(clientWs, tradeMsg) {
  const { token, market, contractType, digit, stake, duration } = tradeMsg;
  if (!token) return clientWs.send(JSON.stringify({ type: "TRADE_ERROR", error: "No token provided" }));

  const tradeWs = new WebSocket(DERIV_WS_URL);
  tradeWs.on("open", () => {
    tradeWs.send(JSON.stringify({ authorize: token }));
  });

  tradeWs.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.msg_type === "authorize") {
      // Place contract
      tradeWs.send(JSON.stringify({
        buy: 1,
        price: stake,
        parameters: {
          contract_type: contractType, // DIGITMATCH, DIGITDIFF, DIGITOVER, DIGITUNDER, DIGITEVEN, DIGITODD
          symbol: market,
          duration: duration || 1,
          duration_unit: "t",
          basis: "stake",
          amount: stake,
          currency: "USD",
          ...(digit !== undefined ? { barrier: digit.toString() } : {}),
        },
      }));
    }
    if (msg.msg_type === "buy") {
      clientWs.send(JSON.stringify({ type: "TRADE_PLACED", contract_id: msg.buy?.contract_id, details: msg.buy }));
      tradeWs.close();
    }
    if (msg.error) {
      clientWs.send(JSON.stringify({ type: "TRADE_ERROR", error: msg.error.message }));
      tradeWs.close();
    }
  });
}

// ── REST API Endpoints ────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "BERLIN PARLEMO ONLINE", markets: MARKETS }));

app.get("/analysis/:market", (req, res) => {
  const analysis = getFullAnalysis(req.params.market);
  if (!analysis) return res.status(404).json({ error: "No data yet" });
  res.json(analysis);
});

app.get("/signals", (req, res) => {
  const allSignals = {};
  MARKETS.forEach((m) => {
    allSignals[m] = generateSignals(m);
  });
  res.json(allSignals);
});

// ── Boot ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║     BERLIN PARLEMO ENGINE ONLINE      ║`);
  console.log(`║     Port: ${PORT}                         ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  MARKETS.forEach(connectMarket);

  // Broadcast full analysis every 2 seconds
  analysisBroadcastInterval = setInterval(broadcastAnalysis, 2000);
});

