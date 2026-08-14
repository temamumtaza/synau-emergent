import { chromium } from 'playwright';
import { expect } from 'playwright/test';

const baseUrl = process.env.SYNAU_BASE_URL ?? 'http://127.0.0.1:8787';
const token = process.env.SYNAU_TEST_TOKEN;
if (!token) throw new Error('Set SYNAU_TEST_TOKEN to an active Supabase Auth access token.');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const createdCourseIds: string[] = [];

async function createCourse(index: number) {
  const response = await page.evaluate(async (courseIndex) => {
    const stamp = `${Date.now()}-${courseIndex}`;
    const lesson = {
      id: `${stamp}-lesson`,
      title: `Foundations ${courseIndex}`,
      summary: 'A short starting point for this UI shell check.',
      estimatedMinutes: 10,
      position: 0,
    };
    const payload = {
      title: `Library QA path ${courseIndex}`,
      description: 'A temporary learning path used to verify library boundaries.',
      topic: `Library QA ${courseIndex}`,
      outcomes: ['Find the path', 'Open the path', 'Keep the path organized'],
      sections: [{
        id: `${stamp}-section`,
        title: 'Starting point',
        summary: 'A temporary section for the browser check.',
        position: 0,
        lessons: [lesson],
      }, {
        id: `${stamp}-section-2`,
        title: 'Next step',
        summary: 'A second temporary section for the browser check.',
        position: 1,
        lessons: [{ ...lesson, id: `${stamp}-lesson-2`, position: 0, title: 'Practice' }],
      }],
    };
    const result = await fetch('/api/courses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: result.status, body: await result.json() };
  }, index);
  if (response.status !== 201 || typeof response.body.course?.id !== 'string') {
    throw new Error(`Could not create UI shell fixture: HTTP ${response.status}`);
  }
  createdCourseIds.push(response.body.course.id);
}

async function deleteFixtureCourses() {
  await page.evaluate(async (courseIds) => {
    await Promise.all(courseIds.map((courseId) => fetch(`/api/courses/${encodeURIComponent(courseId)}`, {
      method: 'DELETE',
    })));
  }, createdCourseIds);
}

try {
  await page.context().addCookies([{
    name: 'synau_session',
    value: token,
    url: baseUrl,
    httpOnly: true,
    secure: baseUrl.startsWith('https://'),
    sameSite: 'Lax',
  }]);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'What do you want to understand next?' })).toBeVisible();

  for (let index = 1; index <= 7; index += 1) await createCourse(index);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.locator('nav[aria-label="Primary navigation"]')).toHaveCount(0);
  await expect(page.locator('.credit-chip')).toBeVisible();
  await expect(page.locator('.course-library .course-card')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'View all paths' })).toBeVisible();

  await page.getByRole('button', { name: 'Open profile menu' }).click();
  const profileMenu = page.getByRole('menu');
  await expect(profileMenu).toBeVisible();
  await expect(profileMenu).not.toContainText('Product quality');
  await profileMenu.getByRole('link', { name: /Profile & settings/ }).click();
  await expect(page.getByRole('heading', { name: 'Profile & settings' })).toBeVisible();

  await page.getByRole('button', { name: /Credits & billing/ }).click();
  await expect(page.getByRole('heading', { name: 'Credits', exact: true })).toBeVisible({ timeout: 15_000 });

  await page.goto(`${baseUrl}/quality`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Measured against the learner experience/ })).toBeVisible();

  await page.goto(`${baseUrl}/library`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'All learning paths' })).toBeVisible();
  await expect(page.locator('.library-page__count')).toBeVisible({ timeout: 30_000 });
  const fullLibraryCount = await page.locator('.library-page .course-card').count();
  if (fullLibraryCount < 7) throw new Error(`Full library only rendered ${fullLibraryCount} paths.`);

  await page.screenshot({ path: 'quality/ui-shell-final.png', fullPage: true });
  console.log(JSON.stringify({ ok: true, evidence: [
    'minimal-header-with-credit-chip',
    'profile-first-settings',
    'credits-page',
    'quality-route-hidden-from-navigation',
    'dashboard-library-capped-at-six',
    'full-library-route',
  ], screenshot: 'quality/ui-shell-final.png' }, null, 2));
} finally {
  await deleteFixtureCourses();
  await browser.close();
}
