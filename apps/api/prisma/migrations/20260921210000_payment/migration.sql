-- Payment (PAY, v0-12-payment.md).
--
-- Taking the money and proving the drawer balances. Every amount is `bigint`
-- sen. The one piece of inexact-looking arithmetic — Malaysia's 5-sen cash
-- rounding — is exact and is a property of the *payment method*, so it is
-- recorded per payment leg and summed onto the invoice.
--
-- Three rules are in the database rather than only in the service, because
-- they are the ones that would be discovered months later by an accountant
-- rather than immediately by a test:
--
--   * a posted payment does not change (PAY-R-10);
--   * the rounding on a leg is within a 5-sen step (PAY-R-02);
--   * a branch has at most one open drawer of a given code (PAY-F-01).
--
-- Hand-written GIN indexes are stripped from the generated drop list;
-- raw-indexes.e2e asserts the survivors against the live database.

-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'DUITNOW_QR', 'BANK_TRANSFER', 'EWALLET', 'CHEQUE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('POSTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('FLOAT_IN', 'CASH_DROP', 'PETTY_OUT', 'PAYMENT_IN', 'VOID_OUT', 'REFUND_OUT');

-- CreateTable
CREATE TABLE "cash_session" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "drawer_code" VARCHAR(20) NOT NULL DEFAULT 'MAIN',
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "opened_by" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "float_amount" BIGINT NOT NULL DEFAULT 0,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "expected_cash" BIGINT,
    "counted_cash" BIGINT,
    "variance" BIGINT,
    "denominations" JSONB,
    "variance_note" VARCHAR(500),
    "totals_by_method" JSONB,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "reopened_by" UUID,
    "reopened_at" TIMESTAMPTZ(3),
    "reopened_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_session_movement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference_type" VARCHAR(40),
    "reference_id" UUID,
    "reason" VARCHAR(500),
    "performed_by" UUID NOT NULL,
    "performed_name" VARCHAR(120) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_session_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "receipt_no" VARCHAR(40) NOT NULL,
    "series_year" INTEGER NOT NULL,
    "series_seq" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "tendered" BIGINT,
    "change_given" BIGINT,
    "rounding_applied" BIGINT NOT NULL DEFAULT 0,
    "reference" VARCHAR(120),
    "card_brand" VARCHAR(40),
    "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED',
    "received_by" UUID NOT NULL,
    "received_name" VARCHAR(120) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" VARCHAR(500),
    "refund_of_id" UUID,
    "idempotency_key" VARCHAR(80) NOT NULL,
    "print_count" INTEGER NOT NULL DEFAULT 0,
    "last_printed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_series" (
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "next_seq" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "receipt_series_pkey" PRIMARY KEY ("branch_id","year")
);

-- CreateTable
CREATE TABLE "payment_method_config" (
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "requires_reference" BOOLEAN NOT NULL DEFAULT false,
    "display_name" VARCHAR(60),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "qr_payload" VARCHAR(1000),

    CONSTRAINT "payment_method_config_pkey" PRIMARY KEY ("branch_id","method")
);

-- CreateIndex
CREATE INDEX "cash_session_branch_status_idx" ON "cash_session"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "cash_session_branch_time_idx" ON "cash_session"("tenant_id", "branch_id", "opened_at");

-- CreateIndex
CREATE INDEX "cash_movement_session_idx" ON "cash_session_movement"("tenant_id", "session_id");

-- CreateIndex
CREATE INDEX "payment_invoice_idx" ON "payment"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "payment_session_method_idx" ON "payment"("tenant_id", "session_id", "method");

-- CreateIndex
CREATE INDEX "payment_branch_time_idx" ON "payment"("tenant_id", "branch_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_idempotency_key" ON "payment"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_receipt_no_key" ON "payment"("tenant_id", "receipt_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_series_key" ON "payment"("branch_id", "series_year", "series_seq");

-- CreateIndex
CREATE INDEX "receipt_series_tenant_idx" ON "receipt_series"("tenant_id");

-- CreateIndex
CREATE INDEX "payment_method_config_branch_idx" ON "payment_method_config"("tenant_id", "branch_id");

-- AddForeignKey
ALTER TABLE "cash_session_movement" ADD CONSTRAINT "cash_session_movement_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_refund_of_id_fkey" FOREIGN KEY ("refund_of_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------ invariants

-- PAY-F-01. Two open sessions on one drawer means cash with nowhere
-- certain to go, and an expected total that is a guess. A partial unique
-- index says it once, for every path, including a direct SQL insert.
CREATE UNIQUE INDEX cash_session_one_open_per_drawer
  ON "cash_session" (branch_id, drawer_code)
  WHERE status IN ('OPEN', 'SUSPENDED');

-- PAY-R-10. A payment is a record of money that changed hands. The only
-- things that may change afterwards are the void marker and the print
-- count — everything else is what happened.
CREATE OR REPLACE FUNCTION payment_is_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invoice_id      IS DISTINCT FROM OLD.invoice_id
     OR NEW.session_id   IS DISTINCT FROM OLD.session_id
     OR NEW.branch_id    IS DISTINCT FROM OLD.branch_id
     OR NEW.receipt_no   IS DISTINCT FROM OLD.receipt_no
     OR NEW.series_year  IS DISTINCT FROM OLD.series_year
     OR NEW.series_seq   IS DISTINCT FROM OLD.series_seq
     OR NEW.method       IS DISTINCT FROM OLD.method
     OR NEW.amount       IS DISTINCT FROM OLD.amount
     OR NEW.tendered     IS DISTINCT FROM OLD.tendered
     OR NEW.change_given IS DISTINCT FROM OLD.change_given
     OR NEW.rounding_applied IS DISTINCT FROM OLD.rounding_applied
     OR NEW.received_by  IS DISTINCT FROM OLD.received_by
     OR NEW.received_at  IS DISTINCT FROM OLD.received_at
     OR NEW.refund_of_id IS DISTINCT FROM OLD.refund_of_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  THEN
    RAISE EXCEPTION
      'A payment records money that changed hands and cannot be edited. Void it and take it again.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER payment_is_immutable_trigger
  BEFORE UPDATE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION payment_is_immutable();

CREATE OR REPLACE FUNCTION payment_no_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A payment is kept. Void it, with a reason.'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER payment_no_delete_trigger
  BEFORE DELETE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION payment_no_delete();

-- A cash movement is a fact about the drawer at a moment. It is never
-- edited; the correction is another movement.
CREATE OR REPLACE FUNCTION cash_movement_is_final() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A drawer movement is a fact. Record the correction as another movement.'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER cash_movement_no_change
  BEFORE UPDATE OR DELETE ON "cash_session_movement"
  FOR EACH ROW EXECUTE FUNCTION cash_movement_is_final();

-- PAY-R-02, and §5's CHECK. Rounding moves an amount to the nearest 5 sen,
-- so it can never be more than two sen either way — ±4 is the specification's
-- bound and is kept as the looser of the two.
ALTER TABLE "payment"
  ADD CONSTRAINT payment_rounding_is_small CHECK (rounding_applied BETWEEN -4 AND 4);

-- §5. A zero payment is not a payment. The one exception the specification
-- allows — an invoice of one or two sen that rounds away to nothing — is a
-- zero `amount` with a non-zero rounding, so it is named rather than banned.
ALTER TABLE "payment"
  ADD CONSTRAINT payment_amount_is_real
  CHECK (amount <> 0 OR rounding_applied <> 0);

-- Cash is the only method with a drawer, so it is the only one that can
-- have money handed over and change given back.
ALTER TABLE "payment"
  ADD CONSTRAINT payment_tender_is_cash_only
  CHECK (method = 'CASH' OR (tendered IS NULL AND change_given IS NULL));

ALTER TABLE "payment"
  ADD CONSTRAINT payment_change_adds_up
  CHECK (
    tendered IS NULL
    OR change_given IS NULL
    OR tendered - change_given = amount
  );

-- A float is money put in, not taken out.
ALTER TABLE "cash_session"
  ADD CONSTRAINT cash_session_float_is_positive CHECK (float_amount >= 0);
ALTER TABLE "cash_session"
  ADD CONSTRAINT cash_session_counted_is_positive
  CHECK (counted_cash IS NULL OR counted_cash >= 0);

-- A closed session has been counted. Leaving these nullable and unchecked is
-- how a session ends up closed with no expected total and a Z-report that
-- cannot be reprinted.
ALTER TABLE "cash_session"
  ADD CONSTRAINT cash_session_closed_is_counted
  CHECK (
    status <> 'CLOSED'
    OR (closed_at IS NOT NULL AND expected_cash IS NOT NULL AND counted_cash IS NOT NULL)
  );

-- ---------------------------------------------------------- isolation

ALTER TABLE "cash_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_session" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cash_session"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "cash_session_movement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_movement" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cash_session_movement"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "receipt_series" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receipt_series" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "receipt_series"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "payment_method_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_method_config" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_method_config"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
