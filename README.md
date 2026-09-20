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

## Development

```bash
npm run dev:api     # Nest, watch mode, port 3001
npm run dev:web     # Next dev server, port 3000
```

The web app proxies `/api/v1/*` to the API, so the session cookie stays
same-origin and can remain `httpOnly` and `SameSite=Lax`.

## Checks

```bash
npm run lint        # every workspace; for the API this includes the
                    # @RequirePermission route check and the DTO tenant-id ban
npm test            # unit tests
npm run test:e2e --workspace @gementar/api   # against a real MySQL database
npm run build       # every workspace
```

The end-to-end suite creates its own tenants with random slugs and deletes them
afterwards, so it is safe to point at a shared development database.

## What is built

| Module | Status |
|---|---|
| [Identity & Access](documents/modules/v0-01-identity-access.md) | API complete and tested; web screens for sign-in, MFA, account, staff administration and the audit dashboard |
| [Tenancy & Branch](documents/modules/v0-02-tenancy-branch.md) | The parts IAM needs: tenant and branch tables, scoping, branch switching |
| [Audit Trail](documents/modules/v0-14-audit-trail.md) | The write path and two read endpoints; the rest is still to come |

Everything else is specified in `documents/modules/` and not yet built.
