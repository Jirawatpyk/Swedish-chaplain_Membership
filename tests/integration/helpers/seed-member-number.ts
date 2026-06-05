/**
 * 055-member-number — shared seed helper for raw `members` inserts.
 *
 * `members.member_number` is `NOT NULL` with a per-tenant UNIQUE index and has
 * NO database default — the canonical `createMember` path allocates it via the
 * advisory-lock-serialised `tenant_member_sequences` allocator (low 1..N per
 * tenant). Integration/seed fixtures that insert members DIRECTLY via Drizzle
 * (bypassing the allocator) must therefore supply the column themselves.
 *
 * `nextSeedMemberNumber()` returns a HIGH, process-monotonic positive integer
 * so a seeded value:
 *   - never collides with allocator output (which counts up from 1), even when
 *     a fixture and a real `createMember`/`commitMembers` write to the SAME
 *     throwaway tenant; and
 *   - never collides with another seeded value in the same tenant.
 *
 * Each integration test file uses its own throwaway tenant(s), so the
 * per-tenant UNIQUE index only constrains values WITHIN a file — a single
 * shared monotonic counter is more than sufficient and keeps the seed code
 * free of bespoke per-file counters.
 */

let seq = 900_000;

/** Next collision-free member number for a raw fixture insert. */
export function nextSeedMemberNumber(): number {
  seq += 1;
  return seq;
}
