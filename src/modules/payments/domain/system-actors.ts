/**
 * Reserved UUIDs for non-human (system) actors used by F5 + downstream
 * F4 writes triggered from webhook / cron paths. Seeded into the `users`
 * table by `drizzle/migrations/0041_seed_system_actors.sql` so every
 * `uuid REFERENCES users(id)` FK (payments.actor_user_id,
 * invoices.payment_recorded_by_user_id, audit_log.actor_user_id, …)
 * stays referentially intact.
 *
 * Adding a new system actor: pick the next id in the
 * `00000000-0000-0000-0000-0000000f5xxx` range, append an INSERT block
 * to a follow-up migration, and export a new `SYSTEM_ACTOR_*` const here.
 *
 * These UUIDs are stable forever. Changing them would orphan every
 * historical audit row referring to a previous value.
 */

/**
 * Actor that wrote payments / invoice state transitions triggered by a
 * Stripe webhook delivery. Used by `markPaidFromProcessor` and any
 * future automatic-reconciliation path.
 */
export const SYSTEM_ACTOR_STRIPE_WEBHOOK =
  '00000000-0000-0000-0000-0000000f5001' as const;

/**
 * Legacy string-form actor sentinel used by F5 audit-emit paths that
 * pre-date the migration-0041 UUID convention. Synthesized timeline
 * events (`payment_succeeded`, `payment_failed`, `payment_canceled`,
 * `refund_*`) carry this value instead of the UUID. Both forms are
 * recognised by the admin reconciliation timeline's `isSystemActor()`
 * helper and render as the i18n `actorSystem` label.
 */
export const SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY =
  'system:stripe-webhook' as const;
