import crypto from 'node:crypto';
import type { GoogleAuthRequest } from '../shared/schemas.js';
import { newId, nowIso } from './utils.js';
import { getSupabaseAdmin } from './supabase.js';
import { recordSupabaseQuery } from './performance.js';
import type { UserRecord } from './auth.js';
import { AuthFlowError, normalizeUsername } from './auth.js';

type RemoteProfile = {
  id: string;
  auth_user_id: string | null;
  email: string;
  first_name: string;
  last_name: string;
  username: string;
  name: string;
};

type GoogleAuthUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: Record<string, unknown> | null;
};

const verifiedTokenCache = new Map<string, { expiresAt: number; user: UserRecord | undefined }>();
const verifiedTokenFlights = new Map<string, Promise<UserRecord | undefined>>();
const verifiedTokenCacheMs = Math.max(0, Math.min(30_000, Number(process.env.SYNAU_AUTH_CACHE_MS ?? 5_000)));
const sessionTtlDays = Math.max(1, Math.min(30, Number(process.env.SYNAU_SESSION_TTL_DAYS ?? 30)));

function sessionTokenHash(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function read<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>) {
  const startedAt = performance.now();
  let result: { data: T; error: { message: string } | null };
  try {
    result = await query;
  } finally {
    recordSupabaseQuery(performance.now() - startedAt);
  }
  if (result.error) throw new Error(`Supabase auth query failed: ${result.error.message}`);
  return result.data;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function displayName(firstName: string, lastName: string) {
  return `${firstName.trim()} ${lastName.trim()}`.trim();
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

async function profileByAuthId(authUserId: string) {
  return read(getSupabaseAdmin().from('users').select('*').eq('auth_user_id', authUserId).maybeSingle<RemoteProfile>());
}

export async function remoteGetUserById(id: string) {
  const profile = await read(getSupabaseAdmin().from('users').select('*').eq('id', id).maybeSingle<RemoteProfile>());
  return profile ? profileUser(profile) : undefined;
}

export async function remoteGetUserByAuthId(authUserId: string) {
  const profile = await profileByAuthId(authUserId);
  return profile ? profileUser(profile) : undefined;
}

export async function remoteGetUserByLoginIdentifier(identifier: string) {
  const normalized = identifier.trim().toLowerCase();
  const profile = normalized.includes('@') ? await profileByEmail(normalized) : await profileByUsername(normalized);
  return profile ? profileUser(profile) : undefined;
}

function metadataString(user: GoogleAuthUser, ...keys: string[]) {
  for (const key of keys) {
    const value = user.user_metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function usernameSuggestion(user: GoogleAuthUser, email: string) {
  const source = metadataString(user, 'username', 'preferred_username', 'given_name') || email.split('@')[0] || 'learner';
  let suggestion = source.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 32);
  suggestion = suggestion.replace(/[^a-z0-9]$/g, '');
  if (suggestion.length < 3) suggestion = `${suggestion || 'synau'}learner`.slice(0, 32);
  return suggestion;
}

function googleProfileSuggestion(user: GoogleAuthUser, email: string) {
  const fullName = metadataString(user, 'full_name', 'name');
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  const firstName = metadataString(user, 'given_name', 'first_name') || nameParts[0] || 'Learner';
  const lastName = metadataString(user, 'family_name', 'last_name') || nameParts.slice(1).join(' ') || 'User';
  return {
    email,
    firstName: firstName.slice(0, 60),
    lastName: lastName.slice(0, 60),
    username: usernameSuggestion(user, email),
  };
}

function hasGoogleIdentity(user: GoogleAuthUser) {
  const provider = user.app_metadata?.provider;
  const providers = user.app_metadata?.providers;
  return provider === 'google' || (Array.isArray(providers) && providers.includes('google'));
}

async function verifiedGoogleUser(accessToken: string) {
  const startedAt = performance.now();
  const { data, error } = await getSupabaseAdmin().auth.getUser(accessToken);
  recordSupabaseQuery(performance.now() - startedAt);
  if (error || !data.user) {
    throw new AuthFlowError('Google sign-in could not be verified. Start again from the Google button.', 401, 'google_token_invalid');
  }
  const user = data.user as GoogleAuthUser;
  if (!hasGoogleIdentity(user)) {
    throw new AuthFlowError('This Synau environment accepts Google accounts only. Start again with Google.', 403, 'google_auth_only');
  }
  const email = normalizeEmail(user.email ?? '');
  if (!email || !email.includes('@')) {
    throw new AuthFlowError('Google did not provide a usable email address for this account.', 400, 'google_email_missing');
  }
  return { user, email };
}

async function linkExistingEmailProfile(user: GoogleAuthUser, email: string) {
  const existing = await profileByEmail(email);
  if (!existing) return undefined;
  if (existing.auth_user_id && existing.auth_user_id !== user.id) {
    throw new AuthFlowError('This email is already linked to another Synau identity.', 409, 'google_account_conflict');
  }
  if (!existing.auth_user_id) {
    const linked = await read(getSupabaseAdmin().from('users').update({ auth_user_id: user.id }).eq('id', existing.id).is('auth_user_id', null).select('*').maybeSingle<RemoteProfile>());
    if (!linked) throw new AuthFlowError('Synau could not link this Google account yet. Please try again.', 503, 'google_profile_link_failed');
    return profileUser(linked);
  }
  return profileUser(existing);
}

export async function completeSupabaseGoogleAuth(input: GoogleAuthRequest) {
  const { user: authUser, email } = await verifiedGoogleUser(input.accessToken);
  const existingByAuthId = await profileByAuthId(authUser.id);
  if (existingByAuthId) {
    return { status: 'authenticated' as const, user: profileUser(existingByAuthId), created: false };
  }

  // A migrated Synau account can be linked to Google by its verified email,
  // without asking the learner to recreate their profile.
  const linkedProfile = await linkExistingEmailProfile(authUser, email);
  if (linkedProfile) {
    return { status: 'authenticated' as const, user: linkedProfile, created: false };
  }

  const suggestion = googleProfileSuggestion(authUser, email);
  const hasAllProfileFields = Boolean(input.firstName && input.lastName && input.username);
  if (!hasAllProfileFields) {
    return { status: 'profile_required' as const, profile: suggestion };
  }

  const firstName = input.firstName!.trim();
  const lastName = input.lastName!.trim();
  const username = normalizeUsername(input.username!);
  const usernameConflict = await profileByUsername(username);
  if (usernameConflict) {
    throw new AuthFlowError('That username is already taken. Choose another one.', 409, 'username_already_registered');
  }

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
  return { status: 'authenticated' as const, user: profileUser(created), created: true };
}

export async function remoteCreateSession(userId: string) {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + sessionTtlDays * 24 * 60 * 60 * 1_000).toISOString();
  await read(getSupabaseAdmin().from('sessions').insert({
    token: sessionTokenHash(token),
    user_id: userId,
    expires_at: expiresAt,
  }));
  return { token, expiresAt };
}

export async function remoteUserForToken(token: string) {
  const cacheKey = crypto.createHash('sha256').update(token).digest('hex');
  const cached = verifiedTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  if (cached) verifiedTokenCache.delete(cacheKey);

  const existingFlight = verifiedTokenFlights.get(cacheKey);
  if (existingFlight) return existingFlight;
  const flight = remoteUserForTokenUncached(token, cacheKey).finally(() => {
    if (verifiedTokenFlights.get(cacheKey) === flight) verifiedTokenFlights.delete(cacheKey);
  });
  verifiedTokenFlights.set(cacheKey, flight);
  return flight;
}

async function remoteUserForTokenUncached(token: string, cacheKey: string) {

  let user: UserRecord | undefined;
  // Application sessions are UUIDs, while Supabase Auth access tokens are JWTs.
  // Avoid a guaranteed remote Auth lookup for our own session format.
  if (token.split('.').length === 3) {
    const startedAt = performance.now();
    const { data } = await getSupabaseAdmin().auth.getUser(token);
    recordSupabaseQuery(performance.now() - startedAt);
    user = data.user && hasGoogleIdentity(data.user as GoogleAuthUser)
      ? await remoteGetUserByAuthId(data.user.id)
      : undefined;
  } else {
    const session = await read(getSupabaseAdmin()
      .from('sessions')
      .select('user_id, users(id, auth_user_id, email, first_name, last_name, username, name)')
      .eq('token', sessionTokenHash(token))
      .gt('expires_at', nowIso())
      .maybeSingle<{ user_id: string; users: RemoteProfile | null }>()).catch(() => null);
    user = session?.users ? profileUser(session.users) : undefined;
  }

  if (verifiedTokenCacheMs > 0) {
    verifiedTokenCache.set(cacheKey, { expiresAt: Date.now() + verifiedTokenCacheMs, user });
  }
  return user;
}

export async function remoteRevokeSession(token: string) {
  await read(getSupabaseAdmin().from('sessions').delete().eq('token', sessionTokenHash(token)));
  const cacheKey = crypto.createHash('sha256').update(token).digest('hex');
  verifiedTokenCache.delete(cacheKey);
  verifiedTokenFlights.delete(cacheKey);
}
