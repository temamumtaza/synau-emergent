import { getSupabaseAdmin } from './supabase.js';
import { newId, nowIso } from './db.js';
import { recordSupabaseQuery } from './performance.js';
import {
  CourseSchema,
  LessonMaterialSchema,
  QuizPublicSchema,
  QuizSchema,
  type Course,
  type LessonMaterial,
  type Quiz,
  type Roadmap,
} from '../shared/schemas.js';

type RemoteLock = {
  user_id: string;
  course_id: string;
  lesson_id: string;
  lesson_title: string;
  created_at: string;
};

type RemoteQueryResult<T> = { data: T; error: { message: string; code?: string } | null };

async function read<T>(query: PromiseLike<RemoteQueryResult<T>>, kind: 'operation' | 'support' = 'support') {
  const startedAt = performance.now();
  let result: RemoteQueryResult<T>;
  try {
    result = await query;
  } finally {
    recordSupabaseQuery(performance.now() - startedAt, kind);
  }
  if (result.error) throw new Error(`Supabase query failed: ${result.error.message}`);
  return result.data;
}

function material(value: unknown) {
  return value ? LessonMaterialSchema.parse(value) : null;
}

export async function supabaseHealth() {
  const client = getSupabaseAdmin();
  await read(client.from('users').select('id', { head: true, count: 'exact' }), 'support');
}

function client() {
  return getSupabaseAdmin();
}

export async function remoteSerializeCourse(userId: string, courseId: string, materialLessonId?: string): Promise<Course | null> {
  return remoteCourseWorkspace(userId, courseId, materialLessonId);
}

export async function remoteListCourses(userId: string) {
  const value = await read(client().rpc('list_course_summaries', { p_user_id: userId }), 'operation');
  return CourseSchema.array().parse(value ?? []);
}

export async function remoteCourseWorkspace(userId: string, courseId: string, materialLessonId?: string): Promise<Course | null> {
  const value = await read(client().rpc('get_course_workspace_json', {
    p_user_id: userId,
    p_course_id: courseId,
    p_material_lesson_id: materialLessonId ?? null,
  }), 'operation');
  return value ? CourseSchema.parse(value) : null;
}

export async function remoteCreateCourse(userId: string, roadmap: Roadmap) {
  const courseId = newId();
  const sectionRows = roadmap.sections.map((section) => {
    const sectionId = newId();
    return {
      id: sectionId,
      course_id: courseId,
      title: section.title,
      summary: section.summary,
      position: section.position,
      lessons: section.lessons.map((lesson) => ({
        id: newId(),
        section_id: sectionId,
        title: lesson.title,
        summary: lesson.summary,
        estimated_minutes: lesson.estimatedMinutes,
        position: lesson.position,
      })),
    };
  });
  const value = await read(client().rpc('create_course_from_roadmap_v3', {
    p_course_id: courseId,
    p_user_id: userId,
    p_topic: roadmap.topic,
    p_title: roadmap.title,
    p_description: roadmap.description,
    p_outcomes: roadmap.outcomes,
    p_sections: sectionRows,
    p_language: roadmap.language,
  }), 'operation');
  return CourseSchema.parse(value);
}

export async function remoteUpdateCourse(userId: string, courseId: string, patch: { title?: string; status?: 'active' | 'archived' }) {
  const value = await read(client().rpc('update_course_and_event', {
    p_user_id: userId,
    p_course_id: courseId,
    p_title: patch.title ?? null,
    p_status: patch.status ?? null,
  }), 'operation');
  return value ? CourseSchema.parse(value) : null;
}

export async function remoteDeleteCourse(userId: string, courseId: string) {
  const value = await read(client().rpc('delete_course_if_unlocked', {
    p_user_id: userId,
    p_course_id: courseId,
  }), 'operation') as { deleted?: boolean; locked?: boolean; notFound?: boolean } | null;
  return {
    deleted: value?.deleted === true,
    locked: value?.locked === true,
    notFound: value?.notFound === true,
  } as const;
}

export async function remoteGetCourseMemory(userId: string, courseId: string) {
  const value = await read(client().rpc('get_course_memory_rows_json', { p_user_id: userId, p_course_id: courseId }), 'operation');
  const rows = Array.isArray(value) ? value as Array<{ title?: unknown; material?: unknown }> : [];
  return rows.flatMap((row) => {
    const parsed = material(row.material);
    if (!parsed) return [];
    return [`${typeof row.title === 'string' ? row.title : 'Lesson'}: ${parsed.keyTakeaway}`, ...contextFromMaterial(parsed).slice(0, 3)];
  }).slice(0, 40);
}

export async function remoteCourseContext(userId: string, courseId: string, scope: 'lesson' | 'chapter' | 'course', scopeId: string) {
  const value = await read(client().rpc('get_course_context_json', {
    p_user_id: userId,
    p_course_id: courseId,
    p_scope: scope,
    p_scope_id: scopeId,
  }), 'operation') as { title?: unknown; description?: unknown; context?: unknown } | null;
  if (!value || typeof value.title !== 'string' || !Array.isArray(value.context)) return null;
  const contextRows = value.context as Array<{ summary?: unknown; material?: unknown }>;
  return {
    title: value.title,
    context: [
      ...(typeof value.description === 'string' ? [value.description] : []),
      ...contextRows.flatMap((row) => [
        ...(typeof row.summary === 'string' ? [row.summary] : []),
        ...contextFromMaterial(material(row.material)),
      ]),
    ],
  };
}

function contextFromMaterial(parsed: LessonMaterial | null) {
  if (!parsed) return [];
  return [
    parsed.keyTakeaway,
    ...parsed.article.sections.flatMap((section) => [
      ...section.paragraphs,
      ...section.content.map((block) => block.type === 'paragraph'
        ? block.text
        : block.type === 'quote'
          ? block.text
          : block.type === 'table'
            ? `${block.caption ?? 'Table'}: ${block.columns.join(' / ')}`
            : block.type === 'equation'
              ? `${block.caption ?? 'Equation'}: ${block.latex}`
              : block.type === 'code'
                ? `${block.caption ?? 'Code'}: ${block.code}`
                : `${block.caption ?? 'Diagram'}: ${block.code}`),
    ]),
    ...parsed.nodes.map((node) => node.heading),
  ]
    .filter((value): value is string => Boolean(value));
}

export async function remoteAddEvent(userId: string, courseId: string, eventType: string, lessonId?: string, data?: unknown) {
  await read(client().from('progress_events').insert({
    id: newId(), user_id: userId, course_id: courseId, lesson_id: lessonId ?? null,
    event_type: eventType, data_json: data ?? null, created_at: nowIso(),
  }));
}

export async function remoteLessonRow(userId: string, courseId: string, lessonId: string) {
  const course = await remoteCourseWorkspace(userId, courseId, lessonId);
  if (!course) return null;
  const section = course.sections.find((candidate) => candidate.lessons.some((lesson) => lesson.id === lessonId));
  const lesson = section?.lessons.find((candidate) => candidate.id === lessonId);
  if (!section || !lesson) return null;
  const row = {
    id: lesson.id,
    section_id: lesson.sectionId,
    title: lesson.title,
    summary: lesson.summary,
    estimated_minutes: lesson.estimatedMinutes,
    position: lesson.position,
    material_json: lesson.material,
    last_generated_at: null,
    completed_at: lesson.completedAt,
  };
  return { course: { ...course, sections: course.sections }, row, sectionTitle: section.title };
}

export async function remoteOpenLesson(userId: string, courseId: string, lessonId: string) {
  const value = await read(client().rpc('open_lesson_and_get_workspace', {
    p_user_id: userId,
    p_course_id: courseId,
    p_lesson_id: lessonId,
  }), 'operation');
  return value ? CourseSchema.parse(value) : null;
}

export async function remoteAcquireLessonLock(userId: string, courseId: string, lessonId: string, lessonTitle: string, staleBefore: string) {
  const result = await read(client().rpc('claim_lesson_generation_lock', {
    p_user_id: userId, p_course_id: courseId, p_lesson_id: lessonId, p_lesson_title: lessonTitle, p_stale_before: staleBefore,
  }), 'operation');
  const payload = result as { acquired?: boolean; lock?: RemoteLock };
  return payload.acquired ? { acquired: true as const } : { acquired: false as const, lock: payload.lock };
}

export async function remoteReleaseLessonLock(userId: string, courseId: string, lessonId: string) {
  await read(client().from('lesson_generation_locks').delete().eq('user_id', userId).eq('course_id', courseId).eq('lesson_id', lessonId), 'operation');
}

export async function remoteSaveLessonMaterial(lessonId: string, materialValue: LessonMaterial) {
  await read(client().from('lessons').update({ material_json: materialValue, last_generated_at: nowIso() }).eq('id', lessonId).is('material_json', null), 'operation');
}

export async function remoteCompleteLesson(userId: string, courseId: string, lessonId: string) {
  const value = await read(client().rpc('complete_lesson_and_event', {
    p_user_id: userId,
    p_course_id: courseId,
    p_lesson_id: lessonId,
  }), 'operation') as {
    ok?: boolean;
    code?: string;
    course?: unknown;
  } | null;
  if (!value?.ok) {
    if (value?.code === 'archived') return { status: 'archived' as const };
    return { status: 'not_found' as const };
  }
  return { status: 'ok' as const, course: CourseSchema.parse(value.course) };
}

export async function remoteInsertQuiz(userId: string, courseId: string, quiz: Quiz) {
  await read(client().from('quiz_attempts').insert({
    id: quiz.id, user_id: userId, course_id: courseId, scope: quiz.scope, scope_id: quiz.scopeId, quiz_json: quiz, created_at: nowIso(),
  }));
}

export async function remoteGetQuiz(userId: string, quizId: string) {
  return read(client().from('quiz_attempts').select('*').eq('id', quizId).eq('user_id', userId).maybeSingle<{ id: string; course_id: string; scope: 'lesson' | 'chapter' | 'course'; scope_id: string; quiz_json: Quiz; score: number | null; completed_at: string | null }>());
}

export async function remoteCompleteQuiz(userId: string, quizId: string, score: number, completedAt: string) {
  const result = await read(client().from('quiz_attempts').update({ score, completed_at: completedAt }).eq('id', quizId).eq('user_id', userId).is('score', null).is('completed_at', null).select('*'));
  return (result as Array<{ course_id: string; scope: string; scope_id: string }>)[0] ?? null;
}

export async function remoteActivity(userId: string, courseId: string) {
  const rows = await read(client().from('progress_events').select('event_type, lesson_id, data_json, created_at').eq('user_id', userId).eq('course_id', courseId).order('created_at', { ascending: false }).limit(40));
  return (rows as Array<{ event_type: string; lesson_id: string | null; data_json: unknown; created_at: string }>).map((event) => ({ type: event.event_type, lessonId: event.lesson_id, data: event.data_json, at: event.created_at }));
}

export async function remoteCount(table: string) {
  const result = await read(client().from(table).select('*', { count: 'exact', head: true }));
  return result;
}
