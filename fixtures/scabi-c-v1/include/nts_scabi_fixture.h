#ifndef NTS_SCABI_FIXTURE_H
#define NTS_SCABI_FIXTURE_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#define NTS_SCABI_EXPORT __declspec(dllexport)
#else
#define NTS_SCABI_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct NtsPadded {
  uint8_t tag;
  uint64_t value;
  double ratio;
} NtsPadded;

typedef struct NtsPair32 {
  int32_t first;
  int32_t second;
} NtsPair32;

typedef struct NtsNestedPair32 {
  NtsPair32 left;
  NtsPair32 right;
  int64_t marker;
} NtsNestedPair32;

typedef int32_t (*NtsCallCallback)(int32_t value, void *context);
typedef void (*NtsRetainedCallback)(int32_t value, void *context);
typedef struct NtsSubscription NtsSubscription;
typedef struct NtsCounter NtsCounter;

/* Three synchronous registrations that hand the handler an OBJECT while it
 * runs inside the caller's frame. Transfer is FULL in all three: the subject
 * is created per invocation and the handler's cell owns it, which is the only
 * spelling a managed platform has for an object reaching a callback — a local
 * reference dies with the native frame, so the cell's destructor is what gives
 * it back. */
typedef void (*NtsTellCallback)(NtsCounter *subject, void *context);
typedef int32_t (*NtsJudgeCallback)(int32_t code, NtsCounter *subject,
                                    void *context);
typedef void (*NtsNoticeCallback)(NtsCounter *subject, void *context);
typedef struct NtsTeller NtsTeller;
typedef struct NtsJudge NtsJudge;

NTS_SCABI_EXPORT int8_t nts_i8_identity(int8_t value);
NTS_SCABI_EXPORT uint8_t nts_u8_identity(uint8_t value);
NTS_SCABI_EXPORT int16_t nts_i16_identity(int16_t value);
NTS_SCABI_EXPORT uint16_t nts_u16_identity(uint16_t value);
NTS_SCABI_EXPORT int32_t nts_i32_identity(int32_t value);
NTS_SCABI_EXPORT uint32_t nts_u32_identity(uint32_t value);
NTS_SCABI_EXPORT int64_t nts_i64_identity(int64_t value);
NTS_SCABI_EXPORT int64_t nts_i64_passthrough(int64_t value);
NTS_SCABI_EXPORT uint64_t nts_u64_identity(uint64_t value);
NTS_SCABI_EXPORT size_t nts_usize_identity(size_t value);
NTS_SCABI_EXPORT float nts_f32_identity(float value);
NTS_SCABI_EXPORT double nts_f64_identity(double value);
NTS_SCABI_EXPORT int32_t nts_boolean_false(void);
NTS_SCABI_EXPORT int32_t nts_boolean_invalid(void);
NTS_SCABI_EXPORT int32_t nts_boolean_not(int32_t value);
NTS_SCABI_EXPORT int32_t nts_boolean_true(void);

NTS_SCABI_EXPORT NtsPadded nts_padded_roundtrip(NtsPadded value);
NTS_SCABI_EXPORT NtsPair32 nts_pair32_transform(NtsPair32 value);
NTS_SCABI_EXPORT NtsNestedPair32 nts_nested_pair32_transform(NtsNestedPair32 value);
NTS_SCABI_EXPORT uint64_t nts_hash_utf8(const char *data, size_t length);
NTS_SCABI_EXPORT void nts_c_string_observe(const char *data);
NTS_SCABI_EXPORT uint64_t nts_hash_bytes(const uint8_t *data, size_t length);
NTS_SCABI_EXPORT uint8_t *nts_bytes_allocate(size_t length);
NTS_SCABI_EXPORT void nts_bytes_free(uint8_t *data);
NTS_SCABI_EXPORT void nts_cstring_free(char *data);

/* UTF-8 whose length comes back beside the pointer rather than through a
 * terminator, and whose text CONTAINS a NUL. A copy that scanned for the
 * terminator stops after two bytes and answers a shorter string that looks
 * perfectly correct, so only a caller reading past the embedded NUL can tell
 * the two lowerings apart. The caller frees the result. */
NTS_SCABI_EXPORT char *nts_span_label(size_t *out_length);
/* The same span where absence is a VALUE rather than a failure: a negative
 * request has no label, which differs from having an empty one. */
NTS_SCABI_EXPORT char *nts_span_label_maybe(int32_t which, size_t *out_length);

NTS_SCABI_EXPORT int32_t nts_call_scoped(
    NtsCallCallback callback,
    void *context,
    int32_t value);

NTS_SCABI_EXPORT NtsSubscription *nts_subscription_create(
    NtsRetainedCallback callback,
    void *context);
NTS_SCABI_EXPORT int32_t nts_subscription_emit(
    NtsSubscription *subscription,
    int32_t value);
NTS_SCABI_EXPORT int32_t nts_subscription_emit_foreign(
    NtsSubscription *subscription,
    int32_t value);
NTS_SCABI_EXPORT void nts_subscription_destroy(
    NtsSubscription *subscription);

NTS_SCABI_EXPORT NtsCounter *nts_counter_create(int32_t initial_value);
NTS_SCABI_EXPORT int32_t nts_counter_add(
    NtsCounter *counter,
    int32_t delta);
NTS_SCABI_EXPORT int32_t nts_counter_value(NtsCounter *counter);
/* Accepts an optional counter: null is a valid argument, not a failure. */
NTS_SCABI_EXPORT int32_t nts_counter_value_or(
    NtsCounter *counter,
    int32_t fallback);
/* The same over the base of the handle hierarchy: an argument two identity
 * upcasts below it has to widen on its way into the optional slot. */
NTS_SCABI_EXPORT int32_t nts_counter_base_value_or(
    NtsCounter *counter,
    int32_t fallback);
NTS_SCABI_EXPORT const char *nts_counter_label(NtsCounter *counter);
NTS_SCABI_EXPORT const char *nts_counter_required_label(NtsCounter *counter);
NTS_SCABI_EXPORT void nts_counter_destroy(NtsCounter *counter);
NTS_SCABI_EXPORT int32_t nts_counter_destroyed_count(void);
NTS_SCABI_EXPORT int32_t nts_counter_verify(
    int32_t actual_value,
    int32_t actual_destroyed,
    int32_t expected_value,
    int32_t expected_destroyed);

NTS_SCABI_EXPORT int32_t nts_fail_errno(int32_t error_number);

/* Tells rather than asks, and is handed an object. Reads its mark AFTER
 * invoking the handler, so a delivery that arrived on a later turn answers 0
 * where the truth is 1 — which is what separates synchronous delivery from
 * queued without needing a second turn to observe. */
NTS_SCABI_EXPORT NtsTeller *nts_teller_create(NtsTellCallback callback,
                                              void *context);
NTS_SCABI_EXPORT int32_t nts_teller_tell(NtsTeller *teller, int32_t seed);
NTS_SCABI_EXPORT void nts_teller_destroy(NtsTeller *teller);
NTS_SCABI_EXPORT void nts_tell_mark(void);

/* Answers a boolean while holding both a scalar and an object. The answer is
 * the emitting call's result, so a delivery that arrived later would answer
 * with this function's own zero rather than the handler's. */
NTS_SCABI_EXPORT NtsJudge *nts_judge_create(NtsJudgeCallback callback,
                                            void *context);
NTS_SCABI_EXPORT int32_t nts_judge_ask(NtsJudge *judge, int32_t code,
                                       int32_t seed);
NTS_SCABI_EXPORT void nts_judge_destroy(NtsJudge *judge);
/* The owner-scoped mirror of the withheld payload: answers while holding a
 * subject the emitter may withhold, anchored to a receiver whose disposal
 * cancels the registration. Same callback as `nts_judge_ask` — nullability is
 * a fact about the value, not the slot — so a negative seed hands over
 * nothing. */
NTS_SCABI_EXPORT int32_t nts_judge_ask_maybe(NtsJudge *judge, int32_t code,
                                             int32_t seed);

/* A registration NOTHING owns: stored in a global, fired by a later call, and
 * never cancelled — the shape a framework dispatch takes when the platform
 * constructs the receiver, so there is no instance to anchor to at the moment
 * one could register. The receiver arrives as an ordinary payload instead. */
/* A registration whose handler is a MEMBER of the receiver's own class: the
 * platform shape where the framework constructs the object and calls a
 * lifecycle member on it, so the program declares the member instead of
 * handing over a function. The callback takes the receiver FIRST and the
 * call's own argument after, which is the order a lowered method already has —
 * its `this` is parameter zero — so an override lowers straight into this slot
 * with no adapter between. */
/* ONE object handed out TWICE, under a reference count.
 *
 * The fixture for a handle whose identity arm is `none`: a platform whose
 * references cannot be compared for identity — JNI, where two global refs to
 * one object are distinct pointers — so the runtime may not intern by pointer
 * and every arrival owns its own reference. Returning the same pointer is what
 * makes the arm observable; the count is what proves each cell released
 * exactly the reference it took. */
typedef struct NtsToken NtsToken;

NTS_SCABI_EXPORT NtsToken *nts_token_acquire(void);
NTS_SCABI_EXPORT void nts_token_release(NtsToken *token);
NTS_SCABI_EXPORT int32_t nts_token_value(NtsToken *token);
NTS_SCABI_EXPORT int32_t nts_token_outstanding(void);

/* The base is its OWN type, not an alias of the counter. A platform base
 * class is — an Activity is not an Object with different members — and the
 * manifest says the same thing structurally: one handle type carries one
 * source declaration, so a type reachable under two spellings is not
 * expressible and should not be. */
typedef struct NtsTickSource NtsTickSource;
typedef void (*NtsTickCallback)(NtsTickSource *self, int32_t seed,
                                void *context);

NTS_SCABI_EXPORT int32_t nts_tick_source_value(NtsTickSource *self);
NTS_SCABI_EXPORT void nts_tick_source_destroy(NtsTickSource *self);
NTS_SCABI_EXPORT void nts_tick_register(NtsTickCallback callback,
                                        void *context);
NTS_SCABI_EXPORT void nts_tick_mark(void);
NTS_SCABI_EXPORT int32_t nts_tick_fire(int32_t seed);
/* The BASE implementation `super.onTick(...)` reaches. On a real platform this
 * is a generated superclass bridge compiled to a non-virtual call; here it is
 * an ordinary function, because what the compiler needs from it is only that
 * it is a DISTINCT binding from the one the platform calls. Were it the same,
 * super would redispatch to the override and never terminate. */
NTS_SCABI_EXPORT void nts_tick_virtual(NtsTickSource *self, int32_t seed);
NTS_SCABI_EXPORT void nts_tick_base(NtsTickSource *self, int32_t seed);

NTS_SCABI_EXPORT void nts_notice_register(NtsNoticeCallback callback,
                                          void *context);
NTS_SCABI_EXPORT void nts_notice_mark(void);
NTS_SCABI_EXPORT int32_t nts_notice_fire(int32_t seed);

/* The same registration where the payload may be ABSENT. A framework hands a
 * lifecycle handler an object on one call and nothing on another — Android's
 * `onCreate(Bundle)` is called with null on first launch and with saved state
 * afterwards — so a contract declaring the payload non-null would be a claim
 * the platform disproves on the first run. A negative seed withholds the
 * subject, which is a VALUE the handler tests rather than a failure. */
typedef void (*NtsMaybeCallback)(NtsCounter *subject, void *context);

NTS_SCABI_EXPORT void nts_maybe_register(NtsMaybeCallback callback,
                                         void *context);
NTS_SCABI_EXPORT void nts_maybe_mark(void);
NTS_SCABI_EXPORT int32_t nts_maybe_fire(int32_t seed);

/* Reports failure by returning an owned error object rather than a code, the
 * shape GLib's GError takes once a generated adapter has absorbed its
 * out-parameter. NULL is success. */
typedef struct NtsFixtureError NtsFixtureError;

NTS_SCABI_EXPORT NtsFixtureError *nts_error_handle_fail(int32_t code);
/* Reports failure through a trailing slot, so the quotient survives. */
NTS_SCABI_EXPORT int32_t nts_error_out_divide(int32_t numerator, int32_t divisor,
                                              NtsFixtureError **error);
/* The same slot under a SUB-WORD result, in both signednesses. The failure
 * value has to survive the narrowing: a lowering that widened before checking
 * the slot, or that reused the result register, answers with a byte that is a
 * legitimate value at this width. */
NTS_SCABI_EXPORT int8_t nts_error_out_i8(int32_t value, NtsFixtureError **error);
NTS_SCABI_EXPORT uint8_t nts_error_out_u8(int32_t value,
                                          NtsFixtureError **error);
NTS_SCABI_EXPORT const char *nts_fixture_error_message(NtsFixtureError *error);
NTS_SCABI_EXPORT void nts_fixture_error_free(NtsFixtureError *error);
NTS_SCABI_EXPORT int32_t nts_fixture_errors_outstanding(void);

/* Implemented by the generated Native TypeScript library, not this fixture. */
NTS_SCABI_EXPORT int32_t nts_ts_add_i32(int32_t left, int32_t right);

#ifdef __cplusplus
}
#endif

#endif
