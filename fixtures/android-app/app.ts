import {
  Button,
  ClickBridge,
  Gravity,
  LinearLayout,
  Log,
  MainActivity,
  TextView,
} from "@native-typescript/jvm-android";
/* Type-only: a Bundle is never constructed or called here, it is only
 * received — the platform makes them. */
import type { Bundle, JvmConnection } from "@native-typescript/jvm-android";
import { applicationStart } from "@native-typescript/jvm-application";

/* A TypeScript Android application with a button that counts.
 *
 * Nothing here constructs the Activity. ART does, after reading the
 * generated manifest, and it calls onCreate on the main looper — which is
 * why that registration is anchored to the CLASS rather than to an
 * instance nobody can name yet, why the receiver arrives as the handler's
 * first argument, and why the library adopts the thread that loaded it
 * rather than spawning one.
 *
 * The LISTENER is the opposite case, and the contrast is the point: this
 * program constructs it, so it holds the instance and its registration
 * anchors to that instance the ordinary way. One generated Java class is
 * an Activity ART instantiates; the other implements an interface the
 * platform only ever calls. Same generator, different anchor, because the
 * difference is who owns the object rather than what it is.
 *
 * The count lives in an ordinary closure variable. That is worth noticing:
 * it is TypeScript state surviving across platform callbacks, held by the
 * closure the registration owns rather than by any Java field.
 *
 * A REGISTRATION IS ANCHORED TO ITS RECEIVER, and that decides what this
 * program must keep. The listener object owns the registration, so a
 * ClickBridge that goes out of scope at the end of onCreate takes its
 * handler with it — Java still holds the object, and the native method
 * is still there, but the handler behind it is gone and the platform
 * reports "no TypeScript handler is registered" on the first tap. So both
 * are held at module scope: the listener because it owns the
 * registration, and the connection because releasing one cancels.
 *
 * That is the contract being honest rather than a leak: a listener on a
 * view the Activity owns should live as long as the process, and saying
 * so is the program's job.
 */
const registrations: JvmConnection[] = [];
const listeners: ClickBridge[] = [];
applicationStart();

MainActivity.onCreate((activity, savedState: Bundle | null) => {
  /* The base implementation runs first, as every Android lifecycle
   * override must: an Activity that skips super throws before it draws. */
  activity.ntsSuperOnCreate(savedState);

  const restored = savedState === null ? "fresh" : "restored";
  let taps = 0;

  const label = new TextView(activity);
  label.setText(`Compiled TypeScript, ${restored} on Android`);
  label.setTextColor(0xFF000000);
  label.setTextSize(24);
  /* The constant comes from the platform's own class file: a static
   * final with a ConstantValue IS its value, so naming it costs no call
   * and the compiler carries the number the class file states. */
  label.setGravity(Gravity.CENTER);

  const button = new Button(activity);
  button.setText("Tap me");
  button.setTextSize(20);

  const clicks = new ClickBridge();
  listeners.push(clicks);
  registrations.push(clicks.onClick((view) => {
    taps += 1;
    label.setText(`Tapped ${taps} time${taps === 1 ? "" : "s"}`);
    Log.i("native-typescript", `tap ${taps}`);
    /* The payload is the View that was clicked, promoted into a managed
     * cell — proof it is a live object rather than a pointer that merely
     * survived the frame. */
    if (view === null) Log.i("native-typescript", "tap without a view");
  }));
  button.setOnClickListener(clicks);

  const content = new LinearLayout(activity);
  /* A modern Android window is edge to edge: without an inset the first
   * child draws under the status and action bars, where a person can
   * neither read it nor tap it. Insetting the CONTAINER is where an
   * application puts that, rather than on each child. */
  content.setPadding(48, 420, 48, 48);
  /* LinearLayout.VERTICAL is 1. The platform states that in a static
   * final, and this program cannot name it yet: an integer constant is
   * projected and translates, but referencing one stops in the compiler
   * while a TypeScript `number` maps to f64 and the manifest correctly
   * says i32. */
  content.setOrientation(1);
  content.addView(label);
  content.addView(button);
  activity.setContentView(content);

  Log.i("native-typescript", `onCreate ran ${restored} in ${activity.getLocalClassName()}`);
});
