import type { getTranslations } from 'next-intl/server';

/**
 * Resolves a stored `legal_entity_type` value to a localised label.
 *
 * Extracted from the admin member-detail page (059 / PR-A Task 3b) so the
 * member-facing portal profile page can share the exact same resolution — a
 * member must see the same translated label an admin sees, never the raw
 * stored code (`legalEntityType: 'limited_company'` printed verbatim — the
 * bug this whole task exists to fix).
 *
 * Task 3b closes the member FORM to the 12-code `LEGAL_ENTITY_TYPES`
 * catalogue going forward, but does not backfill or constrain the DATABASE
 * column — a row saved through the old free-text `<Input>` before this fix
 * shipped may still carry an arbitrary string, a typo, mixed case, or stray
 * whitespace. This resolver's normalise-then-fall-back-to-raw behaviour
 * handles that gracefully: it normalises the stored value to a
 * `lower_snake_case` key and looks it up in `legalEntityTypes.*`; a miss
 * falls back to the raw stored value verbatim (a `t()` call on an unmapped
 * key logs a noisy MISSING_MESSAGE, so guard with `.has` first — same
 * pattern as `timeline-event-item.tsx`).
 *
 * Review fix (Task 3b review, Finding 1) — `legal_entity_type` is now ALSO
 * closed at the Application boundary (create/update-member zod schemas),
 * and `drizzle-member-repo.ts`'s `rowToMember` narrows an out-of-catalogue
 * DB value to `null` on every read. Both known call sites of this resolver
 * (admin member-detail page, portal profile page) pass the Domain
 * `Member.legalEntityType`, so the raw-string fallback below is currently
 * unreachable through them — a legacy out-of-catalogue row now resolves to
 * `null` (raw === null) upstream of this function, not to this fallback.
 * The fallback stays as defense-in-depth for any future caller that reads
 * the raw column directly (bypassing the repo narrowing).
 */
export function resolveLegalEntityTypeLabel(
  raw: string | null,
  tTypes: Awaited<
    ReturnType<typeof getTranslations<'admin.members.detail.legalEntityTypes'>>
  >,
): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const key = trimmed.toLowerCase().replace(/[\s-]+/g, '_');
  return tTypes.has(key as 'company') ? tTypes(key as 'company') : trimmed;
}
