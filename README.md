# Gementar ClinicCare

Clinic operations for Malaysian general practice. Monorepo, npm workspaces.

```
apps/
  web/   Next.js 16 (App Router, TypeScript, Tailwind v4)  -> http://localhost:3000
  api/   NestJS 12 (TypeScript, Prisma, Vitest, oxlint)    -> http://localhost:3001
documents/
  planning/   scope, architecture, multi-tenancy, data model, delivery plan
  modules/    one specification per module, 38 of them, prefixed by version
  decisions/  architecture decision records
  security/   threat models
```

The database is **PostgreSQL 16**, with row-level security enabled and forced
on every tenant-owned table. It ran on MySQL for a day; the move and what it
changed are in
[`documents/decisions/adr-0002-postgres.md`](documents/decisions/adr-0002-postgres.md).

## Setup

```bash
npm install
cp apps/api/.env.example apps/api/.env      # fill in DATABASE_URL and the two keys
cp apps/web/.env.example apps/web/.env.local
```

Generate the two keys the API needs:

```bash
openssl rand -base64 32   # APP_KEK_V1     encrypts MFA secrets at rest
openssl rand -base64 32   # APP_HASH_PEPPER
```

Then create the schema and seed a first administrator. Row-level security,
the audit-immutability trigger and the last-administrator trigger are all part
of the migrations, so there is no separate hardening step:

```bash
npm run db:migrate --workspace @gementar/api
npm run db:seed --workspace @gementar/api -- \
  --tenant "Klinik Pilot" --slug klinik-pilot \
  --branch "Cawangan Cheras" --code KL01 \
  --admin-name "Dr Aisyah" --admin-email admin@example.test
```

The seed prints a one-time link to set the administrator's password. MFA is
mandatory for administrators, so enrolment is forced at first sign-in.

Accounts for trying the system out, and what is worth trying with each role,
are in [`TEST-ACCOUNTS.md`](TEST-ACCOUNTS.md).

## Running everything

One command brings up the whole stack, applies any pending migrations and waits
until both services answer:

```bash
npm run dev
```

```
▸ Applying database migrations
▸ Starting ClinicCare (dev mode)
[api] API listening on :3001 (development)
[web] ready in 1.1s
✓ API is up at http://localhost:3001/api/v1/health
✓ Web is up at http://localhost:3000/login
```

Ctrl-C stops everything, including the processes npm spawned underneath. Each
service runs in its own session, so nothing is left holding a port.

```bash
npm run dev            # watch mode, both services
npm run dev:prod       # build both, then run the production servers
./scripts/dev.sh --api      # API only
./scripts/dev.sh --web      # web only
./scripts/dev.sh --seed     # seed a tenant and administrator first
./scripts/dev.sh --no-migrate
./scripts/dev.sh --help
```

On first run the script creates the env files if they are missing, and stops
with instructions rather than starting half-configured. Ports can be moved with
`API_PORT` and `WEB_PORT`.

The web app proxies `/api/v1/*` to the API, so the session cookie stays
same-origin and can remain `httpOnly` and `SameSite=Lax`.

## Brand

The source logo is `documents/media/logos/logo.png`. The web assets are
generated from it, never hand-edited:

```bash
npm run brand     # -> apps/web/public/brand/ and apps/web/src/app/icon.png
```

It produces the lockup with a transparent background, a white-ink version for
dark surfaces, a compact version without the tagline for headers, the mark on
its own, and the browser-tab icon. Re-run it whenever the logo changes.

The palette in `apps/web/src/app/globals.css` is taken from the logo: red
`#e60107`, black and white. **Light theme only** — there is no dark variant,
and `color-scheme: only light` stops a machine set to dark from inverting the
form controls.

Two things there are deliberate. Red is also the colour of an error, so danger
uses a deeper brick on a tinted panel while the brand red stays on solid
buttons, and the focus ring is blue so it can never be mistaken for either.

## Checks

```bash
npm run lint        # every workspace; for the API this includes the
                    # @RequirePermission route check and the DTO tenant-id ban
npm run typecheck   # every workspace
npm test            # unit tests
npm run test:e2e    # end-to-end, against the real PostgreSQL database
npm run build       # every workspace
```

The end-to-end suite creates its own tenants with random slugs and deletes them
afterwards, so it is safe to point at a shared development database. It runs
with row-level security in force, exactly as production does, and part of what
it asserts is that raw SQL with no tenant filter still sees only one tenant.

Set `TEST_ADMIN_DATABASE_URL` to an owner connection if you want the suite to
remove its own audit rows as well; they are append-only otherwise, by design.

## CI — Jenkins

The pipeline is [`Jenkinsfile`](Jenkinsfile) at the repository root. Point a
multibranch or pipeline job at this repo and it needs two things from the agent:

1. **Node 20 or newer** on `PATH`. If it comes from the NodeJS plugin instead,
   uncomment the `tools { nodejs '...' }` line and name your installation.
2. **A database.** Either a secret-text credential holding the CI
   `DATABASE_URL` (default id `cliniccare-ci-database-url`), or Docker on the
   agent, in which case set the `DATABASE` parameter to `throwaway-container`
   and the pipeline starts and disposes of PostgreSQL 16 itself.

Encryption keys are minted per build and thrown away, so there is nothing else
to configure and no long-lived secret in the job.

Stages: toolchain check, install, Prisma client, migrate, lint and types for
both apps in parallel, unit tests, end-to-end tests, then both builds. Test
results are published as JUnit XML from `apps/api/reports/`.

Two things the pipeline enforces that are easy to lose otherwise:

- `npm run lint` fails the build when a mutating route has no
  `@RequirePermission`, or when any DTO would accept a tenant id.
- The API runs with `DB_GUARD_MODE=require`, so the build fails if any
  tenant-owned table is missing row-level security, if a new table appears
  without either protection or a written exemption, or if the database role can
  bypass policies.

## What is built

| Module | Status |
|---|---|
| [Identity & Access](documents/modules/v0-01-identity-access.md) | API and web screens built and tested: sign-in, MFA, account, staff administration, audit dashboard |
| [Tenancy & Branch](documents/modules/v0-02-tenancy-branch.md) | The parts IAM needs: tenant and branch tables, scoping, branch switching |
| [Audit Trail](documents/modules/v0-14-audit-trail.md) | The write path and two read endpoints; the rest is still to come |

Everything else is specified in `documents/modules/` and not yet built.
