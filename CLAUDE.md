# CLAUDE.md — kal-backend Agent Rules

This repository is **code only**. Every product, business, and architecture decision is governed by the **Kal documentation repository** — never by guesswork inside this repo.

## Locate the Kal docs repo before doing anything it governs

Standard layout (see the Kal README at https://github.com/YassinFawzy/kal):

```text
Kal/                      ← documentation repo (the single source of truth)
└── repositories/
    └── kal-backend/      ← this repo → the docs live at ../../
```

**Before any task that touches business rules, architecture, the data model or schema, API contracts, tenancy/isolation, identity, offline/sync ingestion, phase scope, or anything an HD-xx decision covers**, verify the docs exist and read the relevant sections:

1. Check that `../../PRD.md` and `../../ARCHITECTURE.md` exist. If they do, read the sections governing the task (plus `../../CLAUDE.md`, `../../docs/development/PLAN.md`, and `../../docs/decisions/` where relevant). When documents disagree with each other or with a request, STOP and ask the founder — never pick an interpretation.
2. **Freshness check:** if `../../` is a git repository, run `git -C ../../ fetch origin --quiet`, then `git -C ../../ rev-list --count main..origin/main`. If the count is non-zero, the local Kal docs are behind the remote: warn the user and ask whether to pull first — never build against a known-stale copy silently.
3. If they are not at `../../`, check parent directories for a folder containing both `PRD.md` and `ARCHITECTURE.md` (non-standard but valid layouts).

## If the docs cannot be found — STOP

This repo was probably cloned standalone, outside the Kal folder. **Do not continue the task. Do not guess, approximate, or work from general knowledge — not even for "just a small" decision.** Tell the user exactly this:

> This repository is governed by the Kal documentation repository, which I cannot find. Set it up following the README at https://github.com/YassinFawzy/kal — clone the docs repo, then place this repo inside it at `Kal/repositories/kal-backend` — then ask me again.

## Standing rules (full versions live in the Kal docs repo)

- Modular monolith: modules talk only through exported service interfaces; **no module queries another module's tables**.
- Every read/write of user-owned data goes through the owning module's service layer with a validated `OwnerContext`; unscoped queries are review-blocking defects. Denials must never confirm another owner's object exists.
- Never resolve an open HD-xx decision or an open document conflict in code — stop and ask the founder. Wire configuration points, leave values to the founder.
- Phase discipline: build Phase 1 modules only; `premium` (Phase 2) and the Phase 3 modules (catalog, matching, ordering, payments, delivery, vendor, settlement) are reserved boundaries — do not build early.
- Errors: RFC 9457-style problem details with stable application error codes. Money is integer piastres + currency code. No health data in logs or analytics.
- Never import from another Kal repository; each client keeps its own local types against this API.
- Run `pnpm lint`, `pnpm build`, and `pnpm test` before declaring any task done.
- If a change package spans docs and code, remind the user that the Kal repo's `scripts/snapshot.sh` must be re-run and `docs/development/code-state.md` committed (do it yourself if the Kal repo is present).
