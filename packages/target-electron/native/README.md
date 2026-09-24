# Native addon: user presence

`os-auth` asks the operating system to confirm that the person in front of the
device is the account owner, for actions that should not be triggerable from an
unattended machine.

| platform | mechanism                                                                      |
| -------- | ------------------------------------------------------------------------------ |
| macOS    | LocalAuthentication, `deviceOwnerAuthentication`: Touch ID or account password |
| Windows  | Windows Hello via `IUserConsentVerifierInterop` (needs the window handle)      |
| others   | not implemented, every call reports `unsupported`                              |

## What it does not do

The result is a status this process decides on and passes through IPC. Anyone
who can modify the installed app can skip the check, so this is a barrier
against someone using an unlocked device, not a protection against software
running as the user. Protecting data against that would mean deriving a key
from the authentication (Keychain with `kSecAccessControlUserPresence`,
`KeyCredentialManager` on Windows) instead of returning a status.

Callers have to handle `unsupported` with their own confirmation, otherwise the
action is unreachable on Linux and in the browser target.

## Building

```sh
cd packages/target-electron
pnpm native:build                     # host platform
pnpm native:build x86_64-apple-darwin # or any target triple from bin/build-native.mjs
```

The result goes to `packages/target-electron/native-dist/` and is not checked
in. `pnpm build` does not build it, so a checkout without a Rust toolchain
works as before - the addon is simply missing and user presence reports
`unsupported`.

macOS builds both architectures and merges them with `lipo` into a single
`os-auth.darwin.node`, because the release build is a universal app and
electron-builder merges the two per-architecture bundles.

The CI builds the addon in the macOS and Windows packaging jobs only.

`electron-builder` unpacks `native-dist/` from the asar archive (native code
can not be loaded from inside an archive) and drops the other platforms'
binaries, see `build/gen-electron-builder-config.js`. Packaging for macOS or
Windows fails if the addon is missing, see `assertUserPresenceAddonIsPackaged`
in `build/afterPackHook.mjs`; set `SKIP_USER_PRESENCE_ADDON` to package without
it anyway, for example when building for a platform whose addon can not be
compiled on the current machine.

### Prerequisites on Windows

All of this has to happen on Windows itself, not in WSL. There `process.platform`
is `linux`, so the build produces the Linux stub and the app never asks for
anything - besides, Electron needs a pile of Linux desktop libraries there
(`libasound2`, `libnss3`, `libnspr4`, `libgtk-3-0` ..., the `deb.depends` list
in `build/gen-electron-builder-config.js`) that a fresh WSL image does not have.

- **Rust**, installed with [rustup](https://rustup.rs). The default toolchain
  there is `stable-x86_64-pc-windows-msvc`, which is the one to use.

  ```cmd
  winget install -e --id Rustlang.Rustup
  ```

  Without winget, download `rustup-init.exe` from <https://rustup.rs> (direct
  links: <https://win.rustup.rs/x86_64>, <https://win.rustup.rs/aarch64>) and
  run it once. It is a small bootstrapper, not something that stays around;
  afterwards `rustup` and `cargo` live in `%USERPROFILE%\.cargo\bin`. It also
  offers to install the Visual Studio C++ prerequisites below when they are
  missing, which saves doing that separately.

- **Visual Studio Build Tools** with the "Desktop development with C++"
  workload, which provides the linker and the Windows SDK. Without it the build
  fails with `linker 'link.exe' not found` (`cargo check` still works, it does
  not link). A full Visual Studio with that workload does the job too, and so
  does a version newer than 2022.

  In an administrator prompt:

  ```cmd
  winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```

  Alternatively download "Build Tools for Visual Studio" from
  <https://visualstudio.microsoft.com/downloads/> and tick that workload in the
  installer.

  The workload takes several gigabytes. A component list installs a lot less -
  just compilers, runtimes and the SDK. Put this in a `.vsconfig` file:

  ```json
  {
    "version": "1.0",
    "components": [
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "Microsoft.VisualStudio.Component.Windows11SDK.26100"
    ]
  }
  ```

  ```cmd
  winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --config .\.vsconfig"
  ```

Both are preinstalled on the `windows-latest` CI runners.

No reboot and no "Developer Command Prompt" are needed afterwards, `rustc`
finds the MSVC installation on its own. A fresh terminal is enough:

```cmd
cd packages\target-electron
pnpm native:build
```

A line like `wrote ...\native-dist\os-auth.win32-x64.node` means everything is
in place.

On Windows ARM the build script picks `aarch64-pc-windows-msvc` and the loader
looks for `os-auth.win32-arm64.node`; that architecture is not built by the CI,
because no ARM artifacts are released.

### Prerequisites on macOS

Rust via rustup plus the Xcode command line tools. For a universal binary both
targets are needed:

```sh
rustup target add x86_64-apple-darwin aarch64-apple-darwin
```

## Trying it out

Windows Hello has to be set up for the account (Settings -> Accounts -> Sign-in
options -> PIN), otherwise `UserConsentVerifier` reports `NotConfiguredForUser`,
the addon returns `unsupported` and the guarded action just continues. In a
virtual machine this needs a vTPM. On macOS a device password is enough, Touch
ID is used when present.

```sh
cd packages/target-electron
pnpm native:build
pnpm build
pnpm start
```

Then open Settings -> "Add second device" and press continue. The system prompt
has to appear, and on Windows it has to be modal to the Delta Chat window - that
is what the window handle is for.

The main process log tells apart the cases where no prompt appears:

| log message                                                | meaning                                   |
| ---------------------------------------------------------- | ----------------------------------------- |
| `no addon for this platform, user presence is unavailable` | `pnpm native:build` was not run           |
| `user presence is not supported, continuing unguarded`     | addon loaded, but no Hello / no passcode  |
| `missing window handle`                                    | the window handle did not reach the addon |

Whether the addon loads at all can be checked without the app, but the prompt
itself can not - without a window handle it answers `missing window handle`:

```sh
node -e "require('./native-dist/os-auth.win32-x64.node').isUserPresenceSupported().then(console.log)"
```

## Checking the platform code without those platforms

The platform specific code compiles on any host, only linking needs the real
SDKs:

```sh
cd native/os-auth
cargo check --target aarch64-apple-darwin
cargo check --target x86_64-pc-windows-msvc
```
