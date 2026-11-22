# 🛡 Delta Exchange Smart Stop-Loss (Smart SL) System

A robust **Global Unrealised PnL Stop-Loss System** for [Delta Exchange](https://www.delta.exchange) (supporting both **Delta India** and **Delta Global**) with interactive **Telegram Bot** control, real-time alerts, and one-click emergency exit.

---

## 📌 How It Works

Instead of placing separate stop-loss orders for each individual contract or position, this system calculates your **Account-Wide Total Unrealised PnL** across all active futures and options positions:

1. **Continuous Monitoring:** Polls `GET /v2/positions/margined` every second (configurable).
2. **Loss Threshold Trigger:** If your overall unrealised loss reaches your configured limit (e.g. `-$15`), the engine automatically triggers:
   - In **Live Mode (`SMART_SL_DRY_RUN=false`)**: Submits `POST /v2/positions/close_all` to close all open positions across portfolio and isolated margin.
   - In **Simulation Mode (`SMART_SL_DRY_RUN=true`)**: Logs the trigger event without submitting real market orders.
3. **One-Time Trigger Lock:** Prevents order spamming or race conditions once triggered.
4. **Instant Telegram Alerts:** Sends immediate push notification with breach metrics directly to your Telegram.
5. **Interactive Telegram Management:** Control your stop loss threshold, toggle protection ON/OFF, view live position breakdowns, switch between simulation and live modes, or trigger an emergency close anytime from your phone.

---

## 🚀 Features

- **Global Unrealised PnL Protection:** Protects your entire account balance from flash crashes and correlated drops.
- **Telegram Inline Bot Control:**
  - 🛡 **Smart SL ON / OFF**: Enable or disable protection in one tap.
  - 💰 **Change SL**: Quick preset buttons (`$5`, `$10`, `$15`, `$20`, `$25`, `$50`, `$100`) or input any custom USD amount.
  - 📊 **Live Status**: Real-time breakdown of open positions, mark prices, individual PnL, and total PnL.
  - 🧪 **Toggle Dry-Run**: Switch between test/simulation and live trading modes directly from Telegram.
  - 🔄 **Re-arm / Reset**: Re-enable monitoring after a stop-loss trigger event.
  - 🚨 **Emergency Close All**: Instant two-step confirmed market exit for all open positions.
- **Atomic State Persistence (`smart-sl-state.json`)**: Settings changed in Telegram immediately take effect in the monitoring engine without restarting.
- **Security & Authorization**: Rejects unauthorized Telegram users; only responds to your configured Telegram User ID.
- **Support for Delta India & Delta Global**: Works with `https://api.india.delta.exchange` and `https://api.delta.exchange`.
- **Pre-flight Diagnostic Tool (`npm test`)**: Validates API credentials, network latency, positions endpoint, and Telegram token before risking capital.

---

## 📁 Project Structure

```text
smart_sl_sytem/
├── .env                  # Your secret API keys and configuration
├── .env.example          # Template environment file
├── smart-sl-state.json   # Dynamic shared state (managed by Telegram & engine)
├── smart-sl.js           # Delta API client & Smart SL monitoring engine
├── telegram-bot.js       # Telegram bot with buttons, commands & push alerts
├── index.js              # Unified runner (runs engine + bot together)
├── test-connection.js    # Pre-flight diagnostic & test script
├── package.json          # Node.js project manifest & scripts
└── README.md             # Documentation
```

---

## ⚙️ Setup & Installation

### 1. Prerequisites
- **Node.js** v18+ (tested on Node v20/v24)
- Delta Exchange account (India or Global)
- Telegram account

### 2. Configure Environment Variables
Open the `.env` file in the project directory:

```env
# Delta Exchange API Credentials
DELTA_API_KEY=your_delta_api_key_here
DELTA_API_SECRET=your_delta_api_secret_here

# Base URL (India or Global)
# Delta India:  https://api.india.delta.exchange
# Delta Global: https://api.delta.exchange
DELTA_BASE_URL=https://api.india.delta.exchange

# Initial Smart Stop Loss limit in USD
SMART_SL_LIMIT=15

# Polling frequency in milliseconds (1000 = 1 sec)
SMART_SL_INTERVAL_MS=1000

# Simulation mode (true = test mode, false = live orders)
SMART_SL_DRY_RUN=true

# Telegram Bot Token (from @BotFather)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Your Telegram User/Chat ID (Numbers only, e.g. 123456789)
TELEGRAM_CHAT_ID=
```

#### How to get Telegram credentials:
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, choose a name and username, and copy the provided **HTTP API Token** into `TELEGRAM_BOT_TOKEN`.
3. If you do not know your **Telegram Chat ID**, leave `TELEGRAM_CHAT_ID` empty, start the bot, and send `/start` to your bot. The bot will automatically display your exact Chat ID so you can paste it into `.env`!

---

## 🧪 Pre-Flight Diagnostic Check

Before running the system, test your API keys and Telegram setup:

```bash
npm test
```

This verifies:
- Delta API key & secret authentication (`/v2/profile`).
- Open positions and PnL calculation (`/v2/positions/margined`).
- Telegram bot credentials & sends a test ping to your chat.

---

## 🏃 Running the System

### Option A: Run Both (Unified Engine + Telegram Bot) — *Recommended*
```bash
npm start
```
Runs the Smart SL monitoring engine and Telegram bot in a single process with real-time event-driven push alerts.

### Option B: Run Standalone Processes
- **Run Monitor Engine Only:**
  ```bash
  npm run monitor
  ```
- **Run Telegram Bot Only:**
  ```bash
  npm run bot
  ```

### Option C: Production Deployment with PM2 (24/7 VPS)
If deploying on a VPS (Linux/Windows) for continuous 24/7 background operation:
```bash
npm install -g pm2
pm2 start index.js --name delta-smart-sl
pm2 save
pm2 startup
```

---

## 📱 Telegram Commands & Controls

| Command | Action |
|---|---|
| `/menu` or `/start` | Opens interactive dashboard with inline buttons |
| `/status` | Displays live open positions and current unrealised PnL |
| `/sl <amount>` | Directly changes Stop-Loss limit (e.g. `/sl 25`) |
| `/enable` | Turns Smart SL protection ON |
| `/disable` | Turns Smart SL protection OFF |
| `/reset` | Re-arms the trigger lock after a stop-loss event |
| `/dryrun` | Toggles between Simulation (Dry-Run) and Live Trading |

---

## 🛡 Risk Management & Safety Measures

1. **Start with Dry-Run Mode:** Always test with `SMART_SL_DRY_RUN=true` to observe how PnL is tracked against your active positions.
2. **Options Positions:** Delta Exchange options contracts report `unrealized_pnl` as signed values. Verify that your options settlement currency aligns with your futures margin.
3. **Trigger Lock:** Once the loss limit is hit, the engine stops further checks to avoid flooding the exchange with redundant orders. Use the `/reset` command or Telegram button to re-arm.
4. **Exchange API Rate Limits:** The default `1000ms` polling rate is well within Delta Exchange REST rate limits (up to 10-30 req/sec).
