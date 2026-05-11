/**
 * F8 Phase 7 review-fix S-Simplify-1 — common loader for the
 * "find suggestion + assert it's open" preamble shared across
 * `accept-tier-upgrade`, `dismiss-tier-upgrade`, `escalate-tier-upgrade`.
 *
 * Each caller previously repeated:
 *   1. parseInput → idParse via parseSuggestionId
 *   2. tierUpgradeRepo.findById null check
 *   3. status !== 'open' check
 *
 * This helper consolidates 18-line block × 3 callers to one.
 *
 * The error union widens at the caller's `return err(...)` site so the
 * use-case keeps its own error-kind discrimination visible.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import {
  parseSuggestionId,
  type SuggestionId,
  type TierUpgradeSuggestion,
} from '../../../domain/tier-upgrade-suggestion';
import type { TierUpgradeSuggestionRepo } from '../../ports/tier-upgrade-suggestion-repo';

export type LoadOpenSuggestionError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'suggestion_not_found' }
  | { readonly kind: 'suggestion_not_open' };

/**
 * Phase 7 review-fix Round 2 type SUG-3 — `suggestionId` and
 * `suggestion.suggestionId` carry the SAME value. The dual field is
 * intentional: `suggestionId` is the parsed-input brand (validated
 * via `parseSuggestionId`), while `suggestion.suggestionId` is the
 * DB-mint brand from the row mapper. They're guaranteed equal at
 * this seam, but exposing both spares callers a redundant
 * re-validation when they need just the id (e.g. for audit emit
 * payloads that take the brand directly).
 */
export interface LoadOpenSuggestionResult {
  readonly suggestionId: SuggestionId;
  readonly suggestion: TierUpgradeSuggestion;
}

export async function loadOpenSuggestion(
  repo: TierUpgradeSuggestionRepo,
  tenantId: string,
  rawSuggestionId: string,
): Promise<Result<LoadOpenSuggestionResult, LoadOpenSuggestionError>> {
  const idParse = parseSuggestionId(rawSuggestionId);
  if (!idParse.ok) {
    return err({ kind: 'invalid_input', message: 'invalid suggestion id' });
  }
  const suggestionId = idParse.value;

  const suggestion = await repo.findById(tenantId, suggestionId);
  if (suggestion === null) return err({ kind: 'suggestion_not_found' });
  if (suggestion.status !== 'open') {
    return err({ kind: 'suggestion_not_open' });
  }
  return ok({ suggestionId, suggestion });
}
