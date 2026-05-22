/**
 * Template field length / size limits — single source of truth shared
 * between Application use-cases (create + update template) and
 * Presentation Zod schemas (admin templates POST + PATCH routes).
 *
 * Pure constants — zero framework imports (Constitution Principle III).
 */

/** Template `name` column max length per contract § 1.1 (CHECK constraint also at DB level in migration 0168). */
export const TEMPLATE_MAX_NAME_LENGTH = 100;

/** Template `subject` column max length — mirrors broadcast subject 200-char cap (DOMPurify post-sanitise count). */
export const TEMPLATE_MAX_SUBJECT_LENGTH = 200;

/** Template `body_html` column max size in bytes (200 KB) — same cap as broadcast body for symmetric storage budgeting. */
export const TEMPLATE_MAX_BODY_BYTES = 200 * 1024;
