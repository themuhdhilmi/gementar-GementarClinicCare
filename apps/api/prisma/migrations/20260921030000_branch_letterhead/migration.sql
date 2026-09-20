-- TEN-F-10: the letterhead a printed document carries.
--
-- The header and footer text live in the existing `letterhead` jsonb. The logo
-- is binary and gets columns of its own, so that reading a branch — which
-- happens on every administrative screen — never drags an image along with it.
-- It is served by its own endpoint instead.
--
-- Stored in the database rather than on disk or in S3 deliberately: it is one
-- small file per branch, it must be included in the same backup as the rows
-- that reference it, and a clinic restoring from a dump should not come back
-- with its invoices unbranded. When object storage exists (V1), this becomes a
-- key instead, and the migration is a one-way copy.

ALTER TABLE "branch"
  ADD COLUMN "letterhead_logo" bytea,
  ADD COLUMN "letterhead_logo_mime" varchar(60),
  ADD COLUMN "letterhead_logo_updated_at" timestamptz(3);

COMMENT ON COLUMN "branch"."letterhead_logo" IS
  'TEN-F-10: branch logo for printed documents. At most 512 KiB, PNG/JPEG/SVG.';
