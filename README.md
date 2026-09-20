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

The database is **MySQL 8**. The planning documents specify Postgres; what
changed, and what replaces row-level security, is in
[`documents/decisions/adr-0001-mysql-instead-of-postgres.md`](documents/decisions/adr-0001-mysql-instead-of-postgres.md).

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

Then create the schema, install the database guards and seed a first
administrator:

```bash
npm run db:migrate --workspace @gementar/api
mysql -h HOST -u admin -p DATABASE < apps/api/prisma/sql/tenant-write-guard.sql   # as a DBA
npm run db:seed --workspace @gementar/api -- \
  --tenant "Klinik Pilot" --slug klinik-pilot \
  --branch "Cawangan Cheras" --code KL01 \
  --admin-name "Dr Aisyah" --admin-email admin@example.test
```

The seed prints a one-time link to set the administrator's password. MFA is
mandatory for administrators, so enrolment is forced at first sign-in.

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

## Checks

```bash
npm run lint        # every workspace; for the API this includes the
                    # @RequirePermission route check and the DTO tenant-id ban
npm run typecheck   # every workspace
npm test            # unit tests
npm run test:e2e    # end-to-end, against the real MySQL database
npm run build       # every workspace
```

The end-to-end suite creates its own tenants with random slugs and deletes them
afterwards, so it is safe to point at a shared development database.

## CI — Jenkins

The pipeline is [`Jenkinsfile`](Jenkinsfile) at the repository root. Point a
multibranch or pipeline job at this repo and it needs two things from the agent:

1. **Node 20 or newer** on `PATH`. If it comes from the NodeJS plugin instead,
   uncomment the `tools { nodejs '...' }` line and name your installation.
2. **A database.** Either a secret-text credential holding the CI
   `DATABASE_URL` (default id `cliniccare-ci-database-url`), or Docker on the
   agent, in which case set the `DATABASE` parameter to `throwaway-container`
   and the pipeline starts and disposes of MySQL 8 itself.

Encryption keys are minted per build and thrown away, so there is nothing else
to configure and no long-lived secret in the job.

Stages: toolchain check, install, Prisma client, migrate, lint and types for
both apps in parallel, unit tests, end-to-end tests, then both builds. Test
results are published as JUnit XML from `apps/api/reports/`.

Two things the pipeline enforces that are easy to lose otherwise:

- `npm run lint` fails the build when a mutating route has no
  `@RequirePermission`, or when any DTO would accept a tenant id.
- In `throwaway-container` mode the tenant write-guard triggers are installed as
  root and the API is run with `DB_GUARD_MODE=require`, which proves the script
  a DBA runs in production still applies cleanly to the current schema.

## What is built

| Module | Status |
|---|---|
| [Identity & Access](documents/modules/v0-01-identity-access.md) | API complete and tested; web screens for sign-in, MFA, account, staff administration and the audit dashboard |
| [Tenancy & Branch](documents/modules/v0-02-tenancy-branch.md) | The parts IAM needs: tenant and branch tables, scoping, branch switching |
| [Audit Trail](documents/modules/v0-14-audit-trail.md) | The write path and two read endpoints; the rest is still to come |

Everything else is specified in `documents/modules/` and not yet built.
