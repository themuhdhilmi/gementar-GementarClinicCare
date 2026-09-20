import { Injectable } from '@nestjs/common';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { NotFoundError } from '../../shared/errors/domain-errors.js';
import { TenantStatus } from '../../generated/prisma/enums.js';

@Injectable()
export class TenantService {
  constructor(private readonly db: DbService) {}

  /** Login-time lookup: runs before any tenant is known, so platform scope. */
  async findActiveBySlug(slug: string) {
    return this.db.withPlatform('resolve tenant by slug at login', (tx) =>
      tx.tenant.findFirst({
        where: { slug: slug.trim().toLowerCase(), status: TenantStatus.ACTIVE },
        select: { id: true, name: true, slug: true, timezone: true },
      }),
    );
  }

  async getCurrent(tx: Tx, tenantId: string) {
    const tenant = await tx.tenant.findFirst({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant');
    return tenant;
  }

  /**
   * Serialises the tenant-wide invariants (IAM-R-05) by taking a row lock on the
   * tenant for the rest of the transaction. Two administrators disabling each
   * other at the same instant then queue instead of racing.
   */
  async lockForUpdate(tx: Tx, tenantId: string): Promise<void> {
    await tx.$queryRawUnsafe('SELECT id FROM tenant WHERE id = $1::uuid FOR UPDATE', tenantId);
  }
}
