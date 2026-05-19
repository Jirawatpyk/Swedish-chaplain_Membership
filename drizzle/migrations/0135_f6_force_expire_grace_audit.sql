-- F6 — add `webhook_secret_force_expired` audit event type.
-- Closes the Principle I sub-clause 5 (audit) gap for the
-- `forceExpireGraceSecret` Application use-case: admin force-expire
-- of a webhook grace secret (incident response when the OLD secret
-- is suspected compromised) now leaves a durable 5-year forensic
-- trail.
--
-- Idempotent DO-block — survives partial-replay (Postgres restriction:
-- enum extensions cannot live in the same tx as their first use).

DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_secret_force_expired'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
