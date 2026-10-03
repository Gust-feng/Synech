import { promises as fs } from "node:fs";
import { utf16SafePrefixLength } from "../text-window.js";

export {
  charWindowContent,
  parseLineRange,
  readLineRange,
  sliceLines,
  type ReadContentWindow,
} from "./text-window-read.js";

export async function readAttachmentTextFile(filePath: string, abortSignal?: AbortSignal): Promise<string> {
  return fs.readFile(filePath, { encoding: "utf8", signal: abortSignal });
}

export function returnedRawTextChars(value: string, maxLength: number): number {
  return value.length <= maxLength
    ? value.length
    : utf16SafePrefixLength(value, Math.max(0, maxLength - 1));
}
