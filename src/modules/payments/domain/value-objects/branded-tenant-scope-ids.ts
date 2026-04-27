/**
 * R2 TD-2 (2026-04-27) — Branded id helpers for tenant-scope identifiers.
 *
 * The F5 module surfaces 4 string-typed identifiers that today flow as
 * raw `string` through every use-case + port + repo signature:
 *
 *   - `tenantId`   — Postgres tenant slug (kebab-case, e.g. 'swecham')
 *   - `invoiceId`  — UUID FK to F4's `invoices.id`
 *   - `memberId`   — UUID FK to F3's `members.id`
 *   - `actorUserId` / `userId` — UUID FK to F1's `users.id`
 *
 * Positional argument-order swaps (e.g.
 * `findPendingByInvoiceAndActor(tenantId, invoiceId, actorUserId, …)`)
 * type-check today because all four are `string`. Branding catches the
 * swap at compile time.
 *
 * Migration policy (NON-BREAKING — opt-in):
 *   1. This file ships the brands + cast helpers.
 *   2. Existing call sites stay on raw `string` for now (changing
 *      40+ signatures in one batch is high regression risk).
 *   3. New code + targeted hardening passes can use the branded types
 *      via `asTenantId(slug)` / `asInvoiceId(uuid)` / etc.
 *   4. Full migration tracked as F5.1 cleanup task — touch one
 *      use-case-port-repo trio per PR so each migration is atomic
 *      and testable.
 *
 * For UUID validation at boundaries (route handlers), pair `asXxxId`
 * with a `parseUuid()` helper from `@/lib/uuid` (or the F4 `asInvoiceId`
 * if that module exposes a strict parser).
 */

declare const TenantIdBrand: unique symbol;
declare const InvoiceIdBrand: unique symbol;
declare const MemberIdBrand: unique symbol;
declare const UserIdBrand: unique symbol;

export type TenantId = string & { readonly [TenantIdBrand]: true };
export type InvoiceId = string & { readonly [InvoiceIdBrand]: true };
export type MemberId = string & { readonly [MemberIdBrand]: true };
export type UserId = string & { readonly [UserIdBrand]: true };

/** Unchecked brand cast — use in TRUSTED contexts (DB row → Domain). */
export const asTenantId = (raw: string): TenantId => raw as TenantId;
export const asInvoiceId = (raw: string): InvoiceId => raw as InvoiceId;
export const asMemberId = (raw: string): MemberId => raw as MemberId;
export const asUserId = (raw: string): UserId => raw as UserId;
