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
      ],
    },
  ],
  subclasses: [
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
