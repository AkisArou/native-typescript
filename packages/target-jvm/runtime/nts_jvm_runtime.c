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

void nts_jvm_application_start(char **error) {
  *error = NULL;
  if (nts_jvm_vm != NULL) {
    *error = nts_jvm_owned_message("the JVM is already started");
    return;
  }
  const char *classpath = getenv("NT_JVM_CLASSPATH");
  char *classpath_option = NULL;
  JavaVMOption options[1];
  JavaVMInitArgs arguments = {
      .version = JNI_VERSION_10,
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
}

void nts_jvm_application_stop(void) {
  if (nts_jvm_vm == NULL) return;
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
