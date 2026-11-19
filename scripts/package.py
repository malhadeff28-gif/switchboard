"""Create a portable Switchboard ZIP with a verified upstream Node runtime."""
import argparse
import hashlib
import os
from pathlib import Path
import tarfile
import tempfile
import urllib.request
import zipfile

VERSION = "24.22.3"
SHA = {
    "darwin-arm64": "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
    "darwin-x64": "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7",
    "linux-arm64": "261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8",
    "linux-x64": "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2",
    "win-arm64": "b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14",
    "win-x64": "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f",
}
ROOT = Path(__file__).resolve().parents[1]

def package(target, dest, cache):
    windows = target.startswith("win-")
    prefix = f"node-v{VERSION}-{target}"
    name = prefix + (".zip" if windows else ".tar.gz")
    archive = cache / name
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != SHA[target]:
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as out:
            part = Path(out.name)
        try:
            urllib.request.urlretrieve(f"https://nodejs.org/dist/v{VERSION}/{name}", part)
            if hashlib.sha256(part.read_bytes()).hexdigest() != SHA[target]:
                raise ValueError(f"Upstream checksum mismatch for {name}")
            os.replace(part, archive)
        finally:
            part.unlink(missing_ok=True)
    runtime = "node.exe" if windows else "bin/node"
    if windows:
        with zipfile.ZipFile(archive) as upstream:
            binary, license = [upstream.read(f"{prefix}/{p}") for p in (runtime,"LICENSE")]
    else:
        with tarfile.open(archive) as upstream:
            binary, license = [upstream.extractfile(f"{prefix}/{p}").read() for p in (runtime,"LICENSE")]
    file = dest / f"Switchboard-{target}.zip"
    with zipfile.ZipFile(file, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        def add(name, data, executable=False):
            info=zipfile.ZipInfo("Switchboard/"+name,(2026,11,19,0,0,0))
            info.create_system=3
            info.external_attr=(0o100755 if executable else 0o100644)<<16
            bundle.writestr(info,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=6)
        add("runtime/"+("node.exe" if windows else "node"), binary, True)
        add("runtime/LICENSE", license)
        for p in [ROOT/"server.mjs",ROOT/"package.json",ROOT/"scripts"/"launch.mjs",ROOT/"scripts"/"claude-hook.cjs",*sorted((ROOT/"lib").glob("*.mjs")),*sorted((ROOT/"public").glob("*"))]:
            add(p.relative_to(ROOT).as_posix(), p.read_bytes())
        if windows:
            launcher = "Start Switchboard.cmd"
            contents = '@echo off\r\ncd /d "%~dp0"\r\n"runtime\\node.exe" "scripts\\launch.mjs"\r\nif errorlevel 1 pause\r\n'
        else:
            launcher = "Start Switchboard.command" if target.startswith("darwin") else "Start Switchboard.sh"
            contents = '#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec ./runtime/node scripts/launch.mjs\n'
        add(launcher,contents,True)
        add("START HERE.txt",f"Extract the whole Switchboard folder. Open {launcher}.\nOn Linux you can run: sh 'Start Switchboard.sh'\nKeep the launcher open. Your browser opens the local workspace.\nConnect either Codex or Claude Code, choose two chats, and open the latest result.\nThe provider CLI and an eligible account are required for real work.\nYour workspace is stored in your operating system's user data directory.\n")
    print(file,flush=True)

if __name__ == "__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("target",choices=SHA)
    p.add_argument("--dest",type=Path,required=True)
    p.add_argument("--cache",type=Path,required=True)
    a=p.parse_args()
    for d in (a.dest,a.cache): d.mkdir(parents=True,exist_ok=True)
    package(a.target,a.dest,a.cache)
