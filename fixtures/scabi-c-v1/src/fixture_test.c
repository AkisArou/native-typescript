#include "nts_scabi_fixture.h"

#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <string.h>

typedef struct CallbackState {
  pthread_mutex_t mutex;
  pthread_cond_t changed;
  int32_t count;
  int32_t total;
} CallbackState;

static int32_t call_scoped(int32_t value, void *context) {
  return value + *(const int32_t *)context;
}

static void retained(int32_t value, void *context) {
  CallbackState *state = (CallbackState *)context;
  pthread_mutex_lock(&state->mutex);
  state->count += 1;
  state->total += value;
  pthread_cond_signal(&state->changed);
  pthread_mutex_unlock(&state->mutex);
}

int main(void) {
  assert(nts_i8_identity(INT8_MIN) == INT8_MIN);
  assert(nts_u8_identity(UINT8_MAX) == UINT8_MAX);
  assert(nts_i16_identity(INT16_MIN) == INT16_MIN);
  assert(nts_u16_identity(UINT16_MAX) == UINT16_MAX);
  assert(nts_i32_identity(INT32_MIN) == INT32_MIN);
  assert(nts_u32_identity(UINT32_MAX) == UINT32_MAX);
  assert(nts_i64_identity(INT64_MIN) == INT64_MIN);
  assert(nts_u64_identity(UINT64_MAX) == UINT64_MAX);
  assert(nts_usize_identity(SIZE_MAX) == SIZE_MAX);
  assert(nts_f32_identity(1.25f) == 1.25f);
  assert(nts_f64_identity(1.25) == 1.25);

  NtsPadded input = {.tag = 7, .value = UINT64_C(0xfeedface), .ratio = 0.5};
  NtsPadded output = nts_padded_roundtrip(input);
  assert(output.tag == input.tag);
  assert(output.value == input.value);
  assert(output.ratio == input.ratio);

  const char text[] = "native\0typescript";
  const uint8_t bytes[] = {0x6e, 0x61, 0x74, 0x69, 0x76, 0x65};
  assert(nts_hash_utf8(text, sizeof(text) - 1) != 0);
  nts_c_string_observe("native");
  nts_c_string_observe("done");
  assert(nts_hash_bytes(bytes, sizeof(bytes)) != 0);

  uint8_t *allocation = nts_bytes_allocate(16);
  assert(allocation != NULL);
  memset(allocation, 0xa5, 16);
  nts_bytes_free(allocation);

  int32_t increment = 4;
  assert(nts_call_scoped(call_scoped, &increment, 38) == 42);

  CallbackState state;
  assert(pthread_mutex_init(&state.mutex, NULL) == 0);
  assert(pthread_cond_init(&state.changed, NULL) == 0);
  state.count = 0;
  state.total = 0;

  NtsSubscription *subscription = nts_subscription_create(retained, &state);
  assert(subscription != NULL);
  assert(nts_subscription_emit(subscription, 19) == 0);
  assert(nts_subscription_emit_foreign(subscription, 23) == 0);

  pthread_mutex_lock(&state.mutex);
  while (state.count != 2) {
    pthread_cond_wait(&state.changed, &state.mutex);
  }
  assert(state.total == 42);
  pthread_mutex_unlock(&state.mutex);

  nts_subscription_destroy(subscription);
  pthread_cond_destroy(&state.changed);
  pthread_mutex_destroy(&state.mutex);

  NtsCounter *labelled = nts_counter_create(42);
  NtsCounter *unlabelled = nts_counter_create(0);
  assert(labelled != NULL);
  assert(unlabelled != NULL);
  assert(strcmp(nts_counter_label(labelled), "native \xE2\x9C\x93") == 0);
  assert(strcmp(nts_counter_required_label(labelled), "native \xE2\x9C\x93") == 0);
  assert(nts_counter_label(unlabelled) == NULL);
  nts_counter_destroy(labelled);
  nts_counter_destroy(unlabelled);
  assert(nts_counter_destroyed_count() == 2);

  errno = 0;
  assert(nts_fail_errno(EINVAL) == -1);
  assert(errno == EINVAL);
  return 0;
}
