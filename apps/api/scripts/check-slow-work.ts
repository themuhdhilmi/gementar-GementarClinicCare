/**
 * TEN-F-17: slow work must not run inside a tenant transaction.
 *
 * A transaction holds a database connection and often row locks. Waiting on an
 * HTTP endpoint, rendering a PDF or writing to object storage inside one turns
 * a fast request into a slow one that is also in everybody else's way, and
 * pushes it towards the TEN-N-05 timeout.
 *
 * This reads the source rather than the type graph, so it catches the shape
 * people actually write: a slow client called inside a `withTenant(...)` block.
 * It cannot see through a service call, so it is a net, not a proof — the
 * matching runtime check in `assertOutsideScope` is what makes it certain.
 *
 * Work moved out with `afterCommit(...)` is exactly the intended fix, so
 * anything inside one of those is ignored.
 */
import { globSync, readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';

const SCOPES = ['withTenant', 'withTenantIndependently', 'withPlatform', 'withAuthLookup'];

/** Clients whose work goes over a network or onto a disk. */
const SLOW: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\bfetch\s*\(/, what: 'an outbound HTTP call' },
  { pattern: /\bmailer\.\w+\s*\(/, what: 'sending mail' },
  { pattern: /\bs3\.\w+\s*\(/i, what: 'object storage' },
  { pattern: /\b(renderPdf|toPdf|createPdf)\s*\(/, what: 'rendering a PDF' },
  { pattern: /\bQRCode\.\w+\s*\(/, what: 'rendering a QR code' },
  { pattern: /\bexecFile\s*\(|\bspawn\s*\(/, what: 'running a child process' },
  { pattern: /\bsetTimeout\s*\(/, what: 'sleeping' },
];

/** Files that define the rule, or deliberately sit on the other side of it. */
const EXEMPT = [
  'src/shared/prisma/db.service.ts',
  'src/shared/prisma/tenant-scope.ts',
  'src/modules/identity/services/mailer.service.ts',
];

/** From an opening parenthesis, the index just past its match. */
function endOfCall(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

function spansOf(source: string, names: string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const name of names) {
    const finder = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let match: RegExpExecArray | null;
    while ((match = finder.exec(source)) !== null) {
      const open = match.index + match[0].length - 1;
      spans.push([open, endOfCall(source, open)]);
    }
  }
  return spans;
}

function main(): void {
  const logger = new Logger('SlowWork');
  const files = globSync('src/**/*.ts').filter(
    (file) => !file.endsWith('.spec.ts') && !EXEMPT.includes(file),
  );
  const problems: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!SCOPES.some((name) => source.includes(`${name}(`))) continue;

    const scopes = spansOf(source, SCOPES);
    const escapes = spansOf(source, ['afterCommit']);

    for (const { pattern, what } of SLOW) {
      const finder = new RegExp(pattern.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = finder.exec(source)) !== null) {
        const at = match.index;
        const inScope = scopes.some(([from, to]) => at > from && at < to);
        const movedOut = escapes.some(([from, to]) => at > from && at < to);
        if (!inScope || movedOut) continue;
        const line = source.slice(0, at).split('\n').length;
        problems.push(
          `${file}:${line}  ${what} inside a database transaction. Move it out with ` +
            'DbService.afterCommit(), or gather the data and do it after the scope closes.',
        );
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) logger.error(problem);
    logger.error(`TEN-F-17: ${problems.length} place(s) do slow work inside a transaction.`);
    process.exit(1);
  }
  logger.log('Slow-work check passed.');
}

main();
