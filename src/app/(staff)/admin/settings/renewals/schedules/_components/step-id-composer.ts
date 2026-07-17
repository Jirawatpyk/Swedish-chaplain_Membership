import { offsetKeyFromDays } from '@/modules/renewals/client';
import type { TierBucket } from '@/modules/renewals/client';

/**
 * Compose the wire `step_id`. Offset token MUST be first (gateway
 * `deriveOffsetFromStepId` slices to the first dot). Natural key is
 * (offset, channel[, taskType]) — two steps may share an offset across channels.
 */
export function composeStepId(input: {
  offsetDays: number;
  channel: 'email' | 'task';
  taskType?: string;
}): string {
  const offset = offsetKeyFromDays(input.offsetDays);
  if (input.channel === 'email') return `${offset}.email`;
  return `${offset}.task.${input.taskType ?? 'phone_call'}`;
}

/**
 * Compose the wire `template_id`. Tier MUST be last (gateway
 * `deriveTierFromTemplateId` uses endsWith('.'+tier)). Underscore tier is accepted.
 */
export function composeTemplateId(offsetDays: number, tier: TierBucket): string {
  return `renewal.${offsetKeyFromDays(offsetDays)}.${tier}`;
}

/**
 * Collision-safe `step_id` compose (StepCard v2 rework, Issue 3b).
 *
 * `step_id` uniqueness is BUCKET-WIDE, not per-channel — the Domain's
 * `parseSchedulePolicySteps` (`tenant-renewal-schedule-policy.ts`) walks
 * every step in the policy through a single `seenIds` set regardless of
 * channel. `existingIds` should therefore be every OTHER step's
 * `step_id` already in the bucket.
 *
 * When the base id (`composeStepId(input)`) is already taken, appends a
 * short numeric disambiguator to the **step_id only** — NEVER to
 * `offsetDays`/`template_id` (a separate, unaffected call to
 * `composeTemplateId`). This is safe because the gateway's
 * `deriveOffsetFromStepId` only reads the FIRST dot-segment of
 * `step_id` — a trailing `.2` suffix never breaks offset resolution
 * (pinned by the composer↔gateway contract test). The suffix is
 * derived deterministically from how many prior collisions already
 * exist (`.2`, `.3`, …) — never `Math.random()`/`Date.now()`.
 */
export function composeUniqueStepId(
  input: { offsetDays: number; channel: 'email' | 'task'; taskType?: string },
  existingIds: ReadonlySet<string>,
): string {
  const base = composeStepId(input);
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}.${suffix}`)) {
    suffix++;
  }
  return `${base}.${suffix}`;
}
