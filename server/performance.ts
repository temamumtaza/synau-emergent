import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

type PerformanceContext = {
  requestId: string;
  startedAt: number;
  supabaseQueries: number;
  supabaseMs: number;
  supabaseOperationQueries: number;
  supabaseOperationMs: number;
};

const requestStore = new AsyncLocalStorage<PerformanceContext>();

function currentContext() {
  return requestStore.getStore();
}

export function recordSupabaseQuery(durationMs: number, kind: 'operation' | 'support' = 'support') {
  const context = currentContext();
  if (!context) return;
  context.supabaseQueries += 1;
  context.supabaseMs += durationMs;
  if (kind === 'operation') {
    context.supabaseOperationQueries += 1;
    context.supabaseOperationMs += durationMs;
  }
}

function serverTiming(context: PerformanceContext) {
  const totalMs = performance.now() - context.startedAt;
  const parts = [`app;dur=${totalMs.toFixed(1)}`];
  if (context.supabaseQueries > 0) {
    parts.push(`supabase;dur=${context.supabaseMs.toFixed(1)};desc="${context.supabaseQueries} queries"`);
  }
  if (context.supabaseOperationQueries > 0) {
    parts.push(`supabase-operation;dur=${context.supabaseOperationMs.toFixed(1)};desc="${context.supabaseOperationQueries} queries"`);
  }
  return parts.join(', ');
}

export function performanceMiddleware(req: Request, res: Response, next: NextFunction) {
  const context: PerformanceContext = {
    requestId: randomUUID(),
    startedAt: performance.now(),
    supabaseQueries: 0,
    supabaseMs: 0,
    supabaseOperationQueries: 0,
    supabaseOperationMs: 0,
  };
  res.setHeader('x-request-id', context.requestId);
  const exposeServerTiming = process.env.NODE_ENV !== 'production' || process.env.SYNAU_PERF_DEBUG === 'true';

  const originalEnd = res.end.bind(res);
  res.end = ((...args: any[]) => {
    if (exposeServerTiming && !res.headersSent) res.setHeader('Server-Timing', serverTiming(context));
    return originalEnd(...args);
  }) as typeof res.end;

  res.on('finish', () => {
    if (process.env.SYNAU_PERF_LOG !== 'true') return;
    const totalMs = performance.now() - context.startedAt;
    console.info(JSON.stringify({
      type: 'request.performance',
      requestId: context.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      totalMs: Math.round(totalMs * 10) / 10,
      supabaseQueries: context.supabaseQueries,
      supabaseMs: Math.round(context.supabaseMs * 10) / 10,
      supabaseOperationQueries: context.supabaseOperationQueries,
      supabaseOperationMs: Math.round(context.supabaseOperationMs * 10) / 10,
    }));
  });

  requestStore.run(context, next);
}
