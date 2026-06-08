import { describe, it, expect } from 'vitest';
import { isResolvableActor } from '@/modules/insights/application/use-cases/audit-query';

/**
 * Guards the audit-viewer identity-resolve fix: only UUID-shaped actor ids
 * may reach the `users.id` (uuid column) lookup. A non-UUID id — most
 * notably the bare `'system'` that slipped the old `startsWith('system:')`
 * check — previously caused `invalid input syntax for type uuid` →
 * DrizzleQueryError → `insights.audit_query.identity_resolve_threw`.
 */
describe('isResolvableActor', () => {
  it('accepts a UUID-shaped actor id (case-insensitive)', () => {
    expect(isResolvableActor('f84689e8-b582-4fef-90f9-f8d97f0d41d9')).toBe(true);
    expect(isResolvableActor('F84689E8-B582-4FEF-90F9-F8D97F0D41D9')).toBe(true);
  });

  it('rejects the bare `system` sentinel (the bug — no colon)', () => {
    expect(isResolvableActor('system')).toBe(false);
  });

  it('rejects `system:*` sentinels', () => {
    for (const id of ['system:cron', 'system:auto-retry', 'system:webhook', 'system:public_unsubscribe']) {
      expect(isResolvableActor(id)).toBe(false);
    }
  });

  it('rejects `anonymous`, empty string, and arbitrary non-UUID strings', () => {
    for (const id of ['anonymous', '', 'bootstrap', 'staff@swecham.test', 'not-a-uuid']) {
      expect(isResolvableActor(id)).toBe(false);
    }
  });

  it('rejects a malformed/truncated UUID', () => {
    expect(isResolvableActor('f84689e8-b582-4fef-90f9')).toBe(false);
    expect(isResolvableActor('f84689e8b5824fef90f9f8d97f0d41d9')).toBe(false); // no dashes
  });
});
