-- Rename users.password_hash -> users.password (founder CR, 2026-10-07).
-- Pure rename: same TEXT type, same argon2id PHC contents — the column holds
-- a salted hash exactly as before; only the name changed. CHECK constraints,
-- column grants, and comments follow the column automatically on RENAME.
ALTER TABLE "users" RENAME COLUMN "password_hash" TO "password";
