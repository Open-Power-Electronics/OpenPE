#!/bin/bash
# Maintainer-only glibc Linux x64 Gmsh 4.15.2 / Elmer 26.1 / OpenBLAS 0.3.13.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
source "$root/scripts/linux-bundle.sh"
linux_toolchain
[[ "$("${FC:-gfortran}" -dumpfullversion)" == 14.2.0 ]] || linux_fail 'GFortran 14.2.0 is required.'
downloads="$root/.openpe/downloads"
mkdir -p "$downloads" "$root/.openpe/build"
work="$(mktemp -d "$root/.openpe/build/thermal-linux-XXXXXX")"
linux_fetch 'https://github.com/OpenMathLib/OpenBLAS/archive/refs/tags/v0.3.13.tar.gz' \
  "$downloads/OpenBLAS-0.3.13.tar.gz" '79197543b17cc314b7e43f7a33148c308b0807cd6381ee77f77e15acf3e6459e'
linux_fetch 'https://github.com/ElmerCSC/elmerfem/releases/download/release-26.1/elmerfem-release-26.1.tar.gz' \
  "$downloads/elmerfem-release-26.1.tar.gz" '3a0f14947b5fa83d72506e45d041b54e401a1253ce454afdc188a13c05428990'
wheel='gmsh-4.15.2-py2.py3-none-manylinux_2_24_x86_64.whl'
linux_fetch "https://files.pythonhosted.org/packages/ab/d4/336becb1488ac4fbab205043987128839c8c62d54e2036b7e887bd009040/$wheel" \
  "$downloads/$wheel" '4076a948ce22625330d1413d4982e22b5c69fc2f0f7951f5df64c778cf54108c'
tar -xzf "$downloads/OpenBLAS-0.3.13.tar.gz" -C "$work"
tar -xzf "$downloads/elmerfem-release-26.1.tar.gz" -C "$work"
export CFLAGS="-O2 -Wno-error=implicit-function-declaration -ffile-prefix-map=$work=/openpe-build"
export CXXFLAGS="$CFLAGS"
export FFLAGS="$CFLAGS -fallow-argument-mismatch"
blas="$work/openblas"
blas_make=(TARGET=GENERIC DYNAMIC_ARCH=0 USE_OPENMP=0 USE_THREAD=0 NO_SHARED=0 FC="${FC:-gfortran}" PREFIX="$blas")
# These goals write the same archive; running them concurrently corrupts it.
for goal in libs netlib shared; do
  make -C "$work/OpenBLAS-0.3.13" -j6 "${blas_make[@]}" "$goal"
done
make -C "$work/OpenBLAS-0.3.13" "${blas_make[@]}" install
prefix="$work/elmer-install"
cmake -S "$work/elmerfem-release-26.1" -B "$work/elmer-build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_Fortran_COMPILER="${FC:-gfortran}" -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_INSTALL_RPATH="$prefix/lib/elmersolver;$blas/lib" -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DWITH_MPI=OFF -DWITH_ELMERGUI=OFF -DWITH_OpenMP=OFF -DWITH_Mumps=OFF \
  -DWITH_UMFPACK=ON -DWITH_ElmerIce=OFF -DBUILD_TESTING=OFF \
  -DBLA_VENDOR=OpenBLAS -DBLAS_LIBRARIES="$blas/lib/libopenblas.so" -DLAPACK_LIBRARIES="$blas/lib/libopenblas.so"
cmake --build "$work/elmer-build" --parallel 6
cmake --install "$work/elmer-build"
bundle="$work/bundle"
mkdir -p "$bundle/gmsh/bin" "$bundle/gmsh/lib" "$bundle/elmer/bin" "$bundle/elmer/lib" \
  "$bundle/elmer/share/elmersolver/lib" "$bundle/elmer/licenses/OpenBLAS"
python3 - "$downloads/$wheel" "$bundle/gmsh" "$work" <<'PY'
import sys
from pathlib import Path
from zipfile import ZipFile
with ZipFile(sys.argv[1]) as archive:
    base = 'gmsh-4.15.2.data/data/'
    for source, target in [
        ('lib/libgmsh.so.4.15', Path(sys.argv[2]) / 'lib/libgmsh.so.4.15'),
        ('include/gmshc.h', Path(sys.argv[3]) / 'gmshc.h'),
        ('share/doc/gmsh/LICENSE.txt', Path(sys.argv[2]) / 'LICENSE.txt'),
        ('share/doc/gmsh/CREDITS.txt', Path(sys.argv[2]) / 'CREDITS.txt'),
    ]:
        target.write_bytes(archive.read(base + source))
PY
gcc "$root/scripts/gmsh-linux.c" -I"$work" -L"$bundle/gmsh/lib" -l:libgmsh.so.4.15 \
  -Wl,-rpath,'$ORIGIN/../lib' -o "$bundle/gmsh/bin/gmsh"
linux_relocate "$bundle/gmsh/lib/libgmsh.so.4.15" "$bundle/gmsh/lib" '$ORIGIN'
linux_relocate "$bundle/gmsh/bin/gmsh" "$bundle/gmsh/lib" '$ORIGIN/../lib'
# Elmer installs sibling-relative runpaths. Stage the complete native library
# set before resolving binaries from their new directory.
cp -L "$blas/lib/libopenblas.so.0" "$bundle/elmer/lib/"
for library in "$prefix/lib/elmersolver/"*.so; do
  cp -L "$library" "$bundle/elmer/lib/"
done
for library in "$bundle/elmer/lib/"*.so*; do
  linux_relocate "$library" "$bundle/elmer/lib" '$ORIGIN'
done
for name in ElmerSolver ElmerGrid; do
  cp "$prefix/bin/$name" "$bundle/elmer/bin/"
  linux_relocate "$bundle/elmer/bin/$name" "$bundle/elmer/lib" '$ORIGIN/../lib'
done
for name in elements.def SOLVER.KEYWORDS HeatSolve.so ResultOutputSolve.so; do
  cp "$prefix/share/elmersolver/lib/$name" "$bundle/elmer/share/elmersolver/lib/"
done
for name in HeatSolve.so ResultOutputSolve.so; do
  linux_relocate "$bundle/elmer/share/elmersolver/lib/$name" "$bundle/elmer/lib" '$ORIGIN/../../../lib'
done
cp -r "$prefix/share/elmersolver/license_texts" "$bundle/elmer/share/elmersolver/"
cp "$work/OpenBLAS-0.3.13/LICENSE" "$bundle/elmer/licenses/OpenBLAS/LICENSE"
linux_gcc_notices "$downloads" "$bundle/elmer/licenses/gcc"
mkdir -p "$bundle/sources/openpe"
cp "$root/scripts/gmsh-linux.c" "$root/scripts/build-thermal-linux.sh" \
  "$root/scripts/linux-bundle.sh" "$bundle/sources/openpe/"
linux_install_bundle "$bundle" "$root/resources/thermal/1"
"$bundle/gmsh/bin/gmsh" --version
