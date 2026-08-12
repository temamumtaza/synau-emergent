import 'dotenv/config';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const defaultDbPath = path.resolve(process.cwd(), '.data', 'synau.db');
const configuredDbPath = process.env.SYNAU_DB_PATH ?? defaultDbPath;
const dbPath = configuredDbPath === ':memory:' ? configuredDbPath : path.resolve(configuredDbPath);

// The database contains session tokens and user-provided model keys. Keep newly
// created SQLite files private even when the caller has a permissive shell umask.
process.umask(0o077);

if (dbPath !== ':memory:') {
  const dbDirectory = path.dirname(dbPath);
  const directoryAlreadyExisted = fs.existsSync(dbDirectory);
  fs.mkdirSync(dbDirectory, { recursive: true, mode: 0o700 });
  if (!directoryAlreadyExisted || dbPath === defaultDbPath) {
    fs.chmodSync(dbDirectory, 0o700);
  }
  if (fs.existsSync(dbPath)) {
    fs.chmodSync(dbPath, 0o600);
  }
}

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

if (dbPath !== ':memory:') {
  for (const suffix of ['', '-wal', '-shm']) {
    const sqlitePath = `${dbPath}${suffix}`;
    if (fs.existsSync(sqlitePath)) {
      fs.chmodSync(sqlitePath, 0o600);
    }
  }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    outcomes_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS course_sections (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    section_id TEXT NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    estimated_minutes INTEGER NOT NULL,
    position INTEGER NOT NULL,
    material_json TEXT,
    last_generated_at TEXT,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS lesson_generation_locks (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    lesson_title TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    quiz_json TEXT NOT NULL,
    score INTEGER,
    completed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS progress_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    lesson_id TEXT,
    event_type TEXT NOT NULL,
    data_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credit_accounts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credit_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    delta INTEGER NOT NULL,
    reference_id TEXT NOT NULL,
    description TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, reference_id)
  );
  CREATE TABLE IF NOT EXISTS llm_usage (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    generation_id TEXT NOT NULL UNIQUE,
    generator TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    credit_cost INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credit_topups (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL UNIQUE,
    product_id TEXT NOT NULL,
    credits INTEGER NOT NULL,
    amount_idr INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    snap_token TEXT,
    redirect_url TEXT,
    midtrans_transaction_id TEXT,
    payment_type TEXT,
    raw_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    settled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS auth_challenges (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    identifier TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_courses_user ON courses(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sections_course ON course_sections(course_id, position);
  CREATE INDEX IF NOT EXISTS idx_lessons_section ON lessons(section_id, position);
  CREATE INDEX IF NOT EXISTS idx_events_course ON progress_events(course_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_llm_usage_user ON llm_usage(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_credit_topups_user ON credit_topups(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_auth_challenges_identifier ON auth_challenges(mode, identifier, created_at DESC);
`);

// Older local databases predate passwordless auth. Keep the legacy secret
// column for a non-destructive migration, but add and populate the identity
// fields used by the only supported auth flow.
const userColumns = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((column) => column.name));
if (!userColumns.has('first_name')) db.exec("ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT ''");
if (!userColumns.has('last_name')) db.exec("ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT ''");
if (!userColumns.has('username')) db.exec("ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT ''");

const normalizeLegacyUsername = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
const existingUsers = db.prepare('SELECT id, email, name, first_name, last_name, username FROM users ORDER BY created_at, id').all() as Array<{
  id: string;
  email: string;
  name: string;
  first_name: string;
  last_name: string;
  username: string;
}>;
const usedUsernames = new Set<string>();
for (const user of existingUsers) {
  const nameParts = user.name.trim().split(/\s+/).filter(Boolean);
  const firstName = user.first_name.trim() || nameParts[0] || 'Learner';
  const lastName = user.last_name.trim() || nameParts.slice(1).join(' ') || 'Learner';
  const preferred = normalizeLegacyUsername(user.username.trim() || user.email.split('@')[0]) || `user${user.id.replace(/[^a-z0-9]/gi, '').slice(0, 8)}`;
  let username = preferred;
  let suffix = 2;
  while (usedUsernames.has(username) || username.length < 3) {
    const suffixText = String(suffix++);
    username = `${preferred.slice(0, Math.max(3, 32 - suffixText.length))}${suffixText}`;
  }
  usedUsernames.add(username);
  db.prepare('UPDATE users SET first_name = ?, last_name = ?, username = ?, name = ? WHERE id = ?')
    .run(firstName, lastName, username, `${firstName} ${lastName}`.trim(), user.id);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)');

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

export function json<T>(value: T): string {
  return JSON.stringify(value);
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function cleanExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
}
