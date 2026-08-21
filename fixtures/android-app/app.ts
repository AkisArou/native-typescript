import { applicationStart } from "@native-typescript/jvm-application";
import { Log, MainActivity, TextView } from "@native-typescript/jvm-android";
/* Type-only: a Bundle is never constructed or called here, it is only
 * received — the platform makes them. */
import type { Bundle } from "@native-typescript/jvm-android";

/* A TypeScript Android application that puts something on the screen.
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
 * to restore: the platform reporting absence, not a caller declining to
 * pass something.
 *
 * The view is built from the receiver, which is what makes the receiver
 * worth handing over: an Activity IS a Context, so it is what a View is
 * constructed with, and the identity upcast that makes that legal is the
 * same one the handle's type already declares. The text crosses as a
 * string into a CharSequence position, which is a widening the call
 * performs rather than a conversion this boundary invents.
 *
 * The log line stays as the verdict. A screen is for a person; the device
 * lane needs something it can assert, and android.util.Log is the channel
 * an Android process actually has.
 */
applicationStart();

MainActivity.onCreate((activity, savedState: Bundle | null) => {
  /* The base implementation runs first, as every Android lifecycle
   * override must: an Activity that skips super throws before it draws. */
  activity.ntsSuperOnCreate(savedState);

  const restored = savedState === null ? "fresh" : "restored";
  const label = new TextView(activity);
  label.setText(`Compiled TypeScript, ${restored} on Android`);
  /* Opaque black, written the way a 32-bit ARGB colour has to be written
   * in a language whose numbers are doubles: `| 0` is what makes
   * 0xFF000000 the negative jint the platform's int actually is. Without
   * it the value is 4278190080, which is not an int32 at all. Explicit,
   * because an application with no resource table declares no theme and
   * inherits no promise that the default text contrasts with the default
   * background. */
  label.setTextColor(0xFF000000 | 0);
  label.setTextSize(28);
  /* A modern Android window is edge to edge, so a full-screen view draws
   * its first line under the status bar. These insets are the
   * application's own numbers — `Gravity.CENTER` is projected now, but
   * referencing an INTEGER constant stops in the compiler while a
   * TypeScript `number` maps to f64 and the manifest correctly says i32. */
  label.setPadding(64, 420, 64, 64);
  activity.setContentView(label);

  Log.i("native-typescript", `onCreate ran ${restored} in ${activity.getLocalClassName()}`);
});
