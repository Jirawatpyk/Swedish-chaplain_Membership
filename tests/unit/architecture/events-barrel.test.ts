/**
 * Architecture test for the F6 events module barrel (L1 round-3 fix
 * 2026-05-12).
 *
 * The barrel header at `src/modules/events/index.ts:29-50` documents:
 *   • Raw Infrastructure adapters (Drizzle tables + drizzle-*-repository
 *     factories + pino-audit-port) MUST NOT be re-exported.
 *   • Composition factories (`makeStandaloneAuditDeps`,
 *     `makeIngestWebhookAttendeeDeps`) ARE intentionally exported as
 *     the Presentation→Application seam.
 *
 * Until this test landed, the rule was comment-enforced only. This
 * test scans the barrel's exported names and asserts the forbidden
 * names are absent. A future PR that mistakenly adds `events` /
 * `eventRegistrations` / `makeDrizzleEventsRepository` etc. to the
 * barrel will fail this test.
 */
import { describe, it, expect } from 'vitest';
import * as barrel from '@/modules/events';

const FORBIDDEN_EXPORTS = [
  // Drizzle table names (schema.ts internals)
  'events',
  'eventRegistrations',
  'tenantWebhookConfigs',
  'eventcreateIdempotencyReceipts',
  // Drizzle row types (TypeScript leak vector)
  'EventRow',
  'NewEventRow',
  'EventRegistrationRow',
  'NewEventRegistrationRow',
  'TenantWebhookConfigRow',
  'NewTenantWebhookConfigRow',
  // Drizzle repo factory functions (raw adapters — should go via
  // composition factory `makeIngestWebhookAttendeeDeps` etc.)
  'makeDrizzleEventsRepository',
  'makeDrizzleRegistrationsRepository',
  'makeDrizzleIdempotencyStore',
  'makeDrizzleAttendeeMatcher',
  'makePinoAuditPort',
  // Schema literal (helpers internal to Infrastructure)
  'readAttendeeEmailLower',
];

const REQUIRED_EXPORTS = [
  // Composition factories — the documented seam.
  'makeStandaloneAuditDeps',
  'makeIngestWebhookAttendeeDeps',
  // Application port type-only exports.
  'isMatchType',
  'isPaymentStatus',
  'isProcessingOutcome',
  'isSource',
  'isContactMatch',
  'isPseudonymised',
  'isArchived',
  'isGraceSecretActive',
  'isNonQuotaMatchType',
  'isPersonalEmail',
  // Domain value-object const tables.
  'MATCH_TYPES',
  'PAYMENT_STATUSES',
  'PROCESSING_OUTCOMES',
  'SOURCES',
  // Use-case exports (Phase 3 + Phase 4 shipped).
  'verifyWebhookSignature',
  'ingestWebhookAttendee',
  'matchAttendeeToMember',
  'forceExpireGraceSecret',
  'listEvents',
  'loadEventDetail',
];

describe('events module barrel — architecture guard (L1 round-3)', () => {
  const exportedNames = Object.keys(barrel).filter((k) => k !== 'default');

  it.each(FORBIDDEN_EXPORTS)(
    'does NOT export raw Infrastructure: %s',
    (forbidden) => {
      expect(exportedNames).not.toContain(forbidden);
    },
  );

  it.each(REQUIRED_EXPORTS)('exports required surface: %s', (required) => {
    expect(exportedNames).toContain(required);
  });

  it('keeps the public surface bounded (no surprise exports)', () => {
    // Sanity check that the surface doesn't explode unintentionally.
    // Current count tracks ~50 exports at Phase 4 end. The threshold
    // is loose — adjust upward as Phase 5/6/7/9/10 use-cases land.
    expect(exportedNames.length).toBeLessThan(80);
    expect(exportedNames.length).toBeGreaterThan(30);
  });
});
