import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? import.meta.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/$/, '');
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '').trim();

let browserClient: SupabaseClient | undefined;

export function supabaseBrowserConfigured() {
  return Boolean(supabaseUrl && publishableKey);
}

export function getSupabaseBrowserClient() {
  if (!supabaseUrl || !publishableKey) {
    throw new Error('Google sign-in is not configured. Add the Supabase browser URL and publishable key.');
  }
  if (!browserClient) {
    browserClient = createClient(supabaseUrl, publishableKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    });
  }
  return browserClient;
}

export async function signInWithGoogle() {
  const { error } = await getSupabaseBrowserClient().auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/`,
    },
  });
  if (error) throw error;
}

export async function signOutGoogle() {
  if (!supabaseBrowserConfigured()) return;
  await getSupabaseBrowserClient().auth.signOut();
}
