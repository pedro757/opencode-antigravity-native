# Google Antigravity for OpenCode

Use Google's Antigravity agent in OpenCode's native terminal UI: the normal
composer, transcript, `/models` picker, and permission prompts. No patched
OpenCode build, separate OpenCode service, or separate UI is required.

## Install

Requires OpenCode v2 (tested with **2.4.2**) and the official
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

In OpenCode, run `/reload` if needed, open `/models`, and select a model under
**Google Antigravity**. The plugin lists the models and thinking levels offered
by your `agy acp` session. Use `/variants` to change the thinking level or
restore **Default** for the selected model. Send a text prompt with **Enter**.

Session titles use OpenCode's built-in title agent. For automatic titles, set
`agents.title.model` to an available non-Antigravity model; the ACP bridge only
accepts interactive prompts.

## How it works

The plugin runs the official `agy acp` subprocess over stdio. Antigravity owns
its system prompt, tools, and conversation state. The plugin forwards new,
interactive text prompts and displays replies and tool activity in OpenCode.
It does not forward OpenCode's system prompt or tool definitions. It requests
Antigravity's `--sandbox` mode at launch; sandbox availability depends on the
host and CLI version.

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
internals that can change between releases. Submit from the composer; use
OpenCode's queue shortcut to wait for the next turn. On `agy` 1.5+ a plain-text
follow-up can steer a running turn. Headless runs are not supported. The
interactive check is not a security boundary against another local API client.
See Google's
[ACP documentation](https://antigravity.google/docs/ide/extensions/acp) and
[terms](https://antigravity.google/terms) for applicable usage limits.

## Fork a session

OpenCode's `/fork` copies the transcript to the chosen point. When you send
your first message in the fork, the plugin starts a separate Antigravity
conversation and includes the copied conversation text as context. It uses
available summaries for compacted history and prioritizes recent messages
when the history exceeds the context budget. It does not rerun old prompts
or tools. Later messages continue in the new conversation.

## Work in a session

- Attach files in the native composer. The bridge sends supported image and
  audio blocks directly, embeds small text files, and supplies other files as
  links to private temporary copies.
- Answer Antigravity questions in OpenCode's built-in question menu. Use
  `/agy-answer` to refresh pending questions. `/agy-work` shows task steps,
  reported subagent updates, child transcripts when Antigravity exposes them,
  and recent background replies. `/agy-stop` also stops detached work.
- The next prompt picks up a side-chat result brought back by `better-sidechats`.
  On switching back from another provider, rewinding past a delivered prompt,
  or losing a native session, Antigravity rebuilds from OpenCode's retained
  history.
- OpenCode's `/compact` uses Antigravity's native command when the session
  advertises it. `/agy-clear` starts a new Antigravity conversation while
  leaving the visible OpenCode transcript intact.

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
python3 test-tui.py --subagent override
python3 test-tui.py --fork
python3 test-tui.py --features
python3 test-tui.py --variants
```

The TUI tests need `tmux`, OpenCode, and Node.js and use mock agents in a temporary
workspace. `python3 test-tui.py --real-catalog` optionally checks real model
discovery with your existing local sign-in; it does not send a prompt.
