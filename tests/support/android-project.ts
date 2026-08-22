/**
 * The Android acceptance application, described once.
 *
 * Two lanes build it: one asks what the PACKAGE says about itself, the
 * other asks whether it RUNS. They must be the same application for
 * either answer to mean anything about the other, so the description
 * lives here rather than being written twice and drifting.
 */

/** The API level the NDK toolchain targets and the manifest claims. */
export const ANDROID_API = 35;

export const androidProject = {
  name: "android-app",
  entry: "app.ts",
  output: "ntsdemo",
  packageSlug: "android",
  classes: [
    /* NOTHING here names an ancestor. A class's superclass chain comes
     * with it — `Activity` brings ContextThemeWrapper, ContextWrapper,
     * Context and Object; `Bundle` brings BaseBundle — because a class
     * cannot BE itself without the chain above it, and an ancestor with
     * no selected members costs one handle type and no generated C. What
     * is listed below is surface this application actually calls. */
    /* Bundle is the payload onCreate is handed. */
    { binaryName: "android/os/Bundle" },
    /* The view surface a visible application needs. View is named for its
     * own members rather than for TextView's sake — the ancestry would
     * arrive either way; setOnClickListener and setPadding would not. */
    {
      binaryName: "android/view/View",
      methods: [
        {
          name: "setOnClickListener",
          descriptor: "(Landroid/view/View$OnClickListener;)V",
        },
        /* Declared on View, so every widget inherits it through the
         * upcast chain — which is why it is selected HERE rather than on
         * each descendant that uses it. */
        { name: "setPadding", descriptor: "(IIII)V" },
      ],
    },
    /* The listener INTERFACE, selected so a generated implementation can
     * be passed where it is expected: at the ABI a jobject is a jobject,
     * and the identity upcast is what says so in the manifest. */
    { binaryName: "android/view/View$OnClickListener" },
    /* Only its constructor: setText and setTextSize are declared on
     * TextView, and inherited surface comes from selecting the ancestor
     * rather than restating it on every descendant. */
    {
      binaryName: "android/widget/Button",
      constructors: ["(Landroid/content/Context;)V"],
    },
    /* LinearLayout holds the label and the button; ViewGroup is its
     * superclass and addView is where a child goes. */
    {
      binaryName: "android/view/ViewGroup",
      methods: [{ name: "addView", descriptor: "(Landroid/view/View;)V" }],
    },
    {
      binaryName: "android/widget/LinearLayout",
      constructors: ["(Landroid/content/Context;)V"],
      methods: [{ name: "setOrientation", descriptor: "(I)V" }],
    },
    {
      binaryName: "android/widget/TextView",
      constructors: ["(Landroid/content/Context;)V"],
      methods: [
        { name: "setText", descriptor: "(Ljava/lang/CharSequence;)V" },
        /* An application with no resource table declares no theme, so the
         * platform's default text colour need not contrast with the
         * default window background — the first run put the right words
         * on the screen in a colour that could not be read. Setting them
         * explicitly is the application's business, and both are ordinary
         * scalar arguments. */
        { name: "setTextColor", descriptor: "(I)V" },
        { name: "setTextSize", descriptor: "(F)V" },
        /* A modern Android window is edge to edge, so a full-screen view
         * draws its first line UNDER the status bar. Centring is what
         * puts the text where a person can read it. */
        { name: "setGravity", descriptor: "(I)V" },
      ],
    },
    /* Selected for its constants, and NOT listing them. The platform
     * states what CENTER means, and a program spelling 17 itself would
     * repeat a fact the class file already carries; a static final with a
     * ConstantValue IS its value, so it costs no call and no generated C
     * and therefore arrives with the class. Naming `fields: ["CENTER"]`
     * here would still work and would now be an assertion that it must
     * project — worth doing where a program depends on one surviving a
     * platform version, and bookkeeping where it does not. */
    { binaryName: "android/view/Gravity" },
    {
      binaryName: "android/util/Log",
      methods: [{ name: "i", descriptor: "(Ljava/lang/String;Ljava/lang/String;)I" }],
    },
    /* Selected so the SAME object can be observed twice. Two lifecycle
     * dispatches on one Activity is the shape a peer must preserve — both
     * must find one peer — and nothing checked that the platform even
     * delivers one object across them. `identityHashCode` is how that is
     * asked without comparing handles, which the compiler refuses today. */
    {
      binaryName: "java/lang/System",
      methods: [
        { name: "identityHashCode", descriptor: "(Ljava/lang/Object;)I" },
      ],
    },
    {
      binaryName: "android/app/Activity",
      constructors: ["()V"],
      methods: [
        { name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" },
        { name: "onStart", descriptor: "()V" },
        { name: "getLocalClassName", descriptor: "()Ljava/lang/String;" },
        { name: "setContentView", descriptor: "(Landroid/view/View;)V" },
      ],
    },
  ],
  subclasses: [
    /* A generated implementation of the platform's listener interface.
     * The program CONSTRUCTS this one, so its registration anchors to the
     * instance it holds — unlike the Activity, which ART constructs. */
    {
      baseBinaryName: "android/view/View$OnClickListener",
      overrides: [{ name: "onClick", descriptor: "(Landroid/view/View;)V" }],
      subclassBinaryName: "com/example/ntsdemo/ClickBridge",
    },
    {
      baseBinaryName: "android/app/Activity",
      overrides: [
        { name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" },
        /* A SECOND dispatch on the same instance. Its only job is to be a
         * second place the same object arrives. */
        { name: "onStart", descriptor: "()V" },
      ],
      /* NOT the base's package: Android refuses to load application
       * classes defined in android.*, so the Activity is generated into
       * a package the application owns. */
      subclassBinaryName: "com/example/ntsdemo/MainActivity",
      /* ART constructs this Activity, so its lifecycle registrations
       * answer for the class rather than for an instance nobody holds. */
      anchor: "class" as const,
      /* The platform constructs this class, so its own initializer is
       * the only place the native half can be loaded in time. */
      loadLibrary: "ntsdemo",
    },
  ],
  android: {
    applicationId: "com.example.ntsdemo",
    activityBinaryName: "com/example/ntsdemo/MainActivity",
    label: "NTS Demo",
    minSdk: ANDROID_API,
    targetSdk: 36,
    abi: "x86_64",
  },
  target: {
    triple: `x86_64-linux-android${ANDROID_API}`,
    executionPlatform: "x86_64-linux",
  },
  sdk: {
    vendor: "google",
    name: "android",
    version: `${ANDROID_API}`,
    deploymentTarget: `${ANDROID_API}`,
  },
} as const;
