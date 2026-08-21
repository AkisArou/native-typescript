import { applicationStart } from "@native-typescript/jvm-application";
import { Log, MainActivity } from "@native-typescript/jvm-android";

/* A TypeScript Android application: the whole program is a lifecycle
 * handler, because on a platform that is all a program is.
 *
 * Nothing here constructs the Activity. ART does, after reading the
 * generated manifest, and it calls the lifecycle method on the UI thread
 * — which is why the registration is anchored to the CLASS rather than to
 * an instance nobody can name yet, and why the receiver arrives as the
 * handler's first argument. Both are the contract's shape rather than
 * this program's choice.
 *
 * It overrides onStart rather than onCreate for one reason: onCreate
 * receives a Bundle, and a savedInstanceState is null on first launch, so
 * that override waits on the nullable-payload arm. onStart takes nothing
 * and is dispatched on the same thread by the same machinery.
 *
 * The verdict travels through android.util.Log because Android discards a
 * process's stdout and stderr, and because a signal that crosses the
 * boundary under test is worth more than one that does not: if the line
 * appears, the manifest was read, the library loaded, JNI_OnLoad ran, the
 * class-anchored registration answered for an instance TypeScript never
 * named, and the receiver it was handed was a live object it could call
 * back into.
 */
applicationStart();

MainActivity.onStart((activity) => {
  /* The base implementation runs first, as every Android lifecycle
   * override must: an Activity that skips super throws before it draws. */
  activity.ntsSuperOnStart();
  Log.i("native-typescript", `onStart ran in ${activity.getLocalClassName()}`);
});
