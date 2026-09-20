-- An application account that is not the owner of the tables it queries.
--
-- Row-level security is FORCEd on every tenant-owned table, so it applies to
-- the owner too. Connecting as a separate, unprivileged role is still worth
-- doing: it removes the ability to drop a policy, disable RLS, or alter the
-- schema at all from the account that faces the internet.
--
-- Run as a superuser or the database owner, once per environment, AFTER
-- migrations. Then point the application's DATABASE_URL at cliniccare_app and
-- keep the owner's credentials for migrations only.
--
--   psql "$ADMIN_DATABASE_URL" -v app_password="'a-long-random-password'" \
--        -f prisma/sql/app-role.sql

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cliniccare_app') THEN
    CREATE ROLE cliniccare_app LOGIN;
  END IF;
END
$$;

ALTER ROLE cliniccare_app PASSWORD :app_password;

-- Never. This is the single grant that would silently undo tenant isolation.
ALTER ROLE cliniccare_app NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO cliniccare_app', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO cliniccare_app;

-- Data, yes. Schema changes, no.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cliniccare_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cliniccare_app;

-- Default privileges apply to objects created *by a particular role*, so they
-- have to name the role that runs migrations. Written as `ALTER DEFAULT
-- PRIVILEGES IN SCHEMA public` with no `FOR ROLE`, they would attach to
-- whoever ran this script — and if that was a superuser rather than the
-- owner, every table added by a later migration would be unreadable to the
-- application, at deploy time, with no warning here.
--
-- The owner is read off an existing table rather than passed in, so this is
-- correct however it is invoked.
DO $$
DECLARE
  owner_role name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_role
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'tenant';

  IF owner_role IS NULL THEN
    RAISE EXCEPTION
      'No public.tenant table found. Run the migrations before this script.';
  END IF;

  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cliniccare_app', owner_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT USAGE, SELECT ON SEQUENCES TO cliniccare_app', owner_role);

  RAISE NOTICE 'Tables created by % in future will be usable by cliniccare_app.', owner_role;
END
$$;

-- The audit trail is append-only at the database level as well as in the
-- application, so the trigger stays the last word; this makes the intent
-- visible in the grants too. When AUD partitions the table (v0-14), each new
-- partition will pick up the default privileges above, so re-run this REVOKE
-- for them — or better, have that migration do it.
REVOKE UPDATE, DELETE ON "audit_log" FROM cliniccare_app;

-- Should read: cliniccare_app, f, f, f. Anything else is a mistake.
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb
  FROM pg_roles WHERE rolname = 'cliniccare_app';

-- And this should return no rows: the application account must own nothing.
SELECT c.relname AS unexpectedly_owned_by_app
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND pg_get_userbyid(c.relowner) = 'cliniccare_app';
