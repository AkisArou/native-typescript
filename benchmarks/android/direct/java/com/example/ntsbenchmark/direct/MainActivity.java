package com.example.ntsbenchmark.direct;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.widget.TextView;
import com.example.ntsbenchmark.direct.generated.NativeTypeScriptKernel;

/** Lifecycle and measurement transport only. The measured loop and Android
 * TextUtils call are generated from kernel.ts. */
public final class MainActivity extends Activity {
    private static final int WARMUP_SAMPLES = 3;
    private static final int MEASURED_SAMPLES = 7;
    private static final int LIGHT_OBJECT_ITERATIONS = 50000;
    private static final int STRING_ARGUMENT_ITERATIONS = 20000;
    private static final String TAG = "nts-benchmark";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String scenario = getIntent() == null
            ? null
            : getIntent().getStringExtra("scenario");
        if (!"light-object".equals(scenario) && !"string-argument".equals(scenario)) {
            throw new IllegalArgumentException(
                "direct JVM benchmark supports only light-object and string-argument"
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
        } else {
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
}
