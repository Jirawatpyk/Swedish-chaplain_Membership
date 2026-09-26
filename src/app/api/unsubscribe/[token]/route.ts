/**
 * RFC 8058 one-click unsubscribe — `POST /unsubscribe/[token]`.
 *
 * Mail clients POST `List-Unsubscribe=One-Click` to the URL in the
 * `List-Unsubscribe` header, which is the SAME path as the page
 * (`/unsubscribe/<token>`). Next.js cannot serve a page and a route handler
 * from one segment, so `src/proxy.ts` rewrites that POST here. The public
 * contract is the `/unsubscribe/[token]` URL; this `/api` path is an
 * implementation detail (a direct POST without an Origin is refused by the
 * CSRF guard, which is fine — nobody links here).
 *
 * No cookies, no session, no CSRF token: the signed token is the
 * credential (RFC 8058 § 3). The pipeline is shared with the GET page
 * (`processUnsubscribe`), so the tenant+email row and audit events are
 * identical; the channel is recorded as `one_click_post`.
 *
 * Responses carry no body the mail client needs — status only:
 *   - 200 unsubscribed, or already unsubscribed (idempotent)
 *   - 400 invalid token
 *   - 429 too many FAILED tokens from this IP (`Retry-After`)
 *   - 503 temporary failure — nothing recorded, retry (`Retry-After`)
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

import { processUnsubscribe } from '@/lib/broadcasts-public-unsubscribe';
import { getClientIp } from '@/lib/client-ip';
import { broadcastsTracer } from '@/lib/otel-tracer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'cache-control': 'no-store, private' } as const;
const ERROR_RETRY_AFTER_S = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const requestId = request.headers.get('x-request-id') ?? randomUUID();

  const span = broadcastsTracer().startSpan('public_unsubscribe', {
    attributes: { 'request.id': requestId, 'broadcasts.channel': 'one_click_post' },
  });
  try {
    const { outcome } = await processUnsubscribe(
      token,
      null,
      request.headers.get('accept-language'),
      getClientIp(request),
      requestId,
      'one_click_post',
    );
    span.setAttribute('broadcasts.outcome', outcome.state);
    switch (outcome.state) {
      case 'success':
      case 'already':
        return NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
      case 'invalid':
        return NextResponse.json({ error: 'invalid_token' }, { status: 400, headers: NO_STORE });
      case 'rate_limited':
        return NextResponse.json(
          { error: 'rate_limited' },
          {
            status: 429,
            headers: { ...NO_STORE, 'retry-after': String(outcome.retryAfterSeconds) },
          },
        );
      case 'error':
        return NextResponse.json(
          { error: 'temporarily_unavailable' },
          {
            status: 503,
            headers: { ...NO_STORE, 'retry-after': String(ERROR_RETRY_AFTER_S) },
          },
        );
    }
  } finally {
    span.end();
  }
}

// The page at `/unsubscribe/[token]` owns GET; this path only exists as
// the proxy's POST rewrite target.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
