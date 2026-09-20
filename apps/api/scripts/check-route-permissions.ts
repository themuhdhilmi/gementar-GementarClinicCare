/**
 * IAM-F-22 / IAM-R-03, enforced in CI.
 *
 * Every mutating route (`@Post`, `@Put`, `@Patch`, `@Delete`) must carry either
 * `@RequirePermission('x.y')` or an explicit `@NoPermission('reason')`. A route
 * that simply forgot to say is a hole, and holes in authorisation are exactly
 * the class of bug nobody notices until it matters.
 *
 * Run: npm run lint:routes            Exit code 1 lists every offender.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { PERMISSION_SET } from '../src/shared/access/permissions.js';

const ROOT = new URL('..', import.meta.url).pathname;
const MUTATING = new Set(['Post', 'Put', 'Patch', 'Delete']);

export type RouteFinding = {
  file: string;
  line: number;
  method: string;
  handler: string;
  problem: 'missing_declaration' | 'unknown_permission';
  detail: string;
};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) yield full;
  }
}

function decoratorName(decorator: ts.Decorator): string | null {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  if (ts.isIdentifier(expr)) return expr.text;
  return null;
}

function firstStringArgument(decorator: ts.Decorator): string | null {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr)) return null;
  const [arg] = expr.arguments;
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

export function checkSource(filePath: string, source: string): RouteFinding[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true);
  const findings: RouteFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const decorators = ts.getDecorators(node) ?? [];
      const names = decorators.map(decoratorName).filter((n): n is string => n !== null);
      const httpMethod = names.find((n) => MUTATING.has(n));

      if (httpMethod) {
        const handler = node.name.getText(sourceFile);
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const permissionDecorator = decorators.find(
          (d) => decoratorName(d) === 'RequirePermission',
        );
        const hasExemption = names.includes('NoPermission');

        if (!permissionDecorator && !hasExemption) {
          findings.push({
            file: filePath,
            line: line + 1,
            method: httpMethod.toUpperCase(),
            handler,
            problem: 'missing_declaration',
            detail:
              'add @RequirePermission(\'…\'), or @NoPermission(\'why it needs none\') if that is genuinely right',
          });
        } else if (permissionDecorator) {
          const permission = firstStringArgument(permissionDecorator);
          if (permission && !PERMISSION_SET.has(permission)) {
            findings.push({
              file: filePath,
              line: line + 1,
              method: httpMethod.toUpperCase(),
              handler,
              problem: 'unknown_permission',
              detail: `'${permission}' is not in the permission catalogue`,
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

export function checkProject(srcDir = join(ROOT, 'src')): RouteFinding[] {
  const findings: RouteFinding[] = [];
  for (const file of walk(srcDir)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('@Controller')) continue;
    findings.push(...checkSource(file, source));
  }
  return findings;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  const findings = checkProject();
  if (findings.length > 0) {
    console.error('\nRoutes missing an authorisation declaration:\n');
    for (const f of findings) {
      console.error(
        `  ${relative(ROOT, f.file)}:${f.line}  ${f.method} ${f.handler}()  — ${f.detail}`,
      );
    }
    console.error(`\n${findings.length} problem(s). See IAM-F-22.\n`);
    process.exit(1);
  }
  console.log('Route permission check passed.');
}
