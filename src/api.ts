import type {
  AuthCodeResponse,
  AuthResponse,
  Course,
  CreditSummary,
  TopUpResponse,
  ProductProgress,
  Quiz,
  QuizScope,
  QuizSubmission,
  Roadmap,
  User,
} from './types';

const TOKEN_KEY = 'synau.session';

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
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
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

const jsonBody = (value: unknown) => JSON.stringify(value);

export const api = {
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
    return request<void>('/api/auth/logout', { method: 'POST' });
  },

  courses() {
    return request<{ courses: Course[] }>('/api/courses');
  },

  course(courseId: string) {
    return request<{ course: Course }>(`/api/courses/${encodeURIComponent(courseId)}`);
  },

  renameCourse(courseId: string, title: string) {
    return request<{ course: Course }>(`/api/courses/${encodeURIComponent(courseId)}`, {
      method: 'PATCH',
      body: jsonBody({ title }),
    });
  },

  deleteCourse(courseId: string) {
    return request<void>(`/api/courses/${encodeURIComponent(courseId)}`, { method: 'DELETE' });
  },

  generateRoadmap(topic: string) {
    return request<{ roadmap: Roadmap }>('/api/generate/roadmap', {
      method: 'POST',
      body: jsonBody({ topic }),
    });
  },

  createCourse(roadmap: Roadmap) {
    return request<{ course: Course }>('/api/courses', {
      method: 'POST',
      body: jsonBody(roadmap),
    });
  },

  openLesson(courseId: string, lessonId: string) {
    return request<{ course: Course; generated: boolean }>(
      `/api/courses/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(lessonId)}/open`,
      { method: 'POST' },
      true,
    );
  },

  completeLesson(courseId: string, lessonId: string) {
    return request<{ course: Course }>(
      `/api/courses/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(lessonId)}/complete`,
      { method: 'POST' },
    );
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
    });
  },

  submitQuiz(quizId: string, answers: Record<string, number>) {
    return request<QuizSubmission>(`/api/quizzes/${encodeURIComponent(quizId)}/submit`, {
      method: 'POST',
      body: jsonBody({ answers }),
    });
  },

  credits() {
    return request<{ credits: CreditSummary }>('/api/credits');
  },

  createCreditTopUp(productId: string) {
    return request<{ topUp: TopUpResponse }>('/api/credits/topups', {
      method: 'POST',
      body: jsonBody({ productId }),
    });
  },

  creditTopUpStatus(topUpId: string) {
    return request<{ topUpId: string; status: string; credits: CreditSummary }>(`/api/credits/topups/${encodeURIComponent(topUpId)}/status`);
  },

  productProgress() {
    return request<ProductProgress>('/api/product-progress', {}, false);
  },
};
