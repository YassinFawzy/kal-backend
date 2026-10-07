-- CreateTable
CREATE TABLE "recovery_request_counters" (
    "subject_key" TEXT NOT NULL,
    "device_key" TEXT NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(6),

    CONSTRAINT "recovery_request_counters_pkey" PRIMARY KEY ("subject_key","device_key")
);

-- Governance (W3 Stage-1 carryover F-S4-1; contract note: docs/api/
-- wave-02-contract.md §3 amendment + wave-03-contract.md §6 config points).
ALTER TABLE "recovery_request_counters" ADD CONSTRAINT "recovery_request_counters_nonneg" CHECK ("request_count" >= 0);

-- Same posture as auth_attempt_counters: kal_app upserts and ticks
-- atomically on every well-formed recovery request (SELECT/INSERT + counter
-- UPDATE); it never deletes (window reset is an UPDATE). kal_platform holds
-- the retention/housekeeping shape (SELECT + DELETE of stale counters).
GRANT SELECT, INSERT ON TABLE "recovery_request_counters" TO "kal_app";
GRANT UPDATE ("request_count", "window_started_at", "locked_until") ON TABLE "recovery_request_counters" TO "kal_app";
GRANT SELECT, DELETE ON TABLE "recovery_request_counters" TO "kal_platform";
