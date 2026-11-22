require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs/promises");
const path = require("path");

const {
  loadState,
  saveState,
  getSmartSLStatus,
  closeAllPositions,
  resetTrigger,
  slEvents,
} = require("./smart-sl");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();

if (!BOT_TOKEN) {
  console.warn("⚠️ TELEGRAM_BOT_TOKEN is not defined in .env. Bot will not start until configured.");
}

const bot = new Telegraf(BOT_TOKEN || "PLACEHOLDER_TOKEN");

// User session tracking
let waitingForCustomLimit = {};
let pendingEmergency = {};

// Security middleware: block unauthorized users
bot.use(async (ctx, next) => {
  if (!AUTHORIZED_ID) {
    // If not set yet, tell the user their Chat ID so they can easily set it in .env!
    const fromId = String(ctx.from?.id);
    return ctx.reply(
      `⚠️ TELEGRAM_CHAT_ID is not configured in .env!\n\nYour Telegram User/Chat ID is: \`${fromId}\`\n\nPlease add this to your .env file:\nTELEGRAM_CHAT_ID=${fromId}`,
      { parse_mode: "Markdown" }
    );
  }

  const userId = String(ctx.from?.id || "");
  const authorizedList = AUTHORIZED_ID.split(",").map((id) => id.trim());

  if (!authorizedList.includes(userId)) {
    console.warn(`[SECURITY] Blocked unauthorized access attempt from Telegram ID: ${userId}`);
    return ctx.reply("⛔ Access Denied. You are not authorized to use this Smart SL system.");
  }

  return next();
});

// Main dashboard keyboard
function mainKeyboard(state) {
  const toggleBtn = state.enabled
    ? Markup.button.callback("⛔ Disable Smart SL", "disable")
    : Markup.button.callback("🛡 Enable Smart SL", "enable");

  const dryRunBtn = state.dryRun
    ? Markup.button.callback("🧪 Dry-Run: [ON] (Click to Live)", "toggle_dryrun")
    : Markup.button.callback("⚡ Live Mode: [ACTIVE] (Click to Sim)", "toggle_dryrun");

  return Markup.inlineKeyboard([
    [toggleBtn, Markup.button.callback("📊 Live Status", "status")],
    [Markup.button.callback("💰 Change SL Limit", "change_sl"), Markup.button.callback("🔄 Re-arm / Reset", "reset_trigger")],
    [dryRunBtn],
    [Markup.button.callback("🚨 Emergency Close All", "emergency_close")],
  ]);
}

// Preset values keyboard for Stop Loss
function presetKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("$5", "limit:5"),
      Markup.button.callback("$10", "limit:10"),
      Markup.button.callback("$15", "limit:15"),
    ],
    [
      Markup.button.callback("$20", "limit:20"),
      Markup.button.callback("$25", "limit:25"),
      Markup.button.callback("$50", "limit:50"),
    ],
    [
      Markup.button.callback("$100", "limit:100"),
      Markup.button.callback("✏️ Custom Amount", "custom_sl"),
    ],
    [Markup.button.callback("⬅️ Back to Dashboard", "home")],
  ]);
}

// Render main dashboard message
async function renderDashboard(ctx, editInsteadOfReply = false) {
  const status = await getSmartSLStatus();
  const state = await loadState();

  const pnlSign = status.totalPnl >= 0 ? "+" : "";
  const pnlFormatted = `${pnlSign}$${status.totalPnl.toFixed(2)}`;
  const isBreached = state.lossLimit && status.totalPnl <= -state.lossLimit;
  const pnlIcon = status.totalPnl >= 0 ? "🟢" : isBreached ? "🚨" : "🟡";

  let statusText = [
    "🛡 *DELTA EXCHANGE SMART STOP-LOSS*",
    "━━━━━━━━━━━━━━━━━━━━━━",
  ];

  if (!state.lossLimit) {
    statusText.push(
      "❌ *CONFIGURATION ERROR: STOP-LOSS NOT SET!*",
      "Protection is currently *INACTIVE*.",
      "",
      "👉 *Reply with a number in this chat (e.g. `15` or `25`) or tap a preset below to activate:*",
      "━━━━━━━━━━━━━━━━━━━━━━",
      `• *Protection:* 🔴 WAITING FOR SL VALUE`,
      `• *Max Allowed Loss:* ❌ NOT CONFIGURED`,
      `• *Current Total PnL:* ${pnlIcon} \`${pnlFormatted}\``,
      `• *Open Positions:* ${status.positionsCount}`,
      `• *Engine Status:* \`${status.engine}\``,
      `• *Trading Mode:* ${state.dryRun ? "🧪 Simulation (Dry-Run)" : "⚡ Real Trading (Live)"}`,
      "━━━━━━━━━━━━━━━━━━━━━━"
    );
  } else {
    statusText.push(
      `• *Protection:* ${state.enabled ? "🟢 ENABLED" : "🔴 DISABLED"}`,
      `• *Max Allowed Loss:* -$${state.lossLimit.toFixed(2)}`,
      `• *Current Total PnL:* ${pnlIcon} \`${pnlFormatted}\``,
      `• *Open Positions:* ${status.positionsCount}`,
      `• *Engine Status:* \`${status.engine}\``,
      `• *Trading Mode:* ${state.dryRun ? "🧪 Simulation (Dry-Run)" : "⚡ Real Trading (Live)"}`,
      "━━━━━━━━━━━━━━━━━━━━━━"
    );
  }

  if (status.fetchError) {
    statusText.push(`⚠️ *API Warning:* \`${status.fetchError}\``);
  } else if (status.positionsCount > 0) {
    statusText.push("*Open Positions Breakdown:*");
    status.positions.slice(0, 8).forEach((p) => {
      const posSign = p.unrealized_pnl >= 0 ? "+" : "";
      statusText.push(`  ▪ ${p.product_symbol} (${p.size}): \`${posSign}$${p.unrealized_pnl.toFixed(2)}\``);
    });
    if (status.positionsCount > 8) {
      statusText.push(`  ▪ ... and ${status.positionsCount - 8} more positions`);
    }
  } else {
    statusText.push("ℹ️ No open margined positions currently active.");
  }

  statusText.push("\nSelect an action below:");
  const text = statusText.join("\n");
  const keyboard = mainKeyboard(state);

  try {
    if (editInsteadOfReply && ctx.callbackQuery?.message) {
      return await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        ...keyboard,
      });
    } else {
      return await ctx.reply(text, {
        parse_mode: "Markdown",
        ...keyboard,
      });
    }
  } catch (err) {
    return await ctx.reply(text, {
      parse_mode: "Markdown",
      ...keyboard,
    });
  }
}

// Commands
bot.start(async (ctx) => {
  waitingForCustomLimit[ctx.from.id] = false;
  return renderDashboard(ctx);
});

bot.command(["menu", "dashboard"], async (ctx) => {
  waitingForCustomLimit[ctx.from.id] = false;
  return renderDashboard(ctx);
});

bot.command("status", async (ctx) => {
  const status = await getSmartSLStatus();
  const state = await loadState();

  let lines = [
    "📊 *LIVE DELTA ACCOUNT STATUS*",
    `Protection: ${state.enabled ? "🟢 ENABLED" : "🔴 DISABLED"}`,
    `Stop Loss: -$${state.lossLimit}`,
    `Mode: ${state.dryRun ? "🧪 DRY-RUN" : "⚡ LIVE"}`,
    `Total Unrealised PnL: \`$${status.totalPnl.toFixed(2)}\``,
    `Open Positions: ${status.positionsCount}`,
    `Engine: \`${status.engine}\``,
    "",
  ];

  if (status.positionsCount > 0) {
    lines.push("*Positions:*");
    status.positions.forEach((p) => {
      lines.push(`• ${p.product_symbol}: Size ${p.size} | Mark: ${p.mark_price} | PnL: $${p.unrealized_pnl.toFixed(2)}`);
    });
  } else {
    lines.push("No open positions.");
  }

  return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

bot.command("sl", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  if (args.length === 0) {
    return ctx.reply("Usage: `/sl <amount>` (e.g. `/sl 15` sets max loss to $15)", { parse_mode: "Markdown" });
  }

  const val = parseFloat(args[0]);
  if (!Number.isFinite(val) || val <= 0 || val > 100000) {
    return ctx.reply("❌ Invalid amount. Enter a positive number between 1 and 100000.");
  }

  const state = await loadState();
  state.lossLimit = val;
  await saveState(state);

  return ctx.reply(`✅ Smart SL limit updated to *-$${val.toFixed(2)}*`, {
    parse_mode: "Markdown",
  });
});

bot.command("enable", async (ctx) => {
  const state = await loadState();
  state.enabled = true;
  await saveState(state);
  return ctx.reply("🛡 Smart SL Protection has been *ENABLED*.", { parse_mode: "Markdown" });
});

bot.command("disable", async (ctx) => {
  const state = await loadState();
  state.enabled = false;
  await saveState(state);
  return ctx.reply("⛔ Smart SL Protection has been *DISABLED*.", { parse_mode: "Markdown" });
});

bot.command("reset", async (ctx) => {
  resetTrigger();
  return ctx.reply("🔄 Trigger lock reset! Protection is re-armed.");
});

bot.command("dryrun", async (ctx) => {
  const state = await loadState();
  state.dryRun = !state.dryRun;
  process.env.SMART_SL_DRY_RUN = String(state.dryRun);
  await saveState(state);
  return ctx.reply(`Trading mode switched to: *${state.dryRun ? "🧪 DRY-RUN (Simulation)" : "⚡ LIVE REAL TRADING"}*`, {
    parse_mode: "Markdown",
  });
});

// Callbacks
bot.action("home", async (ctx) => {
  await ctx.answerCbQuery();
  waitingForCustomLimit[ctx.from.id] = false;
  return renderDashboard(ctx, true);
});

bot.action("enable", async (ctx) => {
  const state = await loadState();
  if (!state.lossLimit || state.lossLimit <= 0) {
    await ctx.answerCbQuery("⚠️ Set a Stop-Loss value first!");
    return ctx.reply(
      "❌ *CONFIGURATION ERROR: Cannot enable protection without a Stop-Loss value!*\n\nPlease reply with a number (e.g. `15` or `25`) or choose a preset below to activate protection:",
      { parse_mode: "Markdown", ...presetKeyboard() }
    );
  }
  state.enabled = true;
  await saveState(state);
  await ctx.answerCbQuery("🛡 Smart SL Enabled");
  return renderDashboard(ctx, true);
});

bot.action("disable", async (ctx) => {
  const state = await loadState();
  state.enabled = false;
  await saveState(state);
  await ctx.answerCbQuery("⛔ Smart SL Disabled");
  return renderDashboard(ctx, true);
});

bot.action("toggle_dryrun", async (ctx) => {
  const state = await loadState();
  state.dryRun = !state.dryRun;
  process.env.SMART_SL_DRY_RUN = String(state.dryRun);
  await saveState(state);
  await ctx.answerCbQuery(`Switched to ${state.dryRun ? "Simulation" : "LIVE"}`);
  return renderDashboard(ctx, true);
});

bot.action("status", async (ctx) => {
  await ctx.answerCbQuery("Refreshing status...");
  return renderDashboard(ctx, true);
});

bot.action("reset_trigger", async (ctx) => {
  resetTrigger();
  await ctx.answerCbQuery("🔄 Trigger lock reset");
  return renderDashboard(ctx, true);
});

bot.action("change_sl", async (ctx) => {
  await ctx.answerCbQuery();
  const state = await loadState();
  const currentMsg = state.lossLimit ? `Current Limit: *-$${state.lossLimit.toFixed(2)}*` : `Current Limit: *❌ NOT SET*`;
  return ctx.editMessageText(
    `💰 *Set Smart Stop Loss Threshold*\n\n${currentMsg}\n\nWhen overall unrealised loss reaches this value, all positions are automatically closed.\n\nChoose a preset below or simply type a number in this chat:`,
    {
      parse_mode: "Markdown",
      ...presetKeyboard(),
    }
  );
});

bot.action(/^limit:(\d+(?:\.\d+)?)$/, async (ctx) => {
  const newLimit = parseFloat(ctx.match[1]);
  if (!Number.isFinite(newLimit) || newLimit <= 0) {
    return ctx.answerCbQuery("Invalid threshold");
  }

  const state = await loadState();
  state.lossLimit = newLimit;
  state.enabled = true; // Auto-activate once configured
  await saveState(state);
  resetTrigger();

  await ctx.answerCbQuery(`Updated to -$${newLimit}`);
  await ctx.reply(`✅ *Smart Stop-Loss set to -$${newLimit.toFixed(2)}!*\n\n🛡 Protection is now *ACTIVE* and using this value.`, { parse_mode: "Markdown" });
  return renderDashboard(ctx, false);
});

bot.action("custom_sl", async (ctx) => {
  await ctx.answerCbQuery();
  waitingForCustomLimit[ctx.from.id] = true;
  return ctx.reply(
    "✏️ *Enter Custom Stop Loss Amount in USD*\n\nSimply reply with your value (e.g. `15` or `30.5`):",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Cancel", "home")]]),
    }
  );
});

bot.action("emergency_close", async (ctx) => {
  await ctx.answerCbQuery();
  pendingEmergency[ctx.from.id] = true;

  const confirmationKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🚨 YES, CLOSE ALL POSITIONS NOW", "confirm_emergency")],
    [Markup.button.callback("❌ Cancel", "home")],
  ]);

  return ctx.reply(
    "🚨 *EMERGENCY CLOSE CONFIRMATION*\n\nAre you sure you want to close ALL open positions across Delta Exchange at market price?",
    {
      parse_mode: "Markdown",
      ...confirmationKeyboard,
    }
  );
});

bot.action("confirm_emergency", async (ctx) => {
  if (!pendingEmergency[ctx.from.id]) {
    await ctx.answerCbQuery("No pending emergency request.");
    return renderDashboard(ctx);
  }

  pendingEmergency[ctx.from.id] = false;
  await ctx.answerCbQuery("Submitting emergency close orders...");

  await ctx.reply("⏳ Sending Emergency Close-All request to Delta Exchange...");

  try {
    const res = await closeAllPositions();
    let msg = `✅ *Emergency Close Request Completed*\n\nResult: \`${res.message || "Submitted"}\``;
    if (res.skipped && res.skipped.length > 0) {
      msg += `\n⚠️ Skipped products: \`${JSON.stringify(res.skipped)}\``;
    }
    await ctx.reply(msg, { parse_mode: "Markdown" });
  } catch (err) {
    await ctx.reply(`❌ *Emergency Close Failed:* \`${err.message}\``, {
      parse_mode: "Markdown",
    });
  }

  return renderDashboard(ctx);
});

// Handle conversation text input
bot.on("text", async (ctx) => {
  const rawText = ctx.message.text.trim();

  // 1. Check if user typed any number or Stop-Loss phrasing
  // Matches: "15", "$25", "15.5", "sl 20", "set sl 25", "sl=15", "stoploss 30", "-15", etc.
  const numMatch = rawText.match(/(?:(?:set\s+)?(?:smart\s*)?sl\s*[:=]?\s*|\$)?-?(\d+(?:\.\d+)?)\s*\$?$/i);

  if (numMatch && numMatch[1]) {
    const parsed = parseFloat(numMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 100000) {
      waitingForCustomLimit[ctx.from.id] = false;
      const state = await loadState();
      state.lossLimit = parsed;
      state.enabled = true; // Auto-activate protection once a valid value is provided
      await saveState(state);
      resetTrigger(); // Clear any previous trigger

      await ctx.reply(
        `✅ *Smart Stop-Loss value set to -$${parsed.toFixed(2)}!*\n\n` +
        `🛡 Protection is now *ACTIVE* and using this value.\n` +
        `If total account unrealised losses reach -$${parsed.toFixed(2)}, all positions will be automatically closed.`,
        { parse_mode: "Markdown" }
      );

      return renderDashboard(ctx);
    }
  }

  // 2. If user was explicitly prompted for custom limit but sent invalid input
  if (waitingForCustomLimit[ctx.from.id]) {
    return ctx.reply("❌ Invalid value. Please reply with a positive number, e.g. `15` or `25`.", {
      parse_mode: "Markdown",
    });
  }

  // 3. Quick text shortcuts
  const lower = rawText.toLowerCase();
  if (lower === "status" || lower === "pnl") {
    return renderDashboard(ctx);
  }

  // 4. If Stop-Loss is NOT configured, alert the user with an explicit error!
  const state = await loadState();
  if (!state.lossLimit) {
    return ctx.reply(
      "❌ *CONFIGURATION ERROR: Stop-Loss value is NOT set!*\n\n" +
      "The Smart Stop-Loss engine cannot protect your account until a limit is specified.\n\n" +
      "👉 *Please reply with a number (e.g. `15` or `25`) or choose a preset below to activate protection:*",
      {
        parse_mode: "Markdown",
        ...presetKeyboard(),
      }
    );
  }

  return renderDashboard(ctx);
});

// Dispatch notifications to the authorized user
async function sendTelegramAlert(messageText, extraOptions = null) {
  if (!AUTHORIZED_ID) return;
  const ids = AUTHORIZED_ID.split(",").map((id) => id.trim());

  for (const chatId of ids) {
    try {
      await bot.telegram.sendMessage(chatId, messageText, {
        parse_mode: "Markdown",
        ...(extraOptions || {}),
      });
    } catch (err) {
      console.error(`Failed to send alert to Telegram Chat ID ${chatId}:`, err.message);
    }
  }
}

// Push error alert when Smart SL engine detects missing Stop Loss configuration
slEvents.on("missing_limit", async () => {
  const alertMsg = [
    "🚨 *[SMART STOP-LOSS CONFIGURATION ERROR]*",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "❌ *No Stop-Loss limit is currently configured!*",
    "The monitoring engine is *PAUSED* and cannot protect positions until a value is set.",
    "",
    "👉 *Reply directly with a number (e.g. `15` or `25`) or tap a preset button below to activate protection immediately:*",
    "━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n");

  await sendTelegramAlert(alertMsg, presetKeyboard());
});

// Hook into Smart SL engine events
slEvents.on("triggered", async (evt) => {
  const alertMsg = [
    "🚨 *[SMART STOP-LOSS TRIGGERED]* 🚨",
    "━━━━━━━━━━━━━━━━━━━━━━",
    `• *Breach PnL:* -$${Math.abs(evt.totalPnl).toFixed(2)}`,
    `• *Threshold Limit:* -$${evt.lossLimit.toFixed(2)}`,
    `• *Mode:* ${evt.simulation ? "🧪 SIMULATION (No orders placed)" : "⚡ LIVE EXECUTION"}`,
    `• *Action:* ${evt.message || "Close-all executed"}`,
    `• *Time:* ${new Date().toLocaleString()}`,
    "━━━━━━━━━━━━━━━━━━━━━━",
    "To re-arm the protection for future positions, click *🔄 Re-arm / Reset* in the bot menu.",
  ].join("\n");

  await sendTelegramAlert(alertMsg);
});

slEvents.on("error", async (errEvt) => {
  const errMsg = [
    "⚠️ *[SMART SL SYSTEM ALERT]*",
    `Action: \`${errEvt.action}\``,
    `Error: \`${errEvt.error}\``,
    `Time: ${new Date().toLocaleTimeString()}`,
  ].join("\n");

  await sendTelegramAlert(errMsg);
});

// Bot startup function
async function startBot() {
  if (!BOT_TOKEN || BOT_TOKEN === "PLACEHOLDER_TOKEN") {
    console.warn("[TELEGRAM BOT] No valid TELEGRAM_BOT_TOKEN provided. Skipping bot startup.");
    return;
  }

  console.log("[TELEGRAM BOT] Connecting to Telegram...");
  await bot.launch();
  console.log("[TELEGRAM BOT] Bot is online and listening for commands!");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

if (require.main === module) {
  startBot().catch((err) => {
    console.error("[TELEGRAM BOT LAUNCH ERROR]:", err);
  });
}

module.exports = {
  bot,
  startBot,
  sendTelegramAlert,
};
