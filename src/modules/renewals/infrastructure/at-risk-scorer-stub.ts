/**
 * F8 Phase 6 Wave B (T154) — `AtRiskScorer` stub adapter.
 *
 * Returns a deterministic "healthy / score=0" result for any input.
 * Production composition wires this stub at Wave B as a placeholder so
 * `RenewalsDeps` typechecks + the use-case is exercisable in unit
 * tests via `vi.mock`. **Wave C T159 replaces this stub with the real
 * CTE-based Drizzle adapter** that joins F4 invoices + F7 broadcasts +
 * F3 contacts + F6 events for the 8-factor formula per FR-029.
 *
 * Tests that drive at-risk paths (T173 / T174 / T175 integration; T172
 * property test against the Domain function directly) MUST replace
 * this stub via `makeRenewalsDeps` test-double composition; the stub
 * is intentionally inert + does not call any DB / cross-module code.
 */
import { computeAtRiskScore } from '../domain/at-risk-score';
import type { AtRiskScorer } from '../application/ports/at-risk-scorer';
import type { AtRiskScoreResult } from '../domain/at-risk-score';

const STUB_RESULT: AtRiskScoreResult = (() => {
  const r = computeAtRiskScore(
    { tenureDays: 365 },
    { minTenureDays: 30, eventAttendeesAvailable: false },
  );
  // computeAtRiskScore returns Result<_, never> so .ok is always true;
  // construct the stub result via the canonical Domain function so the
  // shape stays in sync if future Domain refactors change the result
  // shape (e.g. new field).
  /* v8 ignore next */
  if (!r.ok) throw new Error('unreachable: stub seed failed');
  return r.value;
})();

export const atRiskScorerStub: AtRiskScorer = {
  async scoreMember(
    _tenantId: string,
    _memberId: string,
  ): Promise<AtRiskScoreResult> {
    return STUB_RESULT;
  },
  async *scoreMembers(
    _tenantId: string,
    memberIds: ReadonlyArray<string>,
  ): AsyncIterable<{
    readonly memberId: string;
    readonly result: AtRiskScoreResult;
  }> {
    for (const memberId of memberIds) {
      yield { memberId, result: STUB_RESULT };
    }
  },
};
