/**
 * F8 Phase 7 T182 — `escalateTierUpgrade` use-case.
 *
 * Admin clicks "Escalate" on a tier-upgrade suggestion. Drafts a
 * pre-filled outreach record in `at_risk_outreach` linked to the
 * suggestion's member, so the chamber's relationship-management
 * cadence reuses the existing at-risk outreach surface (Phase 6 US4
 * stream). The suggestion stays in its current state (`open`); it
 * is NOT transitioned to a terminal status — admin still has the
 * option to Accept or Dismiss after the outreach.
 *
 * Audit: emits `at_risk_outreach_recorded` (existing event type,
 * shared with US4) — payload's `template_id` carries
 * `'tier_upgrade_escalation_<reasonCode>'` so dashboards can attribute
 * outreach to the tier-upgrade flow vs the at-risk widget flow.
 *
 * RBAC (FR-052a): admin role only.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import { loadOpenSuggestion } from './_lib/load-open-suggestion';
import { type SuggestionId } from '../../domain/tier-upgrade-suggestion';
import type { MemberId } from '@/modules/members';
import type { OutreachId } from '../../domain/at-risk-outreach';

export const escalateTierUpgradeInputSchema = z.object({
  tenantId: z.string().min(1),
  suggestionId: z.string().uuid(),
  outcomeNote: z.string().trim().max(500).optional(),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type EscalateTierUpgradeInput = z.infer<
  typeof escalateTierUpgradeInputSchema
>;

export interface EscalateTierUpgradeOutput {
  readonly suggestionId: SuggestionId;
  readonly outreachId: string;
}

export type EscalateTierUpgradeError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'suggestion_not_found' }
  | { readonly kind: 'suggestion_not_open' }
  | { readonly kind: 'server_error'; readonly message: string };

export async function escalateTierUpgrade(
  deps: RenewalsDeps,
  rawInput: EscalateTierUpgradeInput,
): Promise<Result<EscalateTierUpgradeOutput, EscalateTierUpgradeError>> {
  const inputResult = parseInput(escalateTierUpgradeInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  // Phase 7 review-fix S-Simplify-1: shared loader for the parse+find+
  // status-check preamble.
  const loaded = await loadOpenSuggestion(
    deps.tierUpgradeRepo,
    input.tenantId,
    input.suggestionId,
  );
  if (!loaded.ok) return err(loaded.error);
  const { suggestionId, suggestion: existing } = loaded.value;

  const templateId = `tier_upgrade_escalation_${existing.reasonCode}`;

  try {
    return await runInTenant(deps.tenant, async (tx) => {
      const writeInput: Parameters<
        typeof deps.atRiskOutreachWriteRepo.insertOutreachInTx
      >[2] = {
        memberId: existing.memberId,
        channel: 'email',
        actorUserId: input.actorUserId,
        templateId,
        ...(input.outcomeNote !== undefined && input.outcomeNote.length > 0
          ? { outcomeNote: input.outcomeNote }
          : {}),
      };
      const result = await deps.atRiskOutreachWriteRepo.insertOutreachInTx(
        tx,
        input.tenantId,
        writeInput,
      );

      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'at_risk_outreach_recorded',
          payload: {
            member_id: existing.memberId as MemberId,
            outreach_id: result.outreachId as OutreachId,
            channel: 'email' as const,
            template_id: templateId,
            actor_role: 'admin' as const,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: 'admin',
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );

      return ok({ suggestionId, outreachId: result.outreachId });
    });
  } catch (e) {
    return err({
      kind: 'server_error',
      message: (e as Error)?.message ?? 'unknown',
    });
  }
}

