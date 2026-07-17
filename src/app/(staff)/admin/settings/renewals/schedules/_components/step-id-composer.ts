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
