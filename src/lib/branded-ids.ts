/**
 * Branded ID types for cross-module port boundaries.
 *
 * Constitution v1.4.0 Principle I makes tenant isolation NON-NEGOTIABLE,
 * yet F8's cross-module ports historically accept all IDs as bare
 * `string` — making `findReminderAuditsForCycle(cycleId, tenantId)`
 * (swapped args) type-check. Branded types catch this class of bug at
 * compile time without runtime cost.
 *
 * **Scope policy** (Round 2 review-fix S-9):
 *   - **Cross-module port signatures** (F8 ↔ F4 / F5 / F6 / F2) MUST
 *     use the branded types. This is where arg-swap bugs hurt most:
 *     a swapped tenant_id on a cross-module call could leak data.
 *   - **F8-internal port signatures** (cycle repo, audit emitter,
 *     etc.) keep `string` for now — the cost of branding everywhere
 *     is large and the value lower. Domain internals always operate
 *     within a single tenant scope (set by `runInTenant`).
 *   - **Route handlers** wrap user-supplied strings with the smart
 *     constructors at the F8 entry boundary so the brand propagates
 *     into use-cases.
 *
 * The smart constructors do NOT validate at runtime — they're pure
 * type-level casts. Validation (e.g. UUID-shape check) happens at
 * the zod schema layer where the input first crosses into F8.
 *
 * Pure types — no framework imports (Constitution Principle III).
 */

// `unique symbol` brands prevent structural compatibility — `TenantId`
// and `CycleId` are NOT assignable to each other even though they're
// both `string & { readonly [unique-symbol]: true }`. Each brand gets
// its own private symbol.
declare const tenantIdBrand: unique symbol;
declare const memberIdBrand: unique symbol;
declare const cycleIdBrand: unique symbol;
declare const invoiceIdBrand: unique symbol;
declare const planIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: true };
export type MemberId = string & { readonly [memberIdBrand]: true };
export type CycleId = string & { readonly [cycleIdBrand]: true };
export type InvoiceId = string & { readonly [invoiceIdBrand]: true };
export type PlanId = string & { readonly [planIdBrand]: true };

/**
 * Smart constructors. Pure type-level casts — no runtime validation.
 * Use at the F8 entry boundary (route handler, integration test fixture,
 * use-case adapter wiring) to lift a validated `string` into the brand.
 */
export const asTenantId = (s: string): TenantId => s as TenantId;
export const asMemberId = (s: string): MemberId => s as MemberId;
export const asCycleId = (s: string): CycleId => s as CycleId;
export const asInvoiceId = (s: string): InvoiceId => s as InvoiceId;
export const asPlanId = (s: string): PlanId => s as PlanId;
