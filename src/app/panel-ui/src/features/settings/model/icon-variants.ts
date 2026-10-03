import { decorativeSvg } from "../../../icon-svg";
import "./icon-variants.css";

/** Retain original paint; the theme switches the two local vector groups. */
export function modelIconVariants(original: string, monochrome: string | undefined, identity: string): string {
  if (monochrome === undefined || original === monochrome) return decorativeSvg(original);
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" fill="currentColor" aria-hidden="true" focusable="false">'
    + variantGroup(original, "brand", identity)
    + variantGroup(monochrome, "monochrome", identity)
    + "</svg>";
}

function variantGroup(svg: string, style: "brand" | "monochrome", identity: string): string {
  const root = decorativeSvg(svg).match(/<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/iu)!;
  const viewBox = root[1].match(/\bviewBox="([^"]+)"/iu)?.[1].trim().split(/[\s,]+/u).map(Number) ?? [0, 0, 640, 640];
  const [x, y, width, height] = viewBox;
  const scale = 640 / Math.max(width, height);
  const offsetX = (640 - width * scale) / 2;
  const offsetY = (640 - height * scale) / 2;
  const attributes = root[1].replace(/\s(?:xmlns(?::[\w-]+)?|viewBox|width|height|aria-hidden|focusable)="[^"]*"/giu, "");
  const prefix = identity.replace(/[^a-z0-9-]/giu, "-") + "-" + style + "-";
  const content = ('<g' + attributes + '>' + root[2] + '</g>')
    .replace(/\bid="([^"]+)"/gu, (_match, id: string) => 'id="' + prefix + id + '"')
    .replace(/url\(#([^)]*)\)/gu, (_match, id: string) => "url(#" + prefix + id + ")")
    .replace(/((?:xlink:)?href=")#([^"]+)"/gu, (_match, attribute: string, id: string) => attribute + "#" + prefix + id + '"');
  return '<g data-model-icon-variant="' + style + '" transform="translate(' + offsetX + " " + offsetY + ") scale(" + scale + ") translate(" + -x + " " + -y + ')">' + content + "</g>";
}
