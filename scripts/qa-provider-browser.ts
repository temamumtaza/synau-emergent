import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { db } from '../server/db.js';

const email = process.env.SYNAU_TEST_EMAIL;
const authCode = process.env.SYNAU_TEST_CODE;
if (!email || !authCode) throw new Error('Set SYNAU_TEST_EMAIL and SYNAU_TEST_CODE.');

const baseUrl = process.env.SYNAU_BASE_URL ?? 'http://127.0.0.1:8787';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors: string[] = [];
let secondaryPage: any = null;
let createdCourseId = '';
function recordPageError(prefix: string, error: Error) {
  // Vite's dev-only HMR socket can close when another local watcher owns its port.
  if (/WebSocket closed without opened/i.test(error.message)) return;
  errors.push(`${prefix}: ${error.message}`);
}
page.on('pageerror', (error) => recordPageError('page', error));
page.on('response', (response) => { if (response.status() >= 500) errors.push(`http ${response.status()}: ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByLabel('Email or username').fill(email);
  await page.getByRole('button', { name: /send sign-in code/i }).click();
  await expect(page.getByLabel('Verification code')).toBeVisible();
  await page.getByLabel('Verification code').fill(authCode);
  await page.getByRole('button', { name: /verify and continue/i }).click();
  await expect(page.getByText('What do you want to understand next?')).toBeVisible();

  await page.getByLabel('I want to learn').fill('Decision making with data');
  await page.getByRole('button', { name: /preview roadmap/i }).click();
  await expect(page.getByText('Roadmap preview')).toBeVisible({ timeout: 180_000 });
  await page.locator('.approval-check input').check();
  await page.getByRole('button', { name: /approve and create/i }).click();
  await expect(page.getByText('Generate this lesson on demand.')).toBeVisible({ timeout: 30_000 });
  createdCourseId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
  if (!createdCourseId) throw new Error('Could not identify the temporary course ID.');

  secondaryPage = await context.newPage();
  await secondaryPage.setViewportSize({ width: 1280, height: 900 });
  secondaryPage.on('pageerror', (error: Error) => recordPageError('secondary page', error));
  secondaryPage.on('response', (response: any) => { if (response.status() >= 500) errors.push(`secondary http ${response.status()}: ${response.url()}`); });
  await secondaryPage.goto(page.url(), { waitUntil: 'networkidle' });
  await expect(secondaryPage.getByText('Generate this lesson on demand.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Open lesson' }).click();
  await expect(page.getByText('Generating this lesson')).toBeVisible({ timeout: 30_000 });
  await secondaryPage.locator('.course-rail .rail-lessons > button').nth(1).click();
  await expect(secondaryPage.getByText(/another lesson is currently being generated/i)).toBeVisible({ timeout: 30_000 });
  await secondaryPage.close();
  secondaryPage = null;
  await expect(page.locator('.lesson-reading__section').first()).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('.lesson-citation').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.lesson-references')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.practice-studio')).toBeVisible();
  await page.getByRole('button', { name: /^Mark complete$/i }).click();
  await expect(page.locator('.status-chip--complete')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /lesson quiz/i }).click();
  await expect(page.locator('.quiz-panel')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole('button', { name: /submit answers/i })).toBeVisible({ timeout: 180_000 });
  const questions = page.locator('fieldset.quiz-question');
  for (let index = 0; index < await questions.count(); index += 1) {
    await questions.nth(index).locator('.quiz-option').first().click();
  }
  await page.getByRole('button', { name: /submit answers/i }).click();
  await expect(page.locator('.quiz-score')).toBeVisible({ timeout: 60_000 });
  if (errors.length > 0) throw new Error(errors.join('\n'));
  await page.screenshot({ path: 'quality/tema-provider-e2e.png', fullPage: true });
  console.log(JSON.stringify({ ok: true, result: 'live provider browser workflow passed', screenshot: 'quality/tema-provider-e2e.png' }, null, 2));
} catch (error) {
  await page.screenshot({ path: 'quality/tema-provider-e2e-failure.png', fullPage: true }).catch(() => undefined);
  let currentUrl = '';
  let visibleText = '';
  try { currentUrl = page.url(); } catch { /* the browser may already be closed */ }
  try { visibleText = (await page.locator('body').innerText()).slice(-2400); } catch { /* preserve the original failure */ }
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), url: currentUrl, errors, visibleText, screenshot: 'quality/tema-provider-e2e-failure.png' }, null, 2));
  process.exitCode = 1;
} finally {
  await secondaryPage?.close().catch(() => undefined);
  await browser.close();
  if (createdCourseId) {
    const result = db.prepare('DELETE FROM courses WHERE id = ?').run(createdCourseId);
    console.error(`Browser QA cleanup: removed ${result.changes} temporary course row.`);
  }
  if (db.open) db.close();
}
