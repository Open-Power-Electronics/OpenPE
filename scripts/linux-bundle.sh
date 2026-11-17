# Shared maintainer helpers for the glibc Linux x64 solver bundles.
# Runtime never searches the host for solvers or libraries.
linux_fail() { printf 'Linux bundle: %s\n' "$1" >&2; exit 1; }

linux_fetch() {
  local url="$1" file="$2" expected="$3" actual
  if [[ ! -f "$file" ]]; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --retry 2 --output "$file.partial" "$url"
    mv "$file.partial" "$file"
  fi
  actual="$(sha256sum "$file" | cut -d' ' -f1)"
  [[ "$actual" == "$expected" ]] || linux_fail "SHA-256 mismatch for $(basename "$file")"
}

linux_toolchain() {
  [[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] || linux_fail 'Build on Linux x64.'
  [[ "$(gcc -dumpfullversion)" == 14.2.0 ]] || linux_fail 'GCC 14.2.0 is required.'
  [[ "$(getconf GNU_LIBC_VERSION)" == 'glibc 2.41' ]] || linux_fail 'Build on glibc 2.41.'
  [[ "$(cmake --version | head -n1)" == 'cmake version 4.4.5' ]] || linux_fail 'CMake 4.4.5 is required.'
  command -v patchelf >/dev/null || linux_fail 'patchelf is required.'
  export SOURCE_DATE_EPOCH=1786424074
  umask 022
}

linux_install_bundle() {
  local stage="$1" destination="$2" directory
  [[ -z "$(find "$stage" -type l -print -quit)" ]] || linux_fail 'Bundle contains a link.'
  find "$stage" -type d -exec chmod 755 {} +
  find "$stage" -type f -exec chmod 644 {} +
  while IFS= read -r -d '' directory; do
    mkdir -p "$destination/${directory#"$stage"}"
    chmod 755 "$destination/${directory#"$stage"}"
  done < <(find "$stage" -type d -print0)
  for directory in "$stage/Spice64/bin/ngspice" "$stage/gmsh/bin/gmsh" "$stage/elmer/bin/ElmerSolver" "$stage/elmer/bin/ElmerGrid"; do
    [[ ! -f "$directory" ]] || chmod 755 "$directory"
  done
  cp -r --preserve=mode "$stage/." "$destination/"
}

linux_gcc_notices() {
  local downloads="$1" target="$2" name
  linux_fetch 'https://deb.debian.org/debian/pool/main/g/gcc-14/gcc-14_14.2.0.orig.tar.gz' \
    "$downloads/gcc-14_14.2.0.orig.tar.gz" 'e162a5ef3f0077ecae598c6556908d2ab80841532df3398072a96a6df6e6aa29'
  linux_fetch 'https://deb.debian.org/debian/pool/main/g/gcc-14/gcc-14_14.2.0-19.debian.tar.xz' \
    "$downloads/gcc-14_14.2.0-19.debian.tar.xz" '31cbab4bafa48aa1c540497bd8098cbcf98e673778f927651ed944709f687781'
  mkdir -p "$target"
  tar -xOf "$downloads/gcc-14_14.2.0.orig.tar.gz" gcc-14-14.2.0/gcc-14.2.0-dfsg.tar.xz > "$target/gcc-source.tar.xz.tmp"
  for name in COPYING.RUNTIME COPYING3 COPYING.LIB; do
    tar -xJOf "$target/gcc-source.tar.xz.tmp" "gcc-14.2.0/$name" > "$target/$name"
  done
  rm "$target/gcc-source.tar.xz.tmp"
}

# Keep glibc and the distribution's graphics/font stack as system dependencies.
# Solver, math and compiler runtimes are bundled. Dereference staging links;
# runtime manifests and extraction reject links entirely.
linux_system_library() {
  case "$1" in
    ld-linux-x86-64.so.2|libc.so.6|libm.so.6|libmvec.so.1|libdl.so.2|librt.so.1|libpthread.so.0|libresolv.so.2|libutil.so.1) return 0 ;;
    libGL*.so.*|libOpenGL.so.*|libX*.so.*|libxcb.so.*|libfontconfig.so.*|libfreetype.so.*|libexpat.so.*|libz.so.*|libbz2.so.*|libpng*.so.*|libbrotli*.so.*) return 0 ;;
    *) return 1 ;;
  esac
}

linux_vendor() {
  local file="$1" directory="$2" dependency name
  mkdir -p "$directory"
  while IFS= read -r dependency; do
    name="$(basename "$dependency")"
    linux_system_library "$name" && continue
    if [[ ! -f "$directory/$name" ]]; then
      cp -L "$dependency" "$directory/$name"
      chmod u+w "$directory/$name"
      linux_vendor "$dependency" "$directory"
      patchelf --set-rpath '$ORIGIN' "$directory/$name"
    fi
  done < <(ldd "$file" | awk '/=> \/|^\s*\// {for(i=1;i<=NF;i++) if ($i ~ /^\//) print $i}')
}

linux_relocate() {
  local file="$1" directory="$2" rpath="$3"
  linux_vendor "$file" "$directory"
  patchelf --set-rpath "$rpath" "$file"
  if ldd "$file" | grep -q 'not found'; then linux_fail "Unresolved dependency: $file"; fi
}
