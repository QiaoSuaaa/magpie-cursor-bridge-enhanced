#!/bin/bash
set -euo pipefail
# Cross-compiles the Intel macOS engine on an Apple Silicon host. The arm64
# build stays in scripts/build-native.sh and keeps the historical
# bin/cursor-magpie-bridge path; Intel ships from bin/darwin-x64/ so both
# architectures can live in one package.
bridge_package="$(cd -- "$(dirname -- "$0")/.." && pwd)"
bridge_build="$(mktemp -d "${TMPDIR:-/tmp}/cursor-bridge-macos-x64.XXXXXX")"
trap 'rm -rf -- "$bridge_build"' EXIT
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'This script cross-builds macOS x64 and expects an Apple Silicon host.' >&2
  exit 1
fi
rustup target list --installed | grep -qx x86_64-apple-darwin || rustup target add x86_64-apple-darwin
git clone --branch v1.0.1 --depth 1 https://github.com/leookun/cursor-byok.git "$bridge_build/source"
[ "$(git -C "$bridge_build/source" rev-parse HEAD)" = 2068ab20513288e6a0289d33febe872a30608610 ]
git -C "$bridge_build/source" apply "$bridge_package/source.patch"
# aws-lc-sys drives CMake, which needs the explicit architecture when the host
# and target differ; cc-based crates pick up -arch x86_64 from the Rust target.
CMAKE_OSX_ARCHITECTURES=x86_64 \
CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" \
cargo build --manifest-path "$bridge_build/source/Cargo.toml" --target x86_64-apple-darwin --release --locked -p cursor-server --bin cursor-magpie-bridge
mkdir -p "$bridge_package/bin/darwin-x64"
cp "$bridge_build/source/target/x86_64-apple-darwin/release/cursor-magpie-bridge" "$bridge_package/bin/darwin-x64/cursor-magpie-bridge.new"
chmod 755 "$bridge_package/bin/darwin-x64/cursor-magpie-bridge.new"
# Apple Silicon is ad-hoc signed by the linker automatically; Intel builds are
# not, so sign them explicitly for parity (and a stable Gatekeeper story).
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - --timestamp=none "$bridge_package/bin/darwin-x64/cursor-magpie-bridge.new"
fi
mv "$bridge_package/bin/darwin-x64/cursor-magpie-bridge.new" "$bridge_package/bin/darwin-x64/cursor-magpie-bridge"
python3 - "$bridge_package" "$bridge_build/source" <<'PY'
import hashlib,json,pathlib,re,subprocess,sys
p=pathlib.Path(sys.argv[1]);source=pathlib.Path(sys.argv[2]);key='darwin-x64'
manifest=json.loads((p/'package.json').read_text(encoding='utf-8'))
binary=p/'bin/darwin-x64/cursor-magpie-bridge'
data=json.loads((p/'integrity.json').read_text(encoding='utf-8'))
# Read the rebuilt engine contract from its pinned source, then record it per platform.
engine_version=re.search(r'println!\("(\d+\.\d+\.\d+)"\)',(source/'server/src/bin/cursor-magpie-bridge.rs').read_text(encoding='utf-8')).group(1)
try:
    reported=subprocess.check_output([str(binary),'--version'],text=True).strip()
except OSError:
    # Rosetta is normally available on Apple Silicon; strings is the fallback.
    strings=subprocess.check_output(['strings',str(binary)],text=True).splitlines()
    assert engine_version in strings, f'engine version {engine_version} missing from the binary'
else:
    assert reported==engine_version, f'expected engine {engine_version}, got {reported}'
data['version']=manifest['version']
data.setdefault('engineVersions',{})[key]=engine_version
data.setdefault('platforms',{})[key]=hashlib.sha256(binary.read_bytes()).hexdigest()
data['tabPlatforms']=sorted(set(data.get('tabPlatforms',[]))|{key})
(p/'integrity.json').write_text(json.dumps(data,indent=2)+'\n')
PY