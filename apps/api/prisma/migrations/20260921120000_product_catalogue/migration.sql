-- Product catalogue (INV, the first half of v0-09-inventory.md).
--
-- Built ahead of the rest of inventory because prescribing depends on it.
-- The two safety checks in `RX` are allergy and duplicate, and both need to
-- know what a product *is*: its generic name and its drug class. Without
-- that, every warning degrades to "check by hand", which is the warning
-- everybody learns to ignore.
--
-- Batches, the stock ledger, counts and reconciliation stay in Phase 3.
-- Nothing here assumes them.

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('MEDICINE', 'CONSUMABLE', 'SUPPLY', 'SERVICE_ITEM');

-- CreateEnum
CREATE TYPE "PriceBasis" AS ENUM ('PRODUCT', 'BATCH');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "product_category" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(80) NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sku" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "type" "ProductType" NOT NULL,
    "category_id" UUID,
    "brand" VARCHAR(120),
    "generic_name" VARCHAR(200),
    "drug_class" VARCHAR(120),
    "form" VARCHAR(40),
    "strength_text" VARCHAR(60),
    "strength_value" DECIMAL(12,4),
    "strength_unit" VARCHAR(20),
    "dispense_unit" VARCHAR(20) NOT NULL,
    "pack_size" INTEGER NOT NULL DEFAULT 1,
    "is_pack_dispensed" BOOLEAN NOT NULL DEFAULT false,
    "is_batched" BOOLEAN NOT NULL DEFAULT true,
    "is_controlled" BOOLEAN NOT NULL DEFAULT false,
    "is_cold_chain" BOOLEAN NOT NULL DEFAULT false,
    "max_daily_dose" DECIMAL(12,4),
    "max_daily_dose_unit" VARCHAR(20),
    "default_dose" DECIMAL(10,3),
    "default_dose_unit" VARCHAR(20),
    "default_route" VARCHAR(20),
    "default_frequency" VARCHAR(20),
    "selling_price" BIGINT NOT NULL DEFAULT 0,
    "price_basis" "PriceBasis" NOT NULL DEFAULT 'PRODUCT',
    "markup_pct" DECIMAL(6,2),
    "barcodes" VARCHAR(60)[],
    "notes" VARCHAR(1000),
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "search_text" VARCHAR(600) NOT NULL DEFAULT '',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_price_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "selling_price" BIGINT NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "set_by" UUID,
    "reason" VARCHAR(300),

    CONSTRAINT "product_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_branch_setting" (
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "min_stock" DECIMAL(12,3),
    "reorder_level" DECIMAL(12,3),
    "reorder_qty" DECIMAL(12,3),

    CONSTRAINT "product_branch_setting_pkey" PRIMARY KEY ("tenant_id","product_id","branch_id")
);

-- CreateIndex
CREATE INDEX "product_category_tree_idx" ON "product_category"("tenant_id", "parent_id", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "product_category_id_tenant_key" ON "product_category"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_category_name_key" ON "product_category"("tenant_id", "parent_id", "name");

-- CreateIndex
CREATE INDEX "product_type_idx" ON "product"("tenant_id", "type", "status");

-- CreateIndex
CREATE INDEX "product_generic_idx" ON "product"("tenant_id", "generic_name");

-- CreateIndex
CREATE INDEX "product_class_idx" ON "product"("tenant_id", "drug_class");

-- CreateIndex
CREATE UNIQUE INDEX "product_sku_key" ON "product"("tenant_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_id_tenant_key" ON "product"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "product_price_history_idx" ON "product_price_history"("tenant_id", "product_id", "effective_from");

-- CreateIndex
CREATE INDEX "product_branch_setting_branch_idx" ON "product_branch_setting"("tenant_id", "branch_id");

-- AddForeignKey
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_parent_id_tenant_id_fkey" FOREIGN KEY ("parent_id", "tenant_id") REFERENCES "product_category"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_tenant_id_fkey" FOREIGN KEY ("category_id", "tenant_id") REFERENCES "product_category"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_product_id_tenant_id_fkey" FOREIGN KEY ("product_id", "tenant_id") REFERENCES "product"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_branch_setting" ADD CONSTRAINT "product_branch_setting_product_id_tenant_id_fkey" FOREIGN KEY ("product_id", "tenant_id") REFERENCES "product"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_branch_setting" ADD CONSTRAINT "product_branch_setting_branch_id_tenant_id_fkey" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branch"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- A medicine has a generic name (INV-F-01)
--
-- Not a nicety. An allergy is recorded against a substance, and matching it
-- against what is being prescribed needs the generic name rather than the
-- brand on the box: a patient allergic to penicillin is allergic to Augmentin
-- whether or not anybody wrote that down.
--
-- A check constraint rather than application validation alone, because an
-- import is the likeliest way a medicine gets in without one.
-- --------------------------------------------------------------------------
ALTER TABLE "product"
  ADD CONSTRAINT product_medicine_has_generic
  CHECK ("type" <> 'MEDICINE' OR "generic_name" IS NOT NULL);

-- --------------------------------------------------------------------------
-- Searching the catalogue (INV-F-06)
--
-- A dispenser types three letters of a brand and expects the generic to
-- come back, or the other way round. `search_text` holds name, generic and
-- brand together, lower case, maintained by a trigger for the same reason
-- the patient's normalised name is: search that silently stops matching is
-- a bug nobody reports.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION product_set_search_text() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_text := lower(
    btrim(
      coalesce(NEW.name, '') || ' ' ||
      coalesce(NEW.generic_name, '') || ' ' ||
      coalesce(NEW.brand, '') || ' ' ||
      coalesce(NEW.strength_text, '') || ' ' ||
      coalesce(NEW.sku, '')
    )
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER product_search_text_trigger
  BEFORE INSERT OR UPDATE OF name, generic_name, brand, strength_text, sku ON "product"
  FOR EACH ROW EXECUTE FUNCTION product_set_search_text();

CREATE INDEX product_search_trgm_idx
  ON "product" USING gin ("search_text" gin_trgm_ops);

-- A barcode is scanned, so the lookup has to be exact and fast.
CREATE INDEX product_barcode_idx ON "product" USING gin ("barcodes");

-- --------------------------------------------------------------------------
-- Price history is a record, not a log (INV-F-02)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION product_price_history_append_only() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'product_price_history is append-only: % is not permitted.', TG_OP;
END
$$;

CREATE TRIGGER product_price_history_no_update
  BEFORE UPDATE ON "product_price_history"
  FOR EACH ROW EXECUTE FUNCTION product_price_history_append_only();

CREATE TRIGGER product_price_history_no_delete
  BEFORE DELETE ON "product_price_history"
  FOR EACH ROW EXECUTE FUNCTION product_price_history_append_only();

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
-- --------------------------------------------------------------------------
ALTER TABLE "product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "product_category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_category" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_category"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "product_price_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_price_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_price_history"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "product_branch_setting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_branch_setting" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_branch_setting"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
