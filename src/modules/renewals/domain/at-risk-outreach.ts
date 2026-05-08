/**
 * F8 Phase 6 Wave A2 — `AtRiskOutreach` Domain entity (small).
 *
 * Branded `OutreachId` + outreach-channel constants for the
 * `at_risk_outreach` table (data-model.md § 2.5; migration 0090).
 *
 * Used by:
 *   - `record-at-risk-outreach.ts` use-case (Phase 6 Wave B T156)
 *   - `pause-reminders-after-outreach.ts` use-case (Phase 4 Wave I2a T092 — read-side)
 *   - `at_risk_outreach_recorded` audit-payload typed shape (Wave A2 here)
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

declare const OutreachIdBrand: unique symbol;
export type OutreachId = string & {
  readonly [OutreachIdBrand]: true;
};

const RE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OutreachIdError = {
  readonly kind: 'invalid_outreach_id';
  readonly raw: string;
};

/** Unchecked cast — use only in trusted contexts (DB row mapping, fixtures). */
export function asOutreachId(raw: string): OutreachId {
  return raw as OutreachId;
}

/** Validating parser — preferred for untrusted input (request bodies). */
export function parseOutreachId(
  raw: string,
): Result<OutreachId, OutreachIdError> {
  if (typeof raw !== 'string' || !RE_UUID.test(raw)) {
    return err({ kind: 'invalid_outreach_id', raw });
  }
  return ok(raw as OutreachId);
}

/**
 * Outreach-channel canonical list — mirrors the
 * `at_risk_outreach.channel` CHECK constraint at migration 0090.
 *
 * Migration 0090 also enforces `(channel = 'email' AND template_id IS
 * NOT NULL) OR (channel != 'email' AND template_id IS NULL)`. The
 * use-case zod schema mirrors this discriminant.
 */
export const OUTREACH_CHANNELS = ['email', 'phone', 'meeting'] as const;

export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export type OutreachChannelError = {
  readonly kind: 'invalid_outreach_channel';
  readonly raw: string;
};

export function parseOutreachChannel(
  raw: string,
): Result<OutreachChannel, OutreachChannelError> {
  if ((OUTREACH_CHANNELS as readonly string[]).includes(raw)) {
    return ok(raw as OutreachChannel);
  }
  return err({ kind: 'invalid_outreach_channel', raw });
}
