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
 * with a fixed `mtime: ZIP_MTIME` (2020-01-01). fflate encodes the zip DOS
 * datetime word from a Date's LOCAL-time getters (getFullYear/getHours/…), NOT
 * UTC — so a fixed UTC instant would still emit different header bytes per
 * process TZ. ZIP_MTIME is therefore built from LOCAL date components
 * (`new Date(2020, 0, 1, …)`), which the local getters render identically in
 * every timezone → byte-identical container output (epoch 0 is rejected by
 * fflate as pre-1980). The manifest checksums are over the UNCOMPRESSED file
 * contents, so they are independent of the zip encoding entirely.
 * (code-review max F9 — finding #4)
 *
 * Infrastructure layer (Node `crypto` + `fflate`); bound by the GDPR archive
 * adapter. No cross-module deep imports (Principle III).
 */
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import type {
  GdprMemberData,
  GdprTruncatableCategory,
} from '../../application/ports/gdpr-archive-source';
import { buildGdprReadme } from './gdpr-readme';

/** Map a truncated category to its archive filename (for README + manifest). */
const TRUNCATED_FILE: Record<GdprTruncatableCategory, string> = {
  invoices: 'invoices.json',
  events: 'events.json',
  broadcasts: 'broadcasts.json',
  auditEvents: 'audit-events.json',
};

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
 * Fixed zip entry mtime so the container bytes are deterministic across
 * timezones. Built from LOCAL date components (NOT a `…Z` UTC instant): fflate
 * reads the DOS datetime via local-time getters, so `new Date(2020, 0, 1, …)`
 * — local midnight 2020-01-01 in whatever TZ the process runs — yields the
 * SAME datetime word everywhere (dev box, CI, Vercel sin1). 2020-01-01 sits
 * comfortably inside the zip range (1980-2099); `0` (epoch) is rejected as
 * pre-1980. (code-review max F9 — finding #4)
 */
const ZIP_MTIME = new Date(2020, 0, 1, 0, 0, 0);

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
  // Completeness disclosure (F9 #5): which category files hold only the most
  // recent N records (oldest dropped at the defensive cap). Empty ⇒ complete.
  const truncatedFiles = (data.completeness?.truncatedCategories ?? []).map(
    (c) => TRUNCATED_FILE[c],
  );

  // 1) Assemble every entry EXCEPT the manifest (which checksums the others).
  const entries: Record<string, Uint8Array> = {
    'README.txt': strToU8(
      buildGdprReadme(
        meta.requesterLocale,
        {
          tenantName: meta.tenantName,
          generatedAtIso: meta.generatedAtIso,
          memberId: data.subjectMemberId,
        },
        truncatedFiles,
      ),
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
    // Machine-readable completeness signal (F9 #5): `complete: false` + the
    // capped files tell a recipient (or an automated verifier) the archive is a
    // most-recent-N subset, not a full copy — the checksums authenticate only
    // the included records.
    completeness: { complete: truncatedFiles.length === 0, truncatedFiles },
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
