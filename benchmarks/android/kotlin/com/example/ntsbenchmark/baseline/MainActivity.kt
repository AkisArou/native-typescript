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
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.truncate

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
private const val ARRAY_OPERATION_ITERATIONS = 20000
private const val ARRAY_PIPELINE_ITERATIONS = 20000
private const val RECORD_OBJECT_ITERATIONS = 50000
private const val OPTIONAL_VALUE_ITERATIONS = 50000
private const val MAP_OPERATION_ITERATIONS = 50000
private const val SET_OPERATION_ITERATIONS = 50000
private const val MATH_OPERATION_ITERATIONS = 100000
private const val NUMBER_PARSING_ITERATIONS = 50000
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

private class BenchmarkRow(
    var count: Int,
    val label: String,
    val active: Boolean,
)

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
        } else if (
            "string-normalize".equals(scenario) ||
            "string-slice".equals(scenario) ||
            "string-pad".equals(scenario) ||
            "string-search".equals(scenario)
        ) {
            val raw = "  Native TypeScript Καλημέρα 👩‍💻 e\u0301  "
            val normalized = "native typescript καλημέρα 👩‍💻 e\u0301"
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                if ("string-normalize".equals(scenario)) {
                    runStringNormalize(raw)
                } else if ("string-slice".equals(scenario)) {
                    runStringSlice(normalized)
                } else if ("string-pad".equals(scenario)) {
                    runStringPad("native typescript")
                } else {
                    runStringSearch(normalized)
                }
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = if ("string-normalize".equals(scenario)) {
                    runStringNormalize(raw)
                } else if ("string-slice".equals(scenario)) {
                    runStringSlice(normalized)
                } else if ("string-pad".equals(scenario)) {
                    runStringPad("native typescript")
                } else {
                    runStringSearch(normalized)
                }
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    scenario!!,
                    sample,
                    STRING_OPERATION_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("array-operations".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runArrayOperations()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runArrayOperations()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "array-operations",
                    sample,
                    ARRAY_OPERATION_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("array-pipeline".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runArrayPipeline()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runArrayPipeline()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "array-pipeline",
                    sample,
                    ARRAY_PIPELINE_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("record-objects".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runRecordObjects()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runRecordObjects()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "record-objects",
                    sample,
                    RECORD_OBJECT_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("optional-values".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runOptionalValues()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runOptionalValues()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "optional-values",
                    sample,
                    OPTIONAL_VALUE_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("map-operations".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runMapOperations()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runMapOperations()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "map-operations",
                    sample,
                    MAP_OPERATION_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("set-operations".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runSetOperations()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runSetOperations()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "set-operations",
                    sample,
                    SET_OPERATION_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if ("math-operations".equals(scenario)) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                runMathOperations()
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = runMathOperations()
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    "math-operations",
                    sample,
                    MATH_OPERATION_ITERATIONS,
                    elapsed,
                    checksum,
                )
                sample += 1
            }
        } else if (
            "number-parsing".equals(scenario) ||
            "parse-int".equals(scenario) ||
            "parse-float".equals(scenario) ||
            "number-from-string".equals(scenario)
        ) {
            var warmup = 0
            while (warmup < WARMUP_SAMPLES) {
                if ("number-parsing".equals(scenario)) {
                    runNumberParsing()
                } else if ("parse-int".equals(scenario)) {
                    runParseInt()
                } else if ("parse-float".equals(scenario)) {
                    runParseFloat()
                } else {
                    runNumberFromString()
                }
                warmup += 1
            }
            var sample = 0
            while (sample < MEASURED_SAMPLES) {
                val started = SystemClock.elapsedRealtimeNanos()
                val checksum = if ("number-parsing".equals(scenario)) {
                    runNumberParsing()
                } else if ("parse-int".equals(scenario)) {
                    runParseInt()
                } else if ("parse-float".equals(scenario)) {
                    runParseFloat()
                } else {
                    runNumberFromString()
                }
                val elapsed = SystemClock.elapsedRealtimeNanos() - started
                logSample(
                    scenario!!,
                    sample,
                    NUMBER_PARSING_ITERATIONS,
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

    private fun runStringNormalize(value: String): Int {
        var checksum = 0
        var index = 0
        while (index < STRING_OPERATION_ITERATIONS) {
            val normalized = value.trim().lowercase(Locale.ROOT)
            checksum += normalized.length
            index += 1
        }
        return checksum
    }

    private fun runStringSlice(value: String): Int {
        var checksum = 0
        var index = 0
        while (index < STRING_OPERATION_ITERATIONS) {
            val segment = value.substring(0, 17)
            checksum += segment.length
            index += 1
        }
        return checksum
    }

    private fun runStringPad(value: String): Int {
        var checksum = 0
        var index = 0
        while (index < STRING_OPERATION_ITERATIONS) {
            val padded = value.padEnd(20, '.')
            checksum += padded.length
            index += 1
        }
        return checksum
    }

    private fun runStringSearch(value: String): Int {
        var checksum = 0
        var index = 0
        while (index < STRING_OPERATION_ITERATIONS) {
            if (value.contains("typescript")) checksum += 1
            checksum += value[18].code
            index += 1
        }
        return checksum
    }

    private fun runArrayOperations(): Int {
        var checksum = 0
        var index = 0
        while (index < ARRAY_OPERATION_ITERATIONS) {
            val values = ArrayList<Int>(6)
            values.add(index and 255)
            values.add(3)
            values.add(5)
            values.add(7)
            values.add(1024)
            values.add(13)
            values[1] = 17
            checksum += values.size
            checksum += values[0] + values[1] + values[5]
            checksum += values.indexOf(1024)
            if (values.contains(13)) checksum += 1
            checksum += values.removeAt(values.lastIndex)
            index += 1
        }
        return checksum
    }

    private fun runArrayPipeline(): Int {
        var checksum = 0
        var index = 0
        while (index < ARRAY_PIPELINE_ITERATIONS) {
            val delta = index and 7
            val result = listOf(index and 255, 2, 3, 4)
                .mapIndexed { position, value -> value * 2 + position + delta }
                .filter { value -> value > 7 }
                .fold(0) { sum, value -> sum + value }
            checksum += result
            index += 1
        }
        return checksum
    }

    private fun runRecordObjects(): Int {
        var checksum = 0
        var index = 0
        while (index < RECORD_OBJECT_ITERATIONS) {
            val row = BenchmarkRow(
                label = if (index and 1 != 0) "alpha" else "Καλημέρα",
                count = index and 255,
                active = index and 3 == 0,
            )
            row.count += row.label.length
            if (row.active) row.count += 3
            checksum += row.count
            index += 1
        }
        return checksum
    }

    private fun maybeNumber(index: Int): Int? {
        return if (index and 3 == 0) null else index and 255
    }

    private fun maybeLabel(index: Int): String? {
        return if (index and 1 != 0) "alpha" else null
    }

    private fun runOptionalValues(): Int {
        var checksum = 0
        var index = 0
        while (index < OPTIONAL_VALUE_ITERATIONS) {
            val numeric = maybeNumber(index)
            checksum += if (numeric == null) 11 else numeric + 3
            val label = maybeLabel(index)
            checksum += if (label == null) 7 else label.length
            index += 1
        }
        return checksum
    }

    private fun runMapOperations(): Int {
        val keys = arrayOf(
            "alpha", "beta", "gamma", "delta",
            "epsilon", "zeta", "eta", "theta",
            "iota", "kappa", "lambda", "mu",
            "nu", "xi", "omicron", "pi",
        )
        val counts = LinkedHashMap<String, Int>()
        var checksum = 0
        var index = 0
        while (index < MAP_OPERATION_ITERATIONS) {
            val key = keys[index and 15]
            val previous = counts[key]
            val next = if (previous == null) (index and 7) + 1 else previous + 1
            counts[key] = next
            if (index and 31 == 0) {
                val evictionKey = keys[(index ushr 5) and 15]
                if (counts.containsKey(evictionKey)) checksum += 3
                if (counts.remove(evictionKey) != null) checksum += 5
                counts[evictionKey] = next + 2
            }
            checksum += next + counts.size
            index += 1
        }
        return checksum
    }

    private fun runSetOperations(): Int {
        val keys = arrayOf(
            "alpha", "beta", "gamma", "delta",
            "epsilon", "zeta", "eta", "theta",
            "iota", "kappa", "lambda", "mu",
            "nu", "xi", "omicron", "pi",
        )
        val active = LinkedHashSet<String>()
        var checksum = 0
        var index = 0
        while (index < SET_OPERATION_ITERATIONS) {
            val key = keys[index and 15]
            if (!active.contains(key)) {
                active.add(key)
                checksum += 1
            }
            if (index and 31 == 0) {
                val evictionKey = keys[(index ushr 5) and 15]
                if (active.contains(evictionKey)) checksum += 3
                if (active.remove(evictionKey)) checksum += 5
                active.add(evictionKey)
            }
            if (index and 255 == 0) {
                for (member in active) checksum += member.length
            }
            checksum += active.size
            index += 1
        }
        return checksum
    }

    private fun jsRound(value: Double): Double {
        if (value.isNaN() || value.isInfinite() || value == 0.0) return value
        val lower = floor(value)
        val result = if (value - lower < 0.5) lower else lower + 1.0
        return if (result == 0.0 && value < 0.0) -0.0 else result
    }

    private fun runMathOperations(): Int {
        var checksum = 0.0
        var index = 0
        while (index < MATH_OPERATION_ITERATIONS) {
            val value = ((index and 1023) - 512) / 8.0 +
                (if (index and 1 != 0) 0.25 else -0.25)
            val minimum = min(value, -value)
            val maximum = max(value, -value)
            checksum += floor(value)
            checksum += ceil(value)
            checksum += truncate(value)
            checksum += jsRound(value)
            checksum += truncate(abs(value))
            checksum += truncate(minimum)
            checksum += truncate(maximum)
            index += 1
        }
        return checksum.toInt()
    }

    private fun runNumberParsing(): Int {
        val integerInputs = arrayOf(
            "0", "7", "42", "-17", "255", "1024", "6553", "-3276",
            "12345", "-7654", "2147", "-9999", "73", "8080", "-4096", "3141",
        )
        val floatInputs = arrayOf(
            "0.5", "-2.25", "3.125", "1e3", "-0.03125", "42.75", "512.5", "-128.125",
            "0.125", "64.875", "-16.5", "2048.25", "-4096.75", "7.5", "0e0", "123.375",
        )
        val numberInputs = arrayOf(
            "1.25", "-3.5", "6.125", "2.5e2", "-0.0625", "18.75", "256.25", "-64.5",
            "0.375", "32.625", "-8.25", "1024.5", "-2048.125", "15.875", "0.0", "61.25",
        )
        var checksum = 0.0
        var index = 0
        while (index < NUMBER_PARSING_ITERATIONS) {
            val slot = index and 15
            checksum += integerInputs[slot].toInt()
            checksum += floatInputs[slot].toDouble() * 32.0
            checksum += numberInputs[slot].toDouble() * 32.0
            index += 1
        }
        return checksum.toInt()
    }

    private fun runParseInt(): Int {
        val inputs = arrayOf(
            "0", "7", "42", "-17", "255", "1024", "6553", "-3276",
            "12345", "-7654", "2147", "-9999", "73", "8080", "-4096", "3141",
        )
        var checksum = 0
        var index = 0
        while (index < NUMBER_PARSING_ITERATIONS) {
            checksum += inputs[index and 15].toInt()
            index += 1
        }
        return checksum
    }

    private fun runParseFloat(): Int {
        val inputs = arrayOf(
            "0.5", "-2.25", "3.125", "1e3", "-0.03125", "42.75", "512.5", "-128.125",
            "0.125", "64.875", "-16.5", "2048.25", "-4096.75", "7.5", "0e0", "123.375",
        )
        var checksum = 0.0
        var index = 0
        while (index < NUMBER_PARSING_ITERATIONS) {
            checksum += inputs[index and 15].toDouble() * 32.0
            index += 1
        }
        return checksum.toInt()
    }

    private fun runNumberFromString(): Int {
        val inputs = arrayOf(
            "1.25", "-3.5", "6.125", "2.5e2", "-0.0625", "18.75", "256.25", "-64.5",
            "0.375", "32.625", "-8.25", "1024.5", "-2048.125", "15.875", "0.0", "61.25",
        )
        var checksum = 0.0
        var index = 0
        while (index < NUMBER_PARSING_ITERATIONS) {
            checksum += inputs[index and 15].toDouble() * 32.0
            index += 1
        }
        return checksum.toInt()
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
