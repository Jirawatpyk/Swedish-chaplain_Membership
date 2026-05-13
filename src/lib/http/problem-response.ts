/**
 * RFC 7807 problem-detail response helper.
 *
 * Centralises the `{ type, title, status, detail }` JSON shape +
 * `chamber-os.app/errors/` URI prefix that ~13 admin route handlers
 * previously assembled by hand. Round 3 simplifier S-H1 / type-design
 * M-type-1: one shared `ProblemDetail` interface ensures a typo
 * (`details` for `detail`) becomes a compile error rather than a
 * silently broken `parseProblemDetail` consumer.
 */
import { NextResponse } from 'next/server';

const PROBLEM_TYPE_BASE = 'https://chamber-os.app/errors/';

export interface ProblemDetail {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  /**
   * Forensic correlation key surfaced to the admin so support can map
   * a user-visible failure back to a pino/OTel trace.
   */
  readonly requestId?: string;
}

export interface ProblemResponseOptions {
  readonly headers?: HeadersInit;
  /** Extra problem-body fields (e.g. RFC-defined `errors` array). */
  readonly extras?: Readonly<Record<string, unknown>>;
}

/**
 * Build a `Content-Type: application/problem+json` `NextResponse`
 * with a uniform body shape. `kind` is appended to the canonical
 * `chamber-os.app/errors/` URI to form the problem type.
 */
export function problemResponse(
  status: number,
  kind: string,
  title: string,
  detail: string,
  options?: ProblemResponseOptions,
): NextResponse {
  const body: ProblemDetail & Record<string, unknown> = {
    type: `${PROBLEM_TYPE_BASE}${kind}`,
    title,
    status,
    detail,
    ...(options?.extras ?? {}),
  };
  return NextResponse.json(body, {
    status,
    ...(options?.headers !== undefined ? { headers: options.headers } : {}),
  });
}
