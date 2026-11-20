/**
 * #739 — the span processor that runs before the exporter keeps an error's
 * class and drops its text. Next's `closeSpanWithError` and `@vercel/otel`'s
 * fetch instrumentation call `recordException` (message + stack) and set the
 * status message to `error.message`; a DrizzleQueryError message quotes bound
 * parameters (emails, names).
 */
import { describe, expect, it } from 'vitest';

import { redactErrorTextSpanProcessor } from '@/lib/otel-redact-span-processor';

const ERROR = 2;
const OK = 1;

function failedSpan(type: string, message = 'Failed query: insert … params: a@b.example') {
  return {
    name: 'GET /admin/members',
    attributes: { 'error.type': type, 'http.route': '/admin/members' } as Record<string, unknown>,
    status: { code: ERROR, message } as { code: number; message?: string },
    events: [
      { name: 'started', attributes: { step: 'one' }, time: [0, 0] },
      {
        name: 'exception',
        attributes: {
          'exception.type': type,
          'exception.message': message,
          'exception.stacktrace': `${type}: ${message}\n    at x (/var/task/a@b.example.js:1:1)`,
        },
        time: [0, 0],
      },
    ],
  };
}

function end(span: ReturnType<typeof failedSpan>): void {
  redactErrorTextSpanProcessor.onEnd(span as never);
}

describe('redactErrorTextSpanProcessor (#739)', () => {
  it('an exception event keeps only its type', () => {
    const span = failedSpan('DrizzleQueryError');
    end(span);
    expect(span.events[1]).toEqual({
      name: 'exception',
      attributes: { 'exception.type': 'DrizzleQueryError' },
      time: [0, 0],
    });
    expect(JSON.stringify(span)).not.toContain('@');
  });

  it('an error status message becomes the class', () => {
    const span = failedSpan('DrizzleQueryError');
    end(span);
    expect(span.status).toEqual({ code: ERROR, message: 'DrizzleQueryError' });
  });

  it('a type that is not a class token reads unknown', () => {
    const span = failedSpan('weird type a@b.example');
    end(span);
    expect(span.events[1]?.attributes).toEqual({ 'exception.type': 'unknown' });
    expect(span.attributes['error.type']).toBe('unknown');
    expect(span.status.message).toBe('unknown');
  });

  it('a fetch-style span (status message, no error.type) takes the class from the event', () => {
    const span = failedSpan('TypeError', 'fetch failed for https://x.example/?email=a@b.example');
    delete span.attributes['error.type'];
    end(span);
    expect(span.status.message).toBe('TypeError');
    expect(JSON.stringify(span)).not.toContain('@');
  });

  it('an OK span and other events are untouched', () => {
    const span = failedSpan('Error');
    span.status = { code: OK };
    span.events = [span.events[0]!];
    const before = JSON.stringify(span);
    end(span);
    expect(JSON.stringify(span)).toBe(before);
  });

  it('flush and shutdown resolve', async () => {
    await expect(redactErrorTextSpanProcessor.forceFlush()).resolves.toBeUndefined();
    await expect(redactErrorTextSpanProcessor.shutdown()).resolves.toBeUndefined();
  });
});
