import { getSupabaseAdmin } from './supabase.js';
import { newId, nowIso } from './db.js';
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

type RemoteCourse = {
  id: string;
  user_id: string;
  topic: string;
  title: string;
  description: string;
  outcomes_json: unknown;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
};

type RemoteSection = {
  id: string;
  course_id: string;
  title: string;
  summary: string;
  position: number;
};

type RemoteLesson = {
  id: string;
  section_id: string;
  title: string;
  summary: string;
  estimated_minutes: number;
  position: number;
  material_json: unknown;
  last_generated_at: string | null;
  completed_at: string | null;
};

type RemoteLock = {
  user_id: string;
  course_id: string;
  lesson_id: string;
  lesson_title: string;
  created_at: string;
};

type RemoteQueryResult<T> = { data: T; error: { message: string; code?: string } | null };

async function read<T>(query: PromiseLike<RemoteQueryResult<T>>) {
  const result = await query;
  if (result.error) throw new Error(`Supabase query failed: ${result.error.message}`);
  return result.data;
}

function outcomes(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function material(value: unknown) {
  return value ? LessonMaterialSchema.parse(value) : null;
}

export async function supabaseHealth() {
  const client = getSupabaseAdmin();
  await read(client.from('users').select('id', { head: true, count: 'exact' }));
}

export async function remoteCourseRow(userId: string, courseId: string) {
  return read(client().from('courses').select('*').eq('id', courseId).eq('user_id', userId).maybeSingle<RemoteCourse>());
}

function client() {
  return getSupabaseAdmin();
}

export async function remoteSerializeCourse(userId: string, courseId: string): Promise<Course | null> {
  const course = await remoteCourseRow(userId, courseId);
  if (!course) return null;
  const sections = await read(client().from('course_sections').select('*').eq('course_id', courseId).order('position', { ascending: true }));
  const typedSections = (sections as RemoteSection[]).sort((a, b) => a.position - b.position);
  const sectionIds = typedSections.map((section) => section.id);
  const lessons = sectionIds.length
    ? await read(client().from('lessons').select('*').in('section_id', sectionIds).order('position', { ascending: true }))
    : [];
  const typedLessons = (lessons as RemoteLesson[]).sort((a, b) => a.position - b.position);
  const completedLessons = typedLessons.filter((lesson) => lesson.completed_at).length;
  return CourseSchema.parse({
    id: course.id,
    topic: course.topic,
    title: course.title,
    description: course.description,
    outcomes: outcomes(course.outcomes_json),
    status: course.status,
    createdAt: course.created_at,
    sections: typedSections.map((section) => ({
      id: section.id,
      title: section.title,
      summary: section.summary,
      position: section.position,
      lessons: typedLessons.filter((lesson) => lesson.section_id === section.id).map((lesson) => ({
        id: lesson.id,
        sectionId: lesson.section_id,
        title: lesson.title,
        summary: lesson.summary,
        estimatedMinutes: lesson.estimated_minutes,
        position: lesson.position,
        material: material(lesson.material_json),
        completedAt: lesson.completed_at,
      })),
    })),
    progress: {
      completedLessons,
      totalLessons: typedLessons.length,
      percent: typedLessons.length ? Math.round((completedLessons / typedLessons.length) * 100) : 0,
    },
  });
}

export async function remoteListCourses(userId: string) {
  const rows = await read(client().from('courses').select('id').eq('user_id', userId).order('updated_at', { ascending: false }));
  const courses = await Promise.all((rows as Array<{ id: string }>).map((row) => remoteSerializeCourse(userId, row.id)));
  return courses.filter((course): course is Course => Boolean(course));
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
  await read(client().rpc('create_course_from_roadmap', {
    p_course_id: courseId,
    p_user_id: userId,
    p_topic: roadmap.topic,
    p_title: roadmap.title,
    p_description: roadmap.description,
    p_outcomes: roadmap.outcomes,
    p_sections: sectionRows,
  }));
  await remoteAddEvent(userId, courseId, 'course_created', undefined, { topic: roadmap.topic });
  return remoteSerializeCourse(userId, courseId);
}

export async function remoteUpdateCourse(userId: string, courseId: string, patch: { title?: string; status?: 'active' | 'archived' }) {
  const course = await remoteCourseRow(userId, courseId);
  if (!course) return null;
  const updatedAt = nowIso();
  await read(client().from('courses').update({
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updated_at: updatedAt,
  }).eq('id', courseId).eq('user_id', userId));
  if (patch.title !== undefined && patch.title !== course.title) {
    await remoteAddEvent(userId, courseId, 'course_renamed', undefined, { from: course.title, to: patch.title });
  }
  if (patch.status !== undefined && patch.status !== course.status) {
    await remoteAddEvent(userId, courseId, patch.status === 'archived' ? 'course_archived' : 'course_reopened');
  }
  return remoteSerializeCourse(userId, courseId);
}

export async function remoteDeleteCourse(userId: string, courseId: string) {
  const lock = await read(client().from('lesson_generation_locks').select('lesson_id').eq('user_id', userId).eq('course_id', courseId).maybeSingle<{ lesson_id: string }>());
  if (lock) return { deleted: false as const, locked: true as const };
  const result = await read(client().from('courses').delete().eq('id', courseId).eq('user_id', userId).select('id'));
  return { deleted: (result as Array<{ id: string }>).length === 1, locked: false as const };
}

export async function remoteGetCourseMemory(courseId: string) {
  const sections = await read(client().from('course_sections').select('id').eq('course_id', courseId));
  const sectionIds = (sections as Array<{ id: string }>).map((section) => section.id);
  if (!sectionIds.length) return [];
  const rows = await read(client().from('lessons').select('title, material_json, last_generated_at').in('section_id', sectionIds).not('material_json', 'is', null).order('last_generated_at', { ascending: false }));
  return (rows as Array<{ title: string; material_json: unknown }>).flatMap((row) => {
    const parsed = material(row.material_json);
    if (!parsed) return [];
    const formats = parsed.nodes.length ? parsed.nodes.map((node) => node.type).join(', ') : 'legacy prose';
    return [`${row.title}: ${parsed.keyTakeaway}`, `Prompt: ${parsed.reflectivePrompt}`, `Formats used: ${formats}`];
  }).slice(0, 40);
}

export async function remoteCourseContext(courseId: string, scope: 'lesson' | 'chapter' | 'course', scopeId: string) {
  if (scope === 'lesson') {
    const row = await read(client().from('lessons').select('id, title, summary, material_json, course_sections!inner(title, course_id)').eq('id', scopeId).eq('course_sections.course_id', courseId).maybeSingle<{ title: string; summary: string; material_json: unknown }>()).catch(() => null);
    if (!row) return null;
    const parsed = material(row.material_json);
    return { title: row.title, context: [row.summary, ...contextFromMaterial(parsed)] };
  }
  if (scope === 'chapter') {
    const section = await read(client().from('course_sections').select('title').eq('id', scopeId).eq('course_id', courseId).maybeSingle<{ title: string }>());
    if (!section) return null;
    const rows = await read(client().from('lessons').select('title, summary, material_json').eq('section_id', scopeId).order('position', { ascending: true }));
    return { title: section.title, context: (rows as Array<{ summary: string; material_json: unknown }>).flatMap((row) => [row.summary, ...contextFromMaterial(material(row.material_json))]) };
  }
  if (scopeId !== courseId) return null;
  const courseRows = await read(client().from('courses').select('title, description').eq('id', courseId).maybeSingle<{ title: string; description: string }>());
  if (!courseRows) return null;
  const sections = await read(client().from('course_sections').select('id').eq('course_id', courseId));
  const sectionIds = (sections as Array<{ id: string }>).map((section) => section.id);
  const rows = sectionIds.length ? await read(client().from('lessons').select('title, summary, material_json').in('section_id', sectionIds).order('position', { ascending: true })) : [];
  return { title: courseRows.title, context: [courseRows.description, ...(rows as Array<{ summary: string; material_json: unknown }>).flatMap((row) => [row.summary, ...contextFromMaterial(material(row.material_json))])] };
}

function contextFromMaterial(parsed: LessonMaterial | null) {
  if (!parsed) return [];
  return [parsed.keyTakeaway, parsed.reflectivePrompt, ...parsed.article.sections.flatMap((section) => section.paragraphs), ...parsed.nodes.map((node) => node.heading)];
}

export async function remoteAddEvent(userId: string, courseId: string, eventType: string, lessonId?: string, data?: unknown) {
  await read(client().from('progress_events').insert({
    id: newId(), user_id: userId, course_id: courseId, lesson_id: lessonId ?? null,
    event_type: eventType, data_json: data ?? null, created_at: nowIso(),
  }));
}

export async function remoteLessonRow(userId: string, courseId: string, lessonId: string) {
  const course = await remoteCourseRow(userId, courseId);
  if (!course) return null;
  const row = await read(client().from('lessons').select('*').eq('id', lessonId).maybeSingle<RemoteLesson>());
  if (!row) return null;
  const section = await read(client().from('course_sections').select('id, title, course_id').eq('id', row.section_id).eq('course_id', courseId).maybeSingle<{ id: string; title: string; course_id: string }>());
  return section ? { course, row, sectionTitle: section.title } : null;
}

export async function remoteAcquireLessonLock(userId: string, courseId: string, lessonId: string, lessonTitle: string, staleBefore: string) {
  const result = await read(client().rpc('claim_lesson_generation_lock', {
    p_user_id: userId, p_course_id: courseId, p_lesson_id: lessonId, p_lesson_title: lessonTitle, p_stale_before: staleBefore,
  }));
  const payload = result as { acquired?: boolean; lock?: RemoteLock };
  return payload.acquired ? { acquired: true as const } : { acquired: false as const, lock: payload.lock };
}

export async function remoteReleaseLessonLock(userId: string, courseId: string, lessonId: string) {
  await read(client().from('lesson_generation_locks').delete().eq('user_id', userId).eq('course_id', courseId).eq('lesson_id', lessonId));
}

export async function remoteSaveLessonMaterial(lessonId: string, materialValue: LessonMaterial) {
  await read(client().from('lessons').update({ material_json: materialValue, last_generated_at: nowIso() }).eq('id', lessonId).is('material_json', null));
}

export async function remoteCompleteLesson(userId: string, courseId: string, lessonId: string) {
  const row = await read(client().from('lessons').select('id, section_id, completed_at').eq('id', lessonId).maybeSingle<{ id: string; section_id: string; completed_at: string | null }>());
  if (!row) return null;
  const section = await read(client().from('course_sections').select('id').eq('id', row.section_id).eq('course_id', courseId).maybeSingle<{ id: string }>());
  if (!section) return null;
  if (!row.completed_at) {
    const completedAt = nowIso();
    await read(client().from('lessons').update({ completed_at: completedAt }).eq('id', lessonId));
    await read(client().from('courses').update({ updated_at: completedAt }).eq('id', courseId).eq('user_id', userId));
    await remoteAddEvent(userId, courseId, 'lesson_completed', lessonId);
  }
  return remoteSerializeCourse(userId, courseId);
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
