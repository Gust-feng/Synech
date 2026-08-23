import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = process.cwd();
const source = join(root, "src", "app", "panel-ui", "public", "favicon.svg");
// Web consumes the SVG directly; Electron and Windows consume these generated platform assets.
const desktopIcon = join(root, "dist", "app", "desktop-assets", "favicon.png");
const windowsIcon = join(root, "build", "icons", "favicon.ico");
const sizes = [16, 24, 32, 48, 64, 128, 256];
const svg = readFileSync(source);
const images = sizes.map((size) => ({ size, body: renderPng(svg, size) }));

mkdirSync(dirname(desktopIcon), { recursive: true });
mkdirSync(dirname(windowsIcon), { recursive: true });
writeFileSync(desktopIcon, images.at(-1).body);
writeFileSync(windowsIcon, createIco(images));

function renderPng(sourceSvg, size) {
  return new Resvg(sourceSvg, {
    fitTo: { mode: "width", value: size },
  }).render().asPng();
}

function createIco(images) {
  const headerSize = 6 + images.length * 16;
  const buffer = Buffer.alloc(headerSize + images.reduce((total, image) => total + image.body.length, 0));
  let offset = 0;
  buffer.writeUInt16LE(0, offset);
  offset += 2;
  buffer.writeUInt16LE(1, offset);
  offset += 2;
  buffer.writeUInt16LE(images.length, offset);
  offset += 2;
  let imageOffset = headerSize;
  for (const { size, body } of images) {
    buffer[offset] = size === 256 ? 0 : size;
    buffer[offset + 1] = size === 256 ? 0 : size;
    buffer[offset + 2] = 0;
    buffer[offset + 3] = 0;
    buffer.writeUInt16LE(1, offset + 4);
    buffer.writeUInt16LE(32, offset + 6);
    buffer.writeUInt32LE(body.length, offset + 8);
    buffer.writeUInt32LE(imageOffset, offset + 12);
    offset += 16;
    body.copy(buffer, imageOffset);
    imageOffset += body.length;
  }
  return buffer;
}
