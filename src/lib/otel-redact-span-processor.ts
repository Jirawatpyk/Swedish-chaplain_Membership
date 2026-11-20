/**
 * #739 — the span processor that runs before the exporter (`instrumentation.ts`
 * lists it ahead of `'auto'`). Spans we create use `markSpanFailed` and carry
 * the error's class only, but Next's own spans (`closeSpanWithError`) and
 * `@vercel/otel`'s fetch instrumentation call `recordException`, which records
 * the message and the stack, and set the status message to `error.message`.
 * A DrizzleQueryError message quotes the statement's bound parameters (emails,
 * names), so every ended span is reduced to the class before export:
 *
 * - an `exception` event keeps only `exception.type` (`'unknown'` unless it is
 *   a class token);
 * - an `error.type` attribute that is not a class token reads `'unknown'`;
 * - an ERROR status message becomes that class.
 *
 * The span is mutated in `onEnd`: it has ended, and the composite processor in
 * `@vercel/otel` calls `onEnd` in list order, so this runs before the batch
 * processor queues it. `@opentelemetry/sdk-trace-base` is not a direct
 * dependency, so the processor is written against the shape `registerOTel`
 * accepts. Not covered: Next printing an unhandled error to stderr
 * (`docs/observability.md` § Log hygiene).
 */
import type { registerOTel } from '@vercel/otel';

import { isErrorClassToken } from '@/lib/log-id';

type Configuration = Exclude<NonNullable<Parameters<typeof registerOTel>[0]>, string>;
type SpanProcessorOrName = NonNullable<Configuration['spanProcessors']>[number];
type SpanProcessor = Exclude<SpanProcessorOrName, 'auto'>;

const STATUS_ERROR = 2;

interface MutableEndedSpan {
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: { name: string; attributes?: Record<string, unknown> }[];
}

const asClass = (value: unknown): string => (isErrorClassToken(value) ? value : 'unknown');

function redact(span: MutableEndedSpan): void {
  let eventClass: string | undefined;
  for (const event of span.events) {
    if (event.name !== 'exception') continue;
    const type = asClass(event.attributes?.['exception.type']);
    eventClass ??= type;
    event.attributes = { 'exception.type': type };
  }
  if ('error.type' in span.attributes) span.attributes['error.type'] = asClass(span.attributes['error.type']);
  if (span.status.code === STATUS_ERROR && span.status.message !== undefined) {
    const errorType = span.attributes['error.type'];
    span.status.message = typeof errorType === 'string' ? errorType : (eventClass ?? 'unknown');
  }
}

export const redactErrorTextSpanProcessor: SpanProcessor = {
  onStart() {},
  onEnd(span) {
    redact(span as unknown as MutableEndedSpan);
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};
