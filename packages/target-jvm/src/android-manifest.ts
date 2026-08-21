/**
 * Generates the AndroidManifest.xml an APK is built around.
 *
 * The manifest is not configuration the way a build file is: it is the
 * declaration ART reads to decide what the package IS — which class the
 * launcher constructs, which API levels the package claims, whether the
 * loader may map the native library straight out of the APK. Every field
 * this emits is one of those decisions, so each is named here rather than
 * defaulted somewhere a reader cannot see.
 *
 * What it deliberately does NOT emit is a resource reference. An
 * application with no resources needs no `@string/app_label`, and aapt2
 * accepts a manifest whose labels are literals — so the first Android
 * product carries no resource table at all, and the packaging graph has
 * one less stage whose failure would have nothing to do with the
 * crossing under test.
 */

export interface AndroidManifestSpecification {
  /** The application id: `com.example.demo`. Also the manifest package. */
  readonly applicationId: string;
  /** The launcher activity, as a binary name
   * (`com/example/demo/MainActivity`) — normally the generated bridge. */
  readonly activityBinaryName: string;
  /** What the package claims to run on, and what it was built against. */
  readonly minSdk: number;
  readonly targetSdk: number;
  /** Shown by the launcher. A literal, not a resource reference. */
  readonly label: string;
}

function activitySourceName(binaryName: string): string {
  return binaryName.replace(/\//gu, ".");
}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A package id ART will accept: dotted Java identifiers, at least two
 * segments — the platform refuses a single-segment application id. */
function validateApplicationId(applicationId: string): void {
  const segments = applicationId.split(".");
  if (
    segments.length < 2 ||
    segments.some((segment) => !identifierPattern.test(segment))
  ) {
    throw new Error(
      `Invalid Android application id '${applicationId}': it must be two or ` +
        "more dot-separated Java identifiers",
    );
  }
}

export function generateAndroidManifest(
  specification: AndroidManifestSpecification,
): string {
  validateApplicationId(specification.applicationId);
  const activity = activitySourceName(specification.activityBinaryName);
  if (!activity.startsWith(`${specification.applicationId}.`)) {
    /* ART resolves a relative `android:name` against the package, and an
     * absolute one must still be a class the APK contains. Requiring the
     * activity to live under the application id keeps one rule instead of
     * two and refuses the mistake — an Activity subclass generated into
     * the PLATFORM's package — at the point it is spelled. */
    throw new Error(
      `Activity '${activity}' is outside application id ` +
        `'${specification.applicationId}'; a generated Activity must be ` +
        "generated into a package the application owns",
    );
  }
  if (
    !Number.isInteger(specification.minSdk) ||
    !Number.isInteger(specification.targetSdk) ||
    specification.minSdk < 1 ||
    specification.targetSdk < specification.minSdk
  ) {
    throw new Error(
      `Invalid SDK range: minSdk ${specification.minSdk}, targetSdk ` +
        `${specification.targetSdk}`,
    );
  }
  /* extractNativeLibs="false" is the modern loading mode: the loader maps
   * the .so out of the APK rather than copying it to the app's data
   * directory, which is why the library must be STORED and page-aligned
   * in the zip. It is stated here because the manifest is where the
   * platform reads that decision — the alignment the packaging performs
   * is this declaration's other half. */
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
    `    package="${specification.applicationId}">`,
    `  <uses-sdk android:minSdkVersion="${specification.minSdk}"`,
    `      android:targetSdkVersion="${specification.targetSdk}" />`,
    '  <application android:hasCode="true"',
    '      android:extractNativeLibs="false"',
    `      android:label="${specification.label}">`,
    `    <activity android:name="${activity}"`,
    '        android:exported="true">',
    "      <intent-filter>",
    '        <action android:name="android.intent.action.MAIN" />',
    '        <category android:name="android.intent.category.LAUNCHER" />',
    "      </intent-filter>",
    "    </activity>",
    "  </application>",
    "</manifest>",
    "",
  ].join("\n");
}
