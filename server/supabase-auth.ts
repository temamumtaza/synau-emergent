import crypto from 'node:crypto';
import type { AuthCodeRequest, AuthCodeVerify } from '../shared/schemas.js';
import { newId, nowIso } from './db.js';
import { getSupabaseAdmin, getSupabaseAuthClient } from './supabase.js';
import type { UserRecord } from './auth.js';
import { AuthFlowError, normalizeUsername } from './auth.js';

const DEMO_EMAIL = 'demo@synau.local';
const DEMO_CODE = '020599';
const AUTH_CODE_TTL_MS = Math.max(60_000, Number(process.env.SYNAU_AUTH_CODE_TTL_MINUTES ?? 10) * 60_000);
const AUTH_CODE_RESEND_COOLDOWN_MS = Math.max(5_000, Number(process.env.SYNAU_AUTH_CODE_RESEND_COOLDOWN_SECONDS ?? 45) * 1_000);
const AUTH_CODE_MAX_ATTEMPTS = 5;
const AUTH_CODE_SECRET = (process.env.SYNAU_AUTH_CODE_SECRET ?? 'synau-local-auth-code-secret-change-me').trim();

type RemoteChallenge = {
  id: string;
  mode: 'sign_in' | 'sign_up';
  identifier: string;
  email: string;
  first_name: string;
  last_name: string;
  username: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

type RemoteProfile = {
  id: string;
  auth_user_id: string | null;
  email: string;
  first_name: string;
  last_name: string;
  username: string;
  name: string;
};

async function read<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>) {
  const result = await query;
  if (result.error) throw new Error(`Supabase auth query failed: ${result.error.message}`);
  return result.data;
}

function hash(challengeId: string, code: string) {
  return crypto.createHmac('sha256', AUTH_CODE_SECRET).update(`${challengeId}:${code}`).digest('hex');
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function displayName(firstName: string, lastName: string) {
  return `${firstName.trim()} ${lastName.trim()}`.trim();
}

function maskEmail(email: string) {
  if (!email || !email.includes('@')) return 'your email address';
  const [local, domain] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

function profileUser(profile: RemoteProfile): UserRecord {
  return {
    id: profile.id,
    email: profile.email,
    first_name: profile.first_name,
    last_name: profile.last_name,
    username: profile.username,
    name: profile.name,
  };
}

async function profileByEmail(email: string) {
  return read(getSupabaseAdmin().from('users').select('*').eq('email', normalizeEmail(email)).maybeSingle<RemoteProfile>());
}

async function profileByUsername(username: string) {
  return read(getSupabaseAdmin().from('users').select('*').eq('username', normalizeUsername(username)).maybeSingle<RemoteProfile>());
}

export async function remoteGetUserById(id: string) {
  const profile = await read(getSupabaseAdmin().from('users').select('*').eq('id', id).maybeSingle<RemoteProfile>());
  return profile ? profileUser(profile) : undefined;
}

export async function remoteGetUserByAuthId(authUserId: string) {
  const profile = await read(getSupabaseAdmin().from('users').select('*').eq('auth_user_id', authUserId).maybeSingle<RemoteProfile>());
  return profile ? profileUser(profile) : undefined;
}

export async function remoteGetUserByLoginIdentifier(identifier: string) {
  const normalized = identifier.trim().toLowerCase();
  const profile = normalized.includes('@') ? await profileByEmail(normalized) : await profileByUsername(normalized);
  return profile ? profileUser(profile) : undefined;
}

async function remoteGetChallenge(id: string) {
  return read(getSupabaseAdmin().from('auth_challenges').select('*').eq('id', id).maybeSingle<RemoteChallenge>());
}

function challengeResponse(challengeId: string, email: string, expiresAt: string, isDemo: boolean, message: string) {
  return {
    challengeId,
    maskedEmail: maskEmail(email),
    expiresAt,
    retryAfterSeconds: Math.ceil(AUTH_CODE_RESEND_COOLDOWN_MS / 1_000),
    isDemo,
    message,
  };
}

export async function requestSupabaseAuthCode(input: AuthCodeRequest) {
  const isSignUp = input.mode === 'sign_up';
  const identifier = isSignUp ? normalizeEmail(input.email) : input.identifier.trim().toLowerCase();
  const existingUser = isSignUp ? undefined : await remoteGetUserByLoginIdentifier(identifier);
  if (isSignUp) {
    if (await profileByEmail(input.email)) throw new AuthFlowError('An account with that email already exists. Sign in to continue.', 409, 'email_already_registered');
    if (await profileByUsername(input.username)) throw new AuthFlowError('That username is already taken. Choose another one.', 409, 'username_already_registered');
  }
  const recent = await read(getSupabaseAdmin().from('auth_challenges').select('created_at').eq('mode', input.mode).eq('identifier', identifier).is('consumed_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle<{ created_at: string }>()).catch(() => null);
  if (recent && Date.now() - new Date(recent.created_at).getTime() < AUTH_CODE_RESEND_COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((AUTH_CODE_RESEND_COOLDOWN_MS - (Date.now() - new Date(recent.created_at).getTime())) / 1_000);
    throw new AuthFlowError(`Please wait ${retryAfterSeconds} seconds before requesting another code.`, 429, 'auth_code_cooldown', retryAfterSeconds);
  }

  const email = isSignUp ? normalizeEmail(input.email) : existingUser?.email ?? (identifier.includes('@') ? identifier : '');
  const isDemo = existingUser?.email === DEMO_EMAIL;
  if (!existingUser && !isSignUp) {
    // Keep the account-enumeration-safe behavior of the local flow.
    return challengeResponse(newId(), email, new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(), false, 'If an account exists for that email or username, a verification code has been sent.');
  }

  const challengeId = newId();
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString();
  await read(getSupabaseAdmin().from('auth_challenges').update({ consumed_at: nowIso() }).eq('mode', input.mode).eq('identifier', identifier).is('consumed_at', null));
  await read(getSupabaseAdmin().from('auth_challenges').insert({
    id: challengeId,
    mode: input.mode,
    identifier,
    email,
    first_name: isSignUp ? input.firstName.trim() : existingUser?.first_name ?? '',
    last_name: isSignUp ? input.lastName.trim() : existingUser?.last_name ?? '',
    username: isSignUp ? normalizeUsername(input.username) : existingUser?.username ?? '',
    code_hash: isDemo ? hash(challengeId, DEMO_CODE) : 'supabase-managed',
    expires_at: expiresAt,
    created_at: nowIso(),
  }));

  if (isDemo) {
    return challengeResponse(challengeId, email, expiresAt, true, 'Demo account recognized. Enter the demo verification code to continue.');
  }

  const auth = getSupabaseAuthClient();
  const { error } = await auth.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: isSignUp,
      data: isSignUp ? {
        first_name: input.firstName.trim(),
        last_name: input.lastName.trim(),
        username: normalizeUsername(input.username),
      } : undefined,
    },
  });
  if (error) {
    await read(getSupabaseAdmin().from('auth_challenges').delete().eq('id', challengeId));
    throw new AuthFlowError('We could not send the verification email. Please try again shortly.', 503, 'email_delivery_failed');
  }
  return challengeResponse(challengeId, email, expiresAt, false, `We sent a verification code to ${maskEmail(email)}.`);
}

async function ensureProfile(authUser: { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null }, challenge: RemoteChallenge) {
  const existing = await remoteGetUserByAuthId(authUser.id);
  if (existing) return { user: existing, created: false };
  const firstName = challenge.first_name || String(authUser.user_metadata?.first_name ?? 'Learner');
  const lastName = challenge.last_name || String(authUser.user_metadata?.last_name ?? 'User');
  const username = challenge.username || normalizeUsername(String(authUser.user_metadata?.username ?? (authUser.email ?? '').split('@')[0]));
  const email = normalizeEmail(authUser.email ?? challenge.email);
  const created = await read(getSupabaseAdmin().from('users').insert({
    id: newId(),
    auth_user_id: authUser.id,
    email,
    first_name: firstName,
    last_name: lastName,
    username,
    name: displayName(firstName, lastName),
  }).select('*').single<RemoteProfile>());
  if (!created) throw new AuthFlowError('Could not create your Synau profile. Please try again.', 503, 'profile_creation_failed');
  return { user: profileUser(created), created: true };
}

export async function verifySupabaseAuthCode(input: AuthCodeVerify) {
  const challenge = await remoteGetChallenge(input.challengeId);
  if (!challenge || challenge.consumed_at) throw new AuthFlowError('This verification code is no longer valid. Request a new code.', 400, 'auth_code_invalid');
  if (new Date(challenge.expires_at).getTime() <= Date.now()) throw new AuthFlowError('This verification code has expired. Request a new code.', 400, 'auth_code_expired');
  if (challenge.attempts >= AUTH_CODE_MAX_ATTEMPTS) throw new AuthFlowError('Too many incorrect attempts. Request a new code.', 429, 'auth_code_locked');
  await read(getSupabaseAdmin().from('auth_challenges').update({ attempts: challenge.attempts + 1 }).eq('id', challenge.id));

  if (challenge.email === DEMO_EMAIL) {
    const expected = Buffer.from(challenge.code_hash, 'hex');
    const received = Buffer.from(hash(challenge.id, input.code), 'hex');
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      const remaining = Math.max(0, AUTH_CODE_MAX_ATTEMPTS - challenge.attempts - 1);
      throw new AuthFlowError(remaining ? `That code is incorrect. ${remaining} attempts remaining.` : 'That code is incorrect. Request a new code.', remaining ? 400 : 429, remaining ? 'auth_code_incorrect' : 'auth_code_locked');
    }
    const user = await remoteGetUserByLoginIdentifier(challenge.identifier);
    if (!user) throw new AuthFlowError('This verification code is no longer valid. Request a new code.', 400, 'auth_code_invalid');
    const token = crypto.randomBytes(32).toString('hex');
    await read(getSupabaseAdmin().from('sessions').insert({ token, user_id: user.id, expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString(), created_at: nowIso() }));
    await read(getSupabaseAdmin().from('auth_challenges').update({ consumed_at: nowIso() }).eq('id', challenge.id));
    return { token, user, created: false };
  }

  const { data, error } = await getSupabaseAuthClient().auth.verifyOtp({ email: challenge.email, token: input.code, type: 'email' });
  if (error || !data.user || !data.session?.access_token) {
    const remaining = Math.max(0, AUTH_CODE_MAX_ATTEMPTS - challenge.attempts - 1);
    throw new AuthFlowError(remaining ? `That code is incorrect. ${remaining} attempts remaining.` : 'That code is incorrect. Request a new code.', remaining ? 400 : 429, remaining ? 'auth_code_incorrect' : 'auth_code_locked');
  }
  const ensured = await ensureProfile(data.user, challenge);
  await read(getSupabaseAdmin().from('auth_challenges').update({ consumed_at: nowIso() }).eq('id', challenge.id));
  return { token: data.session.access_token, user: ensured.user, created: ensured.created };
}

export async function remoteUserForToken(token: string) {
  const { data } = await getSupabaseAdmin().auth.getUser(token);
  if (data.user) return remoteGetUserByAuthId(data.user.id);
  const session = await read(getSupabaseAdmin().from('sessions').select('user_id').eq('token', token).gt('expires_at', nowIso()).maybeSingle<{ user_id: string }>()).catch(() => null);
  return session ? remoteGetUserById(session.user_id) : undefined;
}

export async function remoteRevokeSession(token: string) {
  await read(getSupabaseAdmin().from('sessions').delete().eq('token', token));
}
