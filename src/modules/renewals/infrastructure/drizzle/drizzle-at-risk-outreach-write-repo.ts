/**
 * F8 Phase 6 Wave B (T157) — Drizzle adapter for `AtRiskOutreachWriteRepo`.
 *
 * Inserts rows into `at_risk_outreach` (Wave C migration 0090) for the
 * T156 `record-at-risk-outreach` use-case. Companion to the existing
 * read adapter `drizzle-at-risk-outreach-read-repo.ts` (Phase 4 Wave
 * I2a) — same table, different concerns: read-side covers the FR-033
 * 7-day pause check; this write-side covers the US4 admin/manager
 * "Contact" CTA insert.
 *
 * Tenant isolation is enforced by Postgres RLS+FORCE on
 * `at_risk_outreach` (migration 0090) — every method receives a tx
 * already prepared by `runInTenant`. NO explicit
 * `WHERE/INSERT tenant_id = ?` — the policy adds it automatically.
 *
 * Migration 0090 enforces the channel-template discriminant CHECK:
 *   - `channel = 'email'` ⇒ `template_id IS NOT NULL`
 *   - `channel != 'email'` ⇒ `template_id IS NULL`
 * The use-case zod schema mirrors this; if a malformed row reaches
 * here (defence-in-depth), the DB raises a CHECK violation that
 * propagates as an exception and rolls back the surrounding tx.
 */
import { db } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { atRiskOutreach } from '../schema-at-risk-outreach';
import { asOutreachId } from '../../domain/at-risk-outreach';
import type {
  AtRiskOutreachWriteRepo,
  InsertAtRiskOutreachInput,
  InsertAtRiskOutreachResult,
} from '../../application/ports/at-risk-outreach-write-repo';

export function makeDrizzleAtRiskOutreachWriteRepo(
  tenant: TenantContext,
): AtRiskOutreachWriteRepo {
  return {
    async insertOutreachInTx(
      tx: unknown,
      _tenantId: string,
      input: InsertAtRiskOutreachInput,
    ): Promise<InsertAtRiskOutreachResult> {
      const txDb = tx as typeof db;
      const inserted = await txDb
        .insert(atRiskOutreach)
        .values({
          tenantId: tenant.slug,
          memberId: input.memberId,
          channel: input.channel,
          templateId: input.templateId ?? null,
          outcomeNote: input.outcomeNote ?? null,
          actorUserId: input.actorUserId,
          // outreach_id + created_at populated via DB DEFAULT (uuidv4 + NOW())
        })
        .returning({
          outreachId: atRiskOutreach.outreachId,
          createdAt: atRiskOutreach.createdAt,
        });
      const row = inserted[0];
      if (!row) {
        // Should never happen — INSERT … RETURNING always returns the
        // inserted row. Defensive throw so a future regression in
        // RETURNING semantics surfaces loud.
        throw new Error(
          '[drizzle-at-risk-outreach-write-repo] INSERT returned zero rows',
        );
      }
      return {
        outreachId: asOutreachId(row.outreachId),
        createdAt: row.createdAt.toISOString(),
      };
    },
  };
}
