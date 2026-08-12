import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRef = (process.env.SUPABASE_PROJECT_REF ?? '').trim()
  || (await readFile(resolve(process.cwd(), 'supabase/.temp/project-ref'), 'utf8')).trim();
const managementToken = (process.env.SUPABASE_ACCESS_TOKEN ?? '').trim();
const smtp = {
  adminEmail: (process.env.SUPABASE_SMTP_ADMIN_EMAIL ?? '').trim(),
  host: (process.env.SUPABASE_SMTP_HOST ?? '').trim(),
  port: Number(process.env.SUPABASE_SMTP_PORT ?? 587),
  user: (process.env.SUPABASE_SMTP_USER ?? '').trim(),
  password: process.env.SUPABASE_SMTP_PASSWORD ?? '',
  senderName: (process.env.SUPABASE_SMTP_SENDER_NAME ?? 'Synau').trim(),
};

if (!managementToken) {
  throw new Error('SUPABASE_ACCESS_TOKEN is required. Use a Supabase Personal Access Token for this setup command; sb_secret is not a Management API token.');
}
if (!projectRef) throw new Error('SUPABASE_PROJECT_REF is required.');
if (!smtp.adminEmail || !smtp.host || !smtp.user || !smtp.password || !smtp.senderName) {
  throw new Error('Configure SUPABASE_SMTP_ADMIN_EMAIL, HOST, USER, PASSWORD, and SENDER_NAME before running this command.');
}
if (!Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65_535) {
  throw new Error('SUPABASE_SMTP_PORT must be a valid TCP port.');
}

const templatePath = resolve(process.cwd(), 'supabase/templates/auth-otp.html');
const template = await readFile(templatePath, 'utf8');
if (!template.includes('{{ .Token }}')) throw new Error('The Supabase OTP template must contain {{ .Token }}.');
if (template.includes('{{ .ConfirmationURL }}')) throw new Error('The OTP template must not contain {{ .ConfirmationURL }} because that switches the flow to a magic link.');

const response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/config/auth`, {
  method: 'PATCH',
  headers: {
    Accept: 'application/json',
    Authorization: `Bearer ${managementToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    external_email_enabled: true,
    smtp_admin_email: smtp.adminEmail,
    smtp_host: smtp.host,
    smtp_port: smtp.port,
    smtp_user: smtp.user,
    smtp_pass: smtp.password,
    smtp_sender_name: smtp.senderName,
    mailer_subjects_magic_link: 'Your Synau sign-in code',
    mailer_templates_magic_link_content: template,
    mailer_subjects_confirmation: 'Verify your Synau account',
    mailer_templates_confirmation_content: template,
  }),
});

const responseBody = await response.text();
if (!response.ok) {
  throw new Error(`Supabase Auth configuration failed with HTTP ${response.status}: ${responseBody.slice(0, 500)}`);
}

console.log(JSON.stringify({
  ok: true,
  projectRef,
  smtpConfigured: true,
  otpTemplatesConfigured: true,
  message: 'Supabase Auth now uses Synau OTP templates and the configured SMTP provider.',
}, null, 2));
