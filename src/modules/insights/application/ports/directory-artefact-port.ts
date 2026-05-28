/**
 * F9 US5 `DirectoryArtefactPort` (T080/T081).
 *
 * Renders the opt-in published directory into a downloadable artefact — a
 * deterministically-laid-out PDF E-Book (FR-026) or a structured JSON export
 * (FR-027). The caller (the export worker) has already applied the SC-007
 * publication projection (`projectPublishedListing`), so the builder only sees
 * already-redacted `PublishedListing`s — it cannot leak an opted-out member or a
 * hidden field.
 *
 * Pure interface — no react-pdf import (Constitution Principle III); the
 * Infrastructure adapter binds it.
 */
import type { PublishedListing } from '../../domain/directory-listing';

export interface DirectoryArtefactInput {
  /** Chamber name for branding (E-Book header / JSON envelope). */
  readonly tenantName: string;
  /** Tenant default display locale for E-Book field labels (FR-026). */
  readonly locale: string;
  /** ISO-8601 UTC generation timestamp (shown/embedded in the artefact). */
  readonly generatedAtIso: string;
  /** Already-projected, opt-in-only listings, ordered by company name. */
  readonly listings: readonly PublishedListing[];
}

export interface BuiltArtefact {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly extension: 'pdf' | 'json';
}

export interface DirectoryArtefactPort {
  buildEbookPdf(input: DirectoryArtefactInput): Promise<BuiltArtefact>;
  buildJson(input: DirectoryArtefactInput): Promise<BuiltArtefact>;
}
