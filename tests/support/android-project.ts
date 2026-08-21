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

/* The Activity's ancestry, which ingestion requires to be selected rather
 * than inferred: a class whose superclass is present among the sources but
 * absent from the selection is a silent-ancestry error by design. */
const activityChain = [
  { binaryName: "java/lang/Object" },
  { binaryName: "android/content/Context" },
  { binaryName: "android/content/ContextWrapper" },
  { binaryName: "android/view/ContextThemeWrapper" },
];

export const androidProject = {
  name: "android-app",
  entry: "app.ts",
  output: "ntsdemo",
  packageSlug: "android",
  classes: [
    ...activityChain,
    /* Bundle is the payload onCreate is handed, so the selection must
     * project it — and BaseBundle with it, because ingestion refuses a
     * class whose superclass is present among the sources but absent
     * from the selection rather than inventing an ancestry. */
    { binaryName: "android/os/BaseBundle" },
    { binaryName: "android/os/Bundle" },
    /* The view surface a visible application needs: a View to hand to
     * setContentView, and a TextView to put a word in. TextView extends
     * View, and ingestion requires a class's superclass to be selected
     * rather than inferred, so both are named. */
    {
      binaryName: "android/view/View",
      methods: [
        {
          name: "setOnClickListener",
          descriptor: "(Landroid/view/View$OnClickListener;)V",
        },
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
         * draws its first line UNDER the status bar. Insetting it is the
         * application's own choice of numbers, which is why it can be
         * written here while `Gravity.CENTER` cannot: an INTEGER constant
         * is projected and translates, but a program that references one
         * stops in the compiler, because a TypeScript `number` maps to
         * f64 and the manifest correctly says i32. Reported; a double
         * constant works today, and this flips when the integer rule
         * lands. */
        { name: "setPadding", descriptor: "(IIII)V" },
      ],
    },
    {
      binaryName: "android/util/Log",
      methods: [{ name: "i", descriptor: "(Ljava/lang/String;Ljava/lang/String;)I" }],
    },
    {
      binaryName: "android/app/Activity",
      constructors: ["()V"],
      methods: [
        { name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" },
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
      overrides: [{ name: "onCreate", descriptor: "(Landroid/os/Bundle;)V" }],
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
