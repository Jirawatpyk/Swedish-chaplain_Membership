/**
 * T061 (F7.1a US1) — Feature-flag gate helpers for F7.1a US1
 * Pagination (5k → 50k). Composes the master F71A flag AND the
 * per-user-story sub-flag so a feature can be dark-launched at three
 * levels:
 *   1. F7 master kill-switch (`FEATURE_F7_BROADCASTS`) — disables
 *      ALL of F7 MVP + F71A
 *   2. F71A master (`FEATURE_F71A_BROADCAST_ADVANCED`) — disables
 *      ALL of F71A (US1 + US2 + US7) while leaving F7 MVP running
 *   3. F71A US1 sub-flag (`FEATURE_F71A_US1_PAGINATION`) — disables
 *      ONLY US1 batch pagination while leaving US2 image embedding
 *      and US7 template library enabled
 *
 * When US1 is OFF:
 *   - Admin routes T050 (retry) + T051 (accept-partial) return 503
 *     `feature_disabled` (HTTP code maintained by F7 MVP route helpers)
 *   - Cron T055 (dispatch-batches) returns 200 + {skipped: true}
 *     (matches F7 MVP dispatch-scheduled / prune kill-switch pattern;
 *     prevents cron-job.org retry storm during dark launch)
 *   - Admin detail page hides the BatchBreakdown component entirely
 *     — recipients > 10k can't reach the batch creation path while
 *     US1 is off, so the breakdown would always be empty + confusing
 *   - F7.1a webhook batch routing falls back to a no-op (the bypass-
 *     RLS lookup still runs, but `applyBatchWebhookEvent` is not
 *     invoked — the events land in the F7 MVP `processWebhookEvent`
 *     path as a NULL-tenant audit row)
 *
 * Pure helper — no framework imports beyond `env`. Safe to import
 * from server components, API routes, and cron handlers.
 */
import { env } from '@/lib/env';

/**
 * `true` when F7 master + F71A master + F71A US1 sub-flag are all
 * enabled. False otherwise.
 *
 * Use this gate at every F7.1a US1 entry point (admin retry / accept-
 * partial routes, dispatch-batches cron, batch breakdown UI surface).
 */
export function isF71aUs1Enabled(): boolean {
  return (
    env.features.f7Broadcasts &&
    env.features.f71aBroadcastAdvanced &&
    env.features.f71aUs1Pagination
  );
}

/**
 * Discriminated reason for the flag-disabled state — used by route
 * handlers + the cron handler to emit structured logs at the right
 * level (info for kill-switch, warn for unexpected combinations).
 */
export type F71aUs1DisabledReason =
  | 'f7_master_off'
  | 'f71a_master_off'
  | 'f71a_us1_off';

export function f71aUs1DisabledReason(): F71aUs1DisabledReason | null {
  if (!env.features.f7Broadcasts) return 'f7_master_off';
  if (!env.features.f71aBroadcastAdvanced) return 'f71a_master_off';
  if (!env.features.f71aUs1Pagination) return 'f71a_us1_off';
  return null;
}
