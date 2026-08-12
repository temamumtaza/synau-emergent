import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/$/, '');
const supabasePublishableKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim();
const supabaseSecretKey = (process.env.SUPABASE_SECRET_KEY ?? '').trim();

let adminClient: SupabaseClient | undefined;
let authClient: SupabaseClient | undefined;

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

export function getSupabaseAuthClient() {
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error('Supabase Auth requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
  }
  if (!authClient) {
    authClient = createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }
  return authClient;
}

export function isSupabaseStorage() {
  return (process.env.SYNAU_STORAGE ?? 'sqlite').trim().toLowerCase() === 'supabase';
}
