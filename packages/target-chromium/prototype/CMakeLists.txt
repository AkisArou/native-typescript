cmake_minimum_required(VERSION 3.20)
project(native_typescript_chromium_prototype C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_library(nts_web_contract INTERFACE)
target_include_directories(nts_web_contract INTERFACE
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)

add_library(nts_web_runtime STATIC
  src/runtime/nts_handle_table.c
  src/runtime/nts_web_exception.c
)
target_include_directories(nts_web_runtime PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/src
)
target_link_libraries(nts_web_runtime PUBLIC nts_web_contract)

add_library(nts_counter_example OBJECT
  examples/counter/app.c
)
target_link_libraries(nts_counter_example PRIVATE nts_web_contract)

add_library(nts_create_element_example OBJECT
  examples/create-element/app.c
)
target_link_libraries(nts_create_element_example PRIVATE nts_web_contract)

if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(nts_web_runtime PRIVATE
    -Wall -Wextra -Wpedantic -Werror
  )
  target_compile_options(nts_counter_example PRIVATE
    -Wall -Wextra -Wpedantic -Werror
  )
  target_compile_options(nts_create_element_example PRIVATE
    -Wall -Wextra -Wpedantic -Werror
  )
endif()

enable_testing()
add_executable(nts_handle_table_test
  tests/handle_table.c
)
target_link_libraries(nts_handle_table_test PRIVATE nts_web_runtime)
if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(nts_handle_table_test PRIVATE
    -Wall -Wextra -Wpedantic -Werror
  )
endif()
add_test(NAME handle-table COMMAND nts_handle_table_test)

add_executable(nts_counter_contract_test
  examples/counter/app.c
  tests/counter_contract.c
)
target_link_libraries(nts_counter_contract_test PRIVATE nts_web_runtime)
if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(nts_counter_contract_test PRIVATE
    -Wall -Wextra -Wpedantic -Werror
  )
endif()
add_test(NAME counter-contract COMMAND nts_counter_contract_test)

# This standalone CMake build validates the public C contract and target-neutral
# runtime pieces. The Blink adapter is compiled inside a pinned Chromium
# GN/Ninja build, where Blink's C++ implementation types are available.
