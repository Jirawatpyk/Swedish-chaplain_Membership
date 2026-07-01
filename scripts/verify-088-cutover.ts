/**
 * 088-invoice-tax-flow-redesign (T003) — cutover verification (scaffold).
 *
 * Pre- and post-flip assertion for the bill → §86/4-at-payment cutover
 * (plan.md § Rollout, Cutover & Rollback). Run against the target Neon branch
 * before flipping `FEATURE_088_TAX_AT_PAYMENT` on and issuing the first real
 * document:
 *
 *   pnpm tsx scripts/verify-088-cutover.ts
 *
 * Reads DATABASE_URL_UNPOOLED (preferred for introspection) or DATABASE_URL
 * from .env.local; TENANT_SLUG (default 'swecham') scopes the settings /
 * legacy-row checks. Exits 1 on any FAILED hard check.
 *
 * Scaffold status (T003): the schema-level checks (document_type enum,
 * audit_event_type, bill column) are live after Phase-2 migrations 0230/0231.
 * The settings / WHT-note / legal-entity-type / issued-unpaid checks are wired
 * incrementally as the later-story migrations (0233 settings, US3/US5) + the
 * cutover data-audit (T070) land — each is column-existence-guarded so this
 * script runs cleanly at every intermediate migration state.
 *
 * Per Constitution Principle I sub-clause 4: connects via the schema-owner role
 * (BYPASS RLS) — appropriate for cutover introspection, NEVER request-path
 * code (which uses pooled DATABASE_URL + runInTenant).
 */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

process.loadEnvFile?.('.env.local');

/**
 * M1 (§105/RC cutover-ordering guard) — is US7/T050 shipped, i.e. does the
 * event-WITHOUT-TIN §105 arm route to the SEPARATE `receipt_105` register
 * instead of the shared `receipt` (RC) stream? Detected by the routing literal
 * in `issue-event-invoice-as-paid.ts` (the sole site). Until it does, a §105
 * event-no-TIN receipt minted while `receipt_number_prefix='RC'` would carry an
 * `RC-…` number on the §86/4 RC register — un-renumberable §87 pollution.
 */
function us7Receipt105Live(): boolean {
  try {
    const src = readFileSync(
      'src/modules/invoicing/application/use-cases/issue-event-invoice-as-paid.ts',
      'utf8',
    );
    return src.includes("documentType: 'receipt_105'");
  } catch {
    return false;
  }
}

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error(
    'verify-088-cutover: DATABASE_URL_UNPOOLED (or DATABASE_URL) is required.',
  );
  process.exit(1);
}
const TENANT = process.env.TENANT_SLUG ?? 'swecham';

function report(label: string, ok: boolean, detail = ''): boolean {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

async function enumHasValue(
  sql: postgres.Sql,
  typeName: string,
  value: string,
): Promise<boolean> {
  const rows = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = ${typeName} AND e.enumlabel = ${value}
    ) AS present`;
  return rows[0]?.present === true;
}

async function columnExists(
  sql: postgres.Sql,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = ${table} AND column_name = ${column}
    ) AS present`;
  return rows[0]?.present === true;
}

async function main(): Promise<void> {
  const sql = postgres(url!, { max: 1, ssl: 'require' });
  let ok = true;
  try {
    console.log(`verify-088-cutover (tenant=${TENANT}):`);

    // 1. Numbering + document-class enums (migration 0230).
    ok = report(
      "document_type enum has 'bill'",
      await enumHasValue(sql, 'document_type', 'bill'),
    ) && ok;
    ok = report(
      "document_type enum has 'receipt_105' (separate §105 RE register)",
      await enumHasValue(sql, 'document_type', 'receipt_105'),
    ) && ok;

    // 2. §86/4-at-payment audit signal (migration 0230, T009).
    ok = report(
      "audit_event_type enum has 'tax_receipt_issued'",
      await enumHasValue(sql, 'audit_event_type', 'tax_receipt_issued'),
    ) && ok;

    // 3. Non-§87 bill number column (migration 0231).
    const hasBillCol = await columnExists(sql, 'invoices', 'bill_document_number_raw');
    ok = report('invoices.bill_document_number_raw column present', hasBillCol) && ok;

    // 4. SweCham numbering config = separate / RC (settings flip, § E cutover).
    const settings = await sql<
      { receipt_numbering_mode: string | null; receipt_number_prefix: string | null }[]
    >`
      SELECT receipt_numbering_mode, receipt_number_prefix
      FROM tenant_invoice_settings WHERE tenant_id = ${TENANT}`;
    const s = settings[0];
    if (!s) {
      ok = report(`tenant_invoice_settings row for '${TENANT}'`, false, 'row missing') && ok;
    } else {
      ok = report(
        "receipt_numbering_mode = 'separate'",
        s.receipt_numbering_mode === 'separate',
        `got '${s.receipt_numbering_mode}'`,
      ) && ok;
      ok = report(
        "receipt_number_prefix = 'RC'",
        s.receipt_number_prefix === 'RC',
        `got '${s.receipt_number_prefix ?? '(null)'}'`,
      ) && ok;

      // 4b. M1 — §105/RC cutover-ordering ship-gate. Setting the §86/4 RC prefix
      //     is only safe if EITHER the §105 event-no-TIN arm already routes to
      //     the separate `receipt_105` register (US7/T050 shipped) OR there are
      //     zero event-no-TIN §105 sales in the interim. Otherwise a §105
      //     receipt would be minted as `RC-…` onto the §86/4 RC register — a
      //     §87-no-gaps pollution that cannot be renumbered afterwards.
      if (s.receipt_number_prefix === 'RC' && !us7Receipt105Live()) {
        const evtNoTin = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM invoices
          WHERE tenant_id = ${TENANT}
            AND invoice_subject = 'event'
            AND pdf_doc_kind = 'receipt_separate'
            AND receipt_document_number_raw IS NOT NULL`;
        const n = evtNoTin[0]?.n ?? 0;
        ok = report(
          "M1 §105/RC ordering — no event-no-TIN §105 sales pollute the RC register while US7/T050 (receipt_105 split) is unshipped",
          n === 0,
          n === 0
            ? 'zero event-no-TIN §105 sales — RC prefix safe for now, but ship US7/T050 before any occur'
            : `${n} event-no-TIN §105 receipt(s) numbered on the shared RC register — SHIP US7/T050 (receipt_105 split) FIRST, then remediate`,
        ) && ok;
      }
    }

    // 5. WHT note seeded — column-existence-guarded (lands migration 0233 / US5).
    if (await columnExists(sql, 'tenant_invoice_settings', 'wht_note_th')) {
      const wht = await sql<{ wht_note_th: string | null; wht_note_en: string | null }[]>`
        SELECT wht_note_th, wht_note_en
        FROM tenant_invoice_settings WHERE tenant_id = ${TENANT}`;
      ok = report(
        'WHT note seeded (wht_note_th + wht_note_en not null)',
        wht[0]?.wht_note_th != null && wht[0]?.wht_note_en != null,
      ) && ok;
    } else {
      report('WHT note seeded', true, 'skipped — migration 0233 (US5) not yet applied');
    }

    // 6. Cutover data-audit — legal_entity_type populated (branch gate fails
    //    closed on NULL; T070). Informational count, not a hard fail here.
    const nullEntity = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM members
      WHERE tenant_id = ${TENANT} AND legal_entity_type IS NULL AND erased_at IS NULL`;
    report(
      'members with NULL legal_entity_type (branch line fails closed)',
      true,
      `count=${nullEntity[0]?.n ?? 0} — populate juristic members before first issuance (T070)`,
    );

    // 7. Zero issued-unpaid legacy §87 bills (FR-017 operator gate) — a
    //    still-'issued' row carrying a §87 sequence_number but no bill number
    //    would be rejected by the new pay path. Guarded on the bill column.
    if (hasBillCol) {
      const legacy = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM invoices
        WHERE tenant_id = ${TENANT} AND status = 'issued'
          AND sequence_number IS NOT NULL AND bill_document_number_raw IS NULL`;
      ok = report(
        'zero issued-unpaid legacy §87 invoices (FR-017 gate)',
        (legacy[0]?.n ?? 0) === 0,
        `count=${legacy[0]?.n ?? 0}`,
      ) && ok;
    }

    console.log(ok ? '\n✓ cutover checks passed' : '\n✗ cutover checks FAILED');
  } finally {
    await sql.end();
  }
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error('verify-088-cutover: crashed:', error);
  process.exit(1);
});
