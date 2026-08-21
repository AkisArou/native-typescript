import { applicationStart } from "@native-typescript/jvm-application";
import { Log, MainActivity } from "@native-typescript/jvm-android";
/* Type-only: a Bundle is never constructed or called here, it is only
 * received — the platform makes them. */
import type { Bundle } from "@native-typescript/jvm-android";

/* A TypeScript Android application: the whole program is a lifecycle
 * handler, because on a platform that is all a program is.
 *
 * Nothing here constructs the Activity. ART does, after reading the
 * generated manifest, and it calls onCreate on the main looper — which is
 * why the registration is anchored to the CLASS rather than to an
 * instance nobody can name yet, why the receiver arrives as the handler's
 * first argument, and why the library adopts the thread that loaded it
 * rather than spawning one. All three are the platform's shape rather
 * than this program's choice.
 *
 * The saved state is `Bundle | null` because a first launch has nothing
 * to restore. That is the platform reporting absence, not a caller
 * declining to pass something, and it is the first thing this program
 * observes — on the very first dispatch, not in some contrived path.
 *
 * The verdict travels through android.util.Log because Android discards a
 * process's stdout and stderr, and because a signal that crosses the
 * boundary under test is worth more than one that does not: if the line
 * appears, the manifest was read, the library loaded, JNI_OnLoad adopted
 * the thread ART dispatches on, the class-anchored registration answered
 * for an instance TypeScript never named, and the receiver it was handed
 * was a live object it could call back into.
 */
applicationStart();

MainActivity.onCreate((activity, savedState: Bundle | null) => {
  /* The base implementation runs first, as every Android lifecycle
   * override must: an Activity that skips super throws before it draws. */
  activity.ntsSuperOnCreate(savedState);
  const restored = savedState === null ? "fresh" : "restored";
  Log.i(
    "native-typescript",
    `onCreate ran ${restored} in ${activity.getLocalClassName()}`,
  );
});
