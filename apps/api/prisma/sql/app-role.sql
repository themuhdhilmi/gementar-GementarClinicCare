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
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cliniccare_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cliniccare_app;

-- The audit trail is append-only at the database level as well as in the
-- application, so the trigger stays the last word; this makes the intent
-- visible in the grants too.
REVOKE UPDATE, DELETE ON "audit_log" FROM cliniccare_app;

SELECT rolname, rolsuper, rolbypassrls, rolcreatedb
  FROM pg_roles WHERE rolname = 'cliniccare_app';
