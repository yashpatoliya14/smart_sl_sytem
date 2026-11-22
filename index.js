require("dotenv").config();
const { startMonitorLoop, stopMonitorLoop } = require("./smart-sl");
const { startBot, bot } = require("./telegram-bot");

async function main() {
  console.log("==================================================");
  console.log("   DELTA EXCHANGE SMART STOP-LOSS (SL) SYSTEM     ");
  console.log("   with Telegram Bot Integration & Live Alerts    ");
  console.log("==================================================");

  // 1. Start the Delta Exchange monitoring loop
  startMonitorLoop();

  // 2. Start the Telegram Bot if configured
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== "PLACEHOLDER_TOKEN") {
    try {
      await startBot();
    } catch (err) {
      console.error("[ERROR] Failed to launch Telegram Bot:", err.message);
      console.log("The Smart SL monitor engine will continue running independently.");
    }
  } else {
    console.log("ℹ️  TELEGRAM_BOT_TOKEN is not set. Running monitor engine only.");
    console.log("   To enable Telegram management, add your bot token in .env");
  }

  // Graceful shutdown handling
  const shutdown = () => {
    console.log("\n[SYSTEM] Gracefully shutting down Delta Smart SL System...");
    stopMonitorLoop();
    try {
      bot.stop("SIGINT");
    } catch {}
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[FATAL ERROR]:", err);
  process.exit(1);
});
