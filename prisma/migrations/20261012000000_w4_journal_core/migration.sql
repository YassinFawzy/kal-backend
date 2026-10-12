-- Wave 4 — journal core (lane w04-s1-schema). Contract:
-- docs/api/wave-04-contract.md (frozen 2026-10-12). Forward-only; extends
-- the 10-migration history to 11; no `db push`.
--
-- Structure (mirrors the w3_tracking_sync_core migration exactly):
--   1. DDL — platform exercise catalog + consumer-owned journal tables.
--   2. Indexes + compound user references (I3) + foreign keys (RESTRICT).
--   3. Governance — per-table RLS adopt/decline (ADR-0002; decisions
--      documented in the contract note §5, never implied), identifier/shape
--      CHECKs, least-privilege grants.
--   4. sync_operations entity-kind registry widening — the additive `w4`
--      change (conventions §0): kinds `journal_session` and `journal_routine`
--      join the frozen registry; the local-date parity rule extends to the
--      session kind (client-local session date rides the op; routines carry
--      no day). The dropped constraints are replaced, never edited in place.

-- CreateTable
CREATE TABLE "exercises" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en_normalized" TEXT NOT NULL,
    "name_ar_normalized" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL,
    "aliases_normalized" TEXT[] NOT NULL,
    "instructions_en" TEXT NOT NULL,
    "instructions_ar" TEXT NOT NULL,
    "muscle_groups" TEXT[] NOT NULL,
    "tags" TEXT[] NOT NULL,
    "provenance" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exercises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "title" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "last_op_id" UUID,

    CONSTRAINT "journal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_session_exercises" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "exercise_id" UUID NOT NULL,
    "name_snapshot_en" TEXT NOT NULL,
    "name_snapshot_ar" TEXT,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "journal_session_exercises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_exercise_sets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_exercise_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "weight_kg" DECIMAL(9,3),
    "reps" INTEGER,
    "duration_seconds" INTEGER,
    "notes_text" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "journal_exercise_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_routines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "last_op_id" UUID,

    CONSTRAINT "journal_routines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_routine_exercises" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "routine_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "exercise_id" UUID NOT NULL,
    "name_snapshot_en" TEXT NOT NULL,
    "name_snapshot_ar" TEXT,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "journal_routine_exercises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_routine_sets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "routine_exercise_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "weight_kg" DECIMAL(9,3),
    "reps" INTEGER,
    "duration_seconds" INTEGER,
    "notes_text" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "journal_routine_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_training_days" (
    "user_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "marked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_training_days_pkey" PRIMARY KEY ("user_id", "local_date")
);

-- CreateTable
CREATE TABLE "journal_session_create_counters" (
    "user_id" UUID NOT NULL,
    "hour_window_start" TIMESTAMPTZ(6) NOT NULL,
    "hour_count" INTEGER NOT NULL DEFAULT 0,
    "day_window_start" TIMESTAMPTZ(6) NOT NULL,
    "day_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "journal_session_create_counters_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "journal_sessions_id_user_id_key" ON "journal_sessions"("id", "user_id");
CREATE INDEX "journal_sessions_user_id_local_date_idx" ON "journal_sessions"("user_id", "local_date");
CREATE INDEX "journal_sessions_user_id_updated_at_idx" ON "journal_sessions"("user_id", "updated_at");

CREATE UNIQUE INDEX "journal_session_exercises_id_user_id_key" ON "journal_session_exercises"("id", "user_id");
CREATE INDEX "journal_session_exercises_session_id_idx" ON "journal_session_exercises"("session_id");

CREATE UNIQUE INDEX "journal_exercise_sets_id_user_id_key" ON "journal_exercise_sets"("id", "user_id");
CREATE INDEX "journal_exercise_sets_session_exercise_id_idx" ON "journal_exercise_sets"("session_exercise_id");

CREATE UNIQUE INDEX "journal_routines_id_user_id_key" ON "journal_routines"("id", "user_id");
CREATE INDEX "journal_routines_user_id_updated_at_idx" ON "journal_routines"("user_id", "updated_at");

CREATE UNIQUE INDEX "journal_routine_exercises_id_user_id_key" ON "journal_routine_exercises"("id", "user_id");
CREATE INDEX "journal_routine_exercises_routine_id_idx" ON "journal_routine_exercises"("routine_id");

CREATE UNIQUE INDEX "journal_routine_sets_id_user_id_key" ON "journal_routine_sets"("id", "user_id");
CREATE INDEX "journal_routine_sets_routine_exercise_id_idx" ON "journal_routine_sets"("routine_exercise_id");

-- AddForeignKey (all ON DELETE RESTRICT — deletion is always an explicit job
-- that resolves children itself; the W3 posture).
ALTER TABLE "journal_sessions" ADD CONSTRAINT "journal_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_session_exercises" ADD CONSTRAINT "journal_session_exercises_session_id_user_id_fkey" FOREIGN KEY ("session_id", "user_id") REFERENCES "journal_sessions"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_session_exercises" ADD CONSTRAINT "journal_session_exercises_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_exercise_sets" ADD CONSTRAINT "journal_exercise_sets_session_exercise_id_user_id_fkey" FOREIGN KEY ("session_exercise_id", "user_id") REFERENCES "journal_session_exercises"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_routines" ADD CONSTRAINT "journal_routines_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_routine_exercises" ADD CONSTRAINT "journal_routine_exercises_routine_id_user_id_fkey" FOREIGN KEY ("routine_id", "user_id") REFERENCES "journal_routines"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_routine_exercises" ADD CONSTRAINT "journal_routine_exercises_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_routine_sets" ADD CONSTRAINT "journal_routine_sets_routine_exercise_id_user_id_fkey" FOREIGN KEY ("routine_exercise_id", "user_id") REFERENCES "journal_routine_exercises"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_training_days" ADD CONSTRAINT "journal_training_days_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_session_create_counters" ADD CONSTRAINT "journal_session_create_counters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Governance (written together with the DDL above, before first apply —
-- README "Database migrations"). Contract: docs/api/wave-04-contract.md.
--
-- RLS adopt/decline per table (ADR-0002; the per-table decision + rationale
-- is documented in the contract note §5 — decisions are written, never
-- implied):
--   ADOPT (consumer-owned health tables, fail-closed app.user_id policy,
--   weight_log pilot pattern): journal_sessions, journal_session_exercises,
--   journal_exercise_sets, journal_routines, journal_routine_exercises,
--   journal_routine_sets, journal_training_days (health-DERIVED projection
--   — a training-day flag is behavioral health data; a leak is exactly as
--   sensitive as the sessions it projects).
--   DECLINE (platform catalog, not user-scoped): exercises — same posture
--   as foods (every authenticated consumer reads the same governed rows);
--   DECLINE (platform abuse-control state): journal_session_create_counters
--   — same posture as user_food_create_counters (ARCHITECTURE §11 places
--   rate-limit counters on the platform plane; only the owning account's
--   context can ever touch its row).
-- Platform-scope bypass: NONE this wave — no cross-account job exists in W4
-- (the w3 ledger §6 posture stands); exemption policies + grants land
-- together with the first enumerated job, never as inert grant-without-
-- policy pairs.
-- ---------------------------------------------------------------------------

-- Identifier/shape CHECKs (canonical forms; the write path validates before
-- insert — the database is the last line, not the only one).
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_provenance_enum" CHECK ("provenance" IN ('kal_reviewed'));
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_names_length" CHECK (char_length("name_en") BETWEEN 1 AND 200 AND char_length("name_ar") BETWEEN 1 AND 200);
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_names_normalized_length" CHECK (char_length("name_en_normalized") BETWEEN 1 AND 200 AND char_length("name_ar_normalized") BETWEEN 1 AND 200);
-- Element-wise parity: every alias has exactly one normalized form (the
-- wave-03 §7 pipeline is applied element-wise at write time).
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_aliases_parity" CHECK (array_length("aliases", 1) = array_length("aliases_normalized", 1));
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_instructions_length" CHECK (char_length("instructions_en") BETWEEN 1 AND 2000 AND char_length("instructions_ar") BETWEEN 1 AND 2000);
-- Minimal display-only taxonomy: cardinality bounds (empty arrays allowed;
-- element-length 1..40 is a write-path/manifest rule — PostgreSQL CHECKs
-- cannot contain subqueries, so per-element checks live above the database).
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_taxonomy_cardinality" CHECK (
  (array_length("muscle_groups", 1) IS NULL OR array_length("muscle_groups", 1) BETWEEN 1 AND 20)
  AND (array_length("tags", 1) IS NULL OR array_length("tags", 1) BETWEEN 1 AND 20)
  AND (array_length("aliases", 1) IS NULL OR array_length("aliases", 1) BETWEEN 1 AND 20)
);

ALTER TABLE "journal_sessions" ADD CONSTRAINT "journal_sessions_title_length" CHECK ("title" IS NULL OR char_length("title") BETWEEN 1 AND 120);

ALTER TABLE "journal_session_exercises" ADD CONSTRAINT "journal_session_exercises_position_nonneg" CHECK ("position" >= 0);
ALTER TABLE "journal_session_exercises" ADD CONSTRAINT "journal_session_exercises_snapshot_length" CHECK (
  char_length("name_snapshot_en") BETWEEN 1 AND 200
  AND ("name_snapshot_ar" IS NULL OR char_length("name_snapshot_ar") BETWEEN 1 AND 200)
);

-- Set-format discriminated XOR (w4 note §1): weighted (weight kg > 0 ≤ 1000
-- + reps 1..1000), timed (duration 1..86400 s), notes (free text 1..500) —
-- exactly the contract validation bounds; mixed formats coexist ACROSS rows
-- of one session, never within one row.
ALTER TABLE "journal_exercise_sets" ADD CONSTRAINT "journal_exercise_sets_format_enum" CHECK ("format" IN ('weighted', 'timed', 'notes'));
ALTER TABLE "journal_exercise_sets" ADD CONSTRAINT "journal_exercise_sets_position_nonneg" CHECK ("position" >= 0);
ALTER TABLE "journal_exercise_sets" ADD CONSTRAINT "journal_exercise_sets_format_parity" CHECK (
  (
    "format" = 'weighted'
    AND "weight_kg" IS NOT NULL AND "weight_kg" > 0 AND "weight_kg" <= 1000
    AND "reps" IS NOT NULL AND "reps" BETWEEN 1 AND 1000
    AND "duration_seconds" IS NULL AND "notes_text" IS NULL
  )
  OR (
    "format" = 'timed'
    AND "duration_seconds" IS NOT NULL AND "duration_seconds" BETWEEN 1 AND 86400
    AND "weight_kg" IS NULL AND "reps" IS NULL AND "notes_text" IS NULL
  )
  OR (
    "format" = 'notes'
    AND "notes_text" IS NOT NULL AND char_length("notes_text") BETWEEN 1 AND 500
    AND "weight_kg" IS NULL AND "reps" IS NULL AND "duration_seconds" IS NULL
  )
);

ALTER TABLE "journal_routines" ADD CONSTRAINT "journal_routines_name_length" CHECK (char_length("name") BETWEEN 1 AND 120);

ALTER TABLE "journal_routine_exercises" ADD CONSTRAINT "journal_routine_exercises_position_nonneg" CHECK ("position" >= 0);
ALTER TABLE "journal_routine_exercises" ADD CONSTRAINT "journal_routine_exercises_snapshot_length" CHECK (
  char_length("name_snapshot_en") BETWEEN 1 AND 200
  AND ("name_snapshot_ar" IS NULL OR char_length("name_snapshot_ar") BETWEEN 1 AND 200)
);

ALTER TABLE "journal_routine_sets" ADD CONSTRAINT "journal_routine_sets_format_enum" CHECK ("format" IN ('weighted', 'timed', 'notes'));
ALTER TABLE "journal_routine_sets" ADD CONSTRAINT "journal_routine_sets_position_nonneg" CHECK ("position" >= 0);
ALTER TABLE "journal_routine_sets" ADD CONSTRAINT "journal_routine_sets_format_parity" CHECK (
  (
    "format" = 'weighted'
    AND "weight_kg" IS NOT NULL AND "weight_kg" > 0 AND "weight_kg" <= 1000
    AND "reps" IS NOT NULL AND "reps" BETWEEN 1 AND 1000
    AND "duration_seconds" IS NULL AND "notes_text" IS NULL
  )
  OR (
    "format" = 'timed'
    AND "duration_seconds" IS NOT NULL AND "duration_seconds" BETWEEN 1 AND 86400
    AND "weight_kg" IS NULL AND "reps" IS NULL AND "notes_text" IS NULL
  )
  OR (
    "format" = 'notes'
    AND "notes_text" IS NOT NULL AND char_length("notes_text") BETWEEN 1 AND 500
    AND "weight_kg" IS NULL AND "reps" IS NULL AND "duration_seconds" IS NULL
  )
);

ALTER TABLE "journal_session_create_counters" ADD CONSTRAINT "journal_session_create_counters_nonneg" CHECK ("hour_count" >= 0 AND "day_count" >= 0);

-- The `w4` entity-kind registry widening (additive change package,
-- conventions §0): `journal_session` and `journal_routine` join the frozen
-- w3 kinds; the local-date parity rule extends to journal_session ops (the
-- client-local session date rides the op — day-boundary rule §1.8
-- inherited; routines carry NO day). Constraints are REPLACED (drop +
-- re-add), never edited in place; the w3 text is preserved in this history.
ALTER TABLE "sync_operations" DROP CONSTRAINT "sync_operations_entity_kind_enum";
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_entity_kind_enum" CHECK ("entity_kind" IN ('diary_entry', 'user_food', 'favorite', 'journal_session', 'journal_routine'));
ALTER TABLE "sync_operations" DROP CONSTRAINT "sync_operations_local_date_parity";
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_local_date_parity" CHECK (("entity_kind" IN ('diary_entry', 'journal_session')) = ("local_date" IS NOT NULL));

-- Least-privilege grants (default-deny posture; every table grants its roles
-- in the migration that creates it — README "Database migrations").
--
-- Platform catalog (RLS declined — platform-owned, not user-scoped): the
-- governed exercise catalog is readable by every authenticated consumer
-- (catalog search/detail) and by the platform plane (curation).
GRANT SELECT ON TABLE "exercises" TO "kal_app";
GRANT SELECT ON TABLE "exercises" TO "kal_platform";

-- Consumer-owned health tables (RLS ADOPTED below). kal_app works strictly
-- inside the requesting user's context (app.user_id GUC + SET ROLE):
--   journal_sessions: written ONLY by sync ingestion (no journal REST
--     mutation surface exists — contract note §1). Update covers session
--     edits (LWW full snapshot: title/day move + tombstone/op columns);
--     id, user_id, created_at immutable (no UPDATE grant — I1); no DELETE
--     (tombstones are soft deletes).
GRANT SELECT, INSERT ON TABLE "journal_sessions" TO "kal_app";
GRANT UPDATE ("local_date", "title", "updated_at", "deleted_at", "last_op_id") ON TABLE "journal_sessions" TO "kal_app";
--   journal_session_exercises / journal_exercise_sets: full-snapshot update
--   ops replace the child set (the W3 serving-set pattern: soft-delete the
--   superseded rows, insert the new set); content columns carry UPDATE so
--   handlers may upsert-in-place — observables are identical either way.
--   Snapshots are frozen per apply (an edit is a new log event).
GRANT SELECT, INSERT ON TABLE "journal_session_exercises" TO "kal_app";
GRANT UPDATE ("name_snapshot_en", "name_snapshot_ar", "position", "updated_at", "deleted_at") ON TABLE "journal_session_exercises" TO "kal_app";
GRANT SELECT, INSERT ON TABLE "journal_exercise_sets" TO "kal_app";
GRANT UPDATE ("position", "format", "weight_kg", "reps", "duration_seconds", "notes_text", "updated_at", "deleted_at") ON TABLE "journal_exercise_sets" TO "kal_app";
--   journal_routines + children: routine create/edit via sync ops.
GRANT SELECT, INSERT ON TABLE "journal_routines" TO "kal_app";
GRANT UPDATE ("name", "updated_at", "deleted_at", "last_op_id") ON TABLE "journal_routines" TO "kal_app";
GRANT SELECT, INSERT ON TABLE "journal_routine_exercises" TO "kal_app";
GRANT UPDATE ("name_snapshot_en", "name_snapshot_ar", "position", "updated_at", "deleted_at") ON TABLE "journal_routine_exercises" TO "kal_app";
GRANT SELECT, INSERT ON TABLE "journal_routine_sets" TO "kal_app";
GRANT UPDATE ("position", "format", "weight_kg", "reps", "duration_seconds", "notes_text", "updated_at", "deleted_at") ON TABLE "journal_routine_sets" TO "kal_app";
--   journal_training_days: derived projection maintained by the session
--   apply handlers inside the user's context. Rows are INSERT-only and
--   removed (hard DELETE) when the day's last active session disappears —
--   the one documented DELETE grant on an owned table: a derived cache is
--   not history (contract note §5); there is no tombstone semantics to
--   preserve, and the projection must stay exact (∃ active session ⇔ row).
GRANT SELECT, INSERT, DELETE ON TABLE "journal_training_days" TO "kal_app";
--   journal_session_create_counters: the shared limiter ticks the sync-apply
--   path for the authenticated account only.
GRANT SELECT, INSERT ON TABLE "journal_session_create_counters" TO "kal_app";
GRANT UPDATE ("hour_window_start", "hour_count", "day_window_start", "day_count") ON TABLE "journal_session_create_counters" TO "kal_app";
-- kal_platform on ADOPTED tables: NONE this wave — no cross-account job
-- exists in W4; grant-without-policy would be inert noise. The W1
-- weight_log export/deletion exemptions remain the standing pattern.

-- ---------------------------------------------------------------------------
-- Fail-closed RLS — ADOPTED journal health tables (ADR-0002 §2; weight_log
-- pattern: ENABLE + FORCE + per-role policy keyed on the transaction-local
-- app.user_id GUC; unset ⇒ NULL ⇒ zero rows, ever; malformed ⇒ cast error ⇒
-- fail closed; WITH CHECK pins the user binding on writes).
-- ---------------------------------------------------------------------------

ALTER TABLE "journal_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "journal_sessions_user_context" ON "journal_sessions"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);

ALTER TABLE "journal_session_exercises" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_session_exercises" FORCE ROW LEVEL SECURITY;
CREATE POLICY "journal_session_exercises_user_context" ON "journal_session_exercises"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);

ALTER TABLE "journal_exercise_sets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_exercise_sets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "journal_exercise_sets_user_context" ON "journal_exercise_sets"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);

ALTER TABLE "journal_routines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_routines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "journal_routines_user_context" ON "journal_routines"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);

ALTER TABLE "journal_routine_exercises" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_routine_exercises" FORCE ROW LEVEL SECURITY;
CREATE POLICY "journal_routine_exercises_user_context" ON "journal_routine_exercises"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);

ALTER TABLE "journal_routine_sets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_routine_sets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "journal_routine_sets_user_context" ON "journal_routine_sets"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);

ALTER TABLE "journal_training_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_training_days" FORCE ROW LEVEL SECURITY;
CREATE POLICY "journal_training_days_user_context" ON "journal_training_days"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);
