import { chromium } from 'playwright';
import { expect } from 'playwright/test';

const appUrl = process.env.SYNAU_BASE_URL ?? 'http://127.0.0.1:8787';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('response', (response) => { if (response.status() >= 500) errors.push(`http ${response.status()}: ${response.url()}`); });

try {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('input[placeholder="you@example.com or username"]').fill('demo@synau.local');
  await page.getByRole('button', { name: /send sign-in code/i }).click();
  await page.getByLabel('Verification code').fill('020599');
  await page.getByRole('button', { name: /verify and continue/i }).click();
  await expect(page.getByText('What do you want to understand next?')).toBeVisible();
  await page.goto(`${appUrl}/credits`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Credits', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Your credits')).toBeVisible();
  await expect(page.getByText('Sumopod')).toBeVisible();
  await expect(page.getByText('deepseek-v4-flash')).toBeVisible();
  for (const price of ['Rp15.000', 'Rp30.000', 'Rp50.000', 'Rp100.000']) {
    await expect(page.getByText(price, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('10 bonus', { exact: false })).toBeVisible();
  await expect(page.getByText('25 bonus', { exact: false })).toBeVisible();
  await expect(page.getByText('50 bonus', { exact: false })).toBeVisible();
  await expect(page.getByText('New account: +100 free', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /top up locked/i }).first()).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Redeem a credit token' })).toBeVisible();
  const authRoutesRemoved = await page.request.post(`${appUrl}/api/auth/login`, { data: { email: 'demo@synau.local', password: 'legacy-password' } });
  expect([404, 405]).toContain(authRoutesRemoved.status());
  await page.screenshot({ path: 'quality/credits-final.png', fullPage: true });
  if (errors.length > 0) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ ok: true, assertions: [
    'backend-credit-balance',
    'fixed-sumopod-provider',
    'four-locked-top-up-packages',
    'password-routes-removed',
  ], screenshot: 'quality/credits-final.png' }, null, 2));
} finally {
  await browser.close();
}
