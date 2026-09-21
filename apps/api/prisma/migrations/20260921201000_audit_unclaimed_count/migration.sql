-- AUD-N-04: let the maintenance job see the stranded rows it exists to find.
--
-- Every audit partition carries its own row-level security, so a
-- partition reached directly is as tenant-scoped as the parent. That is
-- what we want — and it means a platform-scope query, which has no
-- tenant, counts zero rows in `audit_log_unclaimed` no matter how many
-- are in there. The check that was meant to shout would have been silent
-- forever, which is worse than not having it.
--
-- A SECURITY DEFINER function is the narrow exception: it returns one
-- number, across every clinic, and no row. It cannot be used to read
-- anybody's data because it never returns any.
CREATE OR REPLACE FUNCTION audit_log_unclaimed_count()
  RETURNS bigint
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT count(*)::bigint FROM audit_log_unclaimed;
$$;
