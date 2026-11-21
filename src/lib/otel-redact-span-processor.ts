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
 * #805 — no URL credential is exported either. Next's request span sets
 * `http.target` to the raw URL and `@vercel/otel`'s fetch spans put the full
 * URL in their name, `http.url` and `url.full`; reset, invitation,
 * verification and unsubscribe tokens ride in the path, the GDPR export
 * bearer and the renewal redeem link in the query, and a Blob or heartbeat
 * URL is a capability by its path. `http.target` becomes `http.route` when
 * Next set one; every other URL keeps its origin and its path with no query,
 * and a path segment that looks like a credential reads `:id`.
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
  name: string;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: { name: string; attributes?: Record<string, unknown> }[];
}

/**
 * A class name, or a closed code that carries no data: a pg SQLSTATE (`23505`;
 * `recordException` puts an error's `code` before its name), an HTTP status
 * (Next sets `error.type` to the status on a 5xx), a Node errno (`ECONNRESET`,
 * `ERR_STREAM_PREMATURE_CLOSE`).
 */
const CLOSED_CODE = /^(?:[0-9A-Z]{5}|[1-5][0-9]{2}|[A-Z][A-Z0-9_]{1,63})$/;
const asClass = (value: unknown): string =>
  isErrorClassToken(value) || (typeof value === 'string' && CLOSED_CODE.test(value)) ? value : 'unknown';

/** A path segment that can carry a credential: a uuid, or 16+ url-safe characters holding a digit. */
const CREDENTIAL_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b.*|(?=[^/]*\d)[A-Za-z0-9_.-]{16,})$/i;
const RELATIVE_BASE = 'http://relative.invalid';
const URL_ATTRIBUTES = ['http.url', 'url.full', 'url.path', 'resource.name'] as const;
const URL_SPAN_NAME = /^((?:fetch|http) [A-Z]+) (\S+)$/;

/** A URL (absolute or a path) with no query, no fragment and no credential-looking path segment; `'unknown'` when it cannot be read. */
export function redactUrl(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  let url: URL;
  try {
    url = new URL(raw, RELATIVE_BASE);
  } catch {
    return 'unknown';
  }
  const path = url.pathname
    .split('/')
    .map((segment) => (CREDENTIAL_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
  return url.origin === RELATIVE_BASE && !raw.startsWith(RELATIVE_BASE) ? path : `${url.origin}${path}`;
}

function redactUrls(span: MutableEndedSpan): void {
  const { attributes } = span;
  if ('http.target' in attributes) {
    const route = attributes['http.route'];
    attributes['http.target'] = typeof route === 'string' ? route : redactUrl(attributes['http.target']);
  }
  for (const key of URL_ATTRIBUTES) if (key in attributes) attributes[key] = redactUrl(attributes[key]);
  delete attributes['url.query'];
  const named = typeof span.name === 'string' ? URL_SPAN_NAME.exec(span.name) : null;
  if (named) span.name = `${named[1]} ${redactUrl(named[2])}`;
}

function redact(span: MutableEndedSpan): void {
  if (!Array.isArray(span.events) || typeof span.attributes !== 'object' || span.attributes === null) {
    throw new TypeError('unexpected span shape');
  }
  let eventClass: string | undefined;
  for (const event of span.events) {
    if (event.name !== 'exception') continue;
    const type = asClass(event.attributes?.['exception.type']);
    eventClass ??= type;
    event.attributes = { 'exception.type': type };
  }
  if ('error.type' in span.attributes) span.attributes['error.type'] = asClass(span.attributes['error.type']);
  redactUrls(span);
  if (span.status.code === STATUS_ERROR && span.status.message !== undefined) {
    const errorType = span.attributes['error.type'];
    // A new object: the SDK keeps the caller's status object by reference.
    span.status = { ...span.status, message: typeof errorType === 'string' ? errorType : (eventClass ?? 'unknown') };
  }
}

/** If the span is not shaped as expected, drop its events and URL attributes and mark the status unknown: never export text, never throw into `span.end()`. */
function failClosed(span: MutableEndedSpan): void {
  try {
    span.events = [];
    span.status = { code: span.status?.code ?? STATUS_ERROR, message: 'unknown' };
    if (typeof span.attributes === 'object' && span.attributes !== null) {
      for (const key of ['http.target', 'url.query', ...URL_ATTRIBUTES]) delete span.attributes[key];
    }
    const named = typeof span.name === 'string' ? URL_SPAN_NAME.exec(span.name) : null;
    if (named) span.name = named[1]!;
  } catch {
    // Nothing more can be done without throwing into the caller.
  }
}

export const redactErrorTextSpanProcessor: SpanProcessor = {
  onStart() {},
  onEnd(span) {
    const target = span as unknown as MutableEndedSpan;
    try {
      redact(target);
    } catch {
      failClosed(target);
    }
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};
