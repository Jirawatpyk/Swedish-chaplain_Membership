/**
 * R7 staff-review LOW-A fix — unit test for `withActiveSpan` helper.
 *
 * The helper was added in R6 W-P6 (commit `28cc851`) and is the
 * load-bearing wrapper that sets the cron-dispatch root span as
 * active context so auto-instrumented child spans (Drizzle queries,
 * fetch calls inside the callback) parent correctly in the trace
 * tree. Without these tests, a regression that swaps `startActiveSpan`
 * for `startSpan` (the prior pattern) would silently break trace-
 * tree parenting in Vercel Observability — visible only when an
 * operator opens the trace view.
 */
import { describe, expect, it, vi } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import { withActiveSpan, withSpan } from '@/lib/otel-tracer';

function makeFakeSpan(): {
  span: Span;
  recordedExceptions: Error[];
  endCallCount: number;
  status: { code?: SpanStatusCode; message?: string } | null;
} {
  const recordedExceptions: Error[] = [];
  let endCallCount = 0;
  let status: { code?: SpanStatusCode; message?: string } | null = null;
  const span = {
    setAttribute: vi.fn(),
    setStatus(s: { code: SpanStatusCode; message?: string }): Span {
      status = s;
      return span;
    },
    recordException(e: Error): void {
      recordedExceptions.push(e);
    },
    end(): void {
      endCallCount++;
    },
    isRecording: () => true,
    spanContext: () => ({
      traceId: 't',
      spanId: 's',
      traceFlags: 0,
    }),
  } as unknown as Span;
  return {
    span,
    recordedExceptions,
    get endCallCount() {
      return endCallCount;
    },
    get status() {
      return status;
    },
  };
}

function makeFakeTracer(): {
  tracer: Tracer;
  startActiveCallCount: number;
  startCallCount: number;
  fakeSpan: ReturnType<typeof makeFakeSpan>;
} {
  const fakeSpan = makeFakeSpan();
  let startActiveCallCount = 0;
  let startCallCount = 0;
  const tracer = {
    startSpan(_name: string): Span {
      startCallCount++;
      return fakeSpan.span;
    },
    startActiveSpan(_name: string, _opts: unknown, fn: (s: Span) => unknown): unknown {
      startActiveCallCount++;
      return fn(fakeSpan.span);
    },
  } as unknown as Tracer;
  return {
    tracer,
    get startActiveCallCount() {
      return startActiveCallCount;
    },
    get startCallCount() {
      return startCallCount;
    },
    fakeSpan,
  };
}

describe('withActiveSpan (R7 LOW-A)', () => {
  it('uses startActiveSpan (NOT startSpan) so child spans parent correctly', async () => {
    const t = makeFakeTracer();
    await withActiveSpan(t.tracer, 'test', { foo: 'bar' }, async () => 'ok');
    expect(t.startActiveCallCount).toBe(1);
    expect(t.startCallCount).toBe(0);
  });

  it('returns the callback value on happy path', async () => {
    const t = makeFakeTracer();
    const result = await withActiveSpan(
      t.tracer,
      'test',
      {},
      async () => 'happy-value',
    );
    expect(result).toBe('happy-value');
  });

  it('calls span.end() exactly once on success', async () => {
    const t = makeFakeTracer();
    await withActiveSpan(t.tracer, 'test', {}, async () => 'ok');
    expect(t.fakeSpan.endCallCount).toBe(1);
  });

  it('propagates exceptions, calls span.end(), records exception + sets ERROR status', async () => {
    const t = makeFakeTracer();
    const err = new Error('boom');
    await expect(
      withActiveSpan(t.tracer, 'test', {}, async () => {
        throw err;
      }),
    ).rejects.toThrow('boom');
    expect(t.fakeSpan.endCallCount).toBe(1);
    expect(t.fakeSpan.recordedExceptions).toContain(err);
    expect(t.fakeSpan.status?.code).toBe(SpanStatusCode.ERROR);
    expect(t.fakeSpan.status?.message).toBe('boom');
  });

  it('handles non-Error throws (string/object) without recordException', async () => {
    const t = makeFakeTracer();
    await expect(
      withActiveSpan(t.tracer, 'test', {}, async () => {
        throw 'string-throw';
      }),
    ).rejects.toBe('string-throw');
    expect(t.fakeSpan.endCallCount).toBe(1);
    expect(t.fakeSpan.recordedExceptions).toHaveLength(0);
    expect(t.fakeSpan.status?.code).toBe(SpanStatusCode.ERROR);
    expect(t.fakeSpan.status?.message).toBe('string-throw');
  });
});

describe('withSpan (regression guard — R7 confirms unchanged)', () => {
  it('uses startSpan (non-active) — child spans NOT parented', async () => {
    const t = makeFakeTracer();
    await withSpan(t.tracer, 'test', {}, async () => 'ok');
    expect(t.startCallCount).toBe(1);
    expect(t.startActiveCallCount).toBe(0);
  });

  it('still calls span.end() on throw', async () => {
    const t = makeFakeTracer();
    await expect(
      withSpan(t.tracer, 'test', {}, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(t.fakeSpan.endCallCount).toBe(1);
  });
});
