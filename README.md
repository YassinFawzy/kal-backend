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
pnpm start:dev    # dev server with watch mode → http://localhost:3000
pnpm start        # compiled production mode
```

## Checks

```bash
pnpm lint         # oxlint (type-aware)
pnpm build        # nest build (also the typecheck gate for now)
pnpm test         # unit tests (vitest via the Nest template)
pnpm test:e2e     # e2e — start `pnpm start:dev` in another terminal first
```

## Local database

Prisma is scaffolded (config in `prisma7.config.ts`, schema at `prisma/schema.prisma` — empty by design). The **local dev database is `kal`**: an intentionally EMPTY database on the machine's local PostgreSQL (localhost:5432). Wave 1 of the delivery plan creates the schema through reviewed Prisma migrations; until then nothing creates tables.

```bash
cp .env.example .env          # then set your local credentials
createdb kal                  # once, if it does not exist yet
```

All agents and sessions target this database via `DATABASE_URL` in `.env` (never committed). Ephemeral test databases for the A/B/C security harness are created/dropped by the test harness itself (Wave 1 defines the pattern).

## Not wired yet (state at bootstrap)

PostgreSQL connection config (`.env`), environment/config validation, and all feature modules. Prisma is scaffolded only — no schema, no migrations yet. The foundation increment lands next (see the Kal docs repo).

## Repository rules (from ARCHITECTURE.md — full version there)

- One module per bounded context; modules talk only through exported service interfaces — **no module queries another module's tables**.
- Every read/write of user-owned data goes through the owning module's service layer with a validated `OwnerContext`; unscoped queries are review-blocking defects.
- Errors use RFC 9457-style problem details with stable application error codes.
- Money is integer piastres + currency code, everywhere.
- No imports from any other Kal repository; each client keeps its own local types.
- Migrations are immutable history once Prisma is wired; production schema auto-sync is forbidden.
