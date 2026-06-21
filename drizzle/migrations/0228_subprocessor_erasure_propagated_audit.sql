-- COMP-1 US3-C — best-effort sub-processor erasure propagation audit type.
-- ADD VALUE is transactional-safe in PG16; IF NOT EXISTS makes a re-apply a no-op.
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'subprocessor_erasure_propagated';
