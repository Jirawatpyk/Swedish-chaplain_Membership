/**
 * Stage-3 importer — TSCC `Member Type` column → LegalEntityTypeCode.
 *
 * Fail-loud on any unmapped value (mirrors `countryNameToCode` in coerce.ts): a
 * silent NULL is how the §86/4 branch line came to be missing from every invoice.
 * blank / "N/A" → ok(null) (the 10 TSCC rows whose legal form is unrecorded).
 *
 * IMPORTANT: this must only ever see the `Member Type` column. `Individual` ALSO
 * appears in the `Plan` column with an unrelated meaning — feeding the Plan
 * column here mis-assigns the entity type. Pure + framework-free (spec § 8).
 */
import { err, ok, type Result } from '@/lib/result';
// Deep import (NOT the `@/modules/members` barrel): the barrel transitively
// pulls members→renewals→invoicing→payments, whose infrastructure imports
// `server-only` (a Next-vendored marker absent from node_modules) and dies
// under plain tsx — which broke every `pnpm tsx scripts/import-*.ts` run.
// Scripts follow the established deep-import convention (066 lesson; see
// backfill-cycle-anchors.ts).
import {
  isLegalEntityTypeCode,
  type LegalEntityTypeCode,
} from '@/modules/members/domain/value-objects/legal-entity-type';

export type EntityTypeResolveError = {
  readonly code: 'entityType.unmapped';
  readonly raw: string;
};

/** Excel display name (normalized) → canonical code. Only the values that appear
 *  in the real sheet plus a few obvious variants. */
const DISPLAY_NAME_TO_CODE: Readonly<Record<string, LegalEntityTypeCode>> = {
  'private limited company (company limited)': 'limited_company',
  'private limited company': 'limited_company',
  'company limited': 'limited_company',
  'limited company': 'limited_company',
  'public limited company': 'public_company',
  'public company limited': 'public_company',
  'state enterprise': 'state_enterprise',
  individual: 'individual',
  foundation: 'foundation',
  association: 'association',
};

/** Blank-equivalent cells → ok(null) (legal_entity_type stays NULL). */
const BLANK_ALIASES: ReadonlySet<string> = new Set(['', 'n/a', 'na', '-', 'none']);

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function coerceLegalEntityType(
  raw: string,
): Result<LegalEntityTypeCode | null, EntityTypeResolveError> {
  const norm = normalize(raw);
  if (BLANK_ALIASES.has(norm)) return ok(null);
  // 1. Already a canonical code? ("limited_company")
  if (isLegalEntityTypeCode(norm)) return ok(norm);
  // 2. A known display name?
  const byName = DISPLAY_NAME_TO_CODE[norm];
  if (byName) return ok(byName);
  return err({ code: 'entityType.unmapped', raw });
}
