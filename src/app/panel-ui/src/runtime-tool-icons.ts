import dartLogo from "./runtime-tool-icon-assets/dart.svg?raw";
import dotnetLogo from "./runtime-tool-icon-assets/dotnet.svg?raw";
import erlangLogo from "./runtime-tool-icon-assets/erlang.svg?raw";
import gitLogo from "./runtime-tool-icon-assets/git.svg?raw";
import goLogo from "./runtime-tool-icon-assets/go.svg?raw";
import haskellLogo from "./runtime-tool-icon-assets/haskell.svg?raw";
import javascriptLogo from "./runtime-tool-icon-assets/javascript.svg?raw";
import juliaLogo from "./runtime-tool-icon-assets/julia.svg?raw";
import kotlinLogo from "./runtime-tool-icon-assets/kotlin.svg?raw";
import nodejsLogo from "./runtime-tool-icon-assets/nodejs.svg?raw";
import phpLogo from "./runtime-tool-icon-assets/php.svg?raw";
import pythonLogo from "./runtime-tool-icon-assets/python.svg?raw";
import rLogo from "./runtime-tool-icon-assets/r.svg?raw";
import rubyLogo from "./runtime-tool-icon-assets/ruby.svg?raw";
import rustLogo from "./runtime-tool-icon-assets/rust.svg?raw";
import swiftLogo from "./runtime-tool-icon-assets/swift.svg?raw";
import typescriptLogo from "./runtime-tool-icon-assets/typescript.svg?raw";
import zigLogo from "./runtime-tool-icon-assets/zig.svg?raw";
import { decorativeSvg } from "./icon-svg";

export type RuntimeToolIconKey =
  | "dart"
  | "dotnet"
  | "erlang"
  | "git"
  | "go"
  | "haskell"
  | "javascript"
  | "julia"
  | "kotlin"
  | "nodejs"
  | "php"
  | "python"
  | "r"
  | "ruby"
  | "rust"
  | "swift"
  | "typescript"
  | "zig";

const runtimeToolIcons: Record<RuntimeToolIconKey, string> = {
  dart: runtimeToolSvg("dart", dartLogo),
  dotnet: runtimeToolSvg("dotnet", dotnetLogo),
  erlang: runtimeToolSvg("erlang", erlangLogo),
  git: runtimeToolSvg("git", gitLogo),
  go: runtimeToolSvg("go", goLogo),
  haskell: runtimeToolSvg("haskell", haskellLogo),
  javascript: runtimeToolSvg("javascript", javascriptLogo),
  julia: runtimeToolSvg("julia", juliaLogo),
  kotlin: runtimeToolSvg("kotlin", kotlinLogo),
  nodejs: runtimeToolSvg("nodejs", nodejsLogo),
  php: runtimeToolSvg("php", phpLogo),
  python: runtimeToolSvg("python", pythonLogo),
  r: runtimeToolSvg("r", rLogo),
  ruby: runtimeToolSvg("ruby", rubyLogo),
  rust: runtimeToolSvg("rust", rustLogo),
  swift: runtimeToolSvg("swift", swiftLogo),
  typescript: runtimeToolSvg("typescript", typescriptLogo),
  zig: runtimeToolSvg("zig", zigLogo),
};

const runtimeToolIconAliases = new Map<string, RuntimeToolIconKey>([
  ["c#", "dotnet"],
  ["csharp", "dotnet"],
  ["dart", "dart"],
  ["dotnet", "dotnet"],
  ["erl", "erlang"],
  ["erlang", "erlang"],
  ["git", "git"],
  ["git-bash", "git"],
  ["golang", "go"],
  ["go", "go"],
  ["haskell", "haskell"],
  ["hs", "haskell"],
  ["javascript", "javascript"],
  ["julia", "julia"],
  ["jl", "julia"],
  ["js", "javascript"],
  ["kotlin", "kotlin"],
  ["kt", "kotlin"],
  ["node", "nodejs"],
  ["node.js", "nodejs"],
  ["nodejs", "nodejs"],
  ["php", "php"],
  ["py", "python"],
  ["python", "python"],
  ["r", "r"],
  ["ruby", "ruby"],
  ["rust", "rust"],
  ["swift", "swift"],
  ["ts", "typescript"],
  ["typescript", "typescript"],
  ["zig", "zig"],
]);

export function resolveRuntimeToolIconSvg(id: string): string | undefined {
  const iconKey = runtimeToolIconAliases.get(id.trim().toLowerCase());
  return iconKey === undefined ? undefined : runtimeToolIcons[iconKey];
}

function runtimeToolSvg(key: RuntimeToolIconKey, svg: string): string {
  return prefixSvgIds(decorativeSvg(svg), `synech-runtime-tool-${key}`);
}

function prefixSvgIds(svg: string, prefix: string): string {
  const ids = Array.from(svg.matchAll(/\bid="([^"]+)"/g), (match) => match[1])
    .filter((id): id is string => id !== undefined);
  return ids.reduce((current, id) => {
    const prefixedId = `${prefix}-${id}`;
    return current
      .replace(new RegExp(`\\bid="${escapeRegExp(id)}"`, "g"), `id="${prefixedId}"`)
      .replace(new RegExp(`url\\(#${escapeRegExp(id)}\\)`, "g"), `url(#${prefixedId})`)
      .replace(new RegExp(`(href|xlink:href)="#${escapeRegExp(id)}"`, "g"), `$1="#${prefixedId}"`);
  }, svg);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
