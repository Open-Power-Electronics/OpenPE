# CMake 4 removed FindPythonInterp. libsndfile 1.2.2 still calls it for shared builds.
find_program(PYTHON_EXECUTABLE NAMES python3 python REQUIRED)
include(FindPackageHandleStandardArgs)
find_package_handle_standard_args(PythonInterp REQUIRED_VARS PYTHON_EXECUTABLE)
