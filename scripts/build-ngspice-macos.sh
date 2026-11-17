#!/bin/bash
# Maintainer-only darwin-arm64 ngspice 47 console.
# npm run solvers:build-macos runs this script, then packs the GitHub release archive.
# npm run simulation:prepare downloads that archive and does not compile.
# Feature match for the pinned Windows console, from ngspice 47 visualc/config.h
# and vngspice.vcxproj: XSPICE, OSDI, OpenMP, CIDER, KLU, libsndfile, libsamplerate.
# The separate Windows fftw archive is not this build. No X11 and no readline.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=macos-bundle.sh
source "$root/scripts/macos-bundle.sh"

platform="$(uname -s)-$(uname -m)"
[[ "$platform" == "Darwin-arm64" ]] || macos_fail "ngspice bundle builds only on Darwin-arm64 (found $platform)"
clang_version="$(clang --version | head -n 1)"
sdk_version="$(xcrun --show-sdk-version)"
[[ "$clang_version" == "Apple clang version 17.0.0 (clang-1700.6.3.2)" ]] || macos_fail "clang pin mismatch: $clang_version"
[[ "$sdk_version" == "26.2" ]] || macos_fail "macOS SDK pin mismatch: $sdk_version"

downloads="$root/.openpe/downloads"
work="$root/.openpe/build/ngspice-47-darwin-arm64"
prefix="$work/deps"
src="$work/src"
bundle="$root/resources/ngspice/47"
patch="$root/scripts/patches/ngspice-47-macos-codemodel-path.patch"

verify_sha() {
  local file="$1" expect="$2" actual
  actual="$(shasum -a 256 "$file" | awk '{ print $1 }')"
  [[ "$actual" == "$expect" ]] || macos_fail "SHA-256 mismatch for $(basename "$file")"
}

mkdir -p "$downloads"
macos_fetch_verified "https://downloads.sourceforge.net/project/ngspice/ng-spice-rework/47/ngspice-47.tar.gz" \
  "$downloads/ngspice-47.tar.gz" "894e649651f1838a14095e5a5439e7d3aa63e87ede14d283173fda4fcdef675f"
macos_fetch_verified "https://codeload.github.com/libsndfile/libsndfile/tar.gz/refs/tags/1.2.2" \
  "$downloads/libsndfile-1.2.2.tar.gz" "ffe12ef8add3eaca876f04087734e6e8e029350082f3251f565fa9da55b52121"
macos_fetch_verified "https://codeload.github.com/libsndfile/libsamplerate/tar.gz/refs/tags/0.2.2" \
  "$downloads/libsamplerate-0.2.2.tar.gz" "16e881487f184250deb4fcb60432d7556ab12cb58caea71ef23960aec6c0405a"
macos_fetch_verified "https://github.com/llvm/llvm-project/releases/download/llvmorg-14.0.6/openmp-14.0.6.src.tar.xz" \
  "$downloads/openmp-14.0.6.src.tar.xz" "4f731ff202add030d9d68d4c6daabd91d3aeed9812e6a5b4968815cfdff0eb1f"
verify_sha "$patch" "61bb66fc6eb9bbf3ea2ba8b0a5b8056c9213cc32c90b9c325ee9137a4c6fdc73"

sdk_root="$(xcrun --show-sdk-path)"
[[ -f "$sdk_root/usr/include/c++/v1/limits" ]] || macos_fail "macOS SDK libc++ headers are missing"
# This Command Line Tools install has a stale usr/include/c++/v1. C++ must use the SDK headers.
cxx_flags="-isystem $sdk_root/usr/include/c++/v1"
export MACOSX_DEPLOYMENT_TARGET=26.0
export SOURCE_DATE_EPOCH=1786424074
export ZERO_AR_DATE=1
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"

rm -rf "$work"
mkdir -p "$src" "$prefix"
tar -xzf "$downloads/ngspice-47.tar.gz" -C "$src"
tar -xzf "$downloads/libsndfile-1.2.2.tar.gz" -C "$src"
tar -xzf "$downloads/libsamplerate-0.2.2.tar.gz" -C "$src"
tar -xJf "$downloads/openmp-14.0.6.src.tar.xz" -C "$src"
patch -p1 --forward --directory "$src/ngspice-47" <"$patch"

cmake_common=(
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_C_COMPILER=/usr/bin/clang
  -DCMAKE_CXX_COMPILER=/usr/bin/clang++
  -DCMAKE_INSTALL_PREFIX="$prefix"
  -DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew
  -DCMAKE_OSX_DEPLOYMENT_TARGET=26.0
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5
  -DCMAKE_MACOSX_RPATH=ON
  -DBUILD_SHARED_LIBS=ON
  -DBUILD_TESTING=OFF
)

printf 'Building LLVM OpenMP 14.0.6\n'
/opt/homebrew/bin/cmake -S "$src/openmp-14.0.6.src" -B "$work/openmp-build" \
  "${cmake_common[@]}" \
  -DCMAKE_CXX_FLAGS="$cxx_flags" \
  -DLIBOMP_ENABLE_SHARED=ON \
  -DLIBOMP_INSTALL_ALIASES=OFF
/opt/homebrew/bin/cmake --build "$work/openmp-build" --parallel 6
/opt/homebrew/bin/cmake --install "$work/openmp-build"
omp="$(find "$prefix/lib" -name 'libomp.dylib' -type f | head -n 1)"
[[ -n "$omp" && -f "$omp" ]] || macos_fail "libomp.dylib was not installed"
install_name_tool -id '@rpath/libomp.dylib' "$omp"

printf 'Building libsamplerate 0.2.2\n'
/opt/homebrew/bin/cmake -S "$src/libsamplerate-0.2.2" -B "$work/samplerate-build" \
  "${cmake_common[@]}" \
  -DLIBSAMPLERATE_EXAMPLES=OFF \
  -DLIBSAMPLERATE_INSTALL=ON
/opt/homebrew/bin/cmake --build "$work/samplerate-build" --parallel 6
/opt/homebrew/bin/cmake --install "$work/samplerate-build"

printf 'Building libsndfile 1.2.2\n'
/opt/homebrew/bin/cmake -S "$src/libsndfile-1.2.2" -B "$work/sndfile-build" \
  "${cmake_common[@]}" \
  -DCMAKE_MODULE_PATH="$root/scripts/cmake" \
  -DBUILD_PROGRAMS=OFF \
  -DBUILD_EXAMPLES=OFF \
  -DENABLE_EXTERNAL_LIBS=OFF \
  -DENABLE_MPEG=OFF \
  -DENABLE_EXPERIMENTAL=OFF
/opt/homebrew/bin/cmake --build "$work/sndfile-build" --parallel 6
/opt/homebrew/bin/cmake --install "$work/sndfile-build"

wrapper="$work/clang-openmp"
cat >"$wrapper" <<EOF
#!/bin/sh
link=1
omp=0
out=()
for arg in "\$@"; do
  case "\$arg" in
    -fopenmp)
      omp=1
      out+=("-Xpreprocessor" "-fopenmp" "-I$prefix/include")
      ;;
    -c|-E|-S|-M|-MM) link=0; out+=("\$arg") ;;
    *) out+=("\$arg") ;;
  esac
done
if [ "\$link" = 1 ] && [ "\$omp" = 1 ]; then
  out+=("-L$prefix/lib" "-lomp" "-Wl,-rpath,$prefix/lib")
fi
exec /usr/bin/clang "\${out[@]}"
EOF
chmod +x "$wrapper"

printf 'Configuring ngspice 47\n'
mkdir -p "$work/ngspice-build"
(
  cd "$work/ngspice-build"
  ../src/ngspice-47/configure \
    --prefix="$work/ngspice-install" \
    --without-x \
    --with-readline=no \
    --with-fftw3=no \
    --enable-cider \
    --enable-xspice \
    --enable-osdi \
    --enable-openmp \
    --enable-klu \
    --disable-debug \
    CC="$wrapper" \
    CXX=/usr/bin/clang++ \
    CFLAGS="-O2 -I$prefix/include" \
    CXXFLAGS="-O2 $cxx_flags" \
    LDFLAGS="-L$prefix/lib" \
    CPPFLAGS="-I$prefix/include"
)
make -C "$work/ngspice-build" -j6
make -C "$work/ngspice-build" install

config_h="$work/ngspice-build/src/include/ngspice/config.h"
grep -q 'USE_OMP 1' "$config_h" || macos_fail "OpenMP was not enabled"
grep -q 'XSPICE 1' "$config_h" || macos_fail "XSPICE was not enabled"
grep -q 'OSDI 1' "$config_h" || macos_fail "OSDI was not enabled"
grep -q 'CIDER 1' "$config_h" || macos_fail "CIDER was not enabled"
grep -q 'define KLU' "$config_h" || macos_fail "KLU was not enabled"
grep -q 'HAVE_LIBSNDFILE' "$config_h" || macos_fail "libsndfile was not enabled"
grep -q 'HAVE_LIBSAMPLERATE' "$config_h" || macos_fail "libsamplerate was not enabled"
if grep -q 'HAVE_LIBFFTW3' "$config_h"; then macos_fail "fftw3 was enabled"; fi
if grep -q 'HAVE_GNUREADLINE' "$config_h"; then macos_fail "readline was enabled"; fi

stage="$work/bundle/Spice64"
rm -rf "$work/bundle"
mkdir -p "$stage/bin" "$stage/lib/ngspice" "$stage/share/ngspice/scripts" "$stage/docs"
cp -p "$work/ngspice-install/bin/ngspice" "$stage/bin/ngspice"
cp -p "$src/ngspice-47/COPYING" "$stage/docs/COPYING"
cp -p "$src/ngspice-47/AUTHORS" "$stage/docs/AUTHORS"
cp -p "$src/ngspice-47/visualc/spinit_all" "$stage/share/ngspice/scripts/spinit"
shopt -s nullglob
models=("$work/ngspice-install/lib/ngspice/"*.cm)
(( ${#models[@]} == 7 )) || macos_fail "expected 7 XSPICE code models, found ${#models[@]}"
for model in "${models[@]}"; do
  cp -p "$model" "$stage/lib/ngspice/$(basename "$model")"
done
shopt -u nullglob
deps="$work/deps/lib"
for name in libsndfile.1.dylib libsamplerate.0.dylib libomp.dylib; do
  cp -p "$(realpath "$deps/$name")" "$stage/bin/$name"
done
macos_relocate_bundle "$work/bundle" "$stage/bin"

version="$(SPICE_LIB_DIR="$stage/share/ngspice" "$stage/bin/ngspice" -n --version 2>&1 || true)"
printf '%s\n' "$version" | grep -q 'ngspice-47' || macos_fail "ngspice version probe failed: $version"
probe="$work/probe"
rm -rf "$probe"
mkdir -p "$probe"
printf '%s\n' 'codemodel probe' 'V1 in 0 dc 1' 'R1 in 0 1k' '.end' >"$probe/tiny.cir"
(
  cd "$probe"
  SPICE_LIB_DIR="$stage/share/ngspice" "$stage/bin/ngspice" -n -b tiny.cir >"$probe/out.txt" 2>&1
) || {
  cat "$probe/out.txt" >&2
  macos_fail "ngspice probe failed"
}
if grep -q "couldn't be loaded" "$probe/out.txt"; then
  cat "$probe/out.txt" >&2
  macos_fail "XSPICE code models failed to load"
fi

mkdir -p "$bundle"
rm -rf "$bundle/Spice64"
cp -R "$work/bundle/Spice64" "$bundle/Spice64"
printf 'ngspice 47 darwin-arm64 bundle staged under resources/ngspice/47\n'
