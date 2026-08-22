import {
  Application,
  Placeholder,
  type CreateViewEventData,
} from "@nativescript/core";

/* Keep these literals in lockstep with the Native TypeScript and Kotlin
 * implementations. The runner reads all three source files and refuses to
 * measure if they differ. */
const WARMUP_SAMPLES = 3;
const MEASURED_SAMPLES = 7;
const LIGHT_OBJECT_ITERATIONS = 50000;
const CONSTRUCTOR_ITERATIONS = 2000;
const SETTER_ITERATIONS = 50000;
const CALLBACK_ITERATIONS = 50000;
const TREE_CHILDREN = 128;

const TAG = "nts-benchmark";
let callbackCount = 0;
let retainedListener: android.view.View.OnClickListener | null = null;

function runConstructors(activity: android.app.Activity): number {
  let checksum = 0;
  let index = 0;
  while (index < CONSTRUCTOR_ITERATIONS) {
    const view = new android.widget.TextView(activity);
    view.setMinimumHeight(index & 1);
    checksum += index & 1;
    index += 1;
  }
  return checksum;
}

function runLightObjects(): number {
  let checksum = 0;
  let index = 0;
  while (index < LIGHT_OBJECT_ITERATIONS) {
    const rectangle = new android.graphics.Rect(0, 0, 1, 1);
    checksum += rectangle.width();
    index += 1;
  }
  return checksum;
}

function runSetters(activity: android.app.Activity): number {
  const view = new android.widget.TextView(activity);
  let checksum = 0;
  let index = 0;
  while (index < SETTER_ITERATIONS) {
    view.setTextSize(index & 1 ? 12 : 13);
    checksum += index & 1;
    index += 1;
  }
  return checksum;
}

function logSample(
  scenario: string,
  sample: number,
  iterations: number,
  elapsedNs: number,
  checksum: number,
): void {
  android.util.Log.i(
    TAG,
    `sample implementation=nativescript scenario=${scenario} ` +
      `sample=${sample} iterations=${iterations} elapsedNs=${elapsedNs} ` +
      `checksum=${checksum}`,
  );
}

function buildBenchmarkView(context: android.content.Context): android.view.View {
  const activity = context as android.app.Activity;
  const scenario = activity.getIntent()?.getStringExtra("scenario") ?? null;
  const content = new android.widget.LinearLayout(activity);
  content.setPadding(24, 180, 24, 24);
  content.setOrientation(android.widget.LinearLayout.VERTICAL);

  const button = new android.widget.Button(activity);
  button.setText("Benchmark callback");
  retainedListener = new android.view.View.OnClickListener({
    onClick: () => {
      callbackCount += 1;
    },
  });
  button.setOnClickListener(retainedListener);

  if (scenario === "light-object") {
    let warmup = 0;
    while (warmup < WARMUP_SAMPLES) {
      runLightObjects();
      warmup += 1;
    }
    let sample = 0;
    while (sample < MEASURED_SAMPLES) {
      const started = android.os.SystemClock.elapsedRealtimeNanos();
      const checksum = runLightObjects();
      const elapsed = android.os.SystemClock.elapsedRealtimeNanos() - started;
      logSample(
        "light-object",
        sample,
        LIGHT_OBJECT_ITERATIONS,
        elapsed,
        checksum,
      );
      sample += 1;
    }
  } else if (scenario === "constructor") {
    let warmup = 0;
    while (warmup < WARMUP_SAMPLES) {
      runConstructors(activity);
      warmup += 1;
    }
    let sample = 0;
    while (sample < MEASURED_SAMPLES) {
      const started = android.os.SystemClock.elapsedRealtimeNanos();
      const checksum = runConstructors(activity);
      const elapsed = android.os.SystemClock.elapsedRealtimeNanos() - started;
      logSample(
        "constructor",
        sample,
        CONSTRUCTOR_ITERATIONS,
        elapsed,
        checksum,
      );
      sample += 1;
    }
  } else if (scenario === "setter") {
    let warmup = 0;
    while (warmup < WARMUP_SAMPLES) {
      runSetters(activity);
      warmup += 1;
    }
    let sample = 0;
    while (sample < MEASURED_SAMPLES) {
      const started = android.os.SystemClock.elapsedRealtimeNanos();
      const checksum = runSetters(activity);
      const elapsed = android.os.SystemClock.elapsedRealtimeNanos() - started;
      logSample("setter", sample, SETTER_ITERATIONS, elapsed, checksum);
      sample += 1;
    }
  } else if (scenario === "callback") {
    let warmup = 0;
    while (warmup < WARMUP_SAMPLES) {
      callbackCount = 0;
      let index = 0;
      while (index < CALLBACK_ITERATIONS) {
        button.callOnClick();
        index += 1;
      }
      warmup += 1;
    }
    let sample = 0;
    while (sample < MEASURED_SAMPLES) {
      callbackCount = 0;
      const started = android.os.SystemClock.elapsedRealtimeNanos();
      let index = 0;
      while (index < CALLBACK_ITERATIONS) {
        button.callOnClick();
        index += 1;
      }
      const elapsed = android.os.SystemClock.elapsedRealtimeNanos() - started;
      logSample(
        "callback",
        sample,
        CALLBACK_ITERATIONS,
        elapsed,
        callbackCount,
      );
      sample += 1;
    }
  } else {
    const started = android.os.SystemClock.elapsedRealtimeNanos();
    let index = 0;
    while (index < TREE_CHILDREN) {
      const child = new android.widget.TextView(activity);
      child.setTextSize(index & 1 ? 12 : 13);
      content.addView(child);
      index += 1;
    }
    const elapsed = android.os.SystemClock.elapsedRealtimeNanos() - started;
    logSample("view-tree", 0, TREE_CHILDREN, elapsed, TREE_CHILDREN);
  }

  const status = new android.widget.TextView(activity);
  status.setText(
    scenario === null
      ? "NativeScript benchmark ready"
      : `NativeScript ${scenario} complete`,
  );
  status.setTextColor(0xFF000000);
  status.setTextSize(20);
  content.addView(status);
  content.addView(button);

  android.util.Log.i(
    TAG,
    `complete implementation=nativescript scenario=${scenario ?? "view-tree"}`,
  );
  return content;
}

const root = new Placeholder();
root.on("creatingView", (event: CreateViewEventData) => {
  if (event.context === undefined) {
    throw new Error("NativeScript supplied no Android context for the root view");
  }
  event.view = buildBenchmarkView(event.context as android.content.Context);
});

Application.run({ create: () => root });
