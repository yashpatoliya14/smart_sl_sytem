require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const EventEmitter = require("events");

// Event emitter for triggering external actions (e.g. Telegram notifications)
const slEvents = new EventEmitter();

const STATE_FILE = path.join(__dirname, "smart-sl-state.json");

const CONFIG = {
  baseUrl: (process.env.DELTA_BASE_URL || "https://api.india.delta.exchange").replace(/\/+$/, ""),
  apiKey: process.env.DELTA_API_KEY || "",
  apiSecret: process.env.DELTA_API_SECRET || "",
  intervalMs: Number(process.env.SMART_SL_INTERVAL_MS || 1000),
  defaultDryRun: process.env.SMART_SL_DRY_RUN !== "false",
};

let cachedUserId = null;
let triggered = false;
let running = false;
let monitorIntervalId = null;
let lastMissingLimitAlertTime = 0;

// Read state from JSON file
async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    return {
      enabled: typeof data.enabled === "boolean" ? data.enabled : true,
      lossLimit: Number.isFinite(data.lossLimit) && data.lossLimit > 0 ? Number(data.lossLimit) : null,
      dryRun: typeof data.dryRun === "boolean" ? data.dryRun : CONFIG.defaultDryRun,
      lastUpdated: data.lastUpdated || null
    };
  } catch (err) {
    const defaultState = {
      enabled: true,
      lossLimit: null, // NO hardcoded fallback: must be set via Telegram
      dryRun: CONFIG.defaultDryRun,
      lastUpdated: new Date().toISOString()
    };
    await saveState(defaultState);
    return defaultState;
  }
}

// Atomically save state to JSON file
async function saveState(state) {
  const payload = {
    ...state,
    lastUpdated: new Date().toISOString()
  };
  const tempPath = STATE_FILE + ".tmp";
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, STATE_FILE);
  return payload;
}

// HMAC-SHA256 signature generator for Delta Exchange API
function sign(method, path, body = "") {
  if (!CONFIG.apiKey || !CONFIG.apiSecret) {
    throw new Error("Missing Delta Exchange API Key or Secret in environment configuration.");
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = method.toUpperCase() + timestamp + path + body;

  const signature = crypto
    .createHmac("sha256", CONFIG.apiSecret)
    .update(message)
    .digest("hex");

  return {
    "api-key": CONFIG.apiKey,
    timestamp,
    signature,
    "User-Agent": "Delta-Smart-SL/1.0",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// Standard HTTP client for Delta Exchange API
async function deltaRequest(method, path, payload = null) {
  const body = payload === null ? "" : JSON.stringify(payload);
  const headers = sign(method, path, body);

  const url = CONFIG.baseUrl + path;
  const response = await fetch(url, {
    method: method.toUpperCase(),
    headers,
    body: payload === null ? undefined : body,
    signal: AbortSignal.timeout(8000),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Delta API HTTP ${response.status}: Failed to parse JSON response`);
  }

  if (!response.ok || data.success === false) {
    const errMsg = data?.error?.message || data?.error || JSON.stringify(data);
    throw new Error(`Delta API HTTP ${response.status}: ${errMsg}`);
  }

  return data;
}

// Fetch user profile (to obtain user_id if needed)
async function fetchUserProfile() {
  if (cachedUserId) return cachedUserId;
  try {
    const res = await deltaRequest("GET", "/v2/profile");
    if (res?.result?.id) {
      cachedUserId = res.result.id;
      return cachedUserId;
    }
  } catch (err) {
    // Non-critical if user_id is extracted from positions
  }
  return null;
}

// Fetch all open positions and calculate total unrealised PnL
async function getTotalUnrealisedPnl() {
  const response = await deltaRequest("GET", "/v2/positions/margined");

  if (!Array.isArray(response.result)) {
    throw new Error("Unexpected response format from /v2/positions/margined");
  }

  // Filter out closed positions (size == 0)
  const openPositions = response.result.filter(
    (pos) => Number(pos.size) !== 0
  );

  if (openPositions.length === 0) {
    return {
      totalPnl: 0,
      positions: [],
      userId: cachedUserId,
    };
  }

  // Cache user_id if present
  if (openPositions[0].user_id) {
    cachedUserId = openPositions[0].user_id;
  }

  const positions = openPositions.map((p) => {
    const rawPnl = Number(p.unrealized_pnl);
    const pnl = Number.isFinite(rawPnl) ? rawPnl : 0;
    return {
      product_symbol: p.product_symbol || `Product_${p.product_id}`,
      product_id: p.product_id,
      size: Number(p.size),
      entry_price: p.entry_price || "0",
      mark_price: p.mark_price || "0",
      unrealized_pnl: pnl,
      realized_pnl: Number(p.realized_pnl || 0),
      margin_mode: p.margin_mode || "portfolio",
      user_id: p.user_id || cachedUserId,
    };
  });

  const totalPnl = positions.reduce((sum, pos) => sum + pos.unrealized_pnl, 0);

  return {
    totalPnl,
    positions,
    userId: cachedUserId || positions[0]?.user_id || null,
  };
}

// Emergency / SL execution: Close all open positions across portfolio and isolated margin
async function closeAllPositionsInternal(userId = null) {
  const uid = userId || cachedUserId || (await fetchUserProfile());

  const payload = {
    close_all_portfolio: true,
    close_all_isolated: true,
  };

  if (uid) {
    payload.user_id = uid;
  }

  console.log(`[EXECUTION] Submitting /v2/positions/close_all (user_id: ${uid || "default"})...`);

  const result = await deltaRequest("POST", "/v2/positions/close_all", payload);
  console.log("[EXECUTION] Close-all response:", JSON.stringify(result));

  const skipped = result.result?.skipped_products || [];
  if (skipped.length > 0) {
    console.warn("[WARNING] Some positions were skipped by exchange:", skipped);
  }

  return {
    success: true,
    result: result.result,
    skipped,
  };
}

// Public wrapper for closing all positions (used by Telegram emergency button)
async function closeAllPositions() {
  const data = await getTotalUnrealisedPnl();
  if (data.positions.length === 0) {
    return { success: true, message: "No open positions to close.", count: 0 };
  }

  const result = await closeAllPositionsInternal(data.userId);
  return {
    success: true,
    message: "Close-all request submitted successfully.",
    closedCount: data.positions.length,
    ...result,
  };
}

// Get comprehensive status object for Telegram bot or dashboard
async function getSmartSLStatus() {
  const state = await loadState();
  let pnlData = { totalPnl: 0, positions: [], userId: null };
  let fetchError = null;

  try {
    pnlData = await getTotalUnrealisedPnl();
  } catch (err) {
    fetchError = err.message;
  }

  return {
    enabled: state.enabled,
    lossLimit: state.lossLimit,
    dryRun: state.dryRun,
    totalPnl: pnlData.totalPnl,
    positionsCount: pnlData.positions.length,
    positions: pnlData.positions,
    engine: !state.lossLimit ? "PAUSED (NO SL CONFIGURED)" : triggered ? "TRIGGERED (HALTED)" : running ? "MONITORING" : "IDLE",
    triggered,
    fetchError,
    baseUrl: CONFIG.baseUrl,
    lastChecked: new Date().toISOString(),
  };
}

// Reset the trigger lock so monitoring can resume
function resetTrigger() {
  triggered = false;
  console.log("[SMART SL] Trigger lock has been reset. Protection re-armed.");
  return { success: true, triggered: false };
}

function isTriggered() {
  return triggered;
}

// Single cycle monitor check
async function monitorSmartSL() {
  if (running) return;
  running = true;

  try {
    const state = await loadState();

    if (!state.enabled) {
      return;
    }

    // Require Stop-Loss limit to be explicitly configured via Telegram
    if (!state.lossLimit || state.lossLimit <= 0) {
      const now = Date.now();
      if (now - lastMissingLimitAlertTime > 60000) {
        lastMissingLimitAlertTime = now;
        console.warn("\n⚠️ [SMART SL PAUSED] Loss limit is not configured. Protection is inactive until set via Telegram.");
        slEvents.emit("missing_limit", {
          message: "⚠️ Smart Stop-Loss value is NOT set! Please enter a value in Telegram (e.g. 15 or 25) to activate protection."
        });
      }
      return;
    }

    if (triggered) {
      return; // Already triggered, awaiting user reset
    }

    const data = await getTotalUnrealisedPnl();

    if (data.positions.length === 0) {
      return; // No open positions
    }

    const lossLimit = state.lossLimit;
    const currentPnl = data.totalPnl;

    const logLine = `[${new Date().toLocaleTimeString()}] Positions: ${data.positions.length} | Total Unrealised PnL: $${currentPnl.toFixed(2)} | SL Limit: -$${lossLimit} | Mode: ${state.dryRun ? "DRY-RUN" : "LIVE"}`;
    console.log(logLine);

    // Stop Loss Trigger Condition: Unrealised loss reaches or exceeds limit
    if (currentPnl <= -lossLimit) {
      triggered = true;
      console.error(`\n🚨 [SMART SL TRIGGERED] Unrealised PnL ($${currentPnl.toFixed(2)}) reached limit (-$${lossLimit})!`);

      const triggerEvent = {
        totalPnl: currentPnl,
        lossLimit,
        dryRun: state.dryRun,
        positions: data.positions,
        timestamp: new Date().toISOString(),
      };

      if (state.dryRun) {
        console.warn("🧪 [DRY RUN] Simulation mode active. No real market orders were placed.");
        slEvents.emit("triggered", {
          ...triggerEvent,
          simulation: true,
          message: "Smart SL triggered in SIMULATION mode.",
        });
        return;
      }

      // Live Execution
      try {
        const closeResult = await closeAllPositionsInternal(data.userId);
        slEvents.emit("triggered", {
          ...triggerEvent,
          simulation: false,
          result: closeResult,
          message: "All positions closed successfully.",
        });
      } catch (execErr) {
        console.error("❌ [CLOSE ALL FAILED]:", execErr.message);
        slEvents.emit("error", {
          action: "close_all",
          error: execErr.message,
          pnl: currentPnl,
        });
      }
    }
  } catch (err) {
    console.error("[MONITOR ERROR]:", err.message);
    slEvents.emit("error", { action: "monitor", error: err.message });
  } finally {
    running = false;
  }
}

// Start recurring monitoring loop
function startMonitorLoop() {
  console.log("=========================================");
  console.log("   DELTA EXCHANGE SMART STOP LOSS ENGINE ");
  console.log("=========================================");
  console.log(`Endpoint:    ${CONFIG.baseUrl}`);
  console.log(`Interval:    ${CONFIG.intervalMs}ms`);

  loadState().then((state) => {
    console.log(`Initial SL:  ${state.lossLimit ? `-$${state.lossLimit}` : "⚠️ NOT CONFIGURED (Waiting for Telegram)"}`);
    console.log(`Protection:  ${state.enabled && state.lossLimit ? "ENABLED" : "PAUSED (Awaiting SL value via Telegram)"}`);
    console.log(`Mode:        ${state.dryRun ? "🧪 DRY-RUN (Simulation)" : "⚡ LIVE TRADING"}`);
    console.log("=========================================\n");
  });

  if (monitorIntervalId) clearInterval(monitorIntervalId);

  monitorIntervalId = setInterval(() => {
    monitorSmartSL().catch((err) => {
      console.error("[UNCAUGHT MONITOR ERROR]:", err.message);
    });
  }, CONFIG.intervalMs);

  return monitorIntervalId;
}

// Stop recurring monitoring loop
function stopMonitorLoop() {
  if (monitorIntervalId) {
    clearInterval(monitorIntervalId);
    monitorIntervalId = null;
    console.log("[SMART SL] Monitoring loop stopped.");
  }
}

// If run directly: node smart-sl.js
if (require.main === module) {
  startMonitorLoop();

  process.on("SIGINT", () => {
    console.log("\nShutting down Smart SL monitor...");
    stopMonitorLoop();
    process.exit(0);
  });
}

module.exports = {
  CONFIG,
  slEvents,
  loadState,
  saveState,
  deltaRequest,
  fetchUserProfile,
  getTotalUnrealisedPnl,
  closeAllPositions,
  getSmartSLStatus,
  resetTrigger,
  isTriggered,
  monitorSmartSL,
  startMonitorLoop,
  stopMonitorLoop,
};
