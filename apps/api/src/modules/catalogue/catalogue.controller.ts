import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuditAction } from '../audit/audit.actions.js';
import { Audited } from '../audit/audit.decorators.js';
import { ProductType } from '../../generated/prisma/enums.js';
import { newId } from '../../shared/ids/uuid.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/domain-errors.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { CatalogueService, DISPENSE_UNITS } from './catalogue.service.js';
import { ProductStockLookup } from './stock-lookup.js';
import { CatalogueImportService } from './catalogue-import.service.js';
import {
  BranchStockSettingDto,
  CategoryDto,
  ProductDto,
  RetireProductDto,
  UpdateProductDto,
} from './dto/catalogue.dto.js';

@Controller()
export class CatalogueController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly imports: CatalogueImportService,
    private readonly db: DbService,
    private readonly stock: ProductStockLookup,
  ) {}

  /** INV-F-06. Everybody who touches a patient can look one up. */
  @Get('products')
  @RequirePermission('stock.read')
  async search(
    @Ctx() ctx: TenantContext,
    @Query('q') q = '',
    @Query('type') type?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    if (type && !Object.values(ProductType).includes(type as ProductType)) {
      throw new BadRequestError(`"${type}" is not a kind of product.`, 'invalid_type');
    }
    const items = await this.catalogue.search(q, {
      type: type as ProductType | undefined,
      includeInactive: includeInactive === 'true',
    });

    // RX-F-04: what is on the shelf at the branch the caller is working
    // at, beside each result. Absent rather than zero when the stock
    // module has not registered — "none" and "not known" are different
    // things to a prescriber.
    const stock = await this.stock.for(
      this.db.tx(),
      ctx.branchId,
      items.map((item) => item.id),
    );

    return {
      items: items.map((item) => {
        const found = stock.get(item.id);
        return {
          ...item,
          onHand: this.stock.available ? (found?.onHand ?? 0) : null,
          nearestExpiry: found?.nearestExpiry ?? null,
        };
      }),
      stockKnown: this.stock.available,
      units: DISPENSE_UNITS,
    };
  }

  @Get('products/:id')
  @RequirePermission('stock.read')
  async get(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    void ctx;
    const tx = this.db.tx();
    return {
      product: this.catalogue.present(await this.catalogue.getOrThrow(tx, id)),
      priceHistory: await this.catalogue.priceHistory(tx, id),
    };
  }

  @Post('products')
  @Audited(AuditAction.ProductCreated)
  @RequirePermission('catalogue.write')
  @HttpCode(201)
  async create(@Ctx() ctx: TenantContext, @Body() dto: ProductDto) {
    return this.catalogue.create(ctx, dto);
  }

  @Patch('products/:id')
  @Audited(AuditAction.ProductUpdated)
  @RequirePermission('catalogue.write')
  async update(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.catalogue.update(ctx, id, dto);
  }

  @Post('products/:id/retire')
  @Audited(AuditAction.ProductRetired)
  @RequirePermission('catalogue.write')
  @HttpCode(200)
  async retire(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: RetireProductDto,
  ) {
    return this.catalogue.retire(ctx, id, dto.reason);
  }

  @Post('products/:id/reinstate')
  @Audited(AuditAction.ProductUpdated)
  @RequirePermission('catalogue.write')
  @HttpCode(200)
  async reinstate(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.catalogue.reinstate(ctx, id);
  }

  // ------------------------------------------------------------ categories

  @Get('product-categories')
  @RequirePermission('stock.read')
  async categories(@Ctx() ctx: TenantContext) {
    void ctx;
    return {
      items: await this.db.tx().productCategory.findMany({
        orderBy: [{ parentId: 'asc' }, { sort: 'asc' }, { name: 'asc' }],
      }),
    };
  }

  @Post('product-categories')
  @Audited(AuditAction.CatalogueChanged)
  @RequirePermission('catalogue.write')
  @HttpCode(201)
  async createCategory(@Ctx() ctx: TenantContext, @Body() dto: CategoryDto) {
    const tx = this.db.tx();
    // Two levels, as the specification says. A category tree nobody can
    // see the bottom of is a category tree nobody files anything in.
    if (dto.parentId) {
      const parent = await tx.productCategory.findFirst({
        where: { id: dto.parentId },
        select: { parentId: true },
      });
      if (!parent) throw new NotFoundError('Category');
      if (parent.parentId) {
        throw new BadRequestError(
          'Categories go two levels deep, no further.',
          'category_too_deep',
        );
      }
    }
    await tx.productCategory.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        parentId: dto.parentId ?? null,
        name: dto.name,
        sort: dto.sort ?? 0,
      },
    });
    return this.categories(ctx);
  }

  // -------------------------------------------------- per-branch settings

  @Put('products/:id/branches/:branchId')
  @Audited(AuditAction.CatalogueChanged)
  @RequirePermission('catalogue.write')
  async setBranchStock(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('branchId') branchId: string,
    @Body() dto: BranchStockSettingDto,
  ) {
    const tx = this.db.tx();
    await this.catalogue.getOrThrow(tx, id);
    // Stored now; what reads them arrives with the stock half of
    // inventory in Phase 3.
    await tx.productBranchSetting.upsert({
      where: {
        tenantId_productId_branchId: { tenantId: ctx.tenantId, productId: id, branchId },
      },
      create: {
        tenantId: requireTenantId(),
        productId: id,
        branchId,
        minStock: dto.minStock ?? null,
        reorderLevel: dto.reorderLevel ?? null,
        reorderQty: dto.reorderQty ?? null,
      },
      update: {
        minStock: dto.minStock ?? null,
        reorderLevel: dto.reorderLevel ?? null,
        reorderQty: dto.reorderQty ?? null,
      },
    });
    return {
      items: await tx.productBranchSetting.findMany({ where: { productId: id } }),
    };
  }

  // ---------------------------------------------------------------- import

  /** INV-F-04. Nothing is written unless the run says so in so many words. */
  @Post('products/import')
  @Audited(AuditAction.ProductImported)
  @RequirePermission('catalogue.write')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: 20_000_000 } }))
  async importCsv(
    @Ctx() ctx: TenantContext,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Query('dryRun') dryRun?: string,
    @Query('updateExisting') updateExisting?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestError('No file was uploaded.', 'file_missing');
    }
    return this.imports.run(ctx, file.originalname ?? 'catalogue.csv', file.buffer.toString('utf8'), {
      dryRun: dryRun !== 'false',
      updateExisting: updateExisting === 'true',
    });
  }
}
