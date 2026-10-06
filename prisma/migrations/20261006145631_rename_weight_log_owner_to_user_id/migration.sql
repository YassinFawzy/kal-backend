-- Kal foundation — founder-directed rename (ledger §10, 2026-10-06): the
-- per-person column on consumer tables is `user_id`, never `owner_id`
-- (per-plane ids: consumers user_id, vendors vendor_id, drivers
-- driver_user_id, admins admin_id — ARCHITECTURE I1). Pre-gate-acceptance,
-- zero consumers; merged migrations stay immutable, so this is a FORWARD-FIX.
--
-- Three facts make a full policy recreation necessary rather than an in-place
-- edit:
--   1. `ALTER TABLE ... RENAME COLUMN` does NOT rewrite the GUC name string
--      inside a policy expression — `current_setting('app.current_owner',
--      true)` would keep reading the OLD, never-set variable and the policy
--      would fail closed forever (zero rows for everyone). The policy MUST be
--      recreated against `app.user_id`.
--   2. Policies cannot be ALTERed to change their expression or name.
--   3. The policy name itself carries the retired vocabulary
--      (weight_log_owner_context → weight_log_user_context).
-- Drop + CREATE is the sanctioned pattern (pg_policies must introspect the new
-- expression — see README "Roles & row-level security").
--
-- The platform exemption policies (weight_log_platform_export /
-- weight_log_platform_deletion) are UNAFFECTED: their expressions are `true`,
-- they reference no column, and a column rename does not touch them — they
-- are deliberately not re-created here.
-- Column-level grants are UNAFFECTED: the UPDATE grant already excludes the
-- id column by name-listing only data columns (recorded_at, weight_kg), and
-- table-level SELECT/INSERT/DELETE grants survive a column rename.

ALTER TABLE weight_log RENAME COLUMN owner_id TO user_id;

ALTER INDEX weight_log_owner_id_recorded_at_idx RENAME TO weight_log_user_id_recorded_at_idx;

DROP POLICY weight_log_owner_context ON weight_log;

CREATE POLICY weight_log_user_context ON weight_log
  AS PERMISSIVE
  FOR ALL
  TO kal_app
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);
