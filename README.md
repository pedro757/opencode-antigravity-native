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

This is an experimental third-party integration. It uses OpenCode TUI
internals that can change between releases. It supports text only and is not a
backend for headless runs, background jobs, or queued prompts. The interactive
check is not a security boundary against another local API client. The plugin
does not carry context between Antigravity and other providers. See Google's
[ACP documentation](https://antigravity.google/docs/ide/extensions/acp) and
[terms](https://antigravity.google/terms) for applicable usage limits.

## Test

```sh
bun test acp.test.ts
python3 test-tui.py
```

The second test needs `tmux`, OpenCode, and Node.js and uses a mock agent in a
temporary workspace. `python3 test-tui.py --real-catalog` optionally checks real
model discovery with your existing local sign-in; it does not send a prompt.
