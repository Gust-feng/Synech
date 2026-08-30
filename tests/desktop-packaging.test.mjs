import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

test("desktop packaging exposes Windows and macOS targets without adding Linux", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const builder = YAML.parse(readFileSync("electron-builder.yml", "utf8"));

  assert.match(packageJson.scripts["dist:desktop:win"], /--win nsis --x64/u);
  assert.match(packageJson.scripts["dist:desktop:mac"], /--mac dmg zip/u);
  assert.equal(builder.win.target[0].target, "nsis");
  assert.deepEqual(builder.mac.target, ["dmg", "zip"]);
  assert.equal(builder.mac.icon, "build/icons/favicon.png");
  assert.equal(builder.linux, undefined);
});

test("generated macOS icon is a 512 pixel PNG", () => {
  const icon = readFileSync("build/icons/favicon.png");
  assert.equal(icon.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(icon.readUInt32BE(16), 512);
  assert.equal(icon.readUInt32BE(20), 512);
});
