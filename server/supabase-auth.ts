import type { GoogleAuthRequest } from '../shared/schemas.js';
import { newId, nowIso } from './db.js';
import { getSupabaseAdmin } from './supabase.js';
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

async function read<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>) {
  const result = await query;
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
  const { data, error } = await getSupabaseAdmin().auth.getUser(accessToken);
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
    return { status: 'authenticated' as const, token: input.accessToken, user: profileUser(existingByAuthId), created: false };
  }

  // A migrated Synau account can be linked to Google by its verified email,
  // without asking the learner to recreate their profile.
  const linkedProfile = await linkExistingEmailProfile(authUser, email);
  if (linkedProfile) {
    return { status: 'authenticated' as const, token: input.accessToken, user: linkedProfile, created: false };
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
  return { status: 'authenticated' as const, token: input.accessToken, user: profileUser(created), created: true };
}

export async function remoteUserForToken(token: string) {
  const { data } = await getSupabaseAdmin().auth.getUser(token);
  if (data.user) return hasGoogleIdentity(data.user as GoogleAuthUser) ? remoteGetUserByAuthId(data.user.id) : undefined;
  const session = await read(getSupabaseAdmin().from('sessions').select('user_id').eq('token', token).gt('expires_at', nowIso()).maybeSingle<{ user_id: string }>()).catch(() => null);
  return session ? remoteGetUserById(session.user_id) : undefined;
}

export async function remoteRevokeSession(token: string) {
  await read(getSupabaseAdmin().from('sessions').delete().eq('token', token));
}
