#include "nts_jvm_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
}

void nts_jvm_application_stop(void) {
  if (nts_jvm_vm == NULL) return;
  (*nts_jvm_vm)->DestroyJavaVM(nts_jvm_vm);
  nts_jvm_vm = NULL;
}

void nts_jvm_application_complete(int code) {
  scr_exit_code_note(code);
}

const char *nts_jvm_application_error_message(void *error) {
  return (const char *)error;
}

void nts_jvm_application_error_release(void *error) {
  free(error);
}
