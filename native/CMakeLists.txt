cmake_minimum_required(VERSION 3.16)

project(opendrive_native_tools LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_subdirectory(libOpenDRIVE)

add_executable(odr_json_parser odr_json_parser.cpp)
target_link_libraries(odr_json_parser PRIVATE OpenDrive)
target_include_directories(odr_json_parser PRIVATE libOpenDRIVE/include)

set_target_properties(odr_json_parser PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/bin
)
