# Kal Backend — API

NestJS (TypeScript) modular monolith for Kal. Phase 1 modules (planned): identity, consent, tracking, journal, goals, community, content, notifications, sync, lifecycle, admin, analytics. PostgreSQL + Prisma is the chosen data layer.

> **Decisions live in the Kal documentation repository** (the parent `Kal/` folder on the development machine — `PRD.md`, `ARCHITECTURE.md`, `CLAUDE.md`). This repository is the contract source of truth for the API.

## Prerequisites

- Node.js 20+ (developed on 24.x)
- pnpm 9+ (`npm install -g pnpm`)
- PostgreSQL 15+ — local dev database (see **Local database** below)

## Setup

Recommended: clone inside the Kal docs repo so docs and code sit together (that is the layout agents expect — and AI agents **require** it: they look for the Kal docs at `../../` and must refuse business/architecture work without them, see `CLAUDE.md`):

```bash
cd Kal/repositories          # create the folder if it is your first clone
git clone https://github.com/YassinFawzy/kal-backend.git
cd kal-backend
pnpm install
```

## Run

```bash
cp .env.example .env             # then set your local DATABASE_URL credentials
pnpm install && pnpm prisma generate   # generated client is gitignored — regenerate after clone/schema changes
pnpm start:dev    # dev server with watch mode → http://localhost:3000
pnpm start        # compiled production mode (dist/src/main.js)
```

**Boot-time validation (I15):** the process validates its configuration BEFORE any listener binds — a missing `DATABASE_URL`, a malformed connection string, or a placeholder-class password ("changeme"/"TODO"-class values) refuses the boot with a non-leaking message and a non-zero exit.

### W1 surface (infrastructure wave)

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness — `{"status":"ok"}` |
| `GET /health/ready` | Readiness — `200 {"status":"ok"}` or `503` `UNAVAILABLE` problem-details |
| `GET /probe/problem-details` | Documented `VALIDATION_FAILED` fixture (byte-stable example) |
| `GET /probe/user-context` | Fail-closed user-context proof (I2) — always `403 FORBIDDEN` in W1 (no identity plane yet) |
| `GET /contracts/w1` | Served contract fixtures (conventions §6) |

Every error response is an RFC 9457-style problem-details envelope with a code from the frozen registry (`docs/api/conventions.md` §4) and a `requestId` (echoed `X-Request-Id` or generated).

## Checks

```bash
pnpm lint         # oxlint (type-aware)
pnpm build        # nest build (also the typecheck gate for now)
pnpm test         # unit tests (vitest; specs colocated in src/)
pnpm test:e2e     # e2e (vitest) — boots the real AppModule in-process; NO running server or database required
pnpm test:integration  # A/B/C isolation harness (s4) — real PostgreSQL; see "A/B/C isolation harness" below
```

## Local database

Prisma is configured (`prisma7.config.ts`, schema at `prisma/schema.prisma`). The **local dev database is `kal`** on the machine's local PostgreSQL (localhost:5432); it receives the schema **only through reviewed migrations** (production schema auto-sync is forbidden — `prisma db push` is never run against this database).

```bash
cp .env.example .env          # then set your local credentials
createdb kal                  # once, if it does not exist yet
```

All agents and sessions target this database via `DATABASE_URL` in `.env` (never committed). Ephemeral test databases for the A/B/C security harness are created/dropped by the test harness itself (the Wave 1 pattern below — see `prisma/migrations`).

> Prisma 7 note: the `prisma-client` generator is adapter-based — instantiating the generated client requires a driver adapter. `@prisma/adapter-pg` (wrapping the repo's `pg` dependency) is the sanctioned adapter; `src/db/prisma.service.ts` (application) and `prisma/seed.ts` (seed scaffold) both show the pattern. The generated client lands in `generated/` (gitignored) via `pnpm prisma generate` and is compiled as part of `pnpm build` (its `.ts`-extension internal imports are rewritten by `rewriteRelativeImportExtensions` in `tsconfig.json`).

## Database migrations (workflow)

Migrations are **reviewed, immutable, forward-only history** (ARCHITECTURE §11; CLAUDE.md). Schema, generated clients, fixtures, and deployment steps stay faithful to that history. **Production schema auto-sync is forbidden.**

```bash
pnpm prisma migrate dev                      # author/apply locally (dev kal); creates shadow DB, detects drift
pnpm prisma migrate dev --create-only --name <name>   # generate SQL, review/edit BEFORE applying
pnpm prisma migrate deploy                  # apply pending migrations only (CI/release; no shadow DB)
pnpm prisma migrate status                  # show applied/pending state
dropdb kal && createdb kal && pnpm prisma migrate deploy   # recovery: fresh DB ← full history (structure verified by schema-dump diff)
```

Rules:

- **Never edit an applied migration.** Fix-forward with a new migration. (`prisma migrate reset --force` recreates the dev database from history — dev-only, never shared environments.)
- **Raw SQL (roles, GRANTs, RLS policies, triggers) lives inside migrations** — never in ad hoc scripts. Prisma's generated DDL and governance SQL can share a migration only when written together before first apply; otherwise governance lands as its own migration (see `20261006082537_role_contract_assertions`).
- **Every migration that creates a table grants its roles in the same migration.** Default privilege state is deny; nothing inherits access implicitly.
- Roles are cluster-scoped, migrations are per-database: role creation is guarded (`DO $$ ... IF NOT EXISTS pg_roles ...`), and the `role_contract_assertions` migration then asserts the full least-privilege contract idempotently — so the same history applies cleanly to fresh databases in a cluster that already has the roles (the A/B/C harness creates ephemeral databases per test).
- `prisma migrate dev` replays history into a shadow database for drift detection — policies/roles created by earlier migrations are recreated there identically, so they must be **re-run safe** (idempotent guards; no unguarded `CREATE ROLE`).
- Migrations must apply cleanly to an **empty** database (harness gate) and reproduce identical structure on drop/recreate (verified by schema-dump diff).

### Fresh-machine setup (exact commands)

```bash
cp .env.example .env          # set local credentials (never committed)
createdb kal                  # once
pnpm install
pnpm prisma migrate deploy    # applies full history to kal
pnpm prisma generate          # regenerates generated/prisma (gitignored — never committed)
node prisma/seed.ts           # optional: synthetic fixtures (localhost only)
```

## Roles & row-level security (ADR-0002 pilot pattern)

Wave 1 establishes the structural-isolation pattern every later wave copies:

- **`kal_app`** — request-scope application role. `NOLOGIN` group role: connections assume it via `SET ROLE kal_app` (per session/transaction). Least-privilege column/table GRANTs only; subject to RLS on health tables.
- **`kal_platform`** — platform-scope bypass role for **enumerated** cross-user jobs (export/deletion, retention, sync housekeeping). Bypass is explicit and per-table via exemption policies (e.g. `weight_log_platform_export`/`weight_log_platform_deletion`) — **never** a superuser or `BYPASSRLS` attribute, and never reachable from request-scope code paths.
- **`role_contract_assertions` migration** asserts both roles' full contract (`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`) idempotently — roles can pre-exist in a cluster; the migration normalizes them regardless of provenance.
- **Fail-closed RLS** (pilot table `weight_log`, FORCE-enabled). Naming note (founder directive, ledger §10 2026-10-06): the per-person column is `user_id` (per-plane ids: consumers `user_id`, vendors `vendor_id`, drivers `driver_user_id`, admins `admin_id`) and the context GUC is `app.user_id` — a 2026-10-06 forward-fix migration (`20261006145631_rename_weight_log_owner_to_user_id`) renamed the column, its index, and recreated the policy, **because `ALTER TABLE ... RENAME COLUMN` does NOT rewrite the GUC name string inside the policy expression** (the old policy would have kept reading the never-set `app.current_owner` and failed closed forever):

  ```sql
  CREATE POLICY weight_log_user_context ON weight_log
    AS PERMISSIVE FOR ALL TO kal_app
    USING (user_id = current_setting('app.user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);
  ```

  The `app.user_id` GUC is **transaction-local**: `SELECT set_config('app.user_id', <user uuid>, true)` inside the transaction that queries. Unset ⇒ NULL ⇒ **zero rows, ever**. Malformed ⇒ cast error ⇒ fail closed. Note: `set_config(..., true)` outside an explicit transaction reverts immediately (autocommit) — application code must always set it inside the transaction. Caveat pinned by the harness (F1): on a session that has set the GUC once, an unset GUC reads back `''` (not NULL) ⇒ 22P02 cast error — still fail-closed.
- **User-id immutability**: `user_id` has no UPDATE grant (column-level grants cover data columns only), and the RLS `WITH CHECK` rejects any write whose `user_id` differs from the context — moving a row to another user is structurally impossible.
- **Append-only audit** (`audit_events`, platform-owned, deliberately outside RLS scope): no UPDATE/DELETE grants for any role **and** a `BEFORE UPDATE/DELETE` trigger that raises — the trigger binds even the table owner; only a superuser could bypass it (break-glass territory, audited).
- **Compound user-reference pattern for later waves (I3):** owned child tables carry the per-plane user id column and expose a composite key so cross-user references are structurally impossible:

  ```sql
  -- parent: UNIQUE (id, user_id); child:
  CREATE TABLE child (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    parent_id uuid NOT NULL,
    FOREIGN KEY (parent_id, user_id) REFERENCES parent (id, user_id)
  );
  ```

  (The W1 tables stand alone — no consumer table exists yet, so `weight_log.user_id` deliberately has no FK; the identity wave documents whether pilot tables adopt the composite pattern retroactively.)
- **Never assert RLS behavior over a superuser connection** — superusers bypass RLS unconditionally. Verification connections use `SET ROLE kal_app` / `SET ROLE kal_platform` and assert on `current_user` (proof pattern in the Wave 1 merge request evidence).
- Introspection: `psql "$DATABASE_URL" -c '\dp weight_log' -c "SELECT * FROM pg_policies;"`. After the rename, `pg_policies` must show the recreated policy with the NEW GUC string — `weight_log_user_context … (user_id = (current_setting('app.user_id'::text, true))::uuid)` in both `qual` and `with_check`; `information_schema.columns` shows `user_id` (no `owner_id`), and `pg_indexes` shows `weight_log_user_id_recorded_at_idx`.

## A/B/C isolation harness (s4 — the pattern every wave reuses)

The canonical command (requires the local PostgreSQL from "Local database" and a `DATABASE_URL` whose user is the admin/migration user):

```bash
pnpm test:integration
```

What the harness guarantees (ARCHITECTURE.md §11/§22, ADR-0002):

- **Ephemeral per-suite databases.** Each suite creates `kal_it_<label>_<rand>`, applies the full migration history with the real `prisma migrate deploy` runner, and drops it (`WITH (FORCE)`) afterwards. The dev `kal` database is never touched; suites share nothing.
- **Never assert row security as a superuser.** Superusers bypass RLS unconditionally. Every behavioral statement runs through `test/integration/helpers/acting-user.ts`: `SET LOCAL ROLE kal_app`/`kal_platform` inside a transaction, then a `current_user` proof — the helper refuses to run otherwise. The user context is the transaction-local GUC (`set_config('app.user_id', <uuid>, true)`).
- **A/B/C semantics.** A's rows are the attack targets; B attacks every read/mutate/reference/enumerate path with valid credentials; C is the control (parity proves denials are authorization-driven). Rows are seeded through the app role under each user's context — never via admin authority.
- **Denials are row-count assertions.** RLS hides rows; exceptions are asserted only where PostgreSQL actually raises (INSERT `WITH CHECK`, missing column grants, malformed GUC casts, privilege-escalation attempts).
- **No secrets in logs.** The migration-runner spawn is the one boundary that could echo credentials; its output is redacted against the URL and password before surfacing.

Reuse for later waves: copy `rls-pilot.itspec.ts` as the reference consumer and `test/integration/helpers/*` as-is; owned child tables add the compound user-reference cases (README "Roles & row-level security").

## Not wired yet (state at bootstrap)

PostgreSQL connection config (`.env`), environment/config validation, and all feature modules. Prisma is scaffolded only — no schema, no migrations yet. The foundation increment lands next (see the Kal docs repo).

## Repository rules (from ARCHITECTURE.md — full version there)

- One module per bounded context; modules talk only through exported service interfaces — **no module queries another module's tables**.
- Every read/write of user-owned data goes through the owning module's service layer with a validated `UserContext`; unscoped queries are review-blocking defects.
- Errors use RFC 9457-style problem details with stable application error codes.
- Money is integer piastres + currency code, everywhere.
- No imports from any other Kal repository; each client keeps its own local types.
- Migrations are immutable history once Prisma is wired; production schema auto-sync is forbidden.
