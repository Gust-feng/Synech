import path from "node:path";

/**
 * 删除 / 链接生命周期协调器共享的互斥键。
 *
 * Space 删除、Workspace 删除、Conversation 归属链接三个生命周期协调器必须彼此
 * 串行，并与整仓备份快照（独占 Product Home）互斥。但它们不能直接独占 Product Home
 * 本身：SpaceFeature 的引用删除生命周期会在同一个 file mutation coordinator 上申请
 * system journals 与 workbench/space-files 的子目录锁。协调器不可重入，
 * 若外层独占 Product Home，内层申请其子目录必然被自己阻塞——删除含托管文件夹或工作台
 * 资产的 Space 时会确定性自死锁，并锁死整个协调器。
 *
 * 该 sentinel 位于 system/locks：与备份的 system root 独占仍然重叠（保持互斥、
 * 保持三协调器互串），但与上述子目录锁互为兄弟、不重叠，从而打破自嵌套死锁。它只作为
 * 协调器锁键使用，不对应真实文件，也不会被创建或读写。
 */
export function synechDeletionLifecycleLockKey(lockRoot: string): string {
  return path.join(lockRoot, ".synech-deletion-lifecycle.lock");
}
