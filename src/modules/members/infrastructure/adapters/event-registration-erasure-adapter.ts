/**
 * EventRegistrationErasurePort adapter — bridges F3 member erasure → F6
 * `eraseAllRegistrationsForMember` (COMP-1 US2c, GDPR Art. 17 / PDPA §33).
 *
 * Single allowed F3 → F6 crossing point for the event-registration fan-out
 * cascade. Imports F6's public barrel (`@/modules/events`) — Constitution
 * Principle III barrel-guard permits cross-module reads of public exports.
 * Internal F6 modules (`./application`, `./infrastructure`) are NOT imported.
 *
 * The F6 fan-out is BEST-EFFORT and never-erring: it returns
 * `Result<{ erasedCount, alreadyErasedCount, failedCount }, never>` where a
 * `failedCount > 0` is success-WITH-failures, not an `err`. This adapter
 * translates that into the three-way port outcome:
 *   - ok with `failedCount === 0` → `{ outcome: 'ok', erasedCount }`
 *   - ok with `failedCount > 0`   → `{ outcome: 'partial', erasedCount, failedCount }` (+ log)
 *   - a throw (calling convention) → `{ outcome: 'failed' }` (+ log) — defensive
 *
 * Best-effort defence: the fan-out never-throws, but this adapter still wraps
 * the call in try/catch so a throw at the calling convention (e.g. a
 * deps-factory failure) is translated to `{ outcome: 'failed' }` + a logged
 * error — the erasure proof records the cascade as incomplete, never a silent
 * swallow-to-no-op.
 *
 * Clock: the F6 fan-out input requires an `occurredAt`. The members cascade
 * adapter family sources side-effect values inline at the boundary (e.g. the
 * F8 cascade adapter mints a fresh `randomUUID()` correlation id inline), so
 * the erasure timestamp is captured with `new Date()` at the call site —
 * threaded through the fan-out into each per-registration `eraseAttendeePii`.
 */
import {
  eraseAllRegistrationsForMember,
  makeEraseAllRegistrationsForMemberDeps,
} from '@/modules/events';
import { logger } from '@/lib/logger';
import type { EventRegistrationErasurePort } from '../../application/ports/event-registration-erasure-port';

/**
 * No-op registration-erasure adapter for tests that don't exercise the F6
 * boundary (`EventRegistrationErasurePort` is required in production deps;
 * tests inject this stub instead of leaving the dep `undefined`). Returns the
 * `'ok'` variant of the discriminated union with a zero `erasedCount` — a
 * no-op erased nothing.
 */
export const noopEventRegistrationErasureAdapter: EventRegistrationErasurePort =
  {
    async eraseAllForMember() {
      return { outcome: 'ok', erasedCount: 0 };
    },
  };

export const eventRegistrationErasureAdapter: EventRegistrationErasurePort = {
  async eraseAllForMember(tenant, memberId, meta) {
    try {
      const result = await eraseAllRegistrationsForMember(
        {
          tenantId: tenant.slug,
          memberId: memberId as string,
          actorUserId: meta.actorUserId,
          requestId: meta.requestId,
          occurredAt: new Date(),
        },
        makeEraseAllRegistrationsForMemberDeps(tenant),
      );

      // The F6 fan-out never returns `err` (Result error channel is `never`),
      // but narrow defensively so a future widening can't slip through.
      if (!result.ok) {
        logger.error(
          {
            tenantId: tenant.slug,
            memberId: memberId as string,
            requestId: meta.requestId,
            cascade: 'f6_event_registration_erasure',
          },
          'members.erase.event_registration_erasure_failed',
        );
        return { outcome: 'failed' };
      }

      const { erasedCount, failedCount } = result.value;
      if (failedCount > 0) {
        // Best-effort partial: the member-row erasure still succeeds, but the
        // cascade-completion proof MUST record it as incomplete so the US2d
        // reconciler re-drives the remaining registrations. This is the SINGLE
        // owner of the cascade-detail error log (the use-case `eraseMember` F6
        // block intentionally does NOT re-log — see that block's flag-flip).
        // Log the counts (uuids only, NEVER attendee PII — that is exactly what
        // we erased) + requestId so the use-case's signal is not lost.
        logger.error(
          {
            tenantId: tenant.slug,
            memberId: memberId as string,
            requestId: meta.requestId,
            erasedCount,
            failedCount,
            cascade: 'f6_event_registration_erasure',
          },
          'members.erase.event_registration_erasure_partial',
        );
        return { outcome: 'partial', erasedCount, failedCount };
      }

      return { outcome: 'ok', erasedCount };
    } catch (e) {
      // Defensive: the fan-out is never-throws, but a throw at the calling
      // convention (deps factory, etc.) must not break the erasure flow —
      // translate to `outcome: 'failed'` + log (no swallow-to-no-op).
      logger.error(
        {
          // Forbidden-log hygiene (COMP-1 PR-review FIX D): error CLASS name only,
          // never the raw message (it can embed SQL param VALUES = attendee PII).
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
          tenantId: tenant.slug,
          memberId: memberId as string,
          requestId: meta.requestId,
          cascade: 'f6_event_registration_erasure',
        },
        'members.erase.event_registration_erasure_failed',
      );
      return { outcome: 'failed' };
    }
  },
};
