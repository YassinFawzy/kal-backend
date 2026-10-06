-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weight_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "weight_kg" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "weight_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weight_log_owner_id_recorded_at_idx" ON "weight_log"("owner_id", "recorded_at");

-- Weight sanity: a logged body weight is a positive physical quantity.
-- (Upper bounds are a product-policy matter and are deliberately not encoded here.)
ALTER TABLE "weight_log" ADD CONSTRAINT "weight_log_weight_positive" CHECK ("weight_kg" > 0);
