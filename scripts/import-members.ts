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
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { asPlanYear } from '@/modules/plans/domain/plan';
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
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName]!, {
    header: 1,
    blankrows: false,
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
 * whose contact email already exists as an ACTIVE contact is skipped (re-run
 * safe). A contact whose email matches a SOFT-DELETED row is skipped+counted
 * (operator decision: skip+warn, not reactivate).
 */
export async function commitMembers(
  ctx: TenantContext,
  actorUserId: string,
  validMembers: readonly ValidatedMember[],
  planYear: number,
): Promise<CommitOutcome> {
  return runInTenant(ctx, async (tx): Promise<CommitOutcome> => {
    let membersCreated = 0;
    let contactsCreated = 0;
    let skippedExistingMembers = 0;
    let skippedSoftDeletedContacts = 0;

    for (const m of validMembers) {
      const emails = m.contacts.map((c) => c.email.toLowerCase());

      const activeRows = await tx
        .select({ email: contacts.email })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, ctx.slug),
            inArray(sql`lower(${contacts.email})`, emails),
            isNull(contacts.removedAt),
          ),
        );
      if (activeRows.length > 0) {
        skippedExistingMembers += 1; // already imported — idempotent skip
        continue;
      }

      const softRows = await tx
        .select({ email: contacts.email })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, ctx.slug),
            inArray(sql`lower(${contacts.email})`, emails),
            isNotNull(contacts.removedAt),
          ),
        );
      const softEmails = new Set(softRows.map((r) => r.email.toLowerCase()));

      const memberId = randomUUID();
      await tx.insert(members).values({
        tenantId: ctx.slug,
        memberId,
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

      for (const c of m.contacts) {
        if (softEmails.has(c.email.toLowerCase())) {
          skippedSoftDeletedContacts += 1; // skip+warn (do not reactivate)
          continue;
        }
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
          isPrimary: c.isPrimary,
        });
        await tx.insert(auditLog).values({
          eventType: 'contact_created',
          actorUserId,
          summary: 'import-members: created contact',
          requestId: `import-members-${randomUUID()}`,
          tenantId: ctx.slug,
          payload: { member_id: memberId, contact_id: contactId, is_primary: c.isPrimary, source: 'import-members' },
        });
        contactsCreated += 1;
      }
    }

    return { membersCreated, contactsCreated, skippedExistingMembers, skippedSoftDeletedContacts };
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
