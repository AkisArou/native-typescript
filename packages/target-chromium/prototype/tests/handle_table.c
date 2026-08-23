#include <assert.h>
#include <stdint.h>
#include <stdlib.h>

#include "runtime/nts_handle_table.h"

typedef struct {
  unsigned destroyed;
} TestContext;

static void destroy_token(void *opaque, void *token) {
  TestContext *context = opaque;
  context->destroyed += 1;
  free(token);
}

static bool type_accepts(void *opaque,
                         uint32_t actual_type,
                         uint32_t expected_type) {
  (void)opaque;
  /* Test type 2 as a subtype of type 1. */
  return actual_type == 2 && expected_type == 1;
}

static void *new_token(int value) {
  int *token = malloc(sizeof *token);
  assert(token != NULL);
  *token = value;
  return token;
}

int main(void) {
  TestContext context = {0};
  NtsHandleTable table;
  NtsHandleTableHooks hooks = {
      .destroy_token = destroy_token,
      .type_accepts = type_accepts,
      .context = &context,
  };
  nts_handle_table_init(&table, hooks);

  NtsWebHandle child;
  assert(nts_handle_table_insert(&table, 2, new_token(7), &child) ==
         NTS_WEB_OK);
  assert(child.generation != 0);
  assert(nts_handle_table_live_count(&table) == 1);

  void *resolved = NULL;
  uint32_t actual_type = 0;
  assert(nts_handle_table_resolve(&table, child, 2, &resolved, &actual_type) ==
         NTS_WEB_OK);
  assert(*(int *)resolved == 7);
  assert(actual_type == 2);

  /* Generated base-interface calls can resolve a derived-interface handle. */
  resolved = NULL;
  assert(nts_handle_table_resolve(&table, child, 1, &resolved, NULL) ==
         NTS_WEB_OK);
  assert(*(int *)resolved == 7);

  assert(nts_handle_table_retain(&table, child) == NTS_WEB_OK);
  assert(nts_handle_table_release(&table, child) == NTS_WEB_OK);
  assert(context.destroyed == 0);
  assert(nts_handle_table_release(&table, child) == NTS_WEB_OK);
  assert(context.destroyed == 1);
  assert(nts_handle_table_live_count(&table) == 0);

  /* The old generation is stale even when the free slot is reused. */
  NtsWebHandle replacement;
  assert(nts_handle_table_insert(&table, 2, new_token(9), &replacement) ==
         NTS_WEB_OK);
  assert(replacement.slot == child.slot);
  assert(replacement.generation != child.generation);
  assert(nts_handle_table_resolve(&table, child, 0, &resolved, NULL) ==
         NTS_WEB_INVALID_HANDLE);

  NtsWebHandle second;
  assert(nts_handle_table_insert(&table, 1, new_token(11), &second) ==
         NTS_WEB_OK);
  assert(nts_handle_table_live_count(&table) == 2);

  /* Realm destruction destroys every backend root once and rejects all later
   * accesses before any stale token can be observed. */
  nts_handle_table_invalidate(&table);
  assert(context.destroyed == 3);
  assert(nts_handle_table_live_count(&table) == 0);
  assert(nts_handle_table_retain(&table, replacement) ==
         NTS_WEB_CONTEXT_DESTROYED);
  assert(nts_handle_table_release(&table, second) ==
         NTS_WEB_CONTEXT_DESTROYED);

  /* A failed insert does not transfer token ownership to the table. */
  void *rejected = new_token(13);
  assert(nts_handle_table_insert(&table, 1, rejected, &second) ==
         NTS_WEB_CONTEXT_DESTROYED);
  free(rejected);

  nts_handle_table_destroy(&table);
  assert(context.destroyed == 3);
  return 0;
}
