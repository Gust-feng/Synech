import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const files = sourceFiles(sourceRoot);
const sourceSet = new Set(files.map((file) => path.resolve(file)));
const allowlist = JSON.parse(fs.readFileSync(path.join(root, "scripts", "architecture-baseline-allowlist.json"), "utf8"));
const violations = [];
const ownedFeatures = new Set(["spaces", "workspaces", "personal-knowledge"]);
const presentationFields = new Set(["title", "label", "message", "detail", "summary"]);

for (const file of files) {
  const sourceText = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const sourceFeature = appFeature(file);
  for (const statement of source.statements) {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
      statement.moduleSpecifier === undefined || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const target = resolveSourceImport(file, specifier);
    const targetFeature = target === undefined ? undefined : appFeature(target);
    if (sourceFeature !== undefined && targetFeature !== undefined && sourceFeature !== targetFeature &&
      ownedFeatures.has(sourceFeature) && ownedFeatures.has(targetFeature)) {
      report("feature-cross-import", file, statement, `${sourceFeature} must not import ${targetFeature}`, sourceText, source);
    }
    if (isRouteAdapter(file) && /(?:repository|sqlite)/iu.test(specifier)) {
      report("route-infrastructure-import", file, statement, "Route adapters must not import Repository or SQLite modules", sourceText, source);
    }
    if (!normalized(file).includes("/src/app/panel-server/") && importedName(statement, "PanelHttpError")) {
      report("panel-http-error-outside-adapter", file, statement, "PanelHttpError is restricted to panel-server adapters", sourceText, source);
    }
  }
  if (isPresentationControlScope(file)) visit(source, (node) => {
    if (ts.isBinaryExpression(node) && isEqualityOperator(node.operatorToken.kind) &&
      ((containsPresentationField(node.left) && containsStringLiteral(node.right)) ||
       (containsPresentationField(node.right) && containsStringLiteral(node.left)))) {
      report("presentation-string-control", file, node, "Presentation copy must not be a control-flow identity", sourceText, source);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (["includes", "startsWith", "endsWith", "match", "search"].includes(method) && containsPresentationField(receiver)) {
        report("presentation-string-control", file, node, "Presentation copy must not be parsed for control flow", sourceText, source);
      }
      if (method === "test" && node.arguments.some(containsPresentationField)) {
        report("presentation-string-control", file, node, "Presentation copy must not be parsed by regular expression", sourceText, source);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("Architecture baseline violations detected:");
  for (const violation of violations) console.error(`- [${violation.rule}] ${violation.file}:${violation.line} ${violation.message}`);
  process.exitCode = 1;
}

function report(rule, file, node, message, sourceText, sourceFile) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const text = sourceText.slice(node.getStart(sourceFile), node.getEnd()).split(/\r?\n/u, 1)[0].trim();
  const relativeFile = relative(file);
  const allowed = allowlist.some((entry) => entry.rule === rule && entry.file === relativeFile &&
    typeof entry.contains === "string" && text.includes(entry.contains) &&
    typeof entry.reason === "string" && entry.reason.trim().length > 0);
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

function appFeature(file) {
  const parts = path.relative(path.join(sourceRoot, "app"), file).replaceAll("\\", "/").split("/");
  return parts[0] === ".." || parts.length < 2 ? undefined : parts[0];
}

function isRouteAdapter(file) {
  const value = normalized(file);
  return value.includes("/src/app/panel-server/") && /(?:^|\/)[^/]+-routes?\.ts$/u.test(value);
}

function isPresentationControlScope(file) {
  const value = normalized(file);
  return value.includes("/src/app/panel-api/read-model/") ||
    value.includes("/src/app/panel-ui/src/features/conversations/") ||
    value.endsWith("/ActivityEvidence.tsx") ||
    value.endsWith("/ConfirmationCard.tsx") ||
    value.endsWith("/ConversationTranscript.tsx");
}

function importedName(statement, name) {
  if (!ts.isImportDeclaration(statement)) return false;
  const clause = statement.importClause;
  if (clause?.name?.text === name) return true;
  return clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.some((element) => element.name.text === name || element.propertyName?.text === name);
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

function containsStringLiteral(node) {
  let found = false;
  visit(node, (candidate) => { if (ts.isStringLiteralLike(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) found = true; });
  return found;
}

function isEqualityOperator(kind) {
  return kind === ts.SyntaxKind.EqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
}

function normalized(file) { return path.resolve(file).replaceAll("\\", "/"); }
function relative(file) { return path.relative(root, file).replaceAll("\\", "/"); }
