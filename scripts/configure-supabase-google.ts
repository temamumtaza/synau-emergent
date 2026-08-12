import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRef = (process.env.SUPABASE_PROJECT_REF ?? '').trim()
  || (await readFile(resolve(process.cwd(), 'supabase/.temp/project-ref'), 'utf8')).trim();
const managementToken = (process.env.SUPABASE_ACCESS_TOKEN ?? '').trim();
const clientId = (process.env.SUPABASE_GOOGLE_CLIENT_ID ?? '').trim();
const clientSecret = (process.env.SUPABASE_GOOGLE_CLIENT_SECRET ?? '').trim();

if (!managementToken) {
  throw new Error('SUPABASE_ACCESS_TOKEN is required. Use a Supabase Personal Access Token; sb_secret is not a Management API token.');
}
if (!projectRef) throw new Error('SUPABASE_PROJECT_REF is required.');
if (!clientId || !clientSecret) {
  throw new Error('Configure SUPABASE_GOOGLE_CLIENT_ID and SUPABASE_GOOGLE_CLIENT_SECRET before running this command.');
}

const response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/config/auth`, {
  method: 'PATCH',
  headers: {
    Accept: 'application/json',
    Authorization: `Bearer ${managementToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    enable_signup: true,
    external_email_enabled: false,
    external_google_enabled: true,
    external_google_client_id: clientId,
    external_google_secret: clientSecret,
  }),
});

const responseBody = await response.text();
if (!response.ok) {
  throw new Error(`Supabase Google Auth configuration failed with HTTP ${response.status}: ${responseBody.slice(0, 500)}`);
}

console.log(JSON.stringify({
  ok: true,
  projectRef,
  provider: 'google',
  emailAuthDisabled: true,
  message: 'Supabase Auth now accepts Google only. Configure the exact app URLs in Auth URL Configuration before testing.',
}, null, 2));
