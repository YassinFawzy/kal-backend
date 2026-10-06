-- Kal foundation — database roles, least-privilege grants, and the RLS pilot
-- (Wave 1, lane s1-schema). Authority: ADR-0002 (narrow, fail-closed RLS on
-- consumer-owned health tables), ARCHITECTURE.md §4 (I1–I7, I14), §11, §15.
--
-- This migration is RE-RUN SAFE across databases of the same cluster: roles are
-- cluster-scoped while Prisma tracks migrations per database, so role creation
-- is guarded (a second database in the same cluster must still apply cleanly —
-- the s4 adversarial harness creates ephemeral databases per test).
--
-- Role model:
--   kal_app       — request-scope application role. Least privilege. Subject to
--                   RLS on health tables. NOLOGIN: connections assume it via
--                   SET ROLE (per session/transaction) — see README
--                   "Roles & row-level security". Never a superuser.
--   kal_platform  — platform-scope bypass role for ENUMERATED cross-owner jobs
--                   (export/deletion, retention, sync housekeeping; later: feed
--                   assembly, settlement). Bypass is explicit and per-table via
--                   exemption policies below — never via superuser/BYPASSRLS.
--                   Never reachable from request-scope code paths (ADR-0002 §3).
--   (Superusers bypass RLS unconditionally — they are for migrations and
--   break-glass only, never for asserting or relying on RLS behavior.)

-- ---------------------------------------------------------------------------
-- Roles (cluster-scoped; guarded for multi-database applies)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kal_app') THEN
    CREATE ROLE kal_app NOLOGIN NOINHERIT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kal_platform') THEN
    CREATE ROLE kal_platform NOLOGIN NOINHERIT;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Least-privilege grants (per-database)
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO kal_app, kal_platform;

-- weight_log (consumer-owned health table; RLS pilot)
GRANT SELECT, INSERT, DELETE ON TABLE weight_log TO kal_app;
-- owner_id is IMMUTABLE: UPDATE is granted per-column, excluding owner_id (I1).
GRANT UPDATE (recorded_at, weight_kg) ON TABLE weight_log TO kal_app;

-- Cross-owner job shapes only (ADR-0002 §3): platform reads for export,
-- deletes for account deletion. No INSERT/UPDATE — platform jobs never
-- fabricate or rewrite user data.
GRANT SELECT, DELETE ON TABLE weight_log TO kal_platform;

-- audit_events (platform-owned, append-only — I14). Both service scopes may
-- append and read back through the sanctioned audit service; NOBODY gets
-- UPDATE/DELETE, and the trigger below enforces it even against the owner.
GRANT SELECT, INSERT ON TABLE audit_events TO kal_app;
GRANT SELECT, INSERT ON TABLE audit_events TO kal_platform;

-- Future tables: each migration that creates a table MUST grant its roles in
-- the same migration (pattern documented in README "Migration workflow").

-- ---------------------------------------------------------------------------
-- audit_events — structural append-only enforcement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kal_forbid_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (ARCHITECTURE I14): % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION kal_forbid_audit_mutation();

-- ---------------------------------------------------------------------------
-- RLS pilot on weight_log — fail-closed (ADR-0002 §2)
-- ---------------------------------------------------------------------------
ALTER TABLE weight_log ENABLE ROW LEVEL SECURITY;
-- FORCE: RLS applies to the table owner too, so an accidental owner-classed
-- connection cannot casually browse health data. (Superusers still bypass —
-- documented and accepted for migrations only.)
ALTER TABLE weight_log FORCE ROW LEVEL SECURITY;

-- Owner policy: a row is visible/mutable only when the transaction-local GUC
-- `app.current_owner` equals the row's owner_id. `current_setting(..., true)`
-- returns NULL when the GUC is unset ⇒ NULL ⇒ no rows, ever (fail-closed, I2).
-- A malformed value raises a cast error — also fail-closed (error, not leak).
-- FOR ALL covers SELECT/INSERT/UPDATE/DELETE; WITH CHECK blocks writing a row
-- whose owner_id differs from the context (so owner_id cannot be moved at all:
-- the USING side of UPDATE rejects the old row, WITH CHECK rejects the new).
CREATE POLICY weight_log_owner_context ON weight_log
  AS PERMISSIVE
  FOR ALL
  TO kal_app
  USING (owner_id = current_setting('app.current_owner', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.current_owner', true)::uuid);

-- Platform-scope exemptions — explicit, per-table, operation-narrow
-- (ADR-0002 §3): export (SELECT) and account-deletion (DELETE) jobs only.
CREATE POLICY weight_log_platform_export ON weight_log
  AS PERMISSIVE
  FOR SELECT
  TO kal_platform
  USING (true);

CREATE POLICY weight_log_platform_deletion ON weight_log
  AS PERMISSIVE
  FOR DELETE
  TO kal_platform
  USING (true);
