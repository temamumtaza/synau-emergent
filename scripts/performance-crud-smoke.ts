import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const baseUrl = process.env.SYNAU_BASE_URL ?? 'http://127.0.0.1:8787';
const sessionToken = process.env.SYNAU_PERF_TOKEN;
if (!sessionToken) throw new Error('Set SYNAU_PERF_TOKEN to an active Supabase Auth access token. Do not read application session rows from Supabase.');

const headers = {
  authorization: `Bearer ${sessionToken}`,
  'content-type': 'application/json',
};

type Probe = {
  name: string;
  path: string;
  status: number;
  durationMs: number;
  serverTiming: string;
  supabaseQueries: number;
  supabaseOperationQueries: number;
};

const probes: Probe[] = [];

function serverTimingValue(header: string, pattern: RegExp) {
  const match = header.match(pattern);
  return match ? Number(match[1]) : 0;
}

async function call<T>(name: string, path: string, init: RequestInit = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const durationMs = performance.now() - startedAt;
  const serverTiming = response.headers.get('server-timing') ?? '';
  const body = (response.status === 204 ? null : await response.json()) as T;
  probes.push({
    name,
    path,
    status: response.status,
    durationMs: Math.round(durationMs * 10) / 10,
    serverTiming,
    supabaseQueries: serverTimingValue(serverTiming, /desc="(\d+) queries"/),
    supabaseOperationQueries: serverTimingValue(serverTiming, /supabase-operation;[^,]+desc="(\d+) queries"/),
  });
  if (!response.ok) throw new Error(`${name} failed with ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const sectionOne = randomUUID();
const sectionTwo = randomUUID();
const firstLesson = randomUUID();
const secondLesson = randomUUID();
const roadmap = {
  title: 'CRUD performance probe',
  description: 'Temporary course used by the repeatable performance harness.',
  topic: 'CRUD performance probe',
  outcomes: ['Measure reads', 'Measure writes', 'Keep material lazy'],
  sections: [
    { id: sectionOne, title: 'Read model', summary: 'A metadata-first chapter.', position: 0, lessons: [{ id: firstLesson, title: 'Metadata first', summary: 'Keep the workspace light.', estimatedMinutes: 10, position: 0 }] },
    { id: sectionTwo, title: 'Transactions', summary: 'A mutation chapter.', position: 1, lessons: [{ id: secondLesson, title: 'One round trip', summary: 'Complete a lesson atomically.', estimatedMinutes: 12, position: 0 }] },
  ],
};

let courseId = '';
try {
  const list = await call<{ courses: Array<{ sections: Array<{ lessons: Array<{ material: unknown }> }> }> }>('list', '/api/courses');
  const created = await call<{ course: { id: string; sections: typeof roadmap.sections } }>('create', '/api/courses', { method: 'POST', body: JSON.stringify(roadmap) });
  courseId = created.course.id;
  const detail = await call<{ course: { sections: Array<{ lessons: Array<{ material: unknown }> }> } }>('detail', `/api/courses/${courseId}`);
  const renamed = await call<{ course: { title: string } }>('rename', `/api/courses/${courseId}`, { method: 'PATCH', body: JSON.stringify({ title: 'CRUD performance probe renamed' }) });
  const createdLessonId = created.course.sections[0].lessons[0].id;
  const completed = await call<{ course: { progress: { completedLessons: number } } }>('complete', `/api/courses/${courseId}/lessons/${createdLessonId}/complete`, { method: 'POST' });
  await call<null>('delete', `/api/courses/${courseId}`, { method: 'DELETE' });

  const listMaterial = list.courses.flatMap((course) => course.sections.flatMap((section) => section.lessons)).some((lesson) => lesson.material !== null);
  const detailMaterial = detail.course.sections.flatMap((section) => section.lessons).some((lesson) => lesson.material !== null);
  if (listMaterial || detailMaterial) throw new Error('Metadata read model unexpectedly returned lesson material.');
  if (renamed.course.title !== 'CRUD performance probe renamed') throw new Error('Rename response did not contain the updated title.');
  if (completed.course.progress.completedLessons !== 1) throw new Error('Complete response did not contain updated progress.');

  const queryCounts = probes.map((probe) => probe.supabaseQueries);
  if (queryCounts.some((count) => count < 1 || count > 2) || probes.some((probe) => probe.supabaseOperationQueries !== 1)) {
    throw new Error(`CRUD round-trip regression: ${JSON.stringify(probes)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    score: {
      oneSupabaseQueryPerCrudOperation: true,
      authBoundaryUsesAtMostOneExtraQuery: true,
      metadataMaterialSplit: true,
      completeMutationReturnsProgress: true,
    },
    probes,
  }, null, 2));
} finally {
  if (courseId) {
    await fetch(`${baseUrl}/api/courses/${courseId}`, { method: 'DELETE', headers }).catch(() => undefined);
  }
}
