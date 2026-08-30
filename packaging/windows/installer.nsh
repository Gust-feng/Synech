; The branded WebView2 shell owns the normal installation experience. This
; inner installer remains the single owner of install/update/uninstall facts.

!macro customInit
  SetShellVarContext current
!macroend

; Product Home is deliberately outside $INSTDIR. Remove it only during a real
; uninstall: electron-builder invokes the old uninstaller during an update and
; marks that path with ${isUpdated}; deleting here would destroy user data on
; every upgrade.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ClearErrors
    RMDir /r "$LOCALAPPDATA\Synech"
    ${if} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "无法删除 Synech 数据，请关闭相关进程后重试。"
      Abort
    ${endIf}

    ClearErrors
    RMDir /r "$TEMP\SynechInstaller"
    ${if} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "无法清理 Synech 安装缓存，请关闭相关进程后重试。"
      Abort
    ${endIf}

    ; electron-builder stores the embedded installer used by its updater
    ; plumbing under APP_INSTALLER_STORE_FILE (currently
    ; %LOCALAPPDATA%\synech-updater\installer.exe). Delete only that known
    ; file; never recursively remove an updater directory that may contain
    ; files outside this install's ownership boundary.
    !ifdef APP_INSTALLER_STORE_FILE
      ClearErrors
      ${if} ${FileExists} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
        Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
        ${if} ${Errors}
          MessageBox MB_OK|MB_ICONEXCLAMATION "无法清理 Synech 安装器缓存，请关闭相关进程后重试。"
          Abort
        ${endIf}
      ${endif}
      ClearErrors
      ${StdUtils.GetParentPath} $R0 "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
      ${if} ${FileExists} "$R0"
        ; RMDir without /r removes the cache directory only when it is empty.
        RMDir "$R0"
        ClearErrors
      ${endif}
    !endif

    ClearErrors
    RMDir /r "$TEMP\synech-command-logs"
    ${if} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "无法清理 Synech 命令日志，请关闭相关进程后重试。"
      Abort
    ${endIf}
  ${endIf}
!macroend
