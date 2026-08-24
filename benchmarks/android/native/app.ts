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
const STRING_OPERATION_ITERATIONS = 10000;
const ARRAY_OPERATION_ITERATIONS = 20000;
const ARRAY_PIPELINE_ITERATIONS = 20000;
const RECORD_OBJECT_ITERATIONS = 50000;
const OPTIONAL_VALUE_ITERATIONS = 50000;
const MAP_OPERATION_ITERATIONS = 50000;
const SET_OPERATION_ITERATIONS = 50000;
const MATH_OPERATION_ITERATIONS = 100000;
const NUMBER_PARSING_ITERATIONS = 50000;
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

interface BenchmarkRow {
  count: number;
  label: string;
  active: boolean;
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

function runStringOperations(value: string): number {
  let checksum = 0;
  let index = 0;
  while (index < STRING_OPERATION_ITERATIONS) {
    const trimmed = value.trim();
    const normalized = trimmed.toLowerCase();
    const segment = normalized.slice(0, 17);
    const padded = segment.padEnd(20, ".");
    checksum += segment.length;
    if (normalized.includes("typescript")) checksum += 1;
    checksum += trimmed.charCodeAt(18);
    checksum += padded.length;
    index += 1;
  }
  return checksum;
}

function runStringNormalize(value: string): number {
  let checksum = 0;
  let index = 0;
  while (index < STRING_OPERATION_ITERATIONS) {
    const normalized = value.trim().toLowerCase();
    checksum += normalized.length;
    index += 1;
  }
  return checksum;
}

function runStringSlice(value: string): number {
  let checksum = 0;
  let index = 0;
  while (index < STRING_OPERATION_ITERATIONS) {
    const segment = value.slice(0, 17);
    checksum += segment.length;
    index += 1;
  }
  return checksum;
}

function runStringPad(value: string): number {
  let checksum = 0;
  let index = 0;
  while (index < STRING_OPERATION_ITERATIONS) {
    const padded = value.padEnd(20, ".");
    checksum += padded.length;
    index += 1;
  }
  return checksum;
}

function runStringSearch(value: string): number {
  let checksum = 0;
  let index = 0;
  while (index < STRING_OPERATION_ITERATIONS) {
    if (value.includes("typescript")) checksum += 1;
    checksum += value.charCodeAt(18);
    index += 1;
  }
  return checksum;
}

function runArrayOperations(): number {
  let checksum = 0;
  let index = 0;
  while (index < ARRAY_OPERATION_ITERATIONS) {
    const values = [index & 255, 3, 5, 7];
    values.push(1024, 13);
    values[1] = 17;
    checksum += values.length;
    checksum += values[0]! + values[1]! + values[5]!;
    checksum += values.indexOf(1024);
    if (values.includes(13)) checksum += 1;
    checksum += values.pop()!;
    index += 1;
  }
  return checksum;
}

function runArrayPipeline(): number {
  let checksum = 0;
  let index = 0;
  while (index < ARRAY_PIPELINE_ITERATIONS) {
    const delta = index & 7;
    const result = [index & 255, 2, 3, 4]
      .map((value, position) => value * 2 + position + delta)
      .filter((value) => value > 7)
      .reduce((sum, value) => sum + value, 0);
    checksum += result;
    index += 1;
  }
  return checksum;
}

function runRecordObjects(): number {
  let checksum = 0;
  let index = 0;
  while (index < RECORD_OBJECT_ITERATIONS) {
    const row: BenchmarkRow = {
      label: index & 1 ? "alpha" : "Καλημέρα",
      count: index & 255,
      active: (index & 3) === 0,
    };
    row.count += row.label.length;
    if (row.active) row.count += 3;
    checksum += row.count;
    index += 1;
  }
  return checksum;
}

function maybeNumber(index: number): number | undefined {
  return (index & 3) === 0 ? undefined : index & 255;
}

function maybeLabel(index: number): string | undefined {
  return index & 1 ? "alpha" : undefined;
}

function runOptionalValues(): number {
  let checksum = 0;
  let index = 0;
  while (index < OPTIONAL_VALUE_ITERATIONS) {
    const numeric = maybeNumber(index);
    checksum += numeric === undefined ? 11 : numeric + 3;
    const label = maybeLabel(index);
    checksum += label === undefined ? 7 : label.length;
    index += 1;
  }
  return checksum;
}

function runMapOperations(): number {
  const keys = [
    "alpha", "beta", "gamma", "delta",
    "epsilon", "zeta", "eta", "theta",
    "iota", "kappa", "lambda", "mu",
    "nu", "xi", "omicron", "pi",
  ];
  const counts = new Map<string, number>();
  let checksum = 0;
  let index = 0;
  while (index < MAP_OPERATION_ITERATIONS) {
    const key = keys[index & 15]!;
    const previous = counts.get(key);
    const next = previous === undefined ? (index & 7) + 1 : previous + 1;
    counts.set(key, next);
    if ((index & 31) === 0) {
      const evictionKey = keys[(index >>> 5) & 15]!;
      if (counts.has(evictionKey)) checksum += 3;
      if (counts.delete(evictionKey)) checksum += 5;
      counts.set(evictionKey, next + 2);
    }
    checksum += next + counts.size;
    index += 1;
  }
  return checksum;
}

function runSetOperations(): number {
  const keys = [
    "alpha", "beta", "gamma", "delta",
    "epsilon", "zeta", "eta", "theta",
    "iota", "kappa", "lambda", "mu",
    "nu", "xi", "omicron", "pi",
  ];
  const active = new Set<string>();
  let checksum = 0;
  let index = 0;
  while (index < SET_OPERATION_ITERATIONS) {
    const key = keys[index & 15]!;
    if (!active.has(key)) {
      active.add(key);
      checksum += 1;
    }
    if ((index & 31) === 0) {
      const evictionKey = keys[(index >>> 5) & 15]!;
      if (active.has(evictionKey)) checksum += 3;
      if (active.delete(evictionKey)) checksum += 5;
      active.add(evictionKey);
    }
    if ((index & 255) === 0) {
      for (const member of active) checksum += member.length;
    }
    checksum += active.size;
    index += 1;
  }
  return checksum;
}

function runMathOperations(): number {
  let checksum = 0;
  let index = 0;
  while (index < MATH_OPERATION_ITERATIONS) {
    const value = ((index & 1_023) - 512) / 8 +
      (index & 1 ? 0.25 : -0.25);
    const minimum = Math.min(value, -value);
    const maximum = Math.max(value, -value);
    checksum += Math.floor(value);
    checksum += Math.ceil(value);
    checksum += Math.trunc(value);
    checksum += Math.round(value);
    checksum += Math.trunc(Math.abs(value));
    checksum += Math.trunc(minimum);
    checksum += Math.trunc(maximum);
    index += 1;
  }
  return checksum;
}

function runNumberParsing(): number {
  const integerInputs = [
    "0", "7", "42", "-17", "255", "1024", "6553", "-3276",
    "12345", "-7654", "2147", "-9999", "73", "8080", "-4096", "3141",
  ];
  const floatInputs = [
    "0.5", "-2.25", "3.125", "1e3", "-0.03125", "42.75", "512.5", "-128.125",
    "0.125", "64.875", "-16.5", "2048.25", "-4096.75", "7.5", "0e0", "123.375",
  ];
  const numberInputs = [
    "1.25", "-3.5", "6.125", "2.5e2", "-0.0625", "18.75", "256.25", "-64.5",
    "0.375", "32.625", "-8.25", "1024.5", "-2048.125", "15.875", "0.0", "61.25",
  ];
  let checksum = 0;
  let index = 0;
  while (index < NUMBER_PARSING_ITERATIONS) {
    const slot = index & 15;
    checksum += parseInt(integerInputs[slot]!, 10);
    checksum += parseFloat(floatInputs[slot]!) * 32;
    checksum += Number(numberInputs[slot]!) * 32;
    index += 1;
  }
  return checksum;
}

function runParseInt(): number {
  const inputs = [
    "0", "7", "42", "-17", "255", "1024", "6553", "-3276",
    "12345", "-7654", "2147", "-9999", "73", "8080", "-4096", "3141",
  ];
  let checksum = 0;
  let index = 0;
  while (index < NUMBER_PARSING_ITERATIONS) {
    checksum += parseInt(inputs[index & 15]!, 10);
    index += 1;
  }
  return checksum;
}

function runParseFloat(): number {
  const inputs = [
    "0.5", "-2.25", "3.125", "1e3", "-0.03125", "42.75", "512.5", "-128.125",
    "0.125", "64.875", "-16.5", "2048.25", "-4096.75", "7.5", "0e0", "123.375",
  ];
  let checksum = 0;
  let index = 0;
  while (index < NUMBER_PARSING_ITERATIONS) {
    checksum += parseFloat(inputs[index & 15]!) * 32;
    index += 1;
  }
  return checksum;
}

function runNumberFromString(): number {
  const inputs = [
    "1.25", "-3.5", "6.125", "2.5e2", "-0.0625", "18.75", "256.25", "-64.5",
    "0.375", "32.625", "-8.25", "1024.5", "-2048.125", "15.875", "0.0", "61.25",
  ];
  let checksum = 0;
  let index = 0;
  while (index < NUMBER_PARSING_ITERATIONS) {
    checksum += Number(inputs[index & 15]!) * 32;
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
    } else if (scenario === "string-operations") {
      const value = "  Native TypeScript Καλημέρα 👩‍💻 e\u0301  ";
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runStringOperations(value);
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runStringOperations(value);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "string-operations",
          sample,
          STRING_OPERATION_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (
      scenario === "string-normalize" ||
      scenario === "string-slice" ||
      scenario === "string-pad" ||
      scenario === "string-search"
    ) {
      const raw = "  Native TypeScript Καλημέρα 👩‍💻 e\u0301  ";
      const normalized = "native typescript καλημέρα 👩‍💻 e\u0301";
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        if (scenario === "string-normalize") {
          runStringNormalize(raw);
        } else if (scenario === "string-slice") {
          runStringSlice(normalized);
        } else if (scenario === "string-pad") {
          runStringPad("native typescript");
        } else {
          runStringSearch(normalized);
        }
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        let checksum = 0;
        if (scenario === "string-normalize") {
          checksum = runStringNormalize(raw);
        } else if (scenario === "string-slice") {
          checksum = runStringSlice(normalized);
        } else if (scenario === "string-pad") {
          checksum = runStringPad("native typescript");
        } else {
          checksum = runStringSearch(normalized);
        }
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          scenario,
          sample,
          STRING_OPERATION_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "array-operations") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runArrayOperations();
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runArrayOperations();
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "array-operations",
          sample,
          ARRAY_OPERATION_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "array-pipeline") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runArrayPipeline();
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runArrayPipeline();
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "array-pipeline",
          sample,
          ARRAY_PIPELINE_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "record-objects") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runRecordObjects();
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runRecordObjects();
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "record-objects",
          sample,
          RECORD_OBJECT_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "optional-values") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runOptionalValues();
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runOptionalValues();
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "optional-values",
          sample,
          OPTIONAL_VALUE_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "map-operations") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runMapOperations();
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runMapOperations();
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "map-operations",
          sample,
          MAP_OPERATION_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "set-operations") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runSetOperations();
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runSetOperations();
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "set-operations",
          sample,
          SET_OPERATION_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (scenario === "math-operations") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runMathOperations();
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runMathOperations();
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "math-operations",
          sample,
          MATH_OPERATION_ITERATIONS,
          elapsed,
          checksum,
        );
        sample += 1;
      }
    } else if (
      scenario === "number-parsing" ||
      scenario === "parse-int" ||
      scenario === "parse-float" ||
      scenario === "number-from-string"
    ) {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        if (scenario === "number-parsing") {
          runNumberParsing();
        } else if (scenario === "parse-int") {
          runParseInt();
        } else if (scenario === "parse-float") {
          runParseFloat();
        } else {
          runNumberFromString();
        }
        warmup += 1;
      }
      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        let checksum = 0;
        if (scenario === "number-parsing") {
          checksum = runNumberParsing();
        } else if (scenario === "parse-int") {
          checksum = runParseInt();
        } else if (scenario === "parse-float") {
          checksum = runParseFloat();
        } else {
          checksum = runNumberFromString();
        }
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          scenario,
          sample,
          NUMBER_PARSING_ITERATIONS,
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
