import fs from 'node:fs';
import path from 'node:path';

const baseUrl = (process.env.SYNAU_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const backendSourcePath = path.resolve('server', 'ai.ts');

const protectedPaths = [
  '/server/ai.ts',
  '/server/index.ts',
  '/shared/schemas.ts',
  '/shared/generators.ts',
  '/supabase/config.toml',
  '/scripts/e2e.ts',
  '/quality/progress.json',
  '/.env.example',
  '/dist-server/server/index.js',
  `/@fs${backendSourcePath}`,
];

const unauthenticatedGeneratorRequests = [
  { path: '/api/generate/roadmap', body: { topic: 'security boundary' } },
  { path: '/api/quizzes/generate', body: { courseId: 'missing', scope: 'course', scopeId: 'missing' } },
  { path: '/api/courses/missing/lessons/missing/open', body: {} },
];

async function assertStatus(pathname: string, expected: number, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  if (response.status !== expected) {
    throw new Error(`${pathname} returned ${response.status}; expected ${expected}.`);
  }
  return response;
}

for (const pathname of protectedPaths) {
  const response = await assertStatus(pathname, 404);
  const body = await response.arrayBuffer();
  if (body.byteLength !== 0) throw new Error(`${pathname} returned a non-empty 404 body.`);
}

for (const request of unauthenticatedGeneratorRequests) {
  await assertStatus(request.path, 401, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.body),
  });
}

const bundleRoot = path.resolve('dist');
if (fs.existsSync(bundleRoot)) {
  const forbiddenBundleStrings = [
    'LESSON_GENERATION_SYSTEM_PROMPT',
    'write_subchapter_lesson',
    'build_learning_roadmap',
    'SYNAU_OPENAI_API_KEY',
    'SYNAU_OPENAI_BASE_URL',
    'SUPABASE_SECRET_KEY',
    'MIDTRANS_SERVER_KEY',
    'synau.session',
    'ai.sumopod',
    'deepseek-v4-flash',
  ];
  const bundleFiles: string[] = [];
  function collect(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(entryPath);
      else if (/\.(?:js|map)$/.test(entry.name)) bundleFiles.push(entryPath);
    }
  }
  collect(bundleRoot);
  for (const file of bundleFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const marker = forbiddenBundleStrings.find((candidate) => content.includes(candidate));
    if (marker) throw new Error(`Client bundle contains server-only marker ${marker}: ${file}`);
  }
}

console.log(`Security boundary smoke passed (${protectedPaths.length} protected paths, ${unauthenticatedGeneratorRequests.length} unauthenticated generator routes).`);
