# Relocate Mach-O images so a bundle contains its non-system dependencies
# and records only @rpath / @executable_path / @loader_path. System libraries
# under /usr/lib and /System stay as system linkages.

macos_fail() {
  printf 'macos bundle: %s\n' "$1" >&2
  exit 1
}

# Maintainer input. An existing file must already match; only a missing file is downloaded.
macos_fetch_verified() {
  local url="$1" file="$2" sha="$3" actual partial
  [[ "$url" == https://* ]] || macos_fail "maintainer download must be https: $url"
  if [[ -f "$file" ]]; then
    actual="$(shasum -a 256 "$file" | awk '{ print $1 }')"
    [[ "$actual" == "$sha" ]] || macos_fail "SHA-256 mismatch for $(basename "$file")"
    return 0
  fi
  printf 'Downloading %s\n' "$(basename "$file")"
  partial="${file}.partial"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --retry 2 --output "$partial" "$url" \
    || macos_fail "download failed for $(basename "$file")"
  actual="$(shasum -a 256 "$partial" | awk '{ print $1 }')"
  if [[ "$actual" != "$sha" ]]; then
    rm -f "$partial"
    macos_fail "SHA-256 mismatch for $(basename "$file")"
  fi
  mv "$partial" "$file"
}

macos_is_system_dep() {
  case "$1" in
    /usr/lib/* | /System/* | @rpath/* | @executable_path/* | @loader_path/*) return 0 ;;
    *) return 1 ;;
  esac
}

macos_rpath_for() {
  local root="$1" file="$2" rel
  rel="${file#"$root"/}"
  case "$rel" in
    elmer/bin/* | gmsh/bin/*) printf '%s\n' '@executable_path/../lib' ;;
    Spice64/bin/ngspice) printf '%s\n' '@executable_path' ;;
    Spice64/bin/*) printf '%s\n' '@loader_path' ;;
    Spice64/lib/ngspice/*) printf '%s\n' '@loader_path/../../bin' ;;
    elmer/lib/* | gmsh/lib/*) printf '%s\n' '@loader_path' ;;
    elmer/share/elmersolver/lib/*) printf '%s\n' '@loader_path/../../../lib' ;;
    *) macos_fail "no rpath rule for $rel" ;;
  esac
}

macos_vendor_dep() {
  local dep="$1" libdir="$2"
  macos_is_system_dep "$dep" && return 0
  local base dest child source
  base="$(basename "$dep")"
  dest="$libdir/$base"
  if [[ ! -f "$dest" ]]; then
    [[ -e "$dep" ]] || macos_fail "missing dependency: $dep"
    source="$(realpath "$dep")"
    [[ -f "$source" && ! -L "$source" ]] || macos_fail "dependency is not a regular file: $dep"
    cp -p "$source" "$dest"
    chmod u+w "$dest"
    install_name_tool -id "@rpath/$base" "$dest"
    while IFS= read -r child; do
      [[ -n "$child" ]] || continue
      macos_vendor_dep "$child" "$libdir"
    done < <(otool -L "$dest" | awk 'NR>1 { print $1 }')
  fi
}

macos_each_macho() {
  local root="$1" file
  [[ -d "$root" ]] || macos_fail "bundle directory is missing: $root"
  while IFS= read -r -d '' file; do
    [[ -L "$file" ]] && macos_fail "bundle contains a symlink: ${file#"$root"/}"
    if file -b "$file" | grep -q 'Mach-O'; then
      printf '%s\n' "$file"
    fi
  done < <(find "$root" -type f -print0)
}

macos_relocate_bundle() {
  local root="$1" libdir="$2" file dep rpath existing
  [[ -d "$libdir" ]] || mkdir -p "$libdir"
  while IFS= read -r file; do
    while IFS= read -r dep; do
      [[ -n "$dep" ]] || continue
      macos_is_system_dep "$dep" && continue
      macos_vendor_dep "$dep" "$libdir"
    done < <(otool -L "$file" | awk 'NR>1 { print $1 }')
  done < <(macos_each_macho "$root")

  while IFS= read -r file; do
    chmod u+w "$file"
    if file -b "$file" | grep -q 'shared library\|bundle'; then
      install_name_tool -id "@rpath/$(basename "$file")" "$file"
    fi
    while IFS= read -r dep; do
      [[ -n "$dep" ]] || continue
      macos_is_system_dep "$dep" && continue
      install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$file"
    done < <(otool -L "$file" | awk 'NR>1 { print $1 }')
    rpath="$(macos_rpath_for "$root" "$file")"
    existing="$(otool -l "$file" | awk '/cmd LC_RPATH/{p=1} p && /path /{print $2; p=0}')"
    if ! printf '%s\n' "$existing" | grep -Fxq "$rpath"; then
      install_name_tool -add_rpath "$rpath" "$file"
    fi
    while IFS= read -r existing; do
      [[ -n "$existing" ]] || continue
      case "$existing" in
        @executable_path | @executable_path/* | @loader_path | @loader_path/* | @rpath | @rpath/*) ;;
        *) install_name_tool -delete_rpath "$existing" "$file" ;;
      esac
    done < <(otool -l "$file" | awk '/cmd LC_RPATH/{p=1} p && /path /{print $2; p=0}')
    codesign --force --sign - --timestamp=none "$file" >/dev/null
  done < <(macos_each_macho "$root")
  macos_assert_relocatable "$root"
}

macos_assert_relocatable() {
  local root="$1" file deps rpaths
  while IFS= read -r file; do
    # otool prints the inspected path first. Only dependency names and rpaths are linkage.
    deps="$(otool -L "$file" | awk 'NR>1 { print $1 }')"
    rpaths="$(otool -l "$file" | awk '/cmd LC_RPATH/{p=1} p && /path /{print $2; p=0}')"
    if printf '%s\n%s\n' "$deps" "$rpaths" | grep -E -q '/opt/homebrew|/Users/|/usr/local/'; then
      printf '%s\n%s\n' "$deps" "$rpaths" >&2
      macos_fail "absolute toolchain path remains in ${file#"$root"/}"
    fi
  done < <(macos_each_macho "$root")
}
