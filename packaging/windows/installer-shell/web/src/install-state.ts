export type FailurePrimaryAction = "retry" | "change-location";

export type FailureAction = {
  readonly primary: FailurePrimaryAction;
  readonly retryLabel: string;
  readonly changeLocationLabel: string;
};

export function failureAction(code: string | undefined): FailureAction {
  // 路径策略失败时，主动作应是重新选择父目录，而不是用同一路径重试。
  if (code === "invalid_install_path" || code === "invalid_install_parent" || code === "install_parent_reparse" ||
      code === "install_target_is_file" || code === "install_target_reparse" || code === "install_target_not_empty" ||
      code === "install_target_unavailable" || code === "install_target_product_home_conflict") {
    return {
      primary: "change-location",
      retryLabel: "重新安装",
      changeLocationLabel: "选择安装位置",
    };
  }
  return {
    primary: "retry",
    retryLabel: "重新安装",
    changeLocationLabel: "更改安装位置",
  };
}
