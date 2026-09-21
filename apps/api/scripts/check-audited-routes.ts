/**
 * AUD-R-03 / AUD-T-06, enforced in CI.
 *
 * Every mutating route (`@Post`, `@Put`, `@Patch`, `@Delete`) must carry
 * either `@Audited('entity.action')` or an explicit `@NotAudited('why')`.
 *
 * This is the same shape as `check-route-permissions.ts` and for the same
 * reason. An authorisation hole is a route somebody forgot to protect; an
 * audit hole is a route somebody forgot to record, and it is discovered
 * in exactly the situation where the record was the point — an
 * investigation, a complaint, a PDPA request. "We do not log that" is not
 * an answer anybody wants to give, and nobody notices the gap until then.
 *
 * The declaration does not do the recording. Services write their own
 * entries inside the transaction of the change, which is richer and is
 * what AUD-R-02 requires; `@Audited` names the action for the backstop in
 * `AuditInterceptor` and puts the route on this list.
 *
 * Run: npm run lint:audited           Exit code 1 lists every offender.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { AUDIT_ACTION_SET } from '../src/modules/audit/audit.actions.js';

const ROOT = new URL('..', import.meta.url).pathname;
const MUTATING = new Set(['Post', 'Put', 'Patch', 'Delete']);

export type AuditFinding = {
  file: string;
  line: number;
  method: string;
  handler: string;
  problem: 'missing_declaration' | 'unknown_action' | 'empty_reason';
  detail: string;
};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated' || entry === 'dist')
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) yield full;
  }
}

function decoratorName(decorator: ts.Decorator): string | null {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression))
    return expr.expression.text;
  if (ts.isIdentifier(expr)) return expr.text;
  return null;
}

function firstStringArgument(decorator: ts.Decorator): string | null {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr)) return null;
  const [arg] = expr.arguments;
  if (arg && ts.isStringLiteralLike(arg)) return arg.text;
  // `@Audited(AuditAction.PatientRegistered)` — resolve the member name
  // against the catalogue rather than the literal.
  if (arg && ts.isPropertyAccessExpression(arg)) return `#${arg.name.text}`;
  return null;
}

export function checkSource(
  filePath: string,
  source: string,
  knownActions: ReadonlySet<string>,
  knownKeys: ReadonlySet<string>,
): AuditFinding[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
  const findings: AuditFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const decorators = ts.getDecorators(node) ?? [];
      const names = decorators
        .map(decoratorName)
        .filter((n): n is string => n !== null);
      const httpMethod = names.find((n) => MUTATING.has(n));

      if (httpMethod) {
        const handler = node.name.getText(sourceFile);
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        const audited = decorators.find((d) => decoratorName(d) === 'Audited');
        const exempt = decorators.find(
          (d) => decoratorName(d) === 'NotAudited',
        );

        if (!audited && !exempt) {
          findings.push({
            file: filePath,
            line: line + 1,
            method: httpMethod.toUpperCase(),
            handler,
            problem: 'missing_declaration',
            detail:
              "add @Audited('entity.action'), or @NotAudited('why nothing is worth recording')",
          });
        } else if (audited) {
          const action = firstStringArgument(audited);
          const known = action?.startsWith('#')
            ? knownKeys.has(action.slice(1))
            : action === null || knownActions.has(action);
          if (!known) {
            findings.push({
              file: filePath,
              line: line + 1,
              method: httpMethod.toUpperCase(),
              handler,
              problem: 'unknown_action',
              detail: `'${action}' is not in the audit action catalogue (audit.actions.ts)`,
            });
          }
        } else if (exempt) {
          const reason = firstStringArgument(exempt);
          if (!reason || reason.trim().length < 10) {
            findings.push({
              file: filePath,
              line: line + 1,
              method: httpMethod.toUpperCase(),
              handler,
              problem: 'empty_reason',
              detail: '@NotAudited needs a reason somebody can disagree with',
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

export function checkProject(srcDir = join(ROOT, 'src')): AuditFinding[] {
  const actions = AUDIT_ACTION_SET;
  // The catalogue is `{ PatientRegistered: 'patient.registered' }`; a
  // decorator may name either side, so both are accepted.
  const keys = new Set<string>();
  for (const match of readFileSync(
    join(ROOT, 'src/modules/audit/audit.actions.ts'),
    'utf8',
  ).matchAll(/^\s{2}(\w+):\s*'[a-z0-9_.]+'/gm)) {
    keys.add(match[1]!);
  }

  const findings: AuditFinding[] = [];
  for (const file of walk(srcDir)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('@Controller')) continue;
    findings.push(...checkSource(file, source, actions, keys));
  }
  return findings;
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  const findings = checkProject();
  if (findings.length > 0) {
    console.error(
      '\nMutating routes with nothing said about the audit trail:\n',
    );
    for (const f of findings) {
      console.error(
        `  ${relative(ROOT, f.file)}:${f.line}  ${f.method} ${f.handler}()  — ${f.detail}`,
      );
    }
    console.error(`\n${findings.length} problem(s). See AUD-R-03.\n`);
    process.exit(1);
  }
  console.log('Audited-route check passed.');
}
