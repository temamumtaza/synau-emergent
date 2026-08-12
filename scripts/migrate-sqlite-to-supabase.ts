import 'dotenv/config';
import Database from 'better-sqlite3';
import { getSupabaseAdmin } from '../server/supabase.js';

const dbPath = process.env.SYNAU_DB_PATH ?? '.data/synau.db';
const localDb = new Database(dbPath, { readonly: true });
const supabase = getSupabaseAdmin();

function parseJson(value: string | null) {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function read<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>) {
  const result = await query;
  if (result.error) throw new Error(`Supabase migration query failed: ${result.error.message}`);
  return result.data;
}

async function upsert(table: string, rows: Record<string, unknown>[], onConflict = 'id') {
  if (!rows.length) return;
  for (let index = 0; index < rows.length; index += 200) {
    await read(supabase.from(table).upsert(rows.slice(index, index + 200), { onConflict }));
  }
}

async function allAuthUsers() {
  const users: Array<{ id: string; email?: string | null }> = [];
  for (let page = 1; ; page += 1) {
    const result = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (result.error) throw new Error(`Supabase Auth migration query failed: ${result.error.message}`);
    users.push(...result.data.users);
    if (result.data.users.length < 1000) return users;
  }
}

async function ensureAuthUser(row: { id: string; email: string; first_name: string; last_name: string; username: string }) {
  const existingProfile = await read(supabase.from('users').select('auth_user_id').eq('id', row.id).maybeSingle<{ auth_user_id: string | null }>());
  if (existingProfile?.auth_user_id) return existingProfile.auth_user_id;
  const authUsers = await allAuthUsers();
  const existing = authUsers.find((user) => user.email?.toLowerCase() === row.email.toLowerCase());
  if (existing) return existing.id;
  const created = await supabase.auth.admin.createUser({
    email: row.email,
    email_confirm: true,
    user_metadata: { first_name: row.first_name, last_name: row.last_name, username: row.username },
  });
  if (created.error || !created.data.user) throw new Error(`Could not migrate Auth user ${row.email}: ${created.error?.message ?? 'unknown error'}`);
  return created.data.user.id;
}

async function count(table: string) {
  const result = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (result.error) throw new Error(`Could not count ${table}: ${result.error.message}`);
  return result.count ?? 0;
}

const localUsers = localDb.prepare('SELECT id, email, first_name, last_name, username, name, created_at FROM users ORDER BY created_at, id').all() as Array<{
  id: string; email: string; first_name: string; last_name: string; username: string; name: string; created_at: string;
}>;

const authIds = new Map<string, string>();
for (const user of localUsers) {
  authIds.set(user.id, await ensureAuthUser(user));
}
await upsert('users', localUsers.map((user) => ({
  id: user.id, auth_user_id: authIds.get(user.id), email: user.email, first_name: user.first_name,
  last_name: user.last_name, username: user.username, name: user.name, created_at: user.created_at,
})));

await upsert('sessions', (localDb.prepare('SELECT token, user_id, expires_at, created_at FROM sessions').all() as Array<Record<string, unknown>>), 'token');
await upsert('courses', (localDb.prepare('SELECT id, user_id, topic, title, description, outcomes_json, status, created_at, updated_at FROM courses').all() as Array<Record<string, unknown>>).map((row) => ({ ...row, outcomes_json: parseJson(row.outcomes_json as string) ?? [] })));
await upsert('course_sections', (localDb.prepare('SELECT id, course_id, title, summary, position FROM course_sections').all() as Array<Record<string, unknown>>));
await upsert('lessons', (localDb.prepare('SELECT id, section_id, title, summary, estimated_minutes, position, material_json, last_generated_at, completed_at FROM lessons').all() as Array<Record<string, unknown>>).map((row) => ({ ...row, material_json: parseJson(row.material_json as string | null) })));
await upsert('lesson_generation_locks', (localDb.prepare('SELECT user_id, course_id, lesson_id, lesson_title, created_at FROM lesson_generation_locks').all() as Array<Record<string, unknown>>), 'user_id');
await upsert('quiz_attempts', (localDb.prepare('SELECT id, user_id, course_id, scope, scope_id, quiz_json, score, completed_at, created_at FROM quiz_attempts').all() as Array<Record<string, unknown>>).map((row) => ({ ...row, quiz_json: parseJson(row.quiz_json as string) ?? {} })));
await upsert('progress_events', (localDb.prepare('SELECT id, user_id, course_id, lesson_id, event_type, data_json, created_at FROM progress_events').all() as Array<Record<string, unknown>>).map((row) => ({ ...row, data_json: parseJson(row.data_json as string | null) })));
await upsert('credit_accounts', (localDb.prepare('SELECT user_id, balance, updated_at FROM credit_accounts').all() as Array<Record<string, unknown>>), 'user_id');
await upsert('credit_ledger', (localDb.prepare('SELECT id, user_id, type, delta, reference_id, description, metadata_json, created_at FROM credit_ledger').all() as Array<Record<string, unknown>>).map((row) => ({ ...row, metadata_json: parseJson(row.metadata_json as string | null) })));
await upsert('llm_usage', (localDb.prepare('SELECT id, user_id, generation_id, generator, provider_id, model, input_tokens, cached_input_tokens, output_tokens, total_tokens, request_count, credit_cost, status, metadata_json, created_at FROM llm_usage').all() as Array<Record<string, unknown>>).map((row) => ({ ...row, metadata_json: parseJson(row.metadata_json as string | null) })));
await upsert('credit_topups', (localDb.prepare('SELECT id, user_id, order_id, product_id, credits, amount_idr, status, snap_token, redirect_url, midtrans_transaction_id, payment_type, raw_json, created_at, updated_at, settled_at FROM credit_topups').all() as Array<Record<string, unknown>>).map((row) => ({ ...row, raw_json: parseJson(row.raw_json as string | null) })));
await upsert('auth_challenges', (localDb.prepare('SELECT id, mode, identifier, email, first_name, last_name, username, code_hash, attempts, expires_at, consumed_at, created_at FROM auth_challenges').all() as Array<Record<string, unknown>>));

const tables = ['users', 'sessions', 'courses', 'course_sections', 'lessons', 'lesson_generation_locks', 'quiz_attempts', 'progress_events', 'credit_accounts', 'credit_ledger', 'llm_usage', 'credit_topups', 'auth_challenges'];
const counts: Record<string, number> = {};
for (const table of tables) counts[table] = await count(table);
console.log(JSON.stringify({ ok: true, source: dbPath, migratedUsers: localUsers.length, authUsers: authIds.size, counts }, null, 2));
localDb.close();
