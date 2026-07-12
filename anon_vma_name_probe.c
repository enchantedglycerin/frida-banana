/*
 * anon_vma_name_probe.c — confirm PR_SET_VMA_ANON_NAME works on this kernel,
 * independent of Frida. Mirrors exactly what the stealth build does: map a
 * private-anonymous page and name it with a .rodata string literal, then look
 * for the resulting [anon:...] label in /proc/self/maps.
 *
 * Build (android-arm64, NDK r29):
 *   $NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android21-clang \
 *       -O2 -static-libgcc anon_vma_name_probe.c -o anon_vma_name_probe
 * Run on device:
 *   adb push anon_vma_name_probe /data/local/tmp/ && adb shell /data/local/tmp/anon_vma_name_probe
 *
 * Exit 0 = PASS (kernel names the region); 1 = named region not found; 2 = setup error.
 */
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <unistd.h>

#ifndef PR_SET_VMA
# define PR_SET_VMA 0x53564d41
#endif
#ifndef PR_SET_VMA_ANON_NAME
# define PR_SET_VMA_ANON_NAME 0
#endif

/* Permanent .rodata literal — required: the 4.19 Android backport stores this
 * userspace pointer and reads it lazily when /proc/maps is generated. */
static const char kProbeName[] = "dalvik-anonvma-probe";

static int scan_maps(unsigned long addr, const char *needle)
{
  FILE *f = fopen("/proc/self/maps", "r");
  if (f == NULL) { perror("open /proc/self/maps"); return -1; }

  char line[512];
  int found = 0;
  while (fgets(line, sizeof line, f) != NULL)
  {
    unsigned long start = 0, end = 0;
    if (sscanf(line, "%lx-%lx", &start, &end) == 2 &&
        addr >= start && addr < end)
    {
      printf("  region: %s", line);
      if (strstr(line, needle) != NULL)
        found = 1;
    }
  }
  fclose(f);
  return found;
}

int main(void)
{
  const size_t len = 4096;

  /* 1) private-anonymous RW page, exactly like a gum data allocation. */
  void *rw = mmap(NULL, len, PROT_READ | PROT_WRITE,
                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (rw == MAP_FAILED) { perror("mmap rw"); return 2; }

  int r_rw = prctl(PR_SET_VMA, PR_SET_VMA_ANON_NAME,
                   (unsigned long) rw, len, (unsigned long) kProbeName);
  printf("[rw ] prctl(PR_SET_VMA_ANON_NAME) = %d%s\n",
         r_rw, r_rw != 0 ? strerror(errno) : "");
  int found_rw = scan_maps((unsigned long) rw, kProbeName);

  /* 2) name it, then flip to r-x — mirrors gum's committed code region. */
  void *rx = mmap(NULL, len, PROT_READ | PROT_WRITE,
                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (rx == MAP_FAILED) { perror("mmap rx"); return 2; }
  prctl(PR_SET_VMA, PR_SET_VMA_ANON_NAME,
        (unsigned long) rx, len, (unsigned long) kProbeName);
  if (mprotect(rx, len, PROT_READ | PROT_EXEC) != 0) perror("mprotect rx");
  int found_rx = scan_maps((unsigned long) rx, kProbeName);

  printf("\n");
  if (found_rw == 1 && found_rx == 1)
  {
    printf("RESULT: PASS — kernel supports PR_SET_VMA_ANON_NAME; "
           "regions show [anon:%s] (rw and r-x).\n", kProbeName);
    return 0;
  }

  printf("RESULT: FAIL — named region not found (rw=%d rx=%d, prctl=%d). "
         "Anon-VMA naming unsupported or misused on this kernel.\n",
         found_rw, found_rx, r_rw);
  return 1;
}
