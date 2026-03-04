/**
 * MidLauncher Social Server — PostgreSQL edition
 * Auth: username + password, Microsoft/Elyby linking
 * Admin: @dev can grant/revoke admin, temp/perm bans
 */

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const PORT       = process.env.PORT       || 3747;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_IN_PRODUCTION';
const DATABASE_URL = process.env.DATABASE_URL;

const USERNAME_CHANGE_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
});

pool.on('error', (err) => console.error('[DB] Pool error:', err));

async function q(sql, params) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

async function initDB() {
  console.log('[DB] Connecting...');
  const testClient = await pool.connect();
  console.log('[DB] Connection OK');
  testClient.release();

  await q(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT,
    password_hash TEXT NOT NULL,
    username_changed_at BIGINT DEFAULT 0,
    banned BOOLEAN DEFAULT FALSE,
    ban_until BIGINT DEFAULT NULL,
    ban_reason TEXT DEFAULT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`);

  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_until BIGINT DEFAULT NULL`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT DEFAULT NULL`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`);

  await q(`CREATE TABLE IF NOT EXISTS linked_accounts (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    external_username TEXT,
    UNIQUE(type, external_id)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS friends (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(user_id, friend_id)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    read BOOLEAN DEFAULT FALSE
  )`);

  await q(`CREATE TABLE IF NOT EXISTS blocks (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(user_id, blocked_id)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT 'other',
    text TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`);

  // Make all FK constraints deferrable so we can do cross-table ID renames in a single transaction
  await q(`DO $$
  DECLARE r RECORD;
  BEGIN
    FOR r IN
      SELECT tc.constraint_name, tc.table_name
      FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name IN ('linked_accounts','friends','messages','blocks','reports')
    LOOP
      BEGIN
        EXECUTE format('ALTER TABLE %I ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', r.table_name, r.constraint_name);
      EXCEPTION WHEN others THEN NULL; END;
    END LOOP;
  END$$`).catch(() => {});

  await q(`CREATE INDEX IF NOT EXISTS idx_friends_user   ON friends(user_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_msg_pair       ON messages(from_id, to_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_linked_user    ON linked_accounts(user_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_blocks_user    ON blocks(user_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status)`);

  console.log('[DB] Ready');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const signToken = (id) => jwt.sign({ sub: id }, JWT_SECRET, { expiresIn: '30d' });

// dev — superowner, cannot be demoted or banned
const DEV_USERNAME = 'dev';

async function isDevUser(userId) {
  const r = await q('SELECT username FROM users WHERE id=$1', [userId]);
  if (r.rows.length && r.rows[0].username.toLowerCase() === DEV_USERNAME) return true;
  const r2 = await q('SELECT id FROM users WHERE LOWER(username)=$1', [DEV_USERNAME]);
  if (r2.rows.length && r2.rows[0].id === userId) return true;
  return false;
}

async function isAdminUser(userId) {
  if (await isDevUser(userId)) return true;
  const r = await q('SELECT is_admin FROM users WHERE id=$1', [userId]);
  return r.rows.length && r.rows[0].is_admin === true;
}

async function checkBanStatus(userId) {
  const r = await q('SELECT banned, ban_until, ban_reason FROM users WHERE id=$1', [userId]);
  if (!r.rows.length) return { banned: false };
  const { banned, ban_until, ban_reason } = r.rows[0];
  if (!banned) return { banned: false };
  if (ban_until !== null) {
    const now = Math.floor(Date.now() / 1000);
    if (ban_until <= now) {
      await q('UPDATE users SET banned=FALSE, ban_until=NULL, ban_reason=NULL WHERE id=$1', [userId]);
      return { banned: false };
    }
    return { banned: true, until: ban_until, reason: ban_reason };
  }
  return { banned: true, permanent: true, reason: ban_reason };
}

async function authCheck(req, res, next) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).sub;

    // FIX: verify user actually exists — handles stale tokens after ID change
    const exists = await q('SELECT id FROM users WHERE id=$1', [req.userId]);
    if (!exists.rows.length) return res.status(401).json({ error: 'Token invalid: user not found', reauth: true });

    const banStatus = await checkBanStatus(req.userId);
    if (banStatus.banned) {
      if (banStatus.permanent) {
        return res.status(403).json({ error: 'Аккаунт заблокирован администратором', reason: banStatus.reason || null });
      } else {
        const timeLeft = banStatus.until - Math.floor(Date.now() / 1000);
        const mins = Math.ceil(timeLeft / 60);
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        const timeStr = hrs > 0 ? `${hrs} ч ${rem} мин` : `${mins} мин`;
        return res.status(403).json({ error: `Аккаунт временно заблокирован. Осталось: ${timeStr}`, reason: banStatus.reason || null, until: banStatus.until });
      }
    }
    next();
  } catch(e) {
    if (e.name === 'JsonWebTokenError') res.status(401).json({ error: 'Invalid token' });
    else next(e);
  }
}
const auth = authCheck;

function validUsername(u) {
  if (!u || typeof u !== 'string') return false;
  if (u.length < 1 || u.length > 64) return false;
  return true;
}

async function getUserWithLinks(userId) {
  const ur = await q('SELECT id, username, display_name, username_changed_at, is_admin FROM users WHERE id=$1', [userId]);
  if (!ur.rows.length) return null;
  const u = ur.rows[0];
  const lr = await q('SELECT type, external_username FROM linked_accounts WHERE user_id=$1', [userId]);
  u.linkedAccounts = lr.rows;
  u.isAdmin = u.is_admin || u.username.toLowerCase() === DEV_USERNAME;
  return u;
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (_, res) => res.json({ ok: true, service: 'MidLauncher Social' }));

// ── Register ──────────────────────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Ник и пароль обязательны' });
  if (!validUsername(username)) return res.status(400).json({ error: 'Ник должен быть от 1 до 64 символов' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  try {
    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    const dn = (displayName || username).trim().slice(0, 32) || username;
    await q('INSERT INTO users (id, username, display_name, password_hash) VALUES ($1,$2,$3,$4)', [id, username, dn, hash]);
    const u = await getUserWithLinks(id);
    res.json({ ok: true, token: signToken(id), user: { id, username, displayName: dn, linkedAccounts: [], isAdmin: u.isAdmin } });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ник уже занят' });
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Ник и пароль обязательны' });
  try {
    const r = await q('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Неверный ник или пароль' });
    if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Неверный ник или пароль' });

    const banStatus = await checkBanStatus(user.id);
    if (banStatus.banned) {
      if (banStatus.permanent) {
        return res.status(403).json({ error: 'Аккаунт заблокирован администратором', reason: banStatus.reason || null });
      } else {
        const timeLeft = banStatus.until - Math.floor(Date.now() / 1000);
        const mins = Math.ceil(timeLeft / 60);
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        const timeStr = hrs > 0 ? `${hrs} ч ${rem} мин` : `${mins} мин`;
        return res.status(403).json({ error: `Аккаунт временно заблокирован. Осталось: ${timeStr}`, reason: banStatus.reason || null, until: banStatus.until });
      }
    }

    const u = await getUserWithLinks(user.id);
    res.json({ token: signToken(user.id), user: { id: u.id, username: u.username, displayName: u.display_name, linkedAccounts: u.linkedAccounts, isAdmin: u.isAdmin } });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── OAuth Login ───────────────────────────────────────────────────────────────
app.post('/auth/oauth-login', async (req, res) => {
  const { type, externalId, externalUsername } = req.body;
  if (!type || !externalId) return res.status(400).json({ error: 'Нет данных OAuth' });
  try {
    const r = await q('SELECT user_id FROM linked_accounts WHERE type=$1 AND external_id=$2', [type, externalId]);
    if (!r.rows.length) {
      const name = type === 'microsoft' ? 'Microsoft' : 'Ely.by';
      return res.status(404).json({ error: `Аккаунт ${name} не привязан. Войди по нику и паролю и привяжи его в настройках.` });
    }
    const userId = r.rows[0].user_id;
    if (externalUsername) {
      await q('UPDATE linked_accounts SET external_username=$1 WHERE type=$2 AND external_id=$3', [externalUsername, type, externalId]);
    }
    const banStatus = await checkBanStatus(userId);
    if (banStatus.banned) {
      if (banStatus.permanent) return res.status(403).json({ error: 'Аккаунт заблокирован', reason: banStatus.reason || null });
      return res.status(403).json({ error: 'Аккаунт временно заблокирован', until: banStatus.until, reason: banStatus.reason || null });
    }
    const u = await getUserWithLinks(userId);
    res.json({ token: signToken(userId), user: { id: u.id, username: u.username, displayName: u.display_name, linkedAccounts: u.linkedAccounts, isAdmin: u.isAdmin } });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Me ────────────────────────────────────────────────────────────────────────
app.get('/me', auth, async (req, res) => {
  try {
    const u = await getUserWithLinks(req.userId);
    if (!u) return res.status(404).json({ error: 'Not found' });
    res.json({ id: u.id, username: u.username, displayName: u.display_name, linkedAccounts: u.linkedAccounts, isAdmin: u.isAdmin });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Change Username ───────────────────────────────────────────────────────────
app.post('/auth/change-username', auth, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Нужен новый ник' });
  if (!validUsername(username)) return res.status(400).json({ error: 'Ник должен быть от 1 до 64 символов' });
  try {
    const r = await q('SELECT username, username_changed_at FROM users WHERE id=$1', [req.userId]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.username.toLowerCase() === username.toLowerCase()) return res.status(400).json({ error: 'Это уже твой ник' });
    const now = Date.now();
    const lastChange = Number(user.username_changed_at) || 0;
    const cooldownLeft = USERNAME_CHANGE_COOLDOWN_MS - (now - lastChange);
    if (cooldownLeft > 0) {
      const mins = Math.ceil(cooldownLeft / 60000);
      const hrs  = Math.floor(mins / 60);
      const rem  = mins % 60;
      const timeStr = hrs > 0 ? `${hrs} ч ${rem} мин` : `${mins} мин`;
      return res.status(429).json({ error: `Ник можно менять раз в 2 часа. Подожди ещё ${timeStr}.` });
    }
    await q('UPDATE users SET username=$1, username_changed_at=$2 WHERE id=$3', [username, now, req.userId]);
    const u = await getUserWithLinks(req.userId);
    res.json({ ok: true, user: { id: u.id, username: u.username, displayName: u.display_name, linkedAccounts: u.linkedAccounts, isAdmin: u.isAdmin } });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ник уже занят' });
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Change Display Name ───────────────────────────────────────────────────────
app.post('/auth/change-display-name', auth, async (req, res) => {
  const { displayName } = req.body;
  if (!displayName || !displayName.trim()) return res.status(400).json({ error: 'Нужно отображаемое имя' });
  const dn = displayName.trim().slice(0, 32);
  try {
    await q('UPDATE users SET display_name=$1 WHERE id=$2', [dn, req.userId]);
    const u = await getUserWithLinks(req.userId);
    res.json({ ok: true, user: { id: u.id, username: u.username, displayName: u.display_name, linkedAccounts: u.linkedAccounts, isAdmin: u.isAdmin } });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Change Password ───────────────────────────────────────────────────────────
app.post('/auth/change-password', auth, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.userId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Delete Account ────────────────────────────────────────────────────────────
app.delete('/auth/account', auth, async (req, res) => {
  const { password } = req.body;
  try {
    const r = await q('SELECT password_hash FROM users WHERE id=$1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Аккаунт не найден' });
    if (password !== '__oauth_delete__') {
      if (!password) return res.status(400).json({ error: 'Введи пароль' });
      if (!await bcrypt.compare(password, r.rows[0].password_hash)) return res.status(401).json({ error: 'Неверный пароль' });
    }
    await q('DELETE FROM users WHERE id=$1', [req.userId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Link OAuth ────────────────────────────────────────────────────────────────
app.post('/auth/link', auth, async (req, res) => {
  const { type, externalId, externalUsername } = req.body;
  if (!type || !externalId) return res.status(400).json({ error: 'Нет данных' });
  try {
    const existing = await q('SELECT user_id FROM linked_accounts WHERE type=$1 AND external_id=$2', [type, externalId]);
    if (existing.rows.length && existing.rows[0].user_id !== req.userId) {
      return res.status(409).json({ error: 'Этот аккаунт уже привязан к другому профилю' });
    }
    await q(`INSERT INTO linked_accounts (user_id, type, external_id, external_username) VALUES ($1,$2,$3,$4) ON CONFLICT (type, external_id) DO UPDATE SET external_username=$4`,
      [req.userId, type, externalId, externalUsername || null]);
    const u = await getUserWithLinks(req.userId);
    res.json({ ok: true, linkedAccounts: u.linkedAccounts });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Unlink OAuth ──────────────────────────────────────────────────────────────
app.delete('/auth/link/:type', auth, async (req, res) => {
  try {
    await q('DELETE FROM linked_accounts WHERE user_id=$1 AND type=$2', [req.userId, req.params.type]);
    const u = await getUserWithLinks(req.userId);
    res.json({ ok: true, linkedAccounts: u.linkedAccounts });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Friends ───────────────────────────────────────────────────────────────────
app.get('/friends', auth, async (req, res) => {
  const uid = req.userId;
  try {
    const accepted = (await q(`SELECT u.id, u.username, u.display_name as "displayName", u.is_admin as "isAdmin" FROM friends f JOIN users u ON (CASE WHEN f.user_id=$1 THEN f.friend_id ELSE f.user_id END = u.id) WHERE (f.user_id=$1 OR f.friend_id=$1) AND f.status='accepted'`, [uid])).rows;
    const pending  = (await q(`SELECT u.id, u.username, u.display_name as "displayName", f.id as "requestId" FROM friends f JOIN users u ON f.user_id=u.id WHERE f.friend_id=$1 AND f.status='pending'`, [uid])).rows;
    const outgoing = (await q(`SELECT u.id, u.username, u.display_name as "displayName" FROM friends f JOIN users u ON f.friend_id=u.id WHERE f.user_id=$1 AND f.status='pending'`, [uid])).rows;
    res.json({ accepted, pending, outgoing });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.post('/friends/add', auth, async (req, res) => {
  const { username } = req.body;
  try {
    const tr = await q('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (!tr.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    const targetId = tr.rows[0].id;
    if (targetId === req.userId) return res.status(400).json({ error: 'Нельзя добавить себя' });
    const ex = await q('SELECT status FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [req.userId, targetId]);
    if (ex.rows.length) return res.status(409).json({ error: ex.rows[0].status === 'accepted' ? 'Уже в друзьях' : 'Запрос уже отправлен' });

    // Get sender info for the notification
    const senderRow = await q('SELECT id, username, display_name as "displayName" FROM users WHERE id=$1', [req.userId]);
    const sender = senderRow.rows[0];

    await q('INSERT INTO friends (user_id,friend_id,status) VALUES ($1,$2,$3)', [req.userId, targetId, 'pending']);

    // FIX: Send full sender info so recipient can show the request immediately without re-fetching
    broadcast(targetId, { type: 'friend_request', from: req.userId, sender });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.post('/friends/accept', auth, async (req, res) => {
  const { userId } = req.body;
  try {
    const r = await q('SELECT 1 FROM friends WHERE user_id=$1 AND friend_id=$2 AND status=$3', [userId, req.userId, 'pending']);
    if (!r.rows.length) return res.status(404).json({ error: 'Запрос не найден' });
    await q('UPDATE friends SET status=$1 WHERE user_id=$2 AND friend_id=$3', ['accepted', userId, req.userId]);
    broadcast(userId, { type: 'friend_accepted', by: req.userId });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.delete('/friends/:userId', auth, async (req, res) => {
  try {
    await q('DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [req.userId, req.params.userId]);
    broadcast(req.params.userId, { type: 'friend_removed', by: req.userId });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.get('/users/search', auth, async (req, res) => {
  const q2 = (req.query.q || '').trim();
  if (q2.length < 2) return res.json([]);
  try {
    const r = await q('SELECT id, username, display_name as "displayName", is_admin as "isAdmin" FROM users WHERE username ILIKE $1 AND id!=$2 LIMIT 10', ['%' + q2 + '%', req.userId]);
    res.json(r.rows);
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Messages ──────────────────────────────────────────────────────────────────
app.get('/messages/:friendId', auth, async (req, res) => {
  const { friendId } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '50'), 100);
  const before = req.query.before ? parseInt(req.query.before) : null;
  try {
    const sql = before
      ? `SELECT id, from_id as "fromId", to_id as "toId", content, created_at as ts FROM messages WHERE ((from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)) AND id<$3 ORDER BY id DESC LIMIT $4`
      : `SELECT id, from_id as "fromId", to_id as "toId", content, created_at as ts FROM messages WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1) ORDER BY id DESC LIMIT $3`;
    const params = before ? [req.userId, friendId, before, limit] : [req.userId, friendId, limit];
    const r = await q(sql, params);
    await q('UPDATE messages SET read=TRUE WHERE to_id=$1 AND from_id=$2 AND read=FALSE', [req.userId, friendId]);
    res.json(r.rows.reverse());
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Block ─────────────────────────────────────────────────────────────────────
app.post('/users/block', auth, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Нет userId' });
  if (userId === req.userId) return res.status(400).json({ error: 'Нельзя заблокировать себя' });
  try {
    await q('DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [req.userId, userId]);
    await q('INSERT INTO blocks (user_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, userId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/users/block/:userId', auth, async (req, res) => {
  try {
    await q('DELETE FROM blocks WHERE user_id=$1 AND blocked_id=$2', [req.userId, req.params.userId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Reports ───────────────────────────────────────────────────────────────────
app.post('/reports', auth, async (req, res) => {
  const { userId, reason, text } = req.body;
  if (!userId || !reason) return res.status(400).json({ error: 'Нет данных' });
  if (userId === req.userId) return res.status(400).json({ error: 'Нельзя жаловаться на себя' });
  try {
    await q('INSERT INTO reports (reporter_id, reported_id, reason, text) VALUES ($1,$2,$3,$4)', [req.userId, userId, reason, text || '']);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin endpoints ───────────────────────────────────────────────────────────

app.get('/admin/stats', auth, async (req, res) => {
  if (!await isAdminUser(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const users    = (await q('SELECT COUNT(*) FROM users')).rows[0].count;
    const friends  = (await q("SELECT COUNT(*) FROM friends WHERE status='accepted'")).rows[0].count;
    const messages = (await q('SELECT COUNT(*) FROM messages')).rows[0].count;
    const reports  = (await q("SELECT COUNT(*) FROM reports WHERE status='open'")).rows[0].count;
    res.json({ users: parseInt(users), friends: parseInt(friends), messages: parseInt(messages), reports: parseInt(reports), online: online.size });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/users', auth, async (req, res) => {
  if (!await isAdminUser(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  const query = (req.query.q || '').trim();
  try {
    const sql = query.length >= 1
      ? 'SELECT id, username, display_name as "displayName", banned, ban_until as "banUntil", ban_reason as "banReason", is_admin as "isAdmin" FROM users WHERE username ILIKE $1 ORDER BY created_at DESC LIMIT 50'
      : 'SELECT id, username, display_name as "displayName", banned, ban_until as "banUntil", ban_reason as "banReason", is_admin as "isAdmin" FROM users ORDER BY created_at DESC LIMIT 50';
    const r = await q(sql, query.length >= 1 ? ['%' + query + '%'] : []);
    const now = Math.floor(Date.now() / 1000);
    const rows = r.rows.map(u => {
      if (u.banned && u.banUntil && u.banUntil <= now) {
        return { ...u, banned: false, banUntil: null, banReason: null };
      }
      return u;
    });
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/reports', auth, async (req, res) => {
  if (!await isAdminUser(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await q(`SELECT rp.id, rp.reason, rp.text, rp.created_at,
      u1.username as reporter_username, u2.id as reported_id, u2.username as reported_username
      FROM reports rp
      JOIN users u1 ON rp.reporter_id=u1.id
      JOIN users u2 ON rp.reported_id=u2.id
      WHERE rp.status='open' ORDER BY rp.created_at DESC LIMIT 100`);
    res.json(r.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/users/:userId/ban', auth, async (req, res) => {
  if (!await isAdminUser(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  const { reason } = req.body;
  const targetId = req.params.userId;
  if (await isDevUser(targetId)) return res.status(403).json({ error: 'Нельзя заблокировать этого пользователя' });
  try {
    await q('UPDATE users SET banned=TRUE, ban_until=NULL, ban_reason=$1 WHERE id=$2', [reason || null, targetId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/users/:userId/ban-temp', auth, async (req, res) => {
  if (!await isAdminUser(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  const { durationMinutes, reason } = req.body;
  if (!durationMinutes || durationMinutes <= 0) return res.status(400).json({ error: 'Укажи durationMinutes > 0' });
  const targetId = req.params.userId;
  if (await isDevUser(targetId)) return res.status(403).json({ error: 'Нельзя заблокировать этого пользователя' });
  try {
    const until = Math.floor(Date.now() / 1000) + Math.floor(durationMinutes * 60);
    await q('UPDATE users SET banned=TRUE, ban_until=$1, ban_reason=$2 WHERE id=$3', [until, reason || null, targetId]);
    res.json({ ok: true, until });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/users/:userId/unban', auth, async (req, res) => {
  if (!await isAdminUser(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  try {
    await q('UPDATE users SET banned=FALSE, ban_until=NULL, ban_reason=NULL WHERE id=$1', [req.params.userId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/users/:userId/grant-admin', auth, async (req, res) => {
  if (!await isDevUser(req.userId)) return res.status(403).json({ error: 'Только @dev может выдавать права администратора' });
  const targetId = req.params.userId;
  try {
    await q('UPDATE users SET is_admin=TRUE WHERE id=$1', [targetId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// FIX: Change user ID — now returns new token for the affected user
app.post('/admin/users/:userId/change-id', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const callerRow = await q('SELECT username FROM users WHERE id=$1', [req.userId]);
    const callerName = callerRow.rows[0]?.username || '(not found)';
    if (!await isDevUser(req.userId)) return res.status(403).json({ error: `Только @dev может менять ID. Ваш ник: ${callerName}, ID: ${req.userId}` });
    const { newId } = req.body;
    if (!newId || String(newId).trim().length < 1 || String(newId).length > 128) {
      return res.status(400).json({ error: 'ID не может быть пустым или длиннее 128 символов' });
    }
    const trimmedNewId = String(newId).trim();
    const targetId = req.params.userId;
    if (trimmedNewId === targetId) return res.json({ ok: true, newId: trimmedNewId });
    const existing = await client.query('SELECT id FROM users WHERE id=$1', [trimmedNewId]);
    if (existing.rows.length) return res.status(409).json({ error: 'Этот ID уже занят' });

    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query('UPDATE users SET id=$1 WHERE id=$2', [trimmedNewId, targetId]);
    await client.query('UPDATE linked_accounts SET user_id=$1 WHERE user_id=$2', [trimmedNewId, targetId]);
    await client.query('UPDATE friends SET user_id=$1 WHERE user_id=$2', [trimmedNewId, targetId]);
    await client.query('UPDATE friends SET friend_id=$1 WHERE friend_id=$2', [trimmedNewId, targetId]);
    await client.query('UPDATE messages SET from_id=$1 WHERE from_id=$2', [trimmedNewId, targetId]);
    await client.query('UPDATE messages SET to_id=$1 WHERE to_id=$2', [trimmedNewId, targetId]);
    await client.query('UPDATE blocks SET user_id=$1 WHERE user_id=$2', [trimmedNewId, targetId]);
    await client.query('UPDATE blocks SET blocked_id=$1 WHERE blocked_id=$2', [trimmedNewId, targetId]);
    await client.query('UPDATE reports SET reporter_id=$1 WHERE reporter_id=$2', [trimmedNewId, targetId]);
    await client.query('UPDATE reports SET reported_id=$1 WHERE reported_id=$2', [trimmedNewId, targetId]);
    await client.query('COMMIT');

    // FIX: Update the online map so the WS connection still works after ID change
    const oldWs = online.get(targetId);
    if (oldWs) {
      online.delete(targetId);
      online.set(trimmedNewId, oldWs);
      // Send the user a new valid token so their next requests work
      oldWs.send(JSON.stringify({ type: 'id_changed', newId: trimmedNewId, newToken: signToken(trimmedNewId) }));
    }

    res.json({ ok: true, newId: trimmedNewId, newToken: signToken(trimmedNewId) });
  } catch(e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[change-id]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/admin/users/:userId/revoke-admin', auth, async (req, res) => {
  if (!await isDevUser(req.userId)) return res.status(403).json({ error: 'Только @dev может снимать права администратора' });
  const targetId = req.params.userId;
  if (await isDevUser(targetId)) return res.status(403).json({ error: 'Нельзя снять роль у @dev' });
  try {
    await q('UPDATE users SET is_admin=FALSE WHERE id=$1', [targetId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/reports/:reportId', auth, async (req, res) => {
  if (!await isAdminUser(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  try {
    await q("UPDATE reports SET status='closed' WHERE id=$1", [req.params.reportId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/users/:userId', auth, async (req, res) => {
  if (!await isAdminUser(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  if (await isDevUser(req.params.userId)) return res.status(403).json({ error: 'Нельзя удалить этого пользователя' });
  try {
    await q('DELETE FROM users WHERE id=$1', [req.params.userId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const online = new Map();

function broadcast(targetId, payload) {
  const ws = online.get(targetId);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

async function broadcastToFriends(userId, payload) {
  try {
    const r = await q(`SELECT CASE WHEN user_id=$1 THEN friend_id ELSE user_id END as fid FROM friends WHERE (user_id=$1 OR friend_id=$1) AND status='accepted'`, [userId]);
    r.rows.forEach(({ fid }) => broadcast(fid, payload));
  } catch {}
}

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth') {
      try {
        const decoded = jwt.verify(msg.token, JWT_SECRET);
        userId = decoded.sub;

        // FIX: verify user exists (handles stale tokens after ID change)
        const userExists = await q('SELECT id FROM users WHERE id=$1', [userId]);
        if (!userExists.rows.length) {
          ws.send(JSON.stringify({ type: 'error', message: 'User not found', reauth: true }));
          ws.close();
          return;
        }

        online.set(userId, ws);

        const friendsRows = (await q(`SELECT u.id, u.username, u.display_name as "displayName", u.is_admin as "isAdmin" FROM friends f JOIN users u ON (CASE WHEN f.user_id=$1 THEN f.friend_id ELSE f.user_id END = u.id) WHERE (f.user_id=$1 OR f.friend_id=$1) AND f.status='accepted'`, [userId])).rows;

        // FIX: also send pending friend requests so user sees them immediately on connect
        const pendingRows = (await q(`SELECT u.id, u.username, u.display_name as "displayName", f.id as "requestId" FROM friends f JOIN users u ON f.user_id=u.id WHERE f.friend_id=$1 AND f.status='pending'`, [userId])).rows;

        ws.send(JSON.stringify({
          type: 'auth_ok',
          friends: friendsRows.map(f => ({ ...f, online: online.has(f.id) })),
          pendingRequests: pendingRows,  // FIX: deliver missed friend requests
        }));

        broadcastToFriends(userId, { type: 'friend_online', userId });
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
        ws.close();
      }
      return;
    }
    if (!userId) return;

    if (msg.type === 'presence') { broadcastToFriends(userId, { type: 'presence', userId, data: msg.data }); return; }

    if (msg.type === 'message') {
      const { toId, content } = msg;
      if (!toId || !content) return;
      const trimmed = String(content).trim().slice(0, 2000);
      if (!trimmed) return;
      const fr = await q(`SELECT 1 FROM friends WHERE ((user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)) AND status='accepted'`, [userId, toId]);
      if (!fr.rows.length) return;
      const ts = Math.floor(Date.now() / 1000);
      const ins = await q('INSERT INTO messages (from_id,to_id,content,created_at) VALUES ($1,$2,$3,$4) RETURNING id', [userId, toId, trimmed, ts]);
      const payload = { type: 'message', id: ins.rows[0].id, fromId: userId, toId, content: trimmed, ts };
      broadcast(toId, payload);
      ws.send(JSON.stringify(payload));
      return;
    }

    if (msg.type === 'join_request') { broadcast(msg.toId, { type: 'join_request', fromId: userId, server: msg.server }); }
  });

  ws.on('close', () => {
    if (userId) {
      online.delete(userId);
      broadcastToFriends(userId, { type: 'friend_offline', userId });
    }
  });
  ws.on('error', () => {});
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => console.log(`MidLauncher Social — port ${PORT}`));
}).catch(e => {
  console.error('[DB] Init failed:', e.message);
  process.exit(1);
});
