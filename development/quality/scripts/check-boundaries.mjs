import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const layers = new Map([
  ['core', new Set(['core'])],
  ['application', new Set(['core', 'application'])],
  ['adapters', new Set(['core', 'application', 'adapters'])],
  ['hosts', new Set(['core', 'application', 'hosts'])],
  ['main', new Set(['core', 'application', 'adapters', 'hosts', 'main'])],
]);

const layerOf = (root, file) => relative(root, file).split(/[\\/]/)[0];

/** Inspect actual JavaScript dependencies, including type-only JSDoc imports. */
export function boundaryViolations(sourceRoot) {
  const root = realpathSync(sourceRoot);
  const violations = [];
  const files = readdirSync(root, { recursive: true, withFileTypes: true });
  for (const entry of files) {
    const file = resolve(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) {
      violations.push(relative(root, file) + ': symbolic link in source tree');
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const layer = layerOf(root, file);
    const allowed = layers.get(layer);
    if (!allowed) {
      violations.push(relative(root, file) + ': unknown source layer');
      continue;
    }

    const text = readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const references = new Set(ts.preProcessFile(text, true, true).importedFiles.map(item => item.fileName));
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const target = node.arguments[0];
        if (target && ts.isStringLiteralLike(target)) references.add(target.text);
        else if (layer === 'core') violations.push(relative(root, file) + ' -> computed import');
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);

    for (const reference of references) {
      let forbidden = false;
      if (reference.startsWith('./') || reference.startsWith('../')) {
        const target = resolve(dirname(file), reference);
        let canonical = target;
        try { canonical = realpathSync(target); } catch { /* The checker diagnoses missing modules. */ }
        forbidden = !allowed.has(layerOf(root, target)) || !allowed.has(layerOf(root, canonical));
      } else {
        forbidden = layer === 'core' || isAbsolute(reference) || reference.startsWith('file:') ||
          reference === 'role-orchestrator' || reference.startsWith('#');
      }
      if (forbidden) violations.push(relative(root, file) + ' -> ' + reference);
    }
  }
  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '../../..');
  const violations = boundaryViolations(resolve(root, 'src'));
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('PASS source import boundaries');
  }
}
