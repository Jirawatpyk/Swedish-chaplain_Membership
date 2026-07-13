# Member Form — PR-0: Pre-existing Bug Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three pre-existing defects in the admin member form — a `notes` field that silently discards input on create, a `registration_date` field that silently discards input on edit, and nine fields whose validation errors are invisible — so that PR-A (tax correctness) and PR-B (form UX) build on a form that does not lie to the admin.

**Architecture:** No new columns, no migration, no new dependencies. Three independent changes, each with its own test cycle: (1) thread `notes` through the create path (client payload → zod schema → member draft), (2) make `registration_date` read-only in edit mode and attach an explanatory tooltip in both modes, (3) wire `FieldError` + `aria-invalid` + error-summary entries onto the nine fields that lack them.

**Tech Stack:** Next.js 16 App Router · React 19 · react-hook-form + zod · next-intl · Vitest + @testing-library/react · shadcn/ui + Base UI primitives.

**Spec:** `docs/superpowers/specs/2026-07-13-member-form-redesign-design.md` § 12 (v2, commit `a6c9edd8`).

## Global Constraints

- **Package manager is `pnpm`, never `npm`.** Lockfile is `pnpm-lock.yaml`.
- **Never run `prettier --write`.** `.prettierrc` says `printWidth: 100` but the committed code is ~80 columns and no gate enforces it — a format run would reflow whole files. Hand-format to match the surrounding code.
- **TDD is NON-NEGOTIABLE** (Constitution Principle II): write the failing test, run it, watch it fail, then implement.
- **Conventional Commits**, enforced by a commit-msg hook.
- **i18n**: `en.json` is canonical; a key missing from `en.json` fails the build. Every new key must be added to **all three** of `en.json`, `th.json`, `sv.json` in the same commit.
- **`pnpm typecheck` is not in the pre-push hook.** Run it as the final gate after the last edit, before the last commit.
- Work on branch `057-member-form-redesign` (already created; spec is committed there).

---

### Task 1: `notes` is accepted on create

Today the Notes textarea renders on the create form, the admin types into it, and the value is dropped on the floor: `toPayload` omits it, `createMemberSchema` does not accept it, and `create-member.ts` hardcodes `notes: null`.

**Files:**
- Modify: `src/modules/members/application/use-cases/create-member.ts:52-81` (schema) and `:372` (member draft)
- Modify: `src/components/members/create-member-client.tsx:58-86` (`toPayload`)
- Test: `tests/contract/members/create-member.test.ts` (existing file — reuse its `validBody` fixture at `:65`)
- Test: `tests/unit/members/presentation/create-member-client.test.tsx` (existing file)
- Test: `tests/integration/members/create-member.test.ts` (existing file)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createMemberSchema` gains `notes?: string | null`. `CreateMemberInput` (inferred) therefore gains `notes`. No other task depends on this.

- [ ] **Step 1: Write the failing contract test**

In `tests/contract/members/create-member.test.ts`, inside the existing `describe('contract: POST /api/members (T040)')` block, add:

```ts
  it('accepts notes and forwards them to the use case', async () => {
    requireAdminContextMock.mockResolvedValue(adminContext);
    createMemberMock.mockResolvedValue(
      ok({ memberId: 'm-1', primaryContactId: 'c-1' }),
    );

    const res = await POST(
      makeRequest({ ...validBody, notes: 'Paid by bank transfer, VIP' }),
    );

    expect(res.status).toBe(201);
    expect(createMemberMock).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'Paid by bank transfer, VIP' }),
      expect.anything(),
    );
  });
```

If `makeRequest` / `POST` / `ok` are already imported at the top of the file (they are — see `:9-11`, `:78`), no new imports are needed. If the existing 201 test passes its arguments in a different shape, mirror that shape exactly rather than the one above.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run tests/contract/members/create-member.test.ts -t "accepts notes"
```

Expected: FAIL. `createMemberSchema` is `.strict()`-adjacent in effect — an unknown `notes` key is stripped by zod, so `createMemberMock` is called **without** `notes` and the `objectContaining` assertion fails.

- [ ] **Step 3: Accept `notes` in the schema**

In `src/modules/members/application/use-cases/create-member.ts`, add one line to `createMemberSchema` immediately after `description` (line 58):

```ts
  description: z.string().max(2000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
```

The 4000 cap matches the form's own rule (`member-form.tsx:136-143`) and `updateMemberSchema`.

- [ ] **Step 4: Persist it in the member draft**

In the same file at line 372, replace the hardcoded null:

```ts
        lastActivityAt: null,
        notes: data.notes ?? null,
        addressLine1: data.address_line1 ?? null,
```

- [ ] **Step 5: Run the contract test again**

```bash
pnpm vitest run tests/contract/members/create-member.test.ts
```

Expected: PASS, and no previously-passing test in the file regresses.

- [ ] **Step 6: Write the failing client-payload test**

In `tests/unit/members/presentation/create-member-client.test.tsx`, add a test asserting the POST body carries `notes`. Follow the fetch-mocking pattern already used in that file; the assertion is:

```ts
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(body.notes).toBe('Renewal handled by finance');
```

Drive it by filling the Notes textarea before submitting:

```ts
    fireEvent.change(screen.getByLabelText(/notes/i), {
      target: { value: 'Renewal handled by finance' },
    });
```

- [ ] **Step 7: Run it and watch it fail**

```bash
pnpm vitest run tests/unit/members/presentation/create-member-client.test.tsx -t "notes"
```

Expected: FAIL — `body.notes` is `undefined`.

- [ ] **Step 8: Send `notes` from the client**

In `src/components/members/create-member-client.tsx`, inside `toPayload`, add one line after `description` (line 64). Match the trimming shape `edit-member-payloads.ts:70` already uses, because the form's zod transform already narrowed `notes` to `string | null`:

```ts
    description: values.description?.trim() || null,
    notes: values.notes ? values.notes.trim() || null : null,
```

- [ ] **Step 9: Run it and watch it pass**

```bash
pnpm vitest run tests/unit/members/presentation/create-member-client.test.tsx
```

Expected: PASS.

- [ ] **Step 10: Write the failing integration test (live Neon)**

In `tests/integration/members/create-member.test.ts`, add a case that creates a member with notes and reads the row back. Reuse the file's existing tenant-context + deps helpers:

```ts
  it('persists notes supplied at create time', async () => {
    const result = await createMember(
      { ...baseInput, notes: 'Introduced by the Swedish embassy' },
      meta,
    );
    expect(result.ok).toBe(true);

    const row = await readMemberRow(result.value.memberId);
    expect(row.notes).toBe('Introduced by the Swedish embassy');
  });
```

Use whatever the file already calls its input fixture and its row-reading helper — do not invent new ones.

- [ ] **Step 11: Run it and watch it pass**

```bash
pnpm vitest run --config vitest.integration.config.ts tests/integration/members/create-member.test.ts
```

Expected: PASS. This hits the **`dev` Neon branch** via `.env.local`; the suite refuses to run against prod.

- [ ] **Step 12: Commit**

```bash
git add src/modules/members/application/use-cases/create-member.ts \
        src/components/members/create-member-client.tsx \
        tests/contract/members/create-member.test.ts \
        tests/unit/members/presentation/create-member-client.test.tsx \
        tests/integration/members/create-member.test.ts
git commit -m "fix(members): accept notes on member create

The Notes textarea rendered on the create form but the value was dropped:
toPayload omitted it, createMemberSchema did not accept it, and the member
draft hardcoded notes: null."
```

---

### Task 2: `registration_date` is read-only on Edit, with a tooltip

Today the Registration date input renders in edit mode, is seeded from the database, and is silently discarded on save — `buildFieldPayload` never sends it and `updateMemberSchema` is `.strict()` without the key, so sending it would 400 anyway. It is also the anchor for the F8 renewal cycle, so making it editable would mean re-anchoring the cycle (deferred; see spec § 13). Read-only closes the data-loss bug without touching cycle semantics.

**Files:**
- Modify: `src/components/members/member-form.tsx:698-705`
- Modify: `src/i18n/messages/en.json`, `th.json`, `sv.json` (two new keys)
- Test: `tests/unit/members/presentation/member-form-a11y.test.tsx` (existing file)

**Interfaces:**
- Consumes: nothing.
- Produces: two i18n keys under `admin.members.create.fields` — `registrationDateHint` and `registrationDateReadOnly`. PR-B does not depend on them.

- [ ] **Step 1: Write the failing test**

In `tests/unit/members/presentation/member-form-a11y.test.tsx`, add:

```ts
  it('renders registration_date as read-only in edit mode', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={plans}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
          mode="edit"
          initialValues={{ registration_date: '2024-03-01' }}
        />
      </NextIntlClientProvider>,
    );

    const input = screen.getByLabelText(/registration date/i);
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveValue('2024-03-01');
    expect(
      screen.getByText(/set at member creation and cannot be changed here/i),
    ).toBeInTheDocument();
  });

  it('leaves registration_date editable in create mode', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={plans}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
        />
      </NextIntlClientProvider>,
    );

    expect(screen.getByLabelText(/registration date/i)).not.toHaveAttribute(
      'readonly',
    );
  });
```

Reuse the `plans` fixture already defined in that file.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run tests/unit/members/presentation/member-form-a11y.test.tsx -t "registration_date"
```

Expected: FAIL — the input has no `readonly` attribute and the hint text does not exist.

- [ ] **Step 3: Add the i18n keys**

In `src/i18n/messages/en.json`, under `admin.members.create.fields`:

```json
      "registrationDateHint": "Counted from the date the member is created in the system.",
      "registrationDateReadOnly": "Set at member creation and cannot be changed here.",
```

In `th.json`, same path:

```json
      "registrationDateHint": "นับจากวันที่สร้างสมาชิกในระบบ",
      "registrationDateReadOnly": "กำหนดตอนสร้างสมาชิก ไม่สามารถแก้ไขที่หน้านี้ได้",
```

In `sv.json`, same path:

```json
      "registrationDateHint": "Räknas från det datum då medlemmen skapas i systemet.",
      "registrationDateReadOnly": "Anges när medlemmen skapas och kan inte ändras här.",
```

- [ ] **Step 4: Render it read-only in edit mode**

In `src/components/members/member-form.tsx`, replace the block at lines 698-705:

```tsx
        <div>
          <Label htmlFor="registration_date">{tf('registrationDate')}</Label>
          <Input
            id="registration_date"
            type="date"
            readOnly={mode === 'edit'}
            aria-describedby={
              mode === 'edit'
                ? 'registration_date-hint registration_date-readonly'
                : 'registration_date-hint'
            }
            className={mode === 'edit' ? 'bg-muted' : undefined}
            {...register('registration_date')}
          />
          <p
            id="registration_date-hint"
            className="mt-1 text-xs text-muted-foreground"
          >
            {tf('registrationDateHint')}
          </p>
          {mode === 'edit' && (
            <p
              id="registration_date-readonly"
              className="mt-1 text-xs text-muted-foreground"
            >
              {tf('registrationDateReadOnly')}
            </p>
          )}
        </div>
```

`readOnly` (not `disabled`) is deliberate: a disabled input is skipped by react-hook-form and dropped from the form state, and it is not reachable by keyboard — a WCAG regression. `readOnly` keeps the value visible, focusable, and announced.

- [ ] **Step 5: Run the tests and watch them pass**

```bash
pnpm vitest run tests/unit/members/presentation/member-form-a11y.test.tsx
pnpm check:i18n
```

Expected: both PASS. `check:i18n` must report no missing keys in `th.json` / `sv.json`.

- [ ] **Step 6: Commit**

```bash
git add src/components/members/member-form.tsx src/i18n/messages/en.json \
        src/i18n/messages/th.json src/i18n/messages/sv.json \
        tests/unit/members/presentation/member-form-a11y.test.tsx
git commit -m "fix(members): registration date is read-only on edit

The field rendered in edit mode, was seeded from the DB, and was silently
discarded on save — buildFieldPayload never sent it and updateMemberSchema
is .strict() without the key. It also anchors the F8 renewal cycle, so it
must not become editable without a re-anchor use case (deferred)."
```

---

### Task 3: Nine fields get visible validation errors

Nine inputs carry a zod max-length rule but render no `FieldError`, set no `aria-invalid`, and contribute no entry to the error summary. A failure on any of them makes the submit button do nothing with no explanation. PR-B makes the address fields **required**, so their errors must be visible before that lands.

The nine: `legal_entity_type`, `description`, `notes`, `address_line1`, `address_line2`, `city`, `province`, `postal_code`, `role_title`.

**Files:**
- Modify: `src/components/members/member-form.tsx` — the field blocks at `:499-505`, `:598-606`, `:608-621`, `:713-721`, `:722-730`, `:732-739`, `:741-748`, `:750-758`, `:920-927`; and `summaryEntries` at `:417-446`
- Test: `tests/unit/members/presentation/member-form-error-summary.test.tsx` (existing file)

**Interfaces:**
- Consumes: nothing.
- Produces: DOM ids `<field>-error` for each of the nine fields, matching the `FieldError` convention already used by `company_name` (`:494`). The error summary's jump links target the input ids, which already exist.

- [ ] **Step 1: Write the failing test**

In `tests/unit/members/presentation/member-form-error-summary.test.tsx`, add:

```ts
  it('shows an inline error and a summary entry when city exceeds its max length', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={plans}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
          mode="edit"
          initialValues={{
            company_name: 'ACME',
            country: 'TH',
            plan_id: plans[0]!.plan_id,
            plan_year: 2026,
            city: 'x'.repeat(101),
            province: 'y'.repeat(101),
            primary_contact: {
              first_name: 'A',
              last_name: 'B',
              email: 'a@b.com',
              preferred_language: 'en',
            },
          }}
        />
      </NextIntlClientProvider>,
    );

    fireEvent.submit(screen.getByRole('form', { hidden: true }));

    expect(await screen.findByText(/at most 100/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^city/i)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
```

Seeding the over-length values through `initialValues` is deliberate: the inputs carry a `maxLength` attribute, so a human cannot type past the limit — but a value seeded from a legacy database row can, and that is the real failure mode.

If the existing test in this file submits the form differently (see `:34` — `fireEvent.submit(form)`), copy that mechanism exactly.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run tests/unit/members/presentation/member-form-error-summary.test.tsx -t "city exceeds"
```

Expected: FAIL — no error text is rendered and `aria-invalid` is absent.

- [ ] **Step 3: Wire the nine fields**

In `src/components/members/member-form.tsx`, apply the same three-part treatment to each of the nine. Two worked examples; the other seven follow the identical shape.

`legal_entity_type` (currently `:498-505`):

```tsx
          <div>
            <Label htmlFor="legal_entity_type">{tf('legalEntityType')}</Label>
            <Input
              id="legal_entity_type"
              {...register('legal_entity_type')}
              maxLength={100}
              aria-invalid={Boolean(errors.legal_entity_type)}
              aria-describedby={
                errors.legal_entity_type ? 'legal_entity_type-error' : undefined
              }
            />
            <FieldError
              id="legal_entity_type-error"
              message={errors.legal_entity_type?.message}
            />
          </div>
```

`notes` (currently `:608-621`) already has a `notes-hint`, so the `aria-describedby` must carry **both** ids when an error is present:

```tsx
        <div>
          <Label htmlFor="notes">{tf('notes')}</Label>
          <Textarea
            id="notes"
            {...register('notes')}
            rows={3}
            maxLength={4000}
            placeholder={tf('notesPlaceholder')}
            aria-invalid={Boolean(errors.notes)}
            aria-describedby={
              errors.notes ? 'notes-error notes-hint' : 'notes-hint'
            }
          />
          <p id="notes-hint" className="mt-1 text-xs text-muted-foreground">
            {tf('notesHint')}
          </p>
          <FieldError id="notes-error" message={errors.notes?.message} />
        </div>
```

Repeat for `description` (`:598-606`, `maxLength={2000}`), `address_line1` (`:713-721`), `address_line2` (`:722-730`), `city` (`:732-739`), `province` (`:741-748`), `postal_code` (`:750-758`), and `role_title` (`:920-927`, error path `errors.primary_contact?.role_title`). Each keeps its existing `autoComplete` attribute untouched.

- [ ] **Step 4: Add the nine to the error summary**

In the same file, extend `summaryEntries` (`:417-446`). The first element of each tuple is the **DOM id of the input** the jump link targets, so it must match the `id` on the element, not the RHF path:

```tsx
  const summaryEntries: ReadonlyArray<readonly [string, string | undefined]> = [
    ['company_name', errors.company_name?.message],
    ['legal_entity_type', errors.legal_entity_type?.message],
    ['country', errors.country?.message],
    ['tax_id', errors.tax_id?.message],
    ['website', errors.website?.message],
    ['description', errors.description?.message],
    ['notes', errors.notes?.message],
    ['founded_year', errors.founded_year?.message],
    ['turnover_thb', errors.turnover_thb?.message],
    ['plan_id', errors.plan_id?.message],
    ['plan_year', errors.plan_year?.message],
    ['address_line1', errors.address_line1?.message],
    ['address_line2', errors.address_line2?.message],
    ['city', errors.city?.message],
    ['province', errors.province?.message],
    ['postal_code', errors.postal_code?.message],
    ['first_name', errors.primary_contact?.first_name?.message],
    ['last_name', errors.primary_contact?.last_name?.message],
    ['contact_email', errors.primary_contact?.email?.message],
    ['contact_phone', errors.primary_contact?.phone?.message],
    ['role_title', errors.primary_contact?.role_title?.message],
    [
      'date_of_birth',
      needsDob ? errors.primary_contact?.date_of_birth?.message : undefined,
    ],
    [
      'branch_code',
      mode === 'edit' && !isHeadOffice
        ? errors.branch_code?.message
        : undefined,
    ],
  ];
```

Leave the `date_of_birth` and `branch_code` guards exactly as they are — they exist so a stale error cannot point a jump link at an unmounted input.

- [ ] **Step 5: Run the tests and watch them pass**

```bash
pnpm vitest run tests/unit/members/presentation/
```

Expected: PASS, including the pre-existing a11y, error-summary, schema, and server-field-error suites.

- [ ] **Step 6: Run the a11y E2E scan**

```bash
pnpm test:e2e --grep "@a11y" --workers=1
```

Expected: PASS. `--workers=1` is mandatory on this machine — the default of 3 hangs it.

- [ ] **Step 7: Commit**

```bash
git add src/components/members/member-form.tsx \
        tests/unit/members/presentation/member-form-error-summary.test.tsx
git commit -m "fix(members): nine form fields had invisible validation errors

legal_entity_type, description, notes, the five address fields, and
role_title carried a zod max-length rule but rendered no FieldError, set no
aria-invalid, and contributed no error-summary entry — a failure on any of
them made submit do nothing, with no explanation. Reachable today via
over-length values seeded from legacy rows; PR-B makes the address fields
required, so their errors must be visible first."
```

---

### Task 4: Full gate run and PR

**Files:** none modified — this task verifies.

- [ ] **Step 1: Run the full local pipeline**

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm check:fixme
```

Expected: all green. `pnpm typecheck` is **not** in the pre-push hook — this is the only place it runs. If `.next/dev/types` interferes because a dev server is running, use the temporary tsconfig that excludes `.next`.

- [ ] **Step 2: Run the member integration suite**

```bash
pnpm vitest run --config vitest.integration.config.ts tests/integration/members/
```

Expected: PASS against the `dev` Neon branch.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin 057-member-form-redesign
gh pr create --title "fix(members): three pre-existing member-form defects (PR-0)" --body "$(cat <<'EOF'
Groundwork for the member form redesign (spec: `docs/superpowers/specs/2026-07-13-member-form-redesign-design.md` § 12). No schema change, no migration, no new dependencies.

1. **`notes` was discarded on create.** The textarea rendered, the admin typed, and the value never left the browser — `toPayload` omitted it, `createMemberSchema` did not accept it, and the member draft hardcoded `notes: null`.
2. **`registration_date` was discarded on edit.** The field rendered, was seeded from the DB, and was silently dropped on save. It also anchors the F8 renewal cycle, so it is now **read-only** in edit mode with an explanatory hint rather than made editable — re-anchoring is its own use case (deferred).
3. **Nine fields had invisible validation errors.** `legal_entity_type`, `description`, `notes`, the five address fields and `role_title` carried max-length rules but rendered no message, set no `aria-invalid`, and produced no error-summary entry. PR-B makes the address fields required, so this had to land first.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage**: this plan covers spec § 12 (all three pre-existing bugs) in full. Spec §§ 4–11 are PR-A and PR-B and are out of scope here by design.
- **Deliberately not done here**: the entity-type catalogue, `is_vat_registered`, the postcode address, the secondary contact, and the decomposition of `member-form.tsx`. Task 3 touches nine field blocks in the existing file rather than restructuring it — the decomposition belongs to PR-B, where the file grows.
- **Risk**: Task 3 is the only one that could regress an existing a11y assertion, because it adds `aria-describedby` to fields that previously had none. Step 6 of Task 3 runs the axe scan for exactly that reason.
