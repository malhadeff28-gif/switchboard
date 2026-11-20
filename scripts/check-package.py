"""Extract and start a packaged download through its supplied launcher."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

def check(archive, browser=False):
    with tempfile.TemporaryDirectory(prefix="Switchboard pilot ") as folder:
        dest=Path(folder)
        if os.name=="nt":
            with zipfile.ZipFile(archive) as bundle: bundle.extractall(dest)
        else:
            subprocess.run(["unzip","-q",str(archive),"-d",str(dest)],check=True)
        app=dest/"Switchboard.app"
        mac_app=app.exists()
        root=app/"Contents"/"Resources" if mac_app else dest/"Switchboard"
        with socket.socket() as s:
            s.bind(("127.0.0.1",0)); port=s.getsockname()[1]
        native=os.name=="nt"
        launcher=app/"Contents"/"MacOS"/"Switchboard" if mac_app else next(root.glob("Start Switchboard.*"))
        cmd=["cmd.exe","/d","/c",launcher.name] if native else [str(launcher)]
        # On Windows cmd.exe needs an explicitly quoted batch filename with spaces.
        if native: cmd='cmd.exe /d /c ""'+str(launcher)+'""'
        env={**os.environ,"PORT":str(port),"SWITCHBOARD_DATA_DIR":str(dest/"User Data"),"SWITCHBOARD_NO_BROWSER":"0" if browser else "1"}
        url=f"http://127.0.0.1:{port}"
        def request(route,body=None,token=""):
            req=urllib.request.Request(url+route,data=None if body is None else json.dumps(body).encode(),headers={"Content-Type":"application/json","X-Switchboard-Token":token})
            with urllib.request.urlopen(req,timeout=5) as r: return json.load(r)
        proc=subprocess.Popen(cmd,cwd=root,env=env,start_new_session=not native)
        try:
            for _ in range(150):
                if proc.poll() is not None: raise RuntimeError("Launcher exited early")
                try:
                    if request("/api/health")["app"]=="switchboard": break
                except OSError: time.sleep(.15)
            else: raise RuntimeError("Launcher timed out")
            boot=request("/api/bootstrap"); assert not boot["chats"]
            version=json.loads((root/"package.json").read_text(encoding="utf-8"))["version"]
            assert request("/api/health")["version"]==version
            with urllib.request.urlopen(url) as r: assert "Switchboard" in r.read().decode()
            sample=request("/api/demo",{},boot["token"])["chat"]
            result=request("/api/chats/"+sample["id"]+"/send",{"text":"Pilot check"},boot["token"])
            assert result["nextId"]!=sample["id"]
            for _ in range(40):
                chat=next(c for c in request("/api/bootstrap")["chats"] if c["id"]==sample["id"])
                if chat.get("turns"): break
                time.sleep(.2)
            assert chat["turns"][-1]["phase"]=="finished"
            assert (dest/"User Data"/"workspace.json").is_file()
            assert not (root/".local").exists()
        finally:
            if native: subprocess.run(["taskkill","/pid",str(proc.pid),"/t","/f"],capture_output=True)
            elif mac_app and proc.poll() is None: proc.terminate()
            else:
                try: os.killpg(proc.pid,signal.SIGTERM)
                except ProcessLookupError: pass
            proc.wait(timeout=15)
            if mac_app:
                assert proc.returncode == 0, "Switchboard.app failed to quit cleanly"
                with socket.socket() as s:
                    assert s.connect_ex(("127.0.0.1",port)) != 0, "App server survived launcher quit"
            if native:
                # taskkill and cmd can return before Windows releases the child image.
                deadline=time.monotonic()+10
                while True:
                    try:
                        (root/"runtime"/"node.exe").unlink()
                        break
                    except PermissionError:
                        if time.monotonic()>=deadline: raise
                        time.sleep(.15)
        print("PASS: extracted archive, OS launcher, bundled runtime, first run, send, handoff, external data directory, and shutdown",flush=True)

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive",type=Path)
    parser.add_argument("--browser",action="store_true")
    args=parser.parse_args()
    check(args.archive.resolve(),args.browser)
