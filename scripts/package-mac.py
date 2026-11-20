"""Build a macOS app using the source and pinned runtime in a portable ZIP."""
import argparse
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import zipfile


def run(*args):
    subprocess.run(args, check=True)


def package(portable, dest, identity):
    with tempfile.TemporaryDirectory(prefix="switchboard-mac-") as scratch:
        scratch = Path(scratch)
        with zipfile.ZipFile(portable) as zip_file:
            zip_file.extractall(scratch)
        app = scratch / "Switchboard.app"
        contents = app / "Contents"
        resources = contents / "Resources"
        executables = contents / "MacOS"
        executables.mkdir(parents=True)
        (scratch / "Switchboard").rename(resources)
        node = executables / "node"
        (resources / "runtime" / "node").rename(node)
        node.chmod(0o755)
        run("lipo", "-verify_arch", "arm64", str(node))
        (resources / "Start Switchboard.command").unlink()
        (resources / "START HERE.txt").unlink()
        version = json.loads((resources / "package.json").read_text())["version"]
        short_version, _, pilot = version.partition("-pilot.")
        # Use the polished launcher and hardened runtime on the same supported
        # minimum OS as the existing Apple silicon download.
        minimum_os = "13.5"
        with (contents / "Info.plist").open("wb") as plist:
            plistlib.dump({
                "CFBundleDisplayName": "Switchboard",
                "CFBundleExecutable": "Switchboard",
                "CFBundleIdentifier": "com.michaelcallow.switchboard.local",
                "CFBundleInfoDictionaryVersion": "6.0",
                "CFBundleName": "Switchboard",
                "CFBundlePackageType": "APPL",
                "CFBundleShortVersionString": short_version,
                "CFBundleVersion": pilot or short_version,
                "LSMinimumSystemVersion": minimum_os,
            }, plist)
        launcher = Path(__file__).with_name("macos-launcher.swift")
        run("xcrun", "swiftc", "-O", "-target", f"arm64-apple-macos{minimum_os}", str(launcher),
            "-o", str(executables / "Switchboard"))
        entitlements = scratch / "node-entitlements.plist"
        with entitlements.open("wb") as plist:
            plistlib.dump({"com.apple.security.cs.allow-jit": True}, plist)
        signature = ["--force", "--options", "runtime", "--sign", identity or "-"]
        if identity:
            signature.append("--timestamp")
        run("codesign", *signature, "--entitlements", str(entitlements), str(node))
        run("codesign", *signature, str(app))
        run("codesign", "--verify", "--deep", "--strict", str(app))
        dest.mkdir(parents=True, exist_ok=True)
        label = "signed" if identity else "local-test"
        output = dest / f"Switchboard-{version}-{label}-arm64.zip"
        archive = scratch / output.name
        run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(archive))
        shutil.move(archive, output)
        print(output, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("portable", type=Path, help="Switchboard-darwin-arm64.zip")
    parser.add_argument("--dest", type=Path, required=True)
    parser.add_argument("--identity", help="Developer ID Application identity in this Mac’s keychain")
    args = parser.parse_args()
    package(args.portable, args.dest, args.identity)
