/**
 * F9 US2 (T046) — GET `/api/admin/audit/export.csv` — sync audit export (FR-012).
 *
 * Streams the currently-filtered audit set as CSV (UTF-8 + BOM so Excel-TH
 * renders Thai without the import wizard). Staff-only: admin + manager; member
 * → 403 (the use-case's own role gate is the source of truth). Manager exports
 * are payload-redacted identically to the on-screen viewer (FR-011) because both
 * call the same `auditExport` use-case. The export action is itself audited
 * (`audit_log_exported`) by the use-case.
 *
 * Over the 10k sync cap the use-case returns `export_too_large` → 409; the async
 * `audit_export` job fallback lands with US6. Gated behind FEATURE_F9_DASHBOARD.
 * Node runtime pinned (Drizzle).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { buildAttachmentContentDisposition } from '@/lib/content-disposition';
import { tenantDayStartUtc, tenantDayEndUtc, isYmd } from '@/lib/tenant-day-range';
import { isValidTargetRef } from '@/app/(staff)/admin/audit/_lib/audit-filter-validation';
import { toCsvField } from '@/lib/csv';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { rateLimiter } from '@/modules/auth';
import { auditExport, makeAuditQueryDeps, type AuditQueryInput } from '@/modules/insights';

export const runtime = 'nodejs';

/** Export budget per actor: 10 requests / 60 s sliding window. */
const EXPORT_RL_MAX = 10;
const EXPORT_RL_WINDOW_SECONDS = 60;

const CSV_HEADERS = [
  'id',
  'occurred_at_utc',
  'event_type',
  'actor',
  'actor_user_id',
  'target_user_id',
  'summary',
  'payload',
] as const;

function str(v: string | null): string {
  const raw = (v ?? '').trim();
  return raw;
}

export async function GET(request: NextRequest): Promise<Response> {
  // Redirects unauthenticated callers; returns the session for authenticated.
  const session = await requireSession('staff');
  if (!env.features.f9Dashboard) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
  // Defence-in-depth role gate: `requireSession('staff')` authenticates but does
  // not enforce role, so reject non-staff explicitly before dispatching (the
  // use-case also returns `forbidden` for members → the same 403).
  if (session.user.role !== 'admin' && session.user.role !== 'manager') {
    return NextResponse.json({ error: { code: 'forbidden' } }, { status: 403 });
  }

  // Rate-limit per actor — the export is an unauthenticated-cost-multiplier
  // (broad date range × up to 10k rows × Neon credits). Other admin routes
  // (csv-import, error-csv-download, …) rate-limit; match that for consistency.
  const rl = await rateLimiter.check(
    `audit-export:${session.user.id}`,
    EXPORT_RL_MAX,
    EXPORT_RL_WINDOW_SECONDS,
  );
  if (!rl.success) {
    const retryAfter = retryAfterSecondsFromRl({ reset: rl.reset });
    return NextResponse.json(
      { error: { code: 'rate_limited' } },
      { status: 429, headers: { 'Retry-After': retryAfter.toString() } },
    );
  }

  const url = new URL(request.url);
  const eventType = str(url.searchParams.get('eventType'));
  const actorUserId = str(url.searchParams.get('actorUserId'));
  const targetRef = str(url.searchParams.get('targetRef'));
  const from = str(url.searchParams.get('from'));
  const to = str(url.searchParams.get('to'));

  // Guard the date format BEFORE js-joda conversion — a malformed `from`/`to`
  // (tampered URL) would otherwise throw outside the try/catch below → bodyless
  // 500 + no log. Likewise a non-UUID `targetRef` hits the uuid `target_user_id`
  // column and, though caught below, surfaces as a 500 server_error rather than
  // the correct client error. Both are client errors → 400 invalid_range.
  if (
    (from !== '' && !isYmd(from)) ||
    (to !== '' && !isYmd(to)) ||
    !isValidTargetRef(targetRef)
  ) {
    return NextResponse.json({ error: { code: 'invalid_range' } }, { status: 400 });
  }

  const input: AuditQueryInput = {
    ...(eventType ? { eventType: [eventType] } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    ...(targetRef ? { targetRef } : {}),
    ...(from ? { from: tenantDayStartUtc(from, env.tenant.timezone) } : {}),
    ...(to ? { to: tenantDayEndUtc(to, env.tenant.timezone) } : {}),
  };

  const tenant = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  let result;
  try {
    result = await auditExport(
      input,
      { actorUserId: session.user.id as string, actorRole: session.user.role, requestId },
      tenant,
      makeAuditQueryDeps(),
    );
  } catch (e) {
    // A thrown export (e.g. Neon read failure) would otherwise become a bodyless
    // framework 500 with no log line — make the failure observable (errKind only,
    // no raw message/PII).
    logger.error(
      { tenantId: tenant.slug, requestId, errKind: errKind(e) },
      'insights.audit_export.threw',
    );
    return NextResponse.json({ error: { code: 'server_error' } }, { status: 500 });
  }

  if (!result.ok) {
    if (result.error === 'forbidden') {
      return NextResponse.json({ error: { code: 'forbidden' } }, { status: 403 });
    }
    if (result.error === 'invalid_range') {
      return NextResponse.json({ error: { code: 'invalid_range' } }, { status: 400 });
    }
    // export_too_large — async job fallback is US6.
    return NextResponse.json(
      { error: { code: 'export_too_large', cap: 10_000 } },
      { status: 409 },
    );
  }

  const lines: string[] = [CSV_HEADERS.map(toCsvField).join(',')];
  for (const r of result.value.rows) {
    lines.push(
      [
        r.id,
        r.occurredAt,
        r.eventType,
        r.actorLabel,
        r.actorUserId,
        r.targetUserId ?? '',
        r.summary,
        r.payload ? JSON.stringify(r.payload) : '',
      ]
        .map((c) => toCsvField(String(c)))
        .join(','),
    );
  }
  // Leading BOM for Excel-TH UTF-8 detection.
  const csv = `﻿${lines.join('\r\n')}\r\n`;

  const stamp = new Date().toISOString().slice(0, 10);
  logger.info(
    { tenantId: tenant.slug, requestId, rowCount: result.value.rows.length },
    'insights.audit_export.streamed',
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': buildAttachmentContentDisposition(`audit-log-${stamp}.csv`),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Row-Count': String(result.value.rows.length),
    },
  });
}
