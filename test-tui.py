"""Smoke-test the native composer and transcript in an isolated tmux server."""

import argparse
import json
from pathlib import Path
import shlex
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--checkout", help="Optional development checkout; defaults to the installed opencode")
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--real-catalog", action="store_true", help="Discover only; never send a live prompt")
mode.add_argument("--subagent", choices=["enabled", "disabled"], help="Test native delegation with mock agents")
args = parser.parse_args()
here = Path(__file__).resolve().parent
workspace = tempfile.TemporaryDirectory(prefix="antigravity-native-test-", ignore_cleanup_errors=True)
project = Path(workspace.name)
config = project / "config"
config.mkdir()
tmux = ["tmux", "-S", str(project / "tmux")]


def tm(*options):
    return subprocess.check_output([*tmux, *options], text=True)


def wait(text, present=True):
    deadline = time.monotonic() + 20
    screen = ""
    while time.monotonic() < deadline:
        screen = tm("capture-pane", "-p", "-t", "smoke")
        if (text in screen) == present:
            return screen
        time.sleep(0.15)
    raise AssertionError(f"Expected {text!r} (present={present}).\n{screen}")


def keys(*sequence):
    tm("send-keys", "-t", "smoke", *sequence)


def send(text):
    keys("-l", text)
    wait(text)
    keys("Enter")


settings = {"plugins": [str(here)]}
if args.subagent:
    settings = {
        "plugins": [
            {"package": str(here), "options": {"allowSubagents": args.subagent == "enabled"}},
            str(here / "fixtures/mock-parent"),
        ],
        "model": "mock-parent/test",
        "agents": {"antigravity": {
            "description": "Run a task with Antigravity",
            "mode": "subagent",
            "model": "antigravity-acp/gemini-test",
        }},
    }
env = {
    "OPENCODE_CONFIG_DIR": str(config),
    "OPENCODE_CONFIG_CONTENT": json.dumps(settings),
    "OPENCODE_DB": str(project / "opencode.db"),
    "XDG_DATA_HOME": str(project / "data"),
    "XDG_STATE_HOME": str(project / "state"),
}
if not args.real_catalog:
    env["OPENCODE_ANTIGRAVITY_PATH"] = str(here / "fixtures/mock-agent.mjs")
program = ["bun", "run", "--cwd", args.checkout, "dev"] if args.checkout else ["opencode"]
command = ["env", *(f"{key}={value}" for key, value in env.items()), *program, "--standalone", str(project)]
tm("new-session", "-d", "-s", "smoke", "-x", "126", "-y", "39", shlex.join(command) + " || read -r _")
try:
    wait("ctrl+p")
    if args.subagent:
        wait("Mock parent model")
        send("Delegate to Antigravity")
        wait("Parent received Antigravity reply" if args.subagent == "enabled" else "Parent received delegation error")
    else:
        send("/models")
        wait("Search models")
        keys("-l", "Gemini" if args.real_catalog else "Gemini test")
        wait("Google Antigravity")
        keys("Enter")
        wait("Select variant")
        keys("Enter")
        wait("Select variant", present=False)
    if not args.real_catalog and not args.subagent:
        send("Hello native")
        wait("Mock reply: Hello native")
        send("Approve mock")
        wait("Edit mock.txt")
        keys("Escape")
        wait("Mock edit denied")
        send("Second message")
        wait("Mock reply: Second message")
    print("Native TUI " + ("real catalog OK (no prompt sent)" if args.real_catalog else "mock smoke passed"))
finally:
    subprocess.run([*tmux, "kill-server"], capture_output=True, check=False)
    workspace.cleanup()
