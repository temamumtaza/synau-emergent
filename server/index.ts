import 'dotenv/config';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { newId, nowIso } from './utils.js';
import {
  requireAuth,
  AuthFlowError,
  assertSessionCookieRuntime,
  authTokenOf,
  clearSessionCookie,
  publicUser,
  setSessionCookie,
  type AuthRequest,
} from './auth.js';
import { generateLesson, generateQuiz, generateRoadmap } from './ai.js';
import { assertSupabaseRuntime } from './supabase.js';
import { completeSupabaseGoogleAuth, remoteCreateSession, remoteGetUserById, remoteRevokeSession } from './supabase-auth.js';
import { performanceMiddleware } from './performance.js';
import { createRateLimiter } from './rate-limit.js';
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
  remoteOpenLesson,
  remoteReleaseLessonLock,
  remoteSaveLessonMaterial,
  remoteSerializeCourse,
  remoteUpdateCourse,
  supabaseHealth,
} from './supabase-store.js';
import {
  remoteBillingStatusCode,
  remoteGetCreditSummary,
  remoteGrantNewUserCredits,
  remoteRedeemCreditToken,
} from './supabase-credits.js';
import {
  CoursePatchSchema,
  GoogleAuthRequestSchema,
  GoogleAuthResponseSchema,
  createQuizSubmissionSchema,
  LessonMaterialSchema,
  RedeemCreditInputSchema,
  ProductProgressSchema,
  QuizPublicSchema,
  QuizRequestSchema,
  QuizSchema,
  QuizSubmissionSchema,
  RoadmapSchema,
  TopicInputSchema,
  UserSchema,
  type LessonMaterial,
} from '../shared/schemas.js';

assertSupabaseRuntime();
assertSessionCookieRuntime();

const app = express();
app.disable('x-powered-by');
const isProduction = process.env.NODE_ENV === 'production';
app.set('trust proxy', process.env.SYNAU_TRUST_PROXY === 'true');

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

const configuredOriginInput = process.env.SYNAU_CORS_ORIGIN?.trim();
let configuredOrigin: string | undefined;
try {
  configuredOrigin = configuredOriginInput ? new URL(configuredOriginInput).origin : undefined;
} catch {
  configuredOrigin = configuredOriginInput;
}
function isHttpOrigin(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
      && url.pathname === '/'
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

if (isProduction && (!configuredOrigin || !isHttpOrigin(configuredOrigin))) {
  throw new Error('Production requires SYNAU_CORS_ORIGIN to be an absolute app origin.');
}
if (!isProduction && configuredOrigin && !isLoopbackOrigin(configuredOrigin)) {
  throw new Error('SYNAU_CORS_ORIGIN must be a loopback HTTP(S) origin during development.');
}

const host = process.env.SYNAU_HOST ?? (isProduction ? '0.0.0.0' : '127.0.0.1');
const bindableHost = isLoopbackHostname(host) || host === '0.0.0.0' || host === '::';
if (!bindableHost) {
  throw new Error('SYNAU_HOST must be a loopback, 0.0.0.0, or :: bind address.');
}
if (isProduction && !isLoopbackHostname(host) && process.env.SYNAU_COOKIE_SECURE === 'false') {
  throw new Error('Production deployments must keep SYNAU_COOKIE_SECURE=true when not bound to loopback.');
}

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const hmrPort = Number(process.env.SYNAU_HMR_PORT ?? port + 10_000);
if (!Number.isInteger(hmrPort) || hmrPort < 1 || hmrPort > 65_535) {
  throw new Error('SYNAU_HMR_PORT must be an integer between 1 and 65535.');
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || configuredOrigin === origin || (!isProduction && isLoopbackOrigin(origin))) {
      callback(null, true);
      return;
    }
    callback(new CorsOriginError('Origin is not allowed by this local Synau server.'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
app.use(performanceMiddleware);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (isProduction) {
    const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
    const connectSources = ["'self'", supabaseUrl, 'https://accounts.google.com'].filter(Boolean).join(' ');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' https: data:",
      `connect-src ${connectSources}`,
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self' https://accounts.google.com https://*.supabase.co",
    ].join('; '));
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    if (process.env.SYNAU_COOKIE_SECURE !== 'false') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  }
  next();
});

app.use('/api', (req, res, next) => {
  const unsafeMethod = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const origin = req.header('origin');
  if (isProduction && unsafeMethod && origin && origin !== configuredOrigin) {
    res.status(403).json({ error: 'This origin is not allowed.', code: 'csrf_origin_rejected' });
    return;
  }
  next();
});

const authRateLimit = createRateLimiter({ name: 'auth', windowMs: 15 * 60 * 1_000, max: 30 });
const generatorRateLimit = createRateLimiter({ name: 'generator', windowMs: 5 * 60 * 1_000, max: 30 });

function isProtectedSourcePath(requestPath: string) {
  let pathname = requestPath;
  try {
    pathname = decodeURIComponent(new URL(requestPath, 'http://synau.local').pathname);
  } catch {
    // Keep the original path and let the normal router handle malformed URLs.
  }
  const normalized = pathname.replaceAll('\\', '/');
  return /(^|\/)\.(?:env|git)[^\/]*(?:\/|$)/i.test(normalized)
    || /(^|\/)(?:server|dist-server|shared|supabase|scripts|quality)(?:\/|$)/i.test(normalized);
}

// Do this before Vite's middleware and before production's SPA fallback. A
// direct browser request for backend source must be a 404 in every mode, not
// a transformed TypeScript module (dev) or an accidental index.html (prod).
app.use((req, res, next) => {
  if (isProtectedSourcePath(req.originalUrl)) {
    res.status(404).end();
    return;
  }
  next();
});

const lessonGenerationFlights = new Map<string, Promise<unknown>>();
const streamedMarkdownByFlight = new Map<string, string>();
const userLessonGenerationFlights = new Map<string, {
  courseId: string;
  lessonId: string;
  lessonTitle: string;
  promise: Promise<unknown>;
}>();
const lessonGenerationLockTtlMs = 5 * 60 * 1000;

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
  const billing = remoteBillingStatusCode(error);
  if (billing) {
    res.status(billing.status).json(billing.body);
    return;
  }
  console.error(`[service] ${fallback}`, error instanceof Error ? error.message : error);
  res.status(502).json({ error: fallback, code: 'service_error' });
}

function lessonStreamRequested(req: Request) {
  return (req.headers.accept ?? '').toLocaleLowerCase().includes('text/event-stream');
}

function startLessonStream(res: Response) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': synau-lesson-heartbeat\n\n');
  }, 10_000);
  res.once('close', close);
  return close;
}

function writeLessonStreamEvent(res: Response, event: string, payload: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function lessonStreamError(error: unknown, fallback: string) {
  const billing = remoteBillingStatusCode(error);
  if (billing) return { status: billing.status, body: billing.body };
  console.error(`[lesson-stream] ${fallback}`, error instanceof Error ? error.message : error);
  return {
    status: 502,
    body: { error: fallback, code: 'service_error' },
  };
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

app.get('/healthz', async (_req, res) => {
  try {
    await supabaseHealth();
    res.json({ ok: true, service: 'synau', database: 'supabase' });
  } catch {
    res.status(503).json({ ok: false, service: 'synau', database: 'unavailable' });
  }
});

app.get('/api/auth/config', (_req, res) => {
  res.json({ provider: 'google' as const });
});

app.post('/api/auth/google/session', authRateLimit, async (req, res) => {
  const body = parseBody(GoogleAuthRequestSchema, req, res);
  if (!body) return;
  try {
    const result = await completeSupabaseGoogleAuth(body);
    if (result.status === 'authenticated') {
      if (result.created) await remoteGrantNewUserCredits(result.user.id);
      const session = await remoteCreateSession(result.user.id);
      setSessionCookie(res, session.token, session.expiresAt);
    }
    const response = result.status === 'authenticated'
      ? { ...result, user: UserSchema.parse(publicUser(result.user)) }
      : result;
    res.json(GoogleAuthResponseSchema.parse(response));
  } catch (error) {
    respondWithAuthError(res, error);
  }
});

// Kept as an explicit contract response so old clients fail safely instead of
// attempting to revive the retired local email-code flow.
app.post('/api/auth/request-code', async (_req, res) => {
  res.status(410).json({ error: 'Google sign-in is the only authentication method for Synau.', code: 'google_auth_only' });
});

app.post('/api/auth/verify-code', async (_req, res) => {
  res.status(410).json({ error: 'Google sign-in is the only authentication method for Synau.', code: 'google_auth_only' });
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = authTokenOf(req);
  await remoteRevokeSession(token);
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await remoteGetUserById(userIdOf(req));
  if (!user) {
    res.status(401).json({ error: 'Account not found.' });
    return;
  }
  res.json({ user: UserSchema.parse(publicUser(user)) });
});

app.get('/api/courses', requireAuth, async (req, res) => {
  res.json({ courses: await remoteListCourses(userIdOf(req)) });
});

app.post('/api/generate/roadmap', requireAuth, generatorRateLimit, async (req, res) => {
  const body = parseBody(TopicInputSchema, req, res);
  if (!body) return;
  try {
    const roadmap = await generateRoadmap(body.topic, userIdOf(req), body.language);
    res.json({ roadmap });
  } catch (error) {
    respondWithServiceError(res, error, 'Roadmap generation failed.');
  }
});

app.post('/api/courses', requireAuth, async (req, res) => {
  const body = parseBody(RoadmapSchema, req, res);
  if (!body) return;
  const course = await remoteCreateCourse(userIdOf(req), body);
  res.status(201).json({ course });
});

app.get('/api/courses/:courseId', requireAuth, async (req, res) => {
  const course = await remoteSerializeCourse(userIdOf(req), routeParam(req, 'courseId'));
  if (!course) {
    res.status(404).json({ error: 'Course not found.' });
    return;
  }
  res.json({ course });
});

app.patch('/api/courses/:courseId', requireAuth, async (req, res) => {
  const body = parseBody(CoursePatchSchema, req, res);
  if (!body) return;
  const updated = await remoteUpdateCourse(userIdOf(req), routeParam(req, 'courseId'), body);
  if (!updated) {
    res.status(404).json({ error: 'Course not found.' });
    return;
  }
  res.json({ course: updated });
});

app.delete('/api/courses/:courseId', requireAuth, async (req, res) => {
  const result = await remoteDeleteCourse(userIdOf(req), routeParam(req, 'courseId'));
  if (result.locked) {
    res.status(409).json({
      code: 'course_generation_in_progress',
      error: 'This learning path is generating a lesson. Wait for it to finish before deleting the course.',
    });
    return;
  }
  if (result.notFound) {
    res.status(404).json({ error: 'Course not found.' });
    return;
  }
  res.status(result.deleted ? 204 : 404).end();
});

function lessonContinuity(course: Awaited<ReturnType<typeof remoteSerializeCourse>>, sectionId: string, lessonId: string) {
  const defaults = {
    lessonPosition: 0,
    lessonsInSection: 1,
    sectionPosition: 0,
    sectionsInCourse: 1,
  };
  if (!course) return defaults;
  const sectionPosition = course.sections.findIndex((candidate) => candidate.id === sectionId);
  const section = sectionPosition >= 0 ? course.sections[sectionPosition] : undefined;
  const lessonPosition = section?.lessons.findIndex((candidate) => candidate.id === lessonId) ?? -1;
  if (!section || sectionPosition < 0 || lessonPosition < 0) return defaults;

  const previousLesson = lessonPosition > 0 ? section.lessons[lessonPosition - 1] : undefined;
  const previousSection = sectionPosition > 0 ? course.sections[sectionPosition - 1] : undefined;
  return {
    ...defaults,
    lessonPosition,
    lessonsInSection: section.lessons.length,
    sectionPosition,
    sectionsInCourse: course.sections.length,
    // At a chapter boundary, use the previous chapter as the bridge instead
    // of pretending that the last lesson is the whole preceding chapter.
    ...(previousLesson ? { previousLesson: { title: previousLesson.title, summary: previousLesson.summary } } : {}),
    ...(previousSection ? {
      previousSection: {
        title: previousSection.title,
        summary: previousSection.summary,
        lessonTitles: previousSection.lessons.map((lesson) => lesson.title),
      },
    } : {}),
  };
}

app.post('/api/courses/:courseId/lessons/:lessonId/open', requireAuth, generatorRateLimit, async (req, res) => {
  const userId = userIdOf(req);
  const courseId = routeParam(req, 'courseId');
  const lessonId = routeParam(req, 'lessonId');
  const wantsStream = lessonStreamRequested(req);
  const closeStream = wantsStream ? startLessonStream(res) : undefined;
  const emit = (event: string, payload: unknown) => {
    if (wantsStream) writeLessonStreamEvent(res, event, payload);
  };
  const finishError = (status: number, body: { error: string; code?: string; [key: string]: unknown }) => {
    if (!wantsStream) {
      res.status(status).json(body);
      return;
    }
    emit('error', { status, ...body });
    closeStream?.();
  };
  emit('status', { stage: 'connecting', message: 'Preparing the lesson stream.' });
  let remoteLesson: Awaited<ReturnType<typeof remoteLessonRow>>;
  try {
    remoteLesson = await remoteLessonRow(userId, courseId, lessonId);
  } catch (error) {
    if (!wantsStream) respondWithServiceError(res, error, 'Could not open this lesson.');
    else {
      const failure = lessonStreamError(error, 'Could not open this lesson.');
      emit('error', { status: failure.status, ...failure.body });
      closeStream?.();
    }
    return;
  }
  if (!remoteLesson) {
    finishError(404, { error: 'Lesson not found.' });
    return;
  }
  if (remoteLesson.course.status === 'archived') {
    finishError(409, { error: 'Archived courses are read-only. Reopen the course to generate material.' });
    return;
  }

  let generated = false;
  if (!remoteLesson.row.material_json) {
    const activeUserFlight = userLessonGenerationFlights.get(userId);
    if (activeUserFlight && (activeUserFlight.courseId !== courseId || activeUserFlight.lessonId !== lessonId)) {
      finishError(409, {
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
      if (!flight && activeUserFlight?.courseId === courseId && activeUserFlight.lessonId === lessonId) {
        flight = activeUserFlight.promise;
      }
      if (!flight) {
        const lockResult = await remoteAcquireLessonLock(
          userId,
          courseId,
          lessonId,
          remoteLesson.row.title,
          new Date(Date.now() - lessonGenerationLockTtlMs).toISOString(),
        );
        if (!lockResult.acquired) {
          const lock = lockResult.lock;
          const sameLesson = lock?.course_id === courseId && lock.lesson_id === lessonId;
          finishError(409, {
            code: 'lesson_generation_in_progress',
            error: sameLesson
              ? 'This lesson is already being generated. Please wait for it to finish before trying again.'
              : `Another lesson is currently being generated: “${lock?.lesson_title ?? 'another subchapter'}”. Please wait for it to finish before opening another subchapter.`,
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
          language: remoteLesson.course.language,
          courseTitle: remoteLesson.course.title,
          sectionTitle: remoteLesson.sectionTitle,
          lessonTitle: remoteLesson.row.title,
          lessonSummary: remoteLesson.row.summary,
          courseMemory: await remoteGetCourseMemory(userId, courseId),
          ...lessonContinuity(remoteLesson.course, remoteLesson.row.section_id, lessonId),
        }, userId, {
          onStatus: (progress) => emit('status', progress),
          onMarkdown: (markdown) => {
            const previous = streamedMarkdownByFlight.get(flightKey) ?? '';
            if (markdown.startsWith(previous)) {
              const delta = markdown.slice(previous.length);
              streamedMarkdownByFlight.set(flightKey, markdown);
              if (delta) emit('markdown', { content: delta, append: true });
            } else {
              streamedMarkdownByFlight.set(flightKey, markdown);
              emit('markdown', { content: markdown, append: false });
            }
          },
        })).then(async (generatedMaterial) => {
          emit('status', { stage: 'validating', message: 'Saving the validated lesson.' });
          const boundMaterial = LessonMaterialSchema.parse({ ...generatedMaterial, lessonId }) as LessonMaterial;
          await remoteSaveLessonMaterial(lessonId, boundMaterial);
          return boundMaterial;
        }).finally(async () => {
          try {
            await remoteReleaseLessonLock(userId, courseId, lessonId);
          } catch (error) {
            console.error('[lesson-lock] release failed', error instanceof Error ? error.message : error);
          }
          if (lessonGenerationFlights.get(flightKey) === generation) lessonGenerationFlights.delete(flightKey);
          if (userLessonGenerationFlights.get(userId)?.promise === generation) userLessonGenerationFlights.delete(userId);
          streamedMarkdownByFlight.delete(flightKey);
        });
        flight = generation;
        lessonGenerationFlights.set(flightKey, generation);
        userLessonGenerationFlights.set(userId, {
          courseId,
          lessonId,
          lessonTitle: remoteLesson.row.title,
          promise: generation,
        });
      }
      await flight;
    } catch (error) {
      if (!wantsStream) {
        respondWithServiceError(res, error, 'Lesson generation failed.');
      } else {
        const failure = lessonStreamError(error, 'Lesson generation failed.');
        emit('error', { status: failure.status, ...failure.body });
        closeStream?.();
      }
      return;
    }
  }

  let openedCourse: Awaited<ReturnType<typeof remoteOpenLesson>>;
  try {
    openedCourse = await remoteOpenLesson(userId, courseId, lessonId);
  } catch (error) {
    if (!wantsStream) respondWithServiceError(res, error, 'Could not open this lesson.');
    else {
      const failure = lessonStreamError(error, 'Could not open this lesson.');
      emit('error', { status: failure.status, ...failure.body });
      closeStream?.();
    }
    return;
  }
  if (!openedCourse) {
    finishError(404, { error: 'Lesson not found.' });
    return;
  }
  emit('status', { stage: 'validating', message: 'Lesson is ready.' });
  if (wantsStream) {
    emit('complete', { course: openedCourse, generated });
    closeStream?.();
  } else {
    res.json({ course: openedCourse, generated });
  }
});

app.post('/api/courses/:courseId/lessons/:lessonId/complete', requireAuth, async (req, res) => {
  const completed = await remoteCompleteLesson(userIdOf(req), routeParam(req, 'courseId'), routeParam(req, 'lessonId'));
  if (completed.status === 'archived') {
    res.status(409).json({ error: 'Archived courses are read-only.' });
    return;
  }
  if (completed.status === 'not_found') {
    res.status(404).json({ error: 'Lesson not found.' });
    return;
  }
  res.json({ course: completed.course });
});

app.post('/api/quizzes/generate', requireAuth, generatorRateLimit, async (req, res) => {
  const body = parseBody(QuizRequestSchema, req, res);
  if (!body) return;
  const userId = userIdOf(req);
  const course = await remoteSerializeCourse(userId, body.courseId);
  if (!course) {
    res.status(404).json({ error: 'Quiz scope not found.' });
    return;
  }
  const context = await remoteCourseContext(userId, body.courseId, body.scope, body.scopeId);
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
      language: course.language,
      scopeTitle: context.title,
      materialContext: context.context,
      courseMemory: await remoteGetCourseMemory(userId, body.courseId),
    }, userId);
    const storedQuiz = QuizSchema.parse({ ...quiz, id: newId(), scope: body.scope, scopeId: body.scopeId });
    await remoteInsertQuiz(userId, body.courseId, storedQuiz);
    await remoteAddEvent(userId, body.courseId, 'quiz_started', body.scope === 'lesson' ? body.scopeId : undefined, { scope: body.scope });
    res.status(201).json({ quiz: QuizPublicSchema.parse(storedQuiz) });
  } catch (error) {
    respondWithServiceError(res, error, 'Quiz generation failed.');
  }
});

app.post('/api/quizzes/:quizId/submit', requireAuth, async (req, res) => {
  const body = parseBody(QuizSubmissionSchema, req, res);
  if (!body) return;
  const userId = userIdOf(req);
  const quizId = routeParam(req, 'quizId');
  const row = await remoteGetQuiz(userId, quizId);
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
  const completed = await remoteCompleteQuiz(userId, quizId, score, nowIso());
  if (!completed) {
    res.status(409).json({ error: 'This quiz attempt is already complete. Generate another attempt to retry.' });
    return;
  }
  await remoteAddEvent(userId, completed.course_id, 'quiz_completed', completed.scope === 'lesson' ? completed.scope_id : undefined, { scope: completed.scope, score });
  res.json({ score, results, quiz: QuizPublicSchema.parse(quiz) });
});

app.get('/api/courses/:courseId/activity', requireAuth, async (req, res) => {
  const userId = userIdOf(req);
  const courseId = routeParam(req, 'courseId');
  if (!await remoteSerializeCourse(userId, courseId)) {
    res.status(404).json({ error: 'Course not found.' });
    return;
  }
  res.json({ events: await remoteActivity(userId, courseId) });
});

app.get('/api/credits', requireAuth, async (req, res) => {
  res.json({ credits: await remoteGetCreditSummary(userIdOf(req)) });
});

app.post('/api/credits/topups', requireAuth, async (_req, res) => {
  res.status(410).json({ error: 'Midtrans top-ups are temporarily locked. Use a reviewer redeem token.', code: 'midtrans_disabled' });
});

app.get('/api/credits/topups/:topUpId/status', requireAuth, async (_req, res) => {
  res.status(410).json({ error: 'Midtrans top-ups are temporarily locked.', code: 'midtrans_disabled' });
});

app.post('/api/midtrans/notification', async (_req, res) => {
  res.status(410).json({ error: 'Midtrans is temporarily disabled.', code: 'midtrans_disabled' });
});

app.post('/api/credits/redeem', requireAuth, async (req, res) => {
  const body = parseBody(RedeemCreditInputSchema, req, res);
  if (!body) return;
  try {
    const redemption = await remoteRedeemCreditToken(userIdOf(req), body.token);
    res.json({ redemption });
  } catch (error) {
    respondWithServiceError(res, error, 'Could not redeem this token.');
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
    server: { middlewareMode: true, hmr: { host, port: hmrPort } },
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
    console.error('[cors] rejected request origin', error.message);
    res.status(403).json({ error: 'This origin is not allowed.' });
    return;
  }
  if (error instanceof SyntaxError && (error as SyntaxError & { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON body.' });
    return;
  }
  console.error('Unhandled Synau server error.', error);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(port, host, () => {
  console.log(`Synau listening on http://${host}:${port}`);
  console.log('Storage mode: Supabase');
  console.log(`Generator mode: ${process.env.SYNAU_DEMO_MODE !== 'false' ? 'deterministic demo tools' : 'fixed Sumopod tools'}`);
});
