#----------------------------------------------------------------
# Generated CMake target import file.
#----------------------------------------------------------------

# Commands may need to know the format version.
set(CMAKE_IMPORT_FILE_VERSION 1)

# Import target "OpenDrive::OpenDrive" for configuration ""
set_property(TARGET OpenDrive::OpenDrive APPEND PROPERTY IMPORTED_CONFIGURATIONS NOCONFIG)
set_target_properties(OpenDrive::OpenDrive PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_NOCONFIG "CXX"
  IMPORTED_LOCATION_NOCONFIG "${_IMPORT_PREFIX}/lib/libOpenDrive.a"
  )

list(APPEND _IMPORT_CHECK_TARGETS OpenDrive::OpenDrive )
list(APPEND _IMPORT_CHECK_FILES_FOR_OpenDrive::OpenDrive "${_IMPORT_PREFIX}/lib/libOpenDrive.a" )

# Commands beyond this point should not need to know the version.
set(CMAKE_IMPORT_FILE_VERSION)
