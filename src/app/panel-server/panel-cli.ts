import { parsePanelArgs } from "./panel-launch-args.js";
import { startLocalPanelServer } from "./request-handler.js";

export async function runPanelCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parsePanelArgs(argv);
  const server = await startLocalPanelServer({
    host: args.host,
    port: args.port,
    configDirectory: args.configDirectory,
  });

  console.log(`Synech 本地面板：${server.url}`);
  if (server.configDirectory !== undefined) {
    console.log(`配置目录：${server.configDirectory}`);
  }

  if (args.smoke) {
    await server.close();
    return;
  }

  let closing: Promise<void> | undefined;
  const closeServerOnce = (): Promise<void> => {
    closing ??= server.close();
    return closing;
  };
  const closeAndExit = (): void => {
    closeServerOnce()
      .then(() => {
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
  };

  process.on("SIGINT", closeAndExit);
  process.on("SIGTERM", closeAndExit);
}
