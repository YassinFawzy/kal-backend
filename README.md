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

### W2 identity (contract frozen — `docs/api/wave-02-contract.md`)

The identity wave's session semantics, endpoint shapes, lockout/enumeration observables, and per-table isolation decisions are frozen in the wave-02 contract note (`docs/api/wave-02-contract.md` in the Kal docs repo). This repository serves the `w2` fixture document additively (`GET /contracts/w2` — every `w1` entry retained byte-stably; `w1` itself untouched). The identity endpoints described there are implemented by the Stage-2 lanes (`src/identity/**`); until those merge, the frozen fixtures are declaration, not implementation — the fixture round-trip suite pins the served document, and the implementing lanes pin their responses against it.

Identity schema (migration `20261007101836_identity_core`): `users` (three unique sign-in identifiers + PHC `password_hash` per ADR-0003), `sessions` (rotating refresh secret, generation counter), `recovery_tickets` (single-use hashed tickets), `auth_attempt_counters` (platform-owned throttle digests). Grants follow the least-privilege table pattern; **RLS is declined per table** (see the table in "Roles & row-level security" above).

### W3 tracking + sync (contract frozen — `docs/api/wave-03-contract.md`)

The tracking & sync wave's schema, sync semantics, module seams, normalization rules, seed manifest, and client-store v3 freeze are in the wave-03 contract note. This repository serves the `w3` fixture document additively (`GET /contracts/w3` — every `w1`/`w2` entry retained byte-stably; both pinned by golden hashes).

Schema (migration `20261007222419_w3_tracking_sync_core` + carryovers `20261007222543_weight_log_user_fk`, `20261007222622_recovery_request_throttle`):

- **Platform catalog** (RLS declined): `foods` (+ stored normalized names/aliases for FR-010 search), `serving_variants` (gram weights per FR-012), `barcode_product_cache` (FR-017 pipeline; Open-Food-Facts rows stay license-partitioned via `license_partition`).
- **Consumer health tables** (fail-closed RLS ADOPTED — `app.user_id` policy per the weight_log pilot): `user_foods` + `user_food_servings` (compound user references, I3), `diary_entries` (client-entity-id PK; frozen nutrient snapshots, I11; client-local `local_date` — the server never re-derives the day), `diary_days` (rollup cache), `favorites`, and `sync_operations` (the op ledger; its payload mirrors diary content, so it adopts).
- **Metadata/throttle tables** (RLS declined, documented per table): `sync_idempotency_keys` (batch `Idempotency-Key` records — acks never carry payloads), `user_food_create_counters` (the shared PRD §8 limiter behind BOTH the REST and sync-apply user-food create paths).
- **Diary REST mutations do not exist** — diary/user-food/favorite mutations flow exclusively through sync ingestion (`POST /sync/ops`); the frozen per-op outcomes, LWW tiebreak `(clientUpdatedAt, opId)`, tombstones with no same-id resurrection, and user-bound opaque delta cursors are all specified in the contract note §1.
- The curated Egyptian core pack seeds from `prisma/seed-manifest.ts` (48 items, `node prisma/seed.ts`) — values are **engineering-initial pending founder nutrition review** (ledger §7-E2).

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
>
> **F-W2-1 (UTC-correct timestamptz reads):** `PrismaService` pins `-c timezone=UTC` as a POOL startup option — `@prisma/adapter-pg`'s timestamptz parser rewrites the rendered offset to `+00:00` without converting wall-clock time, so a non-UTC session would shift every read (+3 h on the Africa/Cairo dev cluster). The pool pin makes every connection render UTC; identity's per-transaction `TimeZone` pins stay (harmless belt-and-suspenders). Regression: `test/integration/prisma-utc.itspec.ts` + the `identity-tz` e2e.

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
- **W2 identity tables — RLS DECLINED per table (documented decision, not an omission).** ADR-0002 scopes RLS narrowly to consumer-owned **health-data** tables; identity tables are non-health and stay on the I1–I3 layers (app-level user-scoped predicates + structural constraints), attacked behaviorally by the A/B/C suites. The per-table decision and rationale:

  | Table | Decision | Rationale (ADR-0002-consistent) |
  |---|---|---|
  | `users` | **Decline** | Identity anchor, not a health table. Isolation = I1/I2 predicates in the identity module + structural uniqueness; a leak of account-existence metadata is bounded by the non-disclosure observables (contract note §3), not by row filtering. |
  | `sessions` | **Decline** | Owned child (immutable `user_id` FK), content limited to session metadata + hashed refresh secret — no health data. User-scoped predicates are mandatory in the module; the `user_id` column carries no UPDATE grant. |
  | `recovery_tickets` | **Decline** | Owned child; stores only SHA-256 ticket hashes. Same I1–I3 posture as sessions. |
  | `auth_attempt_counters` | **Decline (outside scope)** | Platform-owned throttle state keyed by digests — no `user_id` column at all, so no per-user row security applies; not user-owned data. |

  Structure is pinned by `test/integration/identity-schema.itspec.ts` (no `relrowsecurity`, zero `pg_policies` rows, column-grant scoping).
- **Compound user-reference pattern — first structural uses (I3):** `user_food_servings`, `diary_entries`, and `favorites` reference `user_foods(id, user_id)` via composite FKs — a cross-account child row is structurally impossible. `weight_log` (W3 carryover b) takes the PLAIN FK (`weight_log_user_id_fkey`, `ON DELETE RESTRICT`): it is an owned ROOT table with no children, so the compound shape has no target there. The generic pattern for future waves:
- **W3 tracking + sync tables — per-table decisions (contract note §5).** Consumer-owned HEALTH tables ADOPT the fail-closed policy; platform catalog and metadata/throttle tables DECLINE with rationale. Structure pinned by `test/integration/tracking-rls.itspec.ts` (24 A/B/C, fail-closed, grants-matrix, and platform-scope cases):

  | Table | Decision | Rationale (ADR-0002-consistent) |
  |---|---|---|
  | `foods`, `serving_variants`, `barcode_product_cache` | **Decline** | Platform catalog, not user-scoped (no `user_id`); every authenticated consumer reads the same governed rows. |
  | `user_foods` + `user_food_servings` | **Adopt** | Consumer-owned health data (label-create foods); compound user reference `(user_food_id, user_id)` (I3) on children. |
  | `diary_entries` | **Adopt** | The core health table (frozen snapshots, I11); simulated-bug tests prove the DB blocks what app code forgets. |
  | `diary_days` | **Adopt** | Derived per-user health rollups. |
  | `favorites` | **Adopt** | Consumer-owned, in the wave's frozen adopted set. |
  | `sync_operations` | **Adopt** | Its `payload` mirrors diary/user-food content — a leak is exactly as catastrophic (ADR-0002 scope). |
  | `sync_idempotency_keys` | **Decline** | Owned child, metadata-only content (digests + ack envelopes that never carry payloads) — the `sessions` posture. |
  | `user_food_create_counters` | **Decline (outside scope)** | Platform abuse-control state (§11 places rate-limit counters on the platform plane). |
  | `recovery_request_counters` | **Decline (outside scope)** | Digest-keyed throttle state, no `user_id` — the `auth_attempt_counters` posture (F-S4-1 carryover). |

  **Platform-scope bypass: none added in W3** (no cross-account job exists) — `kal_platform` carries NO grants on adopted tables this wave; the W1 `weight_log` exemptions remain the standing pattern. On declined tables, platform holds only the enumerated shapes (catalog SELECT; cache + recovery-counter SELECT/DELETE housekeeping).
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

  (The W1 tables stand alone — no consumer table existed then; the identity wave recorded the deferral, and W3 landed the plain `weight_log` FK plus the first compound references, above.)
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
