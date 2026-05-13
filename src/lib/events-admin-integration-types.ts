/**
 * Pure client-safe types + runtime constants for the F6 integration
 * admin surface. Extracted from `events-admin-integration-deps.ts`
 * (Round 3 verify-fix 2026-05-13) so client components — namely
 * `<RecentDeliveriesPanel>` and `<WebhookConfigWizard>` — can import
 * shared types/constants without dragging in the lib file's
 * server-only dependency chain (`@/modules/members` barrel →
 * `verify-contact-email.ts` → `renewals-deps.ts` → F5
 * `drizzle-tenant-payment-settings-repo.ts` with `revalidateTag`).
 *
 * Constraint: this module MUST stay free of any value-imports from
 * `@/modules/*` barrels. Domain-leaf imports (e.g. `SecretLastFour`)
 * are fine because they themselves declare no framework imports.
 */
import type { SecretLastFour } from '@/modules/events/domain/secret-last-four';

/**
 * Closed receiver-side enum of webhook processing outcomes. Duplicated
 * verbatim from `run-test-webhook.ts` (where it lives next to its
 * use-case) so this module does not need to type-import from the
 * Application layer (keeps the client-safe boundary explicit).
 */
export type ProcessingOutcomeLabel =
  | 'short_circuited_test'
  | 'matched_member_contact'
  | 'matched_member_domain'
  | 'matched_member_fuzzy'
  | 'non_member'
  | 'unmatched';

/**
 * Full processing-outcome union surfaced to the admin panel — the
 * receiver-side `ProcessingOutcomeLabel` plus a small set of failure
 * categories that map to dedicated i18n keys and a catch-all
 * `'unknown'` for receiver-side enum extensions that arrive before
 * the UI is rebuilt.
 */
export type RecentDeliveryProcessingOutcome =
  | ProcessingOutcomeLabel
  | 'duplicate'
  | 'malformed'
  | 'rolled_back'
  | 'rate_limited'
  | 'ingest_disabled'
  | 'unknown';

export interface RecentDelivery {
  readonly receivedAt: string;
  readonly requestId: string;
  readonly signatureOutcome: 'verified' | 'rejected' | 'unknown';
  readonly processingOutcome: RecentDeliveryProcessingOutcome | null;
  readonly matchedMemberId: string | null;
  readonly registrationId: string | null;
}

/**
 * Discriminated view of the F6 integration config — keyed on
 * `secretConfigured` so consumers narrow before accessing the
 * post-config fields.
 */
export type IntegrationConfigView =
  | {
      readonly secretConfigured: false;
      readonly webhookUrl: string;
      readonly recentDeliveries: ReadonlyArray<RecentDelivery>;
      readonly recentDeliveriesIncludeTests: boolean;
    }
  | {
      readonly secretConfigured: true;
      readonly webhookUrl: string;
      readonly secretLastFour: SecretLastFour;
      readonly graceActiveUntil: string | null;
      readonly ingestEnabled: boolean;
      readonly lastReceivedAt: string | null;
      readonly recentDeliveries: ReadonlyArray<RecentDelivery>;
      readonly recentDeliveriesIncludeTests: boolean;
    };

export interface LoadConfigOptions {
  readonly includeTestDeliveries: boolean;
  readonly webhookBaseUrl: string;
}

/**
 * Single source of truth for the `processing_outcome` values that
 * have a matching `processing.<value>` i18n key. The client panel
 * consumes this; the server lib re-exports the same Set so the
 * admin GET surface uses the same shape. MUST stay aligned with the
 * keys under
 * `admin.integrations.eventcreate.phaseC.recentDeliveries.processing`
 * in EN/TH/SV.
 */
// Round 3 M-type-2 — `satisfies readonly RecentDeliveryProcessingOutcome[]`
// forces the literal array to stay in lock-step with the union. If a
// future receiver-side widening drops an outcome from the union but
// not from this list, the `satisfies` constraint fails to compile
// instead of widening at construction.
const RECENT_PROCESSING_OUTCOMES_LIST = [
  'short_circuited_test',
  'matched_member_contact',
  'matched_member_domain',
  'matched_member_fuzzy',
  'non_member',
  'unmatched',
  'duplicate',
  'malformed',
  'rolled_back',
  'rate_limited',
  'ingest_disabled',
] as const satisfies readonly RecentDeliveryProcessingOutcome[];

export const KNOWN_RECENT_PROCESSING_OUTCOMES: ReadonlySet<RecentDeliveryProcessingOutcome> =
  new Set<RecentDeliveryProcessingOutcome>(RECENT_PROCESSING_OUTCOMES_LIST);

/**
 * Type-guard predicate over `KNOWN_RECENT_PROCESSING_OUTCOMES`.
 */
export function isKnownRecentProcessingOutcome(
  v: string,
): v is RecentDeliveryProcessingOutcome {
  return (KNOWN_RECENT_PROCESSING_OUTCOMES as ReadonlySet<string>).has(v);
}
