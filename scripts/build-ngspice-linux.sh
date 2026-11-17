#!/bin/bash
# Maintainer build. Ordinary preparation installs the hash-pinned archive.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
source "$root/scripts/linux-bundle.sh"
linux_toolchain
downloads="$root/.openpe/downloads"
mkdir -p "$downloads" "$root/.openpe/build"
work="$(mktemp -d "$root/.openpe/build/ngspice-linux-XXXXXX")"
prefix="$work/deps"
linux_fetch 'https://downloads.sourceforge.net/project/ngspice/ng-spice-rework/47/ngspice-47.tar.gz' \
  "$downloads/ngspice-47.tar.gz" '894e649651f1838a14095e5a5439e7d3aa63e87ede14d283173fda4fcdef675f'
linux_fetch 'https://codeload.github.com/libsndfile/libsndfile/tar.gz/refs/tags/1.2.2' \
  "$downloads/libsndfile-1.2.2.tar.gz" 'ffe12ef8add3eaca876f04087734e6e8e029350082f3251f565fa9da55b52121'
linux_fetch 'https://codeload.github.com/libsndfile/libsamplerate/tar.gz/refs/tags/0.2.2' \
  "$downloads/libsamplerate-0.2.2.tar.gz" '16e881487f184250deb4fcb60432d7556ab12cb58caea71ef23960aec6c0405a'
for name in ngspice-47 libsndfile-1.2.2 libsamplerate-0.2.2; do
  tar -xzf "$downloads/$name.tar.gz" -C "$work"
done
patch -p1 --directory "$work/ngspice-47" < "$root/scripts/patches/ngspice-47-linux-codemodel-path.patch"
export CFLAGS="-O2 -ffile-prefix-map=$work=/openpe-build"
export CXXFLAGS="$CFLAGS"
cmake_common=(-DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_INSTALL_PREFIX="$prefix" -DBUILD_SHARED_LIBS=ON -DBUILD_TESTING=OFF)
cmake -S "$work/libsamplerate-0.2.2" -B "$work/samplerate-build" "${cmake_common[@]}" -DLIBSAMPLERATE_EXAMPLES=OFF
cmake --build "$work/samplerate-build" --parallel 6
cmake --install "$work/samplerate-build"
cmake -S "$work/libsndfile-1.2.2" -B "$work/sndfile-build" "${cmake_common[@]}" \
  -DCMAKE_MODULE_PATH="$root/scripts/cmake" -DBUILD_PROGRAMS=OFF -DBUILD_EXAMPLES=OFF \
  -DENABLE_EXTERNAL_LIBS=OFF -DENABLE_MPEG=OFF
cmake --build "$work/sndfile-build" --parallel 6
cmake --install "$work/sndfile-build"
mkdir "$work/ngspice-build"
(
  cd "$work/ngspice-build"
  ../ngspice-47/configure --prefix="$work/install" --without-x --with-readline=no --with-fftw3=no \
    --enable-cider --enable-xspice --enable-osdi --enable-openmp --enable-klu --disable-debug \
    CPPFLAGS="-I$prefix/include" LDFLAGS="-L$prefix/lib -Wl,-rpath,$prefix/lib"
)
make -C "$work/ngspice-build" -j6
make -C "$work/ngspice-build" install
bundle="$work/bundle/Spice64"
mkdir -p "$bundle/bin" "$bundle/lib/ngspice" "$bundle/docs" "$bundle/share/ngspice/scripts"
cp "$work/install/bin/ngspice" "$bundle/bin/"
for file in "$work/install/lib/ngspice/"*.cm; do
  cp "$file" "$bundle/lib/ngspice/"
  linux_relocate "$bundle/lib/ngspice/$(basename "$file")" "$bundle/bin" '$ORIGIN/../../bin'
done
cp "$work/ngspice-47/visualc/spinit_all" "$bundle/share/ngspice/scripts/spinit"
cp "$work/ngspice-47/COPYING" "$work/ngspice-47/AUTHORS" "$bundle/docs/"
cp "$work/libsndfile-1.2.2/COPYING" "$bundle/docs/libsndfile-COPYING"
cp "$work/libsamplerate-0.2.2/COPYING" "$bundle/docs/libsamplerate-COPYING"
linux_relocate "$bundle/bin/ngspice" "$bundle/bin" '$ORIGIN'
linux_gcc_notices "$downloads" "$bundle/docs/gcc"
mkdir -p "$bundle/docs/build"
cp "$root/scripts/build-ngspice-linux.sh" "$root/scripts/linux-bundle.sh" \
  "$root/scripts/patches/ngspice-47-linux-codemodel-path.patch" "$bundle/docs/build/"
linux_install_bundle "$work/bundle" "$root/resources/ngspice/47"
"$bundle/bin/ngspice" -n --version
