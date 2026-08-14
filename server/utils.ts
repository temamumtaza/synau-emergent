import crypto from 'node:crypto';

/** Shared server utilities. Persistence lives exclusively in Supabase. */
export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

export function json<T>(value: T): string {
  return JSON.stringify(value);
}
