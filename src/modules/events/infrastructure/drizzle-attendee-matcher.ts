/**
 * T046 — Drizzle attendee matcher (F6 Infrastructure).
 *
 * Implements `AttendeeMatcher` port. Reads F3's `members` + `contacts`
 * tables to resolve an attendee to a chamber member via the 4-rule
 * cascade per research.md R4.
 *
 * Schema reality check: F3 does NOT have an `email_domain` column on
 * `members` (data-model.md § 5 spec assumed it; implementation pivot).
 * The domain rule is implemented by querying `contacts` for emails
 * ending in `@<attendee-domain>` and looking up the unique parent
 * member_id. If exactly one distinct member has a contact with that
 * domain → member_domain match; otherwise fall through to fuzzy.
 *
 * Fuzzy match is performed at the application layer: fetch the
 * tenant's members (~<2k at design envelope), apply
 * `normaliseCompanyName` to attendee.company + each
 * `members.companyName`, compute Levenshtein, pick the unique winner
 * with distance ≤ threshold (default 3 per research.md R4 / FR-012).
 *
 * Read-only adapter — never mutates F3 tables. RLS+FORCE on members +
 * contacts means the caller MUST run this inside `runInTenant(ctx, fn)`
 * for the SELECTs to return any rows.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import { type TenantTx } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import type {
  AttendeeMatcher,
  MatchAttendeeInput,
  MatchAttendeeOutput,
  AttendeeMatcherError,
} from '../application/ports/attendee-matcher';
import { isPersonalEmail } from '../domain/personal-email-deny-list';
import { normaliseCompanyName } from '../domain/normalise-company-name';
import { levenshtein } from '../domain/levenshtein';
import { wrapRepoError } from './sanitize-db-error';
import { logger } from '@/lib/logger';
import type { MemberId, ContactId } from '@/modules/members';

const DEFAULT_FUZZY_THRESHOLD = 3;

/**
 * B10 — explicit upper bound on the in-memory fuzzy-match candidate set.
 * The fuzzy rule loads tenant members into JS and computes Levenshtein per
 * row (O(M) per attendee → O(N×M) per import). At/under the 5k design
 * envelope this is fine (scripts/perf/eventcreate-attendee-fuzzy-match.ts,
 * p95<50ms target). Beyond it we cap the scan and emit a structured
 * `logger.warn` so the overrun is OBSERVABLE in Vercel runtime logs rather
 * than silently degrading. Crossing this cap is the trigger to land the
 * documented pg_trgm GIN + SQL-side similarity() fallback. Exported so tests
 * can assert against it.
 */
export const FUZZY_MEMBER_SCAN_CAP = 5000;

/**
 * Factory — returns the adapter bound to a tenant-scoped Drizzle transaction
 * handle. Callers MUST pass the `tx` from `runInTenant` so the member/contact
 * SELECT runs under the tenant RLS context. There is deliberately NO root-`db`
 * default and NO pre-built singleton: defaulting to the BYPASSRLS pool `db`
 * would let a SELECT silently read across tenants (Gotchas — RLS bypass via the
 * pool-global `db`). Requiring an explicit `tx` makes that mistake a compile error.
 */
export function makeDrizzleAttendeeMatcher(
  executor: TenantTx,
): AttendeeMatcher {
  return {
    async match(
      input: MatchAttendeeInput,
    ): Promise<Result<MatchAttendeeOutput, AttendeeMatcherError>> {
      try {
        const emailLower = input.attendeeEmail.toLowerCase();
        const atIdx = emailLower.lastIndexOf('@');
        const domain = atIdx > 0 ? emailLower.slice(atIdx + 1) : '';

        // --- Rule 1: exact contact email match --------------------------
        const contactRows = await executor
          .select({
            contactId: contacts.contactId,
            memberId: contacts.memberId,
          })
          .from(contacts)
          .where(
            and(
              eq(contacts.tenantId, input.tenantId),
              sql`lower(${contacts.email}) = ${emailLower}`,
              // M5 — exclude soft-removed contacts. The partial
              // `contacts_tenant_email_uniq` index (WHERE removed_at IS NULL)
              // lets a removed contact coexist with an active one sharing the
              // same lower(email); without this filter a removed contact could
              // win and mis-link the attendee (+ mis-decrement quota).
              isNull(contacts.removedAt),
            ),
          )
          // M5 — deterministic winner. `.limit(2)`→`[0]` had no ORDER BY, so
          // the row picked among email-duplicates was engine-arbitrary. Order
          // by (created_at, contact_id) so Rule 1 is stable + reproducible.
          .orderBy(asc(contacts.createdAt), asc(contacts.contactId))
          .limit(2);

        if (contactRows.length >= 1) {
          const first = contactRows[0]!;
          return ok({
            resolution: {
              type: 'member_contact',
              matchedMemberId: first.memberId as MemberId,
              matchedContactId: first.contactId as ContactId,
            },
            fuzzyDetail: null,
            unmatchedCandidates: null,
          });
        }

        // --- Rule 2: domain match (skip if personal email) --------------
        if (domain.length > 0 && !isPersonalEmail(input.attendeeEmail)) {
          // R6-B6 staff-review fix (2026-05-13): escape LIKE wildcards
          // in the domain segment before composing the pattern. A
          // domain containing `_` or `%` (e.g., `company_name.com`)
          // would otherwise over-match unrelated contacts and silently
          // resolve as `member_domain` against the wrong member. The
          // `\` ESCAPE clause must be paired in the SQL fragment.
          // (Drizzle parameterises the value so no SQL injection
          // existed, but the semantic correctness is what this fix
          // restores.)
          const escapedDomain = domain.replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/%/g, '\\%');
          const domainSuffix = `%@${escapedDomain}`;
          const domainRows = await executor
            .selectDistinct({ memberId: contacts.memberId })
            .from(contacts)
            .where(
              and(
                eq(contacts.tenantId, input.tenantId),
                sql`lower(${contacts.email}) LIKE ${domainSuffix} ESCAPE '\\'`,
                // M5 — exclude soft-removed contacts. A removed contact at the
                // domain would otherwise either mis-link the attendee (sole
                // match) or inflate the distinct-member count and suppress a
                // legitimate single-member domain match (false negative).
                isNull(contacts.removedAt),
              ),
            )
            .limit(2);
          if (domainRows.length === 1) {
            return ok({
              resolution: {
                type: 'member_domain',
                matchedMemberId: domainRows[0]!.memberId as MemberId,
                matchedContactId: null,
              },
              fuzzyDetail: null,
              unmatchedCandidates: null,
            });
          }
        }

        // --- Rule 3: fuzzy company-name match ---------------------------
        if (input.attendeeCompany && input.attendeeCompany.trim().length > 0) {
          const attendeeNormalised = normaliseCompanyName(input.attendeeCompany);
          const threshold = input.fuzzyDistanceThreshold ?? DEFAULT_FUZZY_THRESHOLD;
          if (attendeeNormalised.length > 0) {
            const memberRowsRaw = await executor
              .select({
                memberId: members.memberId,
                companyName: members.companyName,
              })
              .from(members)
              // M6 — exclude archived + erased members from the fuzzy pool.
              // An archived member could otherwise win a fuzzy match (and
              // decrement quota) or tie with an active member and force a
              // false `unmatched`, depressing the match rate (SC-002). This
              // is IDENTITY resolution, not quota-eligibility, so INACTIVE
              // (non-archived) members are deliberately KEPT — excluding them
              // would wrongly flag real members as non_member. `erased_at`
              // exclusion aligns with every other member read (COMP-1) and is
              // cheap defence-in-depth (the `[erased]` sentinel is fuzzy-distant).
              .where(
                and(
                  eq(members.tenantId, input.tenantId),
                  isNull(members.archivedAt),
                  isNull(members.erasedAt),
                ),
              )
              .limit(FUZZY_MEMBER_SCAN_CAP + 1);

            const fuzzyScanTruncated =
              memberRowsRaw.length > FUZZY_MEMBER_SCAN_CAP;
            const memberRows = fuzzyScanTruncated
              ? memberRowsRaw.slice(0, FUZZY_MEMBER_SCAN_CAP)
              : memberRowsRaw;

            if (fuzzyScanTruncated) {
              // B10 — cap hit: scan exceeded the design envelope. The match
              // result MAY be incomplete (a better fuzzy winner could exist
              // beyond the cap). Surface it (no PII — tenantId + counts only)
              // so operators can prioritise the pg_trgm migration; do NOT
              // throw — the best-effort match continues on the capped set.
              logger.warn(
                {
                  event: 'f6_fuzzy_member_scan_cap_hit',
                  tenantId: input.tenantId,
                  cap: FUZZY_MEMBER_SCAN_CAP,
                  rowsScanned: memberRows.length,
                  truncated: true,
                },
                `[F6] attendee fuzzy match scanned ${FUZZY_MEMBER_SCAN_CAP}+ members (tenant exceeded design envelope) — result may be incomplete; land pg_trgm SQL-side fuzzy match`,
              );
            }

            const scored: ReadonlyArray<{ memberId: MemberId; companyName: string; distance: number }> =
              memberRows
                .map((m) => ({
                  memberId: m.memberId as MemberId,
                  companyName: m.companyName,
                  distance: levenshtein(
                    attendeeNormalised,
                    normaliseCompanyName(m.companyName),
                  ),
                }))
                .filter((row) => row.distance <= threshold)
                .sort((a, b) => a.distance - b.distance);

            if (scored.length === 1) {
              return ok({
                resolution: {
                  type: 'member_fuzzy',
                  matchedMemberId: scored[0]!.memberId,
                  matchedContactId: null,
                },
                fuzzyDetail: {
                  attendeeCompanyOriginal: input.attendeeCompany,
                  matchedMemberCompanyNormalised: normaliseCompanyName(scored[0]!.companyName),
                  levenshteinDistance: scored[0]!.distance,
                },
                unmatchedCandidates: null,
              });
            }

            if (scored.length >= 2 && scored[0]!.distance === scored[1]!.distance) {
              // Ambiguous fuzzy — tied winners → unmatched (admin must relink).
              const candidates = scored
                .filter((s) => s.distance === scored[0]!.distance)
                .map((s) => ({ memberId: s.memberId, levenshteinDistance: s.distance }));
              return ok({
                resolution: {
                  type: 'unmatched',
                  matchedMemberId: null,
                  matchedContactId: null,
                },
                fuzzyDetail: null,
                unmatchedCandidates: candidates,
              });
            }

            if (scored.length >= 1) {
              // Unique winner with no tie — already handled above; this
              // branch handles >1 results with DIFFERENT distances (the
              // unique-min path falls through to scored.length===1 above).
              return ok({
                resolution: {
                  type: 'member_fuzzy',
                  matchedMemberId: scored[0]!.memberId,
                  matchedContactId: null,
                },
                fuzzyDetail: {
                  attendeeCompanyOriginal: input.attendeeCompany,
                  matchedMemberCompanyNormalised: normaliseCompanyName(scored[0]!.companyName),
                  levenshteinDistance: scored[0]!.distance,
                },
                unmatchedCandidates: null,
              });
            }
          }
        }

        // --- Rule 4: non-member fallback --------------------------------
        return ok({
          resolution: {
            type: 'non_member',
            matchedMemberId: null,
            matchedContactId: null,
          },
          fuzzyDetail: null,
          unmatchedCandidates: null,
        });
      } catch (e) {
        return err(wrapRepoError('matcher', e));
      }
    },
  };
}
