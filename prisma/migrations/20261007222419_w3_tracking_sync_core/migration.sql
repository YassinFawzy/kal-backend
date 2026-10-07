-- CreateTable
CREATE TABLE "foods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "license_partition" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT,
    "name_en_normalized" TEXT NOT NULL,
    "name_ar_normalized" TEXT,
    "aliases" TEXT[],
    "aliases_normalized" TEXT[],
    "barcode" TEXT,
    "energy_kcal" DECIMAL(9,2) NOT NULL,
    "protein_g" DECIMAL(9,3) NOT NULL,
    "carbs_g" DECIMAL(9,3) NOT NULL,
    "fat_g" DECIMAL(9,3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "foods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serving_variants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "food_id" UUID NOT NULL,
    "label_en" TEXT NOT NULL,
    "label_ar" TEXT,
    "grams" DECIMAL(9,3) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "serving_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "barcode_product_cache" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "barcode" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "food_id" UUID,
    "payload" JSONB,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barcode_product_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_foods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name_en" TEXT,
    "name_ar" TEXT,
    "name_en_normalized" TEXT,
    "name_ar_normalized" TEXT,
    "energy_kcal" DECIMAL(9,2) NOT NULL,
    "protein_g" DECIMAL(9,3) NOT NULL,
    "carbs_g" DECIMAL(9,3) NOT NULL,
    "fat_g" DECIMAL(9,3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "last_op_id" UUID,

    CONSTRAINT "user_foods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_food_servings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_food_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "label_en" TEXT,
    "label_ar" TEXT,
    "grams" DECIMAL(9,3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_food_servings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_food_create_counters" (
    "user_id" UUID NOT NULL,
    "hour_window_start" TIMESTAMPTZ(6) NOT NULL,
    "hour_count" INTEGER NOT NULL DEFAULT 0,
    "day_window_start" TIMESTAMPTZ(6) NOT NULL,
    "day_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "user_food_create_counters_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "diary_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "meal_slot" TEXT NOT NULL,
    "entry_method" TEXT NOT NULL,
    "food_id" UUID,
    "user_food_id" UUID,
    "quantity" DECIMAL(9,3) NOT NULL,
    "serving_label_en" TEXT,
    "serving_label_ar" TEXT,
    "serving_gram_weight" DECIMAL(9,3),
    "energy_kcal" DECIMAL(9,2) NOT NULL,
    "protein_g" DECIMAL(9,3) NOT NULL,
    "carbs_g" DECIMAL(9,3) NOT NULL,
    "fat_g" DECIMAL(9,3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "last_op_id" UUID,

    CONSTRAINT "diary_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diary_days" (
    "user_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "energy_kcal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "protein_g" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "carbs_g" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "fat_g" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "entry_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diary_days_pkey" PRIMARY KEY ("user_id","local_date")
);

-- CreateTable
CREATE TABLE "favorites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "food_id" UUID,
    "user_food_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "last_op_id" UUID,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "client_op_id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "entity_kind" TEXT NOT NULL,
    "entity_action" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "local_date" DATE,
    "client_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB,
    "outcome" TEXT NOT NULL,
    "rejection_code" TEXT,
    "retryable" BOOLEAN,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_digest" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "foods_barcode_key" ON "foods"("barcode");

-- CreateIndex
CREATE INDEX "foods_name_ar_normalized_idx" ON "foods"("name_ar_normalized");

-- CreateIndex
CREATE INDEX "foods_name_en_normalized_idx" ON "foods"("name_en_normalized");

-- CreateIndex
CREATE INDEX "serving_variants_food_id_idx" ON "serving_variants"("food_id");

-- CreateIndex
CREATE UNIQUE INDEX "barcode_product_cache_barcode_key" ON "barcode_product_cache"("barcode");

-- CreateIndex
CREATE INDEX "user_foods_user_id_updated_at_idx" ON "user_foods"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_foods_id_user_id_key" ON "user_foods"("id", "user_id");

-- CreateIndex
CREATE INDEX "user_food_servings_user_food_id_idx" ON "user_food_servings"("user_food_id");

-- CreateIndex
CREATE INDEX "diary_entries_user_id_local_date_idx" ON "diary_entries"("user_id", "local_date");

-- CreateIndex
CREATE INDEX "diary_entries_user_id_updated_at_idx" ON "diary_entries"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "diary_entries_id_user_id_key" ON "diary_entries"("id", "user_id");

-- CreateIndex
CREATE INDEX "favorites_user_id_updated_at_idx" ON "favorites"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_id_user_id_key" ON "favorites"("id", "user_id");

-- CreateIndex
CREATE INDEX "sync_operations_user_id_entity_kind_entity_id_idx" ON "sync_operations"("user_id", "entity_kind", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_operations_user_id_client_op_id_key" ON "sync_operations"("user_id", "client_op_id");

-- CreateIndex
CREATE INDEX "sync_idempotency_keys_user_id_created_at_idx" ON "sync_idempotency_keys"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sync_idempotency_keys_user_id_endpoint_idempotency_key_key" ON "sync_idempotency_keys"("user_id", "endpoint", "idempotency_key");

-- AddForeignKey
ALTER TABLE "serving_variants" ADD CONSTRAINT "serving_variants_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "foods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcode_product_cache" ADD CONSTRAINT "barcode_product_cache_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "foods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_foods" ADD CONSTRAINT "user_foods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_food_servings" ADD CONSTRAINT "user_food_servings_user_food_id_user_id_fkey" FOREIGN KEY ("user_food_id", "user_id") REFERENCES "user_foods"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_food_create_counters" ADD CONSTRAINT "user_food_create_counters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "foods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_user_food_id_user_id_fkey" FOREIGN KEY ("user_food_id", "user_id") REFERENCES "user_foods"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diary_days" ADD CONSTRAINT "diary_days_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "foods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_food_id_user_id_fkey" FOREIGN KEY ("user_food_id", "user_id") REFERENCES "user_foods"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_idempotency_keys" ADD CONSTRAINT "sync_idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Governance (written together with the DDL above, before first apply —
-- README "Database migrations"). Contract: docs/api/wave-03-contract.md.
--
-- RLS adopt/decline per table (ADR-0002; the per-table decision + rationale
-- is documented in the contract note §5 — decisions are written, never
-- implied):
--   ADOPT (consumer-owned health tables, fail-closed app.user_id policy,
--   weight_log pilot pattern): user_foods, user_food_servings,
--   diary_entries, diary_days, favorites, sync_operations (its payload
--   mirrors diary/user-food content — a leak is exactly as catastrophic).
--   DECLINE (platform catalog, not user-scoped): foods, serving_variants,
--   barcode_product_cache; DECLINE (owned child, metadata-only payloads —
--   ack envelopes never carry entity data): sync_idempotency_keys; DECLINE
--   (platform abuse-control state): user_food_create_counters.
-- Platform-scope bypass: NONE this wave — no cross-account job exists in W3
-- (ledger §6); exemption policies + grants land together with the first
-- enumerated job, never as inert grant-without-policy pairs.
-- ---------------------------------------------------------------------------

-- Identifier/shape CHECKs (canonical forms; the write path validates before
-- insert — the database is the last line, not the only one).
ALTER TABLE "foods" ADD CONSTRAINT "foods_type_enum" CHECK ("type" IN ('dish', 'staple', 'packaged', 'recipe'));
ALTER TABLE "foods" ADD CONSTRAINT "foods_provenance_enum" CHECK ("provenance" IN ('kal_reviewed', 'imported', 'vendor_declared'));
ALTER TABLE "foods" ADD CONSTRAINT "foods_license_partition_enum" CHECK ("license_partition" IN ('proprietary', 'odbl'));
ALTER TABLE "foods" ADD CONSTRAINT "foods_names_nonempty" CHECK (char_length("name_en") BETWEEN 1 AND 200 AND ("name_ar" IS NULL OR char_length("name_ar") BETWEEN 1 AND 200));
ALTER TABLE "foods" ADD CONSTRAINT "foods_macros_nonnegative" CHECK ("energy_kcal" >= 0 AND "protein_g" >= 0 AND "carbs_g" >= 0 AND "fat_g" >= 0);
ALTER TABLE "foods" ADD CONSTRAINT "foods_barcode_digits" CHECK ("barcode" IS NULL OR "barcode" ~ '^[0-9]{8,14}$');

ALTER TABLE "serving_variants" ADD CONSTRAINT "serving_variants_labels" CHECK (char_length("label_en") BETWEEN 1 AND 100 AND ("label_ar" IS NULL OR char_length("label_ar") BETWEEN 1 AND 100));
ALTER TABLE "serving_variants" ADD CONSTRAINT "serving_variants_grams_positive" CHECK ("grams" > 0);

ALTER TABLE "barcode_product_cache" ADD CONSTRAINT "barcode_product_cache_source_enum" CHECK ("source" IN ('platform', 'open_food_facts'));
ALTER TABLE "barcode_product_cache" ADD CONSTRAINT "barcode_product_cache_barcode_digits" CHECK ("barcode" ~ '^[0-9]{8,14}$');

ALTER TABLE "user_foods" ADD CONSTRAINT "user_foods_at_least_one_name" CHECK ("name_en" IS NOT NULL OR "name_ar" IS NOT NULL);
ALTER TABLE "user_foods" ADD CONSTRAINT "user_foods_names_length" CHECK (("name_en" IS NULL OR char_length("name_en") BETWEEN 1 AND 200) AND ("name_ar" IS NULL OR char_length("name_ar") BETWEEN 1 AND 200));
ALTER TABLE "user_foods" ADD CONSTRAINT "user_foods_name_normalization_parity" CHECK (("name_en" IS NULL) = ("name_en_normalized" IS NULL) AND ("name_ar" IS NULL) = ("name_ar_normalized" IS NULL));
ALTER TABLE "user_foods" ADD CONSTRAINT "user_foods_macros_nonnegative" CHECK ("energy_kcal" >= 0 AND "protein_g" >= 0 AND "carbs_g" >= 0 AND "fat_g" >= 0);

ALTER TABLE "user_food_servings" ADD CONSTRAINT "user_food_servings_grams_positive" CHECK ("grams" > 0);

ALTER TABLE "user_food_create_counters" ADD CONSTRAINT "user_food_create_counters_nonneg" CHECK ("hour_count" >= 0 AND "day_count" >= 0);

ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_meal_slot_enum" CHECK ("meal_slot" IN ('breakfast', 'lunch', 'dinner', 'snack'));
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_entry_method_enum" CHECK ("entry_method" IN ('search', 'recents', 'favorites', 'copy_yesterday', 'quick_add', 'barcode'));
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_status_enum" CHECK ("status" IN ('confirmed', 'edited'));
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_macros_nonnegative" CHECK ("energy_kcal" >= 0 AND "protein_g" >= 0 AND "carbs_g" >= 0 AND "fat_g" >= 0);
-- Log source XOR: platform food, own user food, or bare quick-add — exactly
-- one shape per entry method (FR-012/FR-018).
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_source_exactly_one" CHECK (
  (
    (("food_id" IS NOT NULL)::int + ("user_food_id" IS NOT NULL)::int = 1)
    AND "entry_method" <> 'quick_add'
  )
  OR (
    "entry_method" = 'quick_add'
    AND "food_id" IS NULL AND "user_food_id" IS NULL
    AND "serving_label_en" IS NULL AND "serving_label_ar" IS NULL
    AND "serving_gram_weight" IS NULL
  )
);
-- Non-quick-add entries freeze a resolved serving gram weight (FR-012).
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_serving_resolution" CHECK (
  ("entry_method" = 'quick_add') OR ("serving_gram_weight" IS NOT NULL AND "serving_gram_weight" > 0)
);

ALTER TABLE "diary_days" ADD CONSTRAINT "diary_days_rollups_nonnegative" CHECK ("energy_kcal" >= 0 AND "protein_g" >= 0 AND "carbs_g" >= 0 AND "fat_g" >= 0 AND "entry_count" >= 0);

ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_entity_kind_enum" CHECK ("entity_kind" IN ('diary_entry', 'user_food', 'favorite'));
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_entity_action_enum" CHECK ("entity_action" IN ('create', 'update', 'delete'));
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_outcome_enum" CHECK ("outcome" IN ('applied', 'rejected'));
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_rejection_code_enum" CHECK ("rejection_code" IN ('rejected_validation', 'rejected_rate_limited', 'rejected_conflict', 'rejected_deleted'));
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_rejection_parity" CHECK (
  ("outcome" = 'rejected' AND "rejection_code" IS NOT NULL AND "retryable" IS NOT NULL)
  OR ("outcome" = 'applied' AND "rejection_code" IS NULL AND "retryable" IS NULL)
);
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_payload_parity" CHECK (("entity_action" = 'delete') = ("payload" IS NULL));
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_local_date_parity" CHECK (("entity_kind" = 'diary_entry') = ("local_date" IS NOT NULL));
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_device_id_length" CHECK (char_length("device_id") BETWEEN 1 AND 128);

ALTER TABLE "sync_idempotency_keys" ADD CONSTRAINT "sync_idempotency_keys_digest_format" CHECK ("request_digest" ~ '^[0-9a-f]{64}$');
ALTER TABLE "sync_idempotency_keys" ADD CONSTRAINT "sync_idempotency_keys_status_plausible" CHECK ("response_status" BETWEEN 200 AND 499);

-- Structural uniqueness beyond the generated indexes:
--   - one ACTIVE favorite per (user, food) — tombstoned rows free the pair
--     (a re-favorite is a new entity id);
--   - at most one DEFAULT serving variant per platform food;
--   - at most one ACTIVE serving set per user food (update ops soft-delete
--     the superseded rows).
CREATE UNIQUE INDEX "favorites_active_user_food_key" ON "favorites" ("user_id", "food_id") WHERE "deleted_at" IS NULL AND "food_id" IS NOT NULL;
CREATE UNIQUE INDEX "favorites_active_user_user_food_key" ON "favorites" ("user_id", "user_food_id") WHERE "deleted_at" IS NULL AND "user_food_id" IS NOT NULL;
CREATE UNIQUE INDEX "serving_variants_default_per_food_key" ON "serving_variants" ("food_id") WHERE "is_default";
CREATE UNIQUE INDEX "user_food_servings_active_per_food_key" ON "user_food_servings" ("user_food_id") WHERE "deleted_at" IS NULL;

-- Least-privilege grants (default-deny posture; every table grants its roles
-- in the migration that creates it — README "Database migrations").
--
-- Platform catalog (RLS declined — platform-owned, not user-scoped):
--   kal_app reads the governed catalog (search/detail/barcode resolution);
--   it may append barcode cache rows (first resolution wins, ON CONFLICT
--   DO NOTHING — no UPDATE: cache rows are immutable). kal_platform holds
--   the enumerated retention/curation shapes (SELECT, cache DELETE) — usable
--   immediately because these tables carry no RLS.
GRANT SELECT ON TABLE "foods" TO "kal_app";
GRANT SELECT ON TABLE "foods" TO "kal_platform";
GRANT SELECT ON TABLE "serving_variants" TO "kal_app";
GRANT SELECT ON TABLE "serving_variants" TO "kal_platform";
GRANT SELECT, INSERT ON TABLE "barcode_product_cache" TO "kal_app";
GRANT SELECT, DELETE ON TABLE "barcode_product_cache" TO "kal_platform";

-- Consumer-owned health tables (RLS ADOPTED below). kal_app works strictly
-- inside the requesting user's context (app.user_id GUC + SET ROLE):
--   user_foods: create/read/update (names, normalized names, macros,
--     LWW/tombstone/op columns); id, user_id, created_at immutable (no
--     UPDATE grant — I1); no DELETE (tombstones are soft deletes).
GRANT SELECT, INSERT ON TABLE "user_foods" TO "kal_app";
GRANT UPDATE ("name_en", "name_ar", "name_en_normalized", "name_ar_normalized", "energy_kcal", "protein_g", "carbs_g", "fat_g", "updated_at", "deleted_at", "last_op_id") ON TABLE "user_foods" TO "kal_app";
--   user_food_servings: created/replaced by update ops (soft-delete old set).
GRANT SELECT, INSERT ON TABLE "user_food_servings" TO "kal_app";
GRANT UPDATE ("label_en", "label_ar", "grams", "updated_at", "deleted_at") ON TABLE "user_food_servings" TO "kal_app";
--   user_food_create_counters: the shared limiter ticks both paths (REST +
--   sync apply) for the authenticated account only.
GRANT SELECT, INSERT ON TABLE "user_food_create_counters" TO "kal_app";
GRANT UPDATE ("hour_window_start", "hour_count", "day_window_start", "day_count") ON TABLE "user_food_create_counters" TO "kal_app";
--   diary_entries: written ONLY by sync ingestion (no diary REST mutation
--   surface exists — contract note §1). Update covers user edits (new frozen
--   snapshot at edit time + LWW/tombstone/op columns); id, user_id,
--   created_at immutable.
GRANT SELECT, INSERT ON TABLE "diary_entries" TO "kal_app";
GRANT UPDATE ("local_date", "meal_slot", "entry_method", "food_id", "user_food_id", "quantity", "serving_label_en", "serving_label_ar", "serving_gram_weight", "energy_kcal", "protein_g", "carbs_g", "fat_g", "status", "updated_at", "deleted_at", "last_op_id") ON TABLE "diary_entries" TO "kal_app";
--   diary_days: rollup cache recomputed by the diary handlers.
GRANT SELECT, INSERT ON TABLE "diary_days" TO "kal_app";
GRANT UPDATE ("energy_kcal", "protein_g", "carbs_g", "fat_g", "entry_count", "updated_at") ON TABLE "diary_days" TO "kal_app";
--   favorites: create/read + tombstone (LWW/op columns).
GRANT SELECT, INSERT ON TABLE "favorites" TO "kal_app";
GRANT UPDATE ("updated_at", "deleted_at", "last_op_id") ON TABLE "favorites" TO "kal_app";
--   sync_operations: ingestion appends final-outcome rows (single-phase —
--   no UPDATE grant); reads serve replay/dedupe. The ack envelope never
--   echoes payloads.
GRANT SELECT, INSERT ON TABLE "sync_operations" TO "kal_app";
--   sync_idempotency_keys: batch-key records (RLS declined — metadata only).
GRANT SELECT, INSERT ON TABLE "sync_idempotency_keys" TO "kal_app";
-- kal_platform on ADOPTED tables: NONE this wave — no cross-account job
-- exists in W3 (ledger §6); grant-without-policy would be inert noise. The
-- W1 weight_log export/deletion exemptions remain the standing pattern.

-- ---------------------------------------------------------------------------
-- Fail-closed RLS — ADOPTED health tables (ADR-0002 §2; weight_log pattern:
-- ENABLE + FORCE + per-role policy keyed on the transaction-local app.user_id
-- GUC; unset ⇒ NULL ⇒ zero rows, ever; malformed ⇒ cast error ⇒ fail closed;
-- WITH CHECK pins the user binding on writes).
-- ---------------------------------------------------------------------------

ALTER TABLE "user_foods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_foods" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_foods_user_context" ON "user_foods"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);

ALTER TABLE "user_food_servings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_food_servings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_food_servings_user_context" ON "user_food_servings"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);

ALTER TABLE "diary_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "diary_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "diary_entries_user_context" ON "diary_entries"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);

ALTER TABLE "diary_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "diary_days" FORCE ROW LEVEL SECURITY;
CREATE POLICY "diary_days_user_context" ON "diary_days"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);

ALTER TABLE "favorites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "favorites" FORCE ROW LEVEL SECURITY;
CREATE POLICY "favorites_user_context" ON "favorites"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);

ALTER TABLE "sync_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sync_operations_user_context" ON "sync_operations"
  AS PERMISSIVE FOR ALL TO "kal_app"
  USING ("user_id" = current_setting('app.user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);
