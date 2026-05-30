/**
 * F9 US6 (T090) — GDPR archive zip builder unit tests.
 *
 * The builder is deterministic: given the gathered member data it produces a
 * ZIP containing localised README + one JSON per category + invoice PDFs + a
 * locale-neutral manifest whose SHA-256 checksums validate (SC-008).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { buildGdprArchiveBytes } from '@/modules/insights/infrastructure/sources/gdpr-archive-zip';
import type { GdprMemberData } from '@/modules/insights/application/ports/gdpr-archive-source';

const MEMBER = '22222222-2222-2222-2222-222222222222';

const data: GdprMemberData = {
  subjectMemberId: MEMBER,
  profile: { memberId: MEMBER, companyName: 'Acme Co', country: 'TH' },
  contacts: [{ firstName: 'Som', lastName: 'Chai', email: 'som@acme.example' }],
  invoices: [
    {
      record: { number: 'INV-2026-0001', totalSatang: 107000, status: 'paid' },
      pdf: { filename: 'INV-2026-0001.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
    },
    { record: { number: 'INV-2026-0002', status: 'draft' }, pdf: null },
  ],
  events: [{ eventId: 'e1', eventType: 'cultural', attendedAt: '2026-03-01T00:00:00.000Z' }],
  broadcasts: [{ id: 'b1', status: 'sent' }],
  auditEvents: [
    { id: 'a1', eventType: 'member_self_update', occurredAt: '2026-05-01T10:00:00.000Z', summary: 'updated profile', payload: { member_id: MEMBER } },
  ],
};

const meta = { tenantName: 'SweCham', generatedAtIso: '2026-05-29T08:30:00.000Z', requesterLocale: 'en' };

describe('buildGdprArchiveBytes', () => {
  it('produces a zip with README + one JSON per category + the invoice PDF + manifest', () => {
    const { bytes, contentType } = buildGdprArchiveBytes(data, meta);
    expect(contentType).toBe('application/zip');
    const files = unzipSync(bytes);
    const names = Object.keys(files).sort();
    expect(names).toEqual(
      [
        'README.txt',
        'audit-events.json',
        'broadcasts.json',
        'contacts.json',
        'events.json',
        'invoices.json',
        'invoices/INV-2026-0001.pdf',
        'manifest.json',
        'profile.json',
      ].sort(),
    );
  });

  it('includes the member’s own data in profile.json', () => {
    const files = unzipSync(buildGdprArchiveBytes(data, meta).bytes);
    const profile = JSON.parse(strFromU8(files['profile.json']!));
    expect(profile.companyName).toBe('Acme Co');
  });

  it('renders the README in the requester locale (Thai)', () => {
    const files = unzipSync(buildGdprArchiveBytes(data, { ...meta, requesterLocale: 'th' }).bytes);
    const readme = strFromU8(files['README.txt']!);
    expect(readme).toContain('ข้อมูลส่วนบุคคลของคุณ'); // TH README title
    expect(readme).toContain(MEMBER);
  });

  it('renders the README in Swedish (FR-034 — SV is first-class)', () => {
    const files = unzipSync(buildGdprArchiveBytes(data, { ...meta, requesterLocale: 'sv' }).bytes);
    const readme = strFromU8(files['README.txt']!);
    expect(readme).toContain('Export av dina uppgifter'); // SV README title
    expect(readme).toContain(MEMBER);
  });

  it('falls back to EN for an unknown locale', () => {
    const files = unzipSync(buildGdprArchiveBytes(data, { ...meta, requesterLocale: 'de' }).bytes);
    expect(strFromU8(files['README.txt']!)).toContain('Your data export');
  });

  it('a complete archive (no truncation) marks the manifest complete and omits the README warning (F9 #5)', () => {
    const files = unzipSync(buildGdprArchiveBytes(data, meta).bytes);
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(manifest.completeness).toEqual({ complete: true, truncatedFiles: [] });
    expect(strFromU8(files['README.txt']!)).not.toContain('PARTIAL EXPORT');
  });

  it('discloses a capped export in BOTH the README and the manifest (F9 #5)', () => {
    const truncated: GdprMemberData = {
      ...data,
      completeness: { truncatedCategories: ['events', 'auditEvents'] },
    };
    const files = unzipSync(buildGdprArchiveBytes(truncated, meta).bytes);

    // Manifest: machine-readable partial-export signal over the capped files.
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(manifest.completeness.complete).toBe(false);
    expect(manifest.completeness.truncatedFiles).toEqual(['events.json', 'audit-events.json']);

    // README: human-readable warning naming the capped files (so the archive is
    // never presented as a complete copy when it is not — FR-037).
    const readme = strFromU8(files['README.txt']!);
    expect(readme).toContain('PARTIAL EXPORT');
    expect(readme).toContain('events.json, audit-events.json');
  });

  it('manifest checksums validate against each archived file (SC-008)', () => {
    const files = unzipSync(buildGdprArchiveBytes(data, meta).bytes);
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(manifest.schema).toBe('gdpr-export/v1');
    expect(Array.isArray(manifest.files)).toBe(true);
    // manifest.json never lists itself.
    expect(manifest.files.some((f: { path: string }) => f.path === 'manifest.json')).toBe(false);
    // Every other archive entry is listed with a validating checksum.
    for (const entry of manifest.files as Array<{ path: string; sha256: string; bytes: number }>) {
      const content = files[entry.path];
      expect(content, `missing ${entry.path}`).toBeDefined();
      const sha = createHash('sha256').update(content!).digest('hex');
      expect(sha, `checksum mismatch for ${entry.path}`).toBe(entry.sha256);
      expect(entry.bytes).toBe(content!.length);
    }
    // Manifest covers every non-manifest entry.
    const listed = new Set((manifest.files as Array<{ path: string }>).map((f) => f.path));
    const present = Object.keys(files).filter((n) => n !== 'manifest.json');
    expect([...listed].sort()).toEqual(present.sort());
  });

  it('manifest is locale-neutral (identical files set regardless of README locale)', () => {
    const en = unzipSync(buildGdprArchiveBytes(data, { ...meta, requesterLocale: 'en' }).bytes);
    const th = unzipSync(buildGdprArchiveBytes(data, { ...meta, requesterLocale: 'th' }).bytes);
    const mEn = JSON.parse(strFromU8(en['manifest.json']!));
    const mTh = JSON.parse(strFromU8(th['manifest.json']!));
    expect(mEn.subjectMemberId).toBe(mTh.subjectMemberId);
    expect((mEn.files as Array<{ path: string }>).map((f) => f.path).sort()).toEqual(
      (mTh.files as Array<{ path: string }>).map((f) => f.path).sort(),
    );
  });

  it('embeds the invoice PDF bytes under invoices/', () => {
    const files = unzipSync(buildGdprArchiveBytes(data, meta).bytes);
    expect(Array.from(files['invoices/INV-2026-0001.pdf']!)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });
});
