import {
  Activity,
  Button,
  ClickBridge,
  Gravity,
  LinearLayout,
  Log,
  System,
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
 * `this` is the managed peer associated with the receiver the platform
 * delivered. Its hidden strong handle keeps inherited calls available between
 * dispatches, while the generated Activity's peer slot lets distinct JNI
 * references for the same object recover this exact peer.
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
 * The tap count and lifecycle seed are ordinary instance fields. The click
 * closure captures the peer, so its later inherited calls and field writes
 * exercise the same lifetime edge as a normal application.
 */
const registrations: JvmConnection[] = [];
const listeners: ClickBridge[] = [];
applicationStart();

export default class MainActivity extends Activity {
  private taps = 0;
  private lifecycleSeed = 0;

  override onCreate(state: Bundle | null): void {
    /* The base implementation runs first, as every Android lifecycle
     * override must: an Activity that skips it throws SuperNotCalled
     * before it draws.
     *
     * An ordinary `super` call with nothing left to explain, which is the
     * point — this is the line the whole subclassing design was for. It
     * was spelled `ntsSuperOnCreate` for as long as nothing linked an
     * override to the binding that reaches what it replaced, and the class
     * had to name the GENERATED subclass as its base to see that method at
     * all. Both are gone: the manifest states the base call, and `this` is
     * typed from the registration, so the receiver is a MainActivity and
     * widens to Activity on the way in. */
    super.onCreate(state);

    const restored = state === null ? "fresh" : "restored";
    this.lifecycleSeed = 42;

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
      this.taps += 1;
      label.setText(
        `Tapped ${this.taps} time${this.taps === 1 ? "" : "s"}`,
      );
      Log.i("native-typescript", `tap ${this.taps}`);
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
    Log.i("native-typescript", `identity ${System.identityHashCode(this)}`);
  }

  /* A SECOND dispatch on the same instance, and that is its whole job.
   *
   * Two lifecycle callbacks arriving at one Activity is the shape a peer
   * must preserve: both must find the same peer, or a field written in
   * one and read in the other is gone. Nothing checked that the platform
   * even hands us ONE object across them — the assumption everything
   * about peers rests on, never stated and never tested.
   *
   * `identityHashCode` is how that is asked without comparing the
   * handles, which the compiler refuses today (SC1043) and which would be
   * the direct question. It is a ONE-SIDED instrument and worth saying so
   * where it is used: hash codes may collide, so a match is consistent
   * with one object rather than proof of it, while a mismatch is proof of
   * two. It cannot verify a peer; it can falsify the assumption a peer
   * would be built on. */
  override onStart(): void {
    super.onStart();
    Log.i("native-typescript", `identity ${System.identityHashCode(this)}`);
    Log.i("native-typescript", `peer ${this.lifecycleSeed}`);
    Log.i("native-typescript", "onStart ran");
  }
}
