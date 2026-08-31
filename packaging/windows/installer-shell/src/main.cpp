#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <wrl.h>
#include <WebView2.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/base.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cwctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "resource.h"
#include "../generated/installer-shell-assets.h"
#include "../generated/install-metadata.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using winrt::Windows::Data::Json::JsonArray;
using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Data::Json::JsonValue;

namespace {

constexpr wchar_t kWindowTitle[] = L"安装 Synech";
constexpr wchar_t kShellVirtualHost[] = L"synech-installer.example";
constexpr wchar_t kShellDocumentUri[] = L"https://synech-installer.example/index.html";
constexpr wchar_t kInstallDirectoryName[] = L"Synech";
constexpr wchar_t kInstallerRuntimeOwnerMarker[] = L".synech-installer-runtime";
constexpr wchar_t kDemoInstallPath[] = L"C:\\Demo\\Synech";
constexpr std::uint64_t kDemoInstallBytes = 277ULL * 1024ULL * 1024ULL + 100ULL * 1024ULL;
constexpr std::uint64_t kDemoAvailableBytes = 512ULL * 1024ULL * 1024ULL * 1024ULL;
constexpr int kWindowWidth = 820;
constexpr int kWindowHeight = 540;
constexpr UINT kUiEventMessage = WM_APP + 1;
constexpr UINT_PTR kWebReadyTimerId = 1;
constexpr UINT kWebReadyTimeoutMs = 5'000;
constexpr DWORD kInstallObservationIntervalMs = 300;
enum class UiEventKind {
  Phase,
  Activity,
  Artifacts,
  Failure,
  Exit,
};

struct InstallArtifact {
  std::wstring path;
  std::uintmax_t sizeBytes;
  std::wstring key;
};

struct InstallActivityObject {
  std::wstring kind;
  std::wstring path;
  std::wstring value;
  std::wstring detail;
  std::uintmax_t sizeBytes;
  bool hasSize;
};

struct UninstallRegistration {
  std::wstring path;
  std::wstring displayName;
  std::wstring command;
  std::filesystem::path uninstaller;
};

struct UiEvent {
  UiEventKind kind;
  std::wstring value;
  std::wstring state;
  std::wstring category;
  std::vector<InstallArtifact> artifacts;
  std::vector<InstallActivityObject> objects;
};

struct FileStamp {
  std::uintmax_t size;
  std::filesystem::file_time_type modified;

  bool operator==(const FileStamp&) const = default;
};

using FileSnapshot = std::map<std::filesystem::path, FileStamp>;

struct InstallOptions {
  bool createStartMenuShortcut;
  bool createDesktopShortcut;
};

struct InstallLocation {
  std::filesystem::path parent;
  std::filesystem::path target;
};

struct InstallLocationValidation {
  std::optional<InstallLocation> location;
  std::wstring errorCode;
};

std::filesystem::path LocalAppDataDirectory() {
  wchar_t localAppData[32768]{};
  const DWORD length = GetEnvironmentVariableW(
    L"LOCALAPPDATA", localAppData, static_cast<DWORD>(std::size(localAppData)));
  if (length == 0 || length >= std::size(localAppData)) {
    throw std::runtime_error("LOCALAPPDATA is unavailable");
  }
  return std::filesystem::path(localAppData);
}

std::filesystem::path InstallerRuntimeBaseDirectory() {
  wchar_t temporaryDirectory[32768]{};
  const DWORD length = GetTempPathW(
    static_cast<DWORD>(std::size(temporaryDirectory)), temporaryDirectory);
  if (length == 0 || length >= std::size(temporaryDirectory)) {
    throw std::runtime_error("TEMP is unavailable");
  }
  return std::filesystem::path(temporaryDirectory) / kInstallerRuntimeDirectoryName;
}

std::filesystem::path g_installerRuntimeDirectory;

const std::filesystem::path& InstallerRuntimeRootDirectory() {
  if (g_installerRuntimeDirectory.empty()) {
    throw std::runtime_error("installer runtime directory is not initialized");
  }
  return g_installerRuntimeDirectory;
}

void RemoveInstallerRuntimeDirectory() {
  if (g_installerRuntimeDirectory.empty()) return;
  std::filesystem::path base;
  try {
    base = InstallerRuntimeBaseDirectory();
  } catch (...) {
    g_installerRuntimeDirectory.clear();
    return;
  }
  std::error_code error;
  std::filesystem::remove_all(g_installerRuntimeDirectory, error);
  error.clear();
  std::filesystem::remove(base, error);
  g_installerRuntimeDirectory.clear();
}

std::filesystem::path InstallerCacheDirectory() {
  return InstallerRuntimeRootDirectory() / L"InstallerCache";
}

void WriteEmbeddedResource(HINSTANCE instance, int resourceId, const std::filesystem::path& target) {
  const HRSRC resource = FindResourceW(instance, MAKEINTRESOURCEW(resourceId), RT_RCDATA);
  if (resource == nullptr) throw std::runtime_error("embedded shell resource not found");
  const HGLOBAL loaded = LoadResource(instance, resource);
  if (loaded == nullptr) throw std::runtime_error("embedded shell resource could not be loaded");
  const auto* bytes = static_cast<const char*>(LockResource(loaded));
  const DWORD size = SizeofResource(instance, resource);
  if (bytes == nullptr || size == 0) throw std::runtime_error("embedded shell resource is empty");

  std::filesystem::create_directories(target.parent_path());
  std::ofstream output(target, std::ios::binary | std::ios::trunc);
  output.write(bytes, static_cast<std::streamsize>(size));
  if (!output) throw std::runtime_error("embedded shell resource could not be written");
}

std::filesystem::path WriteShellDocument(HINSTANCE instance) {
  const auto directory = InstallerRuntimeRootDirectory() / L"InstallerShell";
  const auto target = directory / L"index.html";
  WriteEmbeddedResource(instance, IDR_SYNECH_SHELL_HTML, target);
  for (const auto& asset : kEmbeddedShellAssets) {
    WriteEmbeddedResource(instance, asset.resourceId, directory / std::filesystem::path(std::wstring(asset.relativePath)));
  }
  return target;
}

std::optional<std::filesystem::path> ExistingInstallDirectory();
std::wstring GuidString();

std::uint64_t AvailableBytesFor(const std::filesystem::path& requestedPath) {
  std::filesystem::path probe = requestedPath;
  std::error_code error;
  while (!probe.empty() && !std::filesystem::exists(probe, error)) {
    error.clear();
    const auto parent = probe.parent_path();
    if (parent == probe) break;
    probe = parent;
  }
  ULARGE_INTEGER available{};
  if (probe.empty() || !GetDiskFreeSpaceExW(probe.c_str(), &available, nullptr, nullptr)) return 0;
  return available.QuadPart;
}

FileSnapshot CaptureInstallFiles(const std::filesystem::path& root) {
  FileSnapshot files;
  std::error_code error;
  if (!std::filesystem::is_directory(root, error) || error) return files;

  std::filesystem::recursive_directory_iterator iterator(
    root, std::filesystem::directory_options::skip_permission_denied, error);
  const std::filesystem::recursive_directory_iterator end;
  while (!error && iterator != end) {
    const auto path = iterator->path();
    if (iterator->is_regular_file(error) && !error) {
      const auto relative = std::filesystem::relative(path, root, error);
      if (!error) {
        const auto size = iterator->file_size(error);
        if (!error) {
          const auto modified = iterator->last_write_time(error);
          if (!error) files.emplace(relative, FileStamp{size, modified});
        }
      }
    }
    error.clear();
    iterator.increment(error);
  }
  return files;
}

std::vector<InstallArtifact> ChangedInstallFiles(const FileSnapshot& previous, const FileSnapshot& current) {
  std::vector<InstallArtifact> changed;
  for (const auto& [path, stamp] : current) {
    const auto existing = previous.find(path);
    if (existing != previous.end() && existing->second == stamp) continue;
    changed.push_back(InstallArtifact{path.native(), stamp.size});
  }
  return changed;
}

// 进度唯一事实源：相对安装前快照，新增或被修改文件的字节总和。
std::uint64_t WrittenBytesSince(const FileSnapshot& baseline, const FileSnapshot& current) {
  std::uint64_t bytes = 0;
  for (const auto& [path, stamp] : current) {
    const auto original = baseline.find(path);
    if (original != baseline.end() && original->second == stamp) continue;
    bytes += stamp.size;
  }
  return bytes;
}

std::optional<std::filesystem::path> KnownFolderPath(REFKNOWNFOLDERID folderId) {
  PWSTR raw = nullptr;
  if (FAILED(SHGetKnownFolderPath(folderId, KF_FLAG_DEFAULT, nullptr, &raw)) || raw == nullptr) return std::nullopt;
  std::filesystem::path result(raw);
  CoTaskMemFree(raw);
  return result;
}

std::optional<std::wstring> EnvironmentValue(const wchar_t* name) {
  const DWORD required = GetEnvironmentVariableW(name, nullptr, 0);
  if (required == 0) return std::nullopt;
  std::wstring value(required, L'\0');
  const DWORD length = GetEnvironmentVariableW(name, value.data(), required);
  if (length == 0 || length >= required) return std::nullopt;
  value.resize(length);
  return value;
}

std::optional<std::filesystem::path> NormalizeAbsolutePath(const std::filesystem::path& value) {
  if (value.empty() || !value.is_absolute()) return std::nullopt;
  std::error_code error;
  const auto absolute = std::filesystem::absolute(value, error);
  if (error || absolute.empty()) return std::nullopt;
  return absolute.lexically_normal();
}

std::optional<std::filesystem::path> ResolveEnvironmentPath(const std::filesystem::path& value) {
  if (value.empty()) return std::nullopt;
  std::error_code error;
  const auto absolute = value.is_absolute() ? value : std::filesystem::absolute(value, error);
  if (error || absolute.empty()) return std::nullopt;
  return absolute.lexically_normal();
}

std::wstring FoldPathComponent(const std::filesystem::path& component) {
  std::wstring value = component.native();
  std::transform(value.begin(), value.end(), value.begin(), std::towlower);
  return value;
}

std::vector<std::wstring> PathComponents(const std::filesystem::path& value) {
  std::vector<std::wstring> components;
  for (const auto& component : value) components.push_back(FoldPathComponent(component));
  return components;
}

bool IsPathPrefix(const std::vector<std::wstring>& prefix, const std::vector<std::wstring>& value) {
  if (prefix.size() > value.size()) return false;
  return std::equal(prefix.begin(), prefix.end(), value.begin());
}

bool PathsOverlap(const std::filesystem::path& left, const std::filesystem::path& right) {
  const auto normalizedLeft = NormalizeAbsolutePath(left);
  const auto normalizedRight = NormalizeAbsolutePath(right);
  if (!normalizedLeft.has_value() || !normalizedRight.has_value()) return false;
  const auto leftComponents = PathComponents(normalizedLeft.value());
  const auto rightComponents = PathComponents(normalizedRight.value());
  return IsPathPrefix(leftComponents, rightComponents) || IsPathPrefix(rightComponents, leftComponents);
}

bool PathsEqual(const std::filesystem::path& left, const std::filesystem::path& right) {
  const auto normalizedLeft = NormalizeAbsolutePath(left);
  const auto normalizedRight = NormalizeAbsolutePath(right);
  if (!normalizedLeft.has_value() || !normalizedRight.has_value()) return false;
  return PathComponents(normalizedLeft.value()) == PathComponents(normalizedRight.value());
}

bool IsReparsePoint(const std::filesystem::path& value) {
  const DWORD attributes = GetFileAttributesW(value.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

bool HasReparsePointAlongPath(const std::filesystem::path& value) {
  auto current = value;
  while (!current.empty()) {
    if (IsReparsePoint(current)) return true;
    const auto parent = current.parent_path();
    if (parent == current) break;
    current = parent;
  }
  return false;
}

std::optional<bool> IsDirectoryEmpty(const std::filesystem::path& directory) {
  std::error_code error;
  std::filesystem::directory_iterator iterator(directory, error);
  if (error) return std::nullopt;
  return iterator == std::filesystem::directory_iterator();
}

bool ShortcutTargetsApplication(
  const std::filesystem::path& shortcut,
  const std::filesystem::path& application) {
  ComPtr<IShellLinkW> link;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link)))) {
    return false;
  }
  ComPtr<IPersistFile> persisted;
  if (FAILED(link.As(&persisted)) || FAILED(persisted->Load(shortcut.c_str(), STGM_READ))) return false;
  wchar_t resolved[32768]{};
  WIN32_FIND_DATAW data{};
  if (FAILED(link->GetPath(resolved, static_cast<int>(std::size(resolved)), &data, SLGP_RAWPATH))) return false;
  return PathsEqual(std::filesystem::path(resolved), application);
}

void RemoveShortcutIfDisabled(
  REFKNOWNFOLDERID folderId,
  bool enabled,
  const std::filesystem::path& application) {
  if (enabled) return;
  const auto directory = KnownFolderPath(folderId);
  if (!directory.has_value()) throw std::runtime_error("shortcut folder is unavailable");
  std::error_code error;
  const auto shortcut = directory.value() / L"Synech.lnk";
  if (!std::filesystem::is_regular_file(shortcut, error) || error) return;
  // A same-named link may have been created by the user. Only remove a link
  // whose target is the application in this installation.
  if (!ShortcutTargetsApplication(shortcut, application)) return;
  std::filesystem::remove(shortcut, error);
  if (error) throw std::runtime_error("shortcut preference could not be applied");
}

void ApplyShortcutPreferences(
  const InstallOptions& options,
  const std::filesystem::path& installPath) {
  const auto application = installPath / L"Synech.exe";
  RemoveShortcutIfDisabled(FOLDERID_Programs, options.createStartMenuShortcut, application);
  RemoveShortcutIfDisabled(FOLDERID_Desktop, options.createDesktopShortcut, application);
  SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
}

InstallActivityObject ActivityObject(
  std::wstring kind,
  const std::filesystem::path& path,
  std::wstring value = {},
  std::optional<std::uintmax_t> sizeBytes = std::nullopt,
  std::wstring detail = {}) {
  return InstallActivityObject{
    std::move(kind),
    path.native(),
    std::move(value),
    std::move(detail),
    sizeBytes.value_or(0),
    sizeBytes.has_value(),
  };
}

std::vector<InstallActivityObject> InstalledShortcutObjects(
  const InstallOptions& options,
  const std::filesystem::path& installPath) {
  std::vector<InstallActivityObject> objects;
  const auto application = installPath / L"Synech.exe";
  const auto append = [&objects, &application](REFKNOWNFOLDERID folderId, bool enabled, std::wstring value) {
    if (!enabled) return;
    const auto directory = KnownFolderPath(folderId);
    if (!directory.has_value()) return;
    const auto shortcut = directory.value() / L"Synech.lnk";
    std::error_code error;
    if (std::filesystem::is_regular_file(shortcut, error) && !error &&
        ShortcutTargetsApplication(shortcut, application)) {
      objects.push_back(ActivityObject(L"shortcut", shortcut, std::move(value)));
    }
  };
  append(FOLDERID_Programs, options.createStartMenuShortcut, L"start-menu");
  append(FOLDERID_Desktop, options.createDesktopShortcut, L"desktop");
  return objects;
}

std::optional<std::filesystem::path> UninstallerPathFromCommand(std::wstring_view command) {
  const auto first = command.find_first_not_of(L" \t");
  if (first == std::wstring_view::npos) return std::nullopt;
  const auto remaining = command.substr(first);
  if (remaining.front() == L'\"') {
    const auto closing = remaining.find(L'\"', 1);
    if (closing == std::wstring_view::npos || closing == 1) return std::nullopt;
    return std::filesystem::path(remaining.substr(1, closing - 1));
  }
  const auto separator = remaining.find_first_of(L" \t");
  return std::filesystem::path(remaining.substr(0, separator));
}

std::optional<std::filesystem::path> ExistingInstallDirectory() {
  constexpr wchar_t parentPath[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
  HKEY parent = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, parentPath, 0, KEY_ENUMERATE_SUB_KEYS, &parent) != ERROR_SUCCESS) {
    return std::nullopt;
  }

  for (DWORD index = 0;; index += 1) {
    wchar_t name[256]{};
    DWORD nameLength = static_cast<DWORD>(std::size(name));
    const LONG enumeration = RegEnumKeyExW(parent, index, name, &nameLength, nullptr, nullptr, nullptr, nullptr);
    if (enumeration == ERROR_NO_MORE_ITEMS) break;
    if (enumeration != ERROR_SUCCESS) continue;

    HKEY key = nullptr;
    if (RegOpenKeyExW(parent, name, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS) continue;

    wchar_t displayName[256]{};
    DWORD displayType = 0;
    DWORD displaySize = sizeof(displayName);
    const LONG displayResult = RegQueryValueExW(
      key,
      L"DisplayName",
      nullptr,
      &displayType,
      reinterpret_cast<LPBYTE>(displayName),
      &displaySize);
    const std::wstring installedName(displayName);
    const bool isSynech = displayResult == ERROR_SUCCESS &&
      (displayType == REG_SZ || displayType == REG_EXPAND_SZ) &&
      (installedName == L"Synech" || installedName.starts_with(L"Synech "));
    if (!isSynech) {
      RegCloseKey(key);
      continue;
    }

    wchar_t installLocation[32768]{};
    DWORD locationType = 0;
    DWORD locationSize = sizeof(installLocation);
    const LONG locationResult = RegQueryValueExW(
      key,
      L"InstallLocation",
      nullptr,
      &locationType,
      reinterpret_cast<LPBYTE>(installLocation),
      &locationSize);
    if (locationResult == ERROR_SUCCESS &&
        (locationType == REG_SZ || locationType == REG_EXPAND_SZ) &&
        installLocation[0] != L'\0') {
      const std::filesystem::path location(installLocation);
      std::error_code fileError;
      if (std::filesystem::is_regular_file(location / L"Synech.exe", fileError) && !fileError) {
        RegCloseKey(key);
        RegCloseKey(parent);
        return location;
      }
    }

    wchar_t uninstallString[32768]{};
    DWORD uninstallType = 0;
    DWORD uninstallSize = sizeof(uninstallString);
    const LONG uninstallResult = RegQueryValueExW(
      key,
      L"UninstallString",
      nullptr,
      &uninstallType,
      reinterpret_cast<LPBYTE>(uninstallString),
      &uninstallSize);
    RegCloseKey(key);
    if (uninstallResult != ERROR_SUCCESS ||
        (uninstallType != REG_SZ && uninstallType != REG_EXPAND_SZ)) {
      continue;
    }
    const auto uninstaller = UninstallerPathFromCommand(uninstallString);
    if (!uninstaller.has_value()) continue;
    const auto location = uninstaller->parent_path();
    std::error_code fileError;
    if (std::filesystem::is_regular_file(location / L"Synech.exe", fileError) && !fileError) {
      RegCloseKey(parent);
      return location;
    }
  }
  RegCloseKey(parent);
  return std::nullopt;
}

std::filesystem::path DefaultInstallDirectory() {
  if (const auto existing = ExistingInstallDirectory(); existing.has_value()) return existing.value();
  if (const auto userPrograms = KnownFolderPath(FOLDERID_UserProgramFiles); userPrograms.has_value()) {
    return userPrograms.value() / kInstallDirectoryName;
  }
  return LocalAppDataDirectory() / L"Programs" / kInstallDirectoryName;
}

std::filesystem::path DefaultInstallParentDirectory() {
  return DefaultInstallDirectory().parent_path();
}

std::optional<UninstallRegistration> RegisteredUninstallInfo(const std::filesystem::path& installPath) {
  constexpr wchar_t parentPath[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
  HKEY parent = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, parentPath, 0, KEY_ENUMERATE_SUB_KEYS, &parent) != ERROR_SUCCESS) return std::nullopt;
  for (DWORD index = 0;; index += 1) {
    wchar_t name[256]{};
    DWORD nameLength = static_cast<DWORD>(std::size(name));
    const LONG enumeration = RegEnumKeyExW(parent, index, name, &nameLength, nullptr, nullptr, nullptr, nullptr);
    if (enumeration == ERROR_NO_MORE_ITEMS) break;
    if (enumeration != ERROR_SUCCESS) continue;
    HKEY key = nullptr;
    if (RegOpenKeyExW(parent, name, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS) continue;
    wchar_t displayName[256]{};
    DWORD type = 0;
    DWORD size = sizeof(displayName);
    const LONG result = RegQueryValueExW(key, L"DisplayName", nullptr, &type, reinterpret_cast<LPBYTE>(displayName), &size);
    wchar_t uninstallString[1024]{};
    DWORD uninstallType = 0;
    DWORD uninstallSize = sizeof(uninstallString);
    const LONG uninstallResult = RegQueryValueExW(
      key,
      L"UninstallString",
      nullptr,
      &uninstallType,
      reinterpret_cast<LPBYTE>(uninstallString),
      &uninstallSize);
    RegCloseKey(key);
    const std::wstring installedName(displayName);
    const auto uninstaller = UninstallerPathFromCommand(uninstallString);
    if (result == ERROR_SUCCESS && (type == REG_SZ || type == REG_EXPAND_SZ) &&
        uninstallResult == ERROR_SUCCESS && (uninstallType == REG_SZ || uninstallType == REG_EXPAND_SZ) &&
        (installedName == L"Synech" || installedName.starts_with(L"Synech ")) &&
        uninstaller.has_value() && PathsEqual(uninstaller->parent_path(), installPath)) {
      std::error_code fileError;
      if (!uninstaller.has_value() || !std::filesystem::is_regular_file(uninstaller.value(), fileError) || fileError) continue;
      RegCloseKey(parent);
      return UninstallRegistration{
        std::wstring(parentPath) + L"\\" + name,
        installedName,
        std::wstring(uninstallString),
        uninstaller.value(),
      };
    }
  }
  RegCloseKey(parent);
  return std::nullopt;
}

std::filesystem::path InstallTargetFor(const std::filesystem::path& parent) {
  return parent / kInstallDirectoryName;
}

std::vector<std::filesystem::path> ProductHomeCandidates() {
  std::vector<std::filesystem::path> candidates;
  std::optional<std::filesystem::path> localAppDataPath;
  if (const auto localAppData = EnvironmentValue(L"LOCALAPPDATA"); localAppData.has_value()) {
    localAppDataPath = NormalizeAbsolutePath(std::filesystem::path(localAppData.value()));
  }
  if (!localAppDataPath.has_value()) {
    localAppDataPath = KnownFolderPath(FOLDERID_LocalAppData);
  }
  if (localAppDataPath.has_value()) {
    candidates.push_back(localAppDataPath.value() / kInstallDirectoryName);
  }
  if (const auto configured = EnvironmentValue(L"SYNECH_HOME"); configured.has_value()) {
    if (const auto normalized = ResolveEnvironmentPath(std::filesystem::path(configured.value())); normalized.has_value()) {
      candidates.push_back(normalized.value());
    }
  }
  return candidates;
}

InstallLocationValidation ValidateInstallLocation(
  const std::filesystem::path& requestedParent,
  const std::optional<std::filesystem::path>& sessionAcceptedTarget = std::nullopt) {
  const auto parent = NormalizeAbsolutePath(requestedParent);
  if (!parent.has_value()) return {std::nullopt, L"invalid_install_parent"};

  std::error_code parentError;
  if (!std::filesystem::is_directory(parent.value(), parentError) || parentError) {
    return {std::nullopt, L"invalid_install_parent"};
  }
  if (HasReparsePointAlongPath(parent.value())) {
    return {std::nullopt, L"install_parent_reparse"};
  }

  const auto target = InstallTargetFor(parent.value());
  for (const auto& productHome : ProductHomeCandidates()) {
    if (PathsOverlap(target, productHome)) {
      return {std::nullopt, L"install_target_product_home_conflict"};
    }
  }

  const DWORD attributes = GetFileAttributesW(target.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    const DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
      return {InstallLocation{parent.value(), target}, {}};
    }
    return {std::nullopt, L"install_target_unavailable"};
  }
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    return {std::nullopt, L"install_target_reparse"};
  }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    return {std::nullopt, L"install_target_is_file"};
  }

  const auto empty = IsDirectoryEmpty(target);
  if (!empty.has_value()) return {std::nullopt, L"install_target_unavailable"};
  if (empty.value()) return {InstallLocation{parent.value(), target}, {}};
  if (sessionAcceptedTarget.has_value() && PathsEqual(target, sessionAcceptedTarget.value())) {
    return {InstallLocation{parent.value(), target}, {}};
  }
  if (RegisteredUninstallInfo(target).has_value()) {
    return {InstallLocation{parent.value(), target}, {}};
  }
  return {std::nullopt, L"install_target_not_empty"};
}

const std::array<std::filesystem::path, 3>& RequiredApplicationFiles() {
  static const std::array<std::filesystem::path, 3> files = {
    std::filesystem::path(L"Synech.exe"),
    std::filesystem::path(L"resources\\app.asar"),
    std::filesystem::path(L"resources.pak"),
  };
  return files;
}

bool RequiredApplicationFilesPresent(const std::filesystem::path& installPath) {
  for (const auto& relative : RequiredApplicationFiles()) {
    std::error_code error;
    if (!std::filesystem::is_regular_file(installPath / relative, error) || error) return false;
  }
  return true;
}

std::vector<InstallActivityObject> InstalledApplicationObjects(const std::filesystem::path& installPath) {
  std::vector<InstallActivityObject> objects;
  for (const auto& relative : RequiredApplicationFiles()) {
    const auto file = installPath / relative;
    std::error_code error;
    if (!std::filesystem::is_regular_file(file, error) || error) continue;
    const auto size = std::filesystem::file_size(file, error);
    if (!error) objects.push_back(ActivityObject(L"file", file, {}, size));
  }
  return objects;
}

std::vector<InstallActivityObject> InstalledUninstallObjects(const std::filesystem::path& installPath) {
  std::vector<InstallActivityObject> objects;
  if (const auto registration = RegisteredUninstallInfo(installPath); registration.has_value()) {
    objects.push_back(ActivityObject(
      L"executable",
      registration->uninstaller,
      L"Uninstaller",
      std::nullopt,
      registration->command));
    objects.push_back(ActivityObject(
      L"registry",
      std::filesystem::path(L"HKCU\\" + registration->path),
      registration->displayName,
      std::nullopt,
      L"DisplayName + UninstallString"));
  }
  return objects;
}

using ExtractProgressFn = std::function<void(std::uintmax_t written, std::uintmax_t total)>;

std::filesystem::path ExtractBackendInstaller(HINSTANCE instance, const std::wstring& extractionId, const ExtractProgressFn& onProgress) {
  const HRSRC resource = FindResourceW(instance, MAKEINTRESOURCEW(IDR_SYNECH_BACKEND_INSTALLER), RT_RCDATA);
  if (resource == nullptr) throw std::runtime_error("backend resource not found");
  const HGLOBAL loaded = LoadResource(instance, resource);
  const auto* bytes = static_cast<const char*>(LockResource(loaded));
  const DWORD size = SizeofResource(instance, resource);
  if (loaded == nullptr || bytes == nullptr || size == 0) throw std::runtime_error("backend resource is invalid");

  const auto directory = InstallerCacheDirectory() / extractionId;
  std::filesystem::create_directories(directory);
  const auto target = directory / L"Synech-Setup.exe";
  try {
    constexpr DWORD kChunkBytes = 8u * 1024u * 1024u;
    constexpr auto kProgressInterval = std::chrono::milliseconds(120);
    std::ofstream output(target, std::ios::binary | std::ios::trunc);
    std::uintmax_t written = 0;
    auto lastReport = std::chrono::steady_clock::now() - kProgressInterval;
    while (written < size) {
      const std::uintmax_t remaining = size - written;
      const DWORD chunk = remaining > kChunkBytes ? kChunkBytes : static_cast<DWORD>(remaining);
      output.write(bytes + written, static_cast<std::streamsize>(chunk));
      if (!output) throw std::runtime_error("backend resource could not be extracted");
      written += chunk;
      const auto now = std::chrono::steady_clock::now();
      if (now - lastReport >= kProgressInterval) {
        lastReport = now;
        if (onProgress) onProgress(written, size);
      }
    }
    if (onProgress) onProgress(size, size);
  } catch (...) {
    std::error_code ignored;
    std::filesystem::remove_all(directory, ignored);
    throw;
  }
  return target;
}

void RemoveExtractedBackend(const std::filesystem::path& backend) {
  if (backend.parent_path().parent_path() != InstallerCacheDirectory()) return;
  std::error_code ignored;
  std::filesystem::remove_all(backend.parent_path(), ignored);
}

bool IsCacheDirectoryName(std::wstring_view value) {
  if (value.size() != 36) return false;
  for (size_t index = 0; index < value.size(); index += 1) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != L'-') return false;
      continue;
    }
    if (!iswxdigit(value[index])) return false;
  }
  return true;
}

void RemoveLegacyInstallerRuntimeDirectories(const std::filesystem::path& base) {
  for (const auto& name : {L"InstallerShell", L"InstallerWebView2", L"InstallerCache"}) {
    const auto directory = base / name;
    const DWORD attributes = GetFileAttributesW(directory.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      continue;
    }
    std::error_code error;
    std::filesystem::remove_all(directory, error);
  }
}

void SweepExpiredInstallerCache() {
  std::filesystem::path base;
  try {
    base = InstallerRuntimeBaseDirectory();
  } catch (...) {
    return;
  }
  std::error_code error;
  std::filesystem::create_directories(base, error);
  if (error) return;
  RemoveLegacyInstallerRuntimeDirectories(base);

  // Each process owns one UUID directory and writes an explicit marker before
  // mounting WebView2. Only marked, expired directories are swept; unrelated
  // files or user-created directories under TEMP are never recursively deleted.
  const auto now = std::filesystem::file_time_type::clock::now();
  for (const auto& entry : std::filesystem::directory_iterator(base, error)) {
    if (error) return;
    if (entry.is_symlink(error) || !entry.is_directory(error) || error) {
      error.clear();
      continue;
    }
    if (!IsCacheDirectoryName(entry.path().filename().native()) ||
        !std::filesystem::is_regular_file(entry.path() / kInstallerRuntimeOwnerMarker, error) || error) {
      error.clear();
      continue;
    }
    const auto modified = entry.last_write_time(error);
    if (error) {
      error.clear();
      continue;
    }
    if (now - modified < std::chrono::hours(24)) continue;
    std::filesystem::remove_all(entry.path(), error);
    error.clear();
  }

  try {
    g_installerRuntimeDirectory = base / GuidString();
    std::filesystem::create_directories(g_installerRuntimeDirectory, error);
    if (error) {
      g_installerRuntimeDirectory.clear();
      return;
    }
    std::ofstream marker(g_installerRuntimeDirectory / kInstallerRuntimeOwnerMarker, std::ios::binary | std::ios::trunc);
    if (!marker) {
      g_installerRuntimeDirectory.clear();
      return;
    }
    marker << "Synech installer runtime\n";
    if (!marker) {
      g_installerRuntimeDirectory.clear();
      return;
    }
  } catch (...) {
    g_installerRuntimeDirectory.clear();
  }
}

class ExtractedBackend {
 public:
  ExtractedBackend(HINSTANCE instance, const std::wstring& extractionId, const ExtractProgressFn& onProgress = {})
    : path_(ExtractBackendInstaller(instance, extractionId, onProgress)) {}
  ~ExtractedBackend() { RemoveExtractedBackend(path_); }
  ExtractedBackend(const ExtractedBackend&) = delete;
  ExtractedBackend& operator=(const ExtractedBackend&) = delete;

  const std::filesystem::path& path() const { return path_; }

 private:
  std::filesystem::path path_;
};

std::wstring GuidString() {
  GUID guid{};
  if (FAILED(CoCreateGuid(&guid))) throw std::runtime_error("could not create extraction id");
  wchar_t value[39]{};
  StringFromGUID2(guid, value, static_cast<int>(std::size(value)));
  std::wstring result(value + 1, value + 37);
  std::transform(result.begin(), result.end(), result.begin(), towlower);
  return result;
}

std::wstring QuoteArgument(std::wstring_view value) {
  std::wstring result = L"\"";
  size_t slashCount = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') {
      slashCount += 1;
      continue;
    }
    if (character == L'\"') {
      result.append(slashCount * 2 + 1, L'\\');
      result.push_back(character);
      slashCount = 0;
      continue;
    }
    result.append(slashCount, L'\\');
    slashCount = 0;
    result.push_back(character);
  }
  result.append(slashCount * 2, L'\\');
  result.push_back(L'\"');
  return result;
}

class InstallerShell {
 public:
  InstallerShell(HINSTANCE instance, HWND window, bool demo)
    : instance_(instance), window_(window), demo_(demo) {}

  ~InstallerShell() {
    // Worker callbacks capture the shell. Join before releasing the object so
    // a late progress/failure post can never dereference a destroyed shell.
    if (worker_.joinable()) worker_.join();
    if (webview_ != nullptr) {
      if (messageToken_.value != 0) webview_->remove_WebMessageReceived(messageToken_);
      if (navigationToken_.value != 0) webview_->remove_NavigationCompleted(navigationToken_);
    }
    // WebView2 may keep file handles open until both COM objects are released.
    // Remove only the installer-owned temporary root after all workers and
    // WebView callbacks have stopped; the downloaded outer EXE is user-owned.
    controller_.Reset();
    webview_.Reset();
    try {
      RemoveInstallerRuntimeDirectory();
    } catch (...) {
      // Cleanup is best-effort here; the next installer launch repeats the
      // exact-root sweep without turning normal process shutdown into a crash.
    }
  }

  void StartWebView() {
    // Bound the whole WebView2 startup, including environment creation and
    // navigation. NavigationCompleted may never arrive when the runtime fails.
    SetTimer(window_, kWebReadyTimerId, kWebReadyTimeoutMs, nullptr);
    std::filesystem::path shellDirectory;
    std::filesystem::path webViewData;
    try {
      shellDirectory = WriteShellDocument(instance_).parent_path();
      webViewData = InstallerRuntimeRootDirectory() / L"InstallerWebView2";
      std::error_code error;
      std::filesystem::create_directories(webViewData, error);
      if (error) {
        StartNativeFallback();
        return;
      }
    } catch (...) {
      StartNativeFallback();
      return;
    }

    const HRESULT environmentStart = CreateCoreWebView2EnvironmentWithOptions(nullptr, webViewData.c_str(), nullptr,
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
        [this, shellDirectory](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
          if (fallbackStarted_) return S_OK;
          if (FAILED(result) || environment == nullptr) {
            StartNativeFallback();
            return S_OK;
          }
          const HRESULT controllerStart = environment->CreateCoreWebView2Controller(window_,
            Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
              [this, shellDirectory](HRESULT controllerResult, ICoreWebView2Controller* controller) -> HRESULT {
                if (fallbackStarted_) return S_OK;
                if (FAILED(controllerResult) || controller == nullptr) {
                  StartNativeFallback();
                  return S_OK;
                }
                controller_ = controller;
                if (FAILED(controller_->get_CoreWebView2(&webview_)) || webview_ == nullptr) {
                  StartNativeFallback();
                  return S_OK;
                }
                if (!ResizeWebView() || !ConfigureWebView()) {
                  StartNativeFallback();
                  return S_OK;
                }
                // The Lottie package fetches its own asset and WASM; serve the extracted Vite tree as one origin.
                ComPtr<ICoreWebView2_3> webview3;
                if (FAILED(webview_.As(&webview3)) || FAILED(webview3->SetVirtualHostNameToFolderMapping(
                      kShellVirtualHost,
                      shellDirectory.c_str(),
                      COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS))) {
                  StartNativeFallback();
                  return S_OK;
                }
                if (FAILED(webview_->Navigate(kShellDocumentUri))) StartNativeFallback();
                return S_OK;
              }).Get());
          if (FAILED(controllerStart)) StartNativeFallback();
          return S_OK;
        }).Get());
    if (FAILED(environmentStart)) StartNativeFallback();
  }

  bool ResizeWebView() const {
    if (controller_ == nullptr) return false;
    RECT bounds{};
    GetClientRect(window_, &bounds);
    return SUCCEEDED(controller_->put_Bounds(bounds));
  }

  bool IsInstalling() const {
    // Keep the native window alive while any worker can still post to it.
    return installing_.load() || demoPlaybackRunning_.load() || workerRunning_.load();
  }

  void HandleWebReadyTimeout() {
    if (!hostReadySent_) StartNativeFallback();
  }

  void HandleUiEvent(std::unique_ptr<UiEvent> event) {
    if (event->kind == UiEventKind::Exit) {
      DestroyWindow(window_);
      return;
    }
    JsonObject payload;
    if (event->kind == UiEventKind::Phase) {
      payload.SetNamedValue(L"phase", JsonValue::CreateStringValue(event->value));
      PostWebMessage(L"install.phase", payload);
      if (event->value == L"completed") {
        // The terminal phase is now in the UI queue and has been forwarded to
        // WebView2. Only this thread may release the close guard.
        installing_.store(false);
        demoPlaybackRunning_.store(false);
      }
      return;
    }
    if (event->kind == UiEventKind::Activity) {
      payload.SetNamedValue(L"id", JsonValue::CreateStringValue(event->value));
      payload.SetNamedValue(L"kind", JsonValue::CreateStringValue(event->category));
      payload.SetNamedValue(L"state", JsonValue::CreateStringValue(event->state));
      JsonArray objects;
      for (const auto& object : event->objects) {
        JsonObject item;
        item.SetNamedValue(L"kind", JsonValue::CreateStringValue(object.kind));
        item.SetNamedValue(L"path", JsonValue::CreateStringValue(object.path));
        if (!object.value.empty()) item.SetNamedValue(L"value", JsonValue::CreateStringValue(object.value));
        if (!object.detail.empty()) item.SetNamedValue(L"detail", JsonValue::CreateStringValue(object.detail));
        if (object.hasSize) item.SetNamedValue(L"sizeBytes", JsonValue::CreateNumberValue(static_cast<double>(object.sizeBytes)));
        objects.Append(item);
      }
      payload.SetNamedValue(L"objects", objects);
      PostWebMessage(L"install.activity", payload);
      return;
    }
    if (event->kind == UiEventKind::Artifacts) {
      JsonArray artifacts;
      for (const auto& artifact : event->artifacts) {
        JsonObject item;
        item.SetNamedValue(L"path", JsonValue::CreateStringValue(artifact.path));
        item.SetNamedValue(L"sizeBytes", JsonValue::CreateNumberValue(static_cast<double>(artifact.sizeBytes)));
        if (!artifact.key.empty()) item.SetNamedValue(L"key", JsonValue::CreateStringValue(artifact.key));
        artifacts.Append(item);
      }
      payload.SetNamedValue(L"artifacts", artifacts);
      PostWebMessage(L"install.artifacts", payload);
      return;
    }
    payload.SetNamedValue(L"code", JsonValue::CreateStringValue(event->value));
    PostWebMessage(L"install.failure", payload);
    installing_.store(false);
    demoPlaybackRunning_.store(false);
  }

 private:
  bool ConfigureWebView() {
    if (webview_ == nullptr) return false;
    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(webview_->get_Settings(&settings))) {
      settings->put_AreDefaultContextMenusEnabled(FALSE);
      settings->put_AreDevToolsEnabled(FALSE);
      settings->put_IsStatusBarEnabled(FALSE);
    }
    const HRESULT messageRegistration = webview_->add_WebMessageReceived(
      Callback<ICoreWebView2WebMessageReceivedEventHandler>(
        [this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
          LPWSTR raw = nullptr;
          if (FAILED(args->get_WebMessageAsJson(&raw)) || raw == nullptr) return S_OK;
          try {
            const JsonObject command = JsonObject::Parse(raw);
            HandleCommand(command);
          } catch (...) {
            PostFailure(L"invalid_command");
          }
          CoTaskMemFree(raw);
          return S_OK;
        }).Get(), &messageToken_);
    if (FAILED(messageRegistration)) return false;
    const HRESULT navigationRegistration = webview_->add_NavigationCompleted(
      Callback<ICoreWebView2NavigationCompletedEventHandler>(
        [this](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
          BOOL succeeded = FALSE;
          if (FAILED(args->get_IsSuccess(&succeeded)) || !succeeded) {
            StartNativeFallback();
            return S_OK;
          }
          navigationCompleted_ = true;
          if (webShellReady_) {
            CompleteWebReady();
          }
          return S_OK;
        }).Get(), &navigationToken_);
    if (FAILED(navigationRegistration)) {
      webview_->remove_WebMessageReceived(messageToken_);
      messageToken_ = {};
      return false;
    }
    return true;
  }

  void CompleteWebReady() {
    if (hostReadySent_ || fallbackStarted_) return;
    // The controller is created while the native window is hidden. WebView2
    // can retain that hidden state even after the HWND is shown, leaving a
    // fully loaded but blank surface. Make the controller visible as part of
    // the same readiness handshake, before exposing the window.
    if (controller_ != nullptr && FAILED(controller_->put_IsVisible(TRUE))) {
      StartNativeFallback();
      return;
    }
    hostReadySent_ = true;
    KillTimer(window_, kWebReadyTimerId);
    // Keep the native window hidden until WebView2 has navigated and React has
    // mounted the actual shell. This removes the white native-background flash
    // that otherwise appears before the first meaningful frame.
    ShowWindow(window_, SW_SHOW);
    UpdateWindow(window_);
    SetFocus(window_);
    if (controller_ != nullptr) controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    if (demo_) {
      PostDemoLocation();
      return;
    }
    PostInstallLocation(L"host.ready", DefaultInstallParentDirectory());
  }

  void HandleCommand(const JsonObject& command) {
    const std::wstring type = command.GetNamedString(L"type").c_str();
    if (demo_) {
      HandleDemoCommand(command, type);
      return;
    }
    if (type == L"shell.ready") {
      webShellReady_ = true;
      if (navigationCompleted_) CompleteWebReady();
      return;
    }
    if (type == L"window.close") {
      if (!IsInstalling()) DestroyWindow(window_);
      return;
    }
    if (type == L"app.open") {
      if (LaunchVerifiedApplication()) {
        // Launch submission succeeded; Electron owns the subsequent startup.
        DestroyWindow(window_);
      }
      else MessageBoxW(window_, L"无法启动已安装的 Synech，请从开始菜单打开。", kWindowTitle, MB_OK | MB_ICONERROR);
      return;
    }
    if (type == L"directory.browse") {
      if (!IsInstalling()) BrowseDirectory();
      return;
    }
    if (type == L"install.start") {
      const JsonObject payload = command.GetNamedObject(L"payload");
      std::filesystem::path parent;
      try {
        parent = std::filesystem::path(payload.GetNamedString(L"installParentPath").c_str());
      } catch (...) {
        PostFailure(L"invalid_install_parent");
        return;
      }
      const auto validation = ValidateInstallLocation(parent, RetryInstallTarget());
      if (!validation.location.has_value()) {
        PostFailure(validation.errorCode.empty() ? L"invalid_install_parent" : validation.errorCode);
        return;
      }
      const auto retryTarget = RetryInstallTarget();
      if (retryTarget.has_value() && !PathsEqual(retryTarget.value(), validation.location->target)) {
        // A retry exception belongs to one exact failed target. Choosing a new
        // parent must not carry that exception into the next install attempt.
        ClearRetryInstallTarget();
      }
      StartInstall(validation.location.value(), {
        payload.GetNamedBoolean(L"createStartMenuShortcut", true),
        payload.GetNamedBoolean(L"createDesktopShortcut", true),
      });
      return;
    }
    PostFailure(L"invalid_command");
  }

  void HandleDemoCommand(const JsonObject& command, const std::wstring& type) {
    if (type == L"shell.ready") {
      webShellReady_ = true;
      if (navigationCompleted_) CompleteWebReady();
      return;
    }
    if (type == L"window.close") {
      if (!demoPlaybackRunning_.load()) DestroyWindow(window_);
      return;
    }
    if (type == L"app.open") {
      if (!demoPlaybackRunning_.load()) DestroyWindow(window_);
      return;
    }
    if (type == L"install.start") {
      const JsonObject payload = command.GetNamedObject(L"payload");
      StartDemoInstall({
        payload.GetNamedBoolean(L"createStartMenuShortcut", true),
        payload.GetNamedBoolean(L"createDesktopShortcut", true),
      });
    }
  }

  void BrowseDirectory() {
    ComPtr<IFileDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) return;
    DWORD options = 0;
    dialog->GetOptions(&options);
    dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    dialog->SetTitle(L"选择 Synech 的上级目录");
    if (FAILED(dialog->Show(window_))) return;
    ComPtr<IShellItem> item;
    if (FAILED(dialog->GetResult(&item))) return;
    PWSTR selected = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &selected))) return;
    const std::filesystem::path selectedPath(selected);
    CoTaskMemFree(selected);
    PostInstallLocation(L"directory.selected", selectedPath);
  }

  void StartInstall(InstallLocation location, InstallOptions options) {
    if (demo_) return;
    bool expected = false;
    if (!installing_.compare_exchange_strong(expected, true)) return;
    ClearVerifiedApplication();
    PostPhase(L"preparing");
    const auto sessionRetryTarget = RetryInstallTarget();
    StartWorker([this, location = std::move(location), options, sessionRetryTarget] {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
      try {
        const auto validation = ValidateInstallLocation(location.parent, sessionRetryTarget);
        if (!validation.location.has_value() || !PathsEqual(validation.location->target, location.target)) {
          PostFailure(validation.errorCode.empty() ? L"invalid_install_parent" : validation.errorCode);
          return;
        }
        const auto installPath = location.target;
        const std::wstring extractionId = GuidString();
        std::optional<DWORD> exitCode;
        {
          const auto package = ActivityObject(L"package", L"Synech-Setup.exe");
          PostActivity(L"prepare-installer", L"package", {package});
          const ExtractedBackend backend(instance_, extractionId, [this](std::uintmax_t written, std::uintmax_t total) {
            PostActivityProgress(L"prepare-installer", L"package", {
              ActivityObject(L"package", L"Synech-Setup.exe", std::to_wstring(total), written),
            });
          });
          PostActivityCompleted(L"prepare-installer", L"package", {package});
          PostPhase(L"installing");
          PostActivity(L"install-application", L"files", {
            ActivityObject(L"directory", installPath),
          });
          // electron-builder's multiUser.nsh parses /D= itself and requires
          // the switch to be last without quotes; it preserves spaces in the
          // remainder as part of the installation path.
          const std::wstring backendArgs = L"/S /D=" + installPath.native();
          exitCode = RunInstallerProcess(backend.path(), backendArgs, installPath);
          if (exitCode.has_value() && exitCode.value() == 0) {
            PostActivityCompleted(L"install-application", L"files", {
              ActivityObject(L"directory", installPath),
            });
          }
        }
        if (!exitCode.has_value() || exitCode.value() != 0) {
          RememberRetryInstallTarget(installPath);
          PostFailure(L"backend_failed");
          return;
        }
        PostActivity(L"verify-application-files", L"verification", {
          ActivityObject(L"directory", installPath),
        });
        const auto applicationObjects = InstalledApplicationObjects(installPath);
        if (!RequiredApplicationFilesPresent(installPath)) {
          RememberRetryInstallTarget(installPath);
          PostFailure(L"installation_verification_failed");
          return;
        }
        PostActivityCompleted(L"verify-application-files", L"verification", applicationObjects);
        PostActivity(L"verify-uninstall-info", L"uninstall", {
          ActivityObject(L"directory", installPath),
        });
        const auto uninstallObjects = InstalledUninstallObjects(installPath);
        if (uninstallObjects.size() != 2) {
          RememberRetryInstallTarget(installPath);
          PostFailure(L"installation_verification_failed");
          return;
        }
        PostActivityCompleted(L"verify-uninstall-info", L"uninstall", uninstallObjects);
        PostActivity(L"sync-shortcuts", L"shortcuts");
        ApplyShortcutPreferences(options, installPath);
        PostActivityCompleted(L"sync-shortcuts", L"shortcuts", InstalledShortcutObjects(options, installPath));
        RememberVerifiedApplication(installPath / L"Synech.exe");
        ClearRetryInstallTarget();
        PostPhase(L"completed");
      } catch (...) {
        PostFailure(L"backend_failed");
      }
    });
  }

  void StartDemoInstall(InstallOptions options) {
    bool expected = false;
    if (!demoPlaybackRunning_.compare_exchange_strong(expected, true)) return;

    const std::filesystem::path installPath(kDemoInstallPath);
    PostPhase(L"preparing");
    PostActivity(L"prepare-installer", L"package", {
      ActivityObject(L"package", L"Synech-Setup.exe"),
    });
    StartWorker([this, installPath, options] {
      const auto pause = [](int milliseconds) {
        std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
      };
      pause(240);
      PostActivityProgress(L"prepare-installer", L"package", {
        ActivityObject(L"package", L"Synech-Setup.exe", L"108 MB", 108ULL * 1024ULL * 1024ULL),
      });
      pause(220);
      PostActivityCompleted(L"prepare-installer", L"package", {
        ActivityObject(L"package", L"Synech-Setup.exe"),
      });

      PostPhase(L"installing");
      PostActivity(L"install-application", L"files", {
        ActivityObject(L"directory", installPath),
      });
      const std::vector<InstallArtifact> artifacts = {
        {installPath / L"Synech.exe", 47ULL * 1024ULL * 1024ULL, installPath / L"Synech.exe"},
        {installPath / L"resources\\app.asar", 212ULL * 1024ULL * 1024ULL, installPath / L"resources\\app.asar"},
        {installPath / L"resources.pak", 6ULL * 1024ULL * 1024ULL, installPath / L"resources.pak"},
        {installPath / L"locales\\zh-CN.pak", 100ULL * 1024ULL, installPath / L"locales\\zh-CN.pak"},
        {installPath / L"ffmpeg.dll", 2ULL * 1024ULL * 1024ULL, installPath / L"ffmpeg.dll"},
        {installPath / L"icudtl.dat", 10ULL * 1024ULL * 1024ULL, installPath / L"icudtl.dat"},
      };
      std::uintmax_t written = 0;
      for (const auto& artifact : artifacts) {
        pause(160);
        written += artifact.sizeBytes;
        PostArtifacts({artifact});
        PostActivityProgress(L"install-application", L"files", {
          ActivityObject(L"directory", installPath, std::to_wstring(kDemoInstallBytes), written),
        });
      }
      PostActivityCompleted(L"install-application", L"files", {
        ActivityObject(L"directory", installPath),
      });

      pause(180);
      PostActivity(L"verify-application-files", L"verification", {
        ActivityObject(L"directory", installPath),
      });
      pause(220);
      PostActivityCompleted(L"verify-application-files", L"verification", {
        ActivityObject(L"executable", installPath / L"Synech.exe"),
        ActivityObject(L"file", installPath / L"resources\\app.asar"),
        ActivityObject(L"file", installPath / L"resources.pak"),
      });

      PostActivity(L"verify-uninstall-info", L"uninstall", {
        ActivityObject(L"directory", installPath),
      });
      pause(180);
      PostActivityCompleted(L"verify-uninstall-info", L"uninstall", {
        ActivityObject(L"registry", L"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Synech"),
        ActivityObject(L"executable", installPath / L"Uninstall Synech.exe", L"Uninstaller"),
      });

      PostActivity(L"sync-shortcuts", L"shortcuts");
      pause(150);
      PostActivityCompleted(L"sync-shortcuts", L"shortcuts", DemoShortcutObjects(options));
      PostPhase(L"completed");
    });
  }

  template <typename Function>
  void StartWorker(Function&& function) {
    if (worker_.joinable()) worker_.join();
    workerRunning_.store(true);
    try {
      worker_ = std::thread([this, task = std::forward<Function>(function)]() mutable {
        try {
          task();
        } catch (...) {
          // Individual workflows report their expected failures. This guard is
          // only for an unexpected worker exception so the UI can recover.
          PostFailure(L"backend_failed");
        }
        // The destructor joins this thread. It is therefore safe for the UI
        // thread to release its terminal guard before the wrapper returns.
        workerRunning_.store(false);
      });
    } catch (...) {
      workerRunning_.store(false);
      throw;
    }
  }

  void ClearVerifiedApplication() {
    std::lock_guard<std::mutex> lock(applicationMutex_);
    verifiedApplication_.reset();
  }

  void RememberVerifiedApplication(const std::filesystem::path& application) {
    std::lock_guard<std::mutex> lock(applicationMutex_);
    verifiedApplication_ = application;
  }

  std::optional<std::filesystem::path> RetryInstallTarget() const {
    std::lock_guard<std::mutex> lock(installLocationMutex_);
    return retryInstallTarget_;
  }

  void RememberRetryInstallTarget(const std::filesystem::path& target) {
    std::lock_guard<std::mutex> lock(installLocationMutex_);
    retryInstallTarget_ = target;
  }

  void ClearRetryInstallTarget() {
    std::lock_guard<std::mutex> lock(installLocationMutex_);
    retryInstallTarget_.reset();
  }

  bool LaunchVerifiedApplication() {
    std::optional<std::filesystem::path> application;
    {
      std::lock_guard<std::mutex> lock(applicationMutex_);
      application = verifiedApplication_;
    }
    std::error_code error;
    if (!application.has_value() || !std::filesystem::is_regular_file(application.value(), error) || error) return false;

    // Installation is already complete. The completion action only submits a
    // normal first-launch request; Electron owns the subsequent startup.
    std::wstring commandLine = QuoteArgument(application->native()) +
      L" --first-launch-after-install";
    STARTUPINFOW startup{sizeof(startup)};
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(application->c_str(), commandLine.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &process)) {
      return false;
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return true;
  }

  std::optional<DWORD> RunInstallerProcess(
    const std::filesystem::path& executable,
    const std::wstring& arguments,
    const std::filesystem::path& installPath) {
    if (demo_) return std::nullopt;
    // 建立基线必须早于启动 NSIS；否则极快的安装可能先写入文件，
    // 这些文件会被错误地当成“安装前”状态，进度和文件清单都会少算。
    const FileSnapshot baseline = CaptureInstallFiles(installPath);
    std::wstring commandLine = QuoteArgument(executable.native()) + L" " + arguments;
    STARTUPINFOW startup{sizeof(startup)};
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), commandLine.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &process)) {
      return std::nullopt;
    }
    CloseHandle(process.hThread);

    auto previous = baseline;
    std::uint64_t reportedBytes = 0;
    const auto reportObservations = [&](FileSnapshot& previousSnapshot) {
      auto current = CaptureInstallFiles(installPath);
      auto changed = ChangedInstallFiles(previousSnapshot, current);
      if (!changed.empty()) {
        for (auto& artifact : changed) artifact.key = artifact.path;
        PostArtifacts(std::move(changed));
      }
      // 只上报真实字节数：值没有变化时保持安静，不发任何事件。
      const std::uint64_t writtenBytes = WrittenBytesSince(baseline, current);
      if (writtenBytes != reportedBytes) {
        reportedBytes = writtenBytes;
        PostActivityProgress(L"install-application", L"files", {
          ActivityObject(L"directory", installPath, std::to_wstring(kRequiredInstallBytes), writtenBytes),
        });
      }
      previousSnapshot = std::move(current);
    };
    while (WaitForSingleObject(process.hProcess, kInstallObservationIntervalMs) == WAIT_TIMEOUT) {
      reportObservations(previous);
    }
    reportObservations(previous);
    DWORD exitCode = ERROR_GEN_FAILURE;
    GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hProcess);
    return exitCode;
  }

  void StartNativeFallback() {
    if (fallbackStarted_) return;
    fallbackStarted_ = true;
    KillTimer(window_, kWebReadyTimerId);
    if (demo_) {
      MessageBoxW(
        window_,
        L"调试安装器需要 WebView2。为避免写入本机，它不会回退到正式安装流程。",
        L"Synech 安装器调试",
        MB_OK | MB_ICONINFORMATION);
      PostEvent(UiEventKind::Exit, L"");
      return;
    }
    // Do not bypass the branded flow when WebView2 is unavailable. The inner
    // NSIS package has no parent-directory selector and would silently install
    // to a different location, which would violate the install ownership
    // boundary. Require the runtime and let the user retry the same package.
    MessageBoxW(
      window_,
      L"当前设备缺少 Microsoft Edge WebView2 Runtime。请先安装该运行时，然后重新运行 Synech 安装器。",
      L"无法打开 Synech 安装器",
      MB_OK | MB_ICONERROR);
    PostEvent(UiEventKind::Exit, L"");
  }

  void PostWebMessage(std::wstring_view type, const JsonObject& payload) const {
    if (webview_ == nullptr) return;
    JsonObject message;
    message.SetNamedValue(L"type", JsonValue::CreateStringValue(type));
    message.SetNamedValue(L"payload", payload);
    webview_->PostWebMessageAsJson(message.Stringify().c_str());
  }

  void PostInstallLocation(std::wstring_view type, const std::filesystem::path& installParentPath) const {
    const auto installPath = InstallTargetFor(installParentPath);
    JsonObject payload;
    payload.SetNamedValue(L"installParentPath", JsonValue::CreateStringValue(installParentPath.native()));
    payload.SetNamedValue(L"installPath", JsonValue::CreateStringValue(installPath.native()));
    payload.SetNamedValue(L"requiredBytes", JsonValue::CreateNumberValue(static_cast<double>(kRequiredInstallBytes)));
    payload.SetNamedValue(L"availableBytes", JsonValue::CreateNumberValue(static_cast<double>(AvailableBytesFor(installPath))));
    PostWebMessage(type, payload);
  }

  void PostDemoLocation() const {
    const std::filesystem::path installPath(kDemoInstallPath);
    const auto installParentPath = installPath.parent_path();
    JsonObject payload;
    payload.SetNamedValue(L"installParentPath", JsonValue::CreateStringValue(installParentPath.native()));
    payload.SetNamedValue(L"installPath", JsonValue::CreateStringValue(kDemoInstallPath));
    payload.SetNamedValue(L"requiredBytes", JsonValue::CreateNumberValue(static_cast<double>(kDemoInstallBytes)));
    payload.SetNamedValue(L"availableBytes", JsonValue::CreateNumberValue(static_cast<double>(kDemoAvailableBytes)));
    PostWebMessage(L"host.ready", payload);
  }

  static std::vector<InstallActivityObject> DemoShortcutObjects(const InstallOptions& options) {
    std::vector<InstallActivityObject> shortcuts;
    if (options.createStartMenuShortcut) {
      shortcuts.push_back(ActivityObject(
        L"shortcut",
        L"C:\\Users\\Demo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Synech.lnk",
        L"start-menu"));
    }
    if (options.createDesktopShortcut) {
      shortcuts.push_back(ActivityObject(L"shortcut", L"C:\\Users\\Demo\\Desktop\\Synech.lnk", L"desktop"));
    }
    return shortcuts;
  }

  void PostPhase(std::wstring phase) const { PostEvent(UiEventKind::Phase, std::move(phase)); }
  void PostActivity(std::wstring activity) const { PostEvent(UiEventKind::Activity, std::move(activity)); }
  void PostArtifacts(std::vector<InstallArtifact> artifacts) const {
    auto* event = new UiEvent{UiEventKind::Artifacts, L"", L"", L"", std::move(artifacts), {}};
    if (!PostMessageW(window_, kUiEventMessage, 0, reinterpret_cast<LPARAM>(event))) delete event;
  }
  void PostFailure(std::wstring code) const { PostEvent(UiEventKind::Failure, std::move(code)); }

  void PostActivity(
    std::wstring id,
    std::wstring category,
    std::vector<InstallActivityObject> objects = {}) const {
    auto* event = new UiEvent{UiEventKind::Activity, std::move(id), L"started", std::move(category), {}, std::move(objects)};
    if (!PostMessageW(window_, kUiEventMessage, 0, reinterpret_cast<LPARAM>(event))) delete event;
  }

  void PostActivityCompleted(
    std::wstring id,
    std::wstring category,
    std::vector<InstallActivityObject> objects = {}) const {
    auto* event = new UiEvent{UiEventKind::Activity, std::move(id), L"completed", std::move(category), {}, std::move(objects)};
    if (!PostMessageW(window_, kUiEventMessage, 0, reinterpret_cast<LPARAM>(event))) delete event;
  }

  void PostActivityProgress(
    std::wstring id,
    std::wstring category,
    std::vector<InstallActivityObject> objects = {}) const {
    auto* event = new UiEvent{UiEventKind::Activity, std::move(id), L"progress", std::move(category), {}, std::move(objects)};
    if (!PostMessageW(window_, kUiEventMessage, 0, reinterpret_cast<LPARAM>(event))) delete event;
  }

  void PostEvent(UiEventKind kind, std::wstring value) const {
    auto* event = new UiEvent{kind, std::move(value), L"", L"", {}, {}};
    if (!PostMessageW(window_, kUiEventMessage, 0, reinterpret_cast<LPARAM>(event))) delete event;
  }

  HINSTANCE instance_;
  HWND window_;
  bool demo_;
  std::atomic_bool installing_{false};
  bool fallbackStarted_{false};
  bool navigationCompleted_{false};
  bool webShellReady_{false};
  bool hostReadySent_{false};
  std::atomic_bool demoPlaybackRunning_{false};
  std::atomic_bool workerRunning_{false};
  std::thread worker_;
  std::mutex applicationMutex_;
  std::optional<std::filesystem::path> verifiedApplication_;
  // A target may contain partial installer files only after a failed attempt;
  // the first attempt never receives this exception.
  mutable std::mutex installLocationMutex_;
  std::optional<std::filesystem::path> retryInstallTarget_;
  ComPtr<ICoreWebView2Controller> controller_;
  ComPtr<ICoreWebView2> webview_;
  EventRegistrationToken messageToken_{};
  EventRegistrationToken navigationToken_{};
};

std::unique_ptr<InstallerShell> g_shell;

LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_SIZE:
      if (g_shell) g_shell->ResizeWebView();
      return 0;
    case WM_DPICHANGED: {
      const auto* suggested = reinterpret_cast<const RECT*>(lparam);
      SetWindowPos(window, nullptr, suggested->left, suggested->top,
        suggested->right - suggested->left, suggested->bottom - suggested->top,
        SWP_NOACTIVATE | SWP_NOZORDER);
      return 0;
    }
    case WM_CLOSE:
      if (!g_shell || !g_shell->IsInstalling()) DestroyWindow(window);
      return 0;
    case WM_TIMER:
      if (wparam == kWebReadyTimerId && g_shell) g_shell->HandleWebReadyTimeout();
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
    case WM_NCHITTEST: {
      const LRESULT hit = DefWindowProcW(window, message, wparam, lparam);
      if (hit == HTCLIENT) {
        POINT point{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
        ScreenToClient(window, &point);
        RECT client{};
        GetClientRect(window, &client);
        const UINT dpi = GetDpiForWindow(window);
        if (point.y < MulDiv(54, dpi, 96) && point.x < client.right - MulDiv(60, dpi, 96)) return HTCAPTION;
      }
      return hit;
    }
    case kUiEventMessage: {
      std::unique_ptr<UiEvent> event(reinterpret_cast<UiEvent*>(lparam));
      if (g_shell) g_shell->HandleUiEvent(std::move(event));
      return 0;
    }
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
}

HWND CreateShellWindow(HINSTANCE instance) {
  WNDCLASSEXW windowClass{sizeof(windowClass)};
  windowClass.lpfnWndProc = WindowProcedure;
  windowClass.hInstance = instance;
  windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  windowClass.lpszClassName = kInstallerWindowClass;
  if (!RegisterClassExW(&windowClass)) return nullptr;

  const UINT dpi = GetDpiForSystem();
  const int windowWidth = MulDiv(kWindowWidth, dpi, 96);
  const int windowHeight = MulDiv(kWindowHeight, dpi, 96);
  const int screenWidth = GetSystemMetrics(SM_CXSCREEN);
  const int screenHeight = GetSystemMetrics(SM_CYSCREEN);
  HWND window = CreateWindowExW(WS_EX_APPWINDOW, kInstallerWindowClass, kWindowTitle, WS_POPUP,
    (screenWidth - windowWidth) / 2, (screenHeight - windowHeight) / 2,
    windowWidth, windowHeight, nullptr, nullptr, instance, nullptr);
  if (window != nullptr) {
    const DWM_WINDOW_CORNER_PREFERENCE preference = DWMWCP_ROUNDSMALL;
    DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, &preference, sizeof(preference));
  }
  return window;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  HANDLE instanceMutex = CreateMutexW(nullptr, TRUE, kInstallerInstanceMutex);
  if (instanceMutex == nullptr) return 1;
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    // The first instance creates its native window before WebView2 has
    // mounted.  Keep that window hidden until its own ready handshake; a
    // duplicate launch must never expose the native white background.
    if (const HWND existing = FindWindowW(kInstallerWindowClass, kWindowTitle);
        existing != nullptr && IsWindowVisible(existing)) {
      ShowWindow(existing, IsIconic(existing) ? SW_RESTORE : SW_SHOW);
      SetForegroundWindow(existing);
    }
    CloseHandle(instanceMutex);
    return 0;
  }
  winrt::init_apartment(winrt::apartment_type::single_threaded);
  SweepExpiredInstallerCache();
  if (g_installerRuntimeDirectory.empty()) {
    CloseHandle(instanceMutex);
    return 1;
  }
  const HWND window = CreateShellWindow(instance);
  if (window == nullptr) {
    RemoveInstallerRuntimeDirectory();
    CloseHandle(instanceMutex);
    return 1;
  }
  const bool demo = kInstallerDemoBuild;
  g_shell = std::make_unique<InstallerShell>(instance, window, demo);
  g_shell->StartWebView();

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  g_shell.reset();
  CloseHandle(instanceMutex);
  return static_cast<int>(message.wParam);
}
