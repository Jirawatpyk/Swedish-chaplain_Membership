/**
 * F9 US6 (T090 / FR-029 / SC-008) — deterministic GDPR archive zip builder.
 *
 * Serialises the gathered `GdprMemberData` into a single ZIP:
 *   - `README.txt`        — localised (requester locale, EN fallback).
 *   - `profile.json`, `contacts.json`, `invoices.json`, `events.json`,
 *     `broadcasts.json`, `audit-events.json` — the member's own data; the audit
 *     subset is already redacted (`buildMemberAuditSubset`).
 *   - `invoices/<file>.pdf` — the invoice PDF documents.
 *   - `manifest.json`     — locale-neutral (English keys) integrity manifest:
 *     a SHA-256 + byte count for every OTHER entry, so a recipient can verify
 *     the archive (SC-008). The manifest never lists itself (it cannot checksum
 *     its own bytes).
 *
 * Determinism: file contents are stable for given data; `zipSync` is invoked
 * with a fixed `mtime: ZIP_MTIME` (2020-01-01) so the container bytes don't vary
 * by wall-clock (epoch 0 is rejected by fflate as pre-1980). The manifest
 * checksums are over the UNCOMPRESSED file contents, so they are independent of
 * the zip encoding entirely.
 *
 * Infrastructure layer (Node `crypto` + `fflate`); bound by the GDPR archive
 * adapter. No cross-module deep imports (Principle III).
 */
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import type { GdprMemberData } from '../../application/ports/gdpr-archive-source';
import { buildGdprReadme } from './gdpr-readme';

export interface BuildGdprArchiveMeta {
  readonly tenantName: string;
  /** ISO-8601 UTC generation instant. */
  readonly generatedAtIso: string;
  /** Requester's locale for the README (EN fallback). */
  readonly requesterLocale: string;
}

export interface BuiltGdprArchive {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * Fixed zip entry mtime so the container bytes are deterministic (don't vary by
 * wall-clock). 2020-01-01 UTC — comfortably inside the zip-format range
 * (1980-2099); `0` (epoch) is rejected by fflate as pre-1980.
 */
const ZIP_MTIME = new Date('2020-01-01T00:00:00.000Z');

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value, null, 2));
}

interface ManifestFileEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export function buildGdprArchiveBytes(
  data: GdprMemberData,
  meta: BuildGdprArchiveMeta,
): BuiltGdprArchive {
  // 1) Assemble every entry EXCEPT the manifest (which checksums the others).
  const entries: Record<string, Uint8Array> = {
    'README.txt': strToU8(
      buildGdprReadme(meta.requesterLocale, {
        tenantName: meta.tenantName,
        generatedAtIso: meta.generatedAtIso,
        memberId: data.subjectMemberId,
      }),
    ),
    'profile.json': jsonBytes(data.profile),
    'contacts.json': jsonBytes(data.contacts),
    'invoices.json': jsonBytes(data.invoices.map((i) => i.record)),
    'events.json': jsonBytes(data.events),
    'broadcasts.json': jsonBytes(data.broadcasts),
    'audit-events.json': jsonBytes(data.auditEvents),
  };
  for (const invoice of data.invoices) {
    if (invoice.pdf !== null) {
      entries[`invoices/${invoice.pdf.filename}`] = invoice.pdf.bytes;
    }
  }

  // 2) Locale-neutral integrity manifest (English keys) over every entry above.
  const files: ManifestFileEntry[] = Object.keys(entries)
    .sort()
    .map((path) => {
      const content = entries[path]!;
      return {
        path,
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: content.length,
      };
    });
  const manifest = {
    schema: 'gdpr-export/v1',
    tenant: meta.tenantName,
    subjectMemberId: data.subjectMemberId,
    generatedAt: meta.generatedAtIso,
    files,
  };
  entries['manifest.json'] = jsonBytes(manifest);

  // 3) Zip (fflate default DEFLATE; mtime pinned for container determinism).
  const bytes = zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([path, content]) => [path, [content, { mtime: ZIP_MTIME }]]),
    ) as Record<string, [Uint8Array, { mtime: Date }]>,
    { mtime: ZIP_MTIME },
  );

  return { bytes, contentType: 'application/zip' };
}
