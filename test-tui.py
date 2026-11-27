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
mode.add_argument("--subagent", choices=["enabled", "disabled", "override"], help="Test native delegation with mock agents")
mode.add_argument("--full-access", action="store_true", help="Test opt-in approval skipping and Plan isolation with a mock agent")
mode.add_argument("--fork", action="store_true", help="Test inherited context with a mock agent")
mode.add_argument("--features", action="store_true", help="Test Antigravity questions, native steering, and session controls")
mode.add_argument("--variants", action="store_true", help="Test explicit thinking levels and resetting to Default")
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
if args.features:
    settings["plugins"].append(str(here / "fixtures/mock-parent"))
if args.full_access:
    settings = {
        "plugins": [{"package": str(here), "options": {"fullAccess": True}}],
        "agents": {"plan": {"model": "antigravity-acp/gemini-test"}},
    }
if args.subagent:
    settings = {
        "plugins": [
            {"package": str(here), "options": {"allowSubagents": args.subagent != "disabled"}},
            str(here / "fixtures/mock-parent"),
        ],
        "model": "mock-parent/test",
        "agents": {"antigravity": {
            "description": "Run a task with Antigravity",
            "mode": "subagent",
            "model": "antigravity-acp/gemini-test#high",
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
if args.fork:
    env["AGY_MOCK_FORK"] = "1"
if args.features:
    env["AGY_MOCK_FEATURES"] = "1"
    (project / "test-attachment.txt").write_text("Fixture attachment contents\n")
program = ["bun", "run", "--cwd", args.checkout, "dev"] if args.checkout else ["opencode"]
command = ["env", *(f"{key}={value}" for key, value in env.items()), *program, "--standalone", str(project)]
tm("new-session", "-d", "-s", "smoke", "-x", "126", "-y", "39", shlex.join(command) + " || read -r _")
try:
    wait("ctrl+p")
    if args.subagent:
        wait("Mock parent model")
        send("Delegate to Antigravity with low" if args.subagent == "override" else "Delegate to Antigravity")
        wait("Parent received delegation error" if args.subagent == "disabled" else "Parent received Antigravity reply")
    else:
        send("/models")
        wait("Search models")
        keys("-l", "Gemini" if args.real_catalog else "Gemini test")
        wait("Google Antigravity")
        keys("Enter")
        wait("Select variant")
        keys("Enter")
        wait("Select variant", present=False)
    if args.variants:
        send("/variants")
        wait("Select variant")
        keys("Down", "Down", "Enter")
        wait("Select variant", present=False)
        send("Check variant explicit")
        wait("ACP variant: gemini-test/high (turn 1)")
        send("/variants")
        wait("Select variant")
        keys("Up", "Up", "Enter")
        wait("Select variant", present=False)
        send("Check variant default")
        wait("ACP variant: gemini-test/low (turn 2)")
        send("/models")
        wait("Search models")
        keys("-l", "Gemini other")
        wait("Google Antigravity")
        keys("Enter")
        wait("Select variant")
        wait("medium")
        keys("Enter")
        wait("Select variant", present=False)
        send("Check variant switched")
        wait("ACP variant: gemini-other/medium (turn 3)")
        send("/models")
        wait("Search models")
        keys("-l", "Fixed effort model")
        wait("Google Antigravity")
        keys("Enter")
        wait("Search models", present=False)
        assert "Select variant" not in tm("capture-pane", "-p", "-t", "smoke")
        send("Check variant fixed")
        wait("ACP variant: fixed-effort/fixed (turn 4)")
    elif args.features:
        send("Ask mock")
        wait("The agent has a question.")
        wait("Choose the package manager")
        keys("Enter")
        wait("Other (optional)")
        wait("Type your answer")
        keys("Tab")
        wait("Submit")
        keys("Enter")
        wait("Question was answered")
        send("Dismiss mock choice")
        wait("Choose the test runner")
        keys("Escape")
        wait("Choice was dismissed")
        send("Ask mock choice")
        wait("Choose the test runner")
        keys("Enter")
        wait("Bun was selected")
        send("/agy-work")
        wait("Build hello")
        keys("Escape")
        wait("Antigravity work", present=False)
        keys("-l", "Check attachment @test-attachment")
        wait("test-attachment.txt")
        keys("Enter", "Enter")
        wait("Attachment reached Antigravity")
        send("Begin steer")
        wait("Steering is ready")
        send("Use native steer")
        wait("Native steer reached Antigravity")
        send("Begin queue")
        wait("Queue is ready")
        keys("-l", "Deliver queued turn")
        keys("C-x", "Enter")
        wait("Mock reply: Deliver queued turn")
        send("/compact")
        wait("Native compaction ran")
        send("/agy-clear")
        keys("Enter")
        wait("Started a fresh Antigravity conversation")
        send("After clear")
        wait("A fresh Antigravity session answered")
        send("/mock-bring-back")
        keys("Enter")
        wait("/mock-bring-back", present=False)
        send("Check side-chat result")
        wait("Antigravity received the side-chat result")
        send("/models")
        wait("Search models")
        keys("-l", "Mock parent model")
        wait("Mock parent model")
        keys("Enter")
        send("Ask the other provider")
        wait("Other provider answered")
        send("/models")
        wait("Search models")
        keys("-l", "Gemini test")
        wait("Google Antigravity")
        keys("Enter")
        wait("Select variant")
        keys("Enter")
        wait("Select variant", present=False)
        send("Check switched history")
        wait("Antigravity received the intervening history")
        send("Launch mock background")
        wait("Native child was launched")
        wait("Antigravity background reply")
        send("/agy-work")
        wait("Mock detached result")
        wait("without session ID")
        keys("-l", "invoke_subagent")
        wait("Mock detached result", present=False)
        keys("Enter")
        wait("Read-only child transcript")
        keys("Escape")
        wait("Antigravity activity", present=False)
        send("Keep this decision")
        wait("Mock reply: Keep this decision")
        send("Remove this decision")
        wait("Mock reply: Remove this decision")
        send("/undo")
        wait("Mock reply: Remove this decision", present=False)
        keys("C-c")
        send("Check the rewind")
        wait("Antigravity resumed with the rewound history")
    elif args.fork:
        send("Fork source first")
        wait("Mock reply: Fork source first")
        send("Fork source later")
        wait("Mock reply: Fork source later")
        send("/fork")
        wait("Full session")
        keys("Down", "Enter")
        wait("Forked session")
        wait("Mock reply: Fork source later", present=False)
        keys("C-c")
        send("Fork first message")
        wait("Fork received the earlier turn")
        send("Fork second message")
        wait("Fork continued without resending history")
    elif not args.real_catalog and not args.subagent:
        send("Hello native")
        wait("Mock reply: Hello native")
        send("Approve mock")
        if args.full_access:
            wait("Mock edit approved without prompting")
            keys("BTab")
            wait("Plan")
            send("Check plan")
            wait("Plan resumed in sandbox")
        else:
            wait("Edit mock.txt")
            keys("Escape")
            wait("Mock edit denied")
            send("Second message")
            wait("Mock reply: Second message")
            send("/models")
            wait("Search models")
            keys("-l", "Third-party model")
            wait("Google Antigravity")
            keys("Enter")
            wait("Select variant")
            wait("extra")
            keys("Down", "Enter")
            wait("Select variant", present=False)
            send("Check model")
            wait("Third-party model selected")
    print("Native TUI " + ("real catalog OK (no prompt sent)" if args.real_catalog else "mock smoke passed"))
finally:
    subprocess.run([*tmux, "kill-server"], capture_output=True, check=False)
    workspace.cleanup()
