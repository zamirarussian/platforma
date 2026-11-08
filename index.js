// Koreys tili platformasi: Telegram bot + Mini App (bitta Railway servisi)
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Bot, InlineKeyboard } = require("grammy");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("BOT_TOKEN topilmadi. Railway > Variables bo'limiga BOT_TOKEN qo'shing.");
  process.exit(1);
}

// Platforma manzili: WEBAPP_URL berilsa shuni, bo'lmasa Railway domenini oladi
const DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
const WEBAPP_URL = process.env.WEBAPP_URL || (DOMAIN ? `https://${DOMAIN}` : "");
const PORT = process.env.PORT || 3000;
// So'rovnoma javoblari yuboriladigan chat (sizning ID yoki guruh ID). Botga /myid yozib bilib olasiz.
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// ---------- Mini App (sayt) ----------
const app = express();
app.use(express.static(path.join(__dirname, "public"), { maxAge: "5m" }));
app.use(express.json({ limit: "20kb" }));
app.get("/health", (_req, res) => res.send("ok"));

// Telegram initData imzosini tekshirish (soxta so'rovlardan himoya)
function checkInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
    const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
    if (calc !== hash) return null;
    return JSON.parse(params.get("user") || "null");
  } catch (e) {
    return null;
  }
}

const esc = (t) => String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

app.post("/api/onboarding", async (req, res) => {
  const user = checkInitData(req.body && req.body.initData);
  if (!user) return res.status(403).json({ ok: false });
  const a = (req.body && req.body.answers) || {};
  res.json({ ok: true });
  if (!ADMIN_CHAT_ID) return;
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const who = user.username ? `@${esc(user.username)}` : `<a href="tg://user?id=${user.id}">profil</a>`;
  const text =
    `🆕 <b>Yangi o'quvchi</b>\n` +
    `👤 ${esc(name)} (${who})\n` +
    `🎂 Yosh: ${esc(a.age)}\n` +
    `🎯 Maqsad: ${esc(a.goal)}\n` +
    `📊 Daraja: ${esc(a.lvl)}\n` +
    `😓 Qiyinchilik: ${esc((a.prob || []).join(", "))}`;
  bot.api.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: "HTML" }).catch((e) => console.error("Adminga yuborilmadi:", e.description || e));
});
app.listen(PORT, () => console.log(`Platforma ${PORT}-portda ishlayapti. Manzil: ${WEBAPP_URL || "(domen hali yo'q)"}`));

// ---------- Bot ----------
const bot = new Bot(TOKEN);

const openKb = () => new InlineKeyboard().webApp("📚 Platformani ochish", WEBAPP_URL);

bot.command("start", async (ctx) => {
  const name = ctx.from?.first_name || "";
  if (!WEBAPP_URL) {
    return ctx.reply("Platforma hali sozlanmagan. Birozdan keyin qayta urinib ko'ring.");
  }
  await ctx.reply(
    `Salom${name ? ", " + name : ""}! 🇰🇷\n\n` +
      "Bu yerda koreys tilining eng kerakli 100 ta fe'li va 100 ta iborasini o'rganasiz.\n\n" +
      "• Kuniga 5 tadan so'z\n• Mashqlar va ball\n• Reytingda boshqalar bilan bellashuv\n\n" +
      "Boshlash uchun pastdagi tugmani bosing 👇",
    { reply_markup: openKb() }
  );
});

bot.command("myid", (ctx) => ctx.reply(`Bu chat ID: ${ctx.chat.id}\nShu raqamni Railway'da ADMIN_CHAT_ID ga yozing.`));

bot.command("help", (ctx) =>
  ctx.reply("Platformani ochish uchun /start bosing yoki pastdagi «Ochish» tugmasidan foydalaning.", {
    reply_markup: WEBAPP_URL ? openKb() : undefined,
  })
);

bot.on("message", (ctx) =>
  ctx.reply("Darslarni boshlash uchun tugmani bosing 👇", { reply_markup: WEBAPP_URL ? openKb() : undefined })
);

bot.catch((err) => console.error("Bot xatosi:", err.error || err));

(async () => {
  // Chat pastidagi doimiy «Ochish» tugmasi
  if (WEBAPP_URL) {
    await bot.api
      .setChatMenuButton({ menu_button: { type: "web_app", text: "Ochish", web_app: { url: WEBAPP_URL } } })
      .catch((e) => console.error("Menu tugmasi o'rnatilmadi:", e.description || e));
  }
  await bot.api.setMyCommands([
    { command: "start", description: "Platformani ochish" },
    { command: "help", description: "Yordam" },
  ]).catch((e) => console.error("Buyruqlar o'rnatilmadi:", e.description || e));
  bot.start({ drop_pending_updates: true, onStart: (me) => console.log(`Bot ishga tushdi: @${me.username}`) });
})();

process.once("SIGTERM", () => bot.stop());
process.once("SIGINT", () => bot.stop());
