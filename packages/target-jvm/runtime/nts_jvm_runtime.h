#ifndef NTS_JVM_RUNTIME_H
#define NTS_JVM_RUNTIME_H

#include <jni.h>

/* The JVM target's process bootstrap. One JavaVM per process, created on
 * the thread that calls start - which becomes the owner executor's thread -
 * and every generated binding package registered at image load is bound
 * before start returns.
 *
 * The classpath is a runtime input: NT_JVM_CLASSPATH in the environment,
 * absent meaning the JVM default. A path in the environment at run time is
 * not a path in a plan.
 *
 * The error object each failing entry hands back is one owned C string,
 * exactly the shape the generated adapters use: read it with
 * nts_jvm_application_error_message, release it with
 * nts_jvm_application_error_release. */

void nts_jvm_runtime_register(jint (*bind)(JavaVM *, char **));

/* The current synchronous JVM capability. Generated adapters provide a weak
 * standalone definition; this runtime's strong definition unifies every
 * package in the image. It is non-NULL only while the current thread is in a
 * Java callback/owner turn, or for the lifetime of a runtime-attached owner
 * thread. */
extern _Thread_local JNIEnv *nts_jvm_thread_env;

void nts_jvm_application_start(char **error);
void nts_jvm_application_stop(void);
void nts_jvm_application_complete(int code);

const char *nts_jvm_application_error_message(void *error);
void nts_jvm_application_error_release(void *error);

#endif
