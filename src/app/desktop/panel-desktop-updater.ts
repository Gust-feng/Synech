import { app } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

const UPDATE_CHECK_DELAY_MS = 10_000;

// 自动更新走 GitHub Releases（electron-builder publish 配置在构建时写入
// app-update.yml），只在打包后的桌面进程运行；dev 与 smoke 启动静默跳过。
// 更新包在后台下载，退出应用时自动安装，避免打断进行中的会话。
export function startDesktopAutoUpdater(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => {
    console.log("检查更新中……");
  });
  autoUpdater.on("update-not-available", (info) => {
    console.log(`已是最新版本：${info.version}`);
  });
  autoUpdater.on("update-available", (info) => {
    console.log(`发现新版本 ${info.version}，正在后台下载。`);
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log(`新版本 ${info.version} 下载完成，退出应用后自动安装。`);
  });
  autoUpdater.on("error", (error) => {
    console.warn("自动更新检查失败。");
    console.warn(error);
  });
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.warn("自动更新检查失败。");
      console.warn(error);
    });
  }, UPDATE_CHECK_DELAY_MS);
}
