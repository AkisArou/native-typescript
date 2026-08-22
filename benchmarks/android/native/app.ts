import {
  Activity,
  Button,
  ClickBridge,
  LinearLayout,
  Log,
  Rect,
  SystemClock,
  TextView,
  jlong,
} from "@native-typescript/jvm-android_benchmark";
import type {
  Bundle,
  JvmConnection,
} from "@native-typescript/jvm-android_benchmark";
import { applicationStart } from "@native-typescript/jvm-application";

/* Keep these literals in lockstep with the Kotlin baseline. The runner reads
 * both source files and refuses to measure if they differ. That makes the
 * workload an input rather than a convention two implementations may drift
 * away from independently. */
const WARMUP_SAMPLES = 3;
const MEASURED_SAMPLES = 7;
const LIGHT_OBJECT_ITERATIONS = 50000;
const CONSTRUCTOR_ITERATIONS = 2000;
const SETTER_ITERATIONS = 50000;
const CALLBACK_ITERATIONS = 50000;
const TREE_CHILDREN = 128;

const TAG = "nts-benchmark";
const registrations: JvmConnection[] = [];
const listeners: ClickBridge[] = [];

applicationStart();

function runConstructors(activity: Activity): number {
  let checksum = 0;
  let index = 0;
  while (index < CONSTRUCTOR_ITERATIONS) {
    const view = new TextView(activity);
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
    const rectangle = new Rect(0, 0, 1, 1);
    checksum += rectangle.width();
    index += 1;
  }
  return checksum;
}

function runSetters(activity: Activity): number {
  const view = new TextView(activity);
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
  Log.i(
    TAG,
    `sample implementation=native-typescript scenario=${scenario} ` +
      `sample=${sample} iterations=${iterations} elapsedNs=${elapsedNs} ` +
      `checksum=${checksum}`,
  );
}

export default class MainActivity extends Activity {
  private callbackCount = 0;

  override onCreate(state: Bundle | null): void {
    super.onCreate(state);

    const deliveredIntent = this.getIntent();
    const scenario = deliveredIntent === null
      ? null
      : deliveredIntent.getStringExtra("scenario");

    const content = new LinearLayout(this);
    content.setPadding(24, 180, 24, 24);
    content.setOrientation(LinearLayout.VERTICAL);

    const button = new Button(this);
    button.setText("Benchmark callback");
    const clicks = new ClickBridge();
    listeners.push(clicks);
    registrations.push(clicks.onClick(() => {
      this.callbackCount += 1;
    }));
    button.setOnClickListener(clicks);

    if (scenario === "light-object") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runLightObjects();
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runLightObjects();
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
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
        runConstructors(this);
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runConstructors(this);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
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
        runSetters(this);
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runSetters(this);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample("setter", sample, SETTER_ITERATIONS, elapsed, checksum);
        sample += 1;
      }
    } else if (scenario === "callback") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        this.callbackCount = 0;
        let index = 0;
        while (index < CALLBACK_ITERATIONS) {
          button.callOnClick();
          index += 1;
        }
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        this.callbackCount = 0;
        const started = SystemClock.elapsedRealtimeNanos();
        let index = 0;
        while (index < CALLBACK_ITERATIONS) {
          button.callOnClick();
          index += 1;
        }
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "callback",
          sample,
          CALLBACK_ITERATIONS,
          elapsed,
          this.callbackCount,
        );
        sample += 1;
      }
    } else {
      const started = SystemClock.elapsedRealtimeNanos();
      let index = 0;
      while (index < TREE_CHILDREN) {
        const child = new TextView(this);
        child.setTextSize(index & 1 ? 12 : 13);
        content.addView(child);
        index += 1;
      }
      const elapsed = jlong.toNumber(
        (SystemClock.elapsedRealtimeNanos() - started) as jlong,
      );
      logSample("view-tree", 0, TREE_CHILDREN, elapsed, TREE_CHILDREN);
    }

    const status = new TextView(this);
    status.setText(
      scenario === null
        ? "Native TypeScript benchmark ready"
        : `Native TypeScript ${scenario} complete`,
    );
    status.setTextColor(0xFF000000);
    status.setTextSize(20);
    content.addView(status);
    content.addView(button);
    this.setContentView(content);

    Log.i(
      TAG,
      `complete implementation=native-typescript scenario=${
        scenario === null ? "view-tree" : scenario
      }`,
    );
  }
}
