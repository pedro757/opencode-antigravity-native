import { Plugin } from "@opencode/plugin/tui"
import type { KeyEvent } from "@opentui/core"

const providerID = "antigravity-acp"
const interactive = "antigravity-acp/interactive"

export default Plugin.define({
  id: "local.antigravity-native",
  setup(ctx) {
    const session = ctx.client.session
    const prompt = session.prompt
    let pending: { text: string; sessionID?: string; expires: number } | undefined

    // withMediaRefs copies the methods off this same SDK object. Keep the native
    // optimistic composer path and only tag its next matching prompt request.
    const forward: typeof prompt = (input, options) => {
      const key = pending
      if (
        key && key.expires >= Date.now() && key.text === input.text &&
        (!key.sessionID || key.sessionID === input.sessionID)
      ) {
        pending = undefined
        if (input.files?.length || input.agents?.length || input.skills?.length)
          return Promise.reject(new Error("Antigravity currently accepts text only. Remove any attached files, agents, or skills."))
        return prompt({ ...input, metadata: { ...input.metadata, [interactive]: true } }, options)
      }
      return prompt(input, options)
    }
    session.prompt = forward

    const enter = (event: KeyEvent) => {
      if (event.name !== "return" && event.name !== "enter") return
      pending = undefined
      if (event.ctrl || event.meta || event.shift || event.option || event.super || event.defaultPrevented) return
      const route = ctx.ui.router.current()
      if (route.type !== "home" && route.type !== "session") return
      if (ctx.ui.model.current()?.providerID !== providerID) return
      // The native composer supplies both plainText and its paste-aware
      // clipboard handler; unrelated text inputs don't have both.
      const editor = ctx.renderer.currentFocusedRenderable as
        | { plainText?: string; getClipboardText?: unknown }
        | null | undefined
      if (typeof editor?.getClipboardText !== "function" || !editor.plainText?.trim()) return
      pending = {
        text: editor.plainText,
        sessionID: route.type === "session" ? route.sessionID : undefined,
        expires: Date.now() + 10_000,
      }
    }
    ctx.renderer.keyInput.prependListener("keypress", enter)

    return () => {
      pending = undefined
      ctx.renderer.keyInput.off("keypress", enter)
      if (session.prompt === forward) session.prompt = prompt
    }
  },
})
