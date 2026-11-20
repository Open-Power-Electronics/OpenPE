#!/bin/bash
# Maintainer-only darwin-arm64 Elmer 26.1, OpenBLAS 0.3.13 and pinned Gmsh SDK.
# npm run solvers:build-macos runs this script, then packs the GitHub release archive.
# npm run thermal:prepare downloads that archive and does not compile.
# Build-time compilers may live in Homebrew. The staged bundle must not.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=macos-bundle.sh
source "$root/scripts/macos-bundle.sh"

platform="$(uname -s)-$(uname -m)"
[[ "$platform" == "Darwin-arm64" ]] || macos_fail "thermal bundle builds only on Darwin-arm64 (found $platform)"

clang_version="$(clang --version | head -n 1)"
gfortran_version="$(/opt/homebrew/bin/gfortran --version | head -n 1)"
cmake_version="$(/opt/homebrew/bin/cmake --version | head -n 1)"
sdk_version="$(xcrun --show-sdk-version)"
[[ "$clang_version" == "Apple clang version 17.0.0 (clang-1700.6.3.2)" ]] || macos_fail "clang pin mismatch: $clang_version"
[[ "$gfortran_version" == "GNU Fortran (Homebrew GCC 16.2.0) 16.2.0" ]] || macos_fail "gfortran pin mismatch: $gfortran_version"
[[ "$cmake_version" == "cmake version 4.4.5" ]] || macos_fail "cmake pin mismatch: $cmake_version"
[[ "$sdk_version" == "26.2" ]] || macos_fail "macOS SDK pin mismatch: $sdk_version"

downloads="$root/.openpe/downloads"
work="$root/.openpe/build/thermal-darwin-arm64"
bundle="$root/resources/thermal/1"
openblas_src="$work/src/OpenBLAS-0.3.13"
openblas_prefix="$work/openblas"
elmer_src="$work/src/elmerfem"
elmer_build="$work/elmer-build"
elmer_prefix="$work/elmer-install"
gmsh_src="$work/src/gmsh-sdk"

verify_sha() {
  local file="$1" expect="$2"
  local actual
  actual="$(shasum -a 256 "$file" | awk '{ print $1 }')"
  [[ "$actual" == "$expect" ]] || macos_fail "SHA-256 mismatch for $(basename "$file")"
}

mkdir -p "$downloads"
macos_fetch_verified "https://github.com/OpenMathLib/OpenBLAS/archive/refs/tags/v0.3.13.tar.gz" \
  "$downloads/OpenBLAS-0.3.13.tar.gz" "79197543b17cc314b7e43f7a33148c308b0807cd6381ee77f77e15acf3e6459e"
macos_fetch_verified "https://github.com/ElmerCSC/elmerfem/releases/download/release-26.1/elmerfem-release-26.1.tar.gz" \
  "$downloads/elmerfem-release-26.1.tar.gz" "3a0f14947b5fa83d72506e45d041b54e401a1253ce454afdc188a13c05428990"
macos_fetch_verified "https://gmsh.info/bin/macOS/gmsh-4.15.2-MacOSARM-sdk.tgz" \
  "$downloads/gmsh-4.15.2-MacOSARM-sdk.tgz" "2ebbc7c241a1681fc21e1bd32fe7f6637449bf407dbd642cf4f8751d56d46b25"
# Corresponding source for the copied GCC runtime. This build links Homebrew GCC 16.2.0 and does not compile the archive.
macos_fetch_verified "https://ftp.gnu.org/gnu/gcc/gcc-16.2.0/gcc-16.2.0.tar.xz" \
  "$downloads/gcc-16.2.0.tar.xz" "e6738e29597f733270731aa90600f37ffdc045079dfc27ec7e8192cc81085c3e"
openblas_patch="$root/scripts/patches/openblas-0.3.13-macos-rpath.patch"
verify_sha "$openblas_patch" "e5c9024bbca6dde16358f49a7529b549bc7d3b7aa077f5913429ef1fef840fa1"

rm -rf "$work"
mkdir -p "$work/src" "$bundle"
tar -xzf "$downloads/OpenBLAS-0.3.13.tar.gz" -C "$work/src"
patch -p1 --forward --directory "$openblas_src" <"$openblas_patch"
tar -xzf "$downloads/elmerfem-release-26.1.tar.gz" -C "$work/src"
mv "$work/src/elmerfem-release-26.1" "$elmer_src"
rm -rf "$gmsh_src"
mkdir -p "$gmsh_src"
tar -xzf "$downloads/gmsh-4.15.2-MacOSARM-sdk.tgz" -C "$gmsh_src"

sdk_root="$(xcrun --show-sdk-path)"
[[ -f "$sdk_root/usr/include/c++/v1/limits" ]] || macos_fail "macOS SDK libc++ headers are missing"
cxx_flags="-isystem $sdk_root/usr/include/c++/v1"
export MACOSX_DEPLOYMENT_TARGET=26.0
export SOURCE_DATE_EPOCH=1786424074
export ZERO_AR_DATE=1
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"

printf 'Building OpenBLAS 0.3.13\n'
openblas_make=(
  TARGET=ARMV8
  DYNAMIC_ARCH=0
  NO_SHARED=0
  USE_OPENMP=0
  USE_THREAD=1
  CC=/usr/bin/clang
  FC=/opt/homebrew/bin/gfortran
  HOSTCC=/usr/bin/clang
  CFLAGS="-O2 -fno-lto -Wno-error=implicit-function-declaration -Wno-error=implicit-int"
  FFLAGS="-O2 -fno-lto"
  PREFIX="$openblas_prefix"
)
make -C "$openblas_src" -j6 "${openblas_make[@]}" libs netlib shared
make -C "$openblas_src" "${openblas_make[@]}" install
[[ -f "$openblas_prefix/lib/libopenblas.dylib" ]] || macos_fail "OpenBLAS did not install libopenblas.dylib"

printf 'Configuring Elmer 26.1\n'
/opt/homebrew/bin/cmake -S "$elmer_src" -B "$elmer_build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=/usr/bin/clang \
  -DCMAKE_CXX_COMPILER=/usr/bin/clang++ \
  -DCMAKE_CXX_FLAGS="$cxx_flags" \
  -DCMAKE_Fortran_COMPILER=/opt/homebrew/bin/gfortran \
  -DCMAKE_INSTALL_PREFIX="$elmer_prefix" \
  -DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=26.0 \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_MACOSX_RPATH=ON \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DUSE_MACOS_PACKAGE_MANAGER=OFF \
  -DWITH_MPI=OFF \
  -DWITH_ELMERGUI=OFF \
  -DWITH_OpenMP=OFF \
  -DWITH_Mumps=OFF \
  -DWITH_UMFPACK=ON \
  -DWITH_ElmerIce=OFF \
  -DBUILD_TESTING=OFF \
  -DBLA_VENDOR=OpenBLAS \
  -DBLAS_LIBRARIES="$openblas_prefix/lib/libopenblas.dylib" \
  -DLAPACK_LIBRARIES="$openblas_prefix/lib/libopenblas.dylib"
/opt/homebrew/bin/cmake --build "$elmer_build" --parallel 6
/opt/homebrew/bin/cmake --install "$elmer_build"

solver_bin="$elmer_prefix/bin/ElmerSolver"
otool -L "$solver_bin" | grep -F -q "$openblas_prefix/lib/libopenblas" || macos_fail "ElmerSolver is not linked to the pinned OpenBLAS"
if otool -L "$solver_bin" | grep -E -q 'Accelerate|libBLAS.dylib'; then
  macos_fail "ElmerSolver linked Apple Accelerate"
fi

stage="$work/bundle"
rm -rf "$stage"
mkdir -p "$stage/gmsh/bin" "$stage/gmsh/lib" "$stage/elmer/bin" "$stage/elmer/lib"

cp -p "$gmsh_src/gmsh-4.15.2-MacOSARM-sdk/bin/gmsh" "$stage/gmsh/bin/gmsh"
cp -p "$(realpath "$gmsh_src/gmsh-4.15.2-MacOSARM-sdk/lib/libgmsh.4.15.dylib")" "$stage/gmsh/lib/libgmsh.4.15.dylib"
cp -p "$gmsh_src/gmsh-4.15.2-MacOSARM-sdk/share/doc/gmsh/LICENSE.txt" "$stage/gmsh/LICENSE.txt"
cp -p "$gmsh_src/gmsh-4.15.2-MacOSARM-sdk/share/doc/gmsh/CREDITS.txt" "$stage/gmsh/CREDITS.txt"
[[ -f "$stage/gmsh/bin/gmsh" && ! -L "$stage/gmsh/lib/libgmsh.4.15.dylib" ]] || macos_fail "Gmsh SDK staging failed"

for name in ElmerSolver ElmerGrid; do
  [[ -f "$elmer_prefix/bin/$name" && ! -L "$elmer_prefix/bin/$name" ]] || macos_fail "Elmer did not install $name"
  cp -p "$elmer_prefix/bin/$name" "$stage/elmer/bin/$name"
done
mkdir -p "$stage/elmer/share/elmersolver/lib" "$stage/elmer/share/elmersolver/license_texts" "$stage/elmer/licenses/gcc" "$stage/elmer/licenses/OpenBLAS"
for name in elements.def SOLVER.KEYWORDS HeatSolve.dylib ResultOutputSolve.dylib; do
  [[ -f "$elmer_prefix/share/elmersolver/lib/$name" ]] || macos_fail "Elmer install is missing $name"
  cp -p "$elmer_prefix/share/elmersolver/lib/$name" "$stage/elmer/share/elmersolver/lib/$name"
done
cp -p "$elmer_prefix/share/elmersolver/license_texts/GPL-2.txt" "$stage/elmer/share/elmersolver/license_texts/GPL-2.txt"
cp -p "$elmer_prefix/share/elmersolver/license_texts/LGPL-2.1.txt" "$stage/elmer/share/elmersolver/license_texts/LGPL-2.1.txt"
cp -p "$elmer_prefix/share/elmersolver/license_texts/LICENSES" "$stage/elmer/share/elmersolver/license_texts/LICENSES"
if [[ -f "$elmer_prefix/share/elmersolver/license_texts/fem/LICENSES" ]]; then
  mkdir -p "$stage/elmer/share/elmersolver/license_texts/fem"
  cp -p "$elmer_prefix/share/elmersolver/license_texts/fem/LICENSES" "$stage/elmer/share/elmersolver/license_texts/fem/LICENSES"
fi
cp -p /opt/homebrew/Cellar/gcc/16.2.0/COPYING.RUNTIME "$stage/elmer/licenses/gcc/COPYING.RUNTIME"
cp -p /opt/homebrew/Cellar/gcc/16.2.0/COPYING "$stage/elmer/licenses/gcc/COPYING"
cp -p /opt/homebrew/Cellar/gcc/16.2.0/COPYING.LIB "$stage/elmer/licenses/gcc/COPYING.LIB"
cp -p "$openblas_src/LICENSE" "$stage/elmer/licenses/OpenBLAS/LICENSE"
cp -p /opt/homebrew/Cellar/gcc/16.2.0/lib/gcc/current/libgcc_s.1.1.dylib "$stage/elmer/lib/libgcc_s.1.1.dylib"

# Core Elmer libraries are linked by name. Vendor pulls OpenBLAS and libgfortran.
shopt -s nullglob
for lib in "$elmer_prefix"/lib/elmersolver/*.dylib "$elmer_prefix"/lib/*.dylib; do
  [[ -f "$lib" && ! -L "$lib" ]] || continue
  cp -p "$lib" "$stage/elmer/lib/$(basename "$lib")"
done
shopt -u nullglob

macos_relocate_bundle "$stage" "$stage/elmer/lib"

if ! strings "$stage/gmsh/lib/libgmsh.4.15.dylib" | grep 'TopoDS_Shape' >/dev/null; then
  macos_fail "Gmsh library has no OpenCASCADE shape kernel"
fi
"$stage/gmsh/bin/gmsh" --version >/dev/null
occ="$work/occ-check"
rm -rf "$occ"
mkdir -p "$occ"
printf '%s\n' 'SetFactory("OpenCASCADE");' 'Box(1) = {0,0,0,1,1,1};' 'Save "box.step";' >"$occ/box.geo"
(cd "$occ" && "$stage/gmsh/bin/gmsh" box.geo -0 -nopopup -v 1)
grep -q 'ISO-10303-21;' "$occ/box.step" || macos_fail "Gmsh OpenCASCADE did not write STEP"
"$stage/elmer/bin/ElmerSolver" >"$work/elmer-version.txt" 2>&1 &
elmer_pid=$!
sleep 3
kill "$elmer_pid" >/dev/null 2>&1 || true
wait "$elmer_pid" >/dev/null 2>&1 || true
grep -E -q 'ELMER|Elmer' "$work/elmer-version.txt" || {
  cat "$work/elmer-version.txt" >&2
  macos_fail "ElmerSolver did not start"
}
otool -L "$stage/elmer/bin/ElmerSolver" | grep -q 'libopenblas' || macos_fail "ElmerSolver is not linked to OpenBLAS"
if otool -L "$stage/elmer/bin/ElmerSolver" | grep -E -q 'Accelerate|libBLAS.dylib'; then
  macos_fail "ElmerSolver linked Apple Accelerate"
fi

rm -rf "$bundle/gmsh" "$bundle/elmer"
mkdir -p "$bundle"
cp -R "$stage/gmsh" "$bundle/gmsh"
cp -R "$stage/elmer" "$bundle/elmer"
printf 'Thermal darwin-arm64 bundle staged under resources/thermal/1\n'
