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

typedef int32_t (*NtsCallCallback)(int32_t value, void *context);
typedef void (*NtsRetainedCallback)(int32_t value, void *context);
typedef struct NtsSubscription NtsSubscription;
typedef struct NtsCounter NtsCounter;

NTS_SCABI_EXPORT int8_t nts_i8_identity(int8_t value);
NTS_SCABI_EXPORT uint8_t nts_u8_identity(uint8_t value);
NTS_SCABI_EXPORT int16_t nts_i16_identity(int16_t value);
NTS_SCABI_EXPORT uint16_t nts_u16_identity(uint16_t value);
NTS_SCABI_EXPORT int32_t nts_i32_identity(int32_t value);
NTS_SCABI_EXPORT uint32_t nts_u32_identity(uint32_t value);
NTS_SCABI_EXPORT int64_t nts_i64_identity(int64_t value);
NTS_SCABI_EXPORT uint64_t nts_u64_identity(uint64_t value);
NTS_SCABI_EXPORT size_t nts_usize_identity(size_t value);
NTS_SCABI_EXPORT float nts_f32_identity(float value);
NTS_SCABI_EXPORT double nts_f64_identity(double value);

NTS_SCABI_EXPORT NtsPadded nts_padded_roundtrip(NtsPadded value);
NTS_SCABI_EXPORT uint64_t nts_hash_utf8(const char *data, size_t length);
NTS_SCABI_EXPORT uint64_t nts_hash_bytes(const uint8_t *data, size_t length);
NTS_SCABI_EXPORT uint8_t *nts_bytes_allocate(size_t length);
NTS_SCABI_EXPORT void nts_bytes_free(uint8_t *data);

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
NTS_SCABI_EXPORT void nts_counter_destroy(NtsCounter *counter);
NTS_SCABI_EXPORT int32_t nts_counter_destroyed_count(void);
NTS_SCABI_EXPORT int32_t nts_counter_verify(
    int32_t actual_value,
    int32_t actual_destroyed,
    int32_t expected_value,
    int32_t expected_destroyed);

NTS_SCABI_EXPORT int32_t nts_fail_errno(int32_t error_number);

/* Implemented by the generated Native TypeScript library, not this fixture. */
NTS_SCABI_EXPORT int32_t nts_ts_add_i32(int32_t left, int32_t right);

#ifdef __cplusplus
}
#endif

#endif
