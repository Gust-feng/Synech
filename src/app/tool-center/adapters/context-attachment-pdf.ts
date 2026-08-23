import { getResolvedPDFJS } from "unpdf";
import { throwIfAborted } from "./local-workspace-common.js";

export type ExtractedPdfText = {
  readonly text: string;
  readonly reason?: string;
  readonly facts: {
    readonly pageCount: number;
    readonly textItems: number;
  };
};

export async function extractPdfText(
  buffer: Buffer,
  abortSignal?: AbortSignal,
): Promise<ExtractedPdfText> {
  throwIfAborted(abortSignal);
  const pdfjs = await getResolvedPDFJS();
  throwIfAborted(abortSignal);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  const abort = (): void => {
    void loadingTask.destroy().catch(() => undefined);
  };
  abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    const document = await loadingTask.promise;
    throwIfAborted(abortSignal);
    const pages: string[] = [];
    let textItems = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(abortSignal);
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        throwIfAborted(abortSignal);
        const fragments: string[] = [];
        for (const item of content.items) {
          if (!("str" in item) || typeof item.str !== "string" || item.str.length === 0) continue;
          fragments.push(item.str, item.hasEOL ? "\n" : " ");
          textItems += 1;
        }
        pages.push(fragments.join(""));
      } finally {
        page.cleanup();
      }
    }
    const text = normalizeExtractedPdfText(pages.join("\n\n"));
    return {
      text,
      reason: text.length === 0 ? "no_extractable_pdf_text" : undefined,
      facts: { pageCount: document.numPages, textItems },
    };
  } catch (error) {
    throwIfAborted(abortSignal);
    throw error;
  } finally {
    abortSignal?.removeEventListener("abort", abort);
    await loadingTask.destroy().catch(() => undefined);
  }
}

export function pdfReadErrorReason(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  if (name === "PasswordException") return "pdf_password_required";
  if (name === "InvalidPDFException" || name === "MissingPDFException") return "invalid_pdf";
  return "pdf_parse_failed";
}

function normalizeExtractedPdfText(value: string): string {
  return value
    .replace(/\u0000/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
