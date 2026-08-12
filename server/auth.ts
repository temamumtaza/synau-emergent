import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AuthCodeRequest, AuthCodeVerify } from '../shared/schemas.js';
import { db, newId, nowIso } from './db.js';
import { sendAuthCodeEmail } from './email.js';
import { isSupabaseStorage } from './supabase.js';
import { remoteRevokeSession, remoteUserForToken, requestSupabaseAuthCode } from './supabase-auth.js';

const DEMO_EMAIL = 'demo@synau.local';
const DEMO_CODE = '020599';
const AUTH_CODE_TTL_MS = Math.max(60_000, Number(process.env.SYNAU_AUTH_CODE_TTL_MINUTES ?? 10) * 60_000);
const AUTH_CODE_RESEND_COOLDOWN_MS = Math.max(5_000, Number(process.env.SYNAU_AUTH_CODE_RESEND_COOLDOWN_SECONDS ?? 45) * 1_000);
const AUTH_CODE_MAX_ATTEMPTS = 5;
const configuredAuthCodeSecret = process.env.SYNAU_AUTH_CODE_SECRET?.trim();
if (!configuredAuthCodeSecret && process.env.NODE_ENV === 'production') {
  throw new Error('SYNAU_AUTH_CODE_SECRET must be configured in production.');
}
const AUTH_CODE_SECRET = configuredAuthCodeSecret ?? 'synau-local-auth-code-secret-change-me';

export type UserRecord = {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  username: string;
  name: string;
};

export type AuthRequest = Request & { userId?: string };

export class AuthFlowError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'auth_flow_error',
    readonly retryAfterSeconds = 0,
  ) {
    super(message);
    this.name = 'AuthFlowError';
  }
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
}

function displayName(firstName: string, lastName: string) {
  return `${firstName.trim()} ${lastName.trim()}`.trim();
}

export function publicUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    username: user.username,
    name: user.name,
  };
}

export function createUser(input: { email: string; firstName: string; lastName: string; username: string }) {
  const id = newId();
  const email = normalizeEmail(input.email);
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const username = normalizeUsername(input.username);
  db.prepare(`INSERT INTO users (id, email, password_hash, name, first_name, last_name, username, created_at)
    VALUES (?, ?, '', ?, ?, ?, ?, ?)`)
    .run(id, email, displayName(firstName, lastName), firstName, lastName, username, nowIso());
  return getUserById(id)!;
}

export function getUserByEmail(email: string) {
  return db.prepare('SELECT id, email, first_name, last_name, username, name FROM users WHERE lower(email) = lower(?)').get(normalizeEmail(email)) as UserRecord | undefined;
}

export function getUserByUsername(username: string) {
  return db.prepare('SELECT id, email, first_name, last_name, username, name FROM users WHERE lower(username) = lower(?)').get(normalizeUsername(username)) as UserRecord | undefined;
}

export function getUserByLoginIdentifier(identifier: string) {
  const normalized = identifier.trim().toLowerCase();
  return db.prepare('SELECT id, email, first_name, last_name, username, name FROM users WHERE lower(email) = ? OR lower(username) = ?')
    .get(normalized, normalized) as UserRecord | undefined;
}

export function getUserById(id: string) {
  return db.prepare('SELECT id, email, first_name, last_name, username, name FROM users WHERE id = ?').get(id) as UserRecord | undefined;
}

export function issueSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, expiresAt, nowIso());
  return token;
}

export function revokeSession(token: string) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function getUserForToken(token: string) {
  return db.prepare(`
    SELECT u.id, u.email, u.first_name, u.last_name, u.username, u.name
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, nowIso()) as UserRecord | undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (isSupabaseStorage()) {
    if (!token) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    void remoteUserForToken(token).then((user) => {
      if (!user) {
        res.status(401).json({ error: 'Authentication required.' });
        return;
      }
      (req as AuthRequest).userId = user.id;
      next();
    }).catch(() => res.status(503).json({ error: 'Authentication service is temporarily unavailable.' }));
    return;
  }
  const user = token ? getUserForToken(token) : undefined;
  if (!user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  (req as AuthRequest).userId = user.id;
  next();
}

export function currentUser(req: Request) {
  const userId = (req as AuthRequest).userId;
  return userId ? getUserById(userId) : undefined;
}

type AuthChallengeRow = {
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

function codeHash(challengeId: string, code: string) {
  return crypto.createHmac('sha256', AUTH_CODE_SECRET).update(`${challengeId}:${code}`).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function maskEmail(email: string) {
  if (!email || !email.includes('@')) return 'your email address';
  const [local, domain] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

function authCodeExpiry() {
  return new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString();
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

export async function requestAuthCode(input: AuthCodeRequest) {
  if (isSupabaseStorage()) return requestSupabaseAuthCode(input);
  const isSignUp = input.mode === 'sign_up';
  const identifier = isSignUp ? normalizeEmail(input.email) : input.identifier.trim().toLowerCase();
  const user = isSignUp ? undefined : getUserByLoginIdentifier(identifier);

  if (isSignUp) {
    if (getUserByEmail(input.email)) {
      throw new AuthFlowError('An account with that email already exists. Sign in to continue.', 409, 'email_already_registered');
    }
    if (getUserByUsername(input.username)) {
      throw new AuthFlowError('That username is already taken. Choose another one.', 409, 'username_already_registered');
    }
  }

  const recent = db.prepare(`SELECT created_at FROM auth_challenges
    WHERE mode = ? AND identifier = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .get(input.mode, identifier) as { created_at: string } | undefined;
  if (recent && Date.now() - new Date(recent.created_at).getTime() < AUTH_CODE_RESEND_COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((AUTH_CODE_RESEND_COOLDOWN_MS - (Date.now() - new Date(recent.created_at).getTime())) / 1_000);
    throw new AuthFlowError(`Please wait ${retryAfterSeconds} seconds before requesting another code.`, 429, 'auth_code_cooldown', retryAfterSeconds);
  }

  const challengeId = newId();
  const code = user?.email === DEMO_EMAIL ? DEMO_CODE : generateCode();
  const expiresAt = authCodeExpiry();
  const email = isSignUp ? normalizeEmail(input.email) : user?.email ?? (identifier.includes('@') ? identifier : '');
  const firstName = isSignUp ? input.firstName.trim() : user?.first_name ?? '';
  const lastName = isSignUp ? input.lastName.trim() : user?.last_name ?? '';
  const username = isSignUp ? normalizeUsername(input.username) : user?.username ?? '';

  db.prepare('UPDATE auth_challenges SET consumed_at = ? WHERE mode = ? AND identifier = ? AND consumed_at IS NULL')
    .run(nowIso(), input.mode, identifier);
  db.prepare(`INSERT INTO auth_challenges
    (id, mode, identifier, email, first_name, last_name, username, code_hash, attempts, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(challengeId, input.mode, identifier, email, firstName, lastName, username, codeHash(challengeId, code), expiresAt, nowIso());

  // Unknown sign-in identifiers intentionally receive the same generic response
  // without sending an email, avoiding account enumeration through delivery.
  if (user || isSignUp) {
    try {
      await sendAuthCodeEmail({
        to: email,
        firstName,
        code,
        purpose: input.mode,
        expiresInMinutes: Math.ceil(AUTH_CODE_TTL_MS / 60_000),
      });
    } catch {
      db.prepare('DELETE FROM auth_challenges WHERE id = ?').run(challengeId);
      throw new AuthFlowError('We could not send the verification email. Please try again shortly.', 503, 'email_delivery_failed');
    }
  }

  const message = user?.email === DEMO_EMAIL
    ? 'Demo account recognized. Enter the demo verification code to continue.'
    : isSignUp
      ? `We sent a verification code to ${maskEmail(email)}.`
      : 'If an account exists for that email or username, a verification code has been sent.';
  return challengeResponse(challengeId, email, expiresAt, user?.email === DEMO_EMAIL, message);
}

export function verifyAuthCode(input: AuthCodeVerify) {
  const challenge = db.prepare('SELECT * FROM auth_challenges WHERE id = ?').get(input.challengeId) as AuthChallengeRow | undefined;
  if (!challenge || challenge.consumed_at) {
    throw new AuthFlowError('This verification code is no longer valid. Request a new code.', 400, 'auth_code_invalid');
  }
  if (new Date(challenge.expires_at).getTime() <= Date.now()) {
    throw new AuthFlowError('This verification code has expired. Request a new code.', 400, 'auth_code_expired');
  }
  if (challenge.attempts >= AUTH_CODE_MAX_ATTEMPTS) {
    throw new AuthFlowError('Too many incorrect attempts. Request a new code.', 429, 'auth_code_locked');
  }

  db.prepare('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?').run(challenge.id);
  const expected = Buffer.from(challenge.code_hash, 'hex');
  const received = Buffer.from(codeHash(challenge.id, input.code), 'hex');
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    const remaining = Math.max(0, AUTH_CODE_MAX_ATTEMPTS - challenge.attempts - 1);
    throw new AuthFlowError(remaining ? `That code is incorrect. ${remaining} attempts remaining.` : 'That code is incorrect. Request a new code.', remaining ? 400 : 429, remaining ? 'auth_code_incorrect' : 'auth_code_locked');
  }

  let user: UserRecord | undefined;
  let created = false;
  if (challenge.mode === 'sign_in') {
    user = getUserByLoginIdentifier(challenge.identifier);
    if (!user) throw new AuthFlowError('This verification code is no longer valid. Request a new code.', 400, 'auth_code_invalid');
  } else {
    if (getUserByEmail(challenge.email)) throw new AuthFlowError('An account with that email already exists. Sign in to continue.', 409, 'email_already_registered');
    if (getUserByUsername(challenge.username)) throw new AuthFlowError('That username is already taken. Choose another one.', 409, 'username_already_registered');
    user = createUser({ email: challenge.email, firstName: challenge.first_name, lastName: challenge.last_name, username: challenge.username });
    created = true;
  }
  db.prepare('UPDATE auth_challenges SET consumed_at = ? WHERE id = ?').run(nowIso(), challenge.id);
  return { token: issueSession(user.id), user, created };
}
