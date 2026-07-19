/**
 * F8 follow-up (`.superpowers/sdd/followup-tasktype-brief.md`) — unit
 * tests for the pure `resolveTaskTypeLabel` guard used by the
 * escalation-task queue's task-type filter + `YearInCyclePill` label.
 *
 * The translator stub reproduces next-intl's real `t(key)` / `t.has(key)`
 * shape over the REAL `admin.renewals.tasks.taskType` bag from `en.json`
 * (not a hand-rolled fixture) so this pins actual translation coverage,
 * not just the resolver's branching logic.
 *
 * Coverage matrix (mirrors the brief's "queue label test" bullet):
 *   - a rich/known task type (`quarterly_review_meeting`) → its real label
 *   - a pre-existing ESCALATION-SPECIFIC task type
 *     (`verify_pending_tier_upgrade` — never part of the StepCard's
 *     `RENEWAL_KNOWN_TASK_TYPES` suggestion catalogue, see
 *     `resolve-task-type-label.ts`'s doc comment) → still its real label,
 *     NOT regressed to raw by a whitelist-only guard
 *   - a bespoke/legacy task type with no i18n entry → falls back to the
 *     raw value, never throws
 */
import { describe, it, expect } from 'vitest';
import {
  resolveTaskTypeLabel,
  type TaskTypeTranslator,
} from '@/app/(staff)/admin/renewals/tasks/_components/resolve-task-type-label';
import enMessages from '@/i18n/messages/en.json';

function getNested(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/** Minimal real-shaped translator over a REAL namespace object — mirrors
 * what `useTranslations('admin.renewals.tasks')` resolves at runtime
 * (`t(key)` + `t.has(key)`), without needing next-intl/React here. */
function makeTranslator(namespace: Record<string, unknown>): TaskTypeTranslator {
  const t = ((key: string) => {
    const value = getNested(namespace, key);
    if (typeof value !== 'string') {
      throw new Error(`MISSING_MESSAGE: ${key}`);
    }
    return value;
  }) as TaskTypeTranslator;
  t.has = (key: string) => typeof getNested(namespace, key) === 'string';
  return t;
}

const t = makeTranslator(enMessages.admin.renewals.tasks as Record<string, unknown>);

describe('resolveTaskTypeLabel (F8 follow-up)', () => {
  it('a rich/known task type resolves to its real EN label, not the raw value', () => {
    expect(resolveTaskTypeLabel(t, 'quarterly_review_meeting')).toBe(
      'Quarterly review meeting',
    );
  });

  it('a pre-existing escalation-specific task type (never part of the StepCard suggestion catalogue) still resolves to its own label', () => {
    // Regression guard: `verify_pending_tier_upgrade` is NOT one of
    // `RENEWAL_KNOWN_TASK_TYPES` (@/modules/renewals/client) — a
    // whitelist-based guard would wrongly treat it as "unknown" and
    // regress this ALREADY-translated label down to raw text.
    expect(resolveTaskTypeLabel(t, 'verify_pending_tier_upgrade')).toBe(
      'Verify pending tier upgrade',
    );
  });

  it('a bespoke/legacy task type with no i18n entry falls back to the raw value, never throws', () => {
    expect(() => resolveTaskTypeLabel(t, 'some_bespoke_legacy_type')).not.toThrow();
    expect(resolveTaskTypeLabel(t, 'some_bespoke_legacy_type')).toBe(
      'some_bespoke_legacy_type',
    );
  });
});
