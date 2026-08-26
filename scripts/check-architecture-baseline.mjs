import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const files = sourceFiles(sourceRoot);
const sourceSet = new Set(files.map((file) => path.resolve(file)));
const parsedSources = new Map(files.map((file) => {
  const sourceText = fs.readFileSync(file, "utf8");
  return [file, {
    sourceText,
    source: ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true),
  }];
}));
const moduleGraph = new Map(files.map((file) => [file, moduleReferences(file, parsedSources.get(file).source)]));
const runtimeModuleGraph = new Map(files.map((file) => [
  file,
  moduleReferences(file, parsedSources.get(file).source).filter(({ node }) => isRuntimeModuleReference(node)),
]));
const allowlist = JSON.parse(fs.readFileSync(path.join(root, "scripts", "architecture-baseline-allowlist.json"), "utf8"));
const matchedAllowlistEntries = new Set();
const violations = [];
const nodeBuiltinModules = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));
const uiReadModelFacade = path.resolve(sourceRoot, "app", "panel-api", "ui-read-model.ts");
const uiReadModelRuntimeFiles = sourceSet.has(uiReadModelFacade)
  ? reachableSourceFiles(uiReadModelFacade, runtimeModuleGraph)
  : new Set();
const ownedFeatures = new Set(["spaces", "workspaces", "personal-knowledge"]);
const presentationFields = new Set(["title", "label", "message", "detail", "summary"]);
const canonicalSpaceReferenceCommands = new Set([
  "addReference",
  "move",
  "rename",
  "unlinkReference",
  "removeReference",
  "refreshReferenceSourceIdentity",
  "updateReferenceAnnotation",
  "updateReferenceImageCaption",
]);
const mechanicalSpaceReferenceMutations = new Set([
  "createFile",
  "createDirectory",
  "deleteEntry",
  "renameEntry",
  "updateLocalDocumentText",
]);
const managedAssetReferenceMutations = new Set([
  "updateManagedAssetTextPreview",
  "updateManagedAssetCaptionPreview",
]);

for (const file of files) {
  const { sourceText, source } = parsedSources.get(file);
  const sourceFeature = appFeature(file);
  for (const reference of moduleGraph.get(file)) {
    const { node, specifier } = reference;
    const target = resolveSourceImport(file, specifier);
    const targetFeatures = target === undefined ? new Set() : reachableOwnedFeatures(target);
    for (const targetFeature of targetFeatures) {
      if (sourceFeature !== undefined && sourceFeature !== targetFeature &&
        ownedFeatures.has(sourceFeature) && ownedFeatures.has(targetFeature)) {
        report("feature-cross-import", file, node, `${sourceFeature} must not depend on ${targetFeature}, including through barrels`, sourceText, source);
      }
    }
    if (isRouteAdapter(file) && /(?:repository|sqlite)/iu.test(specifier)) {
      report("route-infrastructure-import", file, node, "Route adapters must not import Repository or SQLite modules", sourceText, source);
    }
    const names = importedNames(node);
    if (isRouteAdapter(file) && (names.some(isRouteInfrastructureSymbol) ||
      (names.includes("*") && target !== undefined && exportedNames(target).some(isRouteInfrastructureSymbol)))) {
      report("route-infrastructure-import", file, node, "Route adapters must not import Repository, SQLite or Feature factories through barrels", sourceText, source);
    }
    if (!normalized(file).includes("/src/app/panel-server/") &&
      (names.includes("PanelHttpError") || (names.includes("*") && /(?:^|\/)http-utils\.js$/u.test(specifier)))) {
      report("panel-http-error-outside-adapter", file, node, "PanelHttpError is restricted to panel-server adapters", sourceText, source);
    }
    if (isCanonicalSpaceReferenceAdapter(file) &&
      ((specifier.includes("local-filesystem") && names.some((name) => mechanicalSpaceReferenceMutations.has(name))) ||
       specifier.includes("space-reference-mutations") ||
       (specifier.includes("managed-asset-routes") && names.some((name) => managedAssetReferenceMutations.has(name))))) {
      report(
        "canonical-application-bypass",
        file,
        node,
        "Space Reference adapters must delegate filesystem mutations to the canonical Content Application",
        sourceText,
        source,
      );
    }
    if (uiReadModelRuntimeFiles.has(file) && isNodeBuiltinSpecifier(specifier)) {
      report(
        "ui-read-model-node-dependency",
        file,
        node,
        "The client-safe ui-read-model facade must not have runtime dependencies on Node built-ins",
        sourceText,
        source,
      );
    }
  }
  if (isCanonicalSpaceReferenceAdapter(file)) {
    // This exact-file guard is intentional. Content/Lifecycle Applications own
    // admission, lock ordering and lock-time revalidation; adapters may still
    // call unrelated single-owner commands such as createSpace directly.
    visit(source, (node) => {
      const command = referencedCommandName(node);
      if (command !== undefined && canonicalSpaceReferenceCommands.has(command)) {
        report(
          "canonical-application-bypass",
          file,
          node,
          `Space Reference adapter must use the canonical Application instead of commands.${command}`,
          sourceText,
          source,
        );
      }
      if (command === "updateText" || command === "updateCaption") {
        report(
          "canonical-application-bypass",
          file,
          node,
          `Managed Asset reference adapter must use the canonical Content Application instead of commands.${command}`,
          sourceText,
          source,
        );
      }
    });
  }
  if (isPresentationControlScope(file)) {
    const isPresentationAlias = createPresentationAliasResolver(source);
    visit(source, (node) => {
    if (ts.isBinaryExpression(node) && isEqualityOperator(node.operatorToken.kind) &&
      ((containsPresentationValue(node.left, isPresentationAlias) && containsStringLiteral(node.right)) ||
       (containsPresentationValue(node.right, isPresentationAlias) && containsStringLiteral(node.left)))) {
      report("presentation-string-control", file, node, "Presentation copy must not be a control-flow identity", sourceText, source);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (["includes", "startsWith", "endsWith", "match", "search"].includes(method) && containsPresentationValue(receiver, isPresentationAlias)) {
        report("presentation-string-control", file, node, "Presentation copy must not be parsed for control flow", sourceText, source);
      }
      if (method === "test" && node.arguments.some((argument) => containsPresentationValue(argument, isPresentationAlias))) {
        report("presentation-string-control", file, node, "Presentation copy must not be parsed by regular expression", sourceText, source);
      }
    }
    });
  }
  if (isRepositoryFile(file)) {
    visit(source, (node) => {
      if (ts.isAsExpression(node) && isJsonParseExpression(node.expression) &&
        node.type.kind !== ts.SyntaxKind.UnknownKeyword) {
        report(
          "persistence-runtime-schema",
          file,
          node,
          "Persisted JSON must be parsed as unknown and validated by the owner runtime schema",
          sourceText,
          source,
        );
      }
    });
  }
}

checkMigrationChecksumHistory();
checkStaleAllowlistEntries();

if (violations.length > 0) {
  console.error("Architecture baseline violations detected:");
  for (const violation of violations) console.error(`- [${violation.rule}] ${violation.file}:${violation.line} ${violation.message}`);
  process.exitCode = 1;
}

function report(rule, file, node, message, sourceText, sourceFile) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const text = sourceText.slice(node.getStart(sourceFile), node.getEnd()).split(/\r?\n/u, 1)[0].trim();
  const relativeFile = relative(file);
  let allowed = false;
  allowlist.forEach((entry, index) => {
    if (entry.rule === rule && entry.file === relativeFile &&
      typeof entry.contains === "string" && text.includes(entry.contains) &&
      typeof entry.reason === "string" && entry.reason.trim().length > 0) {
      allowed = true;
      matchedAllowlistEntries.add(index);
    }
  });
  if (!allowed) violations.push({ rule, file: relativeFile, line, message });
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : /\.(?:ts|tsx|cts)$/u.test(entry.name) ? [path.resolve(target)] : [];
  });
}

function resolveSourceImport(importer, specifier) {
  const base = specifier.startsWith("@ui/")
    ? path.resolve(sourceRoot, "app/panel-ui/src", specifier.slice("@ui/".length))
    : specifier.startsWith("@panel-api/")
      ? path.resolve(sourceRoot, "app/panel-api", specifier.slice("@panel-api/".length))
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(importer), specifier)
        : undefined;
  if (base === undefined) return undefined;
  const candidates = base.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base.slice(0, -3) + ".cts"]
    : [base + ".ts", base + ".tsx", base + ".cts", path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return candidates.find((candidate) => sourceSet.has(path.resolve(candidate)));
}

function moduleReferences(file, source) {
  const references = [];
  visit(source, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push({ node, specifier: node.moduleSpecifier.text });
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)) {
      references.push({ node, specifier: node.argument.literal.text });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      references.push({ node, specifier: node.arguments[0].text });
    }
  });
  return references;
}

function reachableOwnedFeatures(start) {
  const found = new Set();
  const queue = [start];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const feature = appFeature(current);
    if (feature !== undefined && ownedFeatures.has(feature)) {
      found.add(feature);
      continue;
    }
    for (const reference of moduleGraph.get(current) ?? []) {
      const target = resolveSourceImport(current, reference.specifier);
      if (target !== undefined) queue.push(target);
    }
  }
  return found;
}

function reachableSourceFiles(start, graph) {
  const reachable = new Set();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const reference of graph.get(current) ?? []) {
      const target = resolveSourceImport(current, reference.specifier);
      if (target !== undefined) queue.push(target);
    }
  }
  return reachable;
}

function appFeature(file) {
  const parts = path.relative(path.join(sourceRoot, "app"), file).replaceAll("\\", "/").split("/");
  return parts[0] === ".." || parts.length < 2 ? undefined : parts[0];
}

function isRouteAdapter(file) {
  const value = normalized(file);
  return value.includes("/src/app/panel-server/") &&
    (/(?:^|\/)[^/]+-routes?\.ts$/u.test(value) || value.endsWith("/request-handler.ts") || exportsRouteHandler(file));
}

function isCanonicalSpaceReferenceAdapter(file) {
  const value = normalized(file);
  return value.endsWith("/src/app/spaces/space-tools.ts") ||
    value.endsWith("/src/app/panel-server/spaces/space-routes.ts");
}

function isRepositoryFile(file) {
  return /(?:^|\/)[^/]*repository\.ts$/u.test(normalized(file));
}

function isNodeBuiltinSpecifier(specifier) {
  const candidate = specifier.replace(/^node:/u, "");
  return specifier.startsWith("node:") || nodeBuiltinModules.has(candidate) ||
    nodeBuiltinModules.has(candidate.split("/", 1)[0]);
}

function isRuntimeModuleReference(node) {
  if (ts.isImportTypeNode(node)) return false;
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause === undefined) return true;
    if (clause.isTypeOnly || clause.name !== undefined) return !clause.isTypeOnly;
    if (clause.namedBindings === undefined || ts.isNamespaceImport(clause.namedBindings)) return true;
    return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return false;
    return node.exportClause === undefined || !ts.isNamedExports(node.exportClause) ||
      node.exportClause.elements.some((element) => !element.isTypeOnly);
  }
  return true;
}

function referencedCommandName(node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
  const command = memberName(node);
  const receiver = node.expression;
  if (command === undefined || (!ts.isPropertyAccessExpression(receiver) && !ts.isElementAccessExpression(receiver))) return undefined;
  return memberName(receiver) === "commands" ? command : undefined;
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return node.argumentExpression !== undefined && ts.isStringLiteralLike(node.argumentExpression)
    ? node.argumentExpression.text
    : undefined;
}

function exportsRouteHandler(file) {
  const source = parsedSources.get(file)?.source;
  if (source === undefined) return false;
  return source.statements.some((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name !== undefined &&
    /^handle.+Route$/u.test(statement.name.text) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function isPresentationControlScope(file) {
  const value = normalized(file);
  return value.includes("/src/app/panel-api/read-model/") ||
    value.includes("/src/app/panel-ui/src/features/conversations/") ||
    (value.includes("/src/app/panel-ui/src/") && /(?:conversation|confirmation|activity)/iu.test(path.basename(value)));
}

function importedNames(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause === undefined) return [];
    return [
      ...(clause.name === undefined ? [] : [clause.name.text]),
      ...(clause.namedBindings === undefined ? []
        : ts.isNamespaceImport(clause.namedBindings) ? ["*"]
          : clause.namedBindings.elements.map((element) => element.propertyName?.text ?? element.name.text)),
    ];
  }
  if (ts.isExportDeclaration(node) && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
    return node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text);
  }
  return [];
}

function isRouteInfrastructureSymbol(name) {
  return /^(?:DatabaseSync|SqliteRuntimeDatabase)$/u.test(name) ||
    /^create.+(?:Repository|Feature)$/u.test(name) ||
    /Repository$/u.test(name);
}

function exportedNames(file) {
  const source = parsedSources.get(file)?.source;
  if (source === undefined) return [];
  const names = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      names.push(...statement.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text));
    }
    if (ts.isFunctionDeclaration(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) && statement.name !== undefined) {
      names.push(statement.name.text);
    }
    if (ts.isClassDeclaration(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) && statement.name !== undefined) {
      names.push(statement.name.text);
    }
  }
  return names;
}

function visit(node, visitor) {
  visitor(node);
  node.forEachChild((child) => visit(child, visitor));
}

function containsPresentationField(node) {
  let found = false;
  visit(node, (candidate) => {
    if (ts.isPropertyAccessExpression(candidate) && presentationFields.has(candidate.name.text)) found = true;
    if (ts.isElementAccessExpression(candidate) && candidate.argumentExpression !== undefined &&
      ts.isStringLiteralLike(candidate.argumentExpression) && presentationFields.has(candidate.argumentExpression.text)) found = true;
  });
  return found;
}

function containsPresentationValue(node, isPresentationAlias) {
  if (containsPresentationField(node)) return true;
  let found = false;
  visit(node, (candidate) => {
    if (ts.isIdentifier(candidate) && isPresentationAlias(candidate)) found = true;
  });
  return found;
}

function createPresentationAliasResolver(source) {
  const declarations = new Map();
  visit(source, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    const scope = lexicalScope(node);
    const add = (name, directPresentation) => {
      const byName = declarations.get(scope) ?? new Map();
      const entries = byName.get(name) ?? [];
      entries.push({ node, directPresentation });
      byName.set(name, entries);
      declarations.set(scope, byName);
    };
    if (ts.isIdentifier(node.name)) add(node.name.text, false);
    if (ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const property = element.propertyName?.getText(source) ?? element.name.text;
        add(element.name.text, presentationFields.has(property));
      }
    }
  });
  const resolving = new Set();
  const resolve = (identifier) => {
    const key = `${identifier.text}:${identifier.pos}`;
    if (resolving.has(key)) return false;
    resolving.add(key);
    try {
      const declaration = findVisibleDeclaration(identifier.text, identifier.pos, lexicalScope(identifier), declarations);
      if (declaration === undefined) return false;
      if (declaration.directPresentation) return true;
      const initializer = declaration.node.initializer;
      if (initializer === undefined) return false;
      if (isDirectPresentationExpression(initializer)) return true;
      let found = false;
      visit(initializer, (candidate) => {
        if (ts.isIdentifier(candidate) && candidate !== identifier && resolve(candidate)) found = true;
      });
      return found;
    } finally {
      resolving.delete(key);
    }
  };
  return resolve;
}

function isDirectPresentationExpression(node) {
  if (ts.isPropertyAccessExpression(node)) return presentationFields.has(node.name.text);
  if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.argumentExpression)) return presentationFields.has(node.argumentExpression.text);
  if (ts.isParenthesizedExpression(node)) return isDirectPresentationExpression(node.expression);
  if (ts.isNonNullExpression(node) || ts.isAsExpression(node)) return isDirectPresentationExpression(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return isDirectPresentationExpression(node.left) || isDirectPresentationExpression(node.right);
  }
  if (ts.isCallExpression(node)) {
    return node.arguments.some(isDirectPresentationExpression);
  }
  return false;
}

function findVisibleDeclaration(name, position, scope, declarations) {
  let current = scope;
  while (current !== undefined) {
    const entries = (declarations.get(current)?.get(name) ?? [])
      .filter((entry) => entry.node.pos < position)
      .sort((left, right) => right.node.pos - left.node.pos);
    if (entries.length > 0) return entries[0];
    current = parentLexicalScope(current);
  }
  return undefined;
}

function lexicalScope(node) {
  let current = node;
  while (current !== undefined && !ts.isSourceFile(current) && !ts.isFunctionLike(current) && !ts.isBlock(current)) {
    current = current.parent;
  }
  return current;
}

function parentLexicalScope(scope) {
  return scope?.parent === undefined ? undefined : lexicalScope(scope.parent);
}

function checkMigrationChecksumHistory() {
  const manifestPath = path.join(root, "docs", "architecture", "data-baseline.json");
  const current = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const baseRef = process.env.BASELINE_BASE_REF?.trim() || "HEAD";
  let previous;
  try {
    previous = JSON.parse(execFileSync(
      "git",
      ["show", `${baseRef}:docs/architecture/data-baseline.json`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ));
  } catch {
    return;
  }
  for (const [identity, checksum] of Object.entries(previous.migrationChecksums ?? {})) {
    if (current.migrationChecksums?.[identity] !== checksum) {
      violations.push({
        rule: "migration-checksum-immutable",
        file: "docs/architecture/data-baseline.json",
        line: 1,
        message: `Applied migration ${identity} checksum cannot be changed or removed`,
      });
    }
  }
}

function checkStaleAllowlistEntries() {
  allowlist.forEach((entry, index) => {
    if (matchedAllowlistEntries.has(index)) return;
    violations.push({
      rule: "stale-allowlist-entry",
      file: "scripts/architecture-baseline-allowlist.json",
      line: 1,
      message: `Allowlist entry ${index + 1} (${String(entry?.rule ?? "unknown")}) no longer matches a violation`,
    });
  });
}

function containsStringLiteral(node) {
  let found = false;
  visit(node, (candidate) => { if (ts.isStringLiteralLike(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) found = true; });
  return found;
}

function isJsonParseExpression(node) {
  if (ts.isParenthesizedExpression(node)) return isJsonParseExpression(node.expression);
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "JSON" &&
    node.expression.name.text === "parse";
}

function isEqualityOperator(kind) {
  return kind === ts.SyntaxKind.EqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
}

function normalized(file) { return path.resolve(file).replaceAll("\\", "/"); }
function relative(file) { return path.relative(root, file).replaceAll("\\", "/"); }
