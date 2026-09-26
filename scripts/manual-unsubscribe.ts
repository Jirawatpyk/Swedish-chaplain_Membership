/**
 * Manual E-Blast opt-out — for a recipient who emailed the privacy inbox
 * (`TENANT_PRIVACY_CONTACT_EMAIL`) instead of using the unsubscribe link.
 *
 * The public unsubscribe page promises: "email us and we will remove this
 * address from all {tenant} E-Blasts within 2 business days. This is free of
 * charge." (GDPR Art. 12(2)-(3), Art. 21; PDPA §32.) This script keeps that
 * promise with the SAME write as every other opt-out path: it runs the
 * `unsubscribeRecipient` use-case (channel `manual`), so the tenant + email
 * row in `marketing_unsubscribes` and the `broadcast_unsubscribed` +
 * `broadcast_suppression_applied` audit events are identical to a click on
 * the link. Never hand-insert the row — a raw INSERT writes no audit.
 *
 * Runbook: docs/runbooks/broadcast-manual-unsubscribe.md
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *   # 1. Dry run — shows what would be written, touches nothing:
 *   TENANT_SLUG=swecham node --env-file=.env.production --import tsx \
 *     scripts/manual-unsubscribe.ts --email=person@example.com \
 *     --operator=you@swecham.com --ticket=PRIV-123
 *
 *   # 2. Apply:
 *   ... same command ... --confirm
 *
 * Idempotent: a second run reports "already opted out" and writes nothing.
 * Exit codes: 0 = done (or dry run); 1 = validation / write error.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { UnsubscribeRecipientDeps } from '@/modules/broadcasts/application/use-cases/unsubscribe-recipient';
import type { MembersBridgePort } from '@/modules/broadcasts/application/ports/members-bridge-port';

type Flags = {
  readonly email: string;
  readonly operator: string;
  readonly ticket: string;
  readonly confirm: boolean;
};

function usage(message: string): never {
  console.error(`manual-unsubscribe: ${message}`);
  console.error(
    'usage: TENANT_SLUG=<slug> node --env-file=<env> --import tsx scripts/manual-unsubscribe.ts ' +
      '--email=<address> --operator=<who> --ticket=<ref> [--confirm]',
  );
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Flags {
  let email = '';
  let operator = '';
  let ticket = '';
  let confirm = false;
  for (const arg of argv) {
    if (arg.startsWith('--email=')) email = arg.slice('--email='.length).trim();
    else if (arg.startsWith('--operator=')) operator = arg.slice('--operator='.length).trim();
    else if (arg.startsWith('--ticket=')) ticket = arg.slice('--ticket='.length).trim();
    else if (arg === '--confirm') confirm = true;
    else usage(`unknown argument: ${arg}`);
  }
  if (email === '') usage('--email is required');
  if (operator === '') usage('--operator is required (who is applying this removal)');
  if (ticket === '') usage('--ticket is required (the request reference, for the audit trail)');
  return { email, operator, ticket, confirm };
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));

  // Load env only after argument validation so `--help`-style mistakes fail
  // fast without a database. `--env-file` on the CLI wins; this fallback keeps
  // an env-less run from binding to nothing.
  if (!process.env.DATABASE_URL && existsSync('.env.local')) {
    process.loadEnvFile?.('.env.local');
  }

  const { asEmailLower } = await import(
    '@/modules/broadcasts/domain/value-objects/email-lower'
  );
  const email = asEmailLower(flags.email);
  if (!email.ok) usage(`not a valid email address: ${flags.email} (${email.error.code})`);

  const { asTenantContext, TENANT_SLUG_PATTERN } = await import('@/modules/tenants');
  const slug = process.env.TENANT_SLUG ?? '';
  if (!TENANT_SLUG_PATTERN.test(slug)) usage('TENANT_SLUG is required (e.g. TENANT_SLUG=swecham)');
  const tenant = asTenantContext(slug);

  // Deep imports only (not `broadcasts-deps` or any module barrel): those
  // pull the members → renewals → invoicing → payments chain, whose
  // infrastructure imports `server-only` and refuses to load outside
  // Next.js (same convention as backfill-cycle-anchors.ts).
  const { runInTenant } = await import('@/lib/db');
  const { makeDrizzleBroadcastsRepo } = await import(
    '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo'
  );
  const { f7AuditAdapter } = await import('@/modules/broadcasts/infrastructure/audit-adapter');
  const { makeDrizzleMarketingUnsubscribesRepo } = await import(
    '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo'
  );
  const { unsubscribeRecipient } = await import(
    '@/modules/broadcasts/application/use-cases/unsubscribe-recipient'
  );
  const { env } = await import('@/lib/env');

  const dbHost = (() => {
    try {
      return new URL(env.database.url).host;
    } catch {
      return '(unparseable DATABASE_URL)';
    }
  })();

  const existing = await makeDrizzleMarketingUnsubscribesRepo(slug).lookupBatch(slug, [
    email.value,
  ]);
  const alreadyOptedOut = existing.has(email.value);

  console.log(`tenant:    ${slug}`);
  console.log(`database:  ${dbHost}`);
  console.log(`address:   ${email.value}`);
  console.log(`status:    ${alreadyOptedOut ? 'ALREADY opted out — nothing to do' : 'not opted out'}`);
  if (alreadyOptedOut) return 0;
  if (!flags.confirm) {
    console.log('dry run:   re-run with --confirm to record the opt-out (channel manual).');
    return 0;
  }

  const deps: UnsubscribeRecipientDeps = {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(slug),
    marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(slug),
    // Member/contact attribution is best-effort in the use-case and the real
    // bridge needs the server-only barrel chain, so this CLI records the
    // tenant + email row without it. Suppression at dispatch keys on the
    // address alone, so the opt-out is fully effective.
    membersBridge: {
      lookupContactEmailInTenant: async () => null,
      lookupMemberPrimaryContactEmailInTenant: async () => null,
    } as unknown as MembersBridgePort,
    audit: f7AuditAdapter,
    clock: { now: () => new Date() },
    tenantDisplayName: slug,
    tenantSupportEmail: env.broadcasts.privacyContactEmail,
  };
  const result = await runInTenant(tenant, async () =>
    unsubscribeRecipient(deps, {
      tenantId: tenant.slug,
      broadcastId: null,
      emailLower: email.value,
      tokenPlaintext: null,
      channel: 'manual',
      operator: flags.operator,
      requestId: `manual-unsubscribe:${randomUUID()}`,
      reasonText: `Manual removal requested via privacy contact (ticket ${flags.ticket})`,
    }),
  );
  if (!result.ok) {
    console.error(`manual-unsubscribe: write failed: ${result.error.kind}`);
    return 1;
  }
  console.log(
    result.value.wasNew
      ? 'recorded:  opted out of all E-Blasts from this tenant (audit: broadcast_unsubscribed + broadcast_suppression_applied, channel manual).'
      : 'recorded:  already opted out (concurrent write) — nothing changed.',
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('manual-unsubscribe: crashed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
