/**
 * Round-3 post-import verification — READ-ONLY (Part 3 of the Round-3
 * import; docs/import/ROUND3_PLAN.md § Verify). Runs against whatever
 * DATABASE_URL the operator loads (dev branch or prod) and NEVER writes.
 *
 * Asserts (defaults = ROUND3_PLAN § Verify; every number overridable):
 *   - members: total 150 = active 111 + inactive 39 (no other statuses)
 *   - contacts: 150 active rows, all on @pending.swecham.zyncdata.app
 *   - invoices: 125 = paid 99 + issued 14 + void 12; zero drafts;
 *       every row has coverage_from/to AND bill_document_number_raw;
 *       NO row carries §87 document_number / sequence_number (new-flow only);
 *       every paid row has receipt_document_number_raw + receipt_pdf_status
 *       = 'rendered'
 *   - cycles: 111 = upcoming 99 (anchored_at + anchor_invoice_id set) +
 *       awaiting_payment 12 (linked_invoice_id set); no other statuses
 *   - member_number: exactly 1..150, gapless
 *   - tenant_document_sequences: bill/receipt streams consistent with the
 *       minted maxima per fiscal year (next = max + 1)
 *
 * Output is PII-free (counts, document numbers, member numbers only — never
 * company names or emails). Exit 0 = all assertions pass; exit 1 = one or
 * more failed, each listed.
 *
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.local --import tsx scripts/verify-round3-import.ts
 *
 *   # prod:
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.production --import tsx scripts/verify-round3-import.ts
 *
 * Overrides:
 *   --members N --active N --inactive N --contacts N
 *   --invoices N --paid N --issued N --void N
 *   --cycles N --upcoming N --awaiting N
 *   --email-domain <domain>
 *
 * Role note: uses the owner-role `db` singleton with explicit tenant_id
 * predicates (clear-test-data.ts pattern) — a non-BYPASSRLS role would read
 * silent zeros and produce misleading failures, so it hard-refuses one.
 */
import { existsSync } from 'node:fs';

// NOTE: '@/lib/db' is imported LAZILY inside main() — a static import would
// be hoisted ABOVE this fill-in and src/lib/env.ts would validate an empty
// environment (same lazy-import discipline as import-round3-invoices.ts).
// 'drizzle-orm' + '@/modules/tenants' + the pure helpers are env-free.
if (existsSync('.env.local')) {
  process.loadEnvFile?.('.env.local');
}

import { sql, type SQL } from 'drizzle-orm';
import { TENANT_SLUG_PATTERN } from '@/modules/tenants';
import {
  checkSequenceConsistency,
  findMemberNumberProblems,
  parseDocNumberRaw,
  type SequenceRowLite,
} from './import-round3/verify-helpers';

// Mirrors scripts/clear-test-data.ts.
function unwrap<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

interface Expectations {
  readonly members: number;
  readonly active: number;
  readonly inactive: number;
  readonly contacts: number;
  readonly invoices: number;
  readonly paid: number;
  readonly issued: number;
  readonly void: number;
  readonly cycles: number;
  readonly upcoming: number;
  readonly awaiting: number;
  readonly emailDomain: string;
}

const DEFAULTS: Expectations = {
  members: 150,
  active: 111,
  inactive: 39,
  contacts: 150,
  invoices: 125,
  paid: 99,
  issued: 14,
  void: 12,
  cycles: 111,
  upcoming: 99,
  awaiting: 12,
  emailDomain: 'pending.swecham.zyncdata.app',
};

function parseArgs(argv: readonly string[]): Expectations {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const int = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`verify-round3-import: ${flag} must be a non-negative integer, got "${raw}"`);
    }
    return n;
  };
  return {
    members: int('--members', DEFAULTS.members),
    active: int('--active', DEFAULTS.active),
    inactive: int('--inactive', DEFAULTS.inactive),
    contacts: int('--contacts', DEFAULTS.contacts),
    invoices: int('--invoices', DEFAULTS.invoices),
    paid: int('--paid', DEFAULTS.paid),
    issued: int('--issued', DEFAULTS.issued),
    void: int('--void', DEFAULTS.void),
    cycles: int('--cycles', DEFAULTS.cycles),
    upcoming: int('--upcoming', DEFAULTS.upcoming),
    awaiting: int('--awaiting', DEFAULTS.awaiting),
    emailDomain: get('--email-domain') ?? DEFAULTS.emailDomain,
  };
}

interface Assertion {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

const check = (id: string, ok: boolean, detail: string): Assertion => ({ id, ok, detail });

const eqCheck = (id: string, actual: number, expected: number): Assertion =>
  check(id, actual === expected, `expected ${expected}, got ${actual}`);

/** The lazily-imported `db` singleton, reduced to what this script needs. */
interface DbExec {
  execute(query: SQL): Promise<unknown>;
}

async function runVerification(
  db: DbExec,
  tenantId: string,
  exp: Expectations,
): Promise<Assertion[]> {
  const t = tenantId;
  const assertions: Assertion[] = [];
  const scalar = async (query: SQL): Promise<number> => {
    const r = await db.execute(query);
    return unwrap<{ n: number }>(r)[0]?.n ?? 0;
  };

  // --- members --------------------------------------------------------------
  const memberRows = await db.execute(sql`
    SELECT status, count(*)::int AS n FROM members
    WHERE tenant_id = ${t} GROUP BY status
  `);
  const byStatus = new Map(unwrap<{ status: string; n: number }>(memberRows).map((r) => [r.status, r.n]));
  const membersTotal = [...byStatus.values()].reduce((a, b) => a + b, 0);
  assertions.push(eqCheck('members.total', membersTotal, exp.members));
  assertions.push(eqCheck('members.active', byStatus.get('active') ?? 0, exp.active));
  assertions.push(eqCheck('members.inactive', byStatus.get('inactive') ?? 0, exp.inactive));
  const otherStatuses = [...byStatus.keys()].filter((s) => s !== 'active' && s !== 'inactive');
  assertions.push(
    check(
      'members.no_other_status',
      otherStatuses.length === 0,
      otherStatuses.length === 0
        ? 'only active/inactive present'
        : `unexpected member status(es): ${otherStatuses.join(', ')}`,
    ),
  );

  // --- contacts -------------------------------------------------------------
  const contactsTotal = await scalar(
    sql`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = ${t} AND removed_at IS NULL`,
  );
  assertions.push(eqCheck('contacts.total', contactsTotal, exp.contacts));
  const badDomain = await scalar(sql`
    SELECT count(*)::int AS n FROM contacts
    WHERE tenant_id = ${t} AND removed_at IS NULL
      AND lower(email) NOT LIKE ${'%@' + exp.emailDomain.toLowerCase()}
  `);
  assertions.push(
    check(
      'contacts.email_domain',
      badDomain === 0,
      badDomain === 0
        ? `all on @${exp.emailDomain}`
        : `${badDomain} contact(s) NOT on @${exp.emailDomain}`,
    ),
  );

  // --- invoices -------------------------------------------------------------
  const invRows = await db.execute(sql`
    SELECT status, count(*)::int AS n FROM invoices
    WHERE tenant_id = ${t} GROUP BY status
  `);
  const invByStatus = new Map(unwrap<{ status: string; n: number }>(invRows).map((r) => [r.status, r.n]));
  const invTotal = [...invByStatus.values()].reduce((a, b) => a + b, 0);
  assertions.push(eqCheck('invoices.total', invTotal, exp.invoices));
  assertions.push(eqCheck('invoices.paid', invByStatus.get('paid') ?? 0, exp.paid));
  assertions.push(eqCheck('invoices.issued', invByStatus.get('issued') ?? 0, exp.issued));
  assertions.push(eqCheck('invoices.void', invByStatus.get('void') ?? 0, exp.void));
  assertions.push(eqCheck('invoices.drafts', invByStatus.get('draft') ?? 0, 0));

  const missingCoverage = await scalar(sql`
    SELECT count(*)::int AS n FROM invoices
    WHERE tenant_id = ${t} AND (coverage_from IS NULL OR coverage_to IS NULL)
  `);
  assertions.push(
    check('invoices.coverage_complete', missingCoverage === 0,
      missingCoverage === 0 ? 'every invoice carries coverage_from/to'
        : `${missingCoverage} invoice(s) missing coverage_from/to`),
  );
  const missingBillNo = await scalar(sql`
    SELECT count(*)::int AS n FROM invoices
    WHERE tenant_id = ${t} AND bill_document_number_raw IS NULL
  `);
  assertions.push(
    check('invoices.bill_number_complete', missingBillNo === 0,
      missingBillNo === 0 ? 'every invoice carries bill_document_number_raw'
        : `${missingBillNo} invoice(s) missing bill_document_number_raw`),
  );
  const legacyNumbered = await scalar(sql`
    SELECT count(*)::int AS n FROM invoices
    WHERE tenant_id = ${t}
      AND (document_number IS NOT NULL OR sequence_number IS NOT NULL)
  `);
  assertions.push(
    check('invoices.no_legacy_87_numbers', legacyNumbered === 0,
      legacyNumbered === 0 ? 'no §87 document_number/sequence_number set (new-flow only)'
        : `${legacyNumbered} invoice(s) carry legacy document_number/sequence_number`),
  );
  const paidIncomplete = await scalar(sql`
    SELECT count(*)::int AS n FROM invoices
    WHERE tenant_id = ${t} AND status = 'paid'
      AND (receipt_document_number_raw IS NULL OR receipt_pdf_status IS DISTINCT FROM 'rendered')
  `);
  assertions.push(
    check('invoices.paid_receipts_rendered', paidIncomplete === 0,
      paidIncomplete === 0 ? 'every paid invoice has an RC number + rendered receipt PDF'
        : `${paidIncomplete} paid invoice(s) missing RC number or rendered receipt PDF`),
  );

  // --- renewal cycles -------------------------------------------------------
  const cycRows = await db.execute(sql`
    SELECT status, count(*)::int AS n FROM renewal_cycles
    WHERE tenant_id = ${t} GROUP BY status
  `);
  const cycByStatus = new Map(unwrap<{ status: string; n: number }>(cycRows).map((r) => [r.status, r.n]));
  const cycTotal = [...cycByStatus.values()].reduce((a, b) => a + b, 0);
  assertions.push(eqCheck('cycles.total', cycTotal, exp.cycles));
  assertions.push(eqCheck('cycles.upcoming', cycByStatus.get('upcoming') ?? 0, exp.upcoming));
  assertions.push(
    eqCheck('cycles.awaiting_payment', cycByStatus.get('awaiting_payment') ?? 0, exp.awaiting),
  );
  const cycOther = [...cycByStatus.keys()].filter(
    (s) => s !== 'upcoming' && s !== 'awaiting_payment',
  );
  assertions.push(
    check('cycles.no_other_status', cycOther.length === 0,
      cycOther.length === 0 ? 'only upcoming/awaiting_payment present'
        : `unexpected cycle status(es): ${cycOther.join(', ')}`),
  );
  const upcomingUnanchored = await scalar(sql`
    SELECT count(*)::int AS n FROM renewal_cycles
    WHERE tenant_id = ${t} AND status = 'upcoming'
      AND (anchored_at IS NULL OR anchor_invoice_id IS NULL)
  `);
  assertions.push(
    check('cycles.upcoming_anchored', upcomingUnanchored === 0,
      upcomingUnanchored === 0 ? 'every upcoming cycle carries anchored_at + anchor_invoice_id'
        : `${upcomingUnanchored} upcoming cycle(s) missing anchored_at/anchor_invoice_id`),
  );
  const awaitingUnlinked = await scalar(sql`
    SELECT count(*)::int AS n FROM renewal_cycles
    WHERE tenant_id = ${t} AND status = 'awaiting_payment' AND linked_invoice_id IS NULL
  `);
  assertions.push(
    check('cycles.awaiting_linked', awaitingUnlinked === 0,
      awaitingUnlinked === 0 ? 'every awaiting_payment cycle links its issued bill'
        : `${awaitingUnlinked} awaiting_payment cycle(s) missing linked_invoice_id`),
  );

  // --- member_number gapless 1..N -------------------------------------------
  const numberRows = await db.execute(
    sql`SELECT member_number AS n FROM members WHERE tenant_id = ${t} ORDER BY member_number`,
  );
  const numbers = unwrap<{ n: number }>(numberRows).map((r) => r.n);
  const numberProblems = findMemberNumberProblems(numbers, exp.members);
  assertions.push(
    check('members.member_number_gapless', numberProblems.length === 0,
      numberProblems.length === 0
        ? `member_number exactly 1..${exp.members}`
        : numberProblems.join('; ')),
  );

  // --- tenant_document_sequences vs minted maxima ---------------------------
  const rawRows = await db.execute(sql`
    SELECT bill_document_number_raw AS bill, receipt_document_number_raw AS receipt
    FROM invoices WHERE tenant_id = ${t}
  `);
  const minted = new Map<string, Map<number, number>>([
    ['bill', new Map()],
    ['receipt', new Map()],
  ]);
  const unparseable: string[] = [];
  for (const row of unwrap<{ bill: string | null; receipt: string | null }>(rawRows)) {
    for (const [stream, raw] of [
      ['bill', row.bill],
      ['receipt', row.receipt],
    ] as const) {
      if (raw === null) continue;
      const parsed = parseDocNumberRaw(raw);
      if (parsed === null) {
        unparseable.push(`${stream}:${raw}`);
        continue;
      }
      const byFy = minted.get(stream)!;
      byFy.set(parsed.fiscalYear, Math.max(byFy.get(parsed.fiscalYear) ?? 0, parsed.seq));
    }
  }
  assertions.push(
    check('invoices.doc_numbers_parseable', unparseable.length === 0,
      unparseable.length === 0
        ? 'all minted document numbers match {PREFIX}-{YYYY}-{NNNNNN}'
        : `unparseable document number(s): ${unparseable.slice(0, 10).join(', ')}`),
  );

  const seqRowsRaw = await db.execute(sql`
    SELECT document_type AS "documentType", fiscal_year AS "fiscalYear",
           next_sequence_number AS "nextSequenceNumber"
    FROM tenant_document_sequences WHERE tenant_id = ${t}
    ORDER BY document_type, fiscal_year
  `);
  const seqRows = unwrap<SequenceRowLite>(seqRowsRaw);
  const seqProblems = checkSequenceConsistency(seqRows, minted);
  assertions.push(
    check('sequences.consistent_with_minted', seqProblems.length === 0,
      seqProblems.length === 0
        ? 'bill/receipt streams: next_sequence_number = max minted + 1 per FY'
        : seqProblems.join('; ')),
  );
  // Informational: streams the import never mints into.
  const otherSeqRows = seqRows.filter(
    (r) => r.documentType !== 'bill' && r.documentType !== 'receipt',
  );
  if (otherSeqRows.length > 0) {
    console.log(
      `[info] non-bill/receipt sequence rows present (not asserted): ` +
        otherSeqRows
          .map((r) => `${r.documentType} FY${r.fiscalYear} next=${r.nextSequenceNumber}`)
          .join(' · '),
    );
  }

  return assertions;
}

async function main(): Promise<void> {
  const exp = parseArgs(process.argv.slice(2));
  const tenantId = process.env.TENANT_SLUG ?? 'swecham';
  if (!TENANT_SLUG_PATTERN.test(tenantId)) {
    throw new Error(`verify-round3-import: malformed TENANT_SLUG "${tenantId}".`);
  }

  // Lazy — reaches src/lib/env.ts (validated AFTER the .env.local fill-in).
  const { db } = await import('@/lib/db');

  // Silent-zero guard (see header role note).
  const roleRow = await db.execute(
    sql`SELECT (rolbypassrls OR rolsuper) AS ok FROM pg_roles WHERE rolname = current_user`,
  );
  if (unwrap<{ ok: boolean }>(roleRow)[0]?.ok !== true) {
    throw new Error(
      'verify-round3-import: current DB role does not bypass RLS — every count ' +
        'would read 0 and the report would mislead. Use the owner-role DATABASE_URL.',
    );
  }

  console.log('');
  console.log('=== verify-round3-import (READ-ONLY) ===');
  console.log(`Tenant: ${tenantId}`);
  console.log('');

  const assertions = await runVerification(db, tenantId, exp);
  const failed = assertions.filter((a) => !a.ok);

  for (const a of assertions) {
    console.log(`  [${a.ok ? 'PASS' : 'FAIL'}] ${a.id} — ${a.detail}`);
  }
  console.log('');
  if (failed.length > 0) {
    console.error(`verify-round3-import: ${failed.length} assertion(s) FAILED:`);
    for (const a of failed) console.error(`  - ${a.id}: ${a.detail}`);
    process.exit(1);
  }
  console.log(`verify-round3-import: all ${assertions.length} assertions passed`);
}

// Only run when invoked directly (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith('verify-round3-import.ts')) {
  main().catch((e: unknown) => {
    console.error(
      '[verify-round3-import] FAILED:',
      e instanceof Error ? e.message : String(e),
    );
    process.exit(1);
  });
}
