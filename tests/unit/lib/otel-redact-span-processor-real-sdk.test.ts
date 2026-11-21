/**
 * #739 review — the processor against a real span: `@vercel/otel`'s own
 * provider (its bundled SDK) runs `recordException` and `setStatus`, and the
 * processor listed after ours sees what the exporter would see. A change in
 * `@vercel/otel` (a snapshot before `onEnd`, a frozen span) fails here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { registerOTel } from '@vercel/otel';

import { redactErrorTextSpanProcessor } from '@/lib/otel-redact-span-processor';

interface Seen {
  events: { name: string; attributes?: Record<string, unknown> }[];
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
}

const seen: Seen[] = [];
const capture = {
  onStart() {},
  onEnd(span: Seen) {
    seen.push(JSON.parse(JSON.stringify({ events: span.events, status: span.status, attributes: span.attributes })));
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

class DrizzleQueryError extends Error {
  override name = 'DrizzleQueryError';
}

describe('redactErrorTextSpanProcessor on a real @vercel/otel span (#739 review)', () => {
  afterEach(() => {
    trace.disable();
    seen.length = 0;
  });

  it('the exporter-side processor sees only the class, a SQLSTATE and an HTTP status', () => {
    registerOTel({ serviceName: 't', spanProcessors: [redactErrorTextSpanProcessor, capture as never], instrumentations: [] });
    const tracer = trace.getTracer('next.js');

    const span = tracer.startSpan('GET /admin/members');
    const e = new DrizzleQueryError('Failed query: insert … params: a@b.example');
    span.recordException(e);
    span.setAttribute('error.type', e.name);
    span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
    span.recordException(Object.assign(new Error('duplicate key (email)=(a@b.example)'), { code: '23505' }));
    span.end();

    const status = tracer.startSpan('GET /portal');
    status.setAttribute('error.type', '500');
    status.setStatus({ code: SpanStatusCode.ERROR, message: 'Internal: a@b.example' });
    status.end();

    expect(seen).toHaveLength(2);
    expect(seen[0]!.events.map((ev) => ev.attributes)).toEqual([
      { 'exception.type': 'DrizzleQueryError' },
      { 'exception.type': '23505' },
    ]);
    expect(seen[0]!.status).toEqual({ code: SpanStatusCode.ERROR, message: 'DrizzleQueryError' });
    expect(seen[1]!.attributes['error.type']).toBe('500');
    expect(seen[1]!.status.message).toBe('500');
    expect(JSON.stringify(seen)).not.toContain('@');
  });
});
