-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "device_label" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "refresh_token_hash" TEXT NOT NULL,
    "refresh_generation" INTEGER NOT NULL DEFAULT 0,
    "last_refreshed_at" TIMESTAMPTZ(6),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "recovery_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_attempt_counters" (
    "subject_key" TEXT NOT NULL,
    "device_key" TEXT NOT NULL,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "first_failed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_failed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(6),

    CONSTRAINT "auth_attempt_counters_pkey" PRIMARY KEY ("subject_key","device_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_created_at_idx" ON "sessions"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "recovery_tickets_token_hash_key" ON "recovery_tickets"("token_hash");

-- CreateIndex
CREATE INDEX "recovery_tickets_user_id_created_at_idx" ON "recovery_tickets"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_tickets" ADD CONSTRAINT "recovery_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Governance (written together with the DDL above, before first apply —
-- README "Database migrations"): structural identifier validation + the
-- least-privilege grants for the W2 identity tables. RLS is DECLINED for
-- every table in this migration — the per-table adopt/decline decision and
-- rationale is documented in docs/api/wave-02-contract.md §5 and the README
-- "Roles & row-level security" section (ADR-0002 scopes RLS to consumer-owned
-- HEALTH tables; identity tables are non-health and stay on the I1–I3 layers).
-- ---------------------------------------------------------------------------

-- Identifier shape CHECKs (canonical forms; the application canonicalizes
-- before insert — lowercased email/username, E.164 phone).
ALTER TABLE "users" ADD CONSTRAINT "users_username_format" CHECK ("username" ~ '^[a-z0-9_]{3,30}$');
ALTER TABLE "users" ADD CONSTRAINT "users_email_format" CHECK (char_length("email") BETWEEN 3 AND 254 AND position('@' IN "email") > 1);
ALTER TABLE "users" ADD CONSTRAINT "users_phone_format" CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,15}$');
ALTER TABLE "users" ADD CONSTRAINT "users_status_enum" CHECK ("status" IN ('active', 'closure_requested', 'closed'));

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_refresh_token_hash_format" CHECK ("refresh_token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_label_length" CHECK ("device_label" IS NULL OR char_length("device_label") <= 64);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_expiry_after_creation" CHECK ("expires_at" > "created_at");

ALTER TABLE "recovery_tickets" ADD CONSTRAINT "recovery_tickets_token_hash_format" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "recovery_tickets" ADD CONSTRAINT "recovery_tickets_expiry_after_creation" CHECK ("expires_at" > "created_at");

ALTER TABLE "auth_attempt_counters" ADD CONSTRAINT "auth_attempt_counters_failed_count_nonneg" CHECK ("failed_count" >= 0);

-- Least-privilege grants (default-deny posture; every table grants its roles
-- in the migration that creates it — README "Database migrations").
--
-- users: kal_app signs users up (INSERT), reads for sign-in/profile (SELECT),
-- and updates ONLY credential-mutation columns (rehash-on-login). Identity
-- columns (id, email, username, phone, status, created_at) are immutable —
-- no UPDATE grant (I1). kal_platform holds the enumerated export/deletion job
-- shapes only (SELECT + DELETE; never INSERT/UPDATE — ADR-0002 §3).
GRANT SELECT, INSERT ON TABLE "users" TO "kal_app";
GRANT UPDATE ("password_hash", "updated_at") ON TABLE "users" TO "kal_app";
GRANT SELECT, DELETE ON TABLE "users" TO "kal_platform";

-- sessions / recovery_tickets: owned children (I1/I3) — kal_app reads,
-- creates, revokes/consumes, and rotates; the per-plane user_id and the row
-- id have NO UPDATE grant (binding immutable). kal_platform holds the
-- enumerated deletion (account closure) and housekeeping (expired session /
-- ticket cleanup) shapes: SELECT + DELETE only.
GRANT SELECT, INSERT ON TABLE "sessions" TO "kal_app";
GRANT UPDATE ("revoked_at", "refresh_token_hash", "refresh_generation", "last_refreshed_at") ON TABLE "sessions" TO "kal_app";
GRANT SELECT, DELETE ON TABLE "sessions" TO "kal_platform";

GRANT SELECT, INSERT ON TABLE "recovery_tickets" TO "kal_app";
GRANT UPDATE ("consumed_at") ON TABLE "recovery_tickets" TO "kal_app";
GRANT SELECT, DELETE ON TABLE "recovery_tickets" TO "kal_platform";

-- auth_attempt_counters: platform-owned throttle state (not user-owned data —
-- keyed by digests; contract note §3). kal_app upserts and increments
-- atomically on every credential attempt (SELECT/INSERT + counter UPDATE);
-- it never deletes (window reset is an UPDATE). kal_platform holds the
-- retention/housekeeping shape (SELECT + DELETE of stale counters).
GRANT SELECT, INSERT ON TABLE "auth_attempt_counters" TO "kal_app";
GRANT UPDATE ("failed_count", "first_failed_at", "last_failed_at", "locked_until") ON TABLE "auth_attempt_counters" TO "kal_app";
GRANT SELECT, DELETE ON TABLE "auth_attempt_counters" TO "kal_platform";
