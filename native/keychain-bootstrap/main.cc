#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <cstdlib>
#include <pwd.h>
#include <string>
#include <unistd.h>

// Node-API is ABI-stable. Declaring the three symbols this tiny bridge uses
// avoids downloading Node/Electron headers during an otherwise offline build.
struct napi_env__;
struct napi_value__;
using napi_env = napi_env__*;
using napi_value = napi_value__*;
using napi_status = int32_t;
extern "C" napi_status napi_create_int32(napi_env, int32_t, napi_value*);
extern "C" napi_status napi_set_named_property(napi_env, napi_value, const char*, napi_value);

namespace {
enum class RepairStatus : int32_t {
  healthy = 0,
  repaired = 1,
  unavailable = 2,
  failed = 3
};

struct RepairResult {
  RepairStatus status;
  OSStatus os_status;
};

bool contains(CFArrayRef keychains, SecKeychainRef candidate) {
  const CFIndex count = CFArrayGetCount(keychains);
  for (CFIndex index = 0; index < count; ++index) {
    const auto item = static_cast<SecKeychainRef>(
        const_cast<void*>(CFArrayGetValueAtIndex(keychains, index)));
    if (CFEqual(item, candidate)) return true;
  }
  return false;
}

RepairResult repair_missing_default_keychain() {
  SecKeychainRef current_default = nullptr;
  OSStatus status = SecKeychainCopyDomainDefault(
      kSecPreferencesDomainUser,
      &current_default);
  if (status == errSecSuccess && current_default != nullptr) {
    CFRelease(current_default);
    return {RepairStatus::healthy, errSecSuccess};
  }
  if (status != errSecNoDefaultKeychain) {
    return {RepairStatus::unavailable, status};
  }

  const passwd* account = getpwuid(getuid());
  const char* home = account == nullptr ? nullptr : account->pw_dir;
  if (home == nullptr || home[0] == '\0') {
    return {RepairStatus::unavailable, errSecNoSuchKeychain};
  }
  const std::string login_path =
      std::string(home) + "/Library/Keychains/login.keychain-db";

  SecKeychainRef login = nullptr;
  status = SecKeychainOpen(login_path.c_str(), &login);
  if (status != errSecSuccess || login == nullptr) {
    return {RepairStatus::unavailable, status};
  }

  CFArrayRef existing = nullptr;
  const OSStatus copy_status = SecKeychainCopyDomainSearchList(
      kSecPreferencesDomainUser,
      &existing);
  CFMutableArrayRef repaired = CFArrayCreateMutable(
      kCFAllocatorDefault,
      0,
      &kCFTypeArrayCallBacks);
  if (copy_status == errSecSuccess && existing != nullptr) {
    CFArrayAppendArray(
        repaired,
        existing,
        CFRangeMake(0, CFArrayGetCount(existing)));
  }
  if (!contains(repaired, login)) CFArrayAppendValue(repaired, login);

  status = SecKeychainSetDomainSearchList(kSecPreferencesDomainUser, repaired);
  if (status == errSecSuccess) {
    status = SecKeychainSetDomainDefault(kSecPreferencesDomainUser, login);
  }

  if (existing != nullptr) CFRelease(existing);
  CFRelease(repaired);
  CFRelease(login);
  return status == errSecSuccess
      ? RepairResult{RepairStatus::repaired, errSecSuccess}
      : RepairResult{RepairStatus::failed, status};
}

void set_int(napi_env env, napi_value exports, const char* name, int32_t value) {
  napi_value property = nullptr;
  if (napi_create_int32(env, value, &property) == 0 && property != nullptr) {
    napi_set_named_property(env, exports, name, property);
  }
}
}  // namespace

extern "C" __attribute__((visibility("default"))) napi_value
napi_register_module_v1(napi_env env, napi_value exports) {
  const RepairResult result = repair_missing_default_keychain();
  set_int(env, exports, "status", static_cast<int32_t>(result.status));
  set_int(env, exports, "osStatus", result.os_status);
  return exports;
}
