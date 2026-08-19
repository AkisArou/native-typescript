#ifndef NT_FALSIFIER_COMMON_H
#define NT_FALSIFIER_COMMON_H

#include <jni.h>
#include <stdlib.h>

/* Binding identity resolved once at start-up by the harness. Both variants
 * share it: lookup cost is initialization, not the per-call boundary this
 * instrument measures. Classes are held as global references. */
extern jclass g_cls_falsifier;
extern jclass g_cls_throwable;
extern jmethodID g_mid_make;
extern jmethodID g_mid_checked_add;
extern jmethodID g_mid_get_message;
extern jfieldID g_fid_value;

/* The neutral algebra's managed handle: a stable reference plus its
 * destructor carried as data. This is the shape the contingency's adapter
 * returns, and the bookkeeping LTO gets a chance to collapse. */
typedef struct nt_handle {
  void *ref;
  void (*drop)(JNIEnv *, void *);
} nt_handle;

/* The landed outcome-protocol arm: a failure indicator in a slot beside the
 * result, message and release named by the contract (here: free()). */
typedef struct nt_failure {
  int failed;
  char *message;
} nt_failure;

static inline void nt_handle_release(JNIEnv *env, nt_handle *h) {
  if (h->ref) {
    h->drop(env, h->ref);
    h->ref = 0;
    h->drop = 0;
  }
}

static inline void nt_failure_dispose(nt_failure *f) {
  free(f->message);
  f->message = 0;
  f->failed = 0;
}

/* Variant A: the conservative per-call adapter (adapter.c, its own
 * translation unit — without LTO the boundary is a real call). */
nt_handle nt_adp_make(JNIEnv *env, jint seed, nt_failure *fail);
jint nt_adp_widget_value(JNIEnv *env, nt_handle h);
jint nt_adp_checked_add(JNIEnv *env, jint a, jint b, nt_failure *fail);

/* Benchmark kernels. Every kernel returns a checksum (or -1 on failure) so
 * the harness can prove the variants performed identical Java work. */
jlong nt_kernel_a_nonescaping(JNIEnv *env, jint iters);
jlong nt_kernel_a_stored(JNIEnv *env, jint iters);
jlong nt_kernel_a_fallible(JNIEnv *env, jint iters);
jlong nt_kernel_b_nonescaping(JNIEnv *env, jint iters);
jlong nt_kernel_b_stored(JNIEnv *env, jint iters);
jlong nt_kernel_b_fallible(JNIEnv *env, jint iters);
jlong nt_kernel_b2_nonescaping_batched(JNIEnv *env, jint iters);

/* One-shot failure-path checks; 0 means the detailed message arrived. */
int nt_check_a_failure(JNIEnv *env);
int nt_check_b_failure(JNIEnv *env);

#endif
