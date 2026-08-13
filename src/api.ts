import type {
  AuthCodeResponse,
  AuthResponse,
  Course,
  CreditSummary,
  GoogleAuthResponse,
  TopUpResponse,
  ProductProgress,
  Quiz,
  QuizScope,
  QuizSubmission,
  Roadmap,
  User,
} from './types';

const TOKEN_KEY = 'synau.session';
export const CREDITS_CHANGED_EVENT = 'synau:credits-changed';
const GET_IN_FLIGHT = new Map<string, Promise<unknown>>();
const GET_CACHE = new Map<string, { expiresAt: number; value: unknown }>();
let cacheVersion = 0;

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function getToken() {
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  invalidateRequestCache();
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  invalidateRequestCache();
  window.localStorage.removeItem(TOKEN_KEY);
}

function cacheKey(path: string, authenticated: boolean, token: string | null) {
  return `${authenticated ? token ?? 'anonymous' : 'public'}|${path}`;
}

function invalidateRequestCache(pathPrefix?: string) {
  cacheVersion += 1;
  const matches = (key: string) => !pathPrefix || key.includes(`|${pathPrefix}`);
  for (const key of GET_CACHE.keys()) {
    if (matches(key)) GET_CACHE.delete(key);
  }
}

function markCreditsChanged() {
  invalidateRequestCache('/api/credits');
  window.dispatchEvent(new Event(CREDITS_CHANGED_EVENT));
}

const COURSE_LIST_TTL_MS = 15_000;
const COURSE_TTL_MS = 30_000;
const CREDITS_TTL_MS = 5_000;

function cacheValue<T>(path: string, value: T, ttlMs: number) {
  const token = getToken();
  if (!token) return;
  GET_CACHE.set(cacheKey(path, true, token), { expiresAt: Date.now() + ttlMs, value });
}

function cachedCoursePath(courseId: string) {
  return `/api/courses/${encodeURIComponent(courseId)}`;
}

function metadataCourse(course: Course): Course {
  return {
    ...course,
    sections: course.sections.map((section) => ({
      ...section,
      lessons: section.lessons.map((lesson) => ({ ...lesson, material: null })),
    })),
  };
}

function cacheCourse(course: Course, updateCourseList = true) {
  cacheValue(cachedCoursePath(course.id), { course }, COURSE_TTL_MS);
  if (!updateCourseList) return;
  const token = getToken();
  if (!token) return;
  const listKey = cacheKey('/api/courses', true, token);
  const cachedList = GET_CACHE.get(listKey)?.value as { courses?: Course[] } | undefined;
  if (!cachedList?.courses) return;
  const listCourse = metadataCourse(course);
  cacheValue('/api/courses', {
    courses: cachedList.courses.some((item) => item.id === listCourse.id)
      ? cachedList.courses.map((item) => item.id === listCourse.id ? listCourse : item)
      : [listCourse, ...cachedList.courses],
  }, COURSE_LIST_TTL_MS);
}

function removeCachedCourse(courseId: string) {
  const token = getToken();
  if (!token) return;
  GET_CACHE.delete(cacheKey(cachedCoursePath(courseId), true, token));
  const listKey = cacheKey('/api/courses', true, token);
  const cachedList = GET_CACHE.get(listKey)?.value as { courses?: Course[] } | undefined;
  if (!cachedList?.courses) return;
  cacheValue('/api/courses', { courses: cachedList.courses.filter((course) => course.id !== courseId) }, COURSE_LIST_TTL_MS);
}

async function performRequest<T>(path: string, init: RequestInit, authenticated: boolean): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();

  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (authenticated && token) {
    headers.set('authorization', `Bearer ${token}`);
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError('Synau could not reach the server. Check your connection and try again.', 0);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json().catch(() => null) as { error?: string; code?: string } | null;
  if (!response.ok) {
    if (response.status === 401 && authenticated) {
      clearToken();
      window.dispatchEvent(new Event('synau:unauthorized'));
    }
    throw new ApiError(payload?.error ?? 'Something went wrong. Please try again.', response.status, payload?.code);
  }

  return payload as T;
}

function request<T>(path: string, init: RequestInit = {}, authenticated = true, cacheTtlMs = 0): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return performRequest<T>(path, init, authenticated);

  const key = cacheKey(path, authenticated, getToken());
  if (cacheTtlMs > 0) {
    const cached = GET_CACHE.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value as T);
    if (cached) GET_CACHE.delete(key);
  }

  const pending = GET_IN_FLIGHT.get(key);
  if (pending) return pending as Promise<T>;

  const requestVersion = cacheVersion;
  let nextRequest: Promise<T>;
  nextRequest = performRequest<T>(path, init, authenticated)
    .then((value) => {
      if (cacheTtlMs > 0 && requestVersion === cacheVersion) {
        GET_CACHE.set(key, { expiresAt: Date.now() + cacheTtlMs, value });
      }
      return value;
    })
    .finally(() => {
      if (GET_IN_FLIGHT.get(key) === nextRequest) GET_IN_FLIGHT.delete(key);
    });
  GET_IN_FLIGHT.set(key, nextRequest);
  return nextRequest;
}

const jsonBody = (value: unknown) => JSON.stringify(value);

export const api = {
  authConfig() {
    return request<{ provider: 'google' | 'email' }>('/api/auth/config', {}, false);
  },

  completeGoogleAuth(accessToken: string, profile?: { firstName: string; lastName: string; username: string }) {
    return request<GoogleAuthResponse>('/api/auth/google/session', {
      method: 'POST',
      body: jsonBody({ accessToken, ...profile }),
    }, false);
  },

  requestSignInCode(identifier: string) {
    return request<AuthCodeResponse>('/api/auth/request-code', {
      method: 'POST',
      body: jsonBody({ mode: 'sign_in', identifier }),
    }, false);
  },

  requestSignUpCode(input: { firstName: string; lastName: string; username: string; email: string }) {
    return request<AuthCodeResponse>('/api/auth/request-code', {
      method: 'POST',
      body: jsonBody({ mode: 'sign_up', ...input }),
    }, false);
  },

  verifyAuthCode(challengeId: string, code: string) {
    return request<AuthResponse>('/api/auth/verify-code', {
      method: 'POST',
      body: jsonBody({ challengeId, code }),
    }, false);
  },

  me() {
    return request<{ user: User }>('/api/auth/me');
  },

  logout() {
    return request<void>('/api/auth/logout', { method: 'POST' }).finally(() => {
      invalidateRequestCache();
    });
  },

  courses() {
    return request<{ courses: Course[] }>('/api/courses', {}, true, COURSE_LIST_TTL_MS);
  },

  course(courseId: string) {
    return request<{ course: Course }>(cachedCoursePath(courseId), {}, true, COURSE_TTL_MS);
  },

  prefetchCourse(courseId: string) {
    return request<{ course: Course }>(cachedCoursePath(courseId), {}, true, COURSE_TTL_MS).then(() => undefined);
  },

  renameCourse(courseId: string, title: string) {
    return request<{ course: Course }>(cachedCoursePath(courseId), {
      method: 'PATCH',
      body: jsonBody({ title }),
    }).then((result) => {
      cacheCourse(result.course);
      return result;
    });
  },

  deleteCourse(courseId: string) {
    return request<void>(cachedCoursePath(courseId), { method: 'DELETE' }).then((result) => {
      removeCachedCourse(courseId);
      return result;
    });
  },

  generateRoadmap(topic: string, language: 'en' | 'id' = 'en') {
    return request<{ roadmap: Roadmap }>('/api/generate/roadmap', {
      method: 'POST',
      body: jsonBody({ topic, language }),
    }).finally(() => markCreditsChanged());
  },

  createCourse(roadmap: Roadmap) {
    return request<{ course: Course }>('/api/courses', {
      method: 'POST',
      body: jsonBody(roadmap),
    }).then((result) => {
      cacheCourse(result.course);
      return result;
    });
  },

  openLesson(courseId: string, lessonId: string) {
    return request<{ course: Course; generated: boolean }>(
      `/api/courses/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(lessonId)}/open`,
      { method: 'POST' },
      true,
    ).then((result) => {
      cacheCourse(result.course, false);
      markCreditsChanged();
      return result;
    });
  },

  completeLesson(courseId: string, lessonId: string) {
    return request<{ course: Course }>(
      `/api/courses/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(lessonId)}/complete`,
      { method: 'POST' },
    ).then((result) => {
      cacheCourse(result.course);
      return result;
    });
  },

  generateQuiz(input: {
    course: Course;
    scope: QuizScope;
    scopeId: string;
    scopeTitle: string;
  }) {
    return request<{ quiz: Quiz }>('/api/quizzes/generate', {
      method: 'POST',
      body: jsonBody({
        courseId: input.course.id,
        scope: input.scope,
        scopeId: input.scopeId,
      }),
    }).finally(() => markCreditsChanged());
  },

  submitQuiz(quizId: string, answers: Record<string, number>) {
    return request<QuizSubmission>(`/api/quizzes/${encodeURIComponent(quizId)}/submit`, {
      method: 'POST',
      body: jsonBody({ answers }),
    });
  },

  credits(force = false) {
    if (force) invalidateRequestCache('/api/credits');
    return request<{ credits: CreditSummary }>('/api/credits', {}, true, CREDITS_TTL_MS);
  },

  createCreditTopUp(productId: string) {
    return request<{ topUp: TopUpResponse }>('/api/credits/topups', {
      method: 'POST',
      body: jsonBody({ productId }),
    });
  },

  creditTopUpStatus(topUpId: string) {
    return request<{ topUpId: string; status: string; credits: CreditSummary }>(`/api/credits/topups/${encodeURIComponent(topUpId)}/status`).finally(() => markCreditsChanged());
  },

  redeemCreditToken(token: string) {
    return request<{ redemption: import('./types').RedeemCreditResponse }>('/api/credits/redeem', {
      method: 'POST',
      body: jsonBody({ token }),
    }).finally(() => markCreditsChanged());
  },

  productProgress() {
    return request<ProductProgress>('/api/product-progress', {}, false, 30_000);
  },
};
