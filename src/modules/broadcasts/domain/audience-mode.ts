/**
 * 108 PR-C (data-model § 1, research R8/R10) — which audience the resolver
 * builds for a MEMBER-BASED segment (`all_members`, `tier`).
 *
 *   - `primary_only`  — the pre-108 audience: one primary contact per eligible
 *                       member. The flag-OFF leg; the rollback for the
 *                       widening (quickstart § Rollback matrix).
 *   - `all_contacts`  — every eligible contact (primary AND secondary) of
 *                       every eligible member (FR-020). The flag-ON leg.
 *
 * The value is decided ONCE, in the broadcasts composition root, from
 * `env.features.contactMarketingRecipients`, and passed into
 * `ResolveSegmentDeps.audienceMode` — Domain and Application never read the
 * env (Constitution III). The `primary_only` leg and this type are deleted
 * together after one clean week of sends (tasks T099, plan Complexity
 * Tracking #2).
 *
 * Both legs share everything after the source step: the `status = 'active'`
 * predicate (FR-021, unflagged), self-exclusion by member id, dedupe,
 * suppression, the per-contact opt-out filter and the ceiling.
 */
export type AudienceMode = 'primary_only' | 'all_contacts';
