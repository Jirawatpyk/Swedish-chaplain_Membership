/**
 * Members Backup Export — in-memory ZIP packer (design 2026-07-07).
 *
 * Binds the use-case's `ZipFilesPort` to fflate `zipSync` (existing dep,
 * same engine as the F9 GDPR archive — `gdpr-archive-zip.ts`). CSVs
 * compress well → level 6. No fixed mtime: unlike the GDPR archive there is
 * no byte-determinism requirement (SC-008) on this artefact — this is an
 * admin ad-hoc download, not a checksummed data-subject deliverable.
 */
import { strToU8, zipSync } from 'fflate';
import type { ZipFilesPort } from '../../application/use-cases/export-members-backup';

export const zipCsvFiles: ZipFilesPort = (files) => {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.name] = strToU8(f.content);
  return zipSync(entries, { level: 6 });
};
