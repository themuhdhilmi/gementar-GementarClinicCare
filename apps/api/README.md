# @gementar/api

NestJS 12, Prisma, MySQL 8. A modular monolith: one deployable, hard internal
seams (`documents/planning/02-architecture.md`).

```
src/
  config/          typed, validated configuration — the process refuses to start without it
  shared/
    access/        the permission catalogue
    crypto/        AES-256-GCM envelope encryption, hashing, random tokens
    errors/        domain errors and the RFC 7807 responses
    http/          request id, origin check, client ip
    ids/           UUID v7
    pagination/    page envelope
    prisma/        the tenant-scoped client, and the one transaction per request
    time/          injectable clock, so time-dependent rules are testable
  modules/
    identity/      authentication, sessions, MFA, users, permissions
    tenancy/       tenant and branch, the request context
    audit/         append-only audit trail
    events/        in-process domain events, published after commit
```

## The rule that keeps this clean

> A module may only touch its own tables. Cross-module access goes through the
> other module's exported service.

## Tenant isolation

Two layers, because either alone will eventually fail:

1. **`src/shared/prisma/tenant-scope.ts`** — a Prisma extension that injects
   `tenant_id` into every query against a tenant-owned model, and refuses to run
   one at all outside a scope. A model that is neither classified as tenant-owned
   nor platform-owned is refused too, so a new table cannot ship unprotected.
2. **`prisma/sql/tenant-write-guard.sql`** — triggers that reject any write whose
   `tenant_id` disagrees with the connection's `@app_tenant_id`. Installed by a
   DBA, because creating triggers needs privileges the application account does
   not have. `/api/v1/health` reports whether they are present, and
   `DB_GUARD_MODE=require` refuses to boot without them.

Read `documents/decisions/adr-0001-mysql-instead-of-postgres.md` before changing
any of it.

## Scripts

```bash
npm run start:dev          # watch mode
npm run db:migrate         # prisma migrate deploy
npm run db:seed            # first tenant, branch and administrator
npm run lint               # oxlint + the two authorisation checks
npm run lint:routes        # every mutating route declares a permission
npm run lint:dto           # no DTO accepts a tenant id
npm test                   # unit tests
npm run test:e2e           # end-to-end, against the database in DATABASE_URL
npm run measure:argon2     # tune the password hash cost for this host
```

## Adding an endpoint

1. Put it in the module that owns the tables it touches.
2. Mutating routes carry `@RequirePermission('x.y')`, or `@NoPermission('why')`
   with a reason. `npm run lint:routes` fails the build otherwise, and the
   permission guard refuses the request at runtime.
3. Never accept a tenant id from the request. It comes from the session.
4. Take the transaction from `DbService.tx()`. Do not start your own, and do not
   do slow work — PDF rendering, object storage, outbound HTTP — inside it.
5. Audit anything a clinic would want to ask about later, passing the same
   transaction so the entry shares the fate of the change.
