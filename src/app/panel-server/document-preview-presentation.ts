import type { DocumentPresentation, DocumentPreview } from "../panel-api-contracts.js";

const MARKDOWN_LANGUAGES = new Set(["md", "markdown"]);
const CODE_LANGUAGES = new Set([
  "json", "jsonl", "yaml", "toml", "ini", "xml", "csv", "log",
  "javascript", "typescript", "jsx", "tsx", "python", "java", "c", "h", "cpp", "hpp",
  "cs", "go", "rs", "rb", "php", "shell", "bash", "zsh", "powershell", "sql", "graphql",
  "vue", "svelte", "css", "html", "gitignore", "gitattributes", "gitmodules", "dotenv",
  "editorconfig", "npmrc", "nvmrc", "dockerfile", "makefile", "license",
]);

export function documentPresentation(
  content: DocumentPreview["content"],
): DocumentPresentation {
  const kind = presentationKind(content);
  const editable = content.kind === "text" && content.editable;
  return {
    kind,
    editable,
    sourceMode: kind === "markdown" && editable,
  };
}

function presentationKind(content: DocumentPreview["content"]): DocumentPresentation["kind"] {
  switch (content.kind) {
    case "directory": return "directory";
    case "web": return "web";
    case "pages": return "pdf";
    case "unavailable": return "unavailable";
    case "media": return content.mediaKind;
    case "office": return content.officeKind;
    case "text": {
      const language = content.language?.toLowerCase();
      if (language !== undefined && MARKDOWN_LANGUAGES.has(language)) return "markdown";
      if (language !== undefined && CODE_LANGUAGES.has(language)) return "code";
      return "text";
    }
  }
}
