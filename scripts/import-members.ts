/**
 * Stage-3 member importer CLI (docs/member-import-spec.md, go-live Stage 3).
 *
 *   # dry-run (safe, default — validate + report, ZERO writes)
 *   TENANT_SLUG=swecham pnpm tsx scripts/import-members.ts --file ./swecham-members-2026.xlsx --plan-year 2026
 *
 *   # real import (only after a clean dry-run + PITR snapshot)
 *   TENANT_SLUG=swecham BOOTSTRAP_ADMIN_EMAIL=admin@… pnpm tsx scripts/import-members.ts \
 *       --file ./swecham-members-2026.xlsx --plan-year 2026 --commit
 *
 * PII: the workbook is gitignored + runs only on the operator's machine. The
 * written report is PII-free (counts + row indices only — spec § 7).
 *
 * Reads a TRUSTED local workbook (xlsx@0.18.5). The SheetJS malicious-file
 * advisories concern untrusted/web uploads — out of scope for an operator-run
 * one-time import. Pure logic (map/tier/validate/report) is unit-tested; this
 * orchestration + the --commit write path are covered by tests/integration/.
 */
import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
// 055-member-number — allocate the per-tenant human-readable number INSIDE the
// commit tx, mirroring the canonical createMember path (allocator under tenant
// RLS, advisory-lock-serialised). The column is NOT NULL with a per-tenant
// UNIQUE index, so a raw insert without it now fails at compile + runtime.
import { drizzleMemberNumberAllocator } from '@/modules/members/infrastructure/repos/drizzle-member-number-allocator';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { asPlanYear } from '@/modules/plans/domain/plan';
// F8-completion Slice 1 · Task 1.7 — create the imported member's INITIAL
// renewal cycle inside the same batch tx via the shared createCycleInTx
// helper (the single source of cycle-creation truth). `makeRenewalsDeps`
// is the F8 composition root; we extract the three deps createCycleInTx
// needs (mirrors the online on-paid path in renewals-deps.ts).
import { makeRenewalsDeps } from '@/modules/renewals';
import { createCycleInTx } from '@/modules/renewals/application/use-cases/create-cycle-in-tx';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { renewalsMetrics } from '@/lib/metrics';
import { requireSwechamTenant, findActorUserId } from './seed-demo-members';
import { buildColumnMap, mapDataRows } from './import-members/columns';
import { buildTierResolver, type PlanLite } from './import-members/tier-resolution';
import { validateRows, type ValidatedMember } from './import-members/validate';
import {
  buildReportDocument,
  renderReportText,
  writeReportFile,
  type CommitOutcome,
} from './import-members/report';

interface Args {
  readonly file: string;
  readonly planYear: number;
  readonly commit: boolean;
  readonly reportDir: string;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const file = get('--file');
  const planYearRaw = get('--plan-year');
  if (!file || !planYearRaw) {
    throw new Error(
      'usage: import-members.ts --file <xlsx> --plan-year <year> [--commit] [--report-dir <dir>]',
    );
  }
  const planYear = Number(planYearRaw);
  if (!Number.isInteger(planYear)) throw new Error(`--plan-year must be an integer (got "${planYearRaw}")`);
  return {
    file,
    planYear,
    commit: argv.includes('--commit'),
    reportDir: get('--report-dir') ?? process.cwd(),
  };
}

/** Read the first sheet as array-of-arrays (cellDates → JS Date for date columns). */
export function readWorkbook(file: string): { headers: string[]; dataRows: unknown[][] } {
  const wb = XLSX.readFile(file, { cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error(`workbook has no sheets: ${file}`);
  // blankrows: true KEEPS empty rows in the array so the array index stays aligned
  // with the real Excel row number (mapDataRows drops blank rows but their slot is
  // preserved, so report rowIndex always points at the true spreadsheet row even
  // after a blank separator gap).
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName]!, {
    header: 1,
    blankrows: true,
    defval: '',
  });
  const headers = (aoa[0] ?? []).map((h) => String(h ?? ''));
  return { headers, dataRows: aoa.slice(1) };
}

async function loadTierResolver(ctx: TenantContext, planYear: number) {
  const plans = await planRepo.findByTenantAndYear(ctx, {
    year: asPlanYear(planYear),
    showDeleted: false,
  });
  if (plans.length === 0) {
    throw new Error(
      `no seeded plans for ${ctx.slug} year ${planYear} — run scripts/seed-swecham-2026-plans.ts first (pre-req order, go-live § 6b).`,
    );
  }
  const lite: PlanLite[] = plans.map((p) => ({
    planId: p.plan_id,
    nameEn: p.plan_name.en,
    memberTypeScope: p.member_type_scope,
  }));
  return buildTierResolver(lite);
}

/**
 * Insert all valid members + contacts + audit in ONE transaction (spec § 5 —
 * atomic; a mid-batch failure rolls back the whole import). Idempotent: a member
 * whose listed emails all already exist (ACTIVE or already SOFT-DELETED) under a
 * SINGLE existing member is skipped (re-run safe); if those active emails span
 * DIFFERENT members it is flagged as a partial overlap, never silently swallowed.
 * A contact whose email matches a SOFT-DELETED row is skipped+counted on BOTH the
 * new-member and existing-member paths (operator decision: skip+warn, not reactivate).
 */
export async function commitMembers(
  ctx: TenantContext,
  actorUserId: string,
  validMembers: readonly ValidatedMember[],
  planYear: number,
): Promise<CommitOutcome> {
  // F8-completion Slice 1 · Task 1.7 — deps for the shared createCycleInTx
  // helper, built once from the F8 composition root (tenant-bound). Mirrors
  // the online on-paid path (renewals-deps.ts): cyclesRepo + planLookup +
  // auditEmitter + a randomUUID cycle-id factory.
  const renewalsDeps = makeRenewalsDeps(ctx.slug);
  const cycleDeps = {
    cyclesRepo: renewalsDeps.cyclesRepo,
    planLookup: renewalsDeps.planLookupForRenewal,
    auditEmitter: renewalsDeps.auditEmitter,
    idFactory: { cycleId: () => asCycleId(randomUUID()) },
  };

  return runInTenant(ctx, async (tx): Promise<CommitOutcome> => {
    let membersCreated = 0;
    let contactsCreated = 0;
    let cyclesCreated = 0;
    let skippedExistingMembers = 0;
    let skippedPartialOverlapMembers = 0;
    let skippedSoftDeletedContacts = 0;
    let skippedPrimaryCollisionMembers = 0;
    const partialOverlapRows: number[] = [];
    const primaryCollisionRows: number[] = [];

    const insertContact = async (
      memberId: string,
      c: ValidatedMember['contacts'][number],
      isPrimary: boolean,
    ): Promise<void> => {
      const contactId = randomUUID();
      await tx.insert(contacts).values({
        tenantId: ctx.slug,
        contactId,
        memberId,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        roleTitle: c.roleTitle,
        preferredLanguage: c.preferredLanguage,
        isPrimary,
      });
      await tx.insert(auditLog).values({
        eventType: 'contact_created',
        actorUserId,
        summary: 'import-members: created contact',
        requestId: `import-members-${randomUUID()}`,
        tenantId: ctx.slug,
        payload: { member_id: memberId, contact_id: contactId, is_primary: isPrimary, source: 'import-members' },
      });
      contactsCreated += 1;
    };

    for (const m of validMembers) {
      const headRow = m.rowIndices[0] ?? 0;
      const emails = m.contacts.map((c) => c.email.toLowerCase());
      if (emails.length === 0) continue; // defensive — validate guarantees ≥1 contact

      // Email-based dedupe (spec § 5) — match the per-contact partial unique index
      // (contacts_tenant_email_uniq ON (tenant_id, lower(email)) WHERE removed_at IS NULL).
      // ONE query partitioned in JS by removed_at (halves per-member round-trips); we also
      // carry member_id so an "already exists" skip can tell a true single-member re-run
      // apart from a collision whose active emails are spread across DIFFERENT members
      // (R4 #1/#7 — never silently swallow a workbook member that matches no single member).
      const existing = await tx
        .select({ email: contacts.email, removedAt: contacts.removedAt, memberId: contacts.memberId })
        .from(contacts)
        .where(and(eq(contacts.tenantId, ctx.slug), inArray(sql`lower(${contacts.email})`, emails)));
      const activeRows = existing.filter((r) => r.removedAt === null);
      const activeEmails = new Set(activeRows.map((r) => r.email.toLowerCase()));
      const softEmails = new Set(existing.filter((r) => r.removedAt !== null).map((r) => r.email.toLowerCase()));
      // "Genuinely new" = neither active nor already soft-deleted in the DB.
      const hasNewEmail = emails.some((e) => !activeEmails.has(e) && !softEmails.has(e));

      // Member already exists (≥1 active contact).
      if (activeEmails.size > 0) {
        // Nothing genuinely new (every listed email is active or already soft-deleted).
        if (!hasNewEmail) {
          // If the active matches all belong to ONE existing member, this is a clean
          // idempotent re-run → silent skip (R3 fix: a member with a soft-deleted
          // secondary is NOT a partial overlap). If they are spread across DIFFERENT
          // members, this workbook "member" matches no single member — flag it for the
          // operator instead of silently counting it as already-imported (R4 #1/#7).
          const activeOwnerIds = new Set(activeRows.map((r) => r.memberId));
          if (activeOwnerIds.size > 1) {
            skippedPartialOverlapMembers += 1;
            partialOverlapRows.push(headRow);
            continue;
          }
          // Report any soft-deleted contact the operator explicitly listed but we are NOT
          // reactivating, so this path accounts for it exactly like the new-member path
          // below (R4 #2/#6 — consistent reporting, not a silent drop).
          skippedSoftDeletedContacts += emails.filter((e) => softEmails.has(e)).length;
          skippedExistingMembers += 1;
          continue;
        }
        // Some active + a GENUINELY NEW contact → ambiguous partial overlap (which
        // existing member? is its primary intact?). We DO NOT auto-attach (R2 findings:
        // risks wrong-member attach / no active primary). Skip + record the row for the
        // operator. On a fresh first import this never fires (no active contacts exist).
        skippedPartialOverlapMembers += 1;
        partialOverlapRows.push(headRow);
        continue;
      }

      // NEW member (no active overlap). Its primary contact MUST be insertable — if the
      // primary email collides with a SOFT-DELETED contact, OR validate somehow failed to
      // mark a primary at all, we cannot create a clean member (it would have no active
      // primary), so skip + record the row. The missing-primary arm is defence-in-depth:
      // validate guarantees exactly one primary, but commitMembers is exported + tested
      // directly and contacts_one_primary_per_member silently ALLOWS a zero-primary member
      // (R4 #17 / SWEEP#2).
      const primary = m.contacts.find((c) => c.isPrimary);
      const primaryEmail = primary?.email.toLowerCase();
      if (!primaryEmail || softEmails.has(primaryEmail)) {
        skippedPrimaryCollisionMembers += 1;
        primaryCollisionRows.push(headRow);
        continue;
      }

      const memberId = randomUUID();
      // Allocate the next human-readable member number under the tenant RLS
      // session (tx-bound — never the pool-global db). Advisory-lock
      // serialised inside the allocator; gaps on rollback are acceptable.
      const memberNumber = await drizzleMemberNumberAllocator.allocate(
        tx,
        ctx.slug,
      );
      await tx.insert(members).values({
        tenantId: ctx.slug,
        memberId,
        memberNumber,
        companyName: m.companyName,
        country: m.country,
        taxId: m.taxId,
        planId: m.planId,
        planYear,
        registrationDate: m.registrationDate.toISOString().slice(0, 10),
        registrationFeePaid: true,
        status: 'active',
        turnoverThb: m.turnoverThb,
        city: m.city,
        province: m.province,
        postalCode: m.postalCode,
        preferredLocale: m.preferredLocale,
      });
      await tx.insert(auditLog).values({
        eventType: 'member_created',
        actorUserId,
        summary: `import-members: created member (${m.planId})`,
        requestId: `import-members-${randomUUID()}`,
        tenantId: ctx.slug,
        payload: { member_id: memberId, plan_id: m.planId, plan_year: planYear, source: 'import-members' },
      });
      membersCreated += 1;

      // No active overlap reached here (activeEmails is empty for this member), so the
      // only skip is a SECONDARY contact whose email matches a soft-deleted row; the
      // primary was already guarded above, so the member always keeps its primary.
      for (const c of m.contacts) {
        if (softEmails.has(c.email.toLowerCase())) { skippedSoftDeletedContacts += 1; continue; }
        await insertContact(memberId, c, c.isPrimary);
      }

      // F8-completion Slice 1 · Task 1.7 — the member's INITIAL renewal cycle,
      // created INSIDE this batch tx via the shared createCycleInTx helper.
      // Anchored at registration_date, +12 months, frozen at the resolved plan
      // price; idempotent (findActiveForMemberInTx no-op on a re-run). UNLIKE
      // the createMember onboarding listener, this does NOT swallow: a failure
      // throws → the whole batch rolls back (atomic) → the operator fixes the
      // data + re-runs. The counter is bumped (PII-free: tenant + row-index
      // only) BEFORE the re-throw so the operator sees which row aborted.
      try {
        await createCycleInTx(cycleDeps, tx, {
          tenantId: ctx.slug,
          memberId,
          periodFrom: m.registrationDate.toISOString(),
          planId: m.planId,
          source: 'import',
          actorUserId,
          actorRole: 'system',
          correlationId: `import-members-${randomUUID()}`,
        });
        cyclesCreated += 1;
      } catch (e) {
        renewalsMetrics.importCycleCreateFailed.add(1, { tenant_id: ctx.slug });
        console.error(
          `[import-members] cycle creation failed for row ${headRow} ` +
            `(member ${memberId}) — rolling back the whole batch: ` +
            (e instanceof Error ? e.message : String(e)),
        );
        throw e;
      }
    }

    return {
      membersCreated,
      contactsCreated,
      cyclesCreated,
      skippedExistingMembers,
      skippedPartialOverlapMembers,
      skippedSoftDeletedContacts,
      skippedPrimaryCollisionMembers,
      partialOverlapRows,
      primaryCollisionRows,
    };
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx = requireSwechamTenant();

  const { headers, dataRows } = readWorkbook(args.file);
  const columnMap = buildColumnMap(headers);
  if (columnMap.missingRequired.length > 0) {
    console.error(
      `[import-members] missing required column(s): ${columnMap.missingRequired.join(', ')}. ` +
        `Unmapped headers: ${columnMap.unmappedHeaders.join(', ') || '(none)'}. ` +
        `Fix the workbook headers (or the alias map) and re-run.`,
    );
    process.exit(2);
  }
  // Surface unmapped headers even when proceeding — an unmapped NON-required
  // column (e.g. "Annual Revenue (THB)", "Mobile No.") is silently dropped to '',
  // so the operator must see it + confirm the column map against the real Excel.
  if (columnMap.unmappedHeaders.length > 0) {
    console.warn(
      `[import-members] WARNING — these headers did not map to any field and their ` +
        `values are IGNORED: ${columnMap.unmappedHeaders.join(', ')}. ` +
        `Confirm none of them is a column you meant to import (turnover/phone/role/locale/etc.).`,
    );
  }

  const rows = mapDataRows(dataRows, columnMap, 2); // header is Excel row 1
  const tierResolver = await loadTierResolver(ctx, args.planYear);
  const report = validateRows(rows, tierResolver);

  let committed: CommitOutcome | null = null;
  const willCommit = args.commit && report.stats.errorCount === 0;

  if (args.commit && report.stats.errorCount > 0) {
    console.error(
      `[import-members] REFUSING --commit: ${report.stats.errorCount} validation error(s). ` +
        `Fix them (see report) and re-run a clean dry-run first.`,
    );
  }
  if (willCommit) {
    const actorUserId = await findActorUserId(ctx);
    committed = await commitMembers(ctx, actorUserId, report.members, args.planYear);
  }

  const doc = buildReportDocument({
    report,
    mode: willCommit ? 'commit' : 'dry-run',
    planYear: args.planYear,
    generatedAt: new Date().toISOString(),
    committed,
  });
  const reportPath = writeReportFile(doc, args.reportDir);
  console.log(renderReportText(doc));
  console.log(`\n[import-members] report written: ${reportPath}`);

  // Exit non-zero on validation errors so CI / the operator notices a bad dry-run.
  process.exit(report.stats.errorCount > 0 ? 1 : 0);
}

// Only run when invoked directly (not when imported by the integration test).
if (process.argv[1] && process.argv[1].endsWith('import-members.ts')) {
  main().catch((e: unknown) => {
    console.error('[import-members] crashed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
