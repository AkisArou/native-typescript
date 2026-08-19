/* Variant B: the code an escape- and liveness-aware compiler would emit for
 * the same three programs. No per-call frame, no promotion unless the value
 * actually escapes, failure detection inline with the detailed capture
 * outlined on the cold edge.
 *
 * B is written as realistic compiler output, not hand-tuned assembly: each
 * JNI operation it performs is one the boundary contract already names. */

#include "nt_common.h"

#include <string.h>

/* The cold outlined capture a compiler would emit on the unwind edge. Same
 * protocol as the adapter's: capture, clear pending, own the message. */
__attribute__((noinline, cold)) static void nt_cold_capture(JNIEnv *env,
                                                            nt_failure *fail) {
  fail->failed = 1;
  fail->message = NULL;
  if ((*env)->PushLocalFrame(env, 8) < 0) {
    (*env)->ExceptionClear(env);
    return;
  }
  jthrowable thrown = (*env)->ExceptionOccurred(env);
  (*env)->ExceptionClear(env);
  if (thrown) {
    jstring msg =
        (jstring)(*env)->CallObjectMethod(env, thrown, g_mid_get_message);
    if ((*env)->ExceptionCheck(env)) {
      (*env)->ExceptionClear(env);
    } else if (msg) {
      const char *utf = (*env)->GetStringUTFChars(env, msg, NULL);
      if (utf) {
        fail->message = strdup(utf);
        (*env)->ReleaseStringUTFChars(env, msg, utf);
      }
    }
  }
  (*env)->PopLocalFrame(env, NULL);
}

/* Non-escaping: liveness ends inside the iteration, so the compiler emits a
 * single DeleteLocalRef at last use. No frame, no global reference. */
__attribute__((noinline)) jlong nt_kernel_b_nonescaping(JNIEnv *env,
                                                        jint iters) {
  jlong sum = 0;
  for (jint i = 0; i < iters; i++) {
    jobject local =
        (*env)->CallStaticObjectMethod(env, g_cls_falsifier, g_mid_make, i);
    if (__builtin_expect((*env)->ExceptionCheck(env), 0)) {
      nt_failure fail = {0, 0};
      nt_cold_capture(env, &fail);
      nt_failure_dispose(&fail);
      return -1;
    }
    sum += (*env)->GetIntField(env, local, g_fid_value);
    (*env)->DeleteLocalRef(env, local);
  }
  return sum;
}

/* The batched alternative: a region per BATCH iterations instead of a
 * DeleteLocalRef per iteration. Included to bound what a region chosen by
 * liveness could still win beyond B; it requires a loop-blocking transform
 * the current design does not claim, so it is an appendix, not the claim. */
__attribute__((noinline)) jlong nt_kernel_b2_nonescaping_batched(JNIEnv *env,
                                                                 jint iters) {
  enum { BATCH = 512 };
  jlong sum = 0;
  jint i = 0;
  while (i < iters) {
    jint n = iters - i < BATCH ? iters - i : BATCH;
    if ((*env)->PushLocalFrame(env, n) < 0) return -1;
    for (jint k = 0; k < n; k++, i++) {
      jobject local =
          (*env)->CallStaticObjectMethod(env, g_cls_falsifier, g_mid_make, i);
      if (__builtin_expect((*env)->ExceptionCheck(env), 0)) {
        (*env)->PopLocalFrame(env, NULL);
        return -1;
      }
      sum += (*env)->GetIntField(env, local, g_fid_value);
    }
    (*env)->PopLocalFrame(env, NULL);
  }
  return sum;
}

/* Stored: the value escapes, so the promotion is genuinely required and the
 * compiler emits it too. The delta against variant A isolates the per-call
 * frame plus handle bookkeeping. */
__attribute__((noinline)) jlong nt_kernel_b_stored(JNIEnv *env, jint iters) {
  enum { RING = 256 };
  jobject ring[RING];
  memset(ring, 0, sizeof ring);
  jlong sum = 0;
  for (jint i = 0; i < iters; i++) {
    jint slot = i & (RING - 1);
    if (ring[slot]) {
      (*env)->DeleteGlobalRef(env, ring[slot]);
      ring[slot] = NULL;
    }
    jobject local =
        (*env)->CallStaticObjectMethod(env, g_cls_falsifier, g_mid_make, i);
    if (__builtin_expect((*env)->ExceptionCheck(env), 0)) goto fail_out;
    jobject stable = (*env)->NewGlobalRef(env, local);
    (*env)->DeleteLocalRef(env, local);
    if (!stable) goto fail_out;
    sum += (*env)->GetIntField(env, stable, g_fid_value);
    ring[slot] = stable;
  }
  for (jint s = 0; s < RING; s++)
    if (ring[s]) (*env)->DeleteGlobalRef(env, ring[s]);
  return sum;
fail_out:
  if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
  for (jint s = 0; s < RING; s++)
    if (ring[s]) (*env)->DeleteGlobalRef(env, ring[s]);
  return -1;
}

/* Fallible: detection is one inline ExceptionCheck; everything detailed
 * lives on the cold edge. */
__attribute__((noinline)) jlong nt_kernel_b_fallible(JNIEnv *env, jint iters) {
  jlong sum = 0;
  for (jint i = 0; i < iters; i++) {
    jint r = (*env)->CallStaticIntMethod(env, g_cls_falsifier,
                                         g_mid_checked_add, i, 1);
    if (__builtin_expect((*env)->ExceptionCheck(env), 0)) {
      nt_failure fail = {0, 0};
      nt_cold_capture(env, &fail);
      nt_failure_dispose(&fail);
      return -1;
    }
    sum += r;
  }
  return sum;
}

int nt_check_b_failure(JNIEnv *env) {
  (void)(*env)->CallStaticIntMethod(env, g_cls_falsifier, g_mid_checked_add,
                                    2147483647, 1);
  if (!(*env)->ExceptionCheck(env)) return 1;
  nt_failure fail = {0, 0};
  nt_cold_capture(env, &fail);
  int ok = fail.failed && fail.message && strstr(fail.message, "overflow");
  nt_failure_dispose(&fail);
  return ok ? 0 : 1;
}
