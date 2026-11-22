require("dotenv").config();
const { deltaRequest, getTotalUnrealisedPnl, CONFIG } = require("./smart-sl");
const { Telegraf } = require("telegraf");

async function runDiagnostics() {
  console.log("==================================================");
  console.log("    DELTA SMART SL SYSTEM - DIAGNOSTIC CHECK      ");
  console.log("==================================================\n");

  let allPassed = true;

  // 1. Check Delta Exchange configuration
  console.log("1. Checking Delta Exchange API Configuration...");
  console.log(`   Base URL: ${CONFIG.baseUrl}`);
  console.log(`   API Key:  ${CONFIG.apiKey ? CONFIG.apiKey.substring(0, 6) + "..." : "❌ NOT SET"}`);
  console.log(`   Secret:   ${CONFIG.apiSecret ? "********" : "❌ NOT SET"}`);

  if (!CONFIG.apiKey || !CONFIG.apiSecret) {
    console.log("   ❌ ERROR: Delta API credentials are missing in .env!\n");
    allPassed = false;
  } else {
    try {
      console.log("   🔄 Connecting to Delta Exchange API...");
      // Profile request test
      const profile = await deltaRequest("GET", "/v2/profile");
      console.log(`   ✅ Authentication Successful! User ID: ${profile?.result?.id || "OK"}, Email/Username: ${profile?.result?.email || profile?.result?.username || "Verified"}`);

      // Positions test
      console.log("   🔄 Fetching open margined positions...");
      const positionsData = await getTotalUnrealisedPnl();
      console.log(`   ✅ Positions API working!`);
      console.log(`      Open Positions: ${positionsData.positions.length}`);
      console.log(`      Total Unrealised PnL: $${positionsData.totalPnl.toFixed(4)}`);

      if (positionsData.positions.length > 0) {
        positionsData.positions.forEach((p, idx) => {
          console.log(`      [${idx + 1}] ${p.product_symbol}: Size ${p.size}, PnL: $${p.unrealized_pnl}`);
        });
      }
      console.log();
    } catch (err) {
      console.log(`   ❌ Delta Exchange API Error: ${err.message}\n`);
      allPassed = false;
    }
  }

  // 2. Check Telegram Bot configuration
  console.log("2. Checking Telegram Bot Configuration...");
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  console.log(`   Bot Token: ${botToken ? botToken.substring(0, 10) + "..." : "❌ NOT SET"}`);
  console.log(`   Chat ID:   ${chatId || "⚠️ NOT SET (Bot will tell you your ID when you message it)"}`);

  if (!botToken || botToken === "PLACEHOLDER_TOKEN") {
    console.log("   ⚠️ Telegram Bot Token is not configured. Telegram management will be inactive.\n");
  } else {
    try {
      console.log("   🔄 Verifying Telegram Bot Token with Telegram API...");
      const testBot = new Telegraf(botToken);
      const botInfo = await testBot.telegram.getMe();
      console.log(`   ✅ Bot Verified: @${botInfo.username} (${botInfo.first_name})`);

      if (chatId) {
        console.log(`   🔄 Sending test ping message to Chat ID ${chatId}...`);
        await testBot.telegram.sendMessage(
          chatId,
          "🛡 *Delta Smart SL System Diagnostic Test*\n\n✅ Your Delta Smart SL bot connection test succeeded!",
          { parse_mode: "Markdown" }
        );
        console.log("   ✅ Test message sent successfully to your Telegram!");
      }
      console.log();
    } catch (err) {
      console.log(`   ❌ Telegram Bot Error: ${err.message}\n`);
      allPassed = false;
    }
  }

  console.log("==================================================");
  if (allPassed) {
    console.log("🎉 All configured systems are operational!");
    console.log("   You can start the system with: npm start");
  } else {
    console.log("⚠️ Some checks failed. Please review the errors above and update your .env file.");
  }
  console.log("==================================================");
}

runDiagnostics().catch(console.error);
