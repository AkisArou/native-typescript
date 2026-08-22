package com.example.ntsbenchmark.baseline

import android.app.Activity
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/* The runner compares these literals to the Native TypeScript source before
 * building either APK. Keep the program shapes readable on both sides; do not
 * replace this file with generated Kotlin. */
private const val WARMUP_SAMPLES = 3
private const val MEASURED_SAMPLES = 7
private const val LIGHT_OBJECT_ITERATIONS = 50000
private const val CONSTRUCTOR_ITERATIONS = 2000
private const val SETTER_ITERATIONS = 50000
private const val CALLBACK_ITERATIONS = 50000
private const val TREE_CHILDREN = 128

private const val TAG = "nts-benchmark"

class MainActivity : Activity() {
    private var callbackCount = 0

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)

        val scenario = intent?.getStringExtra("scenario")
        val content = LinearLayout(this)
        content.setPadding(24, 180, 24, 24)
        content.orientation = LinearLayout.VERTICAL

        val button = Button(this)
        button.text = "Benchmark callback"
        button.setOnClickListener(object : View.OnClickListener {
            override fun onClick(view: View?) {
                callbackCount += 1
            }
        })

        if ("light-object".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runLightObjects()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runLightObjects()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "light-object",
                    sample,
                    LIGHT_OBJECT_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("constructor".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runConstructors()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runConstructors()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "constructor",
                    sample,
                    CONSTRUCTOR_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("setter".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runSetters()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runSetters()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample("setter", sample, SETTER_ITERATIONS, elapsed, checksum)
                sample += 1
            }
        } else if ("callback".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                callbackCount = 0
                var index = 0
                while (index < CALLBACK_ITERATIONS) {
                    button.callOnClick()
                    index += 1
                }
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                callbackCount = 0
                val started = SystemClock.elapsedRealtimeNanos()
                var index = 0
                while (index < CALLBACK_ITERATIONS) {
                    button.callOnClick()
                    index += 1
                }
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "callback",
                    sample,
                    CALLBACK_ITERATIONS,
                    elapsed,
                    callbackCount,
                )
                sample += 1
            }
        } else {
            val started = SystemClock.elapsedRealtimeNanos()
            var index = 0
            while (index < TREE_CHILDREN) {
                val child = TextView(this)
                child.textSize = if (index and 1 == 1) 12f else 13f
                content.addView(child)
                index += 1
            }
            val elapsed = SystemClock.elapsedRealtimeNanos() - started
            logSample("view-tree", 0, TREE_CHILDREN, elapsed, TREE_CHILDREN)
        }

        val status = TextView(this)
        status.text = if (scenario == null) {
            "Kotlin benchmark ready"
        } else {
            "Kotlin " + scenario + " complete"
        }
        status.setTextColor(0xFF000000.toInt())
        status.textSize = 20f
        content.addView(status)
        content.addView(button)
        setContentView(content)

        Log.i(
            TAG,
            "complete implementation=kotlin scenario=" +
                (scenario ?: "view-tree"),
        )
    }

    private fun runConstructors(): Int {
        var checksum = 0
        var index = 0
        while (index < CONSTRUCTOR_ITERATIONS) {
            val view = TextView(this)
            view.minimumHeight = index and 1
            checksum += index and 1
            index += 1
        }
        return checksum
    }

    private fun runLightObjects(): Int {
        var checksum = 0
        var index = 0
        while (index < LIGHT_OBJECT_ITERATIONS) {
            val rectangle = Rect(0, 0, 1, 1)
            checksum += rectangle.width()
            index += 1
        }
        return checksum
    }

    private fun runSetters(): Int {
        val view = TextView(this)
        var checksum = 0
        var index = 0
        while (index < SETTER_ITERATIONS) {
            view.textSize = if (index and 1 == 1) 12f else 13f
            checksum += index and 1
            index += 1
        }
        return checksum
    }

    private fun logSample(
        scenario: String?,
        sample: Int,
        iterations: Int,
        elapsedNs: Long,
        checksum: Int,
    ) {
        Log.i(
            TAG,
            "sample implementation=kotlin scenario=" + scenario +
                " sample=" + sample +
                " iterations=" + iterations +
                " elapsedNs=" + elapsedNs +
                " checksum=" + checksum,
        )
    }
}
