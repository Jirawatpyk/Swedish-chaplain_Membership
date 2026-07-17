# Blob store migration + audit tools (one-off ops)

Tools written during the **2026-07 public Blob store US → Singapore migration**
(Vercel Blob region is chosen at store creation and is **immutable**, so moving
regions means: create a new store in `sin1`, copy the referenced blobs, swap
`BLOB_READ_WRITE_TOKEN`, redeploy).

All scripts are **read-token-from-env** (no secrets committed) and run from the
repo root with Node's `--env-file`:

```bash
node --env-file=.env.production scripts/blob-migration/<script>.mjs
```

They resolve tokens from these env vars (`.env.production`):

- `OLD_BLOB_TOKEN` || `BLOB_READ_WRITE_TOKEN` — source store (US)
- `NEW_BLOB_TOKEN` || `SG_READ_WRITE_TOKEN` — target store (SG)
- `DATABASE_URL` — for the DB-truth audits

## Scripts

| Script | Purpose |
|---|---|
| `audit-all-prod-blobs.mjs` | **The important one.** DB-driven completeness check: every blob key the app references (invoice/receipt/cert PDFs, credit notes, invoice logo, directory logos) + broadcast-image/error-CSV prefixes, vs the target store. Reports permanent data missing. |
| `check-invoice-keys-prod.mjs` | Count real invoices from the DB + which invoice/logo keys are missing from the target. |
| `check-invoice-logo.mjs` | Confirm the tenant invoice logo blob is present in both stores. |
| `verify-sg-serves.mjs` | Fetch a few real invoice PDFs from the target store to confirm it serves content (HTTP 200). |
| `migrate-blob-us-to-sg.mjs` | Copy blobs source → target, preserving keys. Resumable (skips existing), retries throttle, `REAL_ONLY` (tenant `swecham`) by default, `--all` to copy everything, `--dry-run` to count. |
| `verify-blob-migration.mjs` | Prefix-based US-vs-SG coverage of the `swecham` tenant. |
| `diff-stores.mjs` | Symmetric set difference between the two stores. |
| `probe-blob.mjs` | Diagnose a blob's public-fetch status (used to spot the store suspension). |
| `test-copy.mjs` | Probe whether `copy()` works cross-store (it does **not** — copy is intra-store only). |

## Lessons (why this exists)

- **Copy only what the DB references (~161 keys), never the whole store.** Blindly
  fetching every blob (~2,300, incl. E2E test junk) from a local machine
  triggered a Vercel Blob **store suspension** (usage/abuse) → a production
  incident (invoice downloads 403). Drive from the DB; keep the request rate low.
- **`copy()` is intra-store only** — cross-store must download+upload (or use the
  DB-referenced subset so it's tiny).
- **Region is immutable + defaults to US.** Always select **Singapore (`sin1`)**
  at store creation (requires Pro). See `docs/runbooks/go-live-operator-gates.md` §6b.
