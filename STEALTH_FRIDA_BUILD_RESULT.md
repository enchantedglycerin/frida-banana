# Stealth frida-server 17.9.1 (android-arm64) — build result

Built from **frida 17.9.1** source (tag `17.9.1`, submodules pinned) in WSL Ubuntu 26.04
with **NDK r29** (29.0.14206865), frida SDK/toolchain `20260311`, meson 1.11.2.

## Deliverable

| file | size | sha256 |
|------|------|--------|
| `stealth-frida-server-17.9.1-android-arm64`     | 53,091,240 | `fa087dd74f5b09a24276ae3f5f6d454716c17efaa34a46deca92bb77c34f2f32` |
| `stealth-frida-server-17.9.1-android-arm64.gz`  | 23,351,182 | `a8083db53db883200a9dce331a3a9275d482d7992ff3bf2ae35a443b76282c64` |

Source patches (apply to a clean checkout — see rebuild recipe):
`stealth-frida-gum.patch`, `stealth-frida-core.patch`, `stealth-patches-BASE-COMMITS.txt`.

ELF64 / AArch64 / PIE; no static symbol table (`.symtab` stripped), `.dynsym` retained
(≈266 entries — required for a PIE, cannot be removed). Host `frida-tools` **must be 17.9.1**
(already is). Runtime: **use QuickJS** (default) — do **NOT** pass `--runtime=v8` (V8's JIT
allocates its own executable pages outside frida-gum, which would reintroduce an rwx tell my
patch does not cover). QuickJS is a pure interpreter → the only agent-generated code is
gum's Interceptor trampolines, which are now W^X.

## Exactly what was patched (for reproducibility on future frida versions)

**PRIMARY — kill the `rwxp` anon region (the proven ~16 s detection trigger):**
1. `subprojects/frida-gum/gum/gummemory.c` → **`gum_query_rwx_support()`**: return
   `GUM_RWX_NONE` on `HAVE_ANDROID`. This makes `gum_query_is_rwx_supported()` false
   everywhere, so gum's code allocator, interceptor and stalker take the **W^X path**
   (allocate `RW`, write, `mprotect` → `RX`) instead of the `rwx` fast path. On Android
   `gum_code_segment_is_supported()` and `gum_memory_can_remap_writable()` are both stubs
   returning `FALSE`, so the W^X path used is the `RW`→`mprotect(RX)` flow — the same,
   well-tested path frida uses on non-jailbroken iOS / Apple Silicon. Result: gum code shows
   as `r-xp`, never `rwxp`.
2. `subprojects/frida-gum/gum/gummemory.c` → **`gum_ensure_code_readable()`**: changed the
   XOM (execute-only, API≥29) softening `mprotect` from `GUM_PAGE_RWX` → **`GUM_PAGE_RX`**.
   The `W` was unnecessary (actual patching is done separately by
   `gum_memory_patch_code_pages()`, which flips the page `RW` under thread-suspension then
   back to `RX`). Removes a *file-backed* rwx region on target modules (e.g. libc) that would
   otherwise appear whenever gum relocates code.

**Name every gum anonymous region so it isn't an unnamed anon mapping (`PR_SET_VMA_ANON_NAME`):**
3. `subprojects/frida-gum/gum/backend-posix/gummemory-posix.c` → added
   `gum_android_label_pages()` and call it at the single mmap chokepoint
   **`gum_allocate_page_aligned()`**. Every gum anon region is labelled
   `[anon:dalvik-LinearAlloc]` (or `[anon:dalvik-jit-code-cache]` if allocated `PROT_EXEC`).
   Names are string literals (permanent `.rodata`) because older Android kernels store the
   name pointer and read it lazily when building `/proc/self/maps`.
4. `subprojects/frida-gum/gum/backend-linux/gummemory-linux.c` → in **`gum_try_mprotect()`**,
   when the new protection includes `PROT_EXEC`, label the region
   `[anon:dalvik-jit-code-cache]`. This catches gum's `RW`→`RX` code-commit transition so
   committed trampolines end up correctly named as an ART JIT code cache. (Anon-naming is a
   no-op on file-backed VMAs, so it never touches the target's own modules.)

**Rename runtime-visible thread comm names (`/proc/<pid>/task/*/comm`), source-level only:**
5. `subprojects/frida-gum/bindings/gumjs/gumscriptscheduler.c` →
   `g_thread_new("gum-js-loop", …)` renamed to **`"gc-worker"`**; added
   `prctl(PR_SET_NAME,"gc-worker")` at the top of `gum_script_scheduler_perform_pool_job()`
   to override GLib's `pool-<prgname>` worker names.
6. `subprojects/frida-core/lib/agent/agent.vala` → injected agent's persistent main thread
   `"frida-eternal-agent"` (×3) → **`"gc-daemon"`**; `"frida-agent-emulated"` →
   `"gc-daemon-emu"`.
7. `subprojects/frida-core/src/agent-container.vala` → `"frida-agent-container"` →
   `"gc-container"`.
   *(`gmain`/`gdbus` deliberately left alone — generic GLib names present in many apps;
   renaming breaks GDBus which frida's protocol needs.)*

**Rename the injected agent's memfd (its `/proc/self/maps` region name in the target):**
8. `subprojects/frida-core/src/linux/linux-host-session.vala` → agent
   `PathTemplate("frida-agent-<arch>.so")` → **`"art-jit-cache-<arch>.so"`**, plus the two
   emulated `AgentResource` names and their lookups. The injected agent now maps as
   `/memfd:art-jit-cache-64.so (deleted)` instead of the obvious `frida-agent` name.

### Known, detection-irrelevant residuals (intentionally NOT chased)
- The embedded agent blob's manifest string `"frida-agent-arm64.so"` and the agent's
  `DT_SONAME` `libfrida-agent-raw.so` still exist. These live in **frida-server's own
  address space** (a separate root process CRK cannot read) and in the agent's ELF
  `.dynamic` (only reachable by dumping+parsing the agent ELF from target memory). The
  measured detector scans **`/proc/self/maps` region names + `comm` + the rwx invariant** —
  proven by the fact that Florida (which scrubs *all* such strings) was still detected at
  16 s purely from the rwx region. So agent-content strings are not this AC's vector.

## Verify on the device (do this before trusting it)

Count *all* rwx (named, unnamed, file-backed) — an unnamed-only grep like
`rwxp 00000000 00:00 0 *$` can **falsely pass**, because the anon-VMA-name patch would label
a leftover gum rwx page `[anon:dalvik-jit-code-cache]` and hide it from that regex.

> Command context — **[host]** = your PC (PowerShell: `adb` / `frida`);
> **[device]** = a root shell on the phone, i.e. run `adb shell` then `su` first (the
> `PID=$(pidof …)` / `awk` lines are Bash and run **on the device**, not in PowerShell).

**Step 0 — clean baseline, NO frida.** Launch CRK normally (frida-server NOT running),
reach the loading screen, then — **[device]** (`adb shell` → `su`):
```
PID=$(pidof com.devsisters.crg)
awk '$2 ~ /rwx/' /proc/$PID/maps | wc -l      # BASELINE, e.g. 1 (CRK's own IL2CPP page)
awk '$2 ~ /rwx/ {print}' /proc/$PID/maps      # note the exact rwx line(s)
am force-stop com.devsisters.crg
```

**Step 1 — start the stealth server** (rename on disk, non-default port).
**[host]:**
```
adb push stealth-frida-server-17.9.1-android-arm64 /data/local/tmp/.gc-srv
adb shell su -c 'chmod 755 /data/local/tmp/.gc-srv && /data/local/tmp/.gc-srv -l 127.0.0.1:17173 &'
```

**Step 2 — attach presence-only (QuickJS), compare rwx to the Step 0 baseline.**
**[host]:**
```
frida -H 127.0.0.1:17173 --runtime=qjs -f com.devsisters.crg -l frida/presence_only.js
```
**[device]** (new `adb shell` → `su`, while the frida session is live):
```
PID=$(pidof com.devsisters.crg)
awk '$2 ~ /rwx/' /proc/$PID/maps | wc -l                # MUST EQUAL the Step 0 baseline
awk '$2 ~ /rwx/ {print}' /proc/$PID/maps                # inspect: no gum/agent lines
grep -cE 'r-xp 00000000 00:00 0 *$' /proc/$PID/maps     # unnamed anon exec ~0 (all gum dalvik-named)
grep -c art-jit-cache /proc/$PID/maps                   # injected agent present, ART-named
```
If the count is **above** the baseline, read the extra rwx mapping line(s) to find the cause —
the W^X patch not taking effect, the script running on V8 (its JIT allocates its own
executable pages; re-check `--runtime=qjs`), or another injected component. The mapping text
(name/path/perms) identifies which.

**Step 3 — survival.** CRK must survive > 60 s attached, no `ea.exbax` in logcat —
**[host]:** `adb logcat | grep -i exbax` (expect no hits).

**Step 4 — capture** (hardware-breakpoint, no `.text` patch → no CRC trip).
First **end the Step 2/3 session**: it spawned CRK with `-f`, so quit that frida CLI
(`q` + Enter, or Ctrl-C) — that kills its CRK instance — then confirm CRK is gone so Step 4
spawns a clean process. **[host]:**
```
adb shell su -c 'am force-stop com.devsisters.crg'    # ensure no stale CRK/agent is left
frida -H 127.0.0.1:17173 --runtime=qjs -f com.devsisters.crg -l frida/capture_hwbp.js
```
Confirm `[CAPTURED] key=… nonce=… din=… dout=…` during asset load. keystream = din XOR dout;
that + `djb_format` notes finish the offline decryptor for the 214 base-APK `.djb` files.
(The stealth server from Step 1 stays running throughout — only the client sessions change.)

## Rebuild recipe (WSL) — reproducible from a clean checkout + the exported patches
Base commits (also in `stealth-patches-BASE-COMMITS.txt`):
frida `31d0d9a6f1b0b8abcccfc2ca10907381e97851f8`, frida-gum
`8bf4e039daafb689849267402a50a42f24e33868`, frida-core
`a62376a3d6319fcdbc8c6b81b6879634be71929b` (all == tag 17.9.1).
```
git clone --recurse-submodules --branch 17.9.1 https://github.com/frida/frida.git
cd frida
git -C subprojects/frida-gum  apply /path/to/stealth-frida-gum.patch
git -C subprojects/frida-core apply /path/to/stealth-frida-core.patch
export ANDROID_NDK_ROOT=~/android-ndk-r29           # NDK r29 EXACTLY (frida pins major==29)
export PATH=~/opt/node/bin:~/.local/bin:$PATH        # node 20, pip meson+ninja
./configure --host=android-arm64
deps/toolchain-linux-x86_64/bin/ninja -C build subprojects/frida-core/server/frida-server
# output: build/subprojects/frida-core/server/frida-server  (already stripped)
```
The plain `./configure && ninja` WITHOUT applying the two patches produces upstream Frida,
not this binary.
