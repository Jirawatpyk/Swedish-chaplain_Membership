# Stage-3 importer survey — reuse map

78 findings · 48 gaps

## GAPS (must build new)
- Excel parser library (pnpm add -D exceljs or xlsx) — not yet in package.json per spec § 7
- Country name → ISO 3166-1 alpha-2 mapping (spec mentions i18n-iso-countries library, not yet verified in package.json)
- Phone normalization to E.164 format (spec § 2 mentions F3 phone rule module — need to locate and reuse)
- Thai tax ID 13-digit checksum validator (spec mentions policies/thai-tax-id-checksum.ts — exists per domain/policies listing but need exact signature)
- RFC email validator (spec mentions email-validator library — verify it's in package.json or add)
- Plan seeding for tenant + plan_year lookup (spec § 4 requires pre-seeded plans; scripts/seed-swecham-2026-plans.ts generates these but importer must load them into a tier-name → plan_id map)
- TenantContext construction from tenant slug (asTenantContext helper exists but importer must know how to resolve the live tenant slug at CLI invocation time)
- Bootstrap admin lookup for audit_log actor_user_id (spec: pre-req order at go-live-readiness § 6b — operator must confirm admin exists or provide BOOTSTRAP_ADMIN_EMAIL)
- Report file formatting + timestamping (spec § 2: 'timestamped report file (no PII in logs — counts + row indices only)' — importer must write JSON/CSV to disk with row-by-row outcomes)
- Exact tier-name to plan_id mapping transformation rules (Excel column label -> 9 canonical IDs) depend on real Excel confirmation at build time. Spec section 4 notes Excel tier names historically differ from PDF; importer must validate tier-name transform before dry-run.
- Tenant context construction at CLI entry point - import spec mentions ctx pre-created but doesn't show asTenantContext(slug) call site or how tenant_slug flows from operator CLI.
- F3 member creation use-case port signature - importer resolves plan_id from tier map but must pass it to member insert (F3 scope). Exact createMember(member_draft_with_resolved_plan_id) signature is out of scope but the plan_id resolution part lives here.
- Exact shape/signature of contacts schema (required + nullable columns, data types)
- Exact shape/signature of members schema (required + nullable columns, data types)
- Valid eventType enum values for auditLog (beyond 'member_created' + 'contact_created')
- Plan resolution + lookup helper function (how to build tier-name -> plan_id map from seeded plans)
- Phone normalization rule module (reuse F3 phone rule per spec § 2)
- E.164 phone formatter / validator library + import path
- Email validator library + import path (spec mentions 'email-validator')
- Country code ISO mapping library + import path (spec mentions 'i18n-iso-countries')
- Thai TIN (tax ID) 13-digit checksum validator + import path
- Excel parser library + import path (spec § 7 lists 'exceljs' or 'xlsx' as candidates)
- Buddhist Era date-year detection + 543-year offset check utility
- Membership plans seeded data shape (planId, planYear, memberTypeScope, etc.) from seed-swecham-2026-plans output
- contacts.isPrimary constraint (exactly one true per member per spec FR-003)
- Soft-delete pattern for contacts (removed_at IS NULL filtering)
- Buddhist-Era (BE) year-to-Gregorian offset validator — NOT FOUND in codebase. Must build: guard that rejects registration_date/founded_year > 2400 (year 2400 Gregorian = year 2943 BE; any year > 2400 is likely a data-entry error from spreadsheet showing BE year minus 543). Build a simple function: `function isValidGregorianYear(year: number): boolean { return year >= 1900 && year <= 2400; }`
- Country-name to alpha-2 reverse mapping helper — NOT FOUND as a reusable importer utility. The i18n-iso-countries.getAlpha2Code(name, locale) is available but must be wrapped for error handling. Build: `function countryNameToCode(excelCountryName: string): Result<IsoCountryCode, {code: 'country.name_not_found'}>` that tries getAlpha2Code then validates via asIsoCountryCode.
- Excel parser (exceljs or xlsx) — MUST ADD TO package.json. Spec says pnpm add -D exceljs (or xlsx). Currently in dependencies: neither package is present.
- Plan tier-name to plan_id mapper — Seeded plans exist (scripts/seed-swecham-2026-plans.ts output) but importer needs a runtime map builder. Build: fetch seeded plans for tenant + plan_year, index by normalized tier name (e.g. 'Premium Corporate' → plan_id), fail if tier is unmapped.
- Deduplication + soft-delete check for contacts — The spec says: skip existing active contacts (email dedupe key) but reactivate or skip soft-deleted ones (spec § 5 asks operator to decide). Build: query contacts WHERE tenant_id=ctx AND lower(email)=lower(input) AND removed_at IS NULL before insert; if found active, skip-with-warning; if soft-deleted, ask operator via report (importer is one-time, not interactive).
- Excel parser library not yet added to package.json (per spec 7: need exceljs or xlsx for streaming parse)
- Plan year lookup module (to map tier names to plan IDs for import year) - referenced in spec 4 but implementation TBD
- Member creation repo method (drizzleMemberRepo.createWithPrimaryContactInTx) implementation details - signature only, no full code shown
- Contact dedup logic for soft-deleted entries (spec 5 says operator must decide: reactivate or skip) - decision flow not yet implemented
- Phone normalization module (spec 3 references F3 phone rule module for E.164 normalization) - location and import path TBD
- Tax ID validation for Thai TINs (13-digit checksum logic per spec 3.8 + S1-P1-16) - function signature and location TBD
- Country name to ISO alpha-2 mapping (spec 2 references i18n-iso-countries library) - import path and wrapper pattern TBD
- Registration date BE-year guard (spec 3.5: reject year > 2400) - validation function location TBD
- Report generation + timestamped file output (spec 7: 'timestamped report file (no PII in logs)') - output format and path TBD
- exceljs or xlsx parser (neither in package.json—add as devDep before build starts)
- Excel workbook parsing logic (spec §7 says add exceljs; analyze_excel.py shows openpyxl pattern as reference)
- Tier name normalization function (map 'Platinum' → 'platinum', 'Start-up' → 'start-up' per membership-benefits-analysis.md, lines 251-260; case-insensitive, handle whitespace)
- Date parsing with Buddhist Era guard (spec §3 rule 5: reject year > 2400 as likely BE; parser must convert Gregorian only)
- Per-row validation report accumulator (collect errors per row, halt dry-run on first batch error, emit summary counts)
- Idempotency handler for soft-deleted contacts (spec §5: dedupe by lower(email) WHERE removed_at IS NULL; decide: skip-with-warning or reactivate—spec says 'operator call')
- Registration fee tracking (new member → registrationFeePaid = true on --commit; renewal skips fee)
- Rollback logic for mid-batch failures (spec §5 mandates whole tx rollback on any insert failure; no partial saves)

## Findings (reuse map)
### F3 member+primary contact atomic creation
- src/modules/members/application/ports/member-repo.ts:200-209
- shape: createWithPrimaryContactInTx(tx: TenantTx, draft: { readonly member: Omit<Member, 'createdAt' | 'updatedAt'>; readonly primaryContact: Omit<Contact, 'createdAt' | 'updatedAt' | 'memberId'>; }): Promise<Result<{ member: Member; contact: Contact }, RepoError>>;
- reuse: Call via drizzleMemberRepo.createWithPrimaryContactInTx(tx, draft) inside runInTenant(ctx, async (tx) => { ... }). Pass draft with member fields (tenantId, memberId, companyName, country, taxId, planId, planYear, registrationDate as Date, registrationFeePaid, notes, status, archivedAt, optional: legalEntityType/website/description/foundedYear/turnoverThb/city/province/postalCode/addressLine1/addressLine2/preferredLocale) and primaryContact fields (tenantId, contactId, firstName, lastName, email, phone, roleTitle, preferredLanguage, isPrimary: boolean, optional: dateOfBirth as Date, linkedUserId). memberId on primaryContact is auto-populated from the inserted member row. Returns Ok({ member: Member, contact: Contact }) on success or Err(RepoError) on duplicate/FK violation.

### Secondary contact insertion
- src/modules/members/application/ports/contact-repo.ts:63-66
- shape: addInTx(tx: TenantTx, draft: Omit<Contact, 'createdAt' | 'updatedAt'>): Promise<Result<Contact, RepoError>>;
- reuse: Call via drizzleContactRepo.addInTx(tx, draft) inside the same runInTenant transaction after createWithPrimaryContactInTx. Pass draft with contact fields (tenantId, contactId, memberId, firstName, lastName, email, phone, roleTitle, preferredLanguage, isPrimary: boolean, optional: dateOfBirth as Date, linkedUserId). Must NOT set isPrimary=true when a primary already exists (partial unique index enforces it). Returns Ok(Contact) with DB-generated createdAt/updatedAt or Err(RepoError) on email/primary conflict.

### Member domain type shapes
- src/modules/members/domain/member.ts:140-170
- shape: type Member = { readonly tenantId: TenantId; readonly memberId: MemberId; readonly companyName: string; readonly legalEntityType: string | null; readonly country: IsoCountryCode; readonly taxId: TaxId | null; readonly website: string | null; readonly description: string | null; readonly foundedYear: number | null; readonly turnoverThb: number | null; readonly planId: PlanId; readonly planYear: number; readonly registrationDate: Date; readonly registrationFeePaid: boolean; readonly notes: string | null; readonly city: string | null; readonly province: string | null; readonly postalCode: string | null; readonly addressLine1: string | null; readonly addressLine2: string | null; readonly preferredLocale: string | null; readonly status: MemberStatus; readonly createdAt: Date; readonly updatedAt: Date; } & MemberLifecycle;
- reuse: Use Omit<Member, 'createdAt'|'updatedAt'> for the draft parameter to createWithPrimaryContactInTx. Construct memberId via randomUUID() then cast with asMemberId() from member.ts. Cast tenantId with asTenantId(ctx.slug). Cast planId with asPlanId(planIdFromResolution). Country must be IsoCountryCode (ISO 3166-1 alpha-2 string brand). TaxId is a branded string or null. registrationDate must be a Date object. memberLifecycle() fn (line 119) derives status+archivedAt coupling from those fields.

### Contact domain type shapes
- src/modules/members/domain/contact.ts:83-106
- shape: type Contact = { readonly tenantId: TenantId; readonly contactId: ContactId; readonly memberId: MemberId; readonly firstName: string; readonly lastName: string; readonly email: Email; readonly phone: Phone | null; readonly roleTitle: string | null; readonly preferredLanguage: PreferredLanguage; readonly dateOfBirth: Date | null; readonly linkedUserId: UserId | null; readonly inviteBouncedAt: Date | null; readonly createdAt: Date; readonly updatedAt: Date; } & ContactPrimacy;
- reuse: Use Omit<Contact, 'createdAt'|'updatedAt'> for draft (same for secondary addInTx). Construct contactId via randomUUID() then cast with asContactId(). Cast email to Email type (string brand). phone is Phone | null (string brand). preferredLanguage must be 'en'|'th'|'sv' (PreferredLanguage union). isPrimary boolean + removedAt null/Date are managed by contactPrimacy() fn (line 67). dateOfBirth optional Date or null. linkedUserId optional string (F1 user id) or null.

### Tenant-scoped transaction execution
- src/lib/db.ts:239-264
- shape: export async function runInTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>
- reuse: Call runInTenant(ctx, async (tx) => { ... }) to open a tenant-scoped transaction. Automatically executes SET LOCAL ROLE chamber_app + SET LOCAL app.current_tenant = ctx.slug. Pass ctx from asTenantContext(tenantSlug). All member/contact repo methods *InTx variants use the tx param. The transaction wraps all member+contact+audit inserts atomically so mid-batch failure rolls back the whole batch.

### Audit event recording (F3)
- src/modules/members/application/ports/audit-port.ts:97-109
- shape: interface AuditPort { record(ctx: TenantContext, event: F3AuditEvent): Promise<Result<undefined, RepoError>>; recordInTx(tx: TenantTx, ctx: TenantContext, event: F3AuditEvent): Promise<Result<undefined, RepoError>>; }
- reuse: Call audit.recordInTx(tx, ctx, event) inside the same runInTenant tx for atomic persist. F3AuditEvent shape: { type: 'member_created'|'contact_created'|..., actorUserId: string, requestId: string, summary: string, payload: Record<string, unknown> }. Emit 'member_created' after member INSERT (payload key 'member_id' bumps lastActivityAt via trigger) and 'contact_created' after contact INSERT (payload key 'member_id' also bumps lastActivityAt). All writes in one tx via runInTenant guarantee consistent audit trail.

### Required domain type constructors
- src/modules/members/domain/member.ts:49-94
- shape: asMemberId(raw: string): MemberId; asTenantId(raw: string): TenantId; asPlanId(raw: string): PlanId; tryMemberId(raw: unknown): Result<MemberId, { code: 'invalid_member_id' }>; tryPlanId(raw: unknown): Result<PlanId, { code: 'invalid_plan_id' }>;
- reuse: For trusted boundaries (e.g. randomUUID() output): use asMemberId(uuid), asTenantId(ctx.slug), asPlanId(planIdFromPlanLookup). For untrusted input from Excel import: use tryMemberId/tryPlanId to validate UUID format and return Result. Import these from @/modules/members/domain/member.

### Drizzle repo implementations
- src/modules/members/infrastructure/db/drizzle-member-repo.ts:374-442
- shape: export const drizzleMemberRepo: MemberRepo = { ..., createWithPrimaryContactInTx(tx, draft) { ... }, ... }; // also exports rowToMember, rowToContact
- reuse: The importer uses drizzleMemberRepo.createWithPrimaryContactInTx(tx, draft) + drizzleContactRepo.addInTx(tx, draft) as the write path. Repo is singleton export. Inside the repo methods: (1) INSERT members table with Drizzle, (2) INSERT contacts table with Drizzle, (3) both call rowToMember/rowToContact to translate DB rows back to domain types. mapDbError() fn (line 440) maps DB errors (FK, unique violation) to RepoError codes.

### Schema: members table columns
- src/modules/members/infrastructure/db/schema-members.ts:42-150
- shape: pgTable('members', { tenantId, memberId, companyName, legalEntityType, country, taxId, website, description, foundedYear, turnoverThb, planId, planYear, registrationDate, registrationFeePaid, lastActivityAt, notes, city, province, postalCode, addressLine1, addressLine2, status, archivedAt, preferredLocale, broadcastsHaltedUntilAdminReview, ... })
- reuse: Required columns for insert: tenantId (text, NOT NULL), memberId (uuid, NOT NULL), companyName (text, NOT NULL), country (char[2], NOT NULL, ISO 3166-1), planId (text, NOT NULL), planYear (int, NOT NULL), registrationDate (date, NOT NULL). Optional: legalEntityType, taxId, website, description, foundedYear, turnoverThb, notes, city, province, postalCode, addressLine1, addressLine2, preferredLocale. DO NOT set createdAt/updatedAt (DB DEFAULT NOW()). status defaults to 'active'. registrationDate is stored as DATE (YYYY-MM-DD string in Drizzle).

### Schema: contacts table columns
- src/modules/members/infrastructure/db/schema-contacts.ts:37-90
- shape: pgTable('contacts', { tenantId, contactId, memberId, firstName, lastName, email, phone, roleTitle, preferredLanguage, isPrimary, dateOfBirth, linkedUserId, removedAt, inviteBouncedAt, createdAt, updatedAt, ... })
- reuse: Required columns for insert: tenantId (text, NOT NULL), contactId (uuid, NOT NULL), memberId (uuid, NOT NULL, FK to members), firstName (text, NOT NULL), lastName (text, NOT NULL), email (text, NOT NULL, unique per tenant when removedAt IS NULL), preferredLanguage (char[2], defaults 'en'). Optional: phone, roleTitle, dateOfBirth (DATE), linkedUserId. Set isPrimary=true for primary contact (partial unique index enforces one per member). DO NOT set createdAt/updatedAt (DB DEFAULT NOW()). removedAt defaults NULL (soft-delete column).

### Idempotency pattern via email deduplication
- src/modules/members/infrastructure/db/schema-contacts.ts:100-120
- shape: contacts_tenant_email_uniq ON contacts(tenant_id, lower(email)) WHERE removed_at IS NULL
- reuse: The importer's dry-run and commit passes must dedupe by lower(email) AND removed_at IS NULL (match the partial index predicate). A soft-deleted contact with the same email is INVISIBLE to the index, so a re-run can reactivate it. Importer must decide: skip-with-warning or reactivate (per spec § 5). The dedup key is email.toLowerCase() matched against contacts in the live tenant within the same runInTenant tx.

### Example seed pattern (similar to importer use case)
- scripts/seed-demo-members.ts:224-340
- shape: seedRow(ctx: TenantContext, actorUserId: string, planYear: number, row: DemoRow): Promise<InsertOutcome>;
- reuse: The seed script at scripts/seed-demo-members.ts lines 224-340 is an exact parallel: it loads Excel data via JSON, validates required fields, checks for existing members (idempotency), opens runInTenant(ctx, async (tx) => { ... }), inserts member + primary contact + audit events, then reports outcomes. The importer can reuse this structure exactly: validate → dry-run report → prompt user → commit inside runInTenant with atomic audit. See main() at line 344 for the full orchestration.

### Plan loading for tenant + plan_year
- src/modules/plans/application/ports.ts:51-54
- shape: findByTenantAndYear(tenant: TenantContext, filter: ListPlansFilter): Promise<Plan[]>
- reuse: Call planRepo.findByTenantAndYear(tenantContext, { year: asPlanYear(2026), showDeleted: false }) to load all active seeded plans for the tenant+year. Returns array of Plan domain objects ready to iterate for tier->plan_id mapping.

### Plan domain type with tier identity fields
- src/modules/plans/domain/plan.ts:85-122
- shape: type Plan = { readonly tenant_id: TenantSlug; readonly plan_id: PlanSlug; readonly plan_year: PlanYear; readonly plan_name: LocaleText; readonly plan_category: PlanCategory; readonly member_type_scope: MemberTypeScope; readonly annual_fee_minor_units: number; readonly includes_corporate_plan_id: PlanSlug | null; }
- reuse: Extract plan_id (PlanSlug), plan_name {en/th/sv} (LocaleText), plan_category ('corporate'|'partnership'), member_type_scope ('company'|'individual'|'both'). For import: build { normalizedTierName -> plan_id } map; read member_type_scope to enforce tax_id requirement per spec section 3.8 (company scope requires tax_id).

### Tier name normalization - canonical seeded tier IDs
- scripts/seed-swecham-2026-plans.ts:111-280
- shape: CORPORATE_SEED + PARTNERSHIP_SEED export: corporate tier IDs = ['premium', 'large', 'regular', 'start-up', 'individual', 'thai-alumni']; partnership tier IDs = ['diamond', 'platinum', 'gold']
- reuse: Import or copy CORPORATE_SEED/PARTNERSHIP_SEED arrays to get the canonical plan_id slugs (tier names). For each imported row, normalize the Excel tier name (case-insensitive, trim) to one of these 9 plan_ids. Importer spec section 4 says tier names differ historically from PDFs; the Excel column will be confirmed at build time.

### MemberTypeScope enum for tax_id validation rule
- src/modules/plans/domain/plan.ts:53-54
- shape: type MemberTypeScope = 'company' | 'individual' | 'both'; export const MEMBER_TYPE_SCOPES = ['company', 'individual', 'both'] as const;
- reuse: After resolving plan_id via tier map, check resolved_plan.member_type_scope. If === 'company', then tax_id is REQUIRED per spec section 3.8 (FR-009a + Thai tax-invoice law). If 'individual' or 'both' and country='TH', tax_id is optional.

### PlanRepo findByTenantAndYear method signature
- src/modules/plans/infrastructure/db/plan-repo.ts:122-159
- shape: async findByTenantAndYear(tenant: TenantContext, filter: ListPlansFilter): Promise<Plan[]>
- reuse: Use this repo method inside import transaction: const plans = await planRepo.findByTenantAndYear(ctx, { year: asPlanYear(2026), showDeleted: false }). Internally runs inside runInTenant which sets RLS context per spec section 5.

### LocaleText type for plan_name display
- src/modules/plans/domain/plan.ts:92
- shape: readonly plan_name: LocaleText; // LocaleText = { en: string; th?: string; sv?: string }
- reuse: Read plan.plan_name.en | plan.plan_name.th | plan.plan_name.sv when building tier->plan_id map display. All plans have en; th/sv may be undefined but en is always non-empty (validated by asLocaleText in repo hydration).

### TenantContext type definition + branded constructor
- src/modules/tenants/domain/tenant-context.ts:37-72
- shape: type TenantContext = { readonly slug: TenantSlug; readonly [tenantContextBrand]: true; };
export function asTenantContext(slug: string): TenantContext
- reuse: Call `asTenantContext('swecham')` to construct a TenantContext. Throws InvalidTenantSlugError if slug doesn't match [a-z0-9-]{1,63}. MUST be called at script entry before any DB operations.

### runInTenant() transaction wrapper for RLS + tenant isolation
- src/lib/db.ts:239-264
- shape: export async function runInTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>
- reuse: Pass ctx and an async callback. Callback receives tx (TenantTx from Drizzle). Inside callback: use `tx.insert(...)` / `tx.update(...)` / `tx.select(...)` NOT global `db`. The function opens a transaction with SET LOCAL ROLE chamber_app + SET LOCAL app.current_tenant = ctx.slug before fn() runs. All tenant-scoped writes MUST go through runInTenant.

### Database client singleton + pg connection setup
- src/lib/db.ts:1-65
- shape: export const db = drizzle(pgClient, { schema });
export type Database = typeof db;
- reuse: Import `db` from '@/lib/db'. It is a pre-configured Drizzle client singleton with Neon pooling + SSL + 5s statement timeout. Do NOT construct a new postgres() client; reuse global db. For cross-tenant identity queries (users table) that don't need tenant isolation, call `db.select(...).from(users)` directly. For tenant-scoped queries, always wrap in runInTenant().

### Script entry pattern: tenant guard + env loading + process.exit cleanup
- scripts/seed-swecham-2026-plans.ts:30-90
- shape: function requireSwechamTenant(): TenantContext { ... }
async function findSeedOwnerUserId(): Promise<string> { ... }
async function main(): Promise<void> { const ctx = requireSwechamTenant(); ...; process.exit(0 or 1); }
- reuse: 1. Load .env via `process.loadEnvFile?.('.env.local')` at top. 2. Guard tenant: `if (process.env.TENANT_SLUG !== 'swecham') throw new Error(...)`. 3. Construct ctx: `asTenantContext('swecham')`. 4. Find admin user ID for audit: query `db.select().from(users).where(eq(users.role, 'admin')).limit(1)` (cross-tenant query, no runInTenant needed). 5. Wrap main logic in async main() function. 6. At the very end: check `process.argv[1]` matches script filename, call main() if entry point, ensure process.exit() in .finally().

### Audit log insertion + event typing
- scripts/seed-demo-members.ts:305-336
- shape: await tx.insert(auditLog).values({eventType: 'member_created' | 'contact_created', actorUserId: string, summary: string, requestId: string, tenantId: ctx.slug, payload: Record<string, any>})
- reuse: Call inside runInTenant callback (use tx, not db). Set eventType to 'member_created' or 'contact_added'. actorUserId is the admin user ID. requestId can be 'import-' + randomUUID(). tenantId MUST equal ctx.slug. payload is JSON with member_id, contact_id, email, etc.

### Member + contact insert pattern with idempotency
- scripts/seed-demo-members.ts:224-340
- shape: async function seedRow(ctx: TenantContext, actorUserId: string, planYear: number, row: DemoRow): Promise<InsertOutcome>
- reuse: Inside runInTenant: (1) Check idempotency by email (case-insensitive). (2) If found, skip or repair. (3) If new: INSERT member (tenantId, memberId=randomUUID(), companyName, country, taxId, planId, planYear, registrationDate, status). (4) INSERT contact (tenantId, contactId=randomUUID(), memberId, firstName, lastName, email, phone, roleTitle, preferredLanguage, isPrimary). (5) INSERT 2 auditLog rows. All writes within same tx for atomic rollback.

### Email deduplication + partial unique index
- docs/member-import-spec.md:90
- shape: contacts_tenant_email_uniq: unique index on (tenant_id, lower(email)) WHERE removed_at IS NULL
- reuse: Before inserting contact: query `tx.select().from(contacts).where(and(eq(contacts.tenantId, ctx.slug), eq(sql`lower(${contacts.email})`, email.toLowerCase()), isNull(contacts.removedAt)))`. If found: skip with warning or reactivate. If not: insert. Soft-deleted contacts are not duplicate-blocked.

### TenantTx type + import
- src/lib/db.ts:109
- shape: export type TenantTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
- reuse: Don't construct TenantTx; it is the callback parameter inside runInTenant. Import as `import { runInTenant, type TenantTx } from '@/lib/db'` if needed in helper function type annotations.

### Schema table imports
- scripts/seed-demo-members.ts:40-46
- shape: import { users } from '@/modules/auth/infrastructure/db/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts'
- reuse: Use exact import paths as shown. Pass to tx.select().from(members), tx.insert(contacts).values(...), etc. inside runInTenant callback.

### UUID generation + requestId naming
- scripts/seed-demo-members.ts:35-36,268-271
- shape: import { randomUUID } from 'node:crypto';
const memberId = randomUUID();
const requestId = `seed-demo-${randomUUID()}`
- reuse: Use randomUUID() from 'node:crypto' for memberId, contactId. For import-members, use `'import-' + randomUUID()` as requestId prefix to distinguish audit events.

### Entry-point detection regex to prevent test auto-run
- scripts/seed-demo-members.ts:438-459
- shape: const isEntryPoint = process.argv[1] !== undefined && /[\\\\/]seed-demo-members\.[cm]?[jt]s$/.test(process.argv[1]);
if (isEntryPoint) main().catch(...).finally(() => process.exit(...))
- reuse: At file end: check argv[1] regex matches script filename with path separator [\\\\\\\/]. If true, call main(). Ensure .finally(() => process.exit(0 or 1)) closes pg pool. Prevents auto-run when imported in tests.

### Consecutive error fail-fast pattern
- scripts/seed-demo-members.ts:372-410
- shape: let consecutiveFailures = 0, errorClass; if (errorClass === prevClass) consecutiveFailures++; if (consecutiveFailures >= 3) throw
- reuse: For each row: catch errors, group by error class name. If 3+ consecutive errors of same type, abort (signals systemic problem like missing migration). Optional enhancement for robustness.

### Process exit cleanup to close pg pool
- scripts/seed-demo-members.ts:450-458
- shape: main().catch(e => { console.error(...); process.exitCode = 1; }).finally(() => process.exit(process.exitCode ?? 0))
- reuse: Always include .finally with process.exit(). Without it, postgres.js pool idle timeout (~20s) blocks CI. Exit 0 on success, 1 on validation/infra error, 99 on crash.

### Phone E.164 normalization (F3 phone value-object)
- src/modules/members/domain/value-objects/phone.ts:21
- shape: function asPhone(raw: string): Result<Phone, PhoneError>
- reuse: import { asPhone } from '@/modules/members/domain/value-objects/phone'; const result = asPhone('+66 81-234-5678'); if (result.ok) { store(result.value); } else { reportError(result.error.code); }

### i18n-iso-countries usage for country alpha-2 validation (F3 member-form)
- src/modules/members/domain/value-objects/iso-country-code.ts:22
- shape: function asIsoCountryCode(raw: string): Result<IsoCountryCode, IsoCountryCodeError>
- reuse: import { asIsoCountryCode } from '@/modules/members/domain/value-objects/iso-country-code'; const result = asIsoCountryCode(excelCountryNameOrCode); if (result.ok) { store(result.value); } else { handleCountryError(); } For name→code mapping, use: import i18nIsoCountries from 'i18n-iso-countries'; const code = i18nIsoCountries.getAlpha2Code(excelCountryName, 'en'); // returns 'TH'|'SE'|'US'|null

### Email RFC5321 validation (F7 broadcasts email-validator)
- src/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator.ts:19
- shape: const rfc5321EmailValidator: EmailValidatorPort = { validate(raw: string): Result<string, EmailValidationError>; }
- reuse: import { rfc5321EmailValidator } from '@/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator'; const result = rfc5321EmailValidator.validate(excelEmail); if (result.ok) { storeEmail(result.value); } // Validates RFC5321 + length ≤254 + lowercase-normalizes. Or reuse simpler F3 domain: import { asEmail } from '@/modules/members/domain/value-objects/email'; const r = asEmail(excelEmail); if (r.ok) store(r.value);

### Thai 13-digit TIN checksum validator
- src/modules/members/domain/policies/thai-tax-id-checksum.ts:14
- shape: function validateThaiTaxIdChecksum(taxId: string): boolean
- reuse: import { validateThaiTaxIdChecksum } from '@/modules/members/domain/policies/thai-tax-id-checksum'; const isValid = validateThaiTaxIdChecksum('1234567890123'); if (!isValid) reportError('taxId.th_bad_checksum'); Or use the full value-object wrapper: import { asTaxId } from '@/modules/members/domain/value-objects/tax-id'; import { asIsoCountryCode } from '@/modules/members/domain/value-objects/iso-country-code'; const result = asTaxId(excelTaxId, asIsoCountryCode('TH').value); // Returns error if checksum fails or wrong format

### Country-code to country-name display mapping
- src/components/members/country-display.tsx:120
- shape: i18nIsoCountries.getName(code: string, baseLocale: string): string | undefined
- reuse: import i18nIsoCountries from 'i18n-iso-countries'; import enLocale from 'i18n-iso-countries/langs/en.json'; i18nIsoCountries.registerLocale(enLocale); const countryName = i18nIsoCountries.getName('TH', 'en'); // 'Thailand' For reverse (name→code): const code = i18nIsoCountries.getAlpha2Code('Thailand', 'en'); // 'TH' (or null if not found)

### Age eligibility policy for date-of-birth validation
- src/modules/members/domain/policies/age-eligibility-policy.ts:29
- shape: function checkAgeEligibility(dateOfBirth: Date, planStartDate: Date, maxAge?: number): Result<undefined, AgeEligibilityViolation>
- reuse: import { checkAgeEligibility } from '@/modules/members/domain/policies/age-eligibility-policy'; const result = checkAgeEligibility(new Date(excelDOB), new Date(planStartDate)); if (!result.ok) { reportAgeError(result.error); } Useful for Thai Alumni tier validation; returns age in whole years.

### Tenant-scoped transaction (RLS + audit isolation)
- src/lib/db.ts:239
- shape: async function runInTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>
- reuse: import { runInTenant, type TenantTx } from '@/lib/db'; const result = await runInTenant(tenantCtx, async (tx) => { const members = await tx.insert(membersTable).values(...); return members; }); // All queries inside fn use tx; transaction auto-commits on return or rolls back on throw. RLS automatically scoped via SET LOCAL app.current_tenant.

### Email domain value-object (simpler alternative to F7 validator)
- src/modules/members/domain/value-objects/email.ts:27
- shape: function asEmail(raw: string): Result<Email, EmailError>
- reuse: import { asEmail } from '@/modules/members/domain/value-objects/email'; const result = asEmail(excelEmail); if (result.ok) { dedupedEmails.add(result.value); } else { reportError(result.error.code); } // Returns lowercase-normalized, max 254 chars, RFC5322-simplified validation (no exotic forms)

### Tax ID value-object wrapper (country-aware)
- src/modules/members/domain/value-objects/tax-id.ts:26
- shape: function asTaxId(raw: string, country: IsoCountryCode): Result<TaxId, TaxIdError>
- reuse: import { asTaxId, asIsoCountryCode } from '@/modules/members/domain/value-objects/'; const countryResult = asIsoCountryCode('TH'); const taxResult = asTaxId(excelTaxId, countryResult.value); if (!taxResult.ok) { switch(taxResult.error.code) { case 'taxId.th_bad_checksum': ...; case 'taxId.th_wrong_format': ...; } }

### Result type for explicit error handling
- src/lib/result.ts:21
- shape: type Result<T, E> = Ok<T> | Err<E>; export const ok = <T>(value: T): Ok<T>; export const err = <E>(error: E): Err<E>;
- reuse: import { ok, err, type Result } from '@/lib/result'; function importRow(row): Result<ImportedMember, ImportError> { if (!row.name) return err({code: 'missing_company_name'}); return ok({memberId, ...}); }

### Seed script structure (member + contact insert pattern)
- scripts/seed-demo-members.ts:224-340
- shape: async function seedRow(ctx: TenantContext, actorUserId: string, planYear: number, row: DemoRow): Promise<InsertOutcome>
- reuse: Mirror the seedRow pattern: (1) use randomUUID() for IDs, (2) check idempotency (existing company by name), (3) insert members via tx.insert(members).values({tenantId, memberId, companyName, country, taxId, planId, planYear, registrationDate, registrationFeePaid, notes, status, ...}), (4) insert contact via tx.insert(contacts).values({tenantId, contactId, memberId, firstName, lastName, email, phone, roleTitle, preferredLanguage, isPrimary: true}), (5) emit audit events at the tail within the same tx

### Member audit event emission (member_created)
- scripts/seed-demo-members.ts:305-320
- shape: await tx.insert(auditLog).values({ eventType: 'member_created', actorUserId, summary: string, requestId: string, tenantId: ctx.slug, payload: { member_id, company_name, plan_id, plan_year, country, source, timestamp } })
- reuse: Emit member_created audit via direct auditLog insert: use eventType='member_created', pack member_id (not memberId) in payload as snake_case key (triggers lastActivityAt trigger per migration 0009), include source field for audit trail (e.g. 'import-members-script')

### Contact audit event emission (contact_created)
- scripts/seed-demo-members.ts:323-336
- shape: await tx.insert(auditLog).values({ eventType: 'contact_created', actorUserId, summary: string, requestId: string, tenantId: ctx.slug, payload: { member_id, contact_id, is_primary: true } })
- reuse: Emit contact_created audit via direct auditLog insert: use eventType='contact_created', pack member_id + contact_id + is_primary in payload (snake_case keys), keep at tail of tx

### F3 audit port (members module high-level abstraction)
- src/modules/members/application/ports/audit-port.ts:97-109
- shape: interface AuditPort { record(ctx, event): Promise<Result<undefined, RepoError>>; recordInTx(tx, ctx, event): Promise<Result<undefined, RepoError>>; }
- reuse: For low-level script that emits directly to auditLog table, reuse the drizzleAuditAdapter pattern: import from src/modules/members/infrastructure/audit/audit-adapter.ts, call recordInTx(tx, ctx, {type, actorUserId, requestId, summary, payload}) for atomic audit+state

### F3 audit adapter implementation (recordInTx variant)
- src/modules/members/infrastructure/audit/audit-adapter.ts:42-59
- shape: async recordInTx(tx: TenantTx, ctx: TenantContext, event: F3AuditEvent): Promise<Result<undefined, RepoError>>
- reuse: Import drizzleAuditAdapter from src/modules/members/infrastructure/audit/audit-adapter.ts; call recordInTx(tx, ctx, {type: 'member_created'|'contact_created', actorUserId, requestId, summary, payload}) within runInTenant tx for atomic state+audit

### Excel column extraction helper (analyze_excel.py analysis)
- .specify/scripts/analyze_excel.py:66-96
- shape: function infer_type(values: list[Any]) -> str: detect 'empty'|'bool'|'int'|'float'|'datetime'|'int-str'|'float-str'|'email'|'phone'|'text'|'mixed(...)'
- reuse: For member-import script Excel parsing: reuse the column-type heuristics from analyze_excel.py (email regex at line 87, phone regex at line 88, datetime detection via hasattr isoformat at line 78) to validate column types before inserting

### Excel header auto-detection (analyze_excel.py pattern)
- .specify/scripts/analyze_excel.py:34-63
- shape: function detect_header_row(ws: Worksheet, max_col: int) -> int: score rows 1..HEADER_SCAN_DEPTH, return row with >=3 identifier-ish cells + >=40% match ratio
- reuse: For member-import script: call detect_header_row to auto-locate the header row in the Excel sheet (handles merged cells / offset headers); scoring uses _IDENTIFIER_RE regex pattern (snake_case identifiers, 'id' suffixes)

### Member schema exact field names
- src/modules/members/infrastructure/db/schema-members.ts:42-97
- shape: members pgTable: { tenantId, memberId, companyName, legalEntityType, country, taxId, website, description, foundedYear, turnoverThb, planId, planYear, registrationDate, registrationFeePaid, lastActivityAt, notes, addressLine1, addressLine2, city, province, postalCode, status, archivedAt, broadcastsHaltedUntilAdminReview, broadcastsAcknowledgedAt, preferredLocale, ... }
- reuse: Use exact DB column names when building member insert: tenantId, memberId, companyName, legalEntityType, country, taxId, planId, planYear, registrationDate (Date object), registrationFeePaid (boolean), status ('active'|'inactive'|'archived'), city, province, postalCode; nullable fields: website, description, notes, foundedYear, turnoverThb, addressLine1, addressLine2

### Contact schema exact field names
- src/modules/members/infrastructure/db/schema-contacts.ts:37-90
- shape: contacts pgTable: { tenantId, contactId, memberId, firstName, lastName, email, phone, roleTitle, preferredLanguage, isPrimary, dateOfBirth, linkedUserId, removedAt, inviteBouncedAt, createdAt, updatedAt }
- reuse: Use exact DB column names: tenantId, contactId, memberId, firstName, lastName, email, phone (nullable), roleTitle (nullable), preferredLanguage (char(2), default 'en'), isPrimary (boolean); for import: set all to FALSE except primary contact, keep linkedUserId null, removedAt null

### runInTenant transaction scope for RLS enforcement
- src/lib/db.ts:239-242
- shape: async function runInTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>
- reuse: Wrap all member/contact inserts in: await runInTenant(ctx, async (tx) => { /* tx.insert(members).values(...); tx.insert(contacts).values(...); tx.insert(auditLog).values(...); */ }); this sets ROLE chamber_app + app.current_tenant GUC automatically for RLS checks

### Seed script tenant context creation
- scripts/seed-demo-members.ts:96-105
- shape: export function requireSwechamTenant(): TenantContext { const slug = process.env.TENANT_SLUG ?? ''; if (slug !== 'swecham') throw new Error(...); return asTenantContext('swecham'); }
- reuse: For import-members.ts: create tenant context via asTenantContext(tenantSlug) after validating TENANT_SLUG env var; use as ctx parameter for all runInTenant + audit.recordInTx calls

### Actor user ID lookup for audit (seed pattern)
- scripts/seed-demo-members.ts:126-165
- shape: async function findActorUserId(ctx: TenantContext): Promise<string>: check BOOTSTRAP_ADMIN_EMAIL env, fallback to JOIN contacts.linkedUserId WHERE role='admin'
- reuse: For import-members.ts actor: support --actor-email flag or env var ACTOR_EMAIL; query users table with exact email match (case-insensitive via sql`lower(...)`), throw if not found; this populates the actorUserId for audit event emission

### Audit import source discriminator (seeding example)
- scripts/seed-demo-members.ts:254-263, 317, 334
- shape: payload: { ..., source: 'seed-demo-members'|'seed-demo-repair', ... }
- reuse: Include source field in audit payload to distinguish import-members from other seed scripts; examples: source: 'import-members-script:bulk-load', source: 'import-members-script:repair-email'

### Idempotency check pattern (by company_name)
- scripts/seed-demo-members.ts:234-246
- shape: const existing = await tx.select({memberId, currentTaxId}).from(members).where(eq(sql`lower(${members.companyName})`, row.companyName.toLowerCase())).limit(1);
- reuse: Before insert: query members by lower(company_name) to detect existing; if found + email unchanged, return 'skipped'; if found + email different, update tax_id + emit 'member_updated' audit (per spec 5 idempotency rule)

### Email deduplication (partial unique index enforcement)
- src/modules/members/infrastructure/db/schema-contacts.ts:100-103
- shape: uniqueIndex('contacts_tenant_email_uniq').on(table.tenantId, sql`lower(${table.email})`).where(sql`removed_at IS NULL`)
- reuse: Dedupe by lower(email) with removed_at IS NULL filter per spec 5; when duplicate found + active: skip with warning; if soft-deleted: operator decides (reactivate or leave removed_at); accumulate all dedupe warnings in validation report before write

### Create-member use-case audit emission pattern
- src/modules/members/application/use-cases/create-member.ts:314-350
- shape: const created = await runInTenant(deps.tenant, async (tx) => { const result = await deps.memberRepo.createWithPrimaryContactInTx(tx, ...); const memberAudit = await deps.audit.recordInTx(tx, deps.tenant, {type: 'member_created', actorUserId, requestId, summary, payload}); const contactAudit = await deps.audit.recordInTx(tx, deps.tenant, {type: 'contact_created', actorUserId, requestId, summary, payload}); return result.value; });
- reuse: For import script: mimic this pattern member insert + 2 audit emits must stay in same tx block; use recordInTx (not record) so audit commits atomically with state; place audit emits at tail before return; catch UseCaseAbort to roll back on error

### MemberRepo.createWithPrimaryContactInTx signature
- src/modules/members/application/ports/member-repo.ts
- shape: createWithPrimaryContactInTx(tx: TenantTx, draft: {readonly member: Omit<Member, 'createdAt'|'updatedAt'>; readonly primaryContact: Omit<Contact, 'createdAt'|'updatedAt'|'memberId'>;}): Promise<Result<{member: Member; contact: Contact}, RepoError>>
- reuse: Import drizzleMemberRepo from src/modules/members/infrastructure/db/drizzle-member-repo.ts; call createWithPrimaryContactInTx(tx, {member: {...}, primaryContact: {...}}) for atomic insert; returns Result<{member, contact}, RepoError>

### Import script dry-run vs commit pattern
- scripts/seed-demo-members.ts:376-412, docs/member-import-spec.md:85-93
- shape: if (--dry-run flag set) { validate only, print report, zero writes; } else if (--commit flag set) { validate + write in runInTenant tx; } default behavior: dry-run
- reuse: Implement --file ./path.xlsx --plan-year 2026 --commit CLI; default (no --commit): validate all rows, print report (member count, contact count, errors, warnings), exit 0; only persist to DB when --commit flag present AND dry-run validation passed with 0 errors

### Audit log schema (F1 shared table)
- src/modules/auth/infrastructure/db/schema.ts (auditLog table definition)
- shape: auditLog pgTable: { id, timestamp, eventType, actorUserId, targetUserId, sourceIp, summary, requestId, tenantId, payload (jsonb) }
- reuse: Direct insert to auditLog table: tx.insert(auditLog).values({eventType, actorUserId, summary, requestId, tenantId: ctx.slug, payload: {...}}); optionally set targetUserId (for email-change flows), sourceIp always null for script context

### AuditEventType enum (valid event types for F3)
- src/modules/members/application/ports/audit-port.ts:23-58
- shape: export type F3AuditEventType = 'member_created'|'member_updated'|'member_plan_changed'|'contact_created'|'contact_updated'|'contact_removed'|...
- reuse: For import script: use 'member_created' + 'contact_created' event types only (script creates new members/contacts, no updates); if repairing: use 'member_updated' per seed-demo-members pattern

### Excel parser dependency status
- package.json:1-160
- shape: NO Excel parser present (grep exceljs|xlsx returns 0 matches)
- reuse: Add as devDep: pnpm add -D exceljs or pnpm add -D xlsx. Spec §7 recommends exceljs (streaming, MIT). Use openpyxl pattern from analyze_excel.py (.specify/scripts/analyze_excel.py:24) as reference for column mapping approach.

### Column structure + tier mapping source
- docs/membership-benefits-analysis.md:73-265
- shape: Plan tier names: 'premium'|'large'|'regular'|'start-up'|'individual'|'thai-alumni'|'diamond'|'platinum'|'gold'. Seed at membership-benefits-analysis.md §4 lines 251-260. Column inference from analyze_excel.py (openpyxl load + header detection).
- reuse: Import plan tier names as string literals (6 corporate + 3 partnership). Map Excel column → schema: company_name, country, tax_id, membership tier (→ plan_id), turnover, city/province/postal_code, registration_date, contact first/last/email/phone/role/language/primary flag, member preferred_locale. See spec §2 table (member-import-spec.md:33-48).

### Email validation (RFC 5321)
- src/modules/members/domain/value-objects/email.ts:1-43
- shape: export function asEmail(raw: string): Result<Email, EmailError>
- reuse: Validate contact.email via asEmail(raw). Normalizes to lowercase. Returns branded Email or EmailError. Already in package (email-validator ^2 listed).

### Phone normalization (E.164)
- src/modules/members/domain/value-objects/phone.ts:1-44
- shape: export function asPhone(raw: string): Result<Phone, PhoneError>. Strips ASCII formatting (spaces, hyphens, parens). Validates +[1-9]\d{7,14}.
- reuse: Call asPhone(raw) for contact.phone. Returns branded Phone or empty (optional field). Handles Thai format normalization e.g. '+66 81-234-5678' → '+66812345678'.

### Country code validation (ISO 3166-1 alpha-2)
- src/modules/members/domain/value-objects/iso-country-code.ts:1-33
- shape: export function asIsoCountryCode(raw: string): Result<IsoCountryCode, IsoCountryCodeError>. Uses i18n-iso-countries (^7, already in package.json:86).
- reuse: Map Excel country name → ISO code via asIsoCountryCode(). Default 'TH' per spec §2 if absent. Validates against i18n-iso-countries package.

### Thai tax ID validation with checksum
- src/modules/members/domain/policies/thai-tax-id-checksum.ts:1-25
- shape: export function validateThaiTaxIdChecksum(taxId: string): boolean. 13-digit weighted sum: weights=[13,12,11,10,9,8,7,6,5,4,3,2], checksum=(11-(sum%11))%10.
- reuse: For country='TH' + company scope: require 13 digits via /^\d{13}$/, then validateThaiTaxIdChecksum(taxId). Other countries: 1–50 chars, no checksum. See tax-id.ts for wrapping validator.

### Tax ID value object (multi-country)
- src/modules/members/domain/value-objects/tax-id.ts:1-43
- shape: export function asTaxId(raw: string, country: IsoCountryCode): Result<TaxId, TaxIdError>
- reuse: Call asTaxId(raw, country) for company members. Delegates to validateThaiTaxIdChecksum for TH, else 1-50 char validation. Errors: empty, too_long, th_wrong_format, th_bad_checksum.

### Member schema (F3)
- src/modules/members/infrastructure/db/schema-members.ts:42-100
- shape: export const members = pgTable('members', { tenantId, memberId (uuid), companyName, country (2-char), taxId, planId, planYear, registrationDate, registrationFeePaid (bool), status='active', city, province, postalCode, ... })
- reuse: Columns to insert: tenantId (from ctx), memberId (uuid v4), companyName, country (ISO-2), taxId, planId, planYear, registrationDate (ISO date), status='active', city, province, postalCode. taxId REQUIRED for company scope (FR-009a). See schema line 55-94.

### Contact schema (F3)
- src/modules/members/infrastructure/db/schema-contacts.ts:37-99
- shape: export const contacts = pgTable('contacts', { tenantId, contactId (uuid), memberId (fk), firstName, lastName, email (unique per tenant, case-insensitive), phone, roleTitle, preferredLanguage='en', isPrimary (bool), dateOfBirth?, linkedUserId?, removedAt? })
- reuse: Insert one contact per member (primary=true, others false). Columns: tenantId, contactId (uuid v4), memberId (fk), firstName, lastName, email (lowercase, dedupe key), phone, roleTitle, preferredLanguage, isPrimary. dateOfBirth for Thai Alumni only. Partial unique index on (tenant_id, lower(email)) WHERE removed_at IS NULL.

### Membership plans schema (F2) + tier names
- src/modules/plans/infrastructure/db/schema.ts:89-150
- shape: export const membershipPlans = pgTable('membership_plans', { tenantId, planId (text), planYear (int), planName (jsonb LocaleText), planCategory ('corporate'|'partnership'), memberTypeScope ('company'|'individual'|'both'), annualFeeMinorUnits (bigint), includesCorporatePlanId (text fk), ... })
- reuse: Build tier → planId map from DB query: SELECT plan_id FROM membership_plans WHERE tenant_id=$1 AND plan_year=$2 AND is_active=TRUE. 9 rows seeded (membership-benefits-analysis.md §4). Plan IDs: premium, large, regular, start-up, individual, thai-alumni (corporate) + diamond, platinum, gold (partnership).

### Tenant-scoped transaction (RLS enforcement)
- src/lib/db.ts:239-264
- shape: export async function runInTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>. Sets LOCAL ROLE chamber_app + SET LOCAL app.current_tenant='<slug>'.
- reuse: ALL member/contact inserts MUST go through runInTenant(ctx, async (tx) => { await tx.insert(members).values(...); await tx.insert(contacts).values(...); }). Spec §5 mandates one tx per dry-run/commit. Never use global db singleton—use tx parameter exclusively.

### Audit event recording (F3)
- src/modules/members/infrastructure/audit/audit-adapter.ts:1-59
- shape: export const drizzleAuditAdapter: AuditPort = { async record(ctx, event), async recordInTx(tx, ctx, event) }. Inserts to auditLog table.
- reuse: For --commit mode: emit member_created + contact_added events via recordInTx(tx, ctx, {type, actorUserId, summary, payload:{member_id}, ...}). Payload MUST use snake_case member_id (not camelCase) so AFTER INSERT trigger bumps members.last_activity_at. See schema-members.ts:74-79.

### Plan lookup (validation)
- src/modules/members/infrastructure/adapters/plan-lookup-adapter.ts:34-76
- shape: export const plansBarrelAdapter: PlanLookupPort = { async getPlan(ctx, planId, planYear): Promise<Result<PlanSummary, ...>>
- reuse: For tier validation: await plansBarrelAdapter.getPlan(ctx, planId, planYear) returns PlanSummary with planId, planCategory, memberTypeScope, minTurnoverThb, maxTurnoverThb. Fail dry-run if plan not found. Already wired in F3 ports.

### Result type (error handling)
- src/lib/result.ts:1-50
- shape: type Result<T, E> = {ok: true, value: T} | {ok: false, error: E}. Helpers: ok(value), err(error), .ok property for truthiness.
- reuse: Use Result<T,E> for all validation + repo calls. Check .ok before accessing value. No exceptions—all errors are Result-typed. Validation errors accumulate in a report (per spec §3).

### Drizzle tx parameter type
- src/lib/db.ts:109-143
- shape: export type TenantTx = Parameters<Parameters<typeof db.transaction>[0]>[0]. Drizzle transaction object with select/insert/update/delete/execute/transaction methods.
- reuse: Inside runInTenant callback, tx: TenantTx is Drizzle's transaction object. Use tx.insert(members).values(...), tx.insert(contacts).values(...), etc. Never the global db singleton.

### Member domain model
- src/modules/members/domain/member.ts:1-80
- shape: export type Member = { tenantId: TenantId, memberId: MemberId, companyName: string, country: IsoCountryCode, taxId: TaxId | null, planId: PlanId, planYear: number, registrationDate: Date, ... }
- reuse: Importer builds Member domain objects before repo insert. Domain validates per memberLifecycle, turnover-policy, startup-duration-policy, thai-tax-id-checksum. See CLAUDE.md §Architecture for flow.

### Contact domain model
- src/modules/members/domain/contact.ts:1-70
- shape: export type Contact = { tenantId: TenantId, contactId: ContactId, memberId: MemberId, firstName: string, lastName: string, email: Email, phone: Phone | null, isPrimary: boolean, preferredLanguage: 'en'|'th'|'sv', ... }
- reuse: Importer builds Contact domain objects. Enforces exactly-one-primary per member (primary-contact-invariant.ts). Email dedupe on import via lower(email) across all new contacts (per spec §5 idempotency).
