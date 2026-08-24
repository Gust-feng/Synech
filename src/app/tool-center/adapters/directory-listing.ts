import { promises as fs } from "node:fs";
import path from "node:path";

import { shouldSkipEntry, throwIfAborted } from "./local-workspace-common.js";

export async function listGlobFiles(input: {
  readonly directory: string;
  readonly pattern: string;
  readonly collectLimit: number;
  readonly abortSignal?: AbortSignal;
}): Promise<readonly string[]> {
  return globFiles(
    input.directory,
    globPatternRegExp(input.pattern),
    input.collectLimit,
    input.abortSignal,
  );
}

async function globFiles(
  directory: string,
  pattern: RegExp,
  collectLimit: number,
  abortSignal: AbortSignal | undefined,
  prefix = "",
  output: string[] = [],
): Promise<readonly string[]> {
  if (output.length >= collectLimit) return output;
  throwIfAborted(abortSignal);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (output.length >= collectLimit) break;
    throwIfAborted(abortSignal);
    if (shouldSkipEntry(entry.name)) continue;
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await globFiles(path.join(directory, entry.name), pattern, collectLimit, abortSignal, relative, output);
    } else if (entry.isFile() && pattern.test(relative)) {
      output.push(relative);
    }
  }
  return output;
}

function globPatternRegExp(pattern: string): RegExp {
  const alternatives = expandGlobBraces(pattern.replaceAll("\\", "/"));
  const sources = alternatives.map((value) => {
    let source = "";
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]!;
      if (character === "*" && value[index + 1] === "*") {
        if (value[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else if (character === "*") source += "[^/]*";
      else if (character === "?") source += "[^/]";
      else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
    return source;
  });
  return new RegExp(`^(?:${sources.join("|")})$`);
}

function expandGlobBraces(pattern: string): readonly string[] {
  const match = /\{([^{}]+)\}/.exec(pattern);
  if (match === null || match.index === undefined) return [pattern];
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return match[1]!.split(",").flatMap((choice) => expandGlobBraces(`${before}${choice}${after}`));
}
