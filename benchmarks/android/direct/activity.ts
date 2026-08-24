import { Activity } from "@native-typescript/jvm-android_benchmark";
import { Button } from "@native-typescript/jvm-android_benchmark";
import { ClickBridge } from "@native-typescript/jvm-android_benchmark";
import { LinearLayout } from "@native-typescript/jvm-android_benchmark";
import { Log } from "@native-typescript/jvm-android_benchmark";
import { Rect } from "@native-typescript/jvm-android_benchmark";
import { SystemClock } from "@native-typescript/jvm-android_benchmark";
import { TextView } from "@native-typescript/jvm-android_benchmark";
import { jlong } from "@native-typescript/jvm-android_benchmark";
import type { Bundle } from "@native-typescript/jvm-android_benchmark";
import { runArrayOperationWorkload } from "./array-operations.js";
import { runArrayPipelineWorkload } from "./array-pipeline.js";
import { runByteArrayWorkload } from "./byte-array.js";
import { runConstructorWorkload } from "./constructor.js";
import { runHandleResultWorkload } from "./handle-result.js";
import { runLightObjectWorkload } from "./light-object.js";
import { runManagedClassWorkload } from "./managed-class.js";
import { runMapOperationWorkload } from "./map-operations.js";
import { runMathOperationWorkload } from "./math-operations.js";
import { runNumberParsingWorkload } from "./number-parsing.js";
import { runOptionalValueWorkload } from "./optional-values.js";
import { runRecordObjectWorkload } from "./record-objects.js";
import { runSetOperationWorkload } from "./set-operations.js";
import { runSetterWorkload } from "./setter.js";
import { runScreenBuildWorkload } from "./screen-build.js";
import { runStringArgumentWorkload } from "./string-argument.js";
import { runStringOperationWorkload } from "./string-operations.js";
import { runStringResultWorkload } from "./string-result.js";
import { runTextUpdateWorkload } from "./text-update.js";

const WARMUP_SAMPLES = 3;
const MEASURED_SAMPLES = 7;
const LIGHT_OBJECT_ITERATIONS = 50000;
const MANAGED_CLASS_ITERATIONS = 100000;
const SETTER_ITERATIONS = 50000;
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
const CALLBACK_ITERATIONS = 50000;
const CALLBACK_PAYLOAD_ITERATIONS = 20000;
const CALLBACK_CAPTURE_ITERATIONS = 20000;
const CONSTRUCTOR_ITERATIONS = 2000;
const TEXT_UPDATE_ITERATIONS = 10000;
const SCREEN_BUILD_ROWS = 32;
const TREE_CHILDREN = 128;
const TAG = "nts-benchmark";

/** The parameters keep javac from treating these as interned constant
 * expressions. Each call therefore creates a separate Java String before
 * the timed region, matching the Kotlin and Java controls. */
function joinText(left: string, right: string): string {
  return left + right;
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

function logSample(
  scenario: string,
  iterations: number,
  sample: number,
  elapsedNs: number,
  checksum: number,
): void {
  Log.i(
    TAG,
    `sample implementation=native-typescript-jvm scenario=${scenario} ` +
      `sample=${sample} iterations=${iterations} ` +
      `elapsedNs=${elapsedNs} checksum=${checksum}`,
  );
}

/** The platform-created benchmark receiver and every measured workload are
 * emitted wholly from checked TypeScript into ordinary JVM classes. */
export default class MainActivity extends Activity {
  private completedSamples = 0;

  override onCreate(state: Bundle | null): void {
    super.onCreate(state);

    const deliveredIntent = this.getIntent();
    const scenario = deliveredIntent === null
      ? null
      : deliveredIntent.getStringExtra("scenario");
    if (scenario === null) {
      const content = new LinearLayout(this);
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
      logSample("view-tree", TREE_CHILDREN, 0, elapsed, TREE_CHILDREN);
      this.completedSamples += 1;
      this.setContentView(content);
      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=view-tree",
      );
      return;
    }

    if (scenario === "light-object") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runLightObjectWorkload(LIGHT_OBJECT_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runLightObjectWorkload(LIGHT_OBJECT_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "light-object",
          LIGHT_OBJECT_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=light-object",
      );
    } else if (scenario === "managed-class") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runManagedClassWorkload(MANAGED_CLASS_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runManagedClassWorkload(MANAGED_CLASS_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "managed-class",
          MANAGED_CLASS_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=managed-class",
      );
    } else if (scenario === "constructor") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runConstructorWorkload(this, CONSTRUCTOR_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runConstructorWorkload(this, CONSTRUCTOR_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "constructor",
          CONSTRUCTOR_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=constructor",
      );
    } else if (scenario === "setter") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runSetterWorkload(this, SETTER_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runSetterWorkload(this, SETTER_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "setter",
          SETTER_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=setter",
      );
    } else if (scenario === "string-argument") {
      const asciiLeft = joinText("settings/", "profile/42");
      const asciiRight = joinText("settings/profile/", "42");
      const unicodeLeft = joinText("Καλημέρα ", "👩‍💻 e\u0301");
      const unicodeRight = joinText("Καλημέρα 👩‍💻 ", "e\u0301");

      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runStringArgumentWorkload(
          asciiLeft,
          asciiRight,
          unicodeLeft,
          unicodeRight,
          STRING_ARGUMENT_ITERATIONS,
        );
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runStringArgumentWorkload(
          asciiLeft,
          asciiRight,
          unicodeLeft,
          unicodeRight,
          STRING_ARGUMENT_ITERATIONS,
        );
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "string-argument",
          STRING_ARGUMENT_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=string-argument",
      );
    } else if (scenario === "string-result") {
      const rectangle = new Rect(1, 2, 11, 22);
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runStringResultWorkload(rectangle, STRING_RESULT_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runStringResultWorkload(
          rectangle,
          STRING_RESULT_ITERATIONS,
        );
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "string-result",
          STRING_RESULT_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=string-result",
      );
    } else if (scenario === "string-operations") {
      const value = "  Native TypeScript Καλημέρα 👩‍💻 e\u0301  ";
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runStringOperationWorkload(value, STRING_OPERATION_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runStringOperationWorkload(
          value,
          STRING_OPERATION_ITERATIONS,
        );
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "string-operations",
          STRING_OPERATION_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=string-operations",
      );
    } else if (scenario === "array-operations") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runArrayOperationWorkload(ARRAY_OPERATION_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runArrayOperationWorkload(ARRAY_OPERATION_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "array-operations",
          ARRAY_OPERATION_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=array-operations",
      );
    } else if (scenario === "array-pipeline") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runArrayPipelineWorkload(ARRAY_PIPELINE_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runArrayPipelineWorkload(ARRAY_PIPELINE_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "array-pipeline",
          ARRAY_PIPELINE_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=array-pipeline",
      );
    } else if (scenario === "record-objects") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runRecordObjectWorkload(RECORD_OBJECT_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runRecordObjectWorkload(RECORD_OBJECT_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "record-objects",
          RECORD_OBJECT_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=record-objects",
      );
    } else if (scenario === "optional-values") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runOptionalValueWorkload(OPTIONAL_VALUE_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runOptionalValueWorkload(OPTIONAL_VALUE_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "optional-values",
          OPTIONAL_VALUE_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=optional-values",
      );
    } else if (scenario === "map-operations") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runMapOperationWorkload(MAP_OPERATION_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runMapOperationWorkload(MAP_OPERATION_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "map-operations",
          MAP_OPERATION_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=map-operations",
      );
    } else if (scenario === "set-operations") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runSetOperationWorkload(SET_OPERATION_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runSetOperationWorkload(SET_OPERATION_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "set-operations",
          SET_OPERATION_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=set-operations",
      );
    } else if (scenario === "math-operations") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runMathOperationWorkload(MATH_OPERATION_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runMathOperationWorkload(MATH_OPERATION_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "math-operations",
          MATH_OPERATION_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=math-operations",
      );
    } else if (scenario === "number-parsing") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runNumberParsingWorkload(NUMBER_PARSING_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runNumberParsingWorkload(NUMBER_PARSING_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "number-parsing",
          NUMBER_PARSING_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=number-parsing",
      );
    } else if (scenario === "byte-array") {
      const input = new Uint8Array(BYTE_ARRAY_LENGTH);
      let inputIndex = 0;
      while (inputIndex < BYTE_ARRAY_LENGTH) {
        input[inputIndex] = inputIndex & 127;
        inputIndex += 1;
      }

      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runByteArrayWorkload(input, BYTE_ARRAY_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runByteArrayWorkload(input, BYTE_ARRAY_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "byte-array",
          BYTE_ARRAY_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=byte-array",
      );
    } else if (scenario === "handle-result") {
      const container = buildHandleResultContainer(this);
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runHandleResultWorkload(
          container,
          HANDLE_RESULT_ITERATIONS,
          HANDLE_RESULT_CHILDREN,
        );
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runHandleResultWorkload(
          container,
          HANDLE_RESULT_ITERATIONS,
          HANDLE_RESULT_CHILDREN,
        );
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "handle-result",
          HANDLE_RESULT_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=handle-result",
      );
    } else if (scenario === "callback") {
      let callbackCount = 0;
      const button = new Button(this);
      const clicks = new ClickBridge();
      const registration = clicks.onClick((_view) => {
        callbackCount += 1;
      });
      button.setOnClickListener(clicks);

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
          CALLBACK_ITERATIONS,
          sample,
          elapsed,
          callbackCount,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      registration.disconnect();
      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=callback",
      );
    } else if (scenario === "callback-payload") {
      let callbackPayloadChecksum = 0;
      const button = new Button(this);
      button.setId(7);
      const clicks = new ClickBridge();
      const registration = clicks.onClick((view) => {
        if (view !== null) callbackPayloadChecksum += view.getId();
      });
      button.setOnClickListener(clicks);

      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        callbackPayloadChecksum = 0;
        let index = 0;
        while (index < CALLBACK_PAYLOAD_ITERATIONS) {
          button.callOnClick();
          index += 1;
        }
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        callbackPayloadChecksum = 0;
        const started = SystemClock.elapsedRealtimeNanos();
        let index = 0;
        while (index < CALLBACK_PAYLOAD_ITERATIONS) {
          button.callOnClick();
          index += 1;
        }
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "callback-payload",
          CALLBACK_PAYLOAD_ITERATIONS,
          sample,
          elapsed,
          callbackPayloadChecksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      registration.disconnect();
      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=callback-payload",
      );
    } else if (scenario === "callback-capture") {
      let callbackCaptureChecksum = 0;
      const button = new Button(this);
      button.setId(7);
      const capturedTarget = new Button(this);
      capturedTarget.setId(11);
      const clicks = new ClickBridge();
      const registration = clicks.onClick((view) => {
        if (view !== null) {
          callbackCaptureChecksum += view.getId() + capturedTarget.getId();
        }
      });
      button.setOnClickListener(clicks);

      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        callbackCaptureChecksum = 0;
        let index = 0;
        while (index < CALLBACK_CAPTURE_ITERATIONS) {
          button.callOnClick();
          index += 1;
        }
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        callbackCaptureChecksum = 0;
        const started = SystemClock.elapsedRealtimeNanos();
        let index = 0;
        while (index < CALLBACK_CAPTURE_ITERATIONS) {
          button.callOnClick();
          index += 1;
        }
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "callback-capture",
          CALLBACK_CAPTURE_ITERATIONS,
          sample,
          elapsed,
          callbackCaptureChecksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      registration.disconnect();
      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=callback-capture",
      );
    } else if (scenario === "text-update") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runTextUpdateWorkload(this, TEXT_UPDATE_ITERATIONS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runTextUpdateWorkload(this, TEXT_UPDATE_ITERATIONS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "text-update",
          TEXT_UPDATE_ITERATIONS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=text-update",
      );
    } else if (scenario === "screen-build") {
      let warmup = 0;
      while (warmup < WARMUP_SAMPLES) {
        runScreenBuildWorkload(this, SCREEN_BUILD_ROWS);
        warmup += 1;
      }

      let sample = 0;
      while (sample < MEASURED_SAMPLES) {
        const started = SystemClock.elapsedRealtimeNanos();
        const checksum = runScreenBuildWorkload(this, SCREEN_BUILD_ROWS);
        const elapsed = jlong.toNumber(
          (SystemClock.elapsedRealtimeNanos() - started) as jlong,
        );
        logSample(
          "screen-build",
          SCREEN_BUILD_ROWS,
          sample,
          elapsed,
          checksum,
        );
        this.completedSamples += 1;
        sample += 1;
      }

      Log.i(
        TAG,
        "complete implementation=native-typescript-jvm scenario=screen-build",
      );
    }
  }
}
