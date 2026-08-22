import {
  Button,
  ClickBridge,
  Gravity,
  LinearLayout,
  Log,
  MainActivity as GeneratedActivity,
  TextView,
} from "@native-typescript/jvm-android";
/* Type-only: a Bundle is never constructed or called here, it is only
 * received — the platform makes them. */
import type { Bundle, JvmConnection } from "@native-typescript/jvm-android";
import { applicationStart } from "@native-typescript/jvm-application";


/* A TypeScript Android application with a button that counts.
 *
 * THE ACTIVITY IS A CLASS THAT EXTENDS A PLATFORM CLASS, which is the
 * whole point of this file. Nothing here registers a handler, holds a
 * receiver, or names a lifecycle callback as a function argument: the
 * program says what an Android program says, and the registration the
 * platform needs is synthesized from the override.
 *
 * `this` IS the receiver — the same native handle a class-anchored
 * registration hands its handler as payload zero — so `new TextView(this)`
 * and `this.setContentView(...)` reach the platform through the identity
 * upcasts the manifest already carries. There is no peer object and no
 * second identity to keep in step.
 *
 * Nothing constructs this Activity. ART does, after reading the generated
 * manifest, and it calls onCreate on the main looper — which is why the
 * registration behind this override is anchored to the CLASS rather than
 * to an instance nobody can name yet, and why the library adopts the
 * thread that loaded it rather than spawning one. The registration is also
 * why the platform can call in before the module's own statements finish:
 * the library loads from the generated class's static initializer.
 *
 * THE LISTENER IS THE OPPOSITE CASE, and the contrast is the point. This
 * program constructs it, so it holds the instance and its registration
 * anchors to that instance the ordinary way. One generated Java class is
 * an Activity ART instantiates; the other implements an interface the
 * platform only ever calls. Same generator, different anchor, because the
 * difference is who owns the object rather than what it is.
 *
 * A REGISTRATION IS ANCHORED TO ITS RECEIVER, and that decides what this
 * program must keep. The listener object owns the registration, so a
 * ClickBridge that goes out of scope at the end of onCreate takes its
 * handler with it — Java still holds the object, and the native method is
 * still there, but the handler behind it is gone and the platform reports
 * "no TypeScript handler is registered" on the first tap. So both are held
 * at module scope: the listener because it owns the registration, and the
 * connection because releasing one cancels. That is the contract being
 * honest rather than a leak: a listener on a view the Activity owns should
 * live as long as the process, and saying so is the program's job.
 *
 * The tap count is a `let` inside the override rather than an instance
 * field. An instance field is exactly what needs a PEER — a second,
 * managed object whose lifetime the platform does not declare — and it
 * refuses by name until that policy exists. A local has no such question:
 * it lives in the closure the registration owns.
 */
const registrations: JvmConnection[] = [];
const listeners: ClickBridge[] = [];
applicationStart();

/* EXTENDS THE GENERATED CLASS, not `Activity`, and that is the one place
 * this program is still further from Java than it should be.
 *
 * `super.onCreate(state)` is the spelling this wants and it is not wired
 * yet, so reaching the base implementation goes through `ntsSuperOnCreate`
 * — a method the GENERATED subclass declares, not one `Activity` has. So
 * the base here has to be the generated class rather than the platform
 * one. The binding is found by declaration identity, `MainActivity.onCreate`,
 * which is the name this class carries either way, so the registration is
 * unaffected by which base is named.
 *
 * When `super` lands over a native base, this becomes
 * `class MainActivity extends Activity` with `super.onCreate(state)`, the
 * alias disappears, and the last divergence from the Java a person would
 * write goes with it. */
export default class MainActivity extends GeneratedActivity {
  override onCreate(state: Bundle | null): void {
    /* The base implementation runs first, as every Android lifecycle
     * override must: an Activity that skips it throws SuperNotCalled
     * before it draws. */
    this.ntsSuperOnCreate(state);

    const restored = state === null ? "fresh" : "restored";
    let taps = 0;

    const label = new TextView(this);
    label.setText(`Compiled TypeScript, ${restored} on Android`);
    label.setTextColor(0xFF000000);
    label.setTextSize(24);
    /* The constant comes from the platform's own class file: a static
     * final with a ConstantValue IS its value, so naming it costs no call
     * and the compiler carries the number the class file states. It is not
     * listed in the selection either — a constant comes with its class. */
    label.setGravity(Gravity.CENTER);

    const button = new Button(this);
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

    const content = new LinearLayout(this);
    /* A modern Android window is edge to edge: without an inset the first
     * child draws under the status and action bars, where a person can
     * neither read it nor tap it. Insetting the CONTAINER is where an
     * application puts that, rather than on each child. */
    content.setPadding(48, 420, 48, 48);
    content.setOrientation(LinearLayout.VERTICAL);
    content.addView(label);
    content.addView(button);
    this.setContentView(content);

    Log.i(
      "native-typescript",
      `onCreate ran ${restored} in ${this.getLocalClassName()}`,
    );
  }
}
