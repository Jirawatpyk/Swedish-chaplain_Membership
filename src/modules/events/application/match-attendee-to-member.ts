/**
 * T045 — `matchAttendeeToMember` use-case (F6 Application).
 *
 * Thin wrapper around the `AttendeeMatcher` port. The 4-rule cascade
 * implementation lives in the adapter (`drizzle-attendee-matcher.ts`,
 * T046) so the Application layer can swap matcher strategies at test
 * time (e.g., a fast in-memory stub).
 *
 * Spec authority:
 *   - research.md R4 (4-rule cascade ordering + personal-email deny list)
 *   - FR-012 + FR-013 (non-member / unmatched invariant)
 *   - contracts/audit-port.md § 2 (match resolution audit events)
 *
 * Pure Application — no framework imports. The matcher port is INJECTED;
 * production composition binds the Drizzle adapter at the route layer.
 */
import type { Result } from '@/lib/result';
import type {
  AttendeeMatcher,
  MatchAttendeeInput,
  MatchAttendeeOutput,
  AttendeeMatcherError,
} from './ports/attendee-matcher';

export interface MatchAttendeeToMemberDeps {
  readonly matcher: AttendeeMatcher;
}

export async function matchAttendeeToMember(
  input: MatchAttendeeInput,
  deps: MatchAttendeeToMemberDeps,
): Promise<Result<MatchAttendeeOutput, AttendeeMatcherError>> {
  return deps.matcher.match(input);
}
