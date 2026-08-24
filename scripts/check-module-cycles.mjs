import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const sourceRoot = path.resolve("src");
const files = sourceFiles(sourceRoot);
const sourceSet = new Set(files);
const graph = new Map();
const directionViolations = [];

for (const file of files) {
  const owner = moduleOwner(file);
  const dependencies = graph.get(owner) ?? new Set();
  graph.set(owner, dependencies);
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
      statement.moduleSpecifier === undefined || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const target = resolveSourceImport(file, statement.moduleSpecifier.text);
    if (target === undefined) continue;
    const dependency = moduleOwner(target);
    if (dependency !== owner) {
      dependencies.add(dependency);
      if (!dependencyAllowed(owner, dependency)) {
        directionViolations.push(`${relative(file)} -> ${relative(target)}`);
      }
    }
  }
}

const cycles = stronglyConnectedComponents(graph).filter((component) => component.length > 1);
if (cycles.length > 0) {
  console.error("Cross-module dependency cycles detected:");
  for (const cycle of cycles) console.error(`- ${cycle.sort().join(" -> ")}`);
  process.exitCode = 1;
}
if (directionViolations.length > 0) {
  console.error("Invalid source dependency directions detected:");
  for (const violation of directionViolations) console.error(`- ${violation}`);
  process.exitCode = 1;
}

function sourceFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(filePath));
    else if (/\.(?:ts|tsx|cts)$/u.test(entry.name)) result.push(path.resolve(filePath));
  }
  return result;
}

function resolveSourceImport(importer, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = base.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base.slice(0, -3) + ".cts"]
    : [base + ".ts", base + ".tsx", base + ".cts", path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return candidates.find((candidate) => sourceSet.has(candidate));
}

function moduleOwner(file) {
  const parts = path.relative(sourceRoot, file).replaceAll("\\", "/").split("/");
  return ["app", "adapters", "domain", "kernel", "platform"].includes(parts[0]) && parts.length > 2
    ? `${parts[0]}/${parts[1]}`
    : parts[0];
}

function dependencyAllowed(owner, dependency) {
  if (owner.startsWith("domain/") || owner.startsWith("kernel/") || owner.startsWith("platform/")) {
    return !dependency.startsWith("app/") && !dependency.startsWith("adapters/");
  }
  if (owner === "app/model-runtime" || owner === "app/capability") {
    return !dependency.startsWith("adapters/");
  }
  return true;
}

function relative(file) {
  return path.relative(process.cwd(), file).replaceAll("\\", "/");
}

function stronglyConnectedComponents(input) {
  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const active = new Set();
  const components = [];

  const visit = (node) => {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    active.add(node);
    for (const dependency of input.get(node) ?? []) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)));
      } else if (active.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(dependency)));
      }
    }
    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      active.delete(current);
      component.push(current);
    } while (current !== node);
    components.push(component);
  };

  for (const node of input.keys()) if (!indexes.has(node)) visit(node);
  return components;
}
