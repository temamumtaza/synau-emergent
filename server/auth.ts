import type { Request, Response, NextFunction } from 'express';
import { remoteUserForToken } from './supabase-auth.js';

export type UserRecord = {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  username: string;
  name: string;
};

export type AuthRequest = Request & { userId?: string };

export const SESSION_COOKIE_NAME = 'synau_session';

function sessionCookieSecure() {
  if (process.env.NODE_ENV === 'production') return process.env.SYNAU_COOKIE_SECURE !== 'false';
  return process.env.SYNAU_COOKIE_SECURE === 'true';
}

function sessionCookieSameSite() {
  const value = (process.env.SYNAU_COOKIE_SAMESITE ?? 'lax').trim().toLowerCase();
  if (value !== 'lax' && value !== 'strict' && value !== 'none') return 'lax' as const;
  if (value === 'none' && !sessionCookieSecure()) {
    throw new Error('SYNAU_COOKIE_SAMESITE=none requires SYNAU_COOKIE_SECURE=true.');
  }
  return value as 'lax' | 'strict' | 'none';
}

function serializeCookie(value: string, maxAge: number) {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sessionCookieSameSite()}`,
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
  ];
  if (sessionCookieSecure()) attributes.push('Secure');
  return attributes.join('; ');
}

function cookieValue(req: Request, name: string) {
  const header = req.header('cookie') ?? '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function authTokenOf(req: Request) {
  const cookieToken = cookieValue(req, SESSION_COOKIE_NAME);
  if (cookieToken) return cookieToken;
  const bearerAllowed = process.env.NODE_ENV !== 'production' || process.env.SYNAU_ALLOW_BEARER_AUTH === 'true';
  if (!bearerAllowed) return '';
  const header = req.header('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export function setSessionCookie(res: Response, token: string, expiresAt: string) {
  const maxAge = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  res.setHeader('Set-Cookie', serializeCookie(token, maxAge / 1_000));
}

export function clearSessionCookie(res: Response) {
  res.setHeader('Set-Cookie', serializeCookie('', 0));
}

export function assertSessionCookieRuntime() {
  sessionCookieSameSite();
}

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

export function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
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

/**
 * Every authenticated request is verified against Supabase Auth or the
 * short-lived application session stored in Supabase. There is no local
 * session or local user database fallback.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = authTokenOf(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  void remoteUserForToken(token).then((user) => {
    if (!user) {
      if (cookieValue(req, SESSION_COOKIE_NAME)) clearSessionCookie(res);
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    (req as AuthRequest).userId = user.id;
    next();
  }).catch(() => res.status(503).json({ error: 'Authentication service is temporarily unavailable.' }));
}
