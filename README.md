# banana-frida

> A stealth build of [Frida](https://github.com/frida/frida) **17.9.1** for Android (arm64)
> that instruments processes without leaving the writable-and-executable (`rwxp`) memory
> footprint that map-scanning anti-tamper systems detect.

![Based on Frida 17.9.1](https://img.shields.io/badge/Frida-17.9.1-blue)
![Platform android-arm64](https://img.shields.io/badge/platform-android--arm64-3DDC84)
![License wxWindows 3.1](https://img.shields.io/badge/license-wxWindows%203.1-lightgrey)

## Overview

Frida's Gum engine allocates writable-executable pages for its runtime, which appear in a
process's `/proc/self/maps` as unnamed `rwxp` anonymous regions. On Android — where ART
enforces W^X and never produces such pages — that region is a reliable fingerprint of an
injected agent, and some applications scan for it to detect instrumentation.

**banana-frida** is a source fork of Frida 17.9.1 that removes this footprint while leaving the
rest of Frida's behaviour and API unchanged. It is intended for security research, reverse
engineering, and interoperability work on devices and applications you own or are authorised to
test.

## What's different from upstream

| Area | Change |
| --- | --- |
| **W^X code allocation** | `gum_query_rwx_support()` returns `GUM_RWX_NONE` on Android, so Gum allocates `RW` then `mprotect`s to `RX` and never creates a writable-executable page. `gum_ensure_code_readable()` softens execute-only pages to `RX` rather than `RWX`. |
| **Named anonymous regions** | Gum's anonymous mappings are labelled via `PR_SET_VMA_ANON_NAME` as `[anon:dalvik-LinearAlloc]` / `[anon:dalvik-jit-code-cache]`, so they resemble ART allocations instead of unnamed anonymous memory. |
| **Thread names** | Runtime-visible thread names are neutralised: `gum-js-loop` → `gc-worker`, GLib pool workers, `frida-eternal-agent` → `gc-daemon`, `frida-agent-container` → `gc-container`. |
| **Injected agent** | The agent's memfd is renamed `frida-agent-<arch>.so` → `art-jit-cache-<arch>.so`, changing its `/proc/self/maps` name inside the target. |

The complete rationale, measurements, and on-device verification procedure are in
[`STEALTH_FRIDA_BUILD_RESULT.md`](STEALTH_FRIDA_BUILD_RESULT.md). The exact diffs are also
provided as `stealth-frida-gum.patch` and `stealth-frida-core.patch` (with their base commits
in `stealth-patches-BASE-COMMITS.txt`) and apply cleanly onto an unmodified Frida 17.9.1
checkout.

## Requirements

- Android NDK **r29** (Frida pins the major version to 29; other releases are rejected)
- Node.js 20+
- Meson and Ninja
- A Linux build host (WSL is fine)

## Building

```sh
export ANDROID_NDK_ROOT=/path/to/android-ndk-r29
./configure --host=android-arm64
ninja -C build subprojects/frida-core/server/frida-server
```

The stripped server is written to `build/subprojects/frida-core/server/frida-server`. The
prebuilt binary is **not** committed to this repository; build it from source, or verify a
binary you were given against the SHA-256 values in the build write-up (the build is
deterministic and reproduces byte-for-byte).

## Usage

- The host `frida-tools` version must be **17.9.1** to match the server.
- Run scripts with `--runtime=qjs` (the default). Do **not** use `--runtime=v8`: V8's JIT
  allocates executable pages outside Gum and would reintroduce an `rwx` region.
- Two helper scripts are included:
  - `presence_only.js` — a minimal probe for confirming the `rwx`-region baseline.
  - `capture_hwbp.js` — a hardware-breakpoint capture harness that reads function arguments
    without patching the target's code.

## Relationship to upstream

This is a flattened snapshot fork: Frida's Git submodules have been vendored into a single tree
so the repository clones and builds without submodule initialisation. It is tagged `17.9.1`, so
`releng/frida_version.py` and the resulting binaries report the correct version. To track
upstream instead, apply the two patch files to a fresh recursive clone of
[frida/frida](https://github.com/frida/frida) at tag `17.9.1`.

## License

Frida and this fork are distributed under the wxWindows Library Licence, Version 3.1. See
[`COPYING`](COPYING). Upstream Frida is © its respective authors.

## Contributors

See [`CONTRIBUTORS.md`](CONTRIBUTORS.md).
