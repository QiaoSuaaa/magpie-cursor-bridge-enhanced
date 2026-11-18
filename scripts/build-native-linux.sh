#!/bin/bash
set -euo pipefail
# Builds the Linux engine on a Linux host (or inside the Docker wrapper).
# Without CURSOR_BRIDGE_TARGET_ARCH it builds for the host architecture; with
# arm64/x64 it cross-builds from an amd64 container, which is what lets a
# Docker-Hub-restricted network still produce both binaries (only Debian and
# static.rust-lang.org need to be reachable).
bridge_package="$(cd -- "$(dirname -- "$0")/.." && pwd)"
bridge_build="$(mktemp -d "${TMPDIR:-/tmp}/cursor-bridge-linux.XXXXXX")"
trap 'rm -rf -- "$bridge_build"' EXIT
if [ "$(uname -s)" != Linux ]; then
  echo 'This script builds the Linux engine and expects a Linux host; use scripts/build-native-linux-docker.sh from macOS.' >&2
  exit 1
fi
cross_arch="${CURSOR_BRIDGE_TARGET_ARCH:-}"
if [ -n "$cross_arch" ]; then
  case "$cross_arch" in
    x64) bridge_arch=x64; rust_target=x86_64-unknown-linux-gnu ;;
    arm64) bridge_arch=arm64; rust_target=aarch64-unknown-linux-gnu ;;
    *) echo "Unsupported cross target: $cross_arch" >&2; exit 1 ;;
  esac
  rustup target list --installed | grep -qx "$rust_target" || rustup target add "$rust_target"
else
  case "$(uname -m)" in
    x86_64|amd64) bridge_arch=x64 ;;
    aarch64|arm64) bridge_arch=arm64 ;;
    *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  rust_target=""
fi
git clone --branch v1.0.1 --depth 1 https://github.com/leookun/cursor-byok.git "$bridge_build/source"
[ "$(git -C "$bridge_build/source" rev-parse HEAD)" = 2068ab20513288e6a0289d33febe872a30608610 ]
git -C "$bridge_build/source" apply "$bridge_package/source.patch"
# Linux only: the engine also accepts Cursor's argv.json and the installer's
# NSS trust marker, and links a vendored OpenSSL for both architectures.
git -C "$bridge_build/source" apply "$bridge_package/source-linux.patch"
# Share one target directory between the test and release builds: otherwise
# every dependency is compiled twice in a fresh container.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$bridge_build/target}"
# The Linux patch adds a vendored OpenSSL dependency, so the lock file needs
# one resolution pass. Native builds get it from `cargo test`; cross builds
# skip tests, so resolve explicitly before the --locked release build.
cargo metadata --format-version 1 --manifest-path "$bridge_build/source/Cargo.toml" >/dev/null
# A cross-compiled test binary cannot run on this host, so only the native
# build executes the upstream test suite.
if [ -z "$rust_target" ]; then
  cargo test --manifest-path "$bridge_build/source/Cargo.toml" -p cursor-server
fi
CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" \
cargo build --manifest-path "$bridge_build/source/Cargo.toml" --release --locked -p cursor-server --bin cursor-magpie-bridge \
  ${rust_target:+--target "$rust_target"}
bridge_target="$CARGO_TARGET_DIR${rust_target:+/$rust_target}/release/cursor-magpie-bridge"
mkdir -p "$bridge_package/bin/linux-$bridge_arch"
cp "$bridge_target" "$bridge_package/bin/linux-$bridge_arch/cursor-magpie-bridge.new"
chmod 755 "$bridge_package/bin/linux-$bridge_arch/cursor-magpie-bridge.new"
strip_bin=strip
if [ -n "$rust_target" ] && command -v "${rust_target%%-*}-linux-gnu-strip" >/dev/null 2>&1; then
  strip_bin="${rust_target%%-*}-linux-gnu-strip"
fi
if command -v "$strip_bin" >/dev/null 2>&1; then
  "$strip_bin" "$bridge_package/bin/linux-$bridge_arch/cursor-magpie-bridge.new" || true
fi
mv "$bridge_package/bin/linux-$bridge_arch/cursor-magpie-bridge.new" "$bridge_package/bin/linux-$bridge_arch/cursor-magpie-bridge"
python3 - "$bridge_package" "$bridge_arch" "$rust_target" "$bridge_build/source" <<'PY'
import hashlib,json,pathlib,re,subprocess,sys
p=pathlib.Path(sys.argv[1]);arch=sys.argv[2];rust_target=sys.argv[3];source=pathlib.Path(sys.argv[4]);key=f'linux-{arch}'
manifest=json.loads((p/'package.json').read_text(encoding='utf-8'))
binary=p/f'bin/linux-{arch}/cursor-magpie-bridge'
data=json.loads((p/'integrity.json').read_text(encoding='utf-8'))
# Read the rebuilt engine contract from its pinned source, then record it per platform.
engine_version=re.search(r'println!\("(\d+\.\d+\.\d+)"\)',(source/'server/src/bin/cursor-magpie-bridge.rs').read_text(encoding='utf-8')).group(1)
if rust_target:
    # A cross-compiled binary cannot run here; read the verbatim version
    # constant the --version branch prints.
    strings=subprocess.check_output(['strings',str(binary)],text=True).splitlines()
    assert engine_version in strings, f'engine version {engine_version} missing from the binary'
else:
    reported=subprocess.check_output([str(binary),'--version'],text=True).strip()
    assert reported==engine_version, f'expected engine {engine_version}, got {reported}'
data['version']=manifest['version']
data.setdefault('engineVersions',{})[key]=engine_version
data.setdefault('platforms',{})[key]=hashlib.sha256(binary.read_bytes()).hexdigest()
data['tabPlatforms']=sorted(set(data.get('tabPlatforms',[]))|{key})
(p/'integrity.json').write_text(json.dumps(data,indent=2)+'\n')
PY
