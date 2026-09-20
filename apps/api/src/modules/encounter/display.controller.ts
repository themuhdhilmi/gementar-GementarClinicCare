import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Sse,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { newId } from '../../shared/ids/uuid.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { Clock } from '../../shared/time/clock.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import {
  Ctx,
  NoRequestTransaction,
  Public,
  RequirePermission,
} from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { DisplayService } from './display.service.js';
import { QueueStreamService } from './queue-stream.service.js';
import { DisplayTokenDto, RoomDto } from './dto/encounter.dto.js';

/**
 * The waiting-room screen, and the rooms a clinic sees patients in.
 *
 * The display half of this is the only public surface in the product. It is
 * kept deliberately small: a token in, queue numbers out, and nothing that
 * identifies anybody (ENC-R-10).
 */
@Controller()
export class DisplayController {
  constructor(
    private readonly display: DisplayService,
    private readonly queueStream: QueueStreamService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly db: DbService,
  ) {}

  // ------------------------------------------------------- display tokens

  @Get('branches/:branchId/display-tokens')
  @RequirePermission('admin.settings')
  async listTokens(@Ctx() ctx: TenantContext, @Param('branchId') branchId: string) {
    void ctx;
    return { items: await this.display.list(this.db.tx(), branchId) };
  }

  @Post('branches/:branchId/display-tokens')
  @RequirePermission('admin.settings')
  @HttpCode(201)
  async issueToken(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: DisplayTokenDto,
  ) {
    const issued = await this.display.issue(ctx, branchId, dto.label);
    return {
      ...issued,
      // Shown once. Only the hash is kept, so there is no second chance.
      url: `/display/${issued.token}`,
      warning:
        'Copy this address now. It is not recoverable, and anyone who has it can watch ' +
        'this branch’s queue. Revoke and reissue if a screen is replaced.',
    };
  }

  @Delete('display-tokens/:id')
  @RequirePermission('admin.settings')
  async revokeToken(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.display.revoke(ctx, id);
  }

  // ---------------------------------------------------------- the display

  /**
   * What the television shows. No session, by design.
   *
   * The token names a branch; everything after that happens inside that
   * clinic's own tenant scope, so the ordinary isolation applies to every
   * row this reads.
   */
  @Get('display/:token')
  @Public()
  async view(@Param('token') token: string) {
    const resolved = await this.display.resolve(token);
    const view = await this.db.withTenant(resolved.tenantId, () =>
      this.display.view(resolved.branchId),
    );
    void this.display.touch(resolved.id, resolved.tenantId).catch(() => undefined);
    return view;
  }

  /**
   * The screen's live feed.
   *
   * No transaction, for the same reason as the staff stream: this is open
   * for as long as the television is on, which is all day.
   */
  @Sse('display/:token/stream')
  @Public()
  @NoRequestTransaction('A waiting-room screen holds this open all day.')
  async stream(
    @Param('token') token: string,
  ): Promise<Observable<{ data: { kind: string; queueNo: string; at: string } }>> {
    const resolved = await this.display.resolve(token);
    // Re-shaped on the way out: the screen needs to know that something
    // changed and which number was called, and nothing else reaches it.
    return this.queueStream.forBranch(resolved.branchId).pipe(
      map((event) => ({
        data:
          'heartbeat' in event.data
            ? { kind: 'heartbeat', queueNo: '', at: event.data.heartbeat }
            : { kind: event.data.kind, queueNo: event.data.queueNo, at: event.data.at },
      })),
    );
  }

  // --------------------------------------------------------------- rooms

  @Get('branches/:branchId/rooms')
  @RequirePermission('patient.read')
  async listRooms(@Ctx() ctx: TenantContext, @Param('branchId') branchId: string) {
    void ctx;
    return {
      items: await this.db.tx().branchRoom.findMany({
        where: { branchId },
        orderBy: [{ active: 'desc' }, { code: 'asc' }],
      }),
    };
  }

  @Post('branches/:branchId/rooms')
  @RequirePermission('admin.settings')
  @HttpCode(201)
  async createRoom(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: RoomDto,
  ) {
    const tx = this.db.tx();
    const id = newId();
    await tx.branchRoom.create({
      data: {
        id,
        tenantId: requireTenantId(),
        branchId,
        name: dto.name,
        code: dto.code,
        type: dto.type ?? 'CONSULT',
        active: dto.active ?? true,
      },
    });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BranchRoomChanged,
      entityType: 'branch_room',
      entityId: id,
      after: { name: dto.name, code: dto.code },
    });
    return this.listRooms(ctx, branchId);
  }

  @Post('rooms/:id/retire')
  @RequirePermission('admin.settings')
  @HttpCode(200)
  async retireRoom(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    const tx = this.db.tx();
    // Retired rather than deleted: encounters already point at it, and the
    // chart for a visit last week should still say which room it was in.
    await tx.branchRoom.update({ where: { id }, data: { active: false } });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BranchRoomChanged,
      entityType: 'branch_room',
      entityId: id,
      after: { active: false },
    });
    void this.clock;
    return { retired: true };
  }

  @Post('rooms/:id/reinstate')
  @RequirePermission('admin.settings')
  @HttpCode(200)
  async reinstateRoom(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    const tx = this.db.tx();
    await tx.branchRoom.update({ where: { id }, data: { active: true } });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BranchRoomChanged,
      entityType: 'branch_room',
      entityId: id,
      after: { active: true },
    });
    return { reinstated: true };
  }
}
