import 'dotenv/config';
import { getSupabaseAdmin } from '../server/supabase.js';

const baseUrl = process.env.SYNAU_BASE_URL ?? 'http://127.0.0.1:8787';
const token = process.env.SYNAU_TEST_TOKEN;
const expectBilling = process.env.SYNAU_EXPECT_BILLING !== 'false';
if (!token) throw new Error('Set SYNAU_TEST_TOKEN to an active Supabase Auth access token.');

let createdCourseId = '';
let userId = '';
const checks: string[] = [];
const admin = getSupabaseAdmin();

type ApiResult = { status: number; body: any };
type UsageRow = { generation_id: string; generator: string; credit_cost: number; status: string };

async function request(path: string, init: RequestInit = {}, expected: number[] = [200], authenticated = true): Promise<ApiResult> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (authenticated) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!expected.includes(response.status)) {
    throw new Error(`${path} returned ${response.status}: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 1000)}`);
  }
  return { status: response.status, body };
}

async function readUsage(profileId: string) {
  const result = await admin
    .from('llm_usage')
    .select('generation_id, generator, credit_cost, status')
    .eq('user_id', profileId);
  if (result.error) throw new Error(`Supabase usage query failed: ${result.error.message}`);
  return (result.data ?? []) as UsageRow[];
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
    body: json({ mode: 'sign_in', identifier: 'unused@example.com' }),
  }, [410], false);
  await request('/api/auth/verify-code', {
    method: 'POST',
    body: json({ challengeId: 'unused', code: '000000' }),
  }, [410], false);
  checks.push('legacy-email-auth-disabled');

  const me = await request('/api/auth/me');
  userId = me.body.user.id;
  check(typeof userId === 'string' && userId.length > 0, 'Supabase Auth token resolved to a Synau profile');

  const initialCredits = (await request('/api/credits')).body.credits;
  check(initialCredits.balance > 0, 'credit wallet has an available balance');
  check(initialCredits.provider.id === 'sumopod' && initialCredits.provider.model === 'deepseek-v4-flash', 'fixed Sumopod provider is exposed without its API key');
  const initialUsageIds = new Set((await readUsage(userId)).map((row) => row.generation_id));

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
  await new Promise((resolve) => setTimeout(resolve, 25));
  const secondOpenPromise = request(`/api/courses/${createdCourseId}/lessons/${secondLesson.id}/open`, { method: 'POST' }, [200, 409]);
  const [firstOpen, secondOpen] = await Promise.all([firstOpenPromise, secondOpenPromise]);
  const openedResult = firstOpen.status === 200 ? firstOpen : secondOpen;
  const blockedOpen = firstOpen.status === 409 ? firstOpen : secondOpen;
  const targetLesson = openedResult === firstOpen ? firstLesson : secondLesson;
  check(blockedOpen.status === 409 && blockedOpen.body.code === 'lesson_generation_in_progress' && blockedOpen.body.activeLessonId === targetLesson.id, 'a concurrent lesson open is blocked while this user is generating another lesson');
  const opened = openedResult.body;
  const material = opened.course.sections.flatMap((section: any) => section.lessons).find((lesson: any) => lesson.id === targetLesson.id)?.material;
  check(opened.generated === true && material && material.lessonId === targetLesson.id, 'lesson generator materialized and rebound the requested lesson ID');
  check(typeof material.article?.markdown === 'string' ? material.article.markdown.trim().length >= 240 : Array.isArray(material.article?.sections) && material.article.sections.length >= 2, 'lesson generator returned a flowing article');
  if (typeof material.article?.markdown === 'string' && material.article.markdown.trim()) {
    check(/(^|\n)#{1,6}\s|\n\s*```/m.test(material.article.markdown), 'Markdown lesson uses a readable Markdown structure');
  } else {
    check(material.article.sections.every((section: any) => Array.isArray(section.content) || Array.isArray(section.paragraphs)), 'lesson article sections use a supported content stream');
  }
  if (material.sources.length > 0) {
    check(material.sources.length >= 1, 'lesson generator returned lesson references');
    const articleText = typeof material.article?.markdown === 'string'
      ? material.article.markdown
      : material.article.sections.flatMap((section: any) => [...(section.paragraphs ?? []), ...(section.content ?? []).map((block: any) => block.text ?? block.caption ?? '')]).join(' ');
    check(/\[\[[^\]]+\]\]/.test(articleText), 'lesson generator returned inline source citations');
  } else {
    checks.push('deterministic original lesson has no external source list');
  }
  const reopened = (await request(`/api/courses/${createdCourseId}/lessons/${targetLesson.id}/open`, { method: 'POST' })).body;
  check(reopened.generated === false, 'reopening a generated lesson does not regenerate it');

  const completed = (await request(`/api/courses/${createdCourseId}/lessons/${targetLesson.id}/complete`, { method: 'POST' })).body.course;
  check(completed.progress.completedLessons === 1, 'lesson completion increments progress');
  const completedAgain = (await request(`/api/courses/${createdCourseId}/lessons/${targetLesson.id}/complete`, { method: 'POST' })).body.course;
  check(completedAgain.progress.completedLessons === 1, 'lesson completion is idempotent');

  async function generateQuiz(scope: 'lesson' | 'chapter' | 'course', scopeId: string) {
    const result = (await request('/api/quizzes/generate', {
      method: 'POST',
      body: json({ courseId: createdCourseId, scope, scopeId }),
    }, [201])).body.quiz;
    check(result.scope === scope && result.scopeId === scopeId, `${scope} quiz scope is bound to the request`);
    check(result.questions.length === 3 && publicQuizHasNoAnswerKey(result), `${scope} quiz has exactly three public-safe questions`);
    check(result.questions.map((question: any) => question.kind).join(',') === 'article,article,challenge', `${scope} quiz contains two article checks followed by one challenge`);
    return result;
  }

  const lessonQuiz = await generateQuiz('lesson', targetLesson.id);
  const repeatLessonQuiz = await generateQuiz('lesson', targetLesson.id);
  check(lessonQuiz.id !== repeatLessonQuiz.id, 'repeat lesson quiz creates a distinct attempt');
  await generateQuiz('chapter', firstSection.id);
  await generateQuiz('course', createdCourseId);

  const answers = Object.fromEntries(lessonQuiz.questions.map((question: any) => [question.id, 0]));
  await request(`/api/quizzes/${lessonQuiz.id}/submit`, { method: 'POST', body: json({ answers: {} }) }, [400]);
  checks.push('empty quiz submission rejected');
  const submission = (await request(`/api/quizzes/${lessonQuiz.id}/submit`, { method: 'POST', body: json({ answers }) })).body;
  check(typeof submission.score === 'number' && submission.results.length === lessonQuiz.questions.length, 'quiz submission scored and returned review results');
  check(publicQuizHasNoAnswerKey(submission.quiz), 'quiz submission response remains public-safe');
  await request(`/api/quizzes/${lessonQuiz.id}/submit`, { method: 'POST', body: json({ answers }) }, [409]);
  checks.push('completed quiz attempt is locked while new attempts remain allowed');

  const activity = (await request(`/api/courses/${createdCourseId}/activity`)).body.events;
  check(activity.some((event: any) => event.type === 'lesson_opened'), 'activity records lesson opens');
  check(activity.some((event: any) => event.type === 'quiz_completed'), 'activity records quiz completion');

  const archived = (await request(`/api/courses/${createdCourseId}`, { method: 'PATCH', body: json({ status: 'archived' }) })).body.course;
  check(archived.status === 'archived', 'course can be archived');
  await request(`/api/courses/${createdCourseId}/lessons/${targetLesson.id}/open`, { method: 'POST' }, [409]);
  await request('/api/quizzes/generate', { method: 'POST', body: json({ courseId: createdCourseId, scope: 'course', scopeId: createdCourseId }) }, [409]);
  checks.push('archived course is read-only');
  const reopenedCourse = (await request(`/api/courses/${createdCourseId}`, { method: 'PATCH', body: json({ status: 'active' }) })).body.course;
  check(reopenedCourse.status === 'active', 'course can be reopened');

  const productProgress = (await request('/api/product-progress', {}, [200], false)).body;
  check(productProgress.latestResults.length > 0, 'product progress endpoint returns live evidence');

  const finalCredits = (await request('/api/credits')).body.credits;
  const usageRows = await readUsage(userId);
  const newUsageRows = usageRows.filter((row) => !initialUsageIds.has(row.generation_id));
  if (expectBilling) {
    check(finalCredits.balance < initialCredits.balance, 'generator usage settled against the credit wallet');
    check(newUsageRows.length >= 4, 'roadmap, lesson, and repeatable quiz calls recorded LLM usage');
    check(newUsageRows.every((row) => row.status === 'success' && row.credit_cost === 1), 'each successful generator is settled at exactly one credit');
    const newGenerationIds = newUsageRows.map((row) => row.generation_id);
    if (newGenerationIds.length > 0) {
      const holdResult = await admin.from('credit_ledger').select('reference_id, delta').eq('user_id', userId).eq('type', 'hold').in('reference_id', newGenerationIds.map((id) => `llm:${id}:hold`));
      if (holdResult.error) throw new Error(`Supabase ledger query failed: ${holdResult.error.message}`);
      const newHoldRows = (holdResult.data ?? []) as Array<{ reference_id: string; delta: number }>;
      check(newHoldRows.length === newUsageRows.length && newHoldRows.every((row) => row.delta === -1), 'each generator reserves one credit before provider work');
    }
  } else {
    checks.push('deterministic demo generator bypassed provider billing checks');
  }

  await request('/api/auth/logout', { method: 'POST' }, [204]);
  checks.push('logout endpoint reached Supabase session boundary');
  console.log(JSON.stringify({ ok: true, checks, createdCourseId, provider: initialCredits.provider, credits: { before: initialCredits.balance, after: finalCredits.balance }, successfulGenerators: newUsageRows.length, usageRows: usageRows.length, storage: 'supabase' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), checks }, null, 2));
  process.exitCode = 1;
} finally {
  if (createdCourseId) {
    await fetch(`${baseUrl}/api/courses/${createdCourseId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }).catch((error) => console.error(`QA cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
    console.error('QA cleanup: requested Supabase course deletion.');
  }
}
