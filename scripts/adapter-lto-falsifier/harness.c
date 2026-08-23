/* Harness: embeds a real JVM through the invocation API, proves both
 * variants perform identical Java work (including the failure path), counts
 * JNI reference and frame operations exactly through an interposed function
 * table, and times steady-state throughput.
 *
 * Counting and timing are separate passes: the counting table adds overhead,
 * so it never runs under the clock. Counts are deterministic per iteration.
 *
 * Single-threaded by design, matching the boundary's first JNI slice
 * (already-attached threads only). */

#include "nt_common.h"

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

jclass g_cls_falsifier;
jclass g_cls_throwable;
jmethodID g_mid_make;
jmethodID g_mid_checked_add;
jmethodID g_mid_get_message;
jfieldID g_fid_value;
JavaVM *g_vm;
_Thread_local JNIEnv *g_scoped_env;

static JNIEnv *g_real_env;
static JavaVM *g_real_vm;
static volatile jlong g_sink;

/* ---- counting env ------------------------------------------------------ */

enum {
  OP_GetEnv,
  OP_GetVersion,
  OP_PushLocalFrame,
  OP_PopLocalFrame,
  OP_NewGlobalRef,
  OP_DeleteGlobalRef,
  OP_DeleteLocalRef,
  OP_NewLocalRef,
  OP_EnsureLocalCapacity,
  OP_ExceptionCheck,
  OP_ExceptionOccurred,
  OP_ExceptionClear,
  OP_CallStaticObjectMethod,
  OP_CallStaticIntMethod,
  OP_CallObjectMethod,
  OP_GetIntField,
  OP_GetObjectClass,
  OP_GetStringUTFChars,
  OP_ReleaseStringUTFChars,
  OP__COUNT
};

static const char *const OP_NAMES[OP__COUNT] = {
    "GetEnv",           "GetVersion",        "PushLocalFrame",
    "PopLocalFrame",    "NewGlobalRef",
    "DeleteGlobalRef",  "DeleteLocalRef",    "NewLocalRef",
    "EnsureLocalCapacity", "ExceptionCheck", "ExceptionOccurred",
    "ExceptionClear",   "CallStaticObjectMethod", "CallStaticIntMethod",
    "CallObjectMethod", "GetIntField",       "GetObjectClass",
    "GetStringUTFChars", "ReleaseStringUTFChars",
};

static uint64_t g_counts[OP__COUNT];

static jint W_GetVersion(JNIEnv *env) {
  (void)env;
  g_counts[OP_GetVersion]++;
  return (*g_real_env)->GetVersion(g_real_env);
}

/* Wrappers forward to the real env: HotSpot derives the thread from the env
 * pointer, so the interposed pointer itself must never reach the VM. */
static jint W_PushLocalFrame(JNIEnv *env, jint cap) {
  (void)env;
  g_counts[OP_PushLocalFrame]++;
  return (*g_real_env)->PushLocalFrame(g_real_env, cap);
}
static jobject W_PopLocalFrame(JNIEnv *env, jobject res) {
  (void)env;
  g_counts[OP_PopLocalFrame]++;
  return (*g_real_env)->PopLocalFrame(g_real_env, res);
}
static jobject W_NewGlobalRef(JNIEnv *env, jobject o) {
  (void)env;
  g_counts[OP_NewGlobalRef]++;
  return (*g_real_env)->NewGlobalRef(g_real_env, o);
}
static void W_DeleteGlobalRef(JNIEnv *env, jobject o) {
  (void)env;
  g_counts[OP_DeleteGlobalRef]++;
  (*g_real_env)->DeleteGlobalRef(g_real_env, o);
}
static void W_DeleteLocalRef(JNIEnv *env, jobject o) {
  (void)env;
  g_counts[OP_DeleteLocalRef]++;
  (*g_real_env)->DeleteLocalRef(g_real_env, o);
}
static jobject W_NewLocalRef(JNIEnv *env, jobject o) {
  (void)env;
  g_counts[OP_NewLocalRef]++;
  return (*g_real_env)->NewLocalRef(g_real_env, o);
}
static jint W_EnsureLocalCapacity(JNIEnv *env, jint n) {
  (void)env;
  g_counts[OP_EnsureLocalCapacity]++;
  return (*g_real_env)->EnsureLocalCapacity(g_real_env, n);
}
static jboolean W_ExceptionCheck(JNIEnv *env) {
  (void)env;
  g_counts[OP_ExceptionCheck]++;
  return (*g_real_env)->ExceptionCheck(g_real_env);
}
static jthrowable W_ExceptionOccurred(JNIEnv *env) {
  (void)env;
  g_counts[OP_ExceptionOccurred]++;
  return (*g_real_env)->ExceptionOccurred(g_real_env);
}
static void W_ExceptionClear(JNIEnv *env) {
  (void)env;
  g_counts[OP_ExceptionClear]++;
  (*g_real_env)->ExceptionClear(g_real_env);
}
static jobject W_CallStaticObjectMethod(JNIEnv *env, jclass c, jmethodID m,
                                        ...) {
  (void)env;
  g_counts[OP_CallStaticObjectMethod]++;
  va_list ap;
  va_start(ap, m);
  jobject r = (*g_real_env)->CallStaticObjectMethodV(g_real_env, c, m, ap);
  va_end(ap);
  return r;
}
static jint W_CallStaticIntMethod(JNIEnv *env, jclass c, jmethodID m, ...) {
  (void)env;
  g_counts[OP_CallStaticIntMethod]++;
  va_list ap;
  va_start(ap, m);
  jint r = (*g_real_env)->CallStaticIntMethodV(g_real_env, c, m, ap);
  va_end(ap);
  return r;
}
static jobject W_CallObjectMethod(JNIEnv *env, jobject o, jmethodID m, ...) {
  (void)env;
  g_counts[OP_CallObjectMethod]++;
  va_list ap;
  va_start(ap, m);
  jobject r = (*g_real_env)->CallObjectMethodV(g_real_env, o, m, ap);
  va_end(ap);
  return r;
}
static jint W_GetIntField(JNIEnv *env, jobject o, jfieldID f) {
  (void)env;
  g_counts[OP_GetIntField]++;
  return (*g_real_env)->GetIntField(g_real_env, o, f);
}
static jclass W_GetObjectClass(JNIEnv *env, jobject o) {
  (void)env;
  g_counts[OP_GetObjectClass]++;
  return (*g_real_env)->GetObjectClass(g_real_env, o);
}
static const char *W_GetStringUTFChars(JNIEnv *env, jstring s,
                                       jboolean *is_copy) {
  (void)env;
  g_counts[OP_GetStringUTFChars]++;
  return (*g_real_env)->GetStringUTFChars(g_real_env, s, is_copy);
}
static void W_ReleaseStringUTFChars(JNIEnv *env, jstring s, const char *c) {
  (void)env;
  g_counts[OP_ReleaseStringUTFChars]++;
  (*g_real_env)->ReleaseStringUTFChars(g_real_env, s, c);
}

static void nt_unwrapped_slot(void) {
  fprintf(stderr,
          "falsifier: counting env hit an unwrapped JNI slot; add a wrapper\n");
  abort();
}

static struct JNINativeInterface_ g_counted_table;
static JNIEnv g_counted_env;

static jint W_GetEnv(JavaVM *vm, void **out, jint version) {
  (void)vm;
  g_counts[OP_GetEnv]++;
  JNIEnv *real = NULL;
  jint result = (*g_real_vm)->GetEnv(g_real_vm, (void **)&real, version);
  if (result == JNI_OK) *out = &g_counted_env;
  return result;
}

static struct JNIInvokeInterface_ g_counted_vm_table;
static JavaVM g_counted_vm;

static void nt_setup_counted_env(void) {
  /* Every slot traps unless explicitly wrapped, so a kernel cannot silently
   * hand the interposed env pointer to the real VM. */
  void **raw = (void **)&g_counted_table;
  size_t slots = sizeof g_counted_table / sizeof(void *);
  for (size_t i = 0; i < slots; i++) raw[i] = (void *)&nt_unwrapped_slot;
  g_counted_table.GetVersion = W_GetVersion;
  g_counted_table.PushLocalFrame = W_PushLocalFrame;
  g_counted_table.PopLocalFrame = W_PopLocalFrame;
  g_counted_table.NewGlobalRef = W_NewGlobalRef;
  g_counted_table.DeleteGlobalRef = W_DeleteGlobalRef;
  g_counted_table.DeleteLocalRef = W_DeleteLocalRef;
  g_counted_table.NewLocalRef = W_NewLocalRef;
  g_counted_table.EnsureLocalCapacity = W_EnsureLocalCapacity;
  g_counted_table.ExceptionCheck = W_ExceptionCheck;
  g_counted_table.ExceptionOccurred = W_ExceptionOccurred;
  g_counted_table.ExceptionClear = W_ExceptionClear;
  g_counted_table.CallStaticObjectMethod = W_CallStaticObjectMethod;
  g_counted_table.CallStaticIntMethod = W_CallStaticIntMethod;
  g_counted_table.CallObjectMethod = W_CallObjectMethod;
  g_counted_table.GetIntField = W_GetIntField;
  g_counted_table.GetObjectClass = W_GetObjectClass;
  g_counted_table.GetStringUTFChars = W_GetStringUTFChars;
  g_counted_table.ReleaseStringUTFChars = W_ReleaseStringUTFChars;
  g_counted_env = &g_counted_table;

  void **vm_raw = (void **)&g_counted_vm_table;
  size_t vm_slots = sizeof g_counted_vm_table / sizeof(void *);
  for (size_t i = 0; i < vm_slots; i++) vm_raw[i] = (void *)&nt_unwrapped_slot;
  g_counted_vm_table.GetEnv = W_GetEnv;
  g_counted_vm = &g_counted_vm_table;
}

/* ---- setup ------------------------------------------------------------- */

static void die(const char *what) {
  fprintf(stderr, "falsifier: %s\n", what);
  if (g_real_env && (*g_real_env)->ExceptionCheck(g_real_env))
    (*g_real_env)->ExceptionDescribe(g_real_env);
  exit(2);
}

static void resolve_binding(JNIEnv *env) {
  jclass c = (*env)->FindClass(env, "NTFalsifier");
  if (!c) die("class NTFalsifier not on the class path");
  g_cls_falsifier = (*env)->NewGlobalRef(env, c);
  (*env)->DeleteLocalRef(env, c);

  jclass w = (*env)->FindClass(env, "NTFalsifier$Widget");
  if (!w) die("class NTFalsifier$Widget not found");
  g_fid_value = (*env)->GetFieldID(env, w, "value", "I");
  if (!g_fid_value) die("field Widget.value not found");
  (*env)->DeleteLocalRef(env, w);

  jclass t = (*env)->FindClass(env, "java/lang/Throwable");
  if (!t) die("class java.lang.Throwable not found");
  g_cls_throwable = (*env)->NewGlobalRef(env, t);
  (*env)->DeleteLocalRef(env, t);

  g_mid_make = (*env)->GetStaticMethodID(env, g_cls_falsifier, "make",
                                         "(I)LNTFalsifier$Widget;");
  if (!g_mid_make) die("method NTFalsifier.make not found");
  g_mid_checked_add =
      (*env)->GetStaticMethodID(env, g_cls_falsifier, "checkedAdd", "(II)I");
  if (!g_mid_checked_add) die("method NTFalsifier.checkedAdd not found");
  g_mid_get_message = (*env)->GetMethodID(env, g_cls_throwable, "getMessage",
                                          "()Ljava/lang/String;");
  if (!g_mid_get_message) die("method Throwable.getMessage not found");
}

/* ---- runs -------------------------------------------------------------- */

typedef jlong (*nt_kernel_fn)(JNIEnv *, jint);

static const struct {
  const char *name;
  nt_kernel_fn fn;
} KERNELS[] = {
    {"a_nonescaping", nt_kernel_a_nonescaping},
    {"b_nonescaping", nt_kernel_b_nonescaping},
    {"b2_nonescaping_batched", nt_kernel_b2_nonescaping_batched},
    {"a_stored", nt_kernel_a_stored},
    {"b_stored", nt_kernel_b_stored},
    {"a_fallible", nt_kernel_a_fallible},
    {"b_fallible", nt_kernel_b_fallible},
    {"env_lookup", nt_kernel_env_lookup},
    {"env_scoped", nt_kernel_env_scoped},
    {"env_passed", nt_kernel_env_passed},
};
enum { KERNEL_COUNT = sizeof KERNELS / sizeof KERNELS[0] };

static int64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
}

static int verify(const char *tag, const char *check, int ok) {
  printf("VERIFY tag=%s check=%s ok=%d\n", tag, check, ok);
  return ok ? 0 : 1;
}

int main(int argc, char **argv) {
  const char *tag = "untagged";
  const char *classpath = "out/classes";
  long iters = 2000000, reps = 9, warmup = 3000000, count_iters = 512;
  for (int i = 1; i + 1 < argc; i += 2) {
    if (!strcmp(argv[i], "--tag")) tag = argv[i + 1];
    else if (!strcmp(argv[i], "--classpath")) classpath = argv[i + 1];
    else if (!strcmp(argv[i], "--iters")) iters = atol(argv[i + 1]);
    else if (!strcmp(argv[i], "--reps")) reps = atol(argv[i + 1]);
    else if (!strcmp(argv[i], "--warmup")) warmup = atol(argv[i + 1]);
    else if (!strcmp(argv[i], "--count-iters")) count_iters = atol(argv[i + 1]);
    else die("unknown argument");
  }

  char cp_opt[4096];
  snprintf(cp_opt, sizeof cp_opt, "-Djava.class.path=%s", classpath);
  /* Serial collector and a fixed heap: allocation cost is part of the
   * workload (make() allocates), so keep its variance identical and low
   * across every kernel. */
  JavaVMOption opts[4] = {
      {.optionString = cp_opt},
      {.optionString = "-Xms1g"},
      {.optionString = "-Xmx1g"},
      {.optionString = "-XX:+UseSerialGC"},
  };
  JavaVMInitArgs vmargs = {
      .version = JNI_VERSION_10,
      .nOptions = 4,
      .options = opts,
      .ignoreUnrecognized = JNI_FALSE,
  };
  JavaVM *vm;
  JNIEnv *env;
  if (JNI_CreateJavaVM(&vm, (void **)&env, &vmargs) != JNI_OK)
    die("JNI_CreateJavaVM failed");
  g_real_vm = vm;
  g_vm = vm;
  g_scoped_env = env;
  g_real_env = env;
  resolve_binding(env);

  int bad = 0;

  /* Failure paths deliver the detailed message in both variants — a
   * comparison against a broken failure channel would be meaningless. */
  bad += verify(tag, "a_failure_message", nt_check_a_failure(env) == 0);
  bad += verify(tag, "b_failure_message", nt_check_b_failure(env) == 0);

  /* Identical Java work across variants. */
  {
    enum { VER_ITERS = 4096 };
    jlong an = nt_kernel_a_nonescaping(env, VER_ITERS);
    jlong bn = nt_kernel_b_nonescaping(env, VER_ITERS);
    jlong b2 = nt_kernel_b2_nonescaping_batched(env, VER_ITERS);
    bad += verify(tag, "nonescaping_sums", an != -1 && an == bn && an == b2);
    jlong as = nt_kernel_a_stored(env, VER_ITERS);
    jlong bs = nt_kernel_b_stored(env, VER_ITERS);
    bad += verify(tag, "stored_sums", as != -1 && as == bs && as == an);
    jlong af = nt_kernel_a_fallible(env, VER_ITERS);
    jlong bf = nt_kernel_b_fallible(env, VER_ITERS);
    jlong expect = (jlong)VER_ITERS * (VER_ITERS + 1) / 2;
    bad += verify(tag, "fallible_sums", af == expect && bf == expect);
    jlong lookup = nt_kernel_env_lookup(env, VER_ITERS);
    jlong scoped = nt_kernel_env_scoped(env, VER_ITERS);
    jlong passed = nt_kernel_env_passed(env, VER_ITERS);
    bad += verify(tag, "env_sums",
                  lookup != -1 && lookup == scoped && lookup == passed);
  }

  /* Exact dynamic operation counts through the interposed table. */
  nt_setup_counted_env();
  g_vm = &g_counted_vm;
  g_scoped_env = &g_counted_env;
  for (int k = 0; k < KERNEL_COUNT; k++) {
    memset(g_counts, 0, sizeof g_counts);
    jlong r = KERNELS[k].fn(&g_counted_env, (jint)count_iters);
    if (r == -1) die("kernel failed during counting pass");
    printf("COUNT tag=%s kernel=%s iters=%ld", tag, KERNELS[k].name,
           count_iters);
    for (int op = 0; op < OP__COUNT; op++)
      printf(" %s=%llu", OP_NAMES[op], (unsigned long long)g_counts[op]);
    printf("\n");
  }
  g_vm = vm;
  g_scoped_env = env;

  /* Steady state: one long warmup drives the Java methods hot, then timed
   * repetitions; the analyzer takes the median. */
  for (int k = 0; k < KERNEL_COUNT; k++) {
    g_sink = KERNELS[k].fn(env, (jint)warmup);
    if (g_sink == -1) die("kernel failed during warmup");
    for (long rep = 0; rep < reps; rep++) {
      int64_t t0 = now_ns();
      g_sink = KERNELS[k].fn(env, (jint)iters);
      int64_t t1 = now_ns();
      if (g_sink == -1) die("kernel failed during timing");
      printf("TIME tag=%s kernel=%s rep=%ld iters=%ld ns=%lld\n", tag,
             KERNELS[k].name, rep, iters, (long long)(t1 - t0));
    }
  }

  if ((*env)->ExceptionCheck(env)) {
    (*env)->ExceptionDescribe(env);
    bad += verify(tag, "no_pending_exception", 0);
  }
  (*vm)->DestroyJavaVM(vm);
  return bad ? 1 : 0;
}
