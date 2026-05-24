// ═══════════════════════════════════════════════════════════════════════════
// TradeIQ AI — Telegram Bot
// Deploy on: Railway · Render · Fly.io · any Node.js host (free tier works!)
//
// SETUP (5 minutes):
// 1. Message @BotFather on Telegram → /newbot → copy TOKEN
// 2. Set env vars below
// 3. npm install && node bot.js
// 4. No webhook needed — uses long polling (works on free hosting)
//
// COMMANDS TO REGISTER WITH BOTFATHER:
// start - Welcome & intro
// help - All commands
// stats - Your P&L summary
// today - Today's trades
// analyze - Full AI coaching report
// chart - Equity curve as ASCII
// undo - Remove last trade
// hindi - Switch to Hindi
// english - Switch to English
// reset - Clear all trades (with confirmation)
// ═══════════════════════════════════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import Anthropic from "@anthropic-ai/sdk";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN  || "your_bot_token_from_botfather";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY   || "your_anthropic_key";

const bot       = new TelegramBot(BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ─── IN-MEMORY STORE (use Redis/Postgres in production) ──────────────────────
const userStore = new Map(); // chatId → { lang, trades[], name }

function getUser(chatId, name = "") {
  if (!userStore.has(chatId)) {
    userStore.set(chatId, { chatId, name, lang: "en", trades: [], pendingReset: false });
  }
  const u = userStore.get(chatId);
  if (name && !u.name) u.name = name;
  return u;
}

// ─── STRINGS ─────────────────────────────────────────────────────────────────
const STR = {
  en: {
    welcome: (name) => `👋 Welcome${name ? `, ${name}` : ""}! I'm *TradeIQ AI* — your NSE/BSE trading coach.\n\n📊 Just describe a trade and I'll log it:\n_"Bought 100 Reliance at 2820, sold 2847"_\n_"Shorted Infy 200 qty entry 1490 exit 1456"_\n\n🧠 I'll analyze your patterns, track emotions, and tell you exactly why you're losing money.\n\nType /help for all commands.`,
    help: `📖 *TradeIQ AI Commands*\n\n*Log a trade* — type naturally:\n• "Bought 100 Reliance at 2820, sold 2847"\n• "Shorted Infy 200 entry 1490 exit 1456"\n\n📊 /stats — P\\&L summary\n🧠 /analyze — Full AI coaching\n🗓 /today — Today's trades\n📈 /chart — Equity curve\n🔁 /undo — Remove last trade\n🗑 /reset — Clear all trades\n🇮🇳 /hindi — Switch to Hindi\n❓ /help — This menu`,
    parsed: (t) => `✅ *Trade Logged!*\n\n*${t.stock}* ${t.type === "LONG" ? "🟢 LONG" : "🔴 SHORT"}\nEntry: ₹${t.entry} → Exit: ₹${t.exit}\nQty: ${t.qty} | Strategy: ${t.strategy}\nEmotion: ${t.emotion}\n\n*P\\&L: ${t.pnl >= 0 ? "+" : ""}₹${Math.abs(t.pnl).toLocaleString("en-IN")} ${t.pnl >= 0 ? "🟢" : "🔴"}*\n\n_/stats for full performance_`,
    parseError: `❌ Couldn't understand that as a trade.\n\nTry:\n_"Bought 100 Reliance at 2820, sold 2847"_\nor type /help for commands.`,
    noTrades: "📭 No trades yet. Tell me about your first trade!",
    stats: (u) => {
      if (!u.trades.length) return STR.en.noTrades;
      const w = u.trades.filter(t=>t.pnl>0), l = u.trades.filter(t=>t.pnl<0);
      const total = u.trades.reduce((a,t)=>a+t.pnl,0);
      const wr = Math.round(w.length/u.trades.length*100);
      const avgW = w.length ? Math.round(w.reduce((a,t)=>a+t.pnl,0)/w.length) : 0;
      const avgL = l.length ? Math.round(l.reduce((a,t)=>a+t.pnl,0)/l.length) : 0;
      const pf = l.length && avgL ? Math.abs(avgW*w.length/(avgL*l.length)).toFixed(2) : "∞";
      return `📊 *Performance Summary*\n\n💰 Net P\\&L: *${total>=0?"+":""}₹${Math.abs(total).toLocaleString("en-IN")}* ${total>=0?"🟢":"🔴"}\n🎯 Win Rate: *${wr}%* \\(${w.length}W/${l.length}L\\)\n⚡ Profit Factor: *${pf}*\n📈 Avg Win: \\+₹${avgW.toLocaleString("en-IN")}\n📉 Avg Loss: \\-₹${Math.abs(avgL).toLocaleString("en-IN")}\n📋 Total Trades: ${u.trades.length}\n\n_/analyze for AI coaching_`;
    },
    today: (u) => {
      const day = new Date().toISOString().slice(0,10);
      const t = u.trades.filter(x=>x.date===day);
      if (!t.length) return `📭 No trades logged today \\(${day}\\)\\.`;
      const total = t.reduce((a,x)=>a+x.pnl,0);
      const lines = t.map(x=>`${x.pnl>=0?"🟢":"🔴"} *${x.stock}* ${x.type} — ₹${Math.abs(x.pnl).toLocaleString("en-IN")}`).join("\n");
      return `🗓 *Today \\(${day}\\)*\n\n${lines}\n\n*Day P\\&L: ${total>=0?"+":""}₹${Math.abs(total).toLocaleString("en-IN")}*`;
    },
    chart: (u) => {
      if (!u.trades.length) return STR.en.noTrades;
      const eq = u.trades.slice().reverse().reduce((acc,t,i)=>{
        acc.push((acc[i-1]||0) + t.pnl);
        return acc;
      },[]);
      const max=Math.max(...eq), min=Math.min(...eq,0);
      const range=max-min||1, H=8;
      const cols = eq.map(v=>Math.round((v-min)/range*(H-1)));
      let chart = "```\n📈 Equity Curve\n\n";
      for(let row=H-1;row>=0;row--){
        const label = row===H-1?`+₹${(max/1000).toFixed(0)}K`:row===0?`₹${(min/1000).toFixed(0)}K`:"     ";
        chart += (label.padStart(6)) + " │ ";
        chart += cols.map(c=>c>=row?"█":"·").join("") + "\n";
      }
      chart += "       └" + "─".repeat(eq.length+2) + "\n```";
      return chart;
    },
    analyzing: "🧠 Analyzing your trades\\.\\.\\. \\(~10 seconds\\)",
    undo: (t) => `🔁 Removed: *${t.stock}* ${t.type} \\(${t.pnl>=0?"+":""}₹${t.pnl.toLocaleString("en-IN")}\\)`,
    noUndo: "Nothing to undo.",
    resetConfirm: "⚠️ This will delete ALL your trades. Send /reset again to confirm.",
    resetDone: "🗑 All trades cleared.",
    langSwitch: "🇮🇳 Switched to *Hindi*\\. Type /english to switch back\\.",
  },

  hi: {
    welcome: (name) => `👋 नमस्ते${name ? `, ${name}` : ""}! मैं *TradeIQ AI* हूँ — आपका NSE/BSE ट्रेडिंग कोच।\n\n📊 ट्रेड बताएं, मैं लॉग करूँगा:\n_"100 रिलायंस 2820 पर खरीदा, 2847 पर बेचा"_\n\n🧠 मैं आपकी गलतियाँ पहचानूँगा और हिंदी में समझाऊँगा।\n\n/help लिखें।`,
    help: `📖 *TradeIQ AI कमांड*\n\n*ट्रेड लॉग करें* — सामान्य भाषा में:\n• "100 रिलायंस 2820 पर खरीदा"\n• "SBIN 500 शेयर 790 entry 782 exit"\n\n📊 /stats — P\\&L सारांश\n🧠 /analyze — AI कोचिंग\n🗓 /today — आज के ट्रेड\n📈 /chart — इक्विटी कर्व\n🔁 /undo — आखिरी ट्रेड हटाएं\n🇬🇧 /english — English में जाएं`,
    parsed: (t) => `✅ *ट्रेड लॉग हो गया\\!*\n\n*${t.stock}* ${t.type === "LONG" ? "🟢 खरीद" : "🔴 बिक्री"}\nखरीद: ₹${t.entry} → बिक्री: ₹${t.exit}\nमात्रा: ${t.qty}\n\n*P\\&L: ${t.pnl >= 0 ? "+" : ""}₹${Math.abs(t.pnl).toLocaleString("en-IN")} ${t.pnl >= 0 ? "🟢" : "🔴"}*`,
    parseError: `❌ ट्रेड नहीं पहचाना।\n\nऐसे लिखें:\n_"100 रिलायंस 2820 पर खरीदा, 2847 पर बेचा"_`,
    noTrades: "📭 अभी कोई ट्रेड नहीं। पहला ट्रेड बताएं!",
    stats: (u) => {
      if (!u.trades.length) return STR.hi.noTrades;
      const w = u.trades.filter(t=>t.pnl>0), l = u.trades.filter(t=>t.pnl<0);
      const total = u.trades.reduce((a,t)=>a+t.pnl,0);
      const wr = Math.round(w.length/u.trades.length*100);
      return `📊 *आपका प्रदर्शन*\n\n💰 कुल P\\&L: *${total>=0?"+":""}₹${Math.abs(total).toLocaleString("en-IN")}* ${total>=0?"🟢":"🔴"}\n🎯 जीत दर: *${wr}%* \\(${w.length} जीत / ${l.length} हार\\)\n📋 कुल ट्रेड: ${u.trades.length}`;
    },
    today: (u) => {
      const day = new Date().toISOString().slice(0,10);
      const t = u.trades.filter(x=>x.date===day);
      if (!t.length) return `📭 आज कोई ट्रेड नहीं \\(${day}\\)\\.`;
      const total = t.reduce((a,x)=>a+x.pnl,0);
      return `🗓 *आज के ट्रेड*\n\n${t.map(x=>`${x.pnl>=0?"🟢":"🔴"} *${x.stock}* — ₹${Math.abs(x.pnl).toLocaleString("en-IN")}`).join("\n")}\n\n*दिन का P\\&L: ${total>=0?"+":""}₹${Math.abs(total).toLocaleString("en-IN")}*`;
    },
    chart: (u) => STR.en.chart(u),
    analyzing: "🧠 ट्रेड का विश्लेषण हो रहा है\\.\\.\\. \\(~10 सेकंड\\)",
    undo: (t) => `🔁 हटाया: *${t.stock}* \\(${t.pnl>=0?"+":""}₹${t.pnl.toLocaleString("en-IN")}\\)`,
    noUndo: "हटाने के लिए कुछ नहीं।",
    resetConfirm: "⚠️ सभी ट्रेड हट जाएंगे। दोबारा /reset भेजें।",
    resetDone: "🗑 सभी ट्रेड साफ हो गए।",
    langSwitch: "🇬🇧 English में बदल दिया। /hindi लिखें वापस जाने के लिए।",
  }
};

// ─── TRADE PARSER ─────────────────────────────────────────────────────────────
function computePnL(t) {
  const e=parseFloat(t.entry),x=parseFloat(t.exit),q=parseInt(t.qty||1);
  if(!e||!x||!q) return 0;
  return t.type==="LONG"?(x-e)*q:(e-x)*q;
}

async function parseTrade(text, lang) {
  const isHindi = lang === "hi";
  const sys = isHindi
    ? `NSE/BSE ट्रेड पार्सर। हिंदी/English input को JSON में बदलें।
{"stock":"CAPS","type":"LONG/SHORT","entry":"num","exit":"num","qty":"num","strategy":"Breakout/Pullback/Momentum/Support-Resistance/News Based/Other","emotion":"Confident/FOMO/Anxious/Revenge/Disciplined/Greedy/Patient","notes":"1 line","parsed":true}
नहीं समझा: {"parsed":false} — सिर्फ JSON।`
    : `NSE/BSE trade parser. Convert natural language to JSON.
{"stock":"CAPS","type":"LONG/SHORT","entry":"num","exit":"num","qty":"num","strategy":"Breakout/Pullback/Momentum/Support/Resistance/News Based/Other","emotion":"Confident/FOMO/Anxious/Revenge/Disciplined/Greedy/Patient","notes":"1 line","parsed":true}
Not a trade: {"parsed":false} — ONLY JSON.`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 250,
    system: sys,
    messages: [{ role: "user", content: text }]
  });
  const raw = msg.content[0].text.trim().replace(/```json|```/g,"").trim();
  return JSON.parse(raw);
}

async function getAIAnalysis(user) {
  const isHindi = user.lang === "hi";
  const ctx = user.trades.map(t=>`${t.date}|${t.stock}|${t.type}|₹${t.entry}→₹${t.exit}|qty:${t.qty}|${t.strategy}|${t.emotion}|P&L:₹${t.pnl}`).join("\n");
  const sys = isHindi
    ? `TradeIQ AI — NSE/BSE कोच। हिंदी में जवाब दें। Telegram MarkdownV2 format। 200 शब्द।\nट्रेड:\n${ctx}`
    : `TradeIQ AI — NSE/BSE coach. Telegram MarkdownV2 format. 200 words max. Be specific.\nTrades:\n${ctx}`;
  const prompt = isHindi
    ? "मेरी सबसे बड़ी कमज़ोरी, सबसे अच्छी रणनीति, और 3 तुरंत सुधार बताओ।"
    : "My biggest weakness, best strategy by numbers, and top 3 immediate improvements.";
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001", max_tokens: 600,
    system: sys,
    messages: [{ role: "user", content: prompt }]
  });
  return msg.content[0].text;
}

// ─── SEND HELPER ──────────────────────────────────────────────────────────────
const send = (chatId, text, opts = {}) =>
  bot.sendMessage(chatId, text, { parse_mode: "MarkdownV2", ...opts }).catch(err => {
    // If MarkdownV2 fails, send plain
    bot.sendMessage(chatId, text.replace(/[*_\[\]()~`>#+\-=|{}.!\\]/g, "")).catch(console.error);
  });

// ─── COMMAND HANDLERS ─────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const user = getUser(msg.chat.id, msg.from.first_name);
  send(msg.chat.id, STR[user.lang].welcome(user.name));
});

bot.onText(/\/help/, (msg) => {
  const user = getUser(msg.chat.id);
  send(msg.chat.id, STR[user.lang].help);
});

bot.onText(/\/stats/, (msg) => {
  const user = getUser(msg.chat.id);
  send(msg.chat.id, STR[user.lang].stats(user));
});

bot.onText(/\/today/, (msg) => {
  const user = getUser(msg.chat.id);
  send(msg.chat.id, STR[user.lang].today(user));
});

bot.onText(/\/chart/, (msg) => {
  const user = getUser(msg.chat.id);
  send(msg.chat.id, STR[user.lang].chart(user));
});

bot.onText(/\/undo/, (msg) => {
  const user = getUser(msg.chat.id);
  if (!user.trades.length) return send(msg.chat.id, STR[user.lang].noUndo);
  const removed = user.trades.shift();
  send(msg.chat.id, STR[user.lang].undo(removed));
});

bot.onText(/\/hindi/, (msg) => {
  const user = getUser(msg.chat.id);
  user.lang = "hi";
  send(msg.chat.id, STR.en.langSwitch);
});

bot.onText(/\/english/, (msg) => {
  const user = getUser(msg.chat.id);
  user.lang = "en";
  send(msg.chat.id, STR.hi.langSwitch);
});

bot.onText(/\/reset/, (msg) => {
  const user = getUser(msg.chat.id);
  if (!user.pendingReset) {
    user.pendingReset = true;
    setTimeout(() => { user.pendingReset = false; }, 30000);
    return send(msg.chat.id, STR[user.lang].resetConfirm);
  }
  user.trades = [];
  user.pendingReset = false;
  send(msg.chat.id, STR[user.lang].resetDone);
});

bot.onText(/\/analyze/, async (msg) => {
  const user = getUser(msg.chat.id);
  if (!user.trades.length) return send(msg.chat.id, STR[user.lang].noTrades);
  await send(msg.chat.id, STR[user.lang].analyzing);
  try {
    const analysis = await getAIAnalysis(user);
    send(msg.chat.id, `🧠 *AI Analysis*\n\n${analysis}`);
  } catch {
    send(msg.chat.id, "❌ Analysis failed\\. Please try again\\.");
  }
});

// ─── TRADE MESSAGE HANDLER ────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const user = getUser(chatId, msg.from.first_name);
  const S = STR[user.lang];

  // Typing indicator
  bot.sendChatAction(chatId, "typing");

  try {
    const parsed = await parseTrade(msg.text, user.lang);
    if (parsed.parsed !== false && parsed.stock && parsed.entry && parsed.exit) {
      const pnl = computePnL(parsed);
      const trade = { ...parsed, id: Date.now(), pnl, date: new Date().toISOString().slice(0,10) };
      user.trades.unshift(trade);
      send(chatId, S.parsed(trade));
    } else {
      send(chatId, S.parseError);
    }
  } catch (err) {
    console.error("Parse error:", err);
    send(chatId, S.parseError);
  }
});

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────
bot.on("polling_error", (err) => console.error("Polling error:", err.message));

console.log(`
🤖 TradeIQ AI Telegram Bot started!
📱 Find your bot on Telegram and send /start

Environment variables needed:
  TELEGRAM_BOT_TOKEN  — From @BotFather
  ANTHROPIC_API_KEY   — Your Anthropic key

Commands supported:
  /start /help /stats /today /chart /analyze /undo /reset /hindi /english
  + Natural language trade logging in English & Hindi
`);

// package.json:
// {
//   "name": "tradeiq-telegram-bot",
//   "type": "module",
//   "scripts": { "start": "node bot.js" },
//   "dependencies": {
//     "node-telegram-bot-api": "^0.64.0",
//     "@anthropic-ai/sdk": "^0.20.0"
//   }
// }
