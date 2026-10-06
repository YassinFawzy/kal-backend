-- Kal foundation — deterministic database-role contract (Wave 1, lane s1-schema).
--
-- Roles are CLUSTER-scoped while Prisma tracks migrations per database, so
-- roles can pre-exist when this history runs (the bootstrap machine had both
-- names before this migration, with benign defaults and unknown provenance).
-- Creation in `roles_rls_pilot` is therefore guarded — but a guard that only
-- skips creation never validates attributes, which would be fail-open if a
-- pre-existing role carried unsafe settings in some other environment.
--
-- This migration ASSERTS the full least-privilege contract on both roles,
-- idempotently and deterministically, whatever created them (ARCHITECTURE
-- I5/I15 hygiene; ADR-0002: the platform bypass is per-table policy, never a
-- role attribute):
--   NOLOGIN        group roles, assumed via SET ROLE only (see README)
--   NOSUPERUSER    superusers bypass RLS unconditionally — must never hold
--                  the request-scope or platform-scope role
--   NOBYPASSRLS    the platform exemption is explicit policy per table, not
--                  an unconditional attribute
--   NOCREATEDB/NOCREATEROLE/NOREPLICATION   no DDL or replication rights
--   NOINHERIT      privileges never arrive implicitly via memberships; code
--                  must SET ROLE explicitly (fail-closed posture, I2)
ALTER ROLE kal_app
  WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE kal_platform
  WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
