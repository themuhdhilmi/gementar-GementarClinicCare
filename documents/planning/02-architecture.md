# Architecture

## Stack

Already scaffolded:

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js 16, App Router, TypeScript, Tailwind v4 | `apps/web`, port 3000 |
| Backend | NestJS 12, TypeScript | `apps/api`, port 3001 |
| Database | PostgreSQL 16+ | Single instance. RLS is load-bearing, see `03`. |
| ORM | Prisma | Migrations are the schema source of truth |
| Storage | S3-compatible | Patient documents, scans. Any provider. |
| Realtime | SSE | Not WebSocket — see below |
| Deploy | Docker Compose on one VPS, Caddy in front | |

Deliberately **not** in V0: Redis, BullMQ, message brokers, Kubernetes, microservices, a separate BFF. Each of these is a thing that breaks at 2am and only you can fix it. Add Redis when a real background job exists — the first genuine one is WhatsApp/SMS sending in V1.

## Modular monolith

One deployable, hard internal seams. The seams matter because they are what lets this become services later *if* it ever needs to, and more immediately because they are what stops a 44-table schema turning into mud.

```
apps/api/src/
  modules/
    identity/       auth, users, sessions, roles
    tenancy/        tenant, branch, request context
    patient/        patient, allergies, chronic conditions
    encounter/      visit lifecycle, queue, state machine
    clinical/       triage vitals, consultation, diagnosis
    prescription/   prescriptions and items
    dispensing/     pharmacy queue, batch pick, dispense
    inventory/      products, batches, stock ledger
    procedure/      procedure catalogue and performed procedures
    billing/        invoices, line items, discounts
    payment/        payments, reconciliation
    document/       PDF generation, templates, storage
    audit/          audit log write + query
    reporting/      read-only projections
  shared/
    prisma/  money/  ids/  errors/  pagination/  sse/
```

### The one rule that keeps this clean

> A module may only touch its own tables. Cross-module access goes through the other module's exported service.

So `billing` never issues a Prisma query against `prescription_item`. It asks `PrescriptionService` for what it needs. This is annoying perhaps twice a month and saves the codebase.

Worth adding an ESLint boundary rule once the module list settles, so it is enforced rather than remembered.

### Dependency direction

`identity` and `tenancy` are depended on by everything and depend on nothing. `reporting` depends on many and is depended on by none. Everything else should form a rough line following the patient journey — if you find `patient` needing to import from `billing`, something is modelled wrong.

## Frontend structure

Organise by **role workspace**, not by table. A receptionist and a pharmacist use disjoint parts of the system, and each should feel like it was built for them.

```
apps/web/src/app/
  (auth)/login
  (clinic)/
    reception/      register, search, check-in, queue
    triage/         queue → vitals entry
    doctor/         my queue → consultation workspace
    pharmacy/       prescription queue → dispense
    cashier/        billing → payment → receipt
    admin/          catalogue, pricing, staff, settings
  display/          waiting-room TV, no auth, branch-token scoped
```

The consultation workspace is the screen a doctor lives in for six hours a day. It deserves disproportionate design effort: keyboard-first, no modal stacking, patient history and allergies always visible without a click.

## Realtime queue

SSE, not WebSocket. One-directional server→client is all the queue board needs, it survives proxies without special config, it reconnects automatically, and it needs no extra infrastructure.

```
GET /api/v1/branches/:branchId/queue/stream   →  text/event-stream
```

Emit on every encounter state transition. With one Node process, an in-memory `EventEmitter` fanning out to connected clients is sufficient and correct. When a second process appears (V2), swap the fan-out for Postgres `LISTEN/NOTIFY` — the client contract does not change.

Have clients treat events as **invalidation signals**, not as state: on event, refetch the queue. Slightly more traffic, dramatically fewer state-sync bugs.

## API conventions

- `/api/v1/...`, versioned from day one
- Branch scope in the path where it is a real scope: `/branches/:branchId/queue`
- Tenant **never** in the path or body — it comes from the session, always (`03`)
- Zod (or Nest `ValidationPipe` with class-validator) at every boundary; no unvalidated input reaches a service
- Errors: RFC 7807-ish `{ type, title, status, detail, traceId }`
- Idempotency keys on payment and dispense endpoints — both are operations a nervous user will double-click

## Deployment

```
VPS
├── Caddy            TLS, reverse proxy
├── web    (Next)    :3000
├── api    (Nest)    :3001
└── postgres         :5432, volume-mounted
```

Single `docker-compose.yml`, image tags from git SHA, deploy by pulling and restarting. A deploy should be one command and under two minutes, because you will be doing it tired.

### Backups — do this in Phase 0, not later

This is a clinic's patient records. Losing them is not a bug, it is an ending.

- `pg_dump` nightly, encrypted, pushed off-box to object storage
- 30 daily, 12 monthly retained
- **A restore rehearsed and timed before go-live.** An untested backup is not a backup.
- Postgres WAL archiving for point-in-time recovery before the second clinic joins

### Environments

`local` → `staging` → `production`. Staging exists so you never test a migration for the first time against real patient data. It costs one more small container and it is not optional once the clinic is live.

## Testing strategy

Solo, so the test suite has to earn every minute. Concentrate it where a bug is expensive and silent:

| Priority | Area | Why |
|---|---|---|
| Must | Tenant isolation (`03`) | Silent cross-clinic leak |
| Must | Stock ledger arithmetic | Silent wrong inventory |
| Must | Invoice totals, discounts, rounding | Silent wrong money |
| Must | Encounter state machine | Stuck patients |
| Should | Allergy and duplicate warnings | Patient safety |
| Should | Consultation sign/lock/amend | Legal integrity |
| Light | CRUD, UI | Cheap to find manually |

Integration tests against a real Postgres in Docker, not mocks — the things worth testing here (RLS, transactions, constraints) are exactly the things mocks cannot check.
