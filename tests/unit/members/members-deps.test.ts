/**
 * Unit tests for the members-module composition factories.
 *
 * `buildMemberProbeDeps` is a pure object-literal factory but carries
 * a precise `Pick<MembersDeps, ...>` contract. A regression where a
 * maintainer accidentally drops `audit` (which drives the
 * `member_cross_tenant_probe` audit emit) would silently break
 * Constitution Principle I clause 4 — probe audit required on every
 * cross-tenant miss. Cheap guard to keep the factory honest.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEraseMemberDeps,
  buildMemberProbeDeps,
  buildMembersDeps,
} from '@/modules/members/members-deps';
import { authUserErasureAdapter } from '@/modules/members/infrastructure/adapters/auth-user-erasure-adapter';
import { emailChangeTokenAdapter } from '@/modules/members/infrastructure/adapters/email-change-token-adapter';
import { userEmailAdapter } from '@/modules/members/infrastructure/adapters/user-email-adapter';
import { outboxCancelAdapter } from '@/modules/members/infrastructure/adapters/outbox-cancel-adapter';
import { f7BroadcastsContentScrubAdapter } from '@/modules/members/infrastructure/adapters/broadcasts-content-scrub-adapter';
import { f7BroadcastsDeliveryTombstoneAdapter } from '@/modules/members/infrastructure/adapters/broadcasts-delivery-tombstone-adapter';
import { eventRegistrationErasureAdapter } from '@/modules/members/infrastructure/adapters/event-registration-erasure-adapter';
import { directoryErasureAdapter } from '@/modules/members/infrastructure/adapters/directory-erasure-adapter';
import { f7BroadcastsAudienceDerivationAdapter } from '@/modules/members/infrastructure/adapters/broadcasts-audience-derivation-adapter';
import { subprocessorErasureAdapter } from '@/modules/members/infrastructure/adapters/subprocessor-erasure-adapter';
import type { TenantContext } from '@/modules/tenants';

const tenant = { slug: 'test-swecham-00000000' } as unknown as TenantContext;

describe('buildMemberProbeDeps', () => {
  it('returns exactly the GetMemberDeps subset — tenant + memberRepo + contactRepo + audit', () => {
    const deps = buildMemberProbeDeps(tenant);
    expect(Object.keys(deps).sort()).toEqual([
      'audit',
      'contactRepo',
      'memberRepo',
      'tenant',
    ]);
  });

  it('reuses the same adapter instances as the full deps bag', () => {
    const full = buildMembersDeps(tenant);
    const probe = buildMemberProbeDeps(tenant);
    expect(probe.memberRepo).toBe(full.memberRepo);
    expect(probe.contactRepo).toBe(full.contactRepo);
    expect(probe.audit).toBe(full.audit);
  });

  it('passes through the tenant argument verbatim', () => {
    const deps = buildMemberProbeDeps(tenant);
    expect(deps.tenant).toBe(tenant);
  });
});

describe('buildEraseMemberDeps', () => {
  it('returns exactly the EraseMemberDeps fields — archive cascade subset + F1 user-erasure (US2a) + F7 content scrub (US2b) + F6 registration fan-out (US2c) + token/outbox cancel (M1/L1) + sub-processor erasure (US3-C)', () => {
    const deps = buildEraseMemberDeps(tenant);
    expect(Object.keys(deps).sort()).toEqual([
      'audit',
      'broadcastsAudienceDerivation',
      'broadcastsCascade',
      'broadcastsContentScrub',
      'broadcastsDeliveryTombstone',
      'clock',
      'contactRepo',
      'directoryErasure',
      'eventRegistrationErasure',
      'invitations',
      'memberRepo',
      'outboxCancel',
      'renewalsCascade',
      'sessions',
      'subprocessorErasure',
      'tenant',
      'tokens',
      'userEmails',
      'userErasure',
    ]);
  });

  it('reuses the same adapter instances as the full deps bag', () => {
    const full = buildMembersDeps(tenant);
    const erase = buildEraseMemberDeps(tenant);
    // Compliance-critical wiring: a type-compatible but WRONG adapter for
    // `audit` would silently break the GDPR Art.17 / PDPA §33
    // member_erasure_requested / member_erased DPO audit, and a wrong
    // cascade adapter would skip the F7/F8 in-flight cancels. Reference
    // equality is what catches that — TypeScript can't.
    expect(erase.audit).toBe(full.audit);
    expect(erase.broadcastsCascade).toBe(full.broadcastsCascade);
    expect(erase.renewalsCascade).toBe(full.renewalsCascade);
    expect(erase.sessions).toBe(full.sessions);
    expect(erase.memberRepo).toBe(full.memberRepo);
    expect(erase.contactRepo).toBe(full.contactRepo);
    expect(erase.invitations).toBe(full.invitations);
    expect(erase.clock).toBe(full.clock);
    // US2a: a type-compatible but WRONG userErasure adapter would silently
    // skip the F1 linked-login anonymisation (the erased member could still
    // sign in). Reference equality catches that — TypeScript can't. The full
    // `MembersDeps` bag has no `userErasure` (it's erase-only), so this pins
    // against the real adapter singleton directly.
    expect(erase.userErasure).toBe(authUserErasureAdapter);
    // US2b: a type-compatible but WRONG broadcastsContentScrub adapter would
    // silently skip the F7 broadcast content + deliveries redaction (the erased
    // member's authored subject/body + received recipient email would survive).
    // The full `MembersDeps` bag has no `broadcastsContentScrub` (erase-only),
    // so pin it against the real adapter singleton directly.
    expect(erase.broadcastsContentScrub).toBe(f7BroadcastsContentScrubAdapter);
    // US2b (re-drive-stable tombstone): a type-compatible but WRONG
    // broadcastsDeliveryTombstone adapter would silently skip the in-tx
    // `broadcast_deliveries` tombstone (the erased member's received recipient
    // email + email-bearing error_message would survive). The full bag has no
    // `broadcastsDeliveryTombstone` (erase-only), so pin the real singleton.
    expect(erase.broadcastsDeliveryTombstone).toBe(
      f7BroadcastsDeliveryTombstoneAdapter,
    );
    // US2c: a type-compatible but WRONG eventRegistrationErasure adapter would
    // silently skip the F6 registration fan-out (every event registration the
    // erased member attended — carrying their email/name/company — would
    // survive in event_registrations forever). The full `MembersDeps` bag has
    // no `eventRegistrationErasure` (erase-only), so pin the real singleton.
    expect(erase.eventRegistrationErasure).toBe(eventRegistrationErasureAdapter);
    // COMP-1 / F9: a type-compatible but WRONG directoryErasure adapter would
    // silently skip the directory_listings + public-logo-blob erasure (the
    // member's directory PII + a publicly-fetchable logo would survive Art.17
    // erasure). The full bag has no `directoryErasure` (erase-only), so pin the
    // real singleton.
    expect(erase.directoryErasure).toBe(directoryErasureAdapter);
    // M1/L1: a wrong tokens / userEmails / outboxCancel adapter would silently
    // skip the post-erasure PII-resurrection + outbox-dispatch defences. The
    // full `MembersDeps` bag DOES carry `tokens` + `userEmails` (used by the
    // email-change flows) so pin those against the shared instance; the full
    // bag has no `outboxCancel` (erase-only), so pin it to the real singleton.
    expect(erase.tokens).toBe(full.tokens);
    expect(erase.userEmails).toBe(full.userEmails);
    expect(erase.tokens).toBe(emailChangeTokenAdapter);
    expect(erase.userEmails).toBe(userEmailAdapter);
    expect(erase.outboxCancel).toBe(outboxCancelAdapter);
    // US3-C: a type-compatible but WRONG broadcastsAudienceDerivation adapter
    // would silently capture an empty (or wrong) (audience, email) pair set in
    // the atomic scrub tx → the post-commit Resend removal would no-op while
    // reporting clean (the erased member stays in their Resend audiences). A
    // wrong subprocessorErasure adapter would skip the Resend removal entirely.
    // Neither is on the full `MembersDeps` bag (erase-only), so pin the real
    // singletons directly.
    expect(erase.broadcastsAudienceDerivation).toBe(
      f7BroadcastsAudienceDerivationAdapter,
    );
    expect(erase.subprocessorErasure).toBe(subprocessorErasureAdapter);
  });

  it('passes through the tenant argument verbatim', () => {
    const deps = buildEraseMemberDeps(tenant);
    expect(deps.tenant).toBe(tenant);
  });
});
