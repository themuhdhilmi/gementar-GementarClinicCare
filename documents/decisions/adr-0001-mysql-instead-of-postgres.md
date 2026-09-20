# ADR-0001 — MySQL 8 instead of PostgreSQL, and what replaces row-level security

| | |
|---|---|
| **Status** | **Superseded by [ADR-0002](adr-0002-postgres.md)** on 2026-09-21 |
| **Date** | 2026-09-21 |
| **Affects** | `documents/planning/02-architecture.md`, `documents/planning/03-multi-tenancy.md`, `documents/planning/04-data-model.md`, every module |
| **Decided while building** | `v0-01-identity-access.md` |

> **This decision was reversed the same day.** A PostgreSQL 16 server became
> available, the schema moved to it, and row-level security now does the work
> the compensating controls below were standing in for. The record is kept
> because the reasoning still explains why those controls exist in the code,
> and what would have to be rebuilt if MySQL ever came back.

## Context

The planning documents specify PostgreSQL 16, and lean on one Postgres feature in
particular: **row-level security** as the second, independent layer of tenant
isolation. `03-multi-tenancy.md` is explicit that either layer alone will
eventually fail, and that RLS is the backstop for the day a `where` clause is
forgotten.

The database available for this deployment is **MySQL 8.3**. MySQL has no
row-level security, and no equivalent feature. It also, on this server, does not
let the application account create triggers: binary logging is on and the
account has neither `SUPER` nor `SET_USER_ID`.

So the question is not "MySQL or Postgres" — that was settled by what is
available — but "what honestly replaces the layer we are losing".

## Decision

Build on MySQL 8, and replace row-level security with three things rather than
one, none of which pretends to be RLS:

**1. A Prisma client extension that scopes every query, mechanically.**
`src/shared/prisma/tenant-scope.ts`. Every model is classified as tenant-owned
or platform-owned; a query against a tenant-owned model injects `tenant_id` into
the filter, stamps it onto every create, and refuses outright to run when no
scope is open. A model nobody has classified is refused too, so adding a table
without thinking about tenancy fails immediately and loudly. This is the
"repository layer that mechanically injects `tenant_id`" that `03` names as the
honest alternative — with the difference that it is not per-call discipline, it
is one code path nobody can forget.

**2. Database triggers as a write-side backstop, installed by a DBA.**
`apps/api/prisma/sql/tenant-write-guard.sql` creates `BEFORE INSERT/UPDATE/DELETE`
triggers on all eight tenant-owned tables. They reject any write whose
`tenant_id` disagrees with `@app_tenant_id`, the session variable the application
sets at the start of every unit of work. This is a genuine `WITH CHECK`
equivalent. It is *not* a `USING` equivalent: MySQL triggers cannot filter reads.

The application sets `@app_tenant_id` whether or not the triggers are installed,
checks on boot whether they are, and says so on `/api/v1/health`. `DB_GUARD_MODE=require`
refuses to start without them.

**3. Composite foreign keys, so a row cannot point across tenants.**
Every child table references its parent by `(id, tenant_id)`, not by `id`. A
session cannot belong to a user of another tenant, a role assignment cannot point
at another tenant's branch, and the database itself enforces it. Postgres could
have done this too; on MySQL it does more work, because it is carrying part of
what RLS would have carried.

## What is weaker than the plan, plainly

- **Reads have one layer, not two.** A raw SQL query written by hand, or a bug in
  the extension, is not caught by anything below it. On Postgres, RLS would have
  caught both. Mitigations: `$queryRaw` is rare and reviewed; the isolation suite
  runs on every push; a generated test asserts that every table with a
  `NOT NULL tenant_id` is classified.
- **The write backstop needs a DBA.** Until someone runs the hardening script,
  layer 2 is not there at all. That is why the health endpoint reports it and
  production can be configured to refuse to boot without it.
- **`FORCE ROW LEVEL SECURITY` has no analogue.** On Postgres the application
  role is a non-owner without `BYPASSRLS`. Here, the application account owns its
  tables. Grant hygiene is therefore the DBA's job, documented in the script.

## Other MySQL consequences worth recording

| Planned (Postgres) | Built (MySQL 8) | Note |
|---|---|---|
| `uuid` primary keys | `CHAR(36)`, UUID v7, generated in the app | Still time-sortable, so index locality holds. `BINARY(16)` would be 4× smaller in the index; at clinic volume that is not worth the conversion fragility, and it stays available later. |
| `citext` email | `VARCHAR(254)` with the default case-insensitive collation, plus lower-casing at the boundary | Two layers agree, which is why a mixed-case address cannot become a second account. |
| `timestamptz` | `DATETIME(3)`, UTC | The pool pins `time_zone='+00:00'` and the driver `timezone: 'Z'`; a round-trip test asserts it. `TIMESTAMP` was rejected for its 2038 limit. |
| `inet` | `VARCHAR(45)` | Fits IPv6; no arithmetic is done on it. |
| `bytea` | `BINARY(32)` for hashes, `VARBINARY` for ciphertext | Fixed width for token hashes keeps the unique index tight. |
| `jsonb` | `JSON` | MySQL's JSON is already binary; no functional index is needed yet. |
| Partial indexes | Plain indexes | MySQL has no partial indexes; the affected ones are small. |
| Monthly partitioning of `audit_log` | Not yet | MySQL partitioning requires the partition key in the primary key. Revisit in `AUD` when volume justifies it. |
| `pg_dump` + WAL archiving | `mysqldump` / `xtrabackup` + binlog | Binary logging is already on, so point-in-time recovery is available. **The restore rehearsal in Phase 0 is unchanged and still not optional.** |

## Consequences

- `documents/planning/02–04` should be read with this ADR beside them; their
  Postgres specifics are superseded, their reasoning is not.
- The Prisma `withTenant` pattern survives intact, including its trade-offs: one
  transaction per request, no slow work inside a scope, no nesting.
- If this system ever moves to Postgres, the extension stays and RLS is added
  underneath it. Nothing here has to be undone.
