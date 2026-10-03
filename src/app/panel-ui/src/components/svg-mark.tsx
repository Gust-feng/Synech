import React from "react";

/** Inline SVG definitions are scoped per rendered instance, including both variants. */
export function SvgMark(props: { readonly svg: string; readonly className?: string }): React.ReactElement {
  const scope = React.useId().replace(/[^a-z0-9-]/giu, "-") + "-";
  const markup = React.useMemo(() => props.svg
    .replace(/\bid="([^"]+)"/gu, (_match, id: string) => 'id="' + scope + id + '"')
    .replace(/url\(#([^)]*)\)/gu, (_match, id: string) => "url(#" + scope + id + ")")
    .replace(/((?:xlink:)?href=")#([^"]+)"/gu, (_match, attribute: string, id: string) => attribute + "#" + scope + id + '"'), [props.svg, scope]);
  return <span className={props.className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />;
}
