import { chromium } from 'playwright';
import { expect } from 'playwright/test';

const baseUrl = process.env.SYNAU_BASE_URL ?? 'http://127.0.0.1:8787';
const token = process.env.SYNAU_TEST_TOKEN;
if (!token) throw new Error('Set SYNAU_TEST_TOKEN to an active Supabase Auth access token.');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const evidence: string[] = [];

try {
  // Vite keeps its HMR client connection open in development, so networkidle
  // is not a stable readiness signal. The assertions below provide the real
  // readiness gates for the learner workflow.
  await page.context().addCookies([{
    name: 'synau_session',
    value: token,
    url: baseUrl,
    httpOnly: true,
    secure: baseUrl.startsWith('https://'),
    sameSite: 'Lax',
  }]);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('What do you want to understand next?')).toBeVisible();
  evidence.push('google-authenticated-session');

  await page.getByLabel('I want to learn').fill('Decision making with data');
  await page.getByRole('button', { name: /generate course/i }).click();
  await expect(page.getByText('Roadmap preview')).toBeVisible();
  const firstRoadmapSection = page.locator('.roadmap-dialog .roadmap-section').first();
  const firstSectionTitle = await firstRoadmapSection.locator('h4').innerText();
  await expect(firstRoadmapSection).toBeVisible();
  evidence.push('roadmap-generated');

  await page.locator('.approval-check input').check();
  await page.getByRole('button', { name: /approve and create/i }).click();
  await expect(page.getByLabel('Course sections').getByText(firstSectionTitle)).toBeVisible();
  const createdCourseTitle = await page.locator('.course-header__title h1').innerText();
  evidence.push('roadmap-approved');

  await expect(page.getByText('Generate this lesson on demand.')).toBeVisible();
  evidence.push('lazy-lesson-not-prefetched');
  await page.locator('.course-rail .rail-lessons > button').first().click();
  await expect(page.locator('.lesson-article--streaming')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.lesson-article--streaming .lesson-markdown')).toBeVisible({ timeout: 60_000 });
  evidence.push('lesson-markdown-streamed-into-article');
  await expect(page.locator('.lesson-markdown, .lesson-reading__section').first()).toBeVisible();
  evidence.push('article-first-lesson');
  const lessonOverview = await page.locator('.lesson-overview p').innerText();
  const lessonOpening = await page.locator('.lesson-markdown p, .lesson-reading__section p').first().innerText();
  if (lessonOverview.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean).length < 2) throw new Error('Lesson overview must contain an editorial two-sentence deck.');
  if (lessonOpening.split(/\s+/).filter(Boolean).length < 45) throw new Error('Lesson opening must be a substantial article paragraph.');
  evidence.push('editorial-intro-quality');
  await expect(page.locator('.lesson-takeaway')).toContainText('Key takeaway');
  await expect(page.locator('.lesson-article .lesson-components, .lesson-article .lesson-node, .lesson-article .data-lab, .lesson-article .practice-studio, .lesson-article .lesson-source-note, .lesson-article .reflection-card, .lesson-article .takeaway-card')).toHaveCount(0);
  await expect(page.locator('.lesson-article').getByText('About this material', { exact: true })).toHaveCount(0);
  await expect(page.locator('.lesson-article').getByText('Practice studio', { exact: true })).toHaveCount(0);
  await expect(page.locator('.lesson-finish')).toContainText('End of subchapter');
  evidence.push('article-surface-has-no-legacy-cards');

  await page.getByRole('button', { name: /^Mark complete$/i }).click();
  await expect(page.locator('.status-chip--complete')).toBeVisible();
  evidence.push('lesson-completed');

  await page.getByRole('button', { name: /lesson quiz/i }).click();
  await expect(page.locator('.quiz-intro')).toBeVisible();
  await expect(page.locator('.quiz-panel')).toContainText(/appointment|metric|baseline|uncertainty|correlation|constraint/i);
  const questionSets = page.locator('fieldset.quiz-question');
  await expect(questionSets).toHaveCount(3);
  await expect(page.locator('.quiz-question').nth(0)).toContainText('From the article');
  await expect(page.locator('.quiz-question').nth(1)).toContainText('From the article');
  await expect(page.locator('.quiz-question').nth(2)).toContainText('Challenge');
  for (let index = 0; index < await questionSets.count(); index += 1) {
    await questionSets.nth(index).locator('.quiz-option').first().click();
  }
  await page.getByRole('button', { name: /submit answers/i }).click();
  await expect(page.getByText(/score/i)).toBeVisible();
  evidence.push('quiz-repeatable');

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const managedCard = page.locator('.course-card').first();
  await expect(managedCard).toBeVisible();
  const renamedCourseTitle = `${createdCourseTitle} — Managed`;
  await managedCard.getByRole('button', { name: /Manage/ }).click();
  await page.getByRole('menuitem', { name: 'Rename path' }).click();
  await expect(page.getByRole('dialog')).toContainText('Rename this path');
  await page.getByLabel('Path name').fill(renamedCourseTitle);
  await page.getByRole('dialog').getByRole('button', { name: 'Save name' }).click();
  await expect(page.locator('.course-card').first()).toContainText(renamedCourseTitle);

  await page.locator('.course-card').first().getByRole('button', { name: /Manage/ }).click();
  await page.getByRole('menuitem', { name: 'Delete course' }).click();
  const deleteDialog = page.getByRole('dialog');
  await expect(deleteDialog).toContainText('Delete this course?');
  await expect(deleteDialog).toContainText(renamedCourseTitle);
  await deleteDialog.getByRole('button', { name: 'Keep course' }).click();
  await expect(deleteDialog).toHaveCount(0);

  await page.locator('.course-card').first().getByRole('button', { name: /Manage/ }).click();
  await page.getByRole('menuitem', { name: 'Delete course' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete course' }).click();
  await expect(page.locator('.course-card').filter({ hasText: renamedCourseTitle })).toHaveCount(0);
  evidence.push('learning-path-manager');

  await page.screenshot({ path: 'quality/e2e-final.png', fullPage: true });
  console.log(JSON.stringify({ ok: true, evidence, screenshot: 'quality/e2e-final.png' }, null, 2));
} finally {
  await browser.close();
}
