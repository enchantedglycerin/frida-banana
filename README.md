<div align="center">

<img src="docs/assets/banana-frida-hero.svg" alt="banana-frida — stealth Frida for Android" width="100%">

<br>

![Frida 17.9.1](https://img.shields.io/badge/Frida-17.9.1-6554C0?style=for-the-badge&logo=frida&logoColor=white)
![Android arm64](https://img.shields.io/badge/Android-arm64-3DDC84?style=for-the-badge&logo=android&logoColor=101820)
![QuickJS](https://img.shields.io/badge/Runtime-QuickJS-F7DF1E?style=for-the-badge&logo=javascript&logoColor=101820)
![W^X](https://img.shields.io/badge/Memory-W%5EX-FFB703?style=for-the-badge&logoColor=101820)

**A source-level Frida 17.9.1 fork for low-footprint Android instrumentation.**

`banana-frida` removes Frida's anonymous `rwxp` footprint, gives Gum allocations ART-like names,
and replaces obvious runtime identifiers—without patching the target application's `.text` pages.

[Build](#-build-from-source) · [Use](#-use-it) · [Verify](#-verify-on-device) · [Technical notes](STEALTH_FRIDA_BUILD_RESULT.md)

</div>

> [!IMPORTANT]
> **Source only.** This repository does not ship a prebuilt `frida-server`. Build it locally with
> NDK r29, or verify a separately provided binary against the reference checksums below.

## 🍌 What makes it banana

| Patch group | What changes | What you see at runtime |
|---|---|---|
| **W^X memory** | Android reports `GUM_RWX_NONE`; Gum writes into `RW` pages and commits them as `RX`. XOM softening uses `RX`, never `RWX`. | No Frida-created writable + executable mapping. |
| **ART-like VMAs** | Gum's anonymous mappings are labeled through `PR_SET_VMA_ANON_NAME`. | `[anon:dalvik-LinearAlloc]` and `[anon:dalvik-jit-code-cache]` instead of unnamed mappings. |
| **Neutral threads** | Obvious Gum/Frida worker names are replaced at their source. | Names such as `gc-worker`, `gc-daemon`, and `gc-container`. |
| **Neutral agent memfd** | The injected agent resource is renamed consistently across creation and lookup paths. | `/memfd:art-jit-cache-64.so (deleted)` instead of `frida-agent-64.so`. |

The exact implementation is intentionally small and reviewable:

- [`stealth-frida-gum.patch`](stealth-frida-gum.patch) — memory policy, VMA labels, and scheduler thread names
- [`stealth-frida-core.patch`](stealth-frida-core.patch) — agent thread and memfd names
- [`stealth-patches-BASE-COMMITS.txt`](stealth-patches-BASE-COMMITS.txt) — pinned upstream commits

## 🧭 Design boundaries

<table>
<tr>
<td width="50%" valign="top">

### ✅ This fork does

- Preserve the Frida **17.9.1** protocol/version identity
- Force Gum's Android code path to follow **W^X**
- Rename Gum-owned anonymous regions and visible workers
- Keep the capture helper off target `.text` pages by using hardware breakpoints

</td>
<td width="50%" valign="top">

### 🚫 This fork does not

- Hide every possible Frida artifact or guarantee universal stealth
- Cover V8's JIT-generated mappings
- Bundle a server binary, Android NDK, or host tools
- Replace the need for device-specific acceptance testing

</td>
</tr>
</table>

## 🛠 Build from source

### Requirements

| Dependency | Required version |
|---|---|
| Android NDK | **r29** (`29.0.14206865` for the reference build) |
| Node.js | **20.x** |
| Meson / Ninja | Meson **1.11.2** used for the reference build |
| Host | Linux or WSL2 |

```bash
git clone --branch 17.9.1 https://github.com/enchantedglycerin/banana-frida.git
cd banana-frida

export ANDROID_NDK_ROOT="$HOME/android-ndk-r29"
export PATH="$HOME/opt/node/bin:$HOME/.local/bin:$PATH"

./configure --host=android-arm64
deps/toolchain-linux-x86_64/bin/ninja \
  -C build \
  subprojects/frida-core/server/frida-server
```

The stripped server is produced at:

```text
build/subprojects/frida-core/server/frida-server
```

### Reference build

| Artifact | Size | SHA-256 |
|---|---:|---|
| `stealth-frida-server-17.9.1-android-arm64` | 53,091,240 bytes | `fa087dd74f5b09a24276ae3f5f6d454716c17efaa34a46deca92bb77c34f2f32` |
| `stealth-frida-server-17.9.1-android-arm64.gz` | 23,351,182 bytes | `a8083db53db883200a9dce331a3a9275d482d7992ff3bf2ae35a443b76282c64` |

Matching the first hash means your output is byte-identical to the reference build. Until a
fresh flattened-clone build reproduces it, treat this checksum as a reference—not a promise.

## 🚀 Use it

The host-side Frida packages must match the server:

```bash
python -m pip install "frida==17.9.1" frida-tools
```

Push and start your locally built server under a neutral filename and a non-default port:

```bash
adb push build/subprojects/frida-core/server/frida-server /data/local/tmp/.gc-srv
adb shell su -c 'chmod 755 /data/local/tmp/.gc-srv'
adb shell su -c '/data/local/tmp/.gc-srv -l 127.0.0.1:17173 &'
```

Run scripts with **QuickJS**:

```bash
# Minimal presence / mapping probe
frida -H 127.0.0.1:17173 --runtime=qjs \
  -f com.example.app \
  -l presence_only.js

# Project-specific capture helper (configured for libgame.so / OFF_CIPHER)
frida -H 127.0.0.1:17173 --runtime=qjs \
  -f com.devsisters.crg \
  -l capture_hwbp.js
```

`capture_hwbp.js` is an example harness, not a universal tracer. For another target, update the
module name, `OFF_CIPHER`, calling convention, and captured argument sizes before using it.

> [!WARNING]
> Do not use `--runtime=v8` for the low-footprint configuration. V8 has its own JIT allocator,
> outside the Gum changes in this fork, and may create executable mappings that defeat the W^X
> objective.

## 🔍 Verify on device

Never infer success from one filtered grep. Compare against a clean baseline and count **all**
writable + executable mappings:

```bash
PID="$(pidof com.example.app)"

# Every writable + executable mapping, named or unnamed
awk '$2 ~ /rwx/ { print }' "/proc/$PID/maps"

# Injected agent mapping
grep 'art-jit-cache' "/proc/$PID/maps"

# Visible thread names
for COMM in /proc/"$PID"/task/*/comm; do cat "$COMM"; done
```

A proper acceptance run should confirm:

1. The post-injection `rwx` count equals the clean application baseline.
2. Gum code mappings are `r-xp`, not `rwxp`.
3. The agent memfd and thread names match the neutral names above.
4. The target remains stable for at least 60 seconds under the intended workload.
5. `capture_hwbp.js` reaches `[CAPTURED]` without a target `.text` modification.

See [`STEALTH_FRIDA_BUILD_RESULT.md`](STEALTH_FRIDA_BUILD_RESULT.md) for the full device procedure,
failure interpretation, and rebuild notes.

## 🗂 Repository map

```text
banana-frida/
├── capture_hwbp.js                  # resilient hardware-breakpoint capture helper
├── presence_only.js                 # minimal injection / mapping probe
├── stealth-frida-gum.patch          # W^X, VMA labels, scheduler rename
├── stealth-frida-core.patch         # agent thread and memfd rename
├── stealth-patches-BASE-COMMITS.txt # pinned upstream bases
├── STEALTH_FRIDA_BUILD_RESULT.md    # deep technical and acceptance notes
├── subprojects/                     # vendored Frida 17.9.1 source tree
└── releng/                          # vendored Frida build tooling
```

## ⚖️ Scope and responsibility

This project is intended for authorized research, interoperability, debugging, and analysis on
software and devices you are permitted to inspect. You are responsible for complying with the
rules and laws that apply to your environment.

## 🌱 Credits

Built on [Frida](https://frida.re/) and the work of its contributors. See
[`CONTRIBUTORS.md`](CONTRIBUTORS.md) for repository credits.

Licensed under the **wxWindows Library Licence 3.1**; see [`COPYING`](COPYING).

<div align="center">

**Stay curious. Keep it yellow. 🍌**

</div>
