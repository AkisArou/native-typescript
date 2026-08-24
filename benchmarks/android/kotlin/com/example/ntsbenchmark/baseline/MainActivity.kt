package com.example.ntsbenchmark.baseline

import android.app.Activity
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.text.TextUtils
import android.util.Base64
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.util.Locale

/* The runner compares these literals to the Native TypeScript source before
 * building either APK. Keep the program shapes readable on both sides; do not
 * replace this file with generated Kotlin. */
private const val WARMUP_SAMPLES = 3
private const val MEASURED_SAMPLES = 7
private const val LIGHT_OBJECT_ITERATIONS = 50000
private const val MANAGED_CLASS_ITERATIONS = 100000
private const val CONSTRUCTOR_ITERATIONS = 2000
private const val SETTER_ITERATIONS = 50000
private const val CALLBACK_ITERATIONS = 50000
private const val STRING_ARGUMENT_ITERATIONS = 20000
private const val STRING_RESULT_ITERATIONS = 10000
private const val STRING_OPERATION_ITERATIONS = 10000
private const val BYTE_ARRAY_ITERATIONS = 2000
private const val BYTE_ARRAY_LENGTH = 256
private const val HANDLE_RESULT_ITERATIONS = 32000
private const val HANDLE_RESULT_CHILDREN = 16
private const val CALLBACK_PAYLOAD_ITERATIONS = 20000
private const val CALLBACK_CAPTURE_ITERATIONS = 20000
private const val TEXT_UPDATE_ITERATIONS = 10000
private const val SCREEN_BUILD_ROWS = 32
private const val TREE_CHILDREN = 128

private const val TAG = "nts-benchmark"

private open class ManagedCounterBase {
    protected var value = 7

    open fun step(): Int {
        value = ((value shl 5) xor (value ushr 2) xor 17) and 1023
        return value
    }
}

private class ManagedCounter : ManagedCounterBase() {
    private val bonus = 1

    override fun step(): Int {
        return super.step() + bonus
    }
}

class MainActivity : Activity() {
    private var callbackCount = 0
    private var callbackPayloadChecksum = 0
    private var callbackCaptureChecksum = 0

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
        } else if ("managed-class".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runManagedClasses()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runManagedClasses()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "managed-class",
                    sample,
                    MANAGED_CLASS_ITERATIONS,
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
        } else if ("string-argument".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runStringArguments()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runStringArguments()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "string-argument",
                    sample,
                    STRING_ARGUMENT_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("string-result".equals(scenario)) {
            val rectangle = Rect(1, 2, 11, 22)
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runStringResults(rectangle)
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runStringResults(rectangle)
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "string-result",
                    sample,
                    STRING_RESULT_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("string-operations".equals(scenario)) {
            val value = "  Native TypeScript Καλημέρα 👩‍💻 e\u0301  "
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runStringOperations(value)
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runStringOperations(value)
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "string-operations",
                    sample,
                    STRING_OPERATION_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("byte-array".equals(scenario)) {
            val input = ByteArray(BYTE_ARRAY_LENGTH)
            var inputIndex = 0
            while (inputIndex < BYTE_ARRAY_LENGTH) {
                input[inputIndex] = (inputIndex and 127).toByte()
                inputIndex += 1
            }
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runByteArrays(input)
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runByteArrays(input)
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "byte-array",
                    sample,
                    BYTE_ARRAY_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("handle-result".equals(scenario)) {
            val container = buildHandleResultContainer()
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runHandleResults(container)
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runHandleResults(container)
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "handle-result",
                    sample,
                    HANDLE_RESULT_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("callback-payload".equals(scenario)) {
            val payloadButton = Button(this)
            payloadButton.id = 7
            payloadButton.setOnClickListener(object : View.OnClickListener {
                override fun onClick(view: View?) {
                    if (view != null) callbackPayloadChecksum += view.id
                }
            })
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                callbackPayloadChecksum = 0
                var index = 0
                while (index < CALLBACK_PAYLOAD_ITERATIONS) {
                    payloadButton.callOnClick()
                    index += 1
                }
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                callbackPayloadChecksum = 0
                val started = SystemClock.elapsedRealtimeNanos()
                var index = 0
                while (index < CALLBACK_PAYLOAD_ITERATIONS) {
                    payloadButton.callOnClick()
                    index += 1
                }
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "callback-payload",
                    sample,
                    CALLBACK_PAYLOAD_ITERATIONS,
                    elapsed,
                    callbackPayloadChecksum,
                )
                sample += 1
            }
        } else if ("callback-capture".equals(scenario)) {
            val captureButton = Button(this)
            captureButton.id = 7
            val capturedTarget = Button(this)
            capturedTarget.id = 11
            captureButton.setOnClickListener(object : View.OnClickListener {
                override fun onClick(view: View?) {
                    if (view != null) {
                        callbackCaptureChecksum += view.id + capturedTarget.id
                    }
                }
            })
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                callbackCaptureChecksum = 0
                var index = 0
                while (index < CALLBACK_CAPTURE_ITERATIONS) {
                    captureButton.callOnClick()
                    index += 1
                }
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                callbackCaptureChecksum = 0
                val started = SystemClock.elapsedRealtimeNanos()
                var index = 0
                while (index < CALLBACK_CAPTURE_ITERATIONS) {
                    captureButton.callOnClick()
                    index += 1
                }
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "callback-capture",
                    sample,
                    CALLBACK_CAPTURE_ITERATIONS,
                    elapsed,
                    callbackCaptureChecksum,
                )
                sample += 1
            }
        } else if ("text-update".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runTextUpdates()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runTextUpdates()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "text-update",
                    sample,
                    TEXT_UPDATE_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("screen-build".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runScreenBuild()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runScreenBuild()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "screen-build",
                    sample,
                    SCREEN_BUILD_ROWS,
                    elapsed,
                    checksum,
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

    private fun runManagedClasses(): Int {
        val counter: ManagedCounterBase = ManagedCounter()
        var checksum = 0
        var index = 0
        while (index < MANAGED_CLASS_ITERATIONS) {
            checksum += counter.step()
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

    private fun runStringArguments(): Int {
        val asciiLeft: String? = java.lang.StringBuilder("settings/")
            .append("profile/42")
            .toString()
        val asciiRight: String? = java.lang.StringBuilder("settings/profile/")
            .append("42")
            .toString()
        val unicodeLeft: String? = java.lang.StringBuilder("Καλημέρα ")
            .append("👩‍💻 e\u0301")
            .toString()
        val unicodeRight: String? = java.lang.StringBuilder("Καλημέρα 👩‍💻 ")
            .append("e\u0301")
            .toString()
        var checksum = 0
        var index = 0
        while (index < STRING_ARGUMENT_ITERATIONS) {
            val equal = if (index and 1 == 1) {
                TextUtils.equals(asciiLeft, asciiRight)
            } else {
                TextUtils.equals(unicodeLeft, unicodeRight)
            }
            if (equal) checksum += 1
            index += 1
        }
        return checksum
    }

    private fun runStringResults(rectangle: Rect): Int {
        var checksum = 0
        var index = 0
        while (index < STRING_RESULT_ITERATIONS) {
            val flattened: String? = rectangle.flattenToString()
            if (flattened != null) checksum += flattened.length
            index += 1
        }
        return checksum
    }

    private fun runStringOperations(value: String): Int {
        var checksum = 0
        var index = 0
        while (index < STRING_OPERATION_ITERATIONS) {
            val trimmed = value.trim()
            val normalized = trimmed.lowercase(Locale.ROOT)
            val segment = normalized.substring(0, 17)
            val padded = segment.padEnd(20, '.')
            checksum += segment.length
            if (normalized.contains("typescript")) checksum += 1
            checksum += trimmed[18].code
            checksum += padded.length
            index += 1
        }
        return checksum
    }

    private fun runByteArrays(input: ByteArray): Int {
        var checksum = 0
        var index = 0
        while (index < BYTE_ARRAY_ITERATIONS) {
            checksum += Base64.encode(input, Base64.NO_WRAP).size
            index += 1
        }
        return checksum
    }

    private fun buildHandleResultContainer(): LinearLayout {
        val container = LinearLayout(this)
        var index = 0
        while (index < HANDLE_RESULT_CHILDREN) {
            val child = TextView(this)
            child.id = index + 1
            container.addView(child)
            index += 1
        }
        return container
    }

    private fun runHandleResults(container: LinearLayout): Int {
        var checksum = 0
        var index = 0
        while (index < HANDLE_RESULT_ITERATIONS) {
            val child = container.getChildAt(index and (HANDLE_RESULT_CHILDREN - 1))
            if (child != null) checksum += child.id
            index += 1
        }
        return checksum
    }

    private fun runTextUpdates(): Int {
        val view = TextView(this)
        var checksum = 0
        var index = 0
        while (index < TEXT_UPDATE_ITERATIONS) {
            val text = "Count: " + (index and 1023)
            view.text = text
            checksum += text.length
            index += 1
        }
        return checksum
    }

    private fun runScreenBuild(): Int {
        val screen = LinearLayout(this)
        screen.orientation = LinearLayout.VERTICAL
        var checksum = 0
        var index = 0
        while (index < SCREEN_BUILD_ROWS) {
            val row = LinearLayout(this)
            row.orientation = LinearLayout.HORIZONTAL
            val title = TextView(this)
            val titleText = "Item " + index
            title.text = titleText
            title.minimumHeight = 48 + (index and 1)
            val action = Button(this)
            val actionText = "Open " + index
            action.text = actionText
            row.addView(title)
            row.addView(action)
            screen.addView(row)
            checksum += titleText.length + actionText.length
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
