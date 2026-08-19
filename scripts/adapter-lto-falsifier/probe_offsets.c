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

int main(void) {
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
  return 0;
}
