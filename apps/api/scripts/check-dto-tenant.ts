/**
 * IAM-R-01 / TEN-R-01, enforced in CI.
 *
 * The tenant is resolved from the session. If a request object can carry a
 * tenant id, sooner or later something will trust it, and that is the bug that
 * becomes a cross-clinic data leak. So: no `tenantId` in any DTO, ever.
 *
 * Run: npm run lint:dto
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PATTERN = /\b(tenantId|tenant_id)\b/;

export type DtoFinding = { file: string; line: number; text: string };

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts')) yield full;
  }
}

function isDtoFile(path: string): boolean {
  return path.includes('/dto/') || path.endsWith('.dto.ts');
}

export function checkProject(srcDir = join(ROOT, 'src')): DtoFinding[] {
  const findings: DtoFinding[] = [];
  for (const file of walk(srcDir)) {
    if (!isDtoFile(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      const withoutComment = text.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (PATTERN.test(withoutComment)) {
        findings.push({ file, line: index + 1, text: text.trim() });
      }
    });
  }
  return findings;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  const findings = checkProject();
  if (findings.length > 0) {
    console.error('\nA tenant id must never be accepted from a request (IAM-R-01):\n');
    for (const f of findings) {
      console.error(`  ${relative(ROOT, f.file)}:${f.line}  ${f.text}`);
    }
    console.error('');
    process.exit(1);
  }
  console.log('DTO tenant-id check passed.');
}
