import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

test("NSIS backend is a non-elevating current-user one-click installer", () => {
  const config = YAML.parse(readFileSync("electron-builder.yml", "utf8"));
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.packElevateHelper, false);
  assert.equal(config.nsis.runAfterFinish, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, true);
  assert.equal(config.nsis.uninstallDisplayName, "Synech");
});

test("uninstall removes only Synech-owned local state and never during an update", () => {
  const script = readFileSync("packaging/windows/installer.nsh", "utf8");
  assert.match(script, /!macro customUnInstall/u);
  assert.match(script, /\$LOCALAPPDATA\\Synech/u);
  assert.match(script, /\$TEMP\\SynechInstaller/u);
  assert.match(script, /\$TEMP\\synech-command-logs/u);
  assert.match(script, /APP_INSTALLER_STORE_FILE/u);
  assert.match(script, /StdUtils\.GetParentPath/u);
  assert.match(script, /Delete "\$LOCALAPPDATA\\\$\{APP_INSTALLER_STORE_FILE\}"/u);
  assert.match(script, /RMDir "\$R0"/u);
  assert.doesNotMatch(script, /RMDir \/r "\$R0"/u);
  assert.match(script, /\$\{ifNot\} \$\{isUpdated\}/u);
});
