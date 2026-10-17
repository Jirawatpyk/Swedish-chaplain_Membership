---
paths:
  - "src/modules/broadcasts/**"
  - "src/app/(staff)/admin/broadcasts/**"
  - "src/app/(staff)/admin/marketing/**"
  - "src/app/(member)/portal/broadcasts/**"
  - "src/app/api/webhooks/resend-broadcasts/**"
  - "src/components/broadcast/**"
  - "tests/**/broadcasts/**"
  - "tests/**/broadcast/**"
---

# Broadcasts / E-Blast (F7 `010-email-broadcast` + `014-email-broadcast-advance`, F119)

- **Stack added**: 4 aggregates (Broadcast / BroadcastDelivery / MarketingUnsubscribe / RecipientSegment) · Tiptap@3.22.5 + isomorphic-dompurify@2.36.0 (both exact-pin) + email-validator@^2 + @tanstack/react-virtual@^3.
- **The Resend Broadcasts surface is separate from F1/F4 transactional** — its own API key, suppression list, webhook endpoint and reputation pool; the webhook is pinned to the Node runtime for Svix HMAC raw-body verification. Env `RESEND_BROADCASTS_API_KEY` + `RESEND_BROADCASTS_WEBHOOK_SECRET` + `UNSUBSCRIBE_TOKEN_SECRET` (≥32 bytes, distinct from `AUTH_COOKIE_SIGNING_SECRET`) + `BROADCASTS_FROM_EMAIL` + `FEATURE_F7_BROADCASTS`. Resend's `Idempotency-Key` is inert on `POST /broadcasts`.
- **Content rules**: sanitiser allowlist (FR-002a) is `p`/`br`/`strong`/`em`/`u`/`a[href]`/`ul`/`ol`/`li`/`h1-h4`/`blockquote`/`hr`, schemes `http`/`https`/`mailto`, **no `<img>`** (F119 images go through the separate image allowlist); subject ≤200, body ≤200 KB; applied in Application and the raw body is never persisted.
- **State rules**: quota reserves at `submitted` and consumes at `sending→sent`, with `currentQuotaYear` in the tenant's TZ. Immutable after submit (DB trigger `broadcasts_immutable_after_submit_fn`, replaced in `0308` — the state-machine ELSE is fail-closed). F119's approval round (`FEATURE_EBLAST_MEMBER_APPROVAL`) is documented in `docs/runbooks/eblast-approval.md`.
- **Audience ceiling**: 500 recipients per tick (`DELIVERABLE_RECIPIENTS_PER_TICK`) unless `FEATURE_F7_IMPORT_AUDIENCE` is ON; the Resend account is on the Free plan (1,000 contacts, 3 segments), so at most two broadcasts can be in flight.
- SLO budgets are still **UNVERIFIED** against prod RUM: compose TTFB <600 ms · submit <1.2 s · queue <500 ms @1k · approve&send <1.5 s · webhook <250 ms · unsubscribe <400 ms.
