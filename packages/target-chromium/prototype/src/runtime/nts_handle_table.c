#include "runtime/nts_handle_table.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

static uint32_t nts_next_generation(uint32_t generation) {
  generation += 1;
  if (generation == 0) generation = 1;
  return generation;
}

static void nts_slot_reset(NtsHandleTable *table,
                           uint32_t index,
                           bool destroy_token) {
  NtsHandleSlot *slot = &table->slots[index];
  if (!slot->occupied) return;

  void *token = slot->token;
  slot->token = NULL;
  slot->type_id = 0;
  slot->references = 0;
  slot->occupied = false;
  slot->generation = nts_next_generation(slot->generation);
  slot->next_free = table->free_head;
  table->free_head = index;

  if (destroy_token && token != NULL && table->hooks.destroy_token != NULL) {
    table->hooks.destroy_token(table->hooks.context, token);
  }
}

static bool nts_handle_slot_matches(const NtsHandleTable *table,
                                    NtsWebHandle handle) {
  if (handle.generation == 0 || handle.slot >= table->slot_count) return false;
  const NtsHandleSlot *slot = &table->slots[handle.slot];
  return slot->occupied && slot->generation == handle.generation;
}

static bool nts_reserve_slot(NtsHandleTable *table, uint32_t *out_index) {
  if (table->free_head != NTS_HANDLE_NO_SLOT) {
    uint32_t index = table->free_head;
    NtsHandleSlot *slot = &table->slots[index];
    table->free_head = slot->next_free;
    slot->next_free = NTS_HANDLE_NO_SLOT;
    *out_index = index;
    return true;
  }

  if (table->slot_count >= UINT32_MAX) return false;

  if (table->slot_count == table->capacity) {
    size_t new_capacity = table->capacity == 0 ? 16 : table->capacity * 2;
    if (new_capacity < table->capacity ||
        new_capacity > ((size_t)UINT32_MAX + 1u)) {
      new_capacity = (size_t)UINT32_MAX + 1u;
    }
    if (new_capacity <= table->capacity) return false;
    if (new_capacity > SIZE_MAX / sizeof(NtsHandleSlot)) return false;

    NtsHandleSlot *slots = realloc(table->slots,
                                   new_capacity * sizeof(NtsHandleSlot));
    if (slots == NULL) return false;
    memset(slots + table->capacity,
           0,
           (new_capacity - table->capacity) * sizeof(NtsHandleSlot));
    table->slots = slots;
    table->capacity = new_capacity;
  }

  uint32_t index = (uint32_t)table->slot_count++;
  NtsHandleSlot *slot = &table->slots[index];
  slot->generation = 1;
  slot->next_free = NTS_HANDLE_NO_SLOT;
  *out_index = index;
  return true;
}

void nts_handle_table_init(NtsHandleTable *table, NtsHandleTableHooks hooks) {
  memset(table, 0, sizeof *table);
  table->free_head = NTS_HANDLE_NO_SLOT;
  table->hooks = hooks;
}

void nts_handle_table_destroy(NtsHandleTable *table) {
  if (table == NULL) return;
  for (size_t i = 0; i < table->slot_count; i++) {
    if (table->slots[i].occupied) {
      void *token = table->slots[i].token;
      if (token != NULL && table->hooks.destroy_token != NULL) {
        table->hooks.destroy_token(table->hooks.context, token);
      }
    }
  }
  free(table->slots);
  memset(table, 0, sizeof *table);
  table->free_head = NTS_HANDLE_NO_SLOT;
}

void nts_handle_table_invalidate(NtsHandleTable *table) {
  if (table == NULL || table->invalidated) return;
  table->invalidated = true;
  table->free_head = NTS_HANDLE_NO_SLOT;

  for (size_t i = table->slot_count; i > 0; i--) {
    uint32_t index = (uint32_t)(i - 1);
    NtsHandleSlot *slot = &table->slots[index];
    if (slot->occupied) {
      nts_slot_reset(table, index, true);
    } else {
      slot->next_free = table->free_head;
      table->free_head = index;
    }
  }
}

NtsWebStatus nts_handle_table_insert(NtsHandleTable *table,
                                     uint32_t type_id,
                                     void *token,
                                     NtsWebHandle *out_handle) {
  if (table == NULL || out_handle == NULL || token == NULL || type_id == 0) {
    return NTS_WEB_INVALID_ARGUMENT;
  }
  if (table->invalidated) return NTS_WEB_CONTEXT_DESTROYED;

  uint32_t index;
  if (!nts_reserve_slot(table, &index)) return NTS_WEB_OUT_OF_MEMORY;

  NtsHandleSlot *slot = &table->slots[index];
  if (slot->generation == 0) slot->generation = 1;
  slot->references = 1;
  slot->type_id = type_id;
  slot->token = token;
  slot->occupied = true;
  slot->next_free = NTS_HANDLE_NO_SLOT;

  out_handle->slot = index;
  out_handle->generation = slot->generation;
  return NTS_WEB_OK;
}

NtsWebStatus nts_handle_table_retain(NtsHandleTable *table,
                                     NtsWebHandle handle) {
  if (table == NULL) return NTS_WEB_INVALID_ARGUMENT;
  if (table->invalidated) return NTS_WEB_CONTEXT_DESTROYED;
  if (!nts_handle_slot_matches(table, handle)) return NTS_WEB_INVALID_HANDLE;

  NtsHandleSlot *slot = &table->slots[handle.slot];
  if (slot->references == UINT32_MAX) return NTS_WEB_OUT_OF_MEMORY;
  slot->references += 1;
  return NTS_WEB_OK;
}

NtsWebStatus nts_handle_table_release(NtsHandleTable *table,
                                      NtsWebHandle handle) {
  if (table == NULL) return NTS_WEB_INVALID_ARGUMENT;
  if (table->invalidated) return NTS_WEB_CONTEXT_DESTROYED;
  if (!nts_handle_slot_matches(table, handle)) return NTS_WEB_INVALID_HANDLE;

  NtsHandleSlot *slot = &table->slots[handle.slot];
  if (--slot->references == 0) nts_slot_reset(table, handle.slot, true);
  return NTS_WEB_OK;
}

NtsWebStatus nts_handle_table_resolve(NtsHandleTable *table,
                                      NtsWebHandle handle,
                                      uint32_t expected_type,
                                      void **out_token,
                                      uint32_t *out_actual_type) {
  if (table == NULL || out_token == NULL) return NTS_WEB_INVALID_ARGUMENT;
  if (table->invalidated) return NTS_WEB_CONTEXT_DESTROYED;
  if (!nts_handle_slot_matches(table, handle)) return NTS_WEB_INVALID_HANDLE;

  NtsHandleSlot *slot = &table->slots[handle.slot];
  if (expected_type != 0 && slot->type_id != expected_type) {
    if (table->hooks.type_accepts == NULL ||
        !table->hooks.type_accepts(table->hooks.context,
                                  slot->type_id,
                                  expected_type)) {
      return NTS_WEB_INVALID_HANDLE;
    }
  }

  *out_token = slot->token;
  if (out_actual_type != NULL) *out_actual_type = slot->type_id;
  return NTS_WEB_OK;
}

size_t nts_handle_table_live_count(const NtsHandleTable *table) {
  if (table == NULL) return 0;
  size_t live = 0;
  for (size_t i = 0; i < table->slot_count; i++) {
    if (table->slots[i].occupied) live += 1;
  }
  return live;
}
