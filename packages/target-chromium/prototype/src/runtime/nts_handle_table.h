#ifndef NTS_HANDLE_TABLE_H
#define NTS_HANDLE_TABLE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "nts_web.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*NtsHandleTokenDestroy)(void *context, void *token);
typedef bool (*NtsHandleTypeAccepts)(void *context,
                                     uint32_t actual_type,
                                     uint32_t expected_type);

typedef struct {
  NtsHandleTokenDestroy destroy_token;
  NtsHandleTypeAccepts type_accepts;
  void *context;
} NtsHandleTableHooks;

typedef struct {
  uint32_t generation;
  uint32_t references;
  uint32_t type_id;
  uint32_t next_free;
  void *token;
  bool occupied;
} NtsHandleSlot;

typedef struct {
  NtsHandleSlot *slots;
  size_t slot_count;
  size_t capacity;
  uint32_t free_head;
  bool invalidated;
  NtsHandleTableHooks hooks;
} NtsHandleTable;

/* UINT32_MAX is reserved as the end-of-free-list marker. Slot indices are
 * otherwise ordinary zero-based array indices. Generation zero is never
 * issued, which leaves {0, 0} available as a convenient null-like value. */
#define NTS_HANDLE_NO_SLOT UINT32_MAX

void nts_handle_table_init(NtsHandleTable *table, NtsHandleTableHooks hooks);

/* Destroys every live token exactly once and frees the slot storage. After
 * destroy, the table may be initialized again. */
void nts_handle_table_destroy(NtsHandleTable *table);

/* Invalidates the realm-facing identity space without freeing the table's
 * storage. Every live token is destroyed exactly once and every occupied
 * slot advances generation before it enters the free list. New inserts are
 * rejected after invalidation. */
void nts_handle_table_invalidate(NtsHandleTable *table);

NtsWebStatus nts_handle_table_insert(NtsHandleTable *table,
                                     uint32_t type_id,
                                     void *token,
                                     NtsWebHandle *out_handle);

NtsWebStatus nts_handle_table_retain(NtsHandleTable *table,
                                     NtsWebHandle handle);

NtsWebStatus nts_handle_table_release(NtsHandleTable *table,
                                      NtsWebHandle handle);

/* Resolves a checked handle to the backend token. expected_type == 0 disables
 * the type test. Otherwise the exact type must match or the hook must admit
 * actual_type as a subtype of expected_type. */
NtsWebStatus nts_handle_table_resolve(NtsHandleTable *table,
                                      NtsWebHandle handle,
                                      uint32_t expected_type,
                                      void **out_token,
                                      uint32_t *out_actual_type);

size_t nts_handle_table_live_count(const NtsHandleTable *table);

#ifdef __cplusplus
}
#endif

#endif
