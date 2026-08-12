import nodemailer from 'nodemailer';

type AuthCodeEmailInput = {
  to: string;
  firstName: string;
  code: string;
  purpose: 'sign_in' | 'sign_up';
  expiresInMinutes: number;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>'\"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character);
}

function emailCopy(input: AuthCodeEmailInput) {
  const isSignUp = input.purpose === 'sign_up';
  const heading = isSignUp ? 'Verify your Synau account' : 'Your Synau sign-in code';
  const intro = isSignUp
    ? 'Use this code to finish creating your Synau account.'
    : 'Use this code to continue signing in to your Synau learning space.';
  const firstName = escapeHtml(input.firstName || 'there');
  const code = escapeHtml(input.code);
  const minutes = escapeHtml(String(input.expiresInMinutes));
  const text = [
    `Hi ${input.firstName || 'there'},`,
    '',
    heading,
    intro,
    '',
    `Verification code: ${input.code}`,
    `This code expires in ${input.expiresInMinutes} minutes.`,
    '',
    'If you did not request this code, you can safely ignore this email.',
    '',
    'Synau',
  ].join('\n');
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f5f5f2;color:#181818;font-family:Arial,Helvetica,sans-serif;">
    <div style="padding:40px 18px;">
      <div style="width:100%;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #deded9;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 28px;border-bottom:1px solid #e7e6e1;">
          <div style="display:inline-block;padding:7px 9px;border-radius:7px;background:#171717;color:#ffffff;font-size:16px;font-weight:700;line-height:1;">S</div>
          <span style="margin-left:9px;color:#181818;font-size:16px;font-weight:700;vertical-align:4px;">Synau</span>
        </div>
        <div style="padding:34px 28px 38px;">
          <p style="margin:0 0 9px;color:#76756f;font-size:11px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;">Account verification</p>
          <h1 style="margin:0;color:#181818;font-size:28px;line-height:1.12;letter-spacing:-.7px;">${heading}</h1>
          <p style="margin:18px 0 0;color:#55544f;font-size:15px;line-height:1.65;">Hi ${firstName}, ${intro}</p>
          <div style="margin:27px 0 20px;padding:21px 18px;border:1px solid #d6d5cf;border-radius:9px;background:#fafaf8;text-align:center;">
            <p style="margin:0 0 9px;color:#76756f;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;">Your verification code</p>
            <div style="color:#171717;font-size:34px;font-weight:700;letter-spacing:8px;line-height:1.2;">${code}</div>
          </div>
          <p style="margin:0;color:#76756f;font-size:13px;line-height:1.6;">This code expires in ${minutes} minutes. If you did not request it, you can safely ignore this email.</p>
        </div>
        <div style="padding:17px 28px;border-top:1px solid #e7e6e1;color:#898883;font-size:11px;line-height:1.5;">This is an automated message from Synau. Please do not reply.</div>
      </div>
    </div>
  </body>
</html>`;
  return { subject: isSignUp ? 'Verify your Synau account' : 'Your Synau sign-in code', text, html };
}

function emailMode() {
  const configured = (process.env.SYNAU_EMAIL_MODE ?? '').trim().toLowerCase();
  if (configured === 'smtp' || configured === 'console') return configured;
  return process.env.NODE_ENV === 'production' ? 'smtp' : 'console';
}

function smtpTransport() {
  const host = process.env.SYNAU_SMTP_HOST?.trim();
  if (!host) throw new Error('SMTP host is not configured.');
  const port = Number(process.env.SYNAU_SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('SMTP port is invalid.');
  const user = process.env.SYNAU_SMTP_USER?.trim();
  const password = process.env.SYNAU_SMTP_PASSWORD;
  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SYNAU_SMTP_SECURE === 'true' || port === 465,
    auth: user && password ? { user, pass: password } : undefined,
  });
}

export async function sendAuthCodeEmail(input: AuthCodeEmailInput) {
  const copy = emailCopy(input);
  if (emailMode() === 'console') {
    // This is intentionally development-only. Production defaults to SMTP and
    // never logs a usable verification code.
    console.info(`[auth-email:console] ${input.to} ${copy.subject} code=${input.code}`);
    return;
  }

  const from = process.env.SYNAU_EMAIL_FROM?.trim();
  if (!from) throw new Error('Email sender is not configured.');
  await smtpTransport().sendMail({
    from,
    to: input.to,
    subject: copy.subject,
    text: copy.text,
    html: copy.html,
  });
}
