# ADR-0002 — PostgreSQL, and row-level security as the second isolation layer

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-21 |
| **Supersedes** | [ADR-0001](adr-0001-mysql-instead-of-postgres.md) |
| **Affects** | `documents/planning/02-architecture.md`, `03-multi-tenancy.md`, `04-data-model.md`, every module |
| **Decided while building** | `v0-01-identity-access.md` |

## Context

ADR-0001 recorded building on MySQL 8, because that was the database available,
and documented what was lost: reads had one isolation layer instead of two, the
write-side backstop needed a database administrator to install triggers the
application account could not create, and three planned capabilities had no
MySQL equivalent.

A PostgreSQL 16.15 server was then made available at the same host, with an
account that is **not a superuser and does not hold `BYPASSRLS`** — which is
precisely the shape row-level security needs.

## Decision

Move to PostgreSQL 16, and implement tenant isolation as the planning documents
originally specified.

**Layer 1, unchanged.** The Prisma client extension in
`src/shared/prisma/tenant-scope.ts` still injects `tenant_id` into every query,
refuses to run against a tenant-owned model with no scope open, and refuses a
model nobody has classified. It survived the move intact, which is a reasonable
sign it was the right shape.

**Layer 2, now real.** `prisma/migrations/*_row_level_security` enables and
**forces** row-level security on all nine tenant-owned tables, with `USING` and
`WITH CHECK` policies reading `app.tenant_id` from the transaction. `FORCE`
matters: without it the owner of a table bypasses its own policies, and the
application account owns these tables.

Three things follow that MySQL could not offer:

1. **Reads are covered.** Raw SQL that forgets a `where` clause returns the
   current tenant's rows and nothing else. There is a test for exactly that.
2. **Unset means deny.** `current_setting('app.tenant_id', true)` returns NULL
   when nothing is set, every policy comparison against NULL is false, and a
   transaction with no scope sees zero rows and cannot insert. Also tested.
3. **No administrator is in the loop.** Policies, the audit-immutability trigger
   and the last-administrator trigger all ship inside `prisma migrate deploy`,
   under the application's own account. The separate hardening script that a DBA
   had to remember is gone.

**The escape hatch is narrow and named.** Authentication has to read across
tenants before it knows which tenant it is: a session by token hash, a user by
email, a reset token by hash. Those tables carry a second permissive policy that
opens only when the transaction sets `app.auth_bypass`. **`branch`,
`user_branch_role` and `audit_log` have no bypass policy at all** and are
unreachable outside a tenant scope, by any caller, including the nightly job.

**Boot refuses to lie about it.** The process checks at startup that every
tenant-owned table has RLS enabled and forced, that no table has appeared
without either protection or a written exemption, and that the connecting role
is neither a superuser nor holds `BYPASSRLS` (TEN-R-02, TEN-R-03).
`DB_GUARD_MODE=require` makes any of those a refusal to start;
`/api/v1/health` reports it either way.

## What changed in the schema

| MySQL | PostgreSQL | Note |
|---|---|---|
| `CHAR(36)` ids | `uuid` | Native type, half the storage, still UUID v7 from the application. |
| `DATETIME(3)` | `timestamptz(3)` | What the data model asked for originally. |
| `BINARY(32)` / `VARBINARY` | `bytea` | |
| `JSON` | `jsonb` | Indexable later without a migration. |
| Case-insensitive collation | `UNIQUE (tenant_id, lower(email))` | MySQL gave case-insensitivity by accident of collation; here it is stated. |
| Trigger-based write guard | RLS policies | Reads covered too, and no DBA step. |
| `audit_log` foreign keys | none | An append-only log must not block work on the rows it describes, and its entries outlive them. `actor_name` was already snapshotted for the same reason. |

## Consequences, including the awkward ones

- **PostgreSQL semantics differ where it matters.** A failed statement aborts the
  whole transaction, so "try the insert, catch the unique violation, carry on"
  is not valid. The MFA replay check now claims its time step with
  `createMany({ skipDuplicates: true })` and reads the row count instead. This
  pattern is worth remembering for every module that follows.
- **Placeholders are `$1`, not `?`.** One raw query had to change; there is
  little raw SQL by design.
- **Deleting test data is now an administrative act**, because the audit trigger
  and the last-administrator trigger exist to stop the application doing it. The
  test harness uses an owner connection and disables those triggers briefly,
  which is also a fair description of what a retention job will have to do.
- The three capabilities named in ADR-0001 as future losses — trigram search for
  patient names, partial unique indexes for soft deletes, and `LISTEN/NOTIFY`
  for the queue when a second process appears — are all available again.
- Backups change tool, not principle: `pg_dump` nightly, encrypted, off-box,
  WAL archiving before the second clinic. **The rehearsed restore in Phase 0 is
  still not optional.**
