import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { db, json, newId, nowIso, parseJson, cleanExpiredSessions } from './db.js';
import {
  getUserById,
  requireAuth,
  revokeSession,
  AuthFlowError,
  publicUser,
  requestAuthCode,
  verifyAuthCode,
  type AuthRequest,
} from './auth.js';
import { generateLesson, generateQuiz, generateRoadmap } from './ai.js';
import { billingStatusCode, createCreditTopUp, getCreditSummary, grantNewUserCredits, handleMidtransNotification, syncCreditTopUp } from './credits.js';
import { isSupabaseStorage } from './supabase.js';
import { completeSupabaseGoogleAuth, remoteGetUserById, remoteRevokeSession } from './supabase-auth.js';
import {
  remoteActivity,
  remoteAcquireLessonLock,
  remoteAddEvent,
  remoteCompleteLesson,
  remoteCompleteQuiz,
  remoteCourseContext,
  remoteCreateCourse,
  remoteDeleteCourse,
  remoteGetCourseMemory,
  remoteGetQuiz,
  remoteInsertQuiz,
  remoteLessonRow,
  remoteListCourses,
  remoteReleaseLessonLock,
  remoteSaveLessonMaterial,
  remoteSerializeCourse,
  remoteUpdateCourse,
} from './supabase-store.js';
import {
  remoteBillingStatusCode,
  remoteCreateCreditTopUp,
  remoteGetCreditSummary,
  remoteGrantNewUserCredits,
  remoteHandleMidtransNotification,
  remoteSyncCreditTopUp,
} from './supabase-credits.js';
import {
  CourseSchema,
  CoursePatchSchema,
  AuthCodeRequestSchema,
  AuthCodeVerifySchema,
  GoogleAuthRequestSchema,
  GoogleAuthResponseSchema,
  createQuizSubmissionSchema,
  LessonMaterialSchema,
  CreateTopUpInputSchema,
  ProductProgressSchema,
  QuizPublicSchema,
  QuizRequestSchema,
  QuizSchema,
  QuizSubmissionSchema,
  RoadmapSchema,
  TopicInputSchema,
  UserSchema,
  lessonMaterialContext,
  type Course,
  type LessonMaterial,
  type Roadmap,
} from '../shared/schemas.js';

const app = express();
app.disable('x-powered-by');

class CorsOriginError extends Error {}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isLoopbackOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && isLoopbackHostname(url.hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

const configuredOrigin = process.env.SYNAU_CORS_ORIGIN;
if (configuredOrigin && !isLoopbackOrigin(configuredOrigin)) {
  throw new Error('SYNAU_CORS_ORIGIN must be a loopback HTTP(S) origin.');
}

const host = process.env.SYNAU_HOST ?? '127.0.0.1';
if (!isLoopbackHostname(host)) {
  throw new Error('SYNAU_HOST must remain loopback-only (127.0.0.1, localhost, or ::1).');
}

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || configuredOrigin === origin || isLoopbackOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new CorsOriginError('Origin is not allowed by this local Synau server.'));
  },
}));
app.use(express.json({ limit: '1mb' }));

const lessonGenerationFlights = new Map<string, Promise<unknown>>();
const userLessonGenerationFlights = new Map<string, {
  courseId: string;
  lessonId: string;
  lessonTitle: string;
  promise: Promise<unknown>;
}>();
const lessonGenerationLockTtlMs = 5 * 60 * 1000;

type LessonGenerationLock = {
  user_id: string;
  course_id: string;
  lesson_id: string;
  lesson_title: string;
  created_at: string;
};

function acquireLessonGenerationLock(userId: string, courseId: string, lessonId: string, lessonTitle: string) {
  const staleBefore = new Date(Date.now() - lessonGenerationLockTtlMs).toISOString();
  db.prepare('DELETE FROM lesson_generation_locks WHERE user_id = ? AND created_at <= ?').run(userId, staleBefore);
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO lesson_generation_locks (user_id, course_id, lesson_id, lesson_title, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, courseId, lessonId, lessonTitle, nowIso());
  if (inserted.changes === 1) return { acquired: true as const };
  return {
    acquired: false as const,
    lock: db.prepare('SELECT * FROM lesson_generation_locks WHERE user_id = ?').get(userId) as LessonGenerationLock | undefined,
  };
}

function releaseLessonGenerationLock(userId: string, courseId: string, lessonId: string) {
  db.prepare('DELETE FROM lesson_generation_locks WHERE user_id = ? AND course_id = ? AND lesson_id = ?')
    .run(userId, courseId, lessonId);
}

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const adjacentProjectDir = path.resolve(rootDir, '..');
const projectDir = fs.existsSync(path.join(adjacentProjectDir, 'index.html'))
  ? adjacentProjectDir
  : path.resolve(adjacentProjectDir, '..');

function userIdOf(req: Request) {
  return (req as AuthRequest).userId!;
}

function routeParam(req: Request, key: string) {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

function parseBody<T>(schema: z.ZodType<T>, req: Request, res: Response) {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request.', issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

function respondWithServiceError(res: Response, error: unknown, fallback: string) {
  const billing = billingStatusCode(error);
  if (billing) {
    res.status(billing.status).json(billing.body);
    return;
  }
  const remoteBilling = remoteBillingStatusCode(error);
  if (remoteBilling) {
    res.status(remoteBilling.status).json(remoteBilling.body);
    return;
  }
  res.status(502).json({ error: error instanceof Error ? error.message : fallback });
}

function respondWithAuthError(res: Response, error: unknown) {
  if (error instanceof AuthFlowError) {
    if (error.retryAfterSeconds > 0) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  console.error('[auth] unexpected authentication failure', error instanceof Error ? error.message : error);
  res.status(503).json({ error: 'Authentication service is temporarily unavailable.', code: 'auth_service_unavailable' });
}

function courseRow(userId: string, courseId: string) {
  return db.prepare('SELECT * FROM courses WHERE id = ? AND user_id = ?').get(courseId, userId) as {
    id: string;
    user_id: string;
    topic: string;
    title: string;
    description: string;
    outcomes_json: string;
    status: 'active' | 'archived';
    created_at: string;
    updated_at: string;
  } | undefined;
}

function serializeCourse(userId: string, courseId: string): Course | null {
  const course = courseRow(userId, courseId);
  if (!course) return null;
  const sections = db.prepare('SELECT * FROM course_sections WHERE course_id = ? ORDER BY position').all(courseId) as Array<{
    id: string;
    course_id: string;
    title: string;
    summary: string;
    position: number;
  }>;
  const lessons = db.prepare(`
    SELECT l.* FROM lessons l JOIN course_sections s ON s.id = l.section_id
    WHERE s.course_id = ? ORDER BY s.position, l.position
  `).all(courseId) as Array<{
    id: string;
    section_id: string;
    title: string;
    summary: string;
    estimated_minutes: number;
    position: number;
    material_json: string | null;
    completed_at: string | null;
  }>;
  const completedLessons = lessons.filter((lesson) => lesson.completed_at).length;
  const output = {
    id: course.id,
    topic: course.topic,
    title: course.title,
    description: course.description,
    outcomes: parseJson<string[]>(course.outcomes_json),
    status: course.status,
    createdAt: course.created_at,
    sections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      summary: section.summary,
      position: section.position,
      lessons: lessons.filter((lesson) => lesson.section_id === section.id).map((lesson) => ({
        id: lesson.id,
        sectionId: lesson.section_id,
        title: lesson.title,
        summary: lesson.summary,
        estimatedMinutes: lesson.estimated_minutes,
        position: lesson.position,
        material: lesson.material_json ? LessonMaterialSchema.parse(parseJson(lesson.material_json)) : null,
        completedAt: lesson.completed_at,
      })),
    })),
    progress: {
      completedLessons,
      totalLessons: lessons.length,
      percent: lessons.length ? Math.round((completedLessons / lessons.length) * 100) : 0,
    },
  };
  return CourseSchema.parse(output);
}

function getCourseMemory(courseId: string) {
  const rows = db.prepare(`
    SELECT l.title, l.material_json FROM lessons l
    JOIN course_sections s ON s.id = l.section_id
    WHERE s.course_id = ? AND l.material_json IS NOT NULL
    ORDER BY l.last_generated_at DESC
  `).all(courseId) as Array<{ title: string; material_json: string }>;
  return rows.flatMap((row) => {
    const material = LessonMaterialSchema.parse(parseJson(row.material_json));
    const formats = material.nodes.length > 0 ? material.nodes.map((node) => node.type).join(', ') : 'legacy prose';
    return [`${row.title}: ${material.keyTakeaway}`, `Prompt: ${material.reflectivePrompt}`, `Formats used: ${formats}`];
  }).slice(0, 40);
}

function compactLessonContext(material: LessonMaterial | null) {
  return material ? lessonMaterialContext(material).slice(0, 8).map((line) => line.slice(0, 700)) : [];
}

function addEvent(userId: string, courseId: string, eventType: string, lessonId?: string, data?: unknown) {
  db.prepare(`
    INSERT INTO progress_events (id, user_id, course_id, lesson_id, event_type, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId(), userId, courseId, lessonId ?? null, eventType, data ? json(data) : null, nowIso());
}

function courseContext(courseId: string, scope: 'lesson' | 'chapter' | 'course', scopeId: string) {
  if (scope === 'lesson') {
    const row = db.prepare(`
      SELECT l.title, l.summary, l.material_json, s.title AS section_title
      FROM lessons l JOIN course_sections s ON s.id = l.section_id
      WHERE l.id = ? AND s.course_id = ?
    `).get(scopeId, courseId) as { title: string; summary: string; material_json: string | null; section_title: string } | undefined;
    if (!row) return null;
    const material = row.material_json ? LessonMaterialSchema.parse(parseJson(row.material_json)) : null;
    return { title: row.title, context: [row.summary, ...compactLessonContext(material)] };
  }
  if (scope === 'chapter') {
    const section = db.prepare('SELECT title FROM course_sections WHERE id = ? AND course_id = ?').get(scopeId, courseId) as { title: string } | undefined;
    if (!section) return null;
    const rows = db.prepare('SELECT title, summary, material_json FROM lessons WHERE section_id = ? ORDER BY position').all(scopeId) as Array<{ title: string; summary: string; material_json: string | null }>;
    return {
      title: section.title,
      context: rows.flatMap((row) => {
        const material = row.material_json ? LessonMaterialSchema.parse(parseJson(row.material_json)) : null;
        return [row.summary, ...compactLessonContext(material)];
      }),
    };
  }
  if (scopeId !== courseId) return null;
  const course = db.prepare('SELECT title, description FROM courses WHERE id = ?').get(courseId) as { title: string; description: string } | undefined;
  if (!course) return null;
  const rows = db.prepare(`
    SELECT l.title, l.summary, l.material_json FROM lessons l
    JOIN course_sections s ON s.id = l.section_id WHERE s.course_id = ? ORDER BY s.position, l.position
  `).all(courseId) as Array<{ title: string; summary: string; material_json: string | null }>;
  return {
    title: course.title,
    context: [course.description, ...rows.flatMap((row) => {
      const material = row.material_json ? LessonMaterialSchema.parse(parseJson(row.material_json)) : null;
      return [row.summary, ...compactLessonContext(material)];
    })],
  };
}

app.get('/healthz', async (_req, res) => {
  try {
    if (isSupabaseStorage()) {
      const { supabaseHealth } = await import('./supabase-store.js');
      await supabaseHealth();
      res.json({ ok: true, service: 'synau', database: 'supabase' });
      return;
    }
    db.prepare('SELECT 1 AS ok').get();
    res.json({ ok: true, service: 'synau', database: 'ready' });
  } catch {
    res.status(503).json({ ok: false, service: 'synau', database: 'unavailable' });
  }
});

app.get('/api/auth/config', (_req, res) => {
  res.json({ provider: isSupabaseStorage() ? 'google' : 'email' });
});

app.post('/api/auth/google/session', async (req, res) => {
  if (!isSupabaseStorage()) {
    res.status(410).json({ error: 'Google sign-in is available only in Supabase mode.', code: 'google_auth_unavailable' });
    return;
  }
  const body = parseBody(GoogleAuthRequestSchema, req, res);
  if (!body) return;
  try {
    const result = await completeSupabaseGoogleAuth(body);
    if (result.status === 'authenticated' && result.created) await remoteGrantNewUserCredits(result.user.id);
    const response = result.status === 'authenticated'
      ? { ...result, user: UserSchema.parse(publicUser(result.user)) }
      : result;
    res.json(GoogleAuthResponseSchema.parse(response));
  } catch (error) {
    respondWithAuthError(res, error);
  }
});

app.post('/api/auth/request-code', async (req, res) => {
  if (isSupabaseStorage()) {
    res.status(410).json({ error: 'Google sign-in is the only authentication method for this Synau environment.', code: 'google_auth_only' });
    return;
  }
  const body = parseBody(AuthCodeRequestSchema, req, res);
  if (!body) return;
  try {
    res.json(await requestAuthCode(body));
  } catch (error) {
    respondWithAuthError(res, error);
  }
});

app.post('/api/auth/verify-code', async (req, res) => {
  if (isSupabaseStorage()) {
    res.status(410).json({ error: 'Google sign-in is the only authentication method for this Synau environment.', code: 'google_auth_only' });
    return;
  }
  const body = parseBody(AuthCodeVerifySchema, req, res);
  if (!body) return;
  try {
    const result = verifyAuthCode(body);
    if (result.created) grantNewUserCredits(result.user.id);
    res.json({ token: result.token, user: UserSchema.parse(publicUser(result.user)) });
  } catch (error) {
    respondWithAuthError(res, error);
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = (req.header('authorization') ?? '').slice(7);
  if (isSupabaseStorage()) await remoteRevokeSession(token);
  else revokeSession(token);
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = isSupabaseStorage() ? await remoteGetUserById(userIdOf(req)) : getUserById(userIdOf(req));
  if (!user) {
    res.status(401).json({ error: 'Account not found.' });
    return;
  }
  res.json({ user: UserSchema.parse(publicUser(user)) });
});

app.get('/api/courses', requireAuth, async (req, res) => {
  if (isSupabaseStorage()) {
    res.json({ courses: await remoteListCourses(userIdOf(req)) });
    return;
  }
  const rows = db.prepare('SELECT id FROM courses WHERE user_id = ? ORDER BY updated_at DESC').all(userIdOf(req)) as Array<{ id: string }>;
  res.json({ courses: rows.map((row) => serializeCourse(userIdOf(req), row.id)).filter(Boolean) });
});

app.post('/api/generate/roadmap', requireAuth, async (req, res) => {
  const body = parseBody(TopicInputSchema, req, res);
  if (!body) return;
  try {
    const roadmap = await generateRoadmap(body.topic, userIdOf(req));
    res.json({ roadmap });
  } catch (error) {
    respondWithServiceError(res, error, 'Roadmap generation failed.');
  }
});

app.post('/api/courses', requireAuth, async (req, res) => {
  const body = parseBody(RoadmapSchema, req, res);
  if (!body) return;
  const userId = userIdOf(req);
  if (isSupabaseStorage()) {
    const course = await remoteCreateCourse(userId, body);
    res.status(201).json({ course });
    return;
  }
  const courseId = newId();
  const createdAt = nowIso();
  const insert = db.transaction((roadmap: Roadmap) => {
    db.prepare(`INSERT INTO courses (id, user_id, topic, title, description, outcomes_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run(courseId, userId, roadmap.topic, roadmap.title, roadmap.description, json(roadmap.outcomes), createdAt, createdAt);
    for (const section of roadmap.sections) {
      const sectionId = newId();
      db.prepare('INSERT INTO course_sections (id, course_id, title, summary, position) VALUES (?, ?, ?, ?, ?)')
        .run(sectionId, courseId, section.title, section.summary, section.position);
      for (const lesson of section.lessons) {
        db.prepare(`INSERT INTO lessons (id, section_id, title, summary, estimated_minutes, position)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(newId(), sectionId, lesson.title, lesson.summary, lesson.estimatedMinutes, lesson.position);
      }
    }
    addEvent(userId, courseId, 'course_created', undefined, { topic: roadmap.topic });
  });
  insert(body);
  res.status(201).json({ course: serializeCourse(userId, courseId) });
});

app.get('/api/courses/:courseId', requireAuth, async (req, res) => {
  const course = isSupabaseStorage()
    ? await remoteSerializeCourse(userIdOf(req), routeParam(req, 'courseId'))
    : serializeCourse(userIdOf(req), routeParam(req, 'courseId'));
  if (!course) {
    res.status(404).json({ error: 'Course not found.' });
    return;
  }
  res.json({ course });
});

app.patch('/api/courses/:courseId', requireAuth, async (req, res) => {
  const courseId = routeParam(req, 'courseId');
  const course = isSupabaseStorage() ? undefined : courseRow(userIdOf(req), courseId);
  const body = parseBody(CoursePatchSchema, req, res);
  if (!body) return;
  if (isSupabaseStorage()) {
    const updated = await remoteUpdateCourse(userIdOf(req), courseId, body);
    if (!updated) {
      res.status(404).json({ error: 'Course not found.' });
      return;
    }
    res.json({ course: updated });
    return;
  }
  if (!course) {
    res.status(404).json({ error: 'Course not found.' });
    return;
  }
  const updatedAt = nowIso();
  const nextTitle = body.title ?? course.title;
  const nextStatus = body.status ?? course.status;
  db.prepare('UPDATE courses SET title = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(nextTitle, nextStatus, updatedAt, courseId, userIdOf(req));
  if (body.title !== undefined && body.title !== course.title) {
    addEvent(userIdOf(req), courseId, 'course_renamed', undefined, { from: course.title, to: nextTitle });
  }
  if (body.status !== undefined && body.status !== course.status) {
    addEvent(userIdOf(req), courseId, body.status === 'archived' ? 'course_archived' : 'course_reopened');
  }
  res.json({ course: serializeCourse(userIdOf(req), courseId) });
});

app.delete('/api/courses/:courseId', requireAuth, async (req, res) => {
  const userId = userIdOf(req);
  const courseId = routeParam(req, 'courseId');
  if (isSupabaseStorage()) {
    const course = await remoteSerializeCourse(userId, courseId);
    if (!course) {
      res.status(404).json({ error: 'Course not found.' });
      return;
    }
    const result = await remoteDeleteCourse(userId, courseId);
    if (result.locked) {
      res.status(409).json({ code: 'course_generation_in_progress', error: 'This learning path is generating a lesson. Wait for it to finish before deleting the course.' });
      return;
    }
    res.status(result.deleted ? 204 : 404).end();
    return;
  }
  const course = courseRow(userId, courseId);
  if (!course) {
    res.status(404).json({ error: 'Course not found.' });
    return;
  }
  const activeFlight = userLessonGenerationFlights.get(userId);
  const activeLock = db.prepare('SELECT lesson_id FROM lesson_generation_locks WHERE user_id = ? AND course_id = ?')
    .get(userId, courseId) as { lesson_id: string } | undefined;
  if (activeFlight?.courseId === courseId || activeLock) {
    res.status(409).json({
      code: 'course_generation_in_progress',
      error: 'This learning path is generating a lesson. Wait for it to finish before deleting the course.',
    });
    return;
  }
  db.prepare('DELETE FROM courses WHERE id = ? AND user_id = ?').run(courseId, userId);
  res.status(204).end();
});

app.post('/api/courses/:courseId/lessons/:lessonId/open', requireAuth, async (req, res) => {
  const userId = userIdOf(req);
  const courseId = routeParam(req, 'courseId');
  const lessonId = routeParam(req, 'lessonId');
  if (isSupabaseStorage()) {
    const remoteLesson = await remoteLessonRow(userId, courseId, lessonId);
    if (!remoteLesson) {
      res.status(404).json({ error: 'Lesson not found.' });
      return;
    }
    if (remoteLesson.course.status === 'archived') {
      res.status(409).json({ error: 'Archived courses are read-only. Reopen the course to generate material.' });
      return;
    }
    let generated = false;
    if (!remoteLesson.row.material_json) {
      const activeUserFlight = userLessonGenerationFlights.get(userId);
      if (activeUserFlight && (activeUserFlight.courseId !== courseId || activeUserFlight.lessonId !== lessonId)) {
        res.status(409).json({
          code: 'lesson_generation_in_progress',
          error: `Another lesson is currently being generated: “${activeUserFlight.lessonTitle}”. Please wait for it to finish before opening another subchapter.`,
          activeLessonId: activeUserFlight.lessonId,
          activeCourseId: activeUserFlight.courseId,
        });
        return;
      }
      try {
        const flightKey = `${courseId}:${lessonId}`;
        let flight = lessonGenerationFlights.get(flightKey);
        if (!flight && activeUserFlight && activeUserFlight.courseId === courseId && activeUserFlight.lessonId === lessonId) flight = activeUserFlight.promise;
        if (!flight) {
          const lockResult = await remoteAcquireLessonLock(userId, courseId, lessonId, remoteLesson.row.title, new Date(Date.now() - lessonGenerationLockTtlMs).toISOString());
          if (!lockResult.acquired) {
            const lock = lockResult.lock;
            const sameLesson = lock?.course_id === courseId && lock.lesson_id === lessonId;
            res.status(409).json({
              code: 'lesson_generation_in_progress',
              error: sameLesson ? 'This lesson is already being generated. Please wait for it to finish before trying again.' : `Another lesson is currently being generated: “${lock?.lesson_title ?? 'another subchapter'}”. Please wait for it to finish before opening another lesson.`,
              activeLessonId: lock?.lesson_id ?? lessonId,
              activeCourseId: lock?.course_id ?? courseId,
            });
            return;
          }
          generated = true;
          const generation = Promise.resolve().then(async () => generateLesson({
            courseId,
            lessonId,
            topic: remoteLesson.course.topic,
            courseTitle: remoteLesson.course.title,
            sectionTitle: remoteLesson.sectionTitle,
            lessonTitle: remoteLesson.row.title,
            lessonSummary: remoteLesson.row.summary,
            courseMemory: await remoteGetCourseMemory(courseId),
          }, userId)).then(async (generatedMaterial) => {
            const boundMaterial = LessonMaterialSchema.parse({ ...generatedMaterial, lessonId }) as LessonMaterial;
            await remoteSaveLessonMaterial(lessonId, boundMaterial);
            return boundMaterial;
          }).finally(async () => {
            await remoteReleaseLessonLock(userId, courseId, lessonId);
            if (lessonGenerationFlights.get(flightKey) === generation) lessonGenerationFlights.delete(flightKey);
            if (userLessonGenerationFlights.get(userId)?.promise === generation) userLessonGenerationFlights.delete(userId);
          });
          flight = generation;
          lessonGenerationFlights.set(flightKey, generation);
          userLessonGenerationFlights.set(userId, { courseId, lessonId, lessonTitle: remoteLesson.row.title, promise: generation });
        }
        await remoteAddEvent(userId, courseId, 'lesson_opened', lessonId);
        await flight;
      } catch (error) {
        const billing = billingStatusCode(error) ?? remoteBillingStatusCode(error);
        if (billing) res.status(billing.status).json(billing.body);
        else res.status(502).json({ error: error instanceof Error ? error.message : 'Lesson generation failed.' });
        return;
      }
    } else {
      await remoteAddEvent(userId, courseId, 'lesson_opened', lessonId);
    }
    res.json({ course: await remoteSerializeCourse(userId, courseId), generated });
    return;
  }
  const course = courseRow(userId, courseId);
  const row = db.prepare(`
    SELECT l.*, s.title AS section_title FROM lessons l JOIN course_sections s ON s.id = l.section_id
    WHERE l.id = ? AND s.course_id = ?
  `).get(lessonId, courseId) as {
    id: string; section_id: string; title: string; summary: string; material_json: string | null; section_title: string;
  } | undefined;
  if (!course || !row) {
    res.status(404).json({ error: 'Lesson not found.' });
    return;
  }
  if (course.status === 'archived') {
    res.status(409).json({ error: 'Archived courses are read-only. Reopen the course to generate material.' });
    return;
  }
  let generated = false;
  if (!row.material_json) {
    const activeUserFlight = userLessonGenerationFlights.get(userId);
    if (activeUserFlight && (activeUserFlight.courseId !== courseId || activeUserFlight.lessonId !== row.id)) {
      res.status(409).json({
        code: 'lesson_generation_in_progress',
        error: `Another lesson is currently being generated: “${activeUserFlight.lessonTitle}”. Please wait for it to finish before opening another subchapter.`,
        activeLessonId: activeUserFlight.lessonId,
        activeCourseId: activeUserFlight.courseId,
      });
      return;
    }

    try {
      const flightKey = `${courseId}:${row.id}`;
      let flight = lessonGenerationFlights.get(flightKey);
      if (!flight && activeUserFlight && activeUserFlight.courseId === courseId && activeUserFlight.lessonId === row.id) {
        flight = activeUserFlight.promise;
      }
      if (!flight) {
        const lockResult = acquireLessonGenerationLock(userId, courseId, row.id, row.title);
        if (!lockResult.acquired) {
          const lock = lockResult.lock;
          const sameLesson = lock?.course_id === courseId && lock.lesson_id === row.id;
          res.status(409).json({
            code: 'lesson_generation_in_progress',
            error: sameLesson
              ? 'This lesson is already being generated. Please wait for it to finish before trying again.'
              : `Another lesson is currently being generated: “${lock?.lesson_title ?? 'another subchapter'}”. Please wait for it to finish before opening another subchapter.`,
            activeLessonId: lock?.lesson_id ?? row.id,
            activeCourseId: lock?.course_id ?? courseId,
          });
          return;
        }
        generated = true;
        const generation = Promise.resolve().then(() => generateLesson({
            courseId,
            lessonId: row.id,
            topic: course.topic,
            courseTitle: course.title,
            sectionTitle: row.section_title,
            lessonTitle: row.title,
            lessonSummary: row.summary,
            courseMemory: getCourseMemory(courseId),
          }, userId)).then((material) => {
          const boundMaterial = LessonMaterialSchema.parse({ ...material, lessonId: row.id }) as LessonMaterial;
          db.prepare('UPDATE lessons SET material_json = ?, last_generated_at = ? WHERE id = ? AND material_json IS NULL')
            .run(json(boundMaterial), nowIso(), row.id);
          return boundMaterial;
        }).finally(() => {
          releaseLessonGenerationLock(userId, courseId, row.id);
          if (lessonGenerationFlights.get(flightKey) === generation) lessonGenerationFlights.delete(flightKey);
          if (userLessonGenerationFlights.get(userId)?.promise === generation) userLessonGenerationFlights.delete(userId);
        });
        flight = generation;
        lessonGenerationFlights.set(flightKey, generation);
        userLessonGenerationFlights.set(userId, {
          courseId,
          lessonId: row.id,
          lessonTitle: row.title,
          promise: generation,
        });
      }
      addEvent(userId, courseId, 'lesson_opened', row.id);
      await flight;
    } catch (error) {
      const billing = billingStatusCode(error);
      if (billing) res.status(billing.status).json(billing.body);
      else res.status(502).json({ error: error instanceof Error ? error.message : 'Lesson generation failed.' });
      return;
    }
  } else {
    addEvent(userId, courseId, 'lesson_opened', row.id);
  }
  res.json({ course: serializeCourse(userId, courseId), generated });
});

app.post('/api/courses/:courseId/lessons/:lessonId/complete', requireAuth, async (req, res) => {
  const userId = userIdOf(req);
  const courseId = routeParam(req, 'courseId');
  const lessonId = routeParam(req, 'lessonId');
  if (isSupabaseStorage()) {
    const course = await remoteSerializeCourse(userId, courseId);
    if (course?.status === 'archived') {
      res.status(409).json({ error: 'Archived courses are read-only.' });
      return;
    }
    const completed = await remoteCompleteLesson(userId, courseId, lessonId);
    if (!course || !completed) {
      res.status(404).json({ error: 'Lesson not found.' });
      return;
    }
    res.json({ course: completed });
    return;
  }
  const course = courseRow(userId, courseId);
  const lesson = db.prepare(`SELECT l.id FROM lessons l JOIN course_sections s ON s.id = l.section_id
    WHERE l.id = ? AND s.course_id = ?`).get(lessonId, courseId) as { id: string } | undefined;
  if (!course || !lesson) {
    res.status(404).json({ error: 'Lesson not found.' });
    return;
  }
  if (course.status === 'archived') {
    res.status(409).json({ error: 'Archived courses are read-only.' });
    return;
  }
  const current = db.prepare('SELECT completed_at FROM lessons WHERE id = ?').get(lesson.id) as { completed_at: string | null };
  if (current.completed_at) {
    res.json({ course: serializeCourse(userId, course.id) });
    return;
  }
  const completedAt = nowIso();
  db.prepare('UPDATE lessons SET completed_at = ? WHERE id = ?').run(completedAt, lesson.id);
  db.prepare('UPDATE courses SET updated_at = ? WHERE id = ?').run(completedAt, course.id);
  addEvent(userId, course.id, 'lesson_completed', lesson.id);
  res.json({ course: serializeCourse(userId, course.id) });
});

app.post('/api/quizzes/generate', requireAuth, async (req, res) => {
  const body = parseBody(QuizRequestSchema, req, res);
  if (!body) return;
  const userId = userIdOf(req);
  const course = isSupabaseStorage()
    ? await remoteSerializeCourse(userId, body.courseId)
    : courseRow(userId, body.courseId);
  if (!course) {
    res.status(404).json({ error: 'Quiz scope not found.' });
    return;
  }
  const context = isSupabaseStorage()
    ? await remoteCourseContext(body.courseId, body.scope, body.scopeId)
    : courseContext(body.courseId, body.scope, body.scopeId);
  if (!context) {
    res.status(404).json({ error: 'Quiz scope not found.' });
    return;
  }
  if (course.status === 'archived') {
    res.status(409).json({ error: 'Archived courses are read-only. Reopen the course to generate quizzes.' });
    return;
  }
  try {
    const quiz = await generateQuiz({
      ...body,
      courseTitle: course.title,
      topic: course.topic,
      scopeTitle: context.title,
      materialContext: context.context,
      courseMemory: isSupabaseStorage() ? await remoteGetCourseMemory(body.courseId) : getCourseMemory(body.courseId),
    }, userId);
    const attemptId = newId();
    const storedQuiz = QuizSchema.parse({ ...quiz, id: attemptId, scope: body.scope, scopeId: body.scopeId });
    if (isSupabaseStorage()) {
      await remoteInsertQuiz(userId, body.courseId, storedQuiz);
      await remoteAddEvent(userId, body.courseId, 'quiz_started', body.scope === 'lesson' ? body.scopeId : undefined, { scope: body.scope });
    } else {
      db.prepare(`INSERT INTO quiz_attempts (id, user_id, course_id, scope, scope_id, quiz_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(attemptId, userId, body.courseId, body.scope, body.scopeId, json(storedQuiz), nowIso());
      addEvent(userId, body.courseId, 'quiz_started', body.scope === 'lesson' ? body.scopeId : undefined, { scope: body.scope });
    }
    res.status(201).json({ quiz: QuizPublicSchema.parse(storedQuiz) });
  } catch (error) {
    respondWithServiceError(res, error, 'Quiz generation failed.');
  }
});

app.post('/api/quizzes/:quizId/submit', requireAuth, async (req, res) => {
  const body = parseBody(QuizSubmissionSchema, req, res);
  if (!body) return;
  const quizId = routeParam(req, 'quizId');
  if (isSupabaseStorage()) {
    const row = await remoteGetQuiz(userIdOf(req), quizId);
    if (!row) {
      res.status(404).json({ error: 'Quiz attempt not found.' });
      return;
    }
    if (row.score !== null || row.completed_at) {
      res.status(409).json({ error: 'This quiz attempt is already complete. Generate another attempt to retry.' });
      return;
    }
    const quiz = QuizSchema.parse(row.quiz_json);
    const checkedBody = createQuizSubmissionSchema(quiz).safeParse(body);
    if (!checkedBody.success) {
      res.status(400).json({ error: 'Invalid request.', issues: checkedBody.error.issues });
      return;
    }
    const results = quiz.questions.map((question) => ({
      questionId: question.id,
      correct: checkedBody.data.answers[question.id] === question.answerIndex,
      answerIndex: question.answerIndex,
      explanation: question.explanation,
    }));
    const score = Math.round((results.filter((result) => result.correct).length / quiz.questions.length) * 100);
    const completedAt = nowIso();
    const completed = await remoteCompleteQuiz(userIdOf(req), quizId, score, completedAt);
    if (!completed) {
      res.status(409).json({ error: 'This quiz attempt is already complete. Generate another attempt to retry.' });
      return;
    }
    await remoteAddEvent(userIdOf(req), completed.course_id, 'quiz_completed', completed.scope === 'lesson' ? completed.scope_id : undefined, { scope: completed.scope, score });
    res.json({ score, results, quiz: QuizPublicSchema.parse(quiz) });
    return;
  }
  const row = db.prepare('SELECT * FROM quiz_attempts WHERE id = ? AND user_id = ?').get(quizId, userIdOf(req)) as {
    id: string; course_id: string; scope: 'lesson' | 'chapter' | 'course'; scope_id: string; quiz_json: string; score: number | null; completed_at: string | null;
  } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Quiz attempt not found.' });
    return;
  }
  if (row.score !== null || row.completed_at) {
    res.status(409).json({ error: 'This quiz attempt is already complete. Generate another attempt to retry.' });
    return;
  }
  const quiz = QuizSchema.parse(parseJson(row.quiz_json));
  const checkedBody = createQuizSubmissionSchema(quiz).safeParse(body);
  if (!checkedBody.success) {
    res.status(400).json({ error: 'Invalid request.', issues: checkedBody.error.issues });
    return;
  }
  const results = quiz.questions.map((question) => ({
    questionId: question.id,
    correct: checkedBody.data.answers[question.id] === question.answerIndex,
    answerIndex: question.answerIndex,
    explanation: question.explanation,
  }));
  const score = Math.round((results.filter((result) => result.correct).length / quiz.questions.length) * 100);
  const completedAt = nowIso();
  const completed = db.transaction(() => {
    const update = db.prepare(`UPDATE quiz_attempts SET score = ?, completed_at = ?
      WHERE id = ? AND user_id = ? AND score IS NULL AND completed_at IS NULL`)
      .run(score, completedAt, row.id, userIdOf(req));
    if (update.changes !== 1) return false;
    addEvent(userIdOf(req), row.course_id, 'quiz_completed', row.scope === 'lesson' ? row.scope_id : undefined, { scope: row.scope, score });
    return true;
  })();
  if (!completed) {
    res.status(409).json({ error: 'This quiz attempt is already complete. Generate another attempt to retry.' });
    return;
  }
  res.json({ score, results, quiz: QuizPublicSchema.parse(quiz) });
});

app.get('/api/courses/:courseId/activity', requireAuth, async (req, res) => {
  const courseId = routeParam(req, 'courseId');
  if (isSupabaseStorage()) {
    if (!await remoteSerializeCourse(userIdOf(req), courseId)) {
      res.status(404).json({ error: 'Course not found.' });
      return;
    }
    res.json({ events: await remoteActivity(userIdOf(req), courseId) });
    return;
  }
  if (!courseRow(userIdOf(req), courseId)) {
    res.status(404).json({ error: 'Course not found.' });
    return;
  }
  const events = db.prepare(`SELECT event_type, lesson_id, data_json, created_at FROM progress_events
    WHERE user_id = ? AND course_id = ? ORDER BY created_at DESC LIMIT 40`).all(userIdOf(req), courseId) as Array<{ event_type: string; lesson_id: string | null; data_json: string | null; created_at: string }>;
  res.json({ events: events.map((event) => ({ type: event.event_type, lessonId: event.lesson_id, data: event.data_json ? parseJson(event.data_json) : null, at: event.created_at })) });
});

app.get('/api/credits', requireAuth, async (req, res) => {
  if (isSupabaseStorage()) {
    res.json({ credits: await remoteGetCreditSummary(userIdOf(req)) });
    return;
  }
  res.json({ credits: getCreditSummary(userIdOf(req)) });
});

app.post('/api/credits/topups', requireAuth, async (req, res) => {
  const body = parseBody(CreateTopUpInputSchema, req, res);
  if (!body) return;
  try {
    const topUp = isSupabaseStorage()
      ? await remoteCreateCreditTopUp(userIdOf(req), body.productId)
      : await createCreditTopUp(userIdOf(req), body.productId);
    res.status(201).json({ topUp });
  } catch (error) {
    respondWithServiceError(res, error, 'Could not create the credit top-up.');
  }
});

app.get('/api/credits/topups/:topUpId/status', requireAuth, async (req, res) => {
  try {
    const status = isSupabaseStorage()
      ? await remoteSyncCreditTopUp(userIdOf(req), routeParam(req, 'topUpId'))
      : await syncCreditTopUp(userIdOf(req), routeParam(req, 'topUpId'));
    const credits = isSupabaseStorage() ? await remoteGetCreditSummary(userIdOf(req)) : getCreditSummary(userIdOf(req));
    res.json({ ...status, credits });
  } catch (error) {
    respondWithServiceError(res, error, 'Could not refresh the credit top-up status.');
  }
});

app.post('/api/midtrans/notification', async (req, res) => {
  try {
    const result = isSupabaseStorage() ? await remoteHandleMidtransNotification(req.body) : handleMidtransNotification(req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    const billing = billingStatusCode(error);
    const remoteBilling = remoteBillingStatusCode(error);
    if (billing) res.status(billing.status).json(billing.body);
    else if (remoteBilling) res.status(remoteBilling.status).json(remoteBilling.body);
    else res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid Midtrans notification.' });
  }
});

app.get('/api/product-progress', (_req, res) => {
  const progressPath = path.join(projectDir, 'quality', 'progress.json');
  const progress = ProductProgressSchema.parse(JSON.parse(fs.readFileSync(progressPath, 'utf8')));
  res.json(progress);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));

let vite: ViteDevServer | undefined;
if (process.env.NODE_ENV !== 'production') {
  vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'custom',
  });
  app.use(vite.middlewares);
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' || req.originalUrl.startsWith('/api') || req.originalUrl === '/healthz') {
      next();
      return;
    }
    try {
      const template = fs.readFileSync(path.join(projectDir, 'index.html'), 'utf8');
      const html = await vite!.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
    } catch (error) {
      vite!.ssrFixStacktrace(error as Error);
      next(error);
    }
  });
} else {
  app.use(express.static(path.join(projectDir, 'dist')));
  app.use((_req, res) => res.sendFile(path.join(projectDir, 'dist', 'index.html')));
}

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof CorsOriginError) {
    res.status(403).json({ error: error.message });
    return;
  }
  if (error instanceof SyntaxError && (error as SyntaxError & { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON body.' });
    return;
  }
  console.error('Unhandled Synau server error.', error);
  res.status(500).json({ error: 'Internal server error.' });
});

cleanExpiredSessions();
app.listen(port, host, () => {
  console.log(`Synau listening on http://${host}:${port}`);
  console.log(`Generator mode: ${process.env.SYNAU_DEMO_MODE !== 'false' ? 'deterministic demo tools' : 'fixed Sumopod tools'}`);
});
