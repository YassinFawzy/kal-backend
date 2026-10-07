-- Sliding session window (founder CR, 2026-10-07): rotation now also updates
-- sessions.expires_at (re-armed to now + sessionTtlSeconds). Extend the
-- kal_app column-grant enumeration additively — the only new write shape.
GRANT UPDATE ("expires_at") ON TABLE "sessions" TO "kal_app";
