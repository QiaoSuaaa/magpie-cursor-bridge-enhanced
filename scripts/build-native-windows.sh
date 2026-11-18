#!/bin/bash
set -euo pipefail
# Build from the pinned local upstream, without checking out or modifying it.
# Windows: run from an x64 VS developer environment with CMake on PATH.
# macOS: use mingw-w64 and the installed windows-gnu Rust target.
bridge_package="$(cd -- "$(dirname -- "$0")/.." && pwd)"
bridge_build="$(mktemp -d "${TMPDIR:-/tmp}/cursor-bridge-win.XXXXXX")"
trap 'rm -rf -- "$bridge_build"' EXIT
bridge_upstream="${CURSOR_BRIDGE_UPSTREAM:-$bridge_package/../..}"
base=2068ab20513288e6a0289d33febe872a30608610
git -C "$bridge_upstream" cat-file -e "$base^{commit}"
mkdir -p "$bridge_build/source"
git -C "$bridge_upstream" archive "$base" | tar -x -C "$bridge_build/source"
git -C "$bridge_build/source" apply "$bridge_package/source.patch"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    [ "$(rustc -vV | tr -d '\r' | grep '^host: ')" = 'host: x86_64-pc-windows-msvc' ] || {
      echo 'Use the x86_64-pc-windows-msvc Rust toolchain.' >&2; exit 1;
    }
    target_args=()
    target_suffix=''
    ;;
  Darwin)
    command -v x86_64-w64-mingw32-gcc >/dev/null
    rustup target list --installed | grep -qx x86_64-pc-windows-gnu
    export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc
    export AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar
    export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
    target_args=(--target x86_64-pc-windows-gnu)
    target_suffix='/x86_64-pc-windows-gnu'
    ;;
  *) echo 'Build Windows on Windows x64 (MSVC) or macOS (mingw-w64).' >&2; exit 1 ;;
esac
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$bridge_build/target}"
CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" cargo build --manifest-path "$bridge_build/source/Cargo.toml" --release --locked "${target_args[@]}" -p cursor-server --bin cursor-magpie-bridge
mkdir -p "$bridge_package/bin/win32-x64"
cp "$CARGO_TARGET_DIR$target_suffix/release/cursor-magpie-bridge.exe" "$bridge_package/bin/win32-x64/cursor-magpie-bridge.exe.new"
mv "$bridge_package/bin/win32-x64/cursor-magpie-bridge.exe.new" "$bridge_package/bin/win32-x64/cursor-magpie-bridge.exe"
python3 - "$bridge_package" "$bridge_build/source" <<'PY'
import hashlib,json,pathlib,re,subprocess,sys
p=pathlib.Path(sys.argv[1]);source=pathlib.Path(sys.argv[2])
b=p/'bin/win32-x64/cursor-magpie-bridge.exe';key='win32-x64'
v=re.search(r'println!\("(\d+\.\d+\.\d+)"\)',(source/'server/src/bin/cursor-magpie-bridge.rs').read_text(encoding='utf-8')).group(1)
if sys.platform=='win32':
    assert subprocess.check_output([str(b),'--version'],text=True).strip()==v
else:
    assert v in subprocess.check_output(['strings',str(b)],text=True).splitlines()
data=json.loads((p/'integrity.json').read_text(encoding='utf-8'))
data['version']=json.loads((p/'package.json').read_text(encoding='utf-8'))['version']
data.setdefault('engineVersions',{})[key]=v
data.setdefault('platforms',{})[key]=hashlib.sha256(b.read_bytes()).hexdigest()
data['tabPlatforms']=sorted(set(data.get('tabPlatforms',[]))|{key})
(p/'integrity.json').write_text(json.dumps(data,indent=2)+'\n')
PY
