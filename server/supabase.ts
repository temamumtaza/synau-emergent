import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/$/, '');
const supabaseSecretKey = (process.env.SUPABASE_SECRET_KEY ?? '').trim();

let adminClient: SupabaseClient | undefined;

export function supabaseConfigured() {
  return Boolean(supabaseUrl && supabaseSecretKey);
}

export function getSupabaseAdmin() {
  if (!supabaseUrl || !supabaseSecretKey) {
    throw new Error('Supabase storage requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.');
  }
  if (!adminClient) {
    adminClient = createClient(supabaseUrl, supabaseSecretKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }
  return adminClient;
}

export function isSupabaseStorage() {
  return (process.env.SYNAU_STORAGE ?? 'sqlite').trim().toLowerCase() === 'supabase';
}
