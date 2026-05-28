/**
 * F9 US5 `DirectoryListing` domain (T077 / FR-024, FR-025, FR-028, SC-007).
 *
 * Pure, framework-free value object + policy for the member directory. Owns:
 *   - the **fixed** listing field set (`DIRECTORY_FIELDS`) — not per-tenant
 *     configurable in F9 (FR-025),
 *   - the visibility-validation helpers (DB-CHECK parity: website scheme +
 *     description cap from migration 0187),
 *   - the **publication projection** (`projectPublishedListing`) — the single
 *     source of truth for SC-007 zero-leakage: only `listed=true` members appear
 *     in published outputs (E-Book / JSON), only fields toggled visible are
 *     emitted, a present-but-hidden contact email is replaced with a contact-form
 *     indicator (FR-028), and a visible-but-empty field is omitted (no empty or
 *     NaN artefacts in the artefact).
 *
 * Default policy: a listing is **private** (`listed=false`) until the member
 * opts in, and the contact email is **default-hidden** (FR-025). Identity fields
 * (name, tier, contact name/email) are sourced **live** from members/contacts/
 * plans by the caller and passed in via `DirectoryIdentity` — this module never
 * stores or duplicates them.
 *
 * No imports — pure TypeScript (Constitution Principle III: Domain is
 * dependency-free).
 */

/** The fixed, individually toggle-able directory field set (FR-025). */
export const DIRECTORY_FIELDS = [
  'name',
  'tier',
  'industry',
  'description',
  'website',
  'logo',
  'location',
  'contact_name',
  'contact_email',
] as const;

export type DirectoryField = (typeof DIRECTORY_FIELDS)[number];

/** Per-field exposure map. An absent key means **not exposed** (default-deny). */
export type FieldVisibility = Partial<Record<DirectoryField, boolean>>;

/** Mirrors the `directory_listings_description_length_check` DB CHECK (0187). */
export const MAX_DIRECTORY_DESCRIPTION_LENGTH = 500;

/**
 * Starting toggles offered when a member first opts in: everything visible
 * except the contact email (FR-025 — email default-hidden). The stored map may
 * diverge as the member toggles fields; publication reads the stored map.
 */
export const DEFAULT_FIELD_VISIBILITY: Record<DirectoryField, boolean> = {
  name: true,
  tier: true,
  industry: true,
  description: true,
  website: true,
  logo: true,
  location: true,
  contact_name: true,
  contact_email: false,
};

const DIRECTORY_FIELD_SET: ReadonlySet<string> = new Set(DIRECTORY_FIELDS);

export function isDirectoryField(value: string): value is DirectoryField {
  return DIRECTORY_FIELD_SET.has(value);
}

/**
 * Coerce arbitrary input (e.g. a form payload or a JSONB column) into a clean
 * `FieldVisibility`: keep only known directory-field keys, coerce each value to
 * a boolean, and drop everything else (incl. prototype-pollution keys, which are
 * never in `DIRECTORY_FIELDS`). data-model § 3: `field_visibility` keys ⊆ fixed set.
 */
export function sanitizeFieldVisibility(input: unknown): FieldVisibility {
  if (input === null || typeof input !== 'object') return {};
  const out: FieldVisibility = {};
  for (const field of DIRECTORY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      out[field] = Boolean((input as Record<string, unknown>)[field]);
    }
  }
  return out;
}

/** A field is published only when explicitly toggled `true` (default-deny). */
export function isFieldVisible(
  visibility: FieldVisibility,
  field: DirectoryField,
): boolean {
  return visibility[field] === true;
}

/** Website scheme allow-list — http/https only (DB CHECK `^https?://`). */
export function isValidDirectoryWebsite(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function isDescriptionWithinCap(description: string): boolean {
  return description.length <= MAX_DIRECTORY_DESCRIPTION_LENGTH;
}

/** Live identity sourced from members / primary contact / plan by the caller. */
export interface DirectoryIdentity {
  readonly memberName: string;
  readonly tier: string | null;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
}

/** Directory-specific metadata stored on the listing row (logo pre-resolved to a URL). */
export interface DirectoryMetadata {
  readonly industry: string | null;
  readonly description: string | null;
  readonly website: string | null;
  readonly logoUrl: string | null;
  readonly locationCity: string | null;
  readonly locationCountry: string | null;
}

export interface DirectoryRecord {
  readonly listed: boolean;
  readonly fieldVisibility: FieldVisibility;
  readonly identity: DirectoryIdentity;
  readonly metadata: DirectoryMetadata;
}

export interface PublishedContact {
  readonly name?: string;
  readonly email?: string;
  /** Set when a contact exists but the email is hidden (FR-028 contact-form indicator). */
  readonly contactForm?: boolean;
}

export interface PublishedLocation {
  readonly city?: string;
  readonly country?: string;
}

export interface PublishedListing {
  readonly name?: string;
  readonly tier?: string;
  readonly industry?: string;
  readonly description?: string;
  readonly website?: string;
  readonly logoUrl?: string;
  readonly location?: PublishedLocation;
  readonly contact?: PublishedContact;
}

function projectContact(
  visibility: FieldVisibility,
  identity: DirectoryIdentity,
): PublishedContact | undefined {
  const showName =
    isFieldVisible(visibility, 'contact_name') && identity.contactName !== null;
  const showEmail =
    isFieldVisible(visibility, 'contact_email') && identity.contactEmail !== null;
  // The contact-form indicator stands in for a hidden email — but only when the
  // member is actually presenting their contact (name shown). A member who
  // exposes no contact field at all gets no contact object (FR-028: the form is
  // the *email's* replacement, not an always-on affordance). This keeps an
  // empty/opted-out visibility map truly empty (SC-007 default-deny).
  const emailHidden =
    !isFieldVisible(visibility, 'contact_email') && identity.contactEmail !== null;
  const showContactForm = showName && emailHidden;

  if (!showName && !showEmail && !showContactForm) return undefined;

  const contact: { name?: string; email?: string; contactForm?: true } = {};
  if (showName) contact.name = identity.contactName as string;
  if (showEmail) contact.email = identity.contactEmail as string;
  if (showContactForm) contact.contactForm = true;
  return contact;
}

function projectLocation(
  visibility: FieldVisibility,
  metadata: DirectoryMetadata,
): PublishedLocation | undefined {
  if (!isFieldVisible(visibility, 'location')) return undefined;
  if (metadata.locationCity === null && metadata.locationCountry === null) {
    return undefined;
  }
  const location: { city?: string; country?: string } = {};
  if (metadata.locationCity !== null) location.city = metadata.locationCity;
  if (metadata.locationCountry !== null) {
    location.country = metadata.locationCountry;
  }
  return location;
}

/**
 * The SC-007 zero-leakage projection. Returns `null` for an un-listed member
 * (excluded from every published output) or a `PublishedListing` containing
 * **only** the fields toggled visible whose underlying value is present.
 */
export function projectPublishedListing(
  record: DirectoryRecord,
): PublishedListing | null {
  if (!record.listed) return null;

  const { fieldVisibility: v, identity, metadata } = record;
  const out: {
    name?: string;
    tier?: string;
    industry?: string;
    description?: string;
    website?: string;
    logoUrl?: string;
    location?: PublishedLocation;
    contact?: PublishedContact;
  } = {};

  if (isFieldVisible(v, 'name') && identity.memberName) {
    out.name = identity.memberName;
  }
  if (isFieldVisible(v, 'tier') && identity.tier !== null) {
    out.tier = identity.tier;
  }
  if (isFieldVisible(v, 'industry') && metadata.industry !== null) {
    out.industry = metadata.industry;
  }
  if (isFieldVisible(v, 'description') && metadata.description !== null) {
    out.description = metadata.description;
  }
  if (isFieldVisible(v, 'website') && metadata.website !== null) {
    out.website = metadata.website;
  }
  if (isFieldVisible(v, 'logo') && metadata.logoUrl !== null) {
    out.logoUrl = metadata.logoUrl;
  }

  const location = projectLocation(v, metadata);
  if (location !== undefined) out.location = location;

  const contact = projectContact(v, identity);
  if (contact !== undefined) out.contact = contact;

  return out;
}
