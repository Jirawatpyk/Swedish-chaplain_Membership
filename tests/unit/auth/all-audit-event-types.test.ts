/**
 * Unit — ALL_AUDIT_EVENT_TYPES is the full cross-module audit-event set
 * (go-live audit S1-P1-7). The admin audit-viewer filter dropdown is built from
 * this; the prior source was auth+payment+F9 only, so member/invoice/plan/etc.
 * events (the bulk of the log) were unfilterable. Guards against a regression
 * that narrows the source back to a single module's catalogue.
 */
import { describe, it, expect } from 'vitest';
import { ALL_AUDIT_EVENT_TYPES } from '@/modules/auth';

describe('ALL_AUDIT_EVENT_TYPES (audit-viewer filter source)', () => {
  it('covers every module, not just auth + payment', () => {
    const set = new Set(ALL_AUDIT_EVENT_TYPES);
    // One representative event per module that writes to audit_log.
    for (const evt of [
      'sign_in_success', // auth (F1)
      'plan_created', // plans (F2)
      'member_created', // members (F3)
      'invoice_issued', // invoicing (F4)
      'payment_succeeded', // payments (F5)
      'dashboard_viewed', // insights (F9)
    ]) {
      expect(set.has(evt), `missing audit event type: ${evt}`).toBe(true);
    }
  });

  it('is a large, de-duplicated, sorted list', () => {
    // The pg enum carries 100+ types across all modules.
    expect(ALL_AUDIT_EVENT_TYPES.length).toBeGreaterThan(100);
    expect(new Set(ALL_AUDIT_EVENT_TYPES).size).toBe(ALL_AUDIT_EVENT_TYPES.length);
    const sorted = [...ALL_AUDIT_EVENT_TYPES].sort();
    expect(ALL_AUDIT_EVENT_TYPES).toEqual(sorted);
  });
});
