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
 * with distance ≤ threshold (default 2 per research.md R4).
 *
 * Read-only adapter — never mutates F3 tables. RLS+FORCE on members +
 * contacts means the caller MUST run this inside `runInTenant(ctx, fn)`
 * for the SELECTs to return any rows.
 */
import { and, eq, sql } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import { db, type TenantTx } from '@/lib/db';
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
import type { MemberId, ContactId } from '@/modules/members';

const DEFAULT_FUZZY_THRESHOLD = 2;

/**
 * Factory — returns the adapter bound to a Drizzle executor (either the
 * root `db` for read-only probes OR a transaction handle when called
 * inside `runInTenant`). The route handler will pass `tx` so the SELECT
 * runs under the tenant-scoped RLS context.
 */
export function makeDrizzleAttendeeMatcher(
  executor: TenantTx | typeof db = db,
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
            ),
          )
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
          // Find distinct member_ids whose contacts have emails in the
          // attendee's domain.
          const domainSuffix = `%@${domain}`;
          const domainRows = await executor
            .selectDistinct({ memberId: contacts.memberId })
            .from(contacts)
            .where(
              and(
                eq(contacts.tenantId, input.tenantId),
                sql`lower(${contacts.email}) LIKE ${domainSuffix}`,
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
            const memberRows = await executor
              .select({
                memberId: members.memberId,
                companyName: members.companyName,
              })
              .from(members)
              .where(eq(members.tenantId, input.tenantId));

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

/**
 * Default singleton bound to root `db` — for use OUTSIDE a tx context.
 * Inside a runInTenant tx, callers should construct a tx-bound matcher
 * via `makeDrizzleAttendeeMatcher(tx)` so the RLS context is honoured.
 */
export const drizzleAttendeeMatcher: AttendeeMatcher = makeDrizzleAttendeeMatcher();
