import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { DOSE_UNITS, PrescriptionService, ROUTES } from './prescription.service.js';
import { FREQUENCY_CODES } from './frequency.js';
import {
  AmendItemDto,
  CheckDto,
  DeclineDto,
  OverrideDto,
  PrescriptionItemDto,
  PrescriptionNotesDto,
  ReasonDto,
} from './dto/prescription.dto.js';

@Controller()
export class PrescriptionController {
  constructor(private readonly rx: PrescriptionService) {}

  /**
   * The closed lists the panel builds its selects from, so the client
   * never carries its own copy of what a valid frequency is.
   */
  @Get('prescriptions/options')
  @RequirePermission('clinical.read')
  options(@Ctx() ctx: TenantContext) {
    void ctx;
    return {
      doseUnits: DOSE_UNITS,
      routes: ROUTES,
      frequencies: Object.entries(FREQUENCY_CODES).map(([code, meta]) => ({
        code,
        perDay: meta.perDay,
        ms: meta.ms,
        en: meta.en,
      })),
    };
  }

  @Get('consultations/:id/prescription')
  @RequirePermission('clinical.read')
  read(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.rx.read(ctx, id);
  }

  @Post('consultations/:id/prescription/items')
  @RequirePermission('rx.write')
  addItem(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: PrescriptionItemDto) {
    return this.rx.addItem(ctx, id, body);
  }

  @Put('consultations/:id/prescription/notes')
  @RequirePermission('rx.write')
  setNotes(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: PrescriptionNotesDto,
  ) {
    return this.rx.setNotes(ctx, id, body);
  }

  @Post('consultations/:id/prescription/repeat-last')
  @RequirePermission('rx.write')
  repeatLast(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.rx.repeatLast(ctx, id);
  }

  /** A dry run, so a template can be shown with its warnings before it is applied. */
  @Post('consultations/:id/prescription/check')
  @HttpCode(200)
  @RequirePermission('rx.write')
  check(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: CheckDto) {
    return this.rx.check(ctx, id, body.items);
  }

  @Put('prescription-items/:id')
  @RequirePermission('rx.write')
  updateItem(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: PrescriptionItemDto) {
    return this.rx.updateItem(ctx, id, body);
  }

  @Delete('prescription-items/:id')
  @RequirePermission('rx.write')
  removeItem(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.rx.removeItem(ctx, id);
  }

  @Post('prescription-items/:id/override')
  @HttpCode(200)
  @RequirePermission('rx.override_warning')
  override(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: OverrideDto) {
    return this.rx.override(ctx, id, body);
  }

  @Post('prescription-items/:id/amend')
  @RequirePermission('clinical.amend')
  amend(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: AmendItemDto) {
    return this.rx.amendItem(ctx, id, body.item, body.reason);
  }

  @Post('prescription-items/:id/cancel')
  @HttpCode(200)
  @RequirePermission('clinical.amend')
  cancel(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: ReasonDto) {
    return this.rx.cancelItem(ctx, id, body.reason);
  }

  /** The patient said no at the counter. */
  @Post('prescription-items/:id/decline')
  @HttpCode(200)
  @RequirePermission('dispense.perform')
  decline(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: DeclineDto) {
    return this.rx.declineItem(ctx, id, body.reason ?? '');
  }

  /** RX-R-10: what the pharmacy needs, and no more. */
  @Get('prescriptions/:id/dispense-view')
  @RequirePermission('dispense.perform')
  dispenseView(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.rx.dispenseView(ctx, id);
  }

  @Get('me/rx-favourites')
  @RequirePermission('rx.write')
  favourites(@Ctx() ctx: TenantContext) {
    return this.rx.favourites(ctx);
  }

  @Delete('me/rx-favourites/:productId')
  @RequirePermission('rx.write')
  removeFavourite(@Ctx() ctx: TenantContext, @Param('productId') productId: string) {
    return this.rx.removeFavourite(ctx, productId);
  }
}
