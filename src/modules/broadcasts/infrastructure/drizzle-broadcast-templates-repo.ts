/**
 * Phase 5C (F7.1a US7) — Real Drizzle `BroadcastTemplatesPort` adapter
 * (replaces Phase 2 T028 skeleton).
 *
 * Tenant scoping: every read/write goes through `runInTenant(ctx, fn)`
 * — mirror of `drizzle-image-allowlist-repo` pattern. Per memory
 * `project_drizzle_repo_tx_pattern`: methods MUST use tx from
 * runInTenant, NEVER the global `db` (silent RLS bypass via pool-fresh
 * BYPASSRLS connection — F7.1a US2 2026-05-20 incident).
 *
 * Tx threading: when the caller provides a tx token (use-case ran
 * `port.withTx(...)` and is propagating it through `create`/`update`/
 * `softDelete`/`incrementStartedFromCount`), the same Drizzle tx is
 * reused so the mutation + the `audit.emit(tx, ...)` row land in ONE
 * transaction (Constitution Principle I clause 3 atomicity).
 *
 * Error mapping:
 *   - INSERT ON CONFLICT DO NOTHING returning empty → `duplicate_name`
 *   - UPDATE / DELETE returning 0 rows → `not_found`
 *   - Postgres 23505 unique-violation on UPDATE → `duplicate_name`
 *   - Any other exception → `storage_error` with detail
 *
 * Soft-delete: `softDelete()` sets `deleted_at = now()` and filters
 * `deleted_at IS NULL` (rows already soft-deleted return `not_found`).
 *
 * Not in barrel — Infrastructure adapter; composition root wires it
 * inline at Phase 5E (broadcasts-deps.ts).
 */
import { and, eq, isNull, desc, sql } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { err, ok, type Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import type {
  BroadcastTemplate,
  BroadcastTemplatesPort,
  BroadcastTemplatesTx,
  CreateTemplateInput,
  ListTemplatesOpts,
  TemplateCreateError,
  TemplateDeleteError,
  TemplateLocale,
  TemplateUpdateError,
  UpdateTemplateInput,
} from '../application/ports/broadcast-templates-port';
import {
  broadcastTemplates,
  type BroadcastTemplateRow,
} from './schema';

/**
 * Tx-thread helper — runs the callback either inside the caller's
 * provided tx OR inside a fresh `runInTenant` scope when tx is
 * null/undefined. Centralises the conditional so all 5 mutation methods
 * share one idiom (mirrors image-allowlist `withTenantTx`).
 */
async function withTenantTx<T>(
  tenantId: TenantSlug,
  tx: BroadcastTemplatesTx | null | undefined,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (tx) {
    return fn(tx as unknown as TenantTx);
  }
  return runInTenant(
    asTenantContext(tenantId as unknown as string),
    async (innerTx) => fn(innerTx),
  );
}

/** Domain row mapper. */
function toDomain(row: BroadcastTemplateRow): BroadcastTemplate {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantSlug,
    name: row.name,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    locale: row.locale as TemplateLocale,
    startedFromCount: row.startedFromCount,
    isSeeded: row.isSeeded,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** Surface PG error code (23505 = unique_violation) for caller mapping. */
function describeStorageError(e: unknown): string {
  const err_ = e as {
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const detail = err_?.cause?.message ?? err_?.message ?? 'unknown';
  const code = err_?.cause?.code ? ` [${err_.cause.code}]` : '';
  return `${detail}${code}`;
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
}

/**
 * Shared SELECT implementation for `findById`. The tx caller controls
 * the transaction boundary; `findById` wraps with `runInTenant` so the
 * RLS+FORCE policy is applied. WHERE clause: id + explicit tenantId
 * belt-and-braces + deletedAt IS NULL.
 *
 * R4.3 M-10 — the previous `findByIdInTx` tx-aware variant was removed.
 * It became dead code after R3.3 H-3 migrated the only caller
 * (`snapshotTemplateToDraft`) to `findByIdAllowDeletedInTx` to
 * distinguish soft-deleted from never-existed templates.
 */
async function findByIdImpl(
  tx: TenantTx,
  tenantId: TenantSlug,
  id: string,
): Promise<BroadcastTemplate | null> {
  const rows = await tx
    .select()
    .from(broadcastTemplates)
    .where(
      and(
        eq(broadcastTemplates.id, id),
        eq(broadcastTemplates.tenantId, tenantId as string),
        isNull(broadcastTemplates.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? toDomain(rows[0] as BroadcastTemplateRow) : null;
}

/**
 * R3-F11 (Phase 5 Round 1) — like findByIdImpl but WITHOUT the
 * `deletedAt IS NULL` predicate. The snapshot use-case needs to
 * distinguish soft-deleted from never-existed.
 */
async function findByIdAllowDeletedImpl(
  tx: TenantTx,
  tenantId: TenantSlug,
  id: string,
): Promise<BroadcastTemplate | null> {
  const rows = await tx
    .select()
    .from(broadcastTemplates)
    .where(
      and(
        eq(broadcastTemplates.id, id),
        eq(broadcastTemplates.tenantId, tenantId as string),
      ),
    )
    .limit(1);
  return rows[0] ? toDomain(rows[0] as BroadcastTemplateRow) : null;
}

export function makeDrizzleBroadcastTemplatesRepo(): BroadcastTemplatesPort {
  return {
    async withTx<T>(
      tenantId: TenantSlug,
      fn: (tx: BroadcastTemplatesTx) => Promise<T>,
    ): Promise<T> {
      return runInTenant(
        asTenantContext(tenantId as unknown as string),
        async (tx) => fn(tx as unknown as BroadcastTemplatesTx),
      );
    },

    async findById(
      tenantId: TenantSlug,
      id: string,
    ): Promise<BroadcastTemplate | null> {
      return runInTenant(
        asTenantContext(tenantId as unknown as string),
        async (tx) => findByIdImpl(tx as unknown as TenantTx, tenantId, id),
      );
    },

    async findByIdAllowDeletedInTx(
      tenantId: TenantSlug,
      id: string,
      tx: BroadcastTemplatesTx,
    ): Promise<BroadcastTemplate | null> {
      // R3-F11 — does NOT filter deletedAt IS NULL. Caller (snapshot
      // use-case) branches on `template.deletedAt !== null` to emit
      // template_soft_deleted vs cross-tenant probe audit.
      return findByIdAllowDeletedImpl(tx as unknown as TenantTx, tenantId, id);
    },

    async findByTenantId(
      tenantId: TenantSlug,
      opts?: ListTemplatesOpts,
    ): Promise<readonly BroadcastTemplate[]> {
      return runInTenant(
        asTenantContext(tenantId as unknown as string),
        async (tx) => {
          // Filter chain: tenant scope (RLS enforces, explicit also for
          // index hit) + soft-delete unless includeDeleted + optional
          // locale (cascading-locale picker at Phase 5D T103).
          const conditions = [
            eq(broadcastTemplates.tenantId, tenantId as string),
          ];
          if (!opts?.includeDeleted) {
            conditions.push(isNull(broadcastTemplates.deletedAt));
          }
          if (opts?.locale) {
            conditions.push(eq(broadcastTemplates.locale, opts.locale));
          }
          const rows = await tx
            .select()
            .from(broadcastTemplates)
            .where(and(...conditions))
            .orderBy(desc(broadcastTemplates.updatedAt));
          return rows.map((r) => toDomain(r as BroadcastTemplateRow));
        },
      );
    },

    async create(
      tenantId: TenantSlug,
      input: CreateTemplateInput,
      callerTx?: BroadcastTemplatesTx,
    ): Promise<Result<BroadcastTemplate, TemplateCreateError>> {
      try {
        return await withTenantTx(tenantId, callerTx, async (tx) => {
          const inserted = await tx
            .insert(broadcastTemplates)
            .values({
              tenantId: tenantId as string,
              name: input.name,
              subject: input.subject,
              bodyHtml: input.bodyHtml,
              locale: input.locale,
              isSeeded: false,
              createdByUserId: input.createdByUserId,
            })
            .onConflictDoNothing({
              target: [
                broadcastTemplates.tenantId,
                broadcastTemplates.name,
                broadcastTemplates.locale,
              ],
            })
            .returning();
          if (inserted.length === 0) {
            return err<TemplateCreateError>({
              kind: 'duplicate_name',
              locale: input.locale,
            });
          }
          return ok(toDomain(inserted[0] as BroadcastTemplateRow));
        });
      } catch (e) {
        return err({ kind: 'storage_error', detail: describeStorageError(e) });
      }
    },

    async update(
      tenantId: TenantSlug,
      id: string,
      input: UpdateTemplateInput,
      callerTx?: BroadcastTemplatesTx,
    ): Promise<Result<BroadcastTemplate, TemplateUpdateError>> {
      try {
        return await withTenantTx(tenantId, callerTx, async (tx) => {
          const setClause: Partial<{
            name: string;
            subject: string;
            bodyHtml: string;
            locale: TemplateLocale;
            updatedAt: Date;
          }> = { updatedAt: new Date() };
          if (input.name !== undefined) setClause.name = input.name;
          if (input.subject !== undefined) setClause.subject = input.subject;
          if (input.bodyHtml !== undefined) setClause.bodyHtml = input.bodyHtml;
          if (input.locale !== undefined) setClause.locale = input.locale;

          // R1.2 H-code-5: explicit tenantId predicate alongside RLS.
          const updated = await tx
            .update(broadcastTemplates)
            .set(setClause)
            .where(
              and(
                eq(broadcastTemplates.id, id),
                eq(broadcastTemplates.tenantId, tenantId as string),
                isNull(broadcastTemplates.deletedAt),
              ),
            )
            .returning();
          if (updated.length === 0) {
            return err<TemplateUpdateError>({ kind: 'not_found' });
          }
          return ok(toDomain(updated[0] as BroadcastTemplateRow));
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          return err({
            kind: 'duplicate_name',
            locale: input.locale ?? 'en',
          });
        }
        return err({ kind: 'storage_error', detail: describeStorageError(e) });
      }
    },

    async softDelete(
      tenantId: TenantSlug,
      id: string,
      callerTx?: BroadcastTemplatesTx,
    ): Promise<Result<void, TemplateDeleteError>> {
      try {
        return await withTenantTx(tenantId, callerTx, async (tx) => {
          // R1.2 H-code-5: explicit tenantId predicate alongside RLS.
          const deleted = await tx
            .update(broadcastTemplates)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(broadcastTemplates.id, id),
                eq(broadcastTemplates.tenantId, tenantId as string),
                isNull(broadcastTemplates.deletedAt),
              ),
            )
            .returning({ id: broadcastTemplates.id });
          if (deleted.length === 0) {
            return err<TemplateDeleteError>({ kind: 'not_found' });
          }
          return ok(undefined);
        });
      } catch (e) {
        return err({ kind: 'storage_error', detail: describeStorageError(e) });
      }
    },

    async incrementStartedFromCount(
      tenantId: TenantSlug,
      id: string,
      callerTx?: BroadcastTemplatesTx,
    ): Promise<void> {
      // Atomic at row level — `started_from_count = started_from_count + 1`
      // via the SQL expression. R1.2 H-sf-1: filter `deletedAt IS NULL`
      // + RETURNING + throw on 0 rows so a TOCTOU soft-delete race
      // (admin deletes template while member is snapshotting) rolls
      // back the snapshot's withTx instead of silently completing
      // against a soft-deleted row. R1.2 H-code-5: explicit tenantId.
      await withTenantTx(tenantId, callerTx, async (tx) => {
        const updated = await tx
          .update(broadcastTemplates)
          .set({
            startedFromCount: sql`${broadcastTemplates.startedFromCount} + 1`,
          })
          .where(
            and(
              eq(broadcastTemplates.id, id),
              eq(broadcastTemplates.tenantId, tenantId as string),
              isNull(broadcastTemplates.deletedAt),
            ),
          )
          .returning({ id: broadcastTemplates.id });
        if (updated.length === 0) {
          throw new Error(
            `incrementStartedFromCount: template ${id} missing or soft-deleted (tenant ${String(tenantId)})`,
          );
        }
      });
    },
  };
}
