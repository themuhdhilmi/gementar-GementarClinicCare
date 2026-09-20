import { describe, expect, it } from 'vitest';
import { checkSource, checkProject } from '../scripts/check-route-permissions.js';
import { checkProject as checkDtos } from '../scripts/check-dto-tenant.js';

const CONTROLLER = (body: string) => `
import { Controller, Post, Get } from '@nestjs/common';
import { RequirePermission, NoPermission } from '../decorators/auth.decorators.js';

@Controller('things')
export class ThingsController {
${body}
}
`;

describe('IAM-T-08: CI refuses a mutating route with no permission declaration', () => {
  it('IAM-T-08: flags a POST with no decoration', () => {
    const findings = checkSource(
      'things.controller.ts',
      CONTROLLER(`
  @Post()
  create() {
    return { created: true };
  }
`),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.problem).toBe('missing_declaration');
    expect(findings[0]!.method).toBe('POST');
    expect(findings[0]!.handler).toBe('create');
  });

  it('accepts a declared permission and an explicit exemption', () => {
    const findings = checkSource(
      'things.controller.ts',
      CONTROLLER(`
  @Post()
  @RequirePermission('admin.users')
  create() {
    return { created: true };
  }

  @Post('public-thing')
  @NoPermission('Public entry point.')
  publicThing() {
    return { ok: true };
  }
`),
    );
    expect(findings).toEqual([]);
  });

  it('flags a permission that is not in the catalogue', () => {
    const findings = checkSource(
      'things.controller.ts',
      CONTROLLER(`
  @Post()
  @RequirePermission('admin.everything')
  create() {
    return { created: true };
  }
`),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.problem).toBe('unknown_permission');
  });

  it('leaves read-only routes alone', () => {
    const findings = checkSource(
      'things.controller.ts',
      CONTROLLER(`
  @Get()
  list() {
    return [];
  }
`),
    );
    expect(findings).toEqual([]);
  });

  it('the real codebase passes both checks', () => {
    expect(checkProject()).toEqual([]);
    expect(checkDtos()).toEqual([]);
  });
});
