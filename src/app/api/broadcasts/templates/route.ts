/**
 * T110 (F7.1a US7) — GET `/api/broadcasts/templates`
 *
 * Member OR admin role + tenant ctx. Returns the template list filtered
 * by cascading locale (current_user_locale || tenant_default_locale ||
 * 'en') per contracts/broadcast-template.md § 1.5 + § 3 picker semantics.
 *
 * Power-user toggle: `?includeAllLocales=1` bypasses the cascade
 * (admin library "Show all" + member dropdown power-user mode).
 *
 * Auth: accepts either member or admin session (the picker is shared
 * between member compose and admin proxy-compose surfaces; admin sees
 * the same locale cascade as a member would since the picker UX is
 * member-facing). Anonymous → 401.
 *
 * Flag gate (T121): returns 503 `feature_disabled` when off (member-
 * facing surface, same shape as snapshot route).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  listBroadcastTemplates,
  makeListBroadcastTemplatesDeps,
  isF71aUs7Enabled,
  f71aUs7DisabledReason,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { baseHeaders, jsonError } from '@/lib/broadcasts-route-helpers';
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const LocaleSchema = z.enum(['en', 'th', 'sv']);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();

  if (!isF71aUs7Enabled()) {
    return NextResponse.json(
      { error: 'feature_disabled', reason: f71aUs7DisabledReason() },
      { status: 503, headers: baseHeaders(correlationId) },
    );
  }

  // Either member OR admin session — shared picker surface.
  const current = await getCurrentSession();
  if (!current) {
    return jsonError(401, 'no-session', correlationId);
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const url = new URL(request.url);

  // Optional locale filter — when omitted the use-case applies the
  // cascading default (currentUserLocale || tenantDefaultLocale || 'en').
  // The route extracts currentUserLocale from the `accept-language`
  // header negotiation OR the explicit `?locale=` query (member can
  // override). includeAllLocales=1 bypasses the cascade entirely.
  const includeAll = url.searchParams.get('includeAllLocales') === '1';
  const localeParam = url.searchParams.get('locale');
  let currentUserLocale: 'en' | 'th' | 'sv' | undefined;
  if (localeParam !== null) {
    const parsed = LocaleSchema.safeParse(localeParam);
    if (!parsed.success) {
      return jsonError(400, 'invalid_locale', correlationId);
    }
    currentUserLocale = parsed.data;
  }

  try {
    const rows = await runInTenant(tenantCtx, async () =>
      listBroadcastTemplates(
        makeListBroadcastTemplatesDeps(tenantCtx.slug),
        {
          tenantId: tenantCtx.slug as never,
          includeAllLocales: includeAll,
          ...(currentUserLocale !== undefined
            ? { currentUserLocale }
            : {}),
        },
      ),
    );

    return NextResponse.json(
      {
        templates: rows.map((t) => ({
          id: t.id,
          name: t.name,
          subject: t.subject,
          locale: t.locale,
          startedFromCount: t.startedFromCount,
          isSeeded: t.isSeeded,
          updatedAt: t.updatedAt.toISOString(),
        })),
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
      },
      'broadcasts.templates.list.unexpected_error',
    );
    return jsonError(500, 'internal_error', correlationId);
  }
}
