#include "nts_scabi_fixture.h"

#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct NtsSubscription {
  pthread_mutex_t mutex;
  pthread_cond_t idle;
  NtsRetainedCallback callback;
  void *context;
  size_t active;
  bool closing;
};

struct NtsCounter {
  int32_t value;
};

static int32_t nts_counter_destroyed = 0;

typedef struct NtsForeignInvocation {
  NtsSubscription *subscription;
  int32_t value;
} NtsForeignInvocation;

int8_t nts_i8_identity(int8_t value) { return value; }
uint8_t nts_u8_identity(uint8_t value) { return value; }
int16_t nts_i16_identity(int16_t value) { return value; }
uint16_t nts_u16_identity(uint16_t value) { return value; }
int32_t nts_i32_identity(int32_t value) { return value; }
uint32_t nts_u32_identity(uint32_t value) { return value; }
int64_t nts_i64_identity(int64_t value) { return value; }
/* The same identity under a second symbol: one C symbol carries one binding,
 * so reading a 64-bit slot as a number while another binding reads it exactly
 * needs an entry point of its own. */
int64_t nts_i64_passthrough(int64_t value) { return value; }
uint64_t nts_u64_identity(uint64_t value) { return value; }
size_t nts_usize_identity(size_t value) { return value; }
float nts_f32_identity(float value) { return value; }
double nts_f64_identity(double value) { return value; }
int32_t nts_boolean_false(void) { return 0; }
int32_t nts_boolean_invalid(void) { return 2; }
int32_t nts_boolean_not(int32_t value) {
  if (value != 0 && value != 1) {
    abort();
  }
  return value == 0 ? 1 : 0;
}
int32_t nts_boolean_true(void) { return 1; }

NtsPadded nts_padded_roundtrip(NtsPadded value) { return value; }

NtsPair32 nts_pair32_transform(NtsPair32 value) {
  if (value.first != 40 || value.second != 2) {
    abort();
  }
  NtsPair32 result = {value.second, value.first + 2};
  return result;
}

NtsNestedPair32 nts_nested_pair32_transform(NtsNestedPair32 value) {
  if (value.left.first != 40 || value.left.second != 2 ||
      value.right.first != 3 || value.right.second != 4 || value.marker != 9) {
    abort();
  }
  NtsNestedPair32 result = {
    value.right,
    {value.left.second, value.left.first + 2},
    value.marker + 1,
  };
  return result;
}

static uint64_t nts_hash(const uint8_t *data, size_t length) {
  uint64_t hash = UINT64_C(14695981039346656037);
  for (size_t index = 0; index < length; index += 1) {
    hash ^= data[index];
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

uint64_t nts_hash_utf8(const char *data, size_t length) {
  return nts_hash((const uint8_t *)data, length);
}

void nts_c_string_observe(const char *data) {
  if (strcmp(data, "native") != 0 && strcmp(data, "done") != 0) {
    abort();
  }
}

uint64_t nts_hash_bytes(const uint8_t *data, size_t length) {
  return nts_hash(data, length);
}

uint8_t *nts_bytes_allocate(size_t length) {
  if (length == 0) {
    length = 1;
  }
  return (uint8_t *)malloc(length);
}

void nts_bytes_free(uint8_t *data) { free(data); }

int32_t nts_call_scoped(
    NtsCallCallback callback,
    void *context,
    int32_t value) {
  return callback(value, context);
}

NtsSubscription *nts_subscription_create(
    NtsRetainedCallback callback,
    void *context) {
  NtsSubscription *subscription =
      (NtsSubscription *)calloc(1, sizeof(NtsSubscription));
  if (subscription == NULL) {
    return NULL;
  }

  int result = pthread_mutex_init(&subscription->mutex, NULL);
  if (result != 0) {
    free(subscription);
    errno = result;
    return NULL;
  }
  result = pthread_cond_init(&subscription->idle, NULL);
  if (result != 0) {
    pthread_mutex_destroy(&subscription->mutex);
    free(subscription);
    errno = result;
    return NULL;
  }

  subscription->callback = callback;
  subscription->context = context;
  return subscription;
}

static bool nts_subscription_admit(NtsSubscription *subscription) {
  pthread_mutex_lock(&subscription->mutex);
  if (subscription->closing) {
    pthread_mutex_unlock(&subscription->mutex);
    return false;
  }
  subscription->active += 1;
  pthread_mutex_unlock(&subscription->mutex);
  return true;
}

static void nts_subscription_finish(NtsSubscription *subscription) {
  pthread_mutex_lock(&subscription->mutex);
  subscription->active -= 1;
  if (subscription->closing && subscription->active == 0) {
    pthread_cond_signal(&subscription->idle);
  }
  pthread_mutex_unlock(&subscription->mutex);
}

int32_t nts_subscription_emit(
    NtsSubscription *subscription,
    int32_t value) {
  if (!nts_subscription_admit(subscription)) {
    errno = ECANCELED;
    return -1;
  }
  subscription->callback(value, subscription->context);
  nts_subscription_finish(subscription);
  return 0;
}

static void *nts_foreign_invoke(void *opaque) {
  NtsForeignInvocation *invocation = (NtsForeignInvocation *)opaque;
  NtsSubscription *subscription = invocation->subscription;
  int32_t value = invocation->value;
  free(invocation);

  subscription->callback(value, subscription->context);
  nts_subscription_finish(subscription);
  return NULL;
}

int32_t nts_subscription_emit_foreign(
    NtsSubscription *subscription,
    int32_t value) {
  if (!nts_subscription_admit(subscription)) {
    errno = ECANCELED;
    return -1;
  }

  NtsForeignInvocation *invocation =
      (NtsForeignInvocation *)malloc(sizeof(NtsForeignInvocation));
  if (invocation == NULL) {
    nts_subscription_finish(subscription);
    return -1;
  }
  invocation->subscription = subscription;
  invocation->value = value;

  pthread_attr_t attributes;
  int result = pthread_attr_init(&attributes);
  if (result != 0) {
    free(invocation);
    nts_subscription_finish(subscription);
    errno = result;
    return -1;
  }
  result = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
  if (result != 0) {
    pthread_attr_destroy(&attributes);
    free(invocation);
    nts_subscription_finish(subscription);
    errno = result;
    return -1;
  }

  pthread_t thread;
  result = pthread_create(&thread, &attributes, nts_foreign_invoke, invocation);
  pthread_attr_destroy(&attributes);
  if (result != 0) {
    free(invocation);
    nts_subscription_finish(subscription);
    errno = result;
    return -1;
  }
  return 0;
}

void nts_subscription_destroy(NtsSubscription *subscription) {
  if (subscription == NULL) {
    return;
  }

  pthread_mutex_lock(&subscription->mutex);
  subscription->closing = true;
  while (subscription->active != 0) {
    pthread_cond_wait(&subscription->idle, &subscription->mutex);
  }
  pthread_mutex_unlock(&subscription->mutex);

  pthread_cond_destroy(&subscription->idle);
  pthread_mutex_destroy(&subscription->mutex);
  free(subscription);
}

NtsCounter *nts_counter_create(int32_t initial_value) {
  NtsCounter *counter = (NtsCounter *)malloc(sizeof *counter);
  if (counter == NULL) {
    return NULL;
  }
  counter->value = initial_value;
  return counter;
}

int32_t nts_counter_add(NtsCounter *counter, int32_t delta) {
  counter->value += delta;
  return counter->value;
}

int32_t nts_counter_value(NtsCounter *counter) { return counter->value; }

const char *nts_counter_label(NtsCounter *counter) {
  return counter->value == 42 ? "native \xE2\x9C\x93" : NULL;
}

const char *nts_counter_required_label(NtsCounter *counter) {
  return nts_counter_label(counter);
}

void nts_counter_destroy(NtsCounter *counter) {
  nts_counter_destroyed += 1;
  free(counter);
}

int32_t nts_counter_destroyed_count(void) { return nts_counter_destroyed; }

int32_t nts_counter_verify(
    int32_t actual_value,
    int32_t actual_destroyed,
    int32_t expected_value,
    int32_t expected_destroyed) {
  return actual_value == expected_value && actual_destroyed == expected_destroyed
             ? 42
             : 1;
}

int32_t nts_fail_errno(int32_t error_number) {
  errno = error_number;
  return -1;
}

struct NtsFixtureError {
  char *message;
};

static int32_t nts_fixture_errors_live;

NtsFixtureError *nts_error_handle_fail(int32_t code) {
  if (code == 0) return NULL;
  NtsFixtureError *error = malloc(sizeof *error);
  if (error == NULL) abort();
  static const char prefix[] = "fixture failure ";
  size_t capacity = sizeof prefix + 16;
  error->message = malloc(capacity);
  if (error->message == NULL) abort();
  snprintf(error->message, capacity, "%s%d", prefix, (int)code);
  nts_fixture_errors_live += 1;
  return error;
}

/* Failure in a trailing slot, so the result is free to carry the quotient.
 * On failure it returns a value that would be WRONG to use, so a boundary that
 * forgets to unwind reads it and says so. */
int32_t nts_error_out_divide(int32_t numerator, int32_t divisor,
                             NtsFixtureError **error) {
  if (divisor == 0) {
    *error = nts_error_handle_fail(numerator);
    return -12345;
  }
  return numerator / divisor;
}

const char *nts_fixture_error_message(NtsFixtureError *error) {
  return error->message;
}

void nts_fixture_error_free(NtsFixtureError *error) {
  nts_fixture_errors_live -= 1;
  free(error->message);
  free(error);
}

int32_t nts_fixture_errors_outstanding(void) { return nts_fixture_errors_live; }

int32_t nts_counter_value_or(NtsCounter *counter, int32_t fallback) {
  return counter == NULL ? fallback : nts_counter_value(counter);
}

int32_t nts_counter_base_value_or(NtsCounter *counter, int32_t fallback) {
  return counter == NULL ? fallback : nts_counter_value(counter);
}

void nts_cstring_free(char *data) { free(data); }

char *nts_span_label(size_t *out_length) {
  static const char text[] = "na\0me";
  size_t length = sizeof text - 1;
  char *copy = (char *)malloc(length);
  if (copy == NULL) {
    *out_length = 0;
    return NULL;
  }
  memcpy(copy, text, length);
  *out_length = length;
  return copy;
}

char *nts_span_label_maybe(int32_t which, size_t *out_length) {
  *out_length = 0;
  if (which < 0) {
    return NULL;
  }
  return nts_span_label(out_length);
}

uint8_t nts_error_out_u8(int32_t value, NtsFixtureError **error) {
  if (value < 0) {
    *error = nts_error_handle_fail(value);
    return 0xFEu;
  }
  return (uint8_t)(value & 0xFF);
}

int8_t nts_error_out_i8(int32_t value, NtsFixtureError **error) {
  if (value < 0) {
    *error = nts_error_handle_fail(value);
    return -128;
  }
  return (int8_t)(value & 0x7F);
}

struct NtsTeller {
  NtsTellCallback callback;
  void *context;
};

static int32_t nts_tell_marks = 0;

NtsTeller *nts_teller_create(NtsTellCallback callback, void *context) {
  NtsTeller *teller = (NtsTeller *)calloc(1, sizeof *teller);
  if (teller == NULL) {
    return NULL;
  }
  teller->callback = callback;
  teller->context = context;
  return teller;
}

void nts_tell_mark(void) { nts_tell_marks += 1; }

int32_t nts_teller_tell(NtsTeller *teller, int32_t seed) {
  nts_tell_marks = 0;
  NtsCounter *subject = nts_counter_create(seed);
  teller->callback(subject, teller->context);
  return nts_tell_marks;
}

void nts_teller_destroy(NtsTeller *teller) { free(teller); }

struct NtsJudge {
  NtsJudgeCallback callback;
  void *context;
};

NtsJudge *nts_judge_create(NtsJudgeCallback callback, void *context) {
  NtsJudge *judge = (NtsJudge *)calloc(1, sizeof *judge);
  if (judge == NULL) {
    return NULL;
  }
  judge->callback = callback;
  judge->context = context;
  return judge;
}

int32_t nts_judge_ask(NtsJudge *judge, int32_t code, int32_t seed) {
  NtsCounter *subject = nts_counter_create(seed);
  return judge->callback(code, subject, judge->context);
}

void nts_judge_destroy(NtsJudge *judge) { free(judge); }

static NtsNoticeCallback nts_notice_cb = NULL;
static void *nts_notice_ctx = NULL;
static int32_t nts_notice_marks = 0;

void nts_notice_register(NtsNoticeCallback callback, void *context) {
  nts_notice_cb = callback;
  nts_notice_ctx = context;
}

void nts_notice_mark(void) { nts_notice_marks += 1; }

int32_t nts_notice_fire(int32_t seed) {
  nts_notice_marks = 0;
  NtsCounter *subject = nts_counter_create(seed);
  nts_notice_cb(subject, nts_notice_ctx);
  return nts_notice_marks;
}

struct NtsTickSource {
  int32_t value;
};

int32_t nts_tick_source_value(NtsTickSource *self) { return self->value; }

void nts_tick_source_destroy(NtsTickSource *self) { free(self); }

static NtsTickCallback nts_tick_cb = NULL;
static void *nts_tick_ctx = NULL;
static int32_t nts_tick_marks = 0;

void nts_tick_register(NtsTickCallback callback, void *context) {
  nts_tick_cb = callback;
  nts_tick_ctx = context;
}

void nts_tick_mark(void) { nts_tick_marks += 1; }

int32_t nts_tick_fire(int32_t seed) {
  nts_tick_marks = 0;
  /* The framework constructs the receiver, which is why nothing in the program
   * does — and why the registration is anchored to the class rather than to an
   * instance that does not exist when one could register. */
  NtsTickSource *self = calloc(1, sizeof *self);
  self->value = seed;
  nts_tick_cb(self, seed, nts_tick_ctx);
  return nts_tick_marks;
}

/* The base's member as an ORDINARY VIRTUAL call — what a platform's own
 * `Activity.onCreate` binding is, and what `super` must NOT reach. On Android
 * this one redispatches into the override that called it and the program
 * recurses until the stack ends; here it marks distinctively instead, so a
 * test can say WHICH binding a base call resolved to rather than only that
 * something ran. */
void nts_tick_virtual(NtsTickSource *self, int32_t seed) {
  (void)self;
  (void)seed;
  nts_tick_marks += 100;
}

void nts_tick_base(NtsTickSource *self, int32_t seed) {
  (void)self;
  nts_tick_marks += seed;
}

static NtsMaybeCallback nts_maybe_cb = NULL;
static void *nts_maybe_ctx = NULL;
static int32_t nts_maybe_marks = 0;

void nts_maybe_register(NtsMaybeCallback callback, void *context) {
  nts_maybe_cb = callback;
  nts_maybe_ctx = context;
}

void nts_maybe_mark(void) { nts_maybe_marks += 1; }

int32_t nts_maybe_fire(int32_t seed) {
  nts_maybe_marks = 0;
  NtsCounter *subject = seed < 0 ? NULL : nts_counter_create(seed);
  nts_maybe_cb(subject, nts_maybe_ctx);
  return nts_maybe_marks;
}

int32_t nts_judge_ask_maybe(NtsJudge *judge, int32_t code, int32_t seed) {
  NtsCounter *subject = seed < 0 ? NULL : nts_counter_create(seed);
  return judge->callback(code, subject, judge->context);
}
