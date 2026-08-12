import 'dotenv/config';

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim().replace(/\/$/, '');
const publishableKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim();
const serverSecretKey = (process.env.SUPABASE_SECRET_KEY ?? '').trim();

if (!supabaseUrl || !publishableKey) {
  throw new Error('Supabase URL and publishable key are required in .env.');
}

const authResponse = await fetch(`${supabaseUrl}/auth/v1/settings`, {
  headers: {
    apikey: publishableKey,
  },
});

if (!authResponse.ok) {
  throw new Error(`Supabase Auth connection failed with HTTP ${authResponse.status}.`);
}

const restKey = serverSecretKey || publishableKey;
const restResponse = await fetch(`${supabaseUrl}/rest/v1/`, {
  headers: {
    apikey: restKey,
    Authorization: `Bearer ${restKey}`,
  },
});
const restBody = await restResponse.text();
const restApi = restResponse.ok
  ? { status: restResponse.status, access: serverSecretKey ? 'server-secret' : 'publishable' }
  : restResponse.status === 401 && restBody.includes('Secret API key required')
    ? { status: restResponse.status, access: 'requires-SUPABASE_SECRET_KEY' }
    : (() => { throw new Error(`Supabase REST connection failed with HTTP ${restResponse.status}.`); })();

console.log(JSON.stringify({
  ok: true,
  service: 'supabase',
  projectUrl: supabaseUrl,
  authApi: { status: authResponse.status, access: 'publishable' },
  restApi,
}, null, 2));
