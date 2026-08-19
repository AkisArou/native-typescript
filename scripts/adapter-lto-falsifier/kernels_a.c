/* Variant A kernels: application code written against the contingency
 * adapter. The adapter lives in another translation unit; these loops are
 * what the LTO build gets to optimize across that boundary. */

#include "nt_common.h"

#include <string.h>

__attribute__((noinline)) jlong nt_kernel_a_nonescaping(JNIEnv *env,
                                                        jint iters) {
  jlong sum = 0;
  for (jint i = 0; i < iters; i++) {
    nt_failure fail = {0, 0};
    nt_handle h = nt_adp_make(env, i, &fail);
    if (fail.failed) {
      nt_failure_dispose(&fail);
      return -1;
    }
    sum += nt_adp_widget_value(env, h);
    /* Scope-exit cleanup, as the neutral machinery would schedule it. */
    nt_handle_release(env, &h);
  }
  return sum;
}

__attribute__((noinline)) jlong nt_kernel_a_stored(JNIEnv *env, jint iters) {
  enum { RING = 256 };
  nt_handle ring[RING];
  memset(ring, 0, sizeof ring);
  jlong sum = 0;
  for (jint i = 0; i < iters; i++) {
    jint slot = i & (RING - 1);
    nt_handle_release(env, &ring[slot]);
    nt_failure fail = {0, 0};
    ring[slot] = nt_adp_make(env, i, &fail);
    if (fail.failed) {
      nt_failure_dispose(&fail);
      goto fail_out;
    }
    sum += nt_adp_widget_value(env, ring[slot]);
  }
  for (jint s = 0; s < RING; s++) nt_handle_release(env, &ring[s]);
  return sum;
fail_out:
  for (jint s = 0; s < RING; s++) nt_handle_release(env, &ring[s]);
  return -1;
}

__attribute__((noinline)) jlong nt_kernel_a_fallible(JNIEnv *env, jint iters) {
  jlong sum = 0;
  for (jint i = 0; i < iters; i++) {
    nt_failure fail = {0, 0};
    jint r = nt_adp_checked_add(env, i, 1, &fail);
    if (fail.failed) {
      nt_failure_dispose(&fail);
      return -1;
    }
    sum += r;
  }
  return sum;
}

int nt_check_a_failure(JNIEnv *env) {
  nt_failure fail = {0, 0};
  (void)nt_adp_checked_add(env, 2147483647, 1, &fail);
  int ok = fail.failed && fail.message && strstr(fail.message, "overflow");
  nt_failure_dispose(&fail);
  return ok ? 0 : 1;
}
