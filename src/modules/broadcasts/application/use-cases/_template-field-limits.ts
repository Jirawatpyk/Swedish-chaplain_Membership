/**
 * Phase 5 Round 1 R2.2 A3+A4 — Centralised template field limits.
 *
 * Used by Application use-cases (create + update broadcast template)
 * + Presentation Zod schemas (admin templates POST + PATCH). Single
 * source of truth — a future bump (e.g. MAX_BODY_BYTES → 500KB) only
 * touches this constant.
 *
 * Application-layer module: zero framework / ORM imports per
 * Constitution Principle III.
 */

/** Template `name` column max length per contract § 1.1 (CHECK constraint also at DB level in migration 0168). */
export const TEMPLATE_MAX_NAME_LENGTH = 100;

/** Template `subject` column max length — mirrors broadcast subject 200-char cap (DOMPurify post-sanitise count). */
export const TEMPLATE_MAX_SUBJECT_LENGTH = 200;

/** Template `body_html` column max size in bytes (200 KB) — same cap as broadcast body for symmetric storage budgeting. */
export const TEMPLATE_MAX_BODY_BYTES = 200 * 1024;
