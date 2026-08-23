/* The admission instrument for carrying JNIEnv * as an execution
 * capability. The two kernels perform identical useful JNI work. Their only
 * difference is whether each iteration asks the cached JavaVM for the
 * current thread's env, reads the reentrant TLS scope the JVM target now
 * uses, or receives the env as an explicit operand (the lower bound).
 *
 * GetVersion is intentionally retained in all arms. It proves that the
 * returned/passed capability is consumed, keeps the loop from becoming an
 * empty timing shell, and leaves the delta attributable to GetEnv. */

#include "nt_common.h"

__attribute__((noinline)) jlong nt_kernel_env_lookup(JNIEnv *expected,
                                                      jint iters) {
  jlong sum = 0;
  for (jint i = 0; i < iters; i++) {
    JNIEnv *env = NULL;
    if ((*g_vm)->GetEnv(g_vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK ||
        env != expected) {
      return -1;
    }
    sum += (*env)->GetVersion(env);
  }
  return sum;
}

__attribute__((noinline)) jlong nt_kernel_env_scoped(JNIEnv *expected,
                                                      jint iters) {
  jlong sum = 0;
  for (jint i = 0; i < iters; i++) {
    JNIEnv *env = g_scoped_env;
    if (env == NULL || env != expected) return -1;
    sum += (*env)->GetVersion(env);
  }
  return sum;
}

__attribute__((noinline)) jlong nt_kernel_env_passed(JNIEnv *env,
                                                      jint iters) {
  jlong sum = 0;
  for (jint i = 0; i < iters; i++) sum += (*env)->GetVersion(env);
  return sum;
}
