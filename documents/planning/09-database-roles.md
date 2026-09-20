# Database roles, and how to stop the app owning its own tables

Satisfies **TEN-F-12** and closes **IAM-OPEN-05** / **TEN-OPEN-15**.

| | |
|---|---|
| **Applies to** | Every environment except a throwaway development database |
| **Needs** | An account with `CREATEROLE`, and `psql` |
| **Takes** | About fifteen minutes, plus a test run |
| **Reversible** | Yes. Point `DATABASE_URL` back at the owner and everything works as before. |

---

## Why

Today the application connects as `gementarcliniccare`, which owns all eleven
tables. It is not a superuser and it cannot bypass row-level security, and
because every policy is `FORCE`d they apply to the owner too. **Tenant
isolation holds.**

What does not hold is the layer behind it. The account that faces the internet
can run `DROP POLICY` or `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`. One SQL
injection in one unparameterised query, or one confused migration, and the
thing keeping clinics apart is gone with no error anywhere. Splitting the role
removes that ability entirely, which is worth doing precisely because the
scenario is unlikely.

Two accounts afterwards:

| Account | Owns the tables | Used by |
|---|:-:|---|
| `gementarcliniccare` | yes | `prisma migrate deploy`, and nothing else |
| `cliniccare_app` | no | the running API |

## Before you start

`psql` is not installed on the development machine. Install the client, or run
these from the database host:

```bash
sudo apt install postgresql-client    # Debian or Ubuntu
```

Have ready an admin connection string. Either the `postgres` superuser, or any
role with `CREATEROLE`. The application's own account has neither, which is
the point.

```bash
export ADMIN_DATABASE_URL='postgresql://postgres:...@192.168.1.104:5432/gementarcliniccare'
```

## Steps

**1. Generate a password and keep it somewhere real.** Not in the repository,
and not in the same place as the database backup.

```bash
openssl rand -base64 30
```

**2. Make sure migrations are up to date first.** The script grants on the
tables that exist, and sets default privileges for the ones that do not yet.
Running it against a half-migrated schema leaves gaps.

```bash
npm run db:migrate --workspace @gementar/api
```

**3. Run the script.** Once per environment.

```bash
psql "$ADMIN_DATABASE_URL" \
  -v app_password="'the-password-from-step-1'" \
  -f apps/api/prisma/sql/app-role.sql
```

The quoting is deliberate and easy to get wrong: the password needs single
quotes *inside* the double quotes, because psql substitutes the variable as
raw SQL text.

It ends by printing two things. The role should read `cliniccare_app, f, f, f`.
The second query should return **no rows**, meaning the application account
owns nothing.

**4. Point the application at the new account.** In the production
environment file only:

```
DATABASE_URL=postgresql://cliniccare_app:<password>@host:5432/gementarcliniccare
DB_GUARD_MODE=require
```

Keep the owner's connection string separately, for migrations. It is the
deploy step's credential, not the application's.

**5. Prove it, rather than assume it.** Run the end-to-end suite against the
new account. This is the step that matters, because a missing `GRANT` shows up
as a broken feature rather than as an error in step 3.

```bash
DATABASE_URL='postgresql://cliniccare_app:...@host:5432/gementarcliniccare' \
  npm run test:e2e --workspace @gementar/api
```

**6. Check the health endpoint.**

```bash
curl -s https://your-host/api/v1/health | jq .tenantIsolation
```

It should say `"role": "unprivileged"` and `"enforced": true`. While the
application still owns its tables it says `"table owner — policies apply, but
this account could drop them"`, which is the current state and is how you can
tell whether this was actually done.

The boot log is the third signal. Every start currently prints a warning that
the application owns its tables and should be moved to the unprivileged role.
When that line stops appearing, this is finished.

## Afterwards

**Migrations now need the owner.** Whatever runs `prisma migrate deploy` has
to be given the owner's `DATABASE_URL`, not the application's. In Jenkins that
is a separate credential on the migrate stage. If a deploy fails with
"permission denied for table", this is why.

**New tables are already handled.** The script sets default privileges *for
the owner role*, so a table created by a future migration is usable by the
application without anyone remembering to grant anything. That detail was
wrong in an earlier version of the script and would have failed at deploy
time, silently, months later.

**The audit trail keeps its revoke.** `audit_log` has `UPDATE` and `DELETE`
revoked explicitly, on top of the trigger that refuses them. When `AUD`
partitions that table (`v0-14-audit-trail.md`), each new partition inherits the
default privileges and needs the same revoke. Put it in that migration.

## If something goes wrong

Set `DATABASE_URL` back to the owner and restart. Nothing in the script
changes data, schema or policies, so there is nothing to undo. Then work out
which grant was missing from the failure in step 5 and add it to the script
rather than to the database, so the next environment gets it too.
