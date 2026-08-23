export function decorativeSvg(svg: string): string {
  const withoutMetadata = svg
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(/<desc\b[^>]*>[\s\S]*?<\/desc>/gi, "")
    .replace(/\saria-labelledby="[^"]*"/gi, "")
    .replace(/\srole="img"/gi, "");

  return withoutMetadata.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    const cleanAttrs = attrs
      .replace(/\saria-hidden="[^"]*"/gi, "")
      .replace(/\sfocusable="[^"]*"/gi, "")
      .trimEnd();
    return `<svg${cleanAttrs} aria-hidden="true" focusable="false">`;
  });
}