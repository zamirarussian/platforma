// Koreys tili platformasi: Telegram bot + Mini App + Adminka (bitta Railway servisi)
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Pool } = require("pg");
const { Bot, InlineKeyboard, InputFile, GrammyError } = require("grammy");

// ================= Sozlamalar (Railway > Variables) =================
const TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // yangi o'quvchilar haqida xabar + sinov xabarlari shu chatga
const DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
const WEBAPP_URL = process.env.WEBAPP_URL || (DOMAIN ? `https://${DOMAIN}` : "");
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("s:" + (TOKEN || "")).digest("hex");
const NO_BOT = process.env.NO_BOT === "1"; // faqat sinov uchun

if (!TOKEN) { console.error("BOT_TOKEN topilmadi. Railway > Variables bo'limiga qo'shing."); process.exit(1); }
if (!DATABASE_URL) { console.error("DATABASE_URL topilmadi. Railway'da PostgreSQL qo'shing va DATABASE_URL ni ulang."); process.exit(1); }

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1|railway\.internal/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
});
const q = (text, params) => db.query(text, params);

// ================= Baza jadvallari =================
async function migrate() {
  await q(`
  CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,
    first_name TEXT, last_name TEXT, username TEXT, photo_url TEXT,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ,
    blocked BOOLEAN NOT NULL DEFAULT false,
    access BOOLEAN NOT NULL DEFAULT true,
    bot_stopped BOOLEAN NOT NULL DEFAULT false,
    age TEXT, goal TEXT, lvl TEXT, prob TEXT, onboarded_at TIMESTAMPTZ,
    learned_fel INT NOT NULL DEFAULT 0, learned_ibora INT NOT NULL DEFAULT 0,
    points_total INT NOT NULL DEFAULT 0, points_week INT NOT NULL DEFAULT 0, week_key TEXT,
    streak INT NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS staff (
    id SERIAL PRIMARY KEY, login TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer','editor','admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS broadcasts (
    id SERIAL PRIMARY KEY, created_by TEXT, segment TEXT, kind TEXT, text TEXT, file_id TEXT,
    total INT NOT NULL DEFAULT 0, sent INT NOT NULL DEFAULT 0, failed INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS funnels (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT 'onboard', segment TEXT NOT NULL DEFAULT 'all',
    enabled BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS funnel_steps (
    id SERIAL PRIMARY KEY, funnel_id INT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
    position INT NOT NULL, delay_minutes INT NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'text', text TEXT, file_id TEXT
  );
  CREATE TABLE IF NOT EXISTS funnel_runs (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, funnel_id INT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(), next_step INT NOT NULL DEFAULT 0, done BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, funnel_id)
  );
  `);
  // Egasi (siz): login va parol Railway o'zgaruvchilaridan olinadi, har ishga tushganda yangilanadi
  if (ADMIN_LOGIN && ADMIN_PASSWORD) {
    await q(
      `INSERT INTO staff(login, pass_hash, role) VALUES ($1,$2,'admin')
       ON CONFLICT (login) DO UPDATE SET pass_hash=EXCLUDED.pass_hash, role='admin'`,
      [ADMIN_LOGIN.trim().toLowerCase(), hashPass(ADMIN_PASSWORD)]
    );
  } else {
    console.warn("ADMIN_LOGIN va ADMIN_PASSWORD berilmagan: adminkaga kirib bo'lmaydi.");
  }
}

// ================= Yordamchilar =================
function hashPass(p) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(String(p), salt, 64).toString("hex");
}
function checkPass(p, stored) {
  const [salt, h] = String(stored).split(":");
  if (!salt || !h) return false;
  const calc = crypto.scryptSync(String(p), salt, 64);
  return crypto.timingSafeEqual(calc, Buffer.from(h, "hex"));
}
const weekKey = (d = new Date()) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
};
const esc = (t) => String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkInitData(initData) {
  try {
    const params = new URLSearchParams(initData || "");
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
    const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
    if (calc !== hash) return null;
    return JSON.parse(params.get("user") || "null");
  } catch (e) { return null; }
}

async function upsertUser(u) {
  if (!u || !u.id) return null;
  const r = await q(
    `INSERT INTO users(id, first_name, last_name, username, photo_url, last_seen)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (id) DO UPDATE SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
       username=EXCLUDED.username, photo_url=COALESCE(EXCLUDED.photo_url, users.photo_url), last_seen=now(), bot_stopped=false
     RETURNING *, (xmax = 0) AS inserted`,
    [u.id, u.first_name || null, u.last_name || null, u.username || null, u.photo_url || null]
  );
  return r.rows[0];
}

// ================= Segmentlar (voronka/auditoriya) =================
const GOALS = ["TOPIK I", "TOPIK II", "Koreyaga ishga borish", "Koreyada o'qish", "O'zim uchun, qiziqish"];
const SEGMENTS = [
  { id: "all", label: "Hammasi", where: "true" },
  { id: "active", label: "Faol (7 kun)", where: "last_seen > now() - interval '7 days'" },
  { id: "inactive", label: "Nofaol 7+ kun", where: "(last_seen IS NULL OR last_seen <= now() - interval '7 days')" },
  { id: "new", label: "Yangi kelganlar (7 kun)", where: "joined_at > now() - interval '7 days'" },
  { id: "no_onboard", label: "So'rovnomani to'ldirmagan", where: "onboarded_at IS NULL" },
  ...GOALS.map((g, i) => ({ id: "goal" + i, label: g, where: `goal = '${g.replace(/'/g, "''")}'` })),
];
const segWhere = (id) => (SEGMENTS.find((s) => s.id === id) || SEGMENTS[0]).where;
const REACHABLE = "NOT blocked AND NOT bot_stopped";

// ================= Bot =================
const bot = new Bot(TOKEN);
const openKb = () => new InlineKeyboard().webApp("📚 Platformani ochish", WEBAPP_URL);

// Bloklangan foydalanuvchiga bot javob bermaydi
bot.use(async (ctx, next) => {
  if (ctx.from && ctx.chat && ctx.chat.type === "private") {
    const r = await q("SELECT blocked FROM users WHERE id=$1", [ctx.from.id]).catch(() => ({ rows: [] }));
    if (r.rows[0] && r.rows[0].blocked) return;
  }
  return next();
});

bot.command("start", async (ctx) => {
  const row = await upsertUser(ctx.from);
  if (row && row.inserted) enrollFunnels(row.id, "start").catch(() => {});
  if (!WEBAPP_URL) return ctx.reply("Platforma hali sozlanmagan. Birozdan keyin qayta urinib ko'ring.");
  const name = ctx.from?.first_name || "";
  await ctx.reply(
    `Salom${name ? ", " + name : ""}! 🇰🇷\n\n` +
      "Bu yerda koreys tilining eng kerakli 100 ta fe'li va 100 ta iborasini o'rganasiz.\n\n" +
      "• Kuniga 5 tadan so'z\n• Mashqlar va ball\n• Reytingda boshqalar bilan bellashuv\n\n" +
      "Boshlash uchun pastdagi tugmani bosing 👇",
    { reply_markup: openKb() }
  );
});
bot.command("myid", (ctx) => ctx.reply(`Bu chat ID: ${ctx.chat.id}\nShu raqamni Railway'da ADMIN_CHAT_ID ga yozing.`));
bot.on("my_chat_member", async (ctx) => {
  const st = ctx.myChatMember.new_chat_member.status;
  if (ctx.chat.type === "private") await q("UPDATE users SET bot_stopped=$2 WHERE id=$1", [ctx.chat.id, st === "kicked"]).catch(() => {});
});
bot.on("message", (ctx) =>
  ctx.reply("Darslarni boshlash uchun tugmani bosing 👇", { reply_markup: WEBAPP_URL ? openKb() : undefined })
);
bot.catch((err) => console.error("Bot xatosi:", err.error || err));

// Bitta xabarni yuborish (matn / rasm / dumaloq video / ovozli / video)
async function sendContent(chatId, m, firstName) {
  const text = (m.text || "").replace(/\{ism\}/g, firstName || "do'stim").trim();
  const f = m.file_id;
  if (m.kind === "photo" && f) return bot.api.sendPhoto(chatId, f, text ? { caption: text } : {});
  if (m.kind === "voice" && f) return bot.api.sendVoice(chatId, f, text ? { caption: text } : {});
  if (m.kind === "video" && f) return bot.api.sendVideo(chatId, f, text ? { caption: text } : {});
  if (m.kind === "video_note" && f) {
    const r = await bot.api.sendVideoNote(chatId, f);
    if (text) await bot.api.sendMessage(chatId, text);
    return r;
  }
  if (!text) throw new Error("Xabar bo'sh");
  return bot.api.sendMessage(chatId, text);
}
// Telegram 403 = foydalanuvchi botni to'xtatgan
async function sendToUser(u, m) {
  try {
    await sendContent(u.id, m, u.first_name);
    return true;
  } catch (e) {
    if (e instanceof GrammyError && e.error_code === 429) {
      await sleep(((e.parameters && e.parameters.retry_after) || 3) * 1000);
      return sendToUser(u, m);
    }
    if (e instanceof GrammyError && e.error_code === 403) await q("UPDATE users SET bot_stopped=true WHERE id=$1", [u.id]).catch(() => {});
    return false;
  }
}

// ================= Ommaviy xabar (fonda, sekundiga ~20 ta) =================
let broadcastRunning = false;
async function runBroadcasts() {
  if (broadcastRunning) return;
  broadcastRunning = true;
  try {
    for (;;) {
      const r = await q("SELECT * FROM broadcasts WHERE status IN ('queued','running') ORDER BY id LIMIT 1");
      const b = r.rows[0];
      if (!b) break;
      const users = (await q(`SELECT id, first_name FROM users WHERE ${REACHABLE} AND ${segWhere(b.segment)} ORDER BY id`)).rows;
      await q("UPDATE broadcasts SET status='running', total=$2 WHERE id=$1", [b.id, users.length]);
      let sent = 0, failed = 0;
      const skip = b.sent + b.failed; // qayta ishga tushsa, davom ettiradi
      for (let i = skip; i < users.length; i++) {
        const st = (await q("SELECT status FROM broadcasts WHERE id=$1", [b.id])).rows[0];
        if (!st || st.status === "stopped") break;
        (await sendToUser(users[i], b)) ? sent++ : failed++;
        if ((sent + failed) % 10 === 0) await q("UPDATE broadcasts SET sent=sent+$2, failed=failed+$3 WHERE id=$1", [b.id, sent, failed]).then(() => { sent = 0; failed = 0; });
        await sleep(50);
      }
      await q(
        "UPDATE broadcasts SET sent=sent+$2, failed=failed+$3, status=CASE WHEN status='stopped' THEN 'stopped' ELSE 'done' END, finished_at=now() WHERE id=$1",
        [b.id, sent, failed]
      );
    }
  } catch (e) {
    console.error("Xabar yuborishda xato:", e);
  } finally {
    broadcastRunning = false;
  }
}

// ================= Voronkalar =================
async function enrollFunnels(userId, trigger) {
  const fs_ = (await q("SELECT * FROM funnels WHERE enabled AND trigger=$1", [trigger])).rows;
  for (const f of fs_) {
    const ok = (await q(`SELECT 1 FROM users WHERE id=$1 AND ${segWhere(f.segment)}`, [userId])).rows.length;
    if (ok) await q("INSERT INTO funnel_runs(user_id, funnel_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, f.id]);
  }
}
let funnelTick = false;
async function runFunnels() {
  if (funnelTick) return;
  funnelTick = true;
  try {
    const due = (
      await q(`
      SELECT r.user_id, r.funnel_id, r.next_step, u.first_name, s.kind, s.text, s.file_id,
             (SELECT count(*) FROM funnel_steps WHERE funnel_id=r.funnel_id) AS nsteps
      FROM funnel_runs r
      JOIN funnels f ON f.id=r.funnel_id AND f.enabled
      JOIN users u ON u.id=r.user_id AND NOT u.blocked AND NOT u.bot_stopped
      JOIN LATERAL (SELECT * FROM funnel_steps WHERE funnel_id=r.funnel_id ORDER BY position, id OFFSET r.next_step LIMIT 1) s ON true
      WHERE NOT r.done AND r.started_at + make_interval(mins => s.delay_minutes) <= now()
      LIMIT 200`)
    ).rows;
    for (const d of due) {
      await sendToUser({ id: d.user_id, first_name: d.first_name }, d);
      const next = d.next_step + 1;
      await q("UPDATE funnel_runs SET next_step=$3, done=$4 WHERE user_id=$1 AND funnel_id=$2", [d.user_id, d.funnel_id, next, next >= Number(d.nsteps)]);
      await sleep(50);
    }
    await q(`UPDATE funnel_runs r SET done=true WHERE NOT done AND next_step >= (SELECT count(*) FROM funnel_steps WHERE funnel_id=r.funnel_id)`);
  } catch (e) {
    console.error("Voronka xatosi:", e);
  } finally {
    funnelTick = false;
  }
}

// ================= Web server =================
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "200kb" }));
const fileAt = (n) => [path.join(__dirname, "public", n), path.join(__dirname, n)].find((f) => fs.existsSync(f));
app.get(["/", "/index.html"], (_req, res) => { const f = fileAt("index.html"); f ? res.sendFile(f) : res.status(404).send("index.html topilmadi"); });
app.get(["/admin", "/admin/"], (_req, res) => { const f = fileAt("admin.html"); f ? res.sendFile(f) : res.status(404).send("admin.html topilmadi"); });
app.get("/health", (_req, res) => res.send("ok"));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: "Serverda xato" }); });

// ---------- Mini App API ----------
const tgUser = (req) => checkInitData((req.body && req.body.initData) || req.get("X-Init-Data"));

app.post("/api/me", wrap(async (req, res) => {
  const u = tgUser(req);
  if (!u) return res.status(403).json({ ok: false });
  const row = await upsertUser(u);
  if (row.inserted) enrollFunnels(row.id, "start").catch(() => {});
  res.json({ ok: true, access: row.access && !row.blocked });
}));

app.post("/api/onboarding", wrap(async (req, res) => {
  const u = tgUser(req);
  if (!u) return res.status(403).json({ ok: false });
  const a = req.body.answers || {};
  await upsertUser(u);
  const prev = (await q("SELECT onboarded_at FROM users WHERE id=$1", [u.id])).rows[0];
  await q("UPDATE users SET age=$2, goal=$3, lvl=$4, prob=$5, onboarded_at=COALESCE(onboarded_at, now()) WHERE id=$1",
    [u.id, String(a.age || "").slice(0, 60), String(a.goal || "").slice(0, 60), String(a.lvl || "").slice(0, 60), (a.prob || []).join(", ").slice(0, 300)]);
  res.json({ ok: true });
  if (!prev || !prev.onboarded_at) {
    enrollFunnels(u.id, "onboard").catch(() => {});
    if (ADMIN_CHAT_ID && !NO_BOT) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
      const who = u.username ? `@${esc(u.username)}` : `<a href="tg://user?id=${u.id}">profil</a>`;
      bot.api.sendMessage(ADMIN_CHAT_ID,
        `🆕 <b>Yangi o'quvchi</b>\n👤 ${esc(name)} (${who})\n🎂 Yosh: ${esc(a.age)}\n🎯 Maqsad: ${esc(a.goal)}\n📊 Daraja: ${esc(a.lvl)}\n😓 Qiyinchilik: ${esc((a.prob || []).join(", "))}`,
        { parse_mode: "HTML" }).catch((e) => console.error("Adminga yuborilmadi:", e.description || e));
    }
  }
}));

app.post("/api/sync", wrap(async (req, res) => {
  const u = tgUser(req);
  if (!u) return res.status(403).json({ ok: false });
  const s = req.body.stats || {};
  const n = (x, max) => Math.max(0, Math.min(max, parseInt(x, 10) || 0));
  const wk = s.week_key === weekKey() ? n(s.points_week, 100000) : 0;
  await upsertUser(u);
  await q(`UPDATE users SET learned_fel=$2, learned_ibora=$3, points_total=GREATEST(points_total,$4), points_week=$5, week_key=$6, streak=$7 WHERE id=$1`,
    [u.id, n(s.learned_fel, 100), n(s.learned_ibora, 100), n(s.points_total, 1000000), wk, weekKey(), n(s.streak, 10000)]);
  res.json({ ok: true });
}));

app.post("/api/leaderboard", wrap(async (req, res) => {
  const u = tgUser(req);
  if (!u) return res.status(403).json({ ok: false });
  const weekly = req.body.kind !== "a";
  const col = weekly ? "CASE WHEN week_key=$1 THEN points_week ELSE 0 END" : "points_total";
  const base = `SELECT id, first_name, ${col} AS p, rank() OVER (ORDER BY ${col} DESC, id) AS r FROM users WHERE NOT blocked`;
  const params = weekly ? [weekKey()] : [];
  const top = (await q(`SELECT * FROM (${base}) t ORDER BY r LIMIT 20`, params)).rows;
  const me = (await q(`SELECT * FROM (${base}) t WHERE id=$${params.length + 1}`, [...params, u.id])).rows[0];
  const row = (x) => ({ name: x.first_name || "O'quvchi", p: Number(x.p), r: Number(x.r), me: String(x.id) === String(u.id) });
  res.json({ ok: true, top: top.map(row), me: me ? row(me) : null });
}));

// ---------- Adminka: kirish ----------
const ROLE_LEVEL = { viewer: 1, editor: 2, admin: 3 };
function sign(v) { return crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("hex"); }
function makeSession(staffId) {
  const exp = Date.now() + 30 * 864e5;
  const v = `${staffId}.${exp}`;
  return `${v}.${sign(v)}`;
}
function readCookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
async function staffFrom(req) {
  const c = readCookie(req, "adm");
  const [id, exp, sig] = c.split(".");
  if (!id || !exp || !sig || Number(exp) < Date.now()) return null;
  const good = sign(`${id}.${exp}`);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return (await q("SELECT id, login, role FROM staff WHERE id=$1", [id])).rows[0] || null;
}
const need = (role) => (fn) => wrap(async (req, res) => {
  const s = await staffFrom(req);
  if (!s) return res.status(401).json({ error: "Qayta kiring" });
  if (ROLE_LEVEL[s.role] < ROLE_LEVEL[role]) return res.status(403).json({ error: "Bu amal uchun ruxsatingiz yo'q" });
  req.staff = s;
  return fn(req, res);
});

const attempts = new Map();
app.post("/admin/api/login", wrap(async (req, res) => {
  const ip = req.ip || "x";
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: "Juda ko'p urinish. 15 daqiqadan keyin qayta urinib ko'ring." });
  const login = String(req.body.login || "").trim().toLowerCase();
  const s = (await q("SELECT * FROM staff WHERE login=$1", [login])).rows[0];
  if (!s || !checkPass(req.body.password || "", s.pass_hash)) {
    a.n++; attempts.set(ip, a);
    return res.status(401).json({ error: "Login yoki parol noto'g'ri" });
  }
  attempts.delete(ip);
  res.setHeader("Set-Cookie", `adm=${encodeURIComponent(makeSession(s.id))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${req.secure ? "; Secure" : ""}`);
  res.json({ ok: true, me: { login: s.login, role: s.role } });
}));
app.post("/admin/api/logout", (_req, res) => { res.setHeader("Set-Cookie", "adm=; Path=/; Max-Age=0"); res.json({ ok: true }); });
app.get("/admin/api/me", need("viewer")(async (req, res) => res.json({ me: req.staff, adminChat: !!ADMIN_CHAT_ID })));

// ---------- Statistika ----------
app.get("/admin/api/stats", need("viewer")(async (req, res) => {
  const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 7));
  const k = (await q(`SELECT
      count(*) AS total,
      count(*) FILTER (WHERE joined_at > now() - make_interval(days => $1)) AS new_period,
      count(*) FILTER (WHERE last_seen > now() - interval '7 days') AS active7,
      count(*) FILTER (WHERE last_seen > date_trunc('day', now())) AS today,
      count(*) FILTER (WHERE blocked) AS blocked,
      count(*) FILTER (WHERE bot_stopped) AS stopped,
      count(*) FILTER (WHERE onboarded_at IS NOT NULL) AS onboarded
    FROM users`, [days])).rows[0];
  const daily = (await q(`SELECT to_char(d, 'YYYY-MM-DD') AS day, (SELECT count(*) FROM users WHERE joined_at >= d AND joined_at < d + interval '1 day') AS n
    FROM generate_series(date_trunc('day', now()) - make_interval(days => $1 - 1), date_trunc('day', now()), interval '1 day') d`, [days])).rows;
  const goals = (await q(`SELECT COALESCE(goal,'Javob bermagan') AS goal, count(*) AS n FROM users GROUP BY 1 ORDER BY 2 DESC`)).rows;
  const learned = (await q(`SELECT COALESCE(sum(learned_fel),0) AS fel, COALESCE(sum(learned_ibora),0) AS ibora FROM users`)).rows[0];
  const num = (o) => Object.fromEntries(Object.entries(o).map(([a, b]) => [a, Number(b)]));
  res.json({ kpi: num(k), daily: daily.map((d) => ({ day: d.day, n: Number(d.n) })), goals: goals.map((g) => ({ goal: g.goal, n: Number(g.n) })), learned: num(learned), days });
}));

// ---------- O'quvchilar ----------
app.get("/admin/api/users", need("viewer")(async (req, res) => {
  const where = ["true"], params = [];
  const s = String(req.query.q || "").trim();
  if (s) { params.push(`%${s.replace(/^@/, "")}%`); where.push(`(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR username ILIKE $${params.length} OR id::text = '${s.replace(/\D/g, "") || "0"}')`); }
  const f = req.query.f;
  if (f === "active") where.push("last_seen > now() - interval '7 days'");
  if (f === "inactive") where.push("(last_seen IS NULL OR last_seen <= now() - interval '7 days')");
  if (f === "blocked") where.push("(blocked OR NOT access)");
  if (f === "stopped") where.push("bot_stopped");
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const rows = (await q(`SELECT *, count(*) OVER() AS _n FROM users WHERE ${where.join(" AND ")} ORDER BY last_seen DESC NULLS LAST, id DESC LIMIT 50 OFFSET ${off}`, params)).rows;
  res.json({ total: rows[0] ? Number(rows[0]._n) : 0, users: rows.map(({ _n, ...r }) => r) });
}));
app.get("/admin/api/users/:id", need("viewer")(async (req, res) => {
  const u = (await q("SELECT * FROM users WHERE id=$1", [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: "Topilmadi" });
  const rank = (await q("SELECT count(*)+1 AS r FROM users WHERE points_total > $1", [u.points_total])).rows[0].r;
  res.json({ user: u, rank: Number(rank) });
}));
app.patch("/admin/api/users/:id", need("admin")(async (req, res) => {
  const b = req.body || {};
  if (typeof b.blocked === "boolean") await q("UPDATE users SET blocked=$2 WHERE id=$1", [req.params.id, b.blocked]);
  if (typeof b.access === "boolean") await q("UPDATE users SET access=$2 WHERE id=$1", [req.params.id, b.access]);
  res.json({ ok: true });
}));
app.post("/admin/api/users/:id/message", need("editor")(async (req, res) => {
  const u = (await q("SELECT id, first_name, blocked FROM users WHERE id=$1", [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: "Topilmadi" });
  const m = msgFrom(req.body);
  if (m.error) return res.status(400).json(m);
  const ok = await sendToUser(u, m);
  ok ? res.json({ ok: true }) : res.status(400).json({ error: "Yuborilmadi: o'quvchi botni to'xtatgan bo'lishi mumkin" });
}));

// ---------- Fayl yuklash (Telegram'ga bir marta yuklanadi, keyin file_id bilan yuboriladi) ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 49 * 1024 * 1024 } });
const KINDS = ["text", "photo", "video_note", "voice", "video"];
function msgFrom(b) {
  const kind = KINDS.includes(b.kind) ? b.kind : "text";
  const text = String(b.text || "").slice(0, kind === "text" || kind === "video_note" ? 4000 : 1000);
  if (kind === "text" && !text.trim()) return { error: "Matn yozing" };
  if (kind !== "text" && !b.file_id) return { error: "Faylni yuklang" };
  return { kind, text, file_id: kind === "text" ? null : String(b.file_id) };
}
app.post("/admin/api/media", need("editor")(async (req, res) => {
  await new Promise((ok, bad) => upload.single("file")(req, res, (e) => (e ? bad(e) : ok())));
  if (!ADMIN_CHAT_ID) return res.status(400).json({ error: "Fayl yuklash uchun Railway'da ADMIN_CHAT_ID qo'shing (botga /myid yozib bilasiz)" });
  if (!req.file) return res.status(400).json({ error: "Fayl tanlanmagan" });
  const kind = req.body.kind;
  const file = new InputFile(req.file.buffer, req.file.originalname || "file");
  let r, id;
  try {
    if (kind === "photo") { r = await bot.api.sendPhoto(ADMIN_CHAT_ID, file, { caption: "📎 Yuklangan rasm" }); id = r.photo[r.photo.length - 1].file_id; }
    else if (kind === "video_note") { r = await bot.api.sendVideoNote(ADMIN_CHAT_ID, file); id = r.video_note && r.video_note.file_id; if (!id) throw new Error("Dumaloq video bo'lmadi. Video kvadrat va 1 daqiqadan qisqa bo'lsin."); }
    else if (kind === "voice") { r = await bot.api.sendVoice(ADMIN_CHAT_ID, file); id = r.voice ? r.voice.file_id : r.audio && r.audio.file_id; if (!r.voice) throw new Error("Ovozli xabar uchun .ogg formatdagi fayl yuklang (Telegram'dan saqlangan ovozli xabar)."); }
    else if (kind === "video") { r = await bot.api.sendVideo(ADMIN_CHAT_ID, file); id = r.video.file_id; }
    else return res.status(400).json({ error: "Noto'g'ri tur" });
  } catch (e) {
    return res.status(400).json({ error: e.description || e.message || "Telegram faylni qabul qilmadi" });
  }
  res.json({ ok: true, file_id: id });
}));

// ---------- Xabar yuborish ----------
app.get("/admin/api/segments", need("viewer")(async (_req, res) => {
  const out = [];
  for (const s of SEGMENTS) {
    const n = (await q(`SELECT count(*) FROM users WHERE ${REACHABLE} AND ${s.where}`)).rows[0].count;
    out.push({ id: s.id, label: s.label, n: Number(n) });
  }
  res.json({ segments: out });
}));
app.post("/admin/api/test", need("editor")(async (req, res) => {
  if (!ADMIN_CHAT_ID) return res.status(400).json({ error: "Railway'da ADMIN_CHAT_ID qo'shing" });
  const m = msgFrom(req.body);
  if (m.error) return res.status(400).json(m);
  try { await sendContent(ADMIN_CHAT_ID, m, "Admin"); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.description || e.message }); }
}));
app.post("/admin/api/broadcasts", need("editor")(async (req, res) => {
  const m = msgFrom(req.body);
  if (m.error) return res.status(400).json(m);
  const seg = SEGMENTS.find((s) => s.id === req.body.segment) ? req.body.segment : "all";
  const r = await q("INSERT INTO broadcasts(created_by, segment, kind, text, file_id) VALUES ($1,$2,$3,$4,$5) RETURNING id", [req.staff.login, seg, m.kind, m.text, m.file_id]);
  if (!NO_BOT) runBroadcasts();
  res.json({ ok: true, id: r.rows[0].id });
}));
app.get("/admin/api/broadcasts", need("viewer")(async (_req, res) => {
  res.json({ broadcasts: (await q("SELECT * FROM broadcasts ORDER BY id DESC LIMIT 30")).rows });
}));
app.post("/admin/api/broadcasts/:id/stop", need("editor")(async (req, res) => {
  await q("UPDATE broadcasts SET status='stopped' WHERE id=$1 AND status IN ('queued','running')", [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Voronkalar ----------
app.get("/admin/api/funnels", need("viewer")(async (_req, res) => {
  const f = (await q(`SELECT f.*, (SELECT count(*) FROM funnel_runs WHERE funnel_id=f.id) AS entered,
    (SELECT count(*) FROM funnel_runs WHERE funnel_id=f.id AND done) AS finished FROM funnels f ORDER BY id`)).rows;
  const s = (await q("SELECT * FROM funnel_steps ORDER BY funnel_id, position, id")).rows;
  res.json({ funnels: f.map((x) => ({ ...x, entered: Number(x.entered), finished: Number(x.finished), steps: s.filter((y) => y.funnel_id === x.id) })) });
}));
app.post("/admin/api/funnels", need("editor")(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: "Voronka nomini yozing" });
  const trigger = b.trigger === "start" ? "start" : "onboard";
  const segment = SEGMENTS.find((s) => s.id === b.segment) ? b.segment : "all";
  const steps = Array.isArray(b.steps) ? b.steps.slice(0, 30) : [];
  for (const st of steps) { const m = msgFrom(st); if (m.error) return res.status(400).json({ error: `${steps.indexOf(st) + 1}-qadam: ${m.error}` }); }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let id = parseInt(b.id, 10);
    if (id) await client.query("UPDATE funnels SET name=$2, trigger=$3, segment=$4, enabled=$5 WHERE id=$1", [id, name, trigger, segment, !!b.enabled]);
    else id = (await client.query("INSERT INTO funnels(name, trigger, segment, enabled) VALUES ($1,$2,$3,$4) RETURNING id", [name, trigger, segment, !!b.enabled])).rows[0].id;
    await client.query("DELETE FROM funnel_steps WHERE funnel_id=$1", [id]);
    let i = 0;
    for (const st of steps) {
      const m = msgFrom(st);
      await client.query("INSERT INTO funnel_steps(funnel_id, position, delay_minutes, kind, text, file_id) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, i++, Math.max(0, Math.min(525600, parseInt(st.delay_minutes, 10) || 0)), m.kind, m.text, m.file_id]);
    }
    await client.query("COMMIT");
    res.json({ ok: true, id });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}));
app.delete("/admin/api/funnels/:id", need("editor")(async (req, res) => {
  await q("DELETE FROM funnels WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Xodimlar (faqat admin) ----------
app.get("/admin/api/staff", need("admin")(async (_req, res) => {
  res.json({ staff: (await q("SELECT id, login, role, created_at FROM staff ORDER BY id")).rows, owner: (ADMIN_LOGIN || "").trim().toLowerCase() });
}));
app.post("/admin/api/staff", need("admin")(async (req, res) => {
  const login = String(req.body.login || "").trim().toLowerCase();
  const role = ROLE_LEVEL[req.body.role] ? req.body.role : "viewer";
  if (!/^[a-z0-9_.]{3,32}$/.test(login)) return res.status(400).json({ error: "Login 3–32 belgi: lotin harflari, raqam, _ yoki ." });
  if (String(req.body.password || "").length < 6) return res.status(400).json({ error: "Parol kamida 6 belgi bo'lsin" });
  try { await q("INSERT INTO staff(login, pass_hash, role) VALUES ($1,$2,$3)", [login, hashPass(req.body.password), role]); }
  catch (e) { return res.status(400).json({ error: "Bu login band" }); }
  res.json({ ok: true });
}));
app.patch("/admin/api/staff/:id", need("admin")(async (req, res) => {
  const t = (await q("SELECT * FROM staff WHERE id=$1", [req.params.id])).rows[0];
  if (!t) return res.status(404).json({ error: "Topilmadi" });
  const owner = (ADMIN_LOGIN || "").trim().toLowerCase();
  if (req.body.role && t.login !== owner && ROLE_LEVEL[req.body.role]) await q("UPDATE staff SET role=$2 WHERE id=$1", [t.id, req.body.role]);
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ error: "Parol kamida 6 belgi bo'lsin" });
    if (t.login === owner) return res.status(400).json({ error: "Egasining parolini Railway'dagi ADMIN_PASSWORD orqali o'zgartiring" });
    await q("UPDATE staff SET pass_hash=$2 WHERE id=$1", [t.id, hashPass(req.body.password)]);
  }
  res.json({ ok: true });
}));
app.delete("/admin/api/staff/:id", need("admin")(async (req, res) => {
  const t = (await q("SELECT * FROM staff WHERE id=$1", [req.params.id])).rows[0];
  if (!t) return res.json({ ok: true });
  if (t.id === req.staff.id || t.login === (ADMIN_LOGIN || "").trim().toLowerCase()) return res.status(400).json({ error: "Bu foydalanuvchini o'chirib bo'lmaydi" });
  await q("DELETE FROM staff WHERE id=$1", [t.id]);
  res.json({ ok: true });
}));

// ================= Ishga tushirish =================
(async () => {
  await migrate();
  app.listen(PORT, () => console.log(`Server ${PORT}-portda. Platforma: ${WEBAPP_URL || "(domen yo'q)"}  Adminka: ${WEBAPP_URL || ""}/admin`));
  if (NO_BOT) return;
  if (WEBAPP_URL) {
    await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Ochish", web_app: { url: WEBAPP_URL } } })
      .catch((e) => console.error("Menu tugmasi o'rnatilmadi:", e.description || e));
  }
  await bot.api.setMyCommands([{ command: "start", description: "Platformani ochish" }]).catch(() => {});
  bot.start({ drop_pending_updates: true, allowed_updates: ["message", "my_chat_member"], onStart: (me) => console.log(`Bot ishga tushdi: @${me.username}`) })
    .catch((e) => console.error("Bot ishga tushmadi (BOT_TOKEN to'g'rimi?):", e.description || e.message || e));
  const tick = Number(process.env.FUNNEL_TICK_MS) || 60e3;
  runBroadcasts();
  setInterval(runBroadcasts, 30e3);
  setInterval(runFunnels, tick);
})().catch((e) => { console.error("Ishga tushmadi:", e); process.exit(1); });

process.once("SIGTERM", () => { bot.stop(); process.exit(0); });
process.once("SIGINT", () => { bot.stop(); process.exit(0); });
