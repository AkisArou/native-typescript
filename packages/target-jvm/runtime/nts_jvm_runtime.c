#include "nts_jvm_runtime.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "scr_runtime.h"

/* Registered binds are announced by generated adapters at image load, so
 * the capacity bounds how many binding packages one program links. A
 * program that exceeds it fails loudly at load, not quietly at bind. */
enum { NTS_JVM_MAX_PACKAGES = 64 };

static jint (*nts_jvm_binds[NTS_JVM_MAX_PACKAGES])(JavaVM *, char **);
static size_t nts_jvm_bind_count;
static JavaVM *nts_jvm_vm;

static char *nts_jvm_owned_message(const char *text) {
  char *owned = strdup(text);
  if (owned == NULL) {
    fprintf(stderr, "nts_jvm_runtime: out of memory reporting a failure\n");
    abort();
  }
  return owned;
}

void nts_jvm_runtime_register(jint (*bind)(JavaVM *, char **)) {
  if (nts_jvm_bind_count >= NTS_JVM_MAX_PACKAGES) {
    fprintf(stderr, "nts_jvm_runtime: too many binding packages registered\n");
    abort();
  }
  nts_jvm_binds[nts_jvm_bind_count++] = bind;
}

/* The pump: the desktop JVM has no native loop of its own, so the queue
 * IS the platform source — a condition variable the wake signals and the
 * poll sleeps on. GTK's runtime is the same shape with GLib underneath;
 * an Android Looper slots in here later the same way. */
static struct {
  pthread_mutex_t mutex;
  pthread_cond_t cond;
  bool woken;
} nts_jvm_loop = {
    PTHREAD_MUTEX_INITIALIZER,
    PTHREAD_COND_INITIALIZER,
    false,
};

/* A recorded failure is STICKY: the drain continues so later work runs,
 * but the exit code is settled - a later completion cannot launder a
 * failure into success. scr_exit_code_note itself is last-write-wins by
 * design (main's own policy), so the stickiness is this target's. */
static bool nts_jvm_failed;

static void nts_jvm_runtime_note_failure(void) {
  nts_jvm_failed = true;
  scr_exit_code_note(1);
}

static void nts_jvm_runtime_wake(void *context) {
  (void)context;
  pthread_mutex_lock(&nts_jvm_loop.mutex);
  nts_jvm_loop.woken = true;
  pthread_cond_signal(&nts_jvm_loop.cond);
  pthread_mutex_unlock(&nts_jvm_loop.mutex);
}

static bool nts_jvm_runtime_pending(void *context) {
  (void)context;
  return scr_retained_callbacks_pending() != 0;
}

static ScrAttachedLoopPollResult nts_jvm_runtime_poll(void *context,
                                                      double max_wait_ms) {
  (void)context;
  pthread_mutex_lock(&nts_jvm_loop.mutex);
  if (!nts_jvm_loop.woken && scr_retained_callbacks_pending() == 0 &&
      max_wait_ms != 0) {
    if (max_wait_ms < 0) {
      pthread_cond_wait(&nts_jvm_loop.cond, &nts_jvm_loop.mutex);
    } else {
      struct timespec deadline;
      clock_gettime(CLOCK_REALTIME, &deadline);
      time_t seconds = (time_t)(max_wait_ms / 1000.0);
      long nanoseconds =
          (long)((max_wait_ms - (double)seconds * 1000.0) * 1e6);
      deadline.tv_sec += seconds;
      deadline.tv_nsec += nanoseconds;
      if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec += 1;
        deadline.tv_nsec -= 1000000000L;
      }
      /* A spurious or early wake is harmless: the scheduler recomputes its
       * deadline on the next poll. */
      pthread_cond_timedwait(&nts_jvm_loop.cond, &nts_jvm_loop.mutex,
                             &deadline);
    }
  }
  nts_jvm_loop.woken = false;
  pthread_mutex_unlock(&nts_jvm_loop.mutex);

  /* One host turn: at most one delivery, then the checkpoint the attached
   * contract requires after each delivered callback. An exception out of a
   * queued handler has no emitting call to answer to, so it is reported
   * and the exit code notes the failure rather than aborting the drain. */
  ScrRetainedCallbackDispatch dispatched = scr_retained_callbacks_dispatch();
  if (dispatched == SCR_RETAINED_CALLBACK_DISPATCH_EXCEPTION) {
    fprintf(stderr,
            "nts_jvm_runtime: uncaught exception in a queued callback\n");
    /* The failure sink must CONSUME the exception or the loop treats it
     * as fatal (the GLib runtime traps on a sink that leaves one
     * pending). Printing releases the payload, which is what lets the
     * drain continue past the failure it just recorded. */
    scr_exc_print_uncaught();
    nts_jvm_runtime_note_failure();
  }
  ScrLoopCheckpointResult checkpoint = scr_loop_checkpoint();
  if (checkpoint == SCR_LOOP_CHECKPOINT_EXCEPTION) {
    fprintf(stderr,
            "nts_jvm_runtime: uncaught exception at a loop checkpoint\n");
    scr_exc_print_uncaught();
    nts_jvm_runtime_note_failure();
  } else if (checkpoint == SCR_LOOP_CHECKPOINT_UNHANDLED_REJECTION) {
    fprintf(stderr, "nts_jvm_runtime: unhandled promise rejection\n");
    nts_jvm_runtime_note_failure();
  }
  return SCR_ATTACHED_LOOP_POLL_COMPLETE;
}

/* ── hosted adoption ────────────────────────────────────────────────────
 * `System.loadLibrary` runs JNI_OnLoad on a JVM thread this runtime did
 * not create — on Android, one with a Looper. The library contract makes
 * the boot order REQUIRED rather than prudent: "the calling thread IS the
 * instance selector", so the thread that calls the library init owns the
 * ScriptC instance. The loader therefore touches only this runtime's own
 * statics — cache the VM, spawn the owner, wait for "bound" — and the
 * owner thread does everything else: attach itself, run the binds, call
 * the init the archive provides (weak, so the executable product links
 * this same object without one), and park in the pump. */
extern void nts_jvm_hosted_init(void) __attribute__((weak));

/* Android's jni.h types AttachCurrentThread's out-parameter JNIEnv**
 * where the desktop JDK's says void** — one slot, two header spellings.
 * The cast target names the divergence once instead of per call site. */
#ifdef __ANDROID__
typedef JNIEnv **NtsJvmEnvOut;
#else
typedef void **NtsJvmEnvOut;
#endif

static bool nts_jvm_adopted;

/* Whether the ScriptC half of the boot has run. */
static bool nts_jvm_services_ready;

/**
 * The retained-callback service and the pump, configured with THIS
 * runtime's wake.
 *
 * It runs before the module's top level, and the reason is a change in
 * what a program can promise. `applicationStart()` used to be the first
 * thing a module did, so it could configure the service and be sure it
 * was first. A TypeScript class that extends a native one is registered
 * by a call the compiler synthesizes AHEAD of the program's own
 * statements — because the platform reaches an override through the class
 * rather than through anything the program does — so "the program calls
 * applicationStart first" stopped being something the program controls.
 *
 * Letting the first registration configure the service lazily is not the
 * alternative it looks like. That path installs the OWNER LOOP's wake and
 * its pipe-based FFI, and on Android nothing drains that pipe: the
 * adopt-in-place boot returns to the platform rather than parking. Whoever
 * configures first decides where a queued delivery goes, so this runtime
 * configures first, deliberately.
 *
 * Idempotent, because `applicationStart()` still calls it and a program
 * that says so out loud should not be punished for it.
 */
static const char *nts_jvm_start_services(void) {
  if (nts_jvm_services_ready) return NULL;
  if (!scr_retained_callbacks_configure(nts_jvm_runtime_wake, NULL)) {
    return "retained-callback service configuration failed";
  }
  if (!scr_loop_set_attached(nts_jvm_runtime_pending, nts_jvm_runtime_poll,
                             &nts_jvm_loop)) {
    (void)scr_retained_callbacks_destroy();
    return "attaching the pump to the loop failed";
  }
  nts_jvm_services_ready = true;
  return NULL;
}

/* Which thread owns the ScriptC instance. An instance is never entered
 * from two threads, and the runtime does not police that — reaching a
 * handler means reading a closure, and a closure read from a foreign
 * thread corrupts rather than fails. A target cannot make the obligation
 * unnecessary, but it can make it OBSERVABLE: every generated trampoline
 * asks this before it delivers, so a dispatch on the wrong thread throws
 * into Java by name instead of proceeding. */
static pthread_t nts_jvm_owner_thread;
static bool nts_jvm_owner_known;

int nts_jvm_runtime_owner_thread_is_current(void) {
  if (!nts_jvm_owner_known) return 1;
  return pthread_equal(nts_jvm_owner_thread, pthread_self()) != 0 ? 1 : 0;
}

static void nts_jvm_claim_owner_thread(void) {
  nts_jvm_owner_thread = pthread_self();
  nts_jvm_owner_known = true;
}

#ifndef NTS_JVM_ADOPT_IN_PLACE
/* The spawned-owner boot, for an embedder that hands control back to the
 * program rather than calling into it: the loader waits until the owner
 * has bound, and the owner parks in the pump. A platform-driven build
 * adopts the loading thread instead and reaches none of this. */
static struct {
  pthread_mutex_t mutex;
  pthread_cond_t cond;
  bool bound;
  bool failed;
} nts_jvm_boot = {
    PTHREAD_MUTEX_INITIALIZER,
    PTHREAD_COND_INITIALIZER,
    false,
    false,
};

static void nts_jvm_boot_signal(bool failed) {
  pthread_mutex_lock(&nts_jvm_boot.mutex);
  nts_jvm_boot.bound = true;
  nts_jvm_boot.failed = failed;
  pthread_cond_signal(&nts_jvm_boot.cond);
  pthread_mutex_unlock(&nts_jvm_boot.mutex);
}

static void *nts_jvm_owner_main(void *opaque) {
  (void)opaque;
  nts_jvm_claim_owner_thread();
  JNIEnv *env = NULL;
  if (
      (*nts_jvm_vm)->AttachCurrentThread(
          nts_jvm_vm, (NtsJvmEnvOut)&env, NULL) != JNI_OK) {
    fprintf(stderr, "nts_jvm_runtime: the owner thread could not attach\n");
    nts_jvm_boot_signal(true);
    return NULL;
  }
  for (size_t index = 0; index < nts_jvm_bind_count; index++) {
    char *error = NULL;
    if (nts_jvm_binds[index](nts_jvm_vm, &error) != 0) {
      fprintf(stderr, "nts_jvm_runtime: bind failed: %s\n",
              error == NULL ? "(no message)" : error);
      free(error);
      nts_jvm_boot_signal(true);
      return NULL;
    }
  }
  /* Binds are pure JNI, so they precede the instance; the ScriptC service
   * setup runs INSIDE the instance, from applicationStart on this same
   * thread, exactly as the executable path orders it. */
  const char *failure = nts_jvm_start_services();
  if (failure != NULL) {
    fprintf(stderr, "nts_jvm_runtime: %s\n", failure);
    nts_jvm_boot_signal(true);
    return NULL;
  }
  nts_jvm_boot_signal(false);
  if (nts_jvm_hosted_init != NULL) {
    nts_jvm_hosted_init();
  }
  /* The program's top level ended without completing: park in the pump so
   * queued deliveries keep draining — hosted service semantics. ScriptC
   * timers do not fire in this park, and the COMPILER is what keeps that
   * honest: library emission requires an async_free module graph, so a
   * hosted program reaching the timers surface refuses by name before
   * this code can strand one (fixtures/jvm-app/hosted-timers.ts pins
   * it). When that refusal lifts, this park must become the loop:
   * adopted pending() answering true turns scr_loop_run into the park —
   * its exhaustion break never fires and its timer station is the only
   * place timers fire — where a hand-rolled deadline wait here would
   * carry the loop's one decision in two places. */
  for (;;) {
    nts_jvm_runtime_poll(NULL, -1.0);
  }
  return NULL;
}
#endif

/* JNI_VERSION_1_6 everywhere a version is spoken: nothing this runtime
 * touches is newer than JNI 1.2 (RegisterNatives, GetEnv,
 * AttachCurrentThread), 1_6 is the floor both HotSpot and ART accept,
 * and Android's jni.h defines nothing later — a JNI_VERSION_10 that
 * works on the desktop fails to compile against the platform that made
 * hosting matter. */
jint JNI_OnLoad(JavaVM *vm, void *reserved) {
  (void)reserved;
  if (nts_jvm_vm != NULL) return JNI_VERSION_1_6;
  nts_jvm_vm = vm;
  nts_jvm_adopted = true;
#ifdef NTS_JVM_ADOPT_IN_PLACE
  /* PLATFORM-DRIVEN adoption: the thread that loads the library becomes
   * the instance's owner, and nothing is spawned or parked.
   *
   * This is the library contract read literally — the calling thread IS
   * the instance selector — and on a platform it is the only correct
   * reading. Android dispatches every Activity lifecycle callback on the
   * process's main looper, and this runs inside the generated Activity's
   * static initializer, so the loading thread and the dispatching thread
   * are the same one. Spawning an owner here would put the instance on a
   * thread the platform will never call, and the first lifecycle callback
   * would read a closure from a foreign thread — corruption rather than a
   * diagnostic, because nothing polices it.
   *
   * There is no park because there is nothing to park for: control
   * returns to the platform, which calls back in. A queued delivery would
   * need the platform's own loop to pump it, which is its own slice with
   * its own program. */
  nts_jvm_claim_owner_thread();
  JNIEnv *env = NULL;
  if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK) {
    fprintf(stderr, "nts_jvm_runtime: the loading thread is not attached\n");
    nts_jvm_vm = NULL;
    return JNI_ERR;
  }
  for (size_t index = 0; index < nts_jvm_bind_count; index++) {
    char *error = NULL;
    if (nts_jvm_binds[index](nts_jvm_vm, &error) != 0) {
      fprintf(stderr, "nts_jvm_runtime: bind failed: %s\n",
              error == NULL ? "(no message)" : error);
      free(error);
      nts_jvm_vm = NULL;
      return JNI_ERR;
    }
  }
  const char *failure = nts_jvm_start_services();
  if (failure != NULL) {
    fprintf(stderr, "nts_jvm_runtime: %s\n", failure);
    nts_jvm_vm = NULL;
    return JNI_ERR;
  }
  if (nts_jvm_hosted_init != NULL) {
    nts_jvm_hosted_init();
  }
  return JNI_VERSION_1_6;
#else
  pthread_t owner;
  if (pthread_create(&owner, NULL, nts_jvm_owner_main, NULL) != 0) {
    fprintf(stderr, "nts_jvm_runtime: could not spawn the owner thread\n");
    nts_jvm_vm = NULL;
    return JNI_ERR;
  }
  pthread_detach(owner);
  /* The wait closes the RegisterNatives race AND makes "the owner owns
   * the instance" observable to the loader before loadLibrary returns.
   * Do not delete it as a race that "cannot happen". Deadlock-free: the
   * owner needs nothing back from this thread. */
  pthread_mutex_lock(&nts_jvm_boot.mutex);
  while (!nts_jvm_boot.bound) {
    pthread_cond_wait(&nts_jvm_boot.cond, &nts_jvm_boot.mutex);
  }
  bool failed = nts_jvm_boot.failed;
  pthread_mutex_unlock(&nts_jvm_boot.mutex);
  if (failed) {
    nts_jvm_vm = NULL;
    nts_jvm_adopted = false;
    return JNI_ERR;
  }
  return JNI_VERSION_1_6;
#endif
}

void nts_jvm_application_start(char **error) {
  *error = NULL;
  if (nts_jvm_adopted) {
    /* Hosted: the platform started the JVM and the owner boot ran the
     * binds; what remains is the ScriptC half, on the instance's own
     * thread — which this is, because the owner called the init that
     * evaluated the module calling here. */
    const char *failure = nts_jvm_start_services();
    if (failure != NULL) *error = nts_jvm_owned_message(failure);
    return;
  }
  if (nts_jvm_vm != NULL) {
    *error = nts_jvm_owned_message("the JVM is already started");
    return;
  }
#ifdef __ANDROID__
  /* Android has no libjvm to create — a library here is ADOPTED by the
   * process that loads it, and the adopted arm above is the only
   * reachable one. Refusing by name also keeps JNI_CreateJavaVM out of
   * the object: bionic resolves symbols eagerly at load, so a reference
   * glibc would leave forever-lazy fails the whole dlopen there. */
  *error = nts_jvm_owned_message(
      "this platform cannot create a JVM; an Android library is adopted "
      "by the process that loads it");
#else
  const char *classpath = getenv("NT_JVM_CLASSPATH");
  char *classpath_option = NULL;
  JavaVMOption options[1];
  JavaVMInitArgs arguments = {
      .version = JNI_VERSION_1_6,
      .nOptions = 0,
      .options = options,
      .ignoreUnrecognized = JNI_FALSE,
  };
  if (classpath != NULL) {
    const char prefix[] = "-Djava.class.path=";
    classpath_option = malloc(sizeof prefix + strlen(classpath));
    if (classpath_option == NULL) {
      fprintf(stderr, "nts_jvm_runtime: out of memory starting the JVM\n");
      abort();
    }
    strcpy(classpath_option, prefix);
    strcat(classpath_option, classpath);
    options[0].optionString = classpath_option;
    arguments.nOptions = 1;
  }
  JNIEnv *env = NULL;
  nts_jvm_claim_owner_thread();
  jint created = JNI_CreateJavaVM(&nts_jvm_vm, (void **)&env, &arguments);
  free(classpath_option);
  if (created != JNI_OK) {
    nts_jvm_vm = NULL;
    *error = nts_jvm_owned_message("JNI_CreateJavaVM failed");
    return;
  }
  for (size_t index = 0; index < nts_jvm_bind_count; index++) {
    if (nts_jvm_binds[index](nts_jvm_vm, error) != 0) {
      /* The bind's own message names the failing package; starting half
       * bound would leave calls that trap later, so the VM goes down. */
      (*nts_jvm_vm)->DestroyJavaVM(nts_jvm_vm);
      nts_jvm_vm = NULL;
      return;
    }
  }
  /* The service links on this target's say-so (requires.compiler), so it
   * is configured whether or not the program connects anything. */
  if (!scr_retained_callbacks_configure(nts_jvm_runtime_wake, NULL)) {
    (*nts_jvm_vm)->DestroyJavaVM(nts_jvm_vm);
    nts_jvm_vm = NULL;
    *error = nts_jvm_owned_message(
        "retained-callback service configuration failed");
    return;
  }
  if (!scr_loop_set_attached(nts_jvm_runtime_pending, nts_jvm_runtime_poll,
                             &nts_jvm_loop)) {
    (void)scr_retained_callbacks_destroy();
    (*nts_jvm_vm)->DestroyJavaVM(nts_jvm_vm);
    nts_jvm_vm = NULL;
    *error = nts_jvm_owned_message("attaching the pump to the loop failed");
    return;
  }
#endif
}

void nts_jvm_application_stop(void) {
  if (nts_jvm_vm == NULL) return;
  if (nts_jvm_adopted) {
    /* The platform owns an adopted VM; stopping tears down only the
     * ScriptC half and leaves the process to its host. */
    scr_retained_callbacks_stop_accepting();
    (void)scr_retained_callbacks_destroy();
    (void)scr_loop_clear_attached(&nts_jvm_loop);
    return;
  }
  /* Mirrors the GTK shutdown sequence: every clause runs, because pending
   * work and a live registration are distinct faults and destroy must be
   * attempted either way. A program that stops while either holds has a
   * bug worth naming, not hiding. */
  scr_retained_callbacks_stop_accepting();
  if (scr_retained_callbacks_pending() != 0) {
    fprintf(stderr,
            "nts_jvm_runtime: stopped with queued callback work pending\n");
  }
  if (scr_retained_callbacks_active() != 0) {
    fprintf(stderr,
            "nts_jvm_runtime: stopped with live callback registrations\n");
  }
  (void)scr_retained_callbacks_destroy();
  (void)scr_loop_clear_attached(&nts_jvm_loop);
  (*nts_jvm_vm)->DestroyJavaVM(nts_jvm_vm);
  nts_jvm_vm = NULL;
}

/* Terminal by contract, with process.exit()'s own semantics: exit
 * listeners run, streams flush, and _Exit ends the process - the JVM and
 * every live handle die with it, which is the "process exit is its honest
 * end" story stated where it is implemented. A plain hint could not be
 * this: a normally exhausting main returns its program verdict without
 * consulting the hint, so completion-as-a-note was dead plumbing - the
 * sticky-failure test is what exposed it. */
void nts_jvm_application_complete(int code) {
  if (nts_jvm_failed) {
    fprintf(stderr,
            "nts_jvm_runtime: completion ignored - a failure was already "
            "recorded and the exit code is settled\n");
    code = 1;
  }
  scr_process_exit((double)code);
}

const char *nts_jvm_application_error_message(void *error) {
  return (const char *)error;
}

void nts_jvm_application_error_release(void *error) {
  free(error);
}
