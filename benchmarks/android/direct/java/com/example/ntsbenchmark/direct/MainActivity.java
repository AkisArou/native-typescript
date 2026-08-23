package com.example.ntsbenchmark.direct;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.example.ntsbenchmark.direct.generated.NativeTypeScriptKernel;

/** Lifecycle and measurement transport only. The measured loop and Android
 * TextUtils call are generated from kernel.ts. */
public final class MainActivity extends Activity {
    private static final int WARMUP_SAMPLES = 3;
    private static final int MEASURED_SAMPLES = 7;
    private static final int LIGHT_OBJECT_ITERATIONS = 50000;
    private static final int SETTER_ITERATIONS = 50000;
    private static final int CALLBACK_ITERATIONS = 50000;
    private static final int CALLBACK_PAYLOAD_ITERATIONS = 20000;
    private static final int STRING_ARGUMENT_ITERATIONS = 20000;
    private static final int STRING_RESULT_ITERATIONS = 10000;
    private static final int BYTE_ARRAY_ITERATIONS = 2000;
    private static final int BYTE_ARRAY_LENGTH = 256;
    private static final int HANDLE_RESULT_ITERATIONS = 32000;
    private static final int HANDLE_RESULT_CHILDREN = 16;
    private static final String TAG = "nts-benchmark";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String scenario = getIntent() == null
            ? null
            : getIntent().getStringExtra("scenario");
        if (
            !"light-object".equals(scenario) &&
            !"setter".equals(scenario) &&
            !"callback".equals(scenario) &&
            !"callback-payload".equals(scenario) &&
            !"string-argument".equals(scenario) &&
            !"string-result".equals(scenario) &&
            !"byte-array".equals(scenario) &&
            !"handle-result".equals(scenario)
        ) {
            throw new IllegalArgumentException(
                "direct JVM benchmark supports only light-object, setter, " +
                    "callback, callback-payload, string-argument, string-result, " +
                    "byte-array, and handle-result"
            );
        }

        if ("light-object".equals(scenario)) {
            for (int warmup = 0; warmup < WARMUP_SAMPLES; warmup++) {
                NativeTypeScriptKernel.runLightObjects();
            }
            for (int sample = 0; sample < MEASURED_SAMPLES; sample++) {
                long started = SystemClock.elapsedRealtimeNanos();
                double rawChecksum = NativeTypeScriptKernel.runLightObjects();
                long elapsed = SystemClock.elapsedRealtimeNanos() - started;
                logSample(
                    "light-object",
                    sample,
                    LIGHT_OBJECT_ITERATIONS,
                    elapsed,
                    (int) rawChecksum
                );
            }
        } else if ("setter".equals(scenario)) {
            for (int warmup = 0; warmup < WARMUP_SAMPLES; warmup++) {
                NativeTypeScriptKernel.runSetters(this);
            }
            for (int sample = 0; sample < MEASURED_SAMPLES; sample++) {
                long started = SystemClock.elapsedRealtimeNanos();
                double rawChecksum = NativeTypeScriptKernel.runSetters(this);
                long elapsed = SystemClock.elapsedRealtimeNanos() - started;
                logSample(
                    "setter",
                    sample,
                    SETTER_ITERATIONS,
                    elapsed,
                    (int) rawChecksum
                );
            }
        } else if ("callback".equals(scenario)) {
            Button button = NativeTypeScriptKernel.prepareCallbacks(this);
            for (int warmup = 0; warmup < WARMUP_SAMPLES; warmup++) {
                NativeTypeScriptKernel.runCallbacks(button);
            }
            for (int sample = 0; sample < MEASURED_SAMPLES; sample++) {
                long started = SystemClock.elapsedRealtimeNanos();
                double rawChecksum = NativeTypeScriptKernel.runCallbacks(button);
                long elapsed = SystemClock.elapsedRealtimeNanos() - started;
                logSample(
                    "callback",
                    sample,
                    CALLBACK_ITERATIONS,
                    elapsed,
                    (int) rawChecksum
                );
            }
        } else if ("callback-payload".equals(scenario)) {
            Button button = NativeTypeScriptKernel.prepareCallbackPayload(this);
            button.setId(7);
            for (int warmup = 0; warmup < WARMUP_SAMPLES; warmup++) {
                NativeTypeScriptKernel.runCallbackPayload(button);
            }
            for (int sample = 0; sample < MEASURED_SAMPLES; sample++) {
                long started = SystemClock.elapsedRealtimeNanos();
                double rawChecksum = NativeTypeScriptKernel.runCallbackPayload(button);
                long elapsed = SystemClock.elapsedRealtimeNanos() - started;
                logSample(
                    "callback-payload",
                    sample,
                    CALLBACK_PAYLOAD_ITERATIONS,
                    elapsed,
                    (int) rawChecksum
                );
            }
        } else if ("string-argument".equals(scenario)) {
            for (int warmup = 0; warmup < WARMUP_SAMPLES; warmup++) {
                runStringArguments();
            }
            for (int sample = 0; sample < MEASURED_SAMPLES; sample++) {
                long started = SystemClock.elapsedRealtimeNanos();
                double rawChecksum = runStringArguments();
                long elapsed = SystemClock.elapsedRealtimeNanos() - started;
                logSample(
                    "string-argument",
                    sample,
                    STRING_ARGUMENT_ITERATIONS,
                    elapsed,
                    (int) rawChecksum
                );
            }
        } else if ("string-result".equals(scenario)) {
            Rect rectangle = new Rect(1, 2, 11, 22);
            for (int warmup = 0; warmup < WARMUP_SAMPLES; warmup++) {
                NativeTypeScriptKernel.runStringResults(rectangle);
            }
            for (int sample = 0; sample < MEASURED_SAMPLES; sample++) {
                long started = SystemClock.elapsedRealtimeNanos();
                double rawChecksum = NativeTypeScriptKernel.runStringResults(rectangle);
                long elapsed = SystemClock.elapsedRealtimeNanos() - started;
                logSample(
                    "string-result",
                    sample,
                    STRING_RESULT_ITERATIONS,
                    elapsed,
                    (int) rawChecksum
                );
            }
        } else if ("byte-array".equals(scenario)) {
            byte[] input = new byte[BYTE_ARRAY_LENGTH];
            for (int inputIndex = 0; inputIndex < BYTE_ARRAY_LENGTH; inputIndex++) {
                input[inputIndex] = (byte) (inputIndex & 127);
            }
            for (int warmup = 0; warmup < WARMUP_SAMPLES; warmup++) {
                NativeTypeScriptKernel.runByteArrays(input);
            }
            for (int sample = 0; sample < MEASURED_SAMPLES; sample++) {
                long started = SystemClock.elapsedRealtimeNanos();
                double rawChecksum = NativeTypeScriptKernel.runByteArrays(input);
                long elapsed = SystemClock.elapsedRealtimeNanos() - started;
                logSample(
                    "byte-array",
                    sample,
                    BYTE_ARRAY_ITERATIONS,
                    elapsed,
                    (int) rawChecksum
                );
            }
        } else {
            LinearLayout container = buildHandleResultContainer();
            for (int warmup = 0; warmup < WARMUP_SAMPLES; warmup++) {
                NativeTypeScriptKernel.runHandleResults(container);
            }
            for (int sample = 0; sample < MEASURED_SAMPLES; sample++) {
                long started = SystemClock.elapsedRealtimeNanos();
                double rawChecksum = NativeTypeScriptKernel.runHandleResults(container);
                long elapsed = SystemClock.elapsedRealtimeNanos() - started;
                logSample(
                    "handle-result",
                    sample,
                    HANDLE_RESULT_ITERATIONS,
                    elapsed,
                    (int) rawChecksum
                );
            }
        }

        TextView status = new TextView(this);
        status.setText("Native TypeScript direct JVM " + scenario + " complete");
        status.setTextColor(Color.BLACK);
        status.setTextSize(20);
        setContentView(status);
        Log.i(
            TAG,
            "complete implementation=native-typescript-jvm " +
                "scenario=" + scenario
        );
    }

    private static void logSample(
        String scenario,
        int sample,
        int iterations,
        long elapsed,
        int checksum
    ) {
        Log.i(
            TAG,
            "sample implementation=native-typescript-jvm " +
                "scenario=" + scenario + " sample=" + sample +
                " iterations=" + iterations +
                " elapsedNs=" + elapsed + " checksum=" + checksum
        );
    }

    /** Construct distinct-but-equal inputs exactly as the Kotlin control does.
     * Java string literals are interned, which would let TextUtils.equals
     * return on object identity without examining either string's contents. */
    private static double runStringArguments() {
        String asciiLeft = new StringBuilder("settings/")
            .append("profile/42")
            .toString();
        String asciiRight = new StringBuilder("settings/profile/")
            .append("42")
            .toString();
        String unicodeLeft = new StringBuilder("Καλημέρα ")
            .append("👩‍💻 e\u0301")
            .toString();
        String unicodeRight = new StringBuilder("Καλημέρα 👩‍💻 ")
            .append("e\u0301")
            .toString();
        return NativeTypeScriptKernel.runStringArguments(
            asciiLeft,
            asciiRight,
            unicodeLeft,
            unicodeRight
        );
    }

    private LinearLayout buildHandleResultContainer() {
        LinearLayout container = new LinearLayout(this);
        for (int index = 0; index < HANDLE_RESULT_CHILDREN; index++) {
            TextView child = new TextView(this);
            child.setId(index + 1);
            container.addView(child);
        }
        return container;
    }
}
