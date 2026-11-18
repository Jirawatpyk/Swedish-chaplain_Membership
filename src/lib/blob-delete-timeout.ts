/**
 * The bound on one Vercel Blob `del`, retries included: the SDK bails on the
 * abort instead of retrying. One value for every module (invoicing PDFs,
 * E-Blast images, the insights logo and export artefacts), because the
 * erasure reserve in `erasure-cascade-deadline.ts` counts on it (#710 review).
 */
export const BLOB_DELETE_TIMEOUT_MS = 10_000;
