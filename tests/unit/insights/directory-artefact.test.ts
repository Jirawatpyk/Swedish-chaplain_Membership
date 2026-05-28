/**
 * F9 US5 (T080/T081) — directory artefact builder unit tests.
 *
 * buildJson: structured envelope, opt-in-only (the caller passes already-
 * projected listings), chosen fields only, hidden email → contact-form (FR-027).
 * buildEbookPdf: produces a non-trivial, valid PDF (%PDF header) deterministically
 * (FR-026) — content fidelity is covered by the E2E.
 */
import { describe, expect, it } from 'vitest';
import { directoryArtefactAdapter } from '@/modules/insights/infrastructure/directory-artefact-adapter';
import type { PublishedListing } from '@/modules/insights';

const listings: PublishedListing[] = [
  {
    name: 'Acme Manufacturing',
    tier: 'Corporate Gold',
    industry: 'Manufacturing',
    description: 'We make widgets.',
    website: 'https://acme.example',
    location: { city: 'Bangkok', country: 'TH' },
    contact: { name: 'Somchai', contactForm: true }, // email hidden
  },
  { name: 'Beta Co', contact: { name: 'Bea', email: 'bea@beta.example' } },
];

const input = {
  tenantName: 'SweCham',
  locale: 'en',
  generatedAtIso: '2026-05-28T00:00:00.000Z',
  listings,
};

describe('directoryArtefactAdapter.buildJson (FR-027)', () => {
  it('produces a structured opt-in envelope with chosen fields only', async () => {
    const built = await directoryArtefactAdapter.buildJson(input);
    expect(built.contentType).toBe('application/json');
    expect(built.extension).toBe('json');
    const parsed = JSON.parse(new TextDecoder().decode(built.bytes));
    expect(parsed.tenant).toBe('SweCham');
    expect(parsed.count).toBe(2);
    expect(parsed.listings).toHaveLength(2);
    // Hidden email is omitted; contact-form indicator preserved (FR-028).
    expect(parsed.listings[0].contact).toEqual({ name: 'Somchai', contactForm: true });
    expect(parsed.listings[0].contact).not.toHaveProperty('email');
    // A visible-email listing keeps the email.
    expect(parsed.listings[1].contact).toEqual({ name: 'Bea', email: 'bea@beta.example' });
  });

  it('is deterministic for identical input', async () => {
    const a = await directoryArtefactAdapter.buildJson(input);
    const b = await directoryArtefactAdapter.buildJson(input);
    expect(new TextDecoder().decode(a.bytes)).toBe(new TextDecoder().decode(b.bytes));
  });
});

describe('directoryArtefactAdapter.buildEbookPdf (FR-026)', () => {
  it('produces a valid, non-trivial PDF', async () => {
    const built = await directoryArtefactAdapter.buildEbookPdf(input);
    expect(built.contentType).toBe('application/pdf');
    expect(built.extension).toBe('pdf');
    expect(built.bytes.length).toBeGreaterThan(1000);
    // PDF magic header "%PDF".
    expect(Array.from(built.bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
  }, 30_000);

  it('renders an empty directory without error', async () => {
    const built = await directoryArtefactAdapter.buildEbookPdf({ ...input, listings: [] });
    expect(built.bytes.length).toBeGreaterThan(500);
  }, 30_000);
});
