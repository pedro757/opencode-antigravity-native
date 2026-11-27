# Google Antigravity for OpenCode

Use Google's Antigravity agent in OpenCode's native terminal UI: the normal
composer, transcript, `/models` picker, and permission prompts. No patched
OpenCode build, separate OpenCode service, or separate UI is required.

## Install

Requires OpenCode v2 (tested with **2.4.1**) and the official
[Antigravity CLI](https://antigravity.google/docs/cli/acp) (`agy` on the OpenCode
server's `PATH`, tested with **1.5.15**). Sign in with `agy` if you haven't
already. The plugin does not read or copy sign-in tokens.

Clone this repo somewhere outside your project, for example:

```sh
git clone https://github.com/pedro757/opencode-antigravity-native.git \
  "$HOME/.config/opencode/antigravity-native"
```

Add the plugin path to the `plugins` array in your global
`~/.config/opencode/opencode.jsonc`. Keep any existing entries:

```jsonc
{
  "plugins": ["./antigravity-native"]
}
```

In OpenCode, run `/reload` if needed, open `/models`, and select a Gemini model
under **Google Antigravity**. Send a text prompt with **Enter**.

## How it works

The plugin runs the official `agy acp` subprocess over stdio. Antigravity owns
its system prompt, tools, and conversation state. The plugin forwards new,
interactive text prompts and displays replies and tool activity in OpenCode.
It does not forward OpenCode's system prompt, tool definitions, or previous
chat history. It requests Antigravity's `--sandbox` mode at launch; sandbox
availability depends on the host and CLI version.

**Permissions:** Antigravity decides which actions to ask about. OpenCode can
deny or present an approval prompt for those actions, but it cannot intercept
actions Antigravity doesn't ask about. Set rules you want applied to all
Antigravity actions in Antigravity's `/permissions`. OpenCode's Plan agent
requests Antigravity's native Plan mode.

To allow Antigravity to run tools without approval prompts or the terminal
sandbox, set `fullAccess: true` in the plugin entry's `options` in
`opencode.jsonc`. This uses `agy acp --dangerously-skip-permissions` for
Antigravity chats and enabled subagents. OpenCode's Plan agent still uses a
sandboxed ACP process with approval prompts. Full access is off by default.

This is an experimental third-party integration. It uses OpenCode TUI
internals that can change between releases. Interactive chats support text
entered with Enter; they do not accept headless runs or queued prompts. The
interactive check is not a security boundary against another local API client.
The plugin does not carry context between Antigravity and other providers. See Google's
[ACP documentation](https://antigravity.google/docs/ide/extensions/acp) and
[terms](https://antigravity.google/terms) for applicable usage limits.

## Delegate from another OpenCode session

Subagent support is opt-in. Replace the existing plugin entry with this object
and add the agent under `agents` in `opencode.jsonc`. Choose a model listed
under **Google Antigravity** in `/models`:

```jsonc
{
  "plugins": [
    { "package": "./antigravity-native", "options": { "allowSubagents": true } }
  ],
  "agents": {
    "antigravity": {
      "description": "Use Google Antigravity for an explicitly requested coding task.",
      "mode": "subagent",
      "model": "antigravity-acp/gemini-3.8-flash"
    }
  }
}
```

In an OpenCode session running a different model, ask it to use the
`antigravity` subagent. OpenCode opens a child session and reports its result
back to the parent. Antigravity receives the delegated task, not the parent's
transcript, and uses the same `agy` sign-in. Google
[does not support agent-driven delegation on consumer plans](https://github.com/google-antigravity/antigravity-cli/issues/1493#issuecomment-6814901159).

## Test

```sh
bun test acp.test.ts
python3 test-tui.py
python3 test-tui.py --full-access
python3 test-tui.py --subagent enabled
python3 test-tui.py --subagent disabled
```

The TUI tests need `tmux`, OpenCode, and Node.js and use mock agents in a temporary
workspace. `python3 test-tui.py --real-catalog` optionally checks real model
discovery with your existing local sign-in; it does not send a prompt.
