import { Injectable } from '@nestjs/common';
import { BranchStatus } from '../../generated/prisma/enums.js';
import { NotFoundError } from '../../shared/errors/domain-errors.js';
import type { Tx } from '../../shared/prisma/db.service.js';

export type BranchSummary = {
  id: string;
  code: string;
  name: string;
  status: BranchStatus;
};

@Injectable()
export class BranchService {
  async listByIds(tx: Tx, ids: readonly string[]): Promise<BranchSummary[]> {
    if (ids.length === 0) return [];
    const branches = await tx.branch.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, code: true, name: true, status: true },
      orderBy: { name: 'asc' },
    });
    return branches;
  }

  async getOrThrow(tx: Tx, branchId: string): Promise<BranchSummary> {
    const branch = await tx.branch.findFirst({
      where: { id: branchId },
      select: { id: true, code: true, name: true, status: true },
    });
    if (!branch) throw new NotFoundError('Branch');
    return branch;
  }

  /** TEN-R-05 in application form: the branch must belong to the current tenant. */
  async assertBelongsToTenant(tx: Tx, branchId: string): Promise<void> {
    const count = await tx.branch.count({ where: { id: branchId } });
    if (count === 0) throw new NotFoundError('Branch');
  }
}
