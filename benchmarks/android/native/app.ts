import {
  Activity,
  Base64,
  Button,
  ClickBridge,
  LinearLayout,
  Log,
  Rect,
  SystemClock,
  TextUtils,
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
const MANAGED_CLASS_ITERATIONS = 100000;
const CONSTRUCTOR_ITERATIONS = 2000;
const SETTER_ITERATIONS = 50000;
const CALLBACK_ITERATIONS = 50000;
const STRING_ARGUMENT_ITERATIONS = 20000;
const STRING_RESULT_ITERATIONS = 10000;
const BYTE_ARRAY_ITERATIONS = 2000;
const BYTE_ARRAY_LENGTH = 256;
const HANDLE_RESULT_ITERATIONS = 32000;
const HANDLE_RESULT_CHILDREN = 16;
const CALLBACK_PAYLOAD_ITERATIONS = 20000;
const CALLBACK_CAPTURE_ITERATIONS = 20000;
const TEXT_UPDATE_ITERATIONS = 10000;
const SCREEN_BUILD_ROWS = 32;
const TREE_CHILDREN = 128;

const TAG = "nts-benchmark";
const registrations: JvmConnection[] = [];
const listeners: ClickBridge[] = [];

applicationStart();

class ManagedCounterBase {
  protected value = 7;

  step(): number {
    this.value = ((this.value << 5) ^ (this.value >>> 2) ^ 17) & 1023;
    return this.value;
  }
}

class ManagedCounter extends ManagedCounterBase {
  private bonus = 1;

  override step(): number {
    return super.step() + this.bonus;
  }
}

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

function runManagedClasses(): number {
  const counter: ManagedCounterBase = new ManagedCounter();
  let checksum = 0;
  let index = 0;
  while (index < MANAGED_CLASS_ITERATIONS) {
    checksum += counter.step();
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

function runStringArguments(): number {
  const asciiLeft = "settings/profile/42";
  const asciiRight = "settings/profile/42";
  const unicodeLeft = "Καλημέρα 👩‍💻 e\u0301";
  const unicodeRight = "Καλημέρα 👩‍💻 e\u0301";
  let checksum = 0;
  let index = 0;
  while (index < STRING_ARGUMENT_ITERATIONS) {
    const equal = index & 1
      ? TextUtils.equals(asciiLeft, asciiRight)
      : TextUtils.equals(unicodeLeft, unicodeRight);
    if (equal) checksum += 1;
    index += 1;
  }
  return checksum;
}

function runStringResults(rectangle: Rect): number {
  let checksum = 0;
  let index = 0;
  while (index < STRING_RESULT_ITERATIONS) {
    checksum += rectangle.flattenToString().length;
    index += 1;
  }
  return checksum;
}

function runByteArrays(input: Uint8Array): number {
  let checksum = 0;
  let index = 0;
  while (index < BYTE_ARRAY_ITERATIONS) {
    checksum += Base64.encode(input, 2).length;
    index += 1;
  }
  return checksum;
}

function buildHandleResultContainer(activity: Activity): LinearLayout {
  const container = new LinearLayout(activity);
  let index = 0;
  while (index < HANDLE_RESULT_CHILDREN) {
    const child = new TextView(activity);
    child.setId(index + 1);
    container.addView(child);
    index += 1;
  }
  return container;
}

function runHandleResults(container: LinearLayout): number {
  let checksum = 0;
  let index = 0;
  while (index < HANDLE_RESULT_ITERATIONS) {
    const child = container.getChildAt(index & (HANDLE_RESULT_CHILDREN - 1));
    if (child !== null) checksum += child.getId();
    index += 1;
  }
  return checksum;
}

function runTextUpdates(activity: Activity): number {
  const view = new TextView(activity);
  let checksum = 0;
  let index = 0;
  while (index < TEXT_UPDATE_ITERATIONS) {
    const text = `Count: ${index & 1023}`;
    view.setText(text);
    checksum += text.length;
    index += 1;
  }
  return checksum;
}

function runScreenBuild(activity: Activity): number {
  const screen = new LinearLayout(activity);
  screen.setOrientation(LinearLayout.VERTICAL);
  let checksum = 0;
  let index = 0;
  while (index < SCREEN_BUILD_ROWS) {
    const row = new LinearLayout(activity);
    row.setOrientation(LinearLayout.HORIZONTAL);
    const title = new TextView(activity);
    const titleText = `Item ${index}`;
    title.setText(titleText);
    title.setMinimumHeight(48 + (index & 1));
    const action = new Button(activity);
    const actionText = `Open ${index}`;
    action.setText(actionText);
    row.addView(title);
    row.addView(action);
    screen.addView(row);
    checksum += titleText.length + actionText.length;
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
  private callbackPayloadChecksum = 0;
  private callbackCaptureChecksum = 0;

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
    registrations.push(clicks.onClick((_view) => {
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
    } else if (scenario === "managed-class") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runManagedClasses();
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runManagedClasses();
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "managed-class",
          sample,
          MANAGED_CLASS_ITERATIONS,
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
    } else if (scenario === "string-argument") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runStringArguments();
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runStringArguments();
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "string-argument",
          sample,
          STRING_ARGUMENT_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "string-result") {
      const rectangle = new Rect(1, 2, 11, 22);
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runStringResults(rectangle);
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runStringResults(rectangle);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "string-result",
          sample,
          STRING_RESULT_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "byte-array") {
      const input = new Uint8Array(BYTE_ARRAY_LENGTH);
      let inputIndex = 0;
      while (inputIndex < BYTE_ARRAY_LENGTH) {
        input[inputIndex] = inputIndex & 127;
        inputIndex += 1;
      }
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runByteArrays(input);
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runByteArrays(input);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "byte-array",
          sample,
          BYTE_ARRAY_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "handle-result") {
      const container = buildHandleResultContainer(this);
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runHandleResults(container);
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runHandleResults(container);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "handle-result",
          sample,
          HANDLE_RESULT_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "callback-payload") {
      const payloadButton = new Button(this);
      payloadButton.setId(7);
      const payloadClicks = new ClickBridge();
      listeners.push(payloadClicks);
      registrations.push(payloadClicks.onClick((view) => {
        if (view !== null) this.callbackPayloadChecksum += view.getId();
      }));
      payloadButton.setOnClickListener(payloadClicks);
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        this.callbackPayloadChecksum = 0;
        let index = 0;
        while (index < CALLBACK_PAYLOAD_ITERATIONS) {
          payloadButton.callOnClick();
          index += 1;
        }
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        this.callbackPayloadChecksum = 0;
        const started = SystemClock.elapsedRealtimeNanos();
        let index = 0;
        while (index < CALLBACK_PAYLOAD_ITERATIONS) {
          payloadButton.callOnClick();
          index += 1;
        }
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "callback-payload",
          sample,
          CALLBACK_PAYLOAD_ITERATIONS,
          elapsed,
          this.callbackPayloadChecksum,
        );
        sample += 1;
      }
    } else if (scenario === "callback-capture") {
      const captureButton = new Button(this);
      captureButton.setId(7);
      const capturedTarget = new Button(this);
      capturedTarget.setId(11);
      const captureClicks = new ClickBridge();
      listeners.push(captureClicks);
      registrations.push(captureClicks.onClick((view) => {
        if (view !== null) {
          this.callbackCaptureChecksum += view.getId() + capturedTarget.getId();
        }
      }));
      captureButton.setOnClickListener(captureClicks);
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        this.callbackCaptureChecksum = 0;
        let index = 0;
        while (index < CALLBACK_CAPTURE_ITERATIONS) {
          captureButton.callOnClick();
          index += 1;
        }
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        this.callbackCaptureChecksum = 0;
        const started = SystemClock.elapsedRealtimeNanos();
        let index = 0;
        while (index < CALLBACK_CAPTURE_ITERATIONS) {
          captureButton.callOnClick();
          index += 1;
        }
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "callback-capture",
          sample,
          CALLBACK_CAPTURE_ITERATIONS,
          elapsed,
          this.callbackCaptureChecksum,
        );
        sample += 1;
      }
    } else if (scenario === "text-update") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runTextUpdates(this);
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runTextUpdates(this);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "text-update",
          sample,
          TEXT_UPDATE_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "screen-build") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runScreenBuild(this);
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runScreenBuild(this);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "screen-build",
          sample,
          SCREEN_BUILD_ROWS,
          elapsed,
          checksum,
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
