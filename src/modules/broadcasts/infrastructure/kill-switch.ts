/**
 * T031 — F7 kill-switch helper.
 *
 * Single source of truth for the `FEATURE_F7_BROADCASTS` env-var check.
 * Every F7 route handler + cron handler + webhook handler MUST call
 * `assertF7Enabled()` at the start of execution to fail loudly + return
 * 503 when the feature is dark.
 *
 * The kill-switch ships in the disabled state by default (env.ts default
 * `false`) — F7 is dark in production until release-gate review.
 *
 * Reads from `@/lib/env` which is validated at boot (Phase 1 Setup T003).
 * No additional env validation here — `env.features.f7Broadcasts` is
 * guaranteed boolean by the zod schema.
 *
 * Usage in API route handlers (Phase 3+):
 *
 *     import { assertF7Enabled, F7DisabledError } from '@/modules/broadcasts/infrastructure/kill-switch';
 *
 *     export async function POST(req: NextRequest) {
 *       try {
 *         assertF7Enabled();
 *       } catch (e) {
 *         if (e instanceof F7DisabledError) {
 *           return Response.json({ code: 'feature_disabled' }, { status: 503 });
 *         }
 *         throw e;
 *       }
 *       // … normal handler logic …
 *     }
 *
 * **Mid-flight visibility caveat** (Spec § Edge Cases L341 + Q14): admin
 * routes that operate on EXISTING broadcasts (approve / reject / cancel /
 * detail-view) MUST NOT call `assertF7Enabled()` — the kill-switch
 * blocks NEW submissions only; in-flight broadcasts remain manageable
 * by admins so the queue can be cleared. Use `isF7Enabled()` for
 * conditional UI rendering instead.
 */
import { env } from '@/lib/env';

/**
 * Custom error thrown by `assertF7Enabled` when
 * `FEATURE_F7_BROADCASTS=false`. Discriminated `kind` field follows F5
 * `WebhookSignatureError` pattern.
 */
export class F7DisabledError extends Error {
  public readonly kind = 'feature_disabled' as const;

  constructor(message = 'F7 Email Broadcast feature is disabled') {
    super(message);
    this.name = 'F7DisabledError';
  }
}

/**
 * Throws `F7DisabledError` if `FEATURE_F7_BROADCASTS=false`. Use at
 * route-handler entry points for member-facing surfaces (compose,
 * draft, submit, schedule).
 */
export function assertF7Enabled(): void {
  if (!env.features.f7Broadcasts) {
    throw new F7DisabledError();
  }
}

/**
 * Predicate variant — returns the boolean directly. Use in admin
 * surfaces (queue list, detail view) where the kill-switch should NOT
 * block in-flight broadcast actions but may inform conditional UI
 * rendering ("Compose new broadcast" button hidden when disabled).
 */
export function isF7Enabled(): boolean {
  return env.features.f7Broadcasts;
}
