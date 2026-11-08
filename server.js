const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const API_KEY = process.env.API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
if (!API_KEY || !DATABASE_URL) {
  console.error("Missing API_KEY or DATABASE_URL environment variable");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

const app = express();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- helpers ----------
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stable(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

function formatBooking(r) {
  return {
    id: r.id,
    slot_id: r.slot_id,
    name: r.name,
    email: r.email,
    status: r.status,
    created_at: new Date(r.created_at).toISOString(),
  };
}

const fail = (status, error) => ({ status, body: { error } });

// ---------- rate limit (level 5): 5 attempts per email per minute ----------
const attempts = new Map();
const WINDOW_MS = 60000;
function checkRate(email) {
  const now = Date.now();
  const list = (attempts.get(email) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= 5) {
    attempts.set(email, list);
    return Math.max(1, Math.ceil((list[0] + WINDOW_MS - now) / 1000));
  }
  list.push(now);
  attempts.set(email, list);
  return 0;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of attempts) {
    const fresh = list.filter((t) => now - t < WINDOW_MS);
    if (fresh.length) attempts.set(k, fresh);
    else attempts.delete(k);
  }
}, 30000).unref();

// ---------- public routes (no key): web page + health ----------
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- level 2: API key ----------
app.use((req, res, next) => {
  const key = req.get("X-API-Key");
  if (!key || !safeEqual(key, API_KEY)) {
    return res.status(401).json({ error: "missing or invalid API key" });
  }
  next();
});

app.use(express.json({ limit: "1mb" }));

// ---------- POST /reset ----------
app.post("/reset", async (req, res) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) {
    return res.status(400).json({ error: "slots must be an array" });
  }
  const seen = new Set();
  const clean = [];
  for (const s of slots) {
    if (
      !s ||
      typeof s.id !== "string" ||
      !s.id.trim() ||
      typeof s.provider !== "string" ||
      typeof s.start !== "string" ||
      typeof s.end !== "string" ||
      isNaN(Date.parse(s.start)) ||
      isNaN(Date.parse(s.end)) ||
      seen.has(s.id)
    ) {
      return res.status(400).json({ error: "invalid slot in slots" });
    }
    seen.add(s.id);
    clean.push(s);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM idempotency");
    await client.query("DELETE FROM slots");
    for (const s of clean) {
      await client.query(
        "INSERT INTO slots(id, provider, start_text, end_text, start_ts) VALUES($1,$2,$3,$4,$5)",
        [s.id, s.provider, s.start, s.end, new Date(s.start).toISOString()]
      );
    }
    await client.query("COMMIT");
    attempts.clear();
    res.json({ ok: true, slots: clean.length });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error(e);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// ---------- GET /slots ----------
app.get("/slots", async (req, res) => {
  try {
    const params = [];
    let where = "";
    if (typeof req.query.provider === "string") {
      params.push(req.query.provider);
      where = "WHERE s.provider = $1";
    }
    const r = await pool.query(
      `SELECT s.id, s.provider, s.start_text, s.end_text,
        NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s ${where}
       ORDER BY s.start_ts ASC, s.id ASC`,
      params
    );
    res.json({
      slots: r.rows.map((x) => ({
        id: x.id,
        provider: x.provider,
        start: x.start_text,
        end: x.end_text,
        available: x.available,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// ---------- booking logic (levels 1-3) ----------
async function createBooking(client, body) {
  const slotId =
    typeof body.slot_id === "string" && body.slot_id.trim() ? body.slot_id : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!slotId) return fail(400, "slot_id is required");
  if (!name) return fail(400, "name is required");
  if (!email) return fail(400, "email is required");
  if (!EMAIL_RE.test(email)) return fail(400, "email is not valid");

  const slot = await client.query(
    "SELECT id, start_ts FROM slots WHERE id = $1",
    [slotId]
  );
  if (!slot.rowCount) return fail(404, "slot not found");
  if (new Date(slot.rows[0].start_ts).getTime() <= Date.now()) {
    return fail(400, "slot has already started");
  }

  const ins = await client.query(
    `INSERT INTO bookings(id, slot_id, name, email, status)
     VALUES($1,$2,$3,$4,'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), slotId, name, email]
  );
  if (!ins.rowCount) return fail(409, "slot is already booked");
  return { status: 201, body: formatBooking(ins.rows[0]) };
}

// ---------- POST /bookings ----------
app.post("/bookings", async (req, res) => {
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
  const idemKey = req.get("Idempotency-Key");
  const rateEmail =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let bodyHash = null;
    if (idemKey) {
      bodyHash = crypto.createHash("sha256").update(stable(body)).digest("hex");
      // one request per key at a time, so simultaneous retries can't both book
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [idemKey]);
      const found = await client.query(
        "SELECT body_hash, status, response FROM idempotency WHERE key = $1",
        [idemKey]
      );
      if (found.rowCount) {
        await client.query("COMMIT");
        const row = found.rows[0];
        if (row.body_hash !== bodyHash) {
          return res.status(422).json({
            error: "Idempotency-Key was already used with a different body",
          });
        }
        return res.status(row.status).json(row.response);
      }
    }

    if (rateEmail) {
      const retry = checkRate(rateEmail);
      if (retry) {
        await client.query("ROLLBACK");
        res.set("Retry-After", String(retry));
        return res
          .status(429)
          .json({ error: "too many booking attempts for this email, try again later" });
      }
    }

    const result = await createBooking(client, body);

    if (idemKey) {
      await client.query(
        "INSERT INTO idempotency(key, body_hash, status, response) VALUES($1,$2,$3,$4)",
        [idemKey, bodyHash, result.status, JSON.stringify(result.body)]
      );
    }
    await client.query("COMMIT");
    return res.status(result.status).json(result.body);
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error(e);
    return res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// ---------- GET /bookings (level 4: cursor pagination) ----------
app.get("/bookings", async (req, res) => {
  try {
    const email =
      typeof req.query.email === "string"
        ? req.query.email.trim().toLowerCase()
        : "";
    if (!email) {
      return res.status(400).json({ error: "email query parameter is required" });
    }

    let limit = 10;
    if (req.query.limit !== undefined) {
      const s = String(req.query.limit);
      if (!/^\d+$/.test(s)) {
        return res.status(400).json({ error: "limit must be a number from 1 to 50" });
      }
      limit = parseInt(s, 10);
      if (limit < 1 || limit > 50) {
        return res.status(400).json({ error: "limit must be a number from 1 to 50" });
      }
    }

    let after = 0;
    if (typeof req.query.cursor === "string" && req.query.cursor !== "") {
      const decoded = Buffer.from(req.query.cursor, "base64url").toString();
      if (!/^\d+$/.test(decoded)) {
        return res.status(400).json({ error: "invalid cursor" });
      }
      after = Number(decoded);
    }

    const r = await pool.query(
      "SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3",
      [email, after, limit + 1]
    );
    const hasMore = r.rows.length > limit;
    const page = r.rows.slice(0, limit);
    const next_cursor = hasMore
      ? Buffer.from(String(page[page.length - 1].seq)).toString("base64url")
      : null;
    res.json({ bookings: page.map(formatBooking), next_cursor });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// ---------- GET /bookings/:id ----------
app.get("/bookings/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "booking not found" });
    res.json(formatBooking(r.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// ---------- DELETE /bookings/:id (level 3: cancel) ----------
app.delete("/bookings/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      "SELECT * FROM bookings WHERE id = $1 FOR UPDATE",
      [req.params.id]
    );
    if (!r.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "booking not found" });
    }
    if (r.rows[0].status === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "booking is already cancelled" });
    }
    const u = await client.query(
      "UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    await client.query("COMMIT");
    res.json(formatBooking(u.rows[0]));
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error(e);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// ---------- fallbacks ----------
app.use((req, res) => res.status(404).json({ error: "not found" }));
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

// ---------- start ----------
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id text PRIMARY KEY,
      provider text NOT NULL,
      start_text text NOT NULL,
      end_text text NOT NULL,
      start_ts timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      seq bigserial UNIQUE,
      id text PRIMARY KEY,
      slot_id text NOT NULL,
      name text NOT NULL,
      email text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot
      ON bookings(slot_id) WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings(email, seq);
    CREATE TABLE IF NOT EXISTS idempotency (
      key text PRIMARY KEY,
      body_hash text NOT NULL,
      status int NOT NULL,
      response jsonb NOT NULL
    );
  `);

  // sample slots so the web page has something to show
  const c = await pool.query("SELECT count(*)::int AS n FROM slots");
  if (c.rows[0].n === 0) {
    const iso = (d) => d.toISOString().replace(".000Z", "Z");
    let n = 1;
    for (let day = 1; day <= 3; day++) {
      for (const provider of ["Dr Ade", "Dr Bola"]) {
        for (const [h, m] of [[9, 0], [9, 30], [10, 0]]) {
          const start = new Date();
          start.setUTCDate(start.getUTCDate() + day);
          start.setUTCHours(h, m, 0, 0);
          const end = new Date(start.getTime() + 30 * 60000);
          await pool.query(
            "INSERT INTO slots(id, provider, start_text, end_text, start_ts) VALUES($1,$2,$3,$4,$5)",
            ["s" + n++, provider, iso(start), iso(end), start.toISOString()]
          );
        }
      }
    }
  }
}

init()
  .then(() => app.listen(PORT, () => console.log("Listening on " + PORT)))
  .catch((e) => {
    console.error("Startup failed", e);
    process.exit(1);
  });
