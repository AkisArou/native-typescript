/* Variant A: the contingency adapter (docs/foreign-boundary.md, "The
 * contingency"). Generated per call signature with no knowledge of the
 * caller — it cannot see liveness or escape, so every object-returning call
 * opens a local frame and promotes its result to a global reference before
 * returning an owned handle. That is the measured price of needing nothing
 * from the compiler.
 *
 * This file is a separate translation unit deliberately: the no-LTO build
 * measures the adapter as a real call boundary; the LTO build measures what
 * the linker refunds.
 *
 * One generosity toward the adapter, biasing the experiment against the
 * compiler-side thesis: primitive-returning calls do not open a frame,
 * because a per-signature generator can see the return is primitive. The
 * conservatism measured here is only what a generator genuinely cannot
 * avoid. */

#include "nt_common.h"

#include <string.h>

enum { NT_ADP_FRAME_CAPACITY = 8 };

static void nt_drop_global(JNIEnv *env, void *ref) {
  (*env)->DeleteGlobalRef(env, (jobject)ref);
}

/* Detailed failure capture: pull the pending throwable, clear it (JNI
 * forbids most operations while an exception is pending), and materialize
 * the message as an owned UTF-8 copy whose release action is free(). */
static void nt_adp_capture(JNIEnv *env, nt_failure *fail) {
  fail->failed = 1;
  fail->message = NULL;
  if ((*env)->PushLocalFrame(env, NT_ADP_FRAME_CAPACITY) < 0) {
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

nt_handle nt_adp_make(JNIEnv *env, jint seed, nt_failure *fail) {
  nt_handle h = {0, 0};
  if ((*env)->PushLocalFrame(env, NT_ADP_FRAME_CAPACITY) < 0) {
    nt_adp_capture(env, fail);
    return h;
  }
  jobject local =
      (*env)->CallStaticObjectMethod(env, g_cls_falsifier, g_mid_make, seed);
  if ((*env)->ExceptionCheck(env)) {
    nt_adp_capture(env, fail);
    (*env)->PopLocalFrame(env, NULL);
    return h;
  }
  /* The mandatory promotion: the adapter cannot know whether the caller
   * keeps the value past this call, so it must assume yes, every time. */
  jobject stable = (*env)->NewGlobalRef(env, local);
  (*env)->PopLocalFrame(env, NULL);
  if (!stable) {
    fail->failed = 1;
    fail->message = NULL;
    return h;
  }
  h.ref = stable;
  h.drop = nt_drop_global;
  return h;
}

jint nt_adp_widget_value(JNIEnv *env, nt_handle h) {
  return (*env)->GetIntField(env, (jobject)h.ref, g_fid_value);
}

jint nt_adp_checked_add(JNIEnv *env, jint a, jint b, nt_failure *fail) {
  jint r = (*env)->CallStaticIntMethod(env, g_cls_falsifier,
                                       g_mid_checked_add, a, b);
  if ((*env)->ExceptionCheck(env)) {
    nt_adp_capture(env, fail);
    return 0;
  }
  return r;
}
