import 'dotenv/config';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';

const baseUrl = process.env.SYNAU_BASE_URL ?? 'http://127.0.0.1:8787';
const courseCacheExpiryWaitMs = Number(process.env.SYNAU_PERF_CACHE_WAIT_MS ?? 15_200);
const requestSettleWaitMs = Number(process.env.SYNAU_PERF_SETTLE_WAIT_MS ?? 2_000);
const explicitToken = process.env.SYNAU_PERF_TOKEN;
if (!explicitToken) throw new Error('Set SYNAU_PERF_TOKEN to an active Supabase Auth access token.');
const sessionToken = explicitToken;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const requests: Array<{ path: string; status: number | undefined; durationMs: number; serverTiming: string }> = [];
const startedAt = new Map<object, number>();

page.on('request', (request) => {
  if (request.url().includes('/api/')) startedAt.set(request, Date.now());
});
page.on('requestfinished', async (request) => {
  const started = startedAt.get(request);
  if (started === undefined) return;
  const response = await request.response();
  requests.push({
    path: new URL(request.url()).pathname,
    status: response?.status(),
    durationMs: Date.now() - started,
    serverTiming: response?.headers()['server-timing'] ?? '',
  });
  startedAt.delete(request);
});

function resetRequests() {
  requests.length = 0;
}

function count(path: string) {
  return requests.filter((request) => request.path === path).length;
}

function snapshot(label: string) {
  const ordered = [...requests].sort((left, right) => left.durationMs - right.durationMs);
  const appDurations = requests.flatMap((request) => {
    const match = request.serverTiming.match(/(?:^|,\s*)app;dur=([\d.]+)/);
    return match ? [Number(match[1])] : [];
  }).sort((left, right) => left - right);
  const supabaseQueryCounts = requests.flatMap((request) => {
    const match = request.serverTiming.match(/desc="(\d+) queries"/);
    return match ? [Number(match[1])] : [];
  });
  return {
    label,
    total: requests.length,
    byPath: Object.fromEntries([...new Set(requests.map((request) => request.path))].map((path) => [path, count(path)])),
    p95ApiMs: ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))].durationMs : 0,
    p95ServerAppMs: appDurations.length ? appDurations[Math.min(appDurations.length - 1, Math.floor(appDurations.length * 0.95))] : 0,
    maxSupabaseQueries: supabaseQueryCounts.length ? Math.max(...supabaseQueryCounts) : 0,
  };
}

try {
  await page.context().addCookies([{
    name: 'synau_session',
    value: sessionToken,
    url: baseUrl,
    httpOnly: true,
    secure: baseUrl.startsWith('https://'),
    sameSite: 'Lax',
  }]);
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'What do you want to understand next?' })).toBeVisible();
  await page.waitForTimeout(100);

  const dashboard = snapshot('authenticated dashboard');
  if (count('/api/courses') !== 1 || count('/api/credits') !== 1) {
    throw new Error(`Dashboard request regression: ${JSON.stringify(dashboard)}`);
  }

  resetRequests();
  await page.getByRole('button', { name: 'Open profile menu' }).click();
  await page.getByRole('menu').getByRole('link', { name: /^Credits$/ }).click();
  await expect(page.getByRole('heading', { name: 'Credits', exact: true })).toBeVisible();
  const creditsClick = snapshot('dashboard to credits click');
  if (requests.length !== 0) throw new Error(`Credits click was not cache-hot: ${JSON.stringify(creditsClick)}`);

  resetRequests();
  await page.getByRole('button', { name: 'Open profile menu' }).click();
  await page.getByRole('menu').getByRole('link', { name: /Your library/ }).click();
  await expect(page.getByRole('heading', { name: 'All learning paths' })).toBeVisible();
  const libraryClick = snapshot('credits to library click');
  if (requests.length !== 0) throw new Error(`Library click was not cache-hot: ${JSON.stringify(libraryClick)}`);

  resetRequests();
  await page.waitForTimeout(courseCacheExpiryWaitMs);
  await page.getByRole('link', { name: /Synau/ }).click();
  await expect(page.getByRole('heading', { name: 'What do you want to understand next?' })).toBeVisible();
  await page.waitForTimeout(requestSettleWaitMs);
  const cacheExpiry = snapshot('library to dashboard after cache expiry');
  if (count('/api/courses') !== 1 || count('/api/credits') !== 1) {
    throw new Error(`Cache expiry did not refresh exactly once: ${JSON.stringify(cacheExpiry)}`);
  }

  resetRequests();
  await page.getByLabel('I want to learn').fill('Performance measurement');
  await page.getByRole('button', { name: /generate course/i }).click();
  await expect(page.getByText('Roadmap preview')).toBeVisible();
  await page.waitForTimeout(requestSettleWaitMs);
  const generatorMutation = snapshot('roadmap generator credit refresh');
  if (count('/api/generate/roadmap') !== 1 || count('/api/credits') !== 1) {
    throw new Error(`Generator refresh duplicated or missed: ${JSON.stringify(generatorMutation)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    assertions: [
      'one-dashboard-courses-request',
      'one-dashboard-credits-request',
      'cache-hot-route-clicks',
      'single-refresh-after-cache-expiry',
      'single-credit-refresh-after-generator',
    ],
    snapshots: [dashboard, creditsClick, libraryClick, cacheExpiry, generatorMutation],
  }, null, 2));
} finally {
  await browser.close();
}
