/**
 * Stage-3 member importer — tier → plan_id resolver (spec § 4).
 *
 * The Excel "Membership tier" column carries free-text labels that historically
 * differ from the PDF (e.g. "Premium" vs the seeded plan_name "Premium Corporate",
 * "Start-up" vs slug "start-up"). We build a normalized lookup from the seeded
 * plans (loaded via `planRepo.findByTenantAndYear` in the CLI) keyed by BOTH the
 * plan_id slug AND the English plan name, so "Premium" / "Premium Corporate" /
 * "premium" all resolve to plan_id `premium`. **Fail-loud** on any unmapped tier
 * (no silent default — spec § 4). Pure + framework-free (unit-testable, spec § 8).
 */
import { err, ok, type Result } from '@/lib/result';

export type MemberTypeScope = 'company' | 'individual' | 'both';

/** Decoupled from the full F2 Plan domain type — the CLI maps Plan[] → PlanLite[]. */
export interface PlanLite {
  readonly planId: string;
  readonly nameEn: string;
  readonly memberTypeScope: MemberTypeScope;
}

export interface ResolvedTier {
  readonly planId: string;
  /** Drives the spec § 3.8 tax_id-required rule (company scope ⇒ tax_id mandatory). */
  readonly memberTypeScope: MemberTypeScope;
}

export type TierResolveError = {
  readonly code: 'tier.unmapped';
  readonly raw: string;
  readonly known: readonly string[];
};

export interface TierResolver {
  resolve(excelTierLabel: string): Result<ResolvedTier, TierResolveError>;
  readonly knownTiers: readonly string[];
}

/** Lowercase + strip every non-alphanumeric char: "Start-up" → "startup", "Gold Partnership" → "goldpartnership". */
function normalizeTier(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Build a tier resolver from the seeded plans. Throws if two distinct plans
 * normalize to the same alias (a seed-data integrity error the operator must
 * fix before import — never a silent collision).
 */
export function buildTierResolver(plans: readonly PlanLite[]): TierResolver {
  const map = new Map<string, ResolvedTier>();

  const addAlias = (alias: string, entry: ResolvedTier): void => {
    const key = normalizeTier(alias);
    if (key.length === 0) return;
    const existing = map.get(key);
    if (existing && existing.planId !== entry.planId) {
      throw new Error(
        `tier-resolver: alias "${alias}" (normalized "${key}") maps to both ` +
          `"${existing.planId}" and "${entry.planId}" — ambiguous seeded plans.`,
      );
    }
    map.set(key, entry);
  };

  for (const p of plans) {
    const entry: ResolvedTier = {
      planId: p.planId,
      memberTypeScope: p.memberTypeScope,
    };
    addAlias(p.planId, entry); // 'premium', 'start-up' → 'startup'
    addAlias(p.nameEn, entry); // 'Premium Corporate' → 'premiumcorporate'
  }

  const knownTiers = plans.map((p) => p.planId);

  return {
    knownTiers,
    resolve(raw: string): Result<ResolvedTier, TierResolveError> {
      const hit = map.get(normalizeTier(raw));
      if (!hit) return err({ code: 'tier.unmapped', raw, known: knownTiers });
      return ok(hit);
    },
  };
}
