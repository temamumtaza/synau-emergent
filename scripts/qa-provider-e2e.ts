import { db } from '../server/db.js';

const baseUrl = process.env.SYNAU_BASE_URL ?? 'http://127.0.0.1:8787';
const email = process.env.SYNAU_TEST_EMAIL;
const authCode = process.env.SYNAU_TEST_CODE;
if (!email || !authCode) throw new Error('Set SYNAU_TEST_EMAIL and SYNAU_TEST_CODE.');

let token = '';
let createdCourseId = '';
const checks: string[] = [];

type ApiResult = { status: number; body: any };

async function request(path: string, init: RequestInit = {}, expected: number[] = [200], authenticated = true): Promise<ApiResult> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (authenticated && token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!expected.includes(response.status)) {
    throw new Error(`${path} returned ${response.status}: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 1000)}`);
  }
  return { status: response.status, body };
}

function check(condition: unknown, message: string) {
  if (!condition) throw new Error(`QA assertion failed: ${message}`);
  checks.push(message);
}

function json(value: unknown) {
  return JSON.stringify(value);
}

function publicQuizHasNoAnswerKey(quiz: any) {
  return quiz.questions.every((question: any) => !('answerIndex' in question) && !('explanation' in question));
}

try {
  await request('/healthz', {}, [200], false);
  checks.push('healthz');

  await request('/api/auth/request-code', {
    method: 'POST',
    body: json({ mode: 'sign_up', firstName: '', lastName: '', username: 'x', email: 'not-an-email' }),
  }, [400], false);
  checks.push('invalid register rejected');

  const requestedCode = await request('/api/auth/request-code', {
    method: 'POST',
    body: json({ mode: 'sign_in', identifier: email }),
  }, [200], false);
  const login = await request('/api/auth/verify-code', {
    method: 'POST',
    body: json({ challengeId: requestedCode.body.challengeId, code: authCode }),
  }, [200], false);
  token = login.body.token;
  check(typeof token === 'string' && token.length > 20, 'login issued a session token');

  const me = await request('/api/auth/me');
  check(me.body.user.email === email, 'auth/me returned the requested user');

  const initialCredits = (await request('/api/credits')).body.credits;
  check(initialCredits.balance > 0, 'credit wallet has an available balance');
  check(initialCredits.provider.id === 'sumopod' && initialCredits.provider.model === 'deepseek-v4-flash', 'fixed Sumopod provider is exposed without its API key');
  const initialUsageIds = new Set((db.prepare('SELECT generation_id FROM llm_usage WHERE user_id = ?').all(login.body.user.id) as Array<{ generation_id: string }>).map((row) => row.generation_id));

  const roadmap = (await request('/api/generate/roadmap', {
    method: 'POST',
    body: json({ topic: 'Decision making with data' }),
  })).body.roadmap;
  check(roadmap.sections.length >= 2 && roadmap.sections.every((section: any) => section.lessons.length > 0), 'roadmap generator returned valid sections and lessons');
  checks.push(`roadmap ${roadmap.sections.length} sections`);

  const created = (await request('/api/courses', {
    method: 'POST',
    body: json(roadmap),
  }, [201])).body.course;
  createdCourseId = created.id;
  check(created.status === 'active' && created.progress.completedLessons === 0, 'course creation starts active with zero progress');

  const listed = (await request('/api/courses')).body.courses;
  check(listed.some((course: any) => course.id === createdCourseId), 'course list includes the new course');
  const fetched = (await request(`/api/courses/${createdCourseId}`)).body.course;
  check(fetched.id === createdCourseId, 'course detail returns the new course');

  const firstSection = fetched.sections[0];
  const firstLesson = firstSection.lessons[0];
  const secondLesson = firstSection.lessons[1] ?? fetched.sections[1]?.lessons[0];
  if (!secondLesson) throw new Error('QA course did not contain a second lesson for concurrency testing.');
  const firstOpenPromise = request(`/api/courses/${createdCourseId}/lessons/${firstLesson.id}/open`, { method: 'POST' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  let blockedOpen: ApiResult;
  try {
    blockedOpen = await request(`/api/courses/${createdCourseId}/lessons/${secondLesson.id}/open`, { method: 'POST' }, [409]);
  } finally {
    await firstOpenPromise;
  }
  check(blockedOpen.body.code === 'lesson_generation_in_progress' && blockedOpen.body.activeLessonId === firstLesson.id, 'a second lesson is blocked while this user is generating another lesson');
  const opened = (await firstOpenPromise).body;
  const material = opened.course.sections[0].lessons.find((lesson: any) => lesson.id === firstLesson.id)?.material;
  check(opened.generated === true && material && material.lessonId === firstLesson.id, 'lesson generator materialized and rebound the requested lesson ID');
  check(Array.isArray(material.article?.sections) && material.article.sections.length >= 2, 'lesson generator returned a flowing article');
  check(Array.isArray(material.sources) && material.sources.length >= 1, 'lesson generator returned lesson references');
  check(material.article.sections.some((section: any) => section.paragraphs.some((paragraph: string) => /\[\[[^\]]+\]\]/.test(paragraph))), 'lesson generator returned inline source citations');
  const reopened = (await request(`/api/courses/${createdCourseId}/lessons/${firstLesson.id}/open`, { method: 'POST' })).body;
  check(reopened.generated === false, 'reopening a generated lesson does not regenerate it');

  const completed = (await request(`/api/courses/${createdCourseId}/lessons/${firstLesson.id}/complete`, { method: 'POST' })).body.course;
  check(completed.progress.completedLessons === 1, 'lesson completion increments progress');
  const completedAgain = (await request(`/api/courses/${createdCourseId}/lessons/${firstLesson.id}/complete`, { method: 'POST' })).body.course;
  check(completedAgain.progress.completedLessons === 1, 'lesson completion is idempotent');

  async function generateQuiz(scope: 'lesson' | 'chapter' | 'course', scopeId: string) {
    const result = (await request('/api/quizzes/generate', {
      method: 'POST',
      body: json({ courseId: createdCourseId, scope, scopeId }),
    }, [201])).body.quiz;
    check(result.scope === scope && result.scopeId === scopeId, `${scope} quiz scope is bound to the request`);
    check(result.questions.length >= 2 && publicQuizHasNoAnswerKey(result), `${scope} quiz is public-safe and has questions`);
    return result;
  }

  const lessonQuiz = await generateQuiz('lesson', firstLesson.id);
  const repeatLessonQuiz = await generateQuiz('lesson', firstLesson.id);
  check(lessonQuiz.id !== repeatLessonQuiz.id, 'repeat lesson quiz creates a distinct attempt');
  await generateQuiz('chapter', firstSection.id);
  await generateQuiz('course', createdCourseId);

  const answers = Object.fromEntries(lessonQuiz.questions.map((question: any) => [question.id, 0]));
  await request(`/api/quizzes/${lessonQuiz.id}/submit`, {
    method: 'POST',
    body: json({ answers: {} }),
  }, [400]);
  checks.push('empty quiz submission rejected');
  const submission = (await request(`/api/quizzes/${lessonQuiz.id}/submit`, {
    method: 'POST',
    body: json({ answers }),
  })).body;
  check(typeof submission.score === 'number' && submission.results.length === lessonQuiz.questions.length, 'quiz submission scored and returned review results');
  check(publicQuizHasNoAnswerKey(submission.quiz), 'quiz submission response remains public-safe');
  await request(`/api/quizzes/${lessonQuiz.id}/submit`, {
    method: 'POST',
    body: json({ answers }),
  }, [409]);
  checks.push('completed quiz attempt is locked while new attempts remain allowed');

  const activity = (await request(`/api/courses/${createdCourseId}/activity`)).body.events;
  check(activity.some((event: any) => event.type === 'lesson_opened'), 'activity records lesson opens');
  check(activity.some((event: any) => event.type === 'quiz_completed'), 'activity records quiz completion');

  const archived = (await request(`/api/courses/${createdCourseId}`, {
    method: 'PATCH',
    body: json({ status: 'archived' }),
  })).body.course;
  check(archived.status === 'archived', 'course can be archived');
  await request(`/api/courses/${createdCourseId}/lessons/${firstLesson.id}/open`, { method: 'POST' }, [409]);
  await request('/api/quizzes/generate', {
    method: 'POST',
    body: json({ courseId: createdCourseId, scope: 'course', scopeId: createdCourseId }),
  }, [409]);
  checks.push('archived course is read-only');
  const reopenedCourse = (await request(`/api/courses/${createdCourseId}`, {
    method: 'PATCH',
    body: json({ status: 'active' }),
  })).body.course;
  check(reopenedCourse.status === 'active', 'course can be reopened');

  const productProgress = (await request('/api/product-progress', {}, [200], false)).body;
  check(productProgress.latestResults.length > 0, 'product progress endpoint returns live evidence');

  const finalCredits = (await request('/api/credits')).body.credits;
  check(finalCredits.balance < initialCredits.balance, 'generator usage settled against the credit wallet');
  const usageRows = db.prepare('SELECT generation_id, generator, credit_cost, status FROM llm_usage WHERE user_id = ?').all(login.body.user.id) as Array<{ generation_id: string; generator: string; credit_cost: number; status: string }>;
  const newUsageRows = usageRows.filter((row) => !initialUsageIds.has(row.generation_id));
  check(newUsageRows.length >= 4, 'roadmap, lesson, and repeatable quiz calls recorded LLM usage');
  check(newUsageRows.every((row) => row.status === 'success' && row.credit_cost === 1), 'each successful generator is settled at exactly one credit');
  const newGenerationIds = newUsageRows.map((row) => row.generation_id);
  const newHoldRows = newGenerationIds.length === 0 ? [] : db.prepare(`SELECT reference_id, delta FROM credit_ledger WHERE user_id = ? AND type = 'hold' AND reference_id IN (${newGenerationIds.map(() => '?').join(',')})`)
    .all(login.body.user.id, ...newGenerationIds.map((id) => `llm:${id}:hold`)) as Array<{ reference_id: string; delta: number }>;
  check(newHoldRows.length === newUsageRows.length && newHoldRows.every((row) => row.delta === -1), 'each generator reserves one credit before provider work');
  const successfulGenerators = newUsageRows.length;

  await request('/api/auth/logout', { method: 'POST' }, [204]);
  await request('/api/auth/me', {}, [401]);
  checks.push('logout revoked the session');

  console.log(JSON.stringify({ ok: true, checks, createdCourseId, provider: initialCredits.provider, credits: { before: initialCredits.balance, after: finalCredits.balance }, successfulGenerators, usageRows: usageRows.length }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), checks }, null, 2));
  process.exitCode = 1;
} finally {
  if (createdCourseId) {
    const result = db.prepare('DELETE FROM courses WHERE id = ?').run(createdCourseId);
    console.error(`QA cleanup: removed ${result.changes} temporary course row.`);
  }
}
