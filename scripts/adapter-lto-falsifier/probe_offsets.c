/* Prints the byte offset of each measured JNI function-table slot, taken
 * from the real jni.h with offsetof. The disassembly analyzer uses these to
 * label indirect calls. Evidence over inference: a hand-written slot table
 * in an earlier draft of the boundary design got ExceptionClear wrong, which
 * is exactly why this is a probe and not a constant list. */

#include <jni.h>
#include <stddef.h>
#include <stdio.h>

#define P(name) \
  printf("%s %zu\n", #name, offsetof(struct JNINativeInterface_, name))
#define V(name) \
  printf("VM_%s %zu\n", #name, offsetof(struct JNIInvokeInterface_, name))

int main(void) {
  P(GetVersion);
  P(PushLocalFrame);
  P(PopLocalFrame);
  P(NewGlobalRef);
  P(DeleteGlobalRef);
  P(DeleteLocalRef);
  P(NewLocalRef);
  P(EnsureLocalCapacity);
  P(ExceptionCheck);
  P(ExceptionOccurred);
  P(ExceptionClear);
  P(CallStaticObjectMethod);
  P(CallStaticIntMethod);
  P(CallObjectMethod);
  P(GetIntField);
  P(GetObjectClass);
  P(GetStringUTFChars);
  P(ReleaseStringUTFChars);
  V(GetEnv);
  return 0;
}
