# Multi-Tenancy

You chose tenant-aware from day one. This document is how. It is the most important document here, because a mistake in it is a cross-clinic patient data leak — commercially fatal, and in Malaysia a PDPA matter.

## The model

Three levels:

```
Tenant        the customer — a clinic company that pays you
  └ Branch    a physical clinic
      └ ...   encounters, stock, invoices
```

### What is scoped where

This is a real design decision, not bookkeeping. Get it wrong and you will migrate data later.

| Entity | Scope | Reasoning |
|---|---|---|
| Patient | **Tenant** | A patient visiting branch B must be the same record as at branch A. One patient record across the chain is a core product promise. |
| Encounter, consultation, prescription | Tenant + **branch stamp** | Owned by the tenant, but always carries the branch where it happened, for reporting and access control. |
| Product (catalogue) | **Tenant** | One medicine catalogue chain-wide. |
| Batch, stock movement | **Branch** | Physical stock sits in one place. Non-negotiable. |
| Invoice, payment | Tenant + **branch stamp** | Revenue is attributed to a branch. |
| User | **Tenant**, with per-branch role assignments | One login, access to several branches. |
| Membership | **Tenant** | Valid chain-wide, with branch-specific benefits in V1. |

So: `tenant_id` on **every** table, and `branch_id` additionally where the table above says branch.

### Users and branches

```
user            tenant_id, email, password_hash, status
user_branch_role  user_id, branch_id, role
```

A user's accessible branches come from `user_branch_role`. The session carries `tenantId` and the currently selected `branchId`. Switching branch is an explicit action, re-validated server-side every request — never trusted from the client.

## Enforcement: defence in depth

Two independent layers. Either alone will eventually fail.

### Layer 1 — application scoping

Tenant comes from the authenticated session and **nothing else**. Never from a request body, query string, path parameter or header.

```ts
// modules/tenancy/tenant-context.ts
// Request-scoped, populated by the auth guard from the session.
export interface TenantContext {
  tenantId: string
  branchId: string
  userId: string
  roles: Role[]
}
```

If an endpoint ever accepts a `tenantId` input, that is a bug, and it is the bug that turns into a breach. Consider a CI grep for `tenantId` appearing in any DTO.

### Layer 2 — Postgres Row Level Security

The backstop for the day a `where` clause is forgotten.

```sql
ALTER TABLE patient ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON patient
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`USING` filters reads, `WITH CHECK` blocks writes that would create a row belonging to another tenant. You need both — a policy with only `USING` lets an attacker insert rows into someone else's tenant.

### Three ways to get RLS wrong

These are the actual failure modes, all common:

1. **Connecting as the table owner.** Table owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is set. Set it, *and* connect as a dedicated non-owner role.
2. **Granting `BYPASSRLS`.** Never on the application role. Migrations run as a separate privileged role.
3. **`current_setting` without the `true` argument.** Without it, an unset variable raises instead of returning null, and the failure mode is a confusing 500 rather than a clean deny. With `true` plus `NOT NULL` on `tenant_id`, an unset variable denies everything, which is the correct default.

## Prisma and RLS — the sharp edge

Prisma has no built-in notion of a per-request session variable, and this is where most implementations quietly break. The setting must be applied on the **same connection** as the query, and the pool hands out connections per query.

The workable pattern is to run each request's work inside one interactive transaction, setting the variable locally at the start:

```ts
// shared/prisma/tenant-client.ts
export function withTenant<T>(
  prisma: PrismaClient,
  ctx: TenantContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // set_config(..., true) = LOCAL to this transaction.
    // Safe under PgBouncer transaction pooling; resets on commit or rollback.
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId}::text, true)`
    return fn(tx)
  })
}
```

Wire this into a Nest interceptor so every request handler receives an already-scoped `tx`, and services take that `tx` rather than reaching for the global client.

**Understand the tradeoffs before committing:**

- Every request becomes a transaction. For a clinic's load this is irrelevant; know that it is true.
- Long transactions hold connections. Never do PDF generation, S3 uploads or outbound HTTP inside the scoped transaction — gather data, close it, then do the slow work.
- `$transaction` cannot nest. Services must accept a `tx` rather than starting their own, which is good discipline anyway.
- Prisma's `$extends` query-interception approach is tempting and is worse here: it wraps each individual query in its own transaction, so a multi-statement operation loses atomicity.

If this pattern becomes painful, the honest alternative is to drop RLS to advisory and rely on a repository layer that mechanically injects `tenant_id`. It is weaker. Do not make that trade quietly.

## Testing isolation

Non-negotiable, and written in Phase 0 before there are features to protect:

```
tenant-isolation.spec.ts
  ├ seed tenant A with a patient, tenant B with a patient
  ├ as A: list patients → exactly A's, never B's
  ├ as A: read B's patient by its real id → not found
  ├ as A: update B's patient by id → not found, B's row unchanged
  ├ as A: insert a row carrying B's tenant_id → rejected by WITH CHECK
  └ with app.tenant_id unset → zero rows, never all rows
```

Run it in CI on every push. Then add one generated test that, for **every** table in the schema, asserts RLS is enabled and forced — so a new table added in eighteen months cannot silently ship unprotected. That single generated test is worth more than any amount of care.

## Branch-level access

RLS handles tenants. Branch access is finer-grained and belongs in the application layer, because the rules are genuinely conditional: an org admin sees all branches, a receptionist sees one, a locum doctor sees the branches they are rostered to.

Enforce it in a guard reading `user_branch_role`, and include `branch_id` in every query that is branch-scoped. Do not try to express this in RLS policies — it gets complicated fast and the complexity lands in SQL where it is hardest to test.

## Clinical data access

A subtlety worth deciding before V1: within one tenant, should every doctor see every patient's full clinical history?

Clinically, usually yes — continuity of care depends on it. But receptionists and finance staff should not see consultation notes at all, and that boundary must hold at the API level, not by hiding UI. Model it as a permission (`clinical.read`) checked in the clinical module, and log every clinical record view to the audit trail (`05`).
