import { Plugin } from "@opencode/plugin/tui"
import type { KeyEvent } from "@opentui/core"
import { Antigravity, type Answers, type Question, type Work } from "./rpc"

const providerID = "antigravity-acp"
const interactive = "antigravity-acp/interactive"

export default Plugin.define({
  id: "local.antigravity-native",
  setup(ctx) {
    const session = ctx.client.session
    const prompt = session.prompt
    let pending: { text: string; sessionID?: string; forkOf?: string; expires: number } | undefined
    let answering = false

    const client = () => ctx.client.rpc(Antigravity)
    const request = () => ({ location: ctx.location })
    const status = async (sessionID: string) => await client().status({ sessionID }, request()) as {
      questions: Question[]; steps: Work[]; agents: Work[]; replies: string[]
    }
    const sessionID = () => {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const answer = async (id: string) => {
      if (answering) return
      answering = true
      try {
        const [form] = (await status(id)).questions
        if (!form) return
        const values: Answers = Object.create(null)
        for (const field of form.fields) {
          const value = field.choices
            ? await ctx.ui.dialog.select({ title: field.title, options: field.choices })
            : await ctx.ui.dialog.prompt({ title: field.title })
          if (value === undefined) {
            await client().answer({ sessionID: id, id: form.id }, request())
            return
          }
          if (value === "" && !field.required) continue
          values[field.id] = field.type === "integer" || field.type === "number" ? Number(value) : value
        }
        await client().answer({ sessionID: id, id: form.id, answers: values }, request())
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error)
        await ctx.ui.dialog.alert({ title: "Antigravity question", message })
      } finally {
        answering = false
      }
    }
    const off = client().events.on("question", (event) => {
      const data = event.data as { sessionID: string }
      if (sessionID() === data.sessionID) void answer(data.sessionID)
    })
    const offBackground = client().events.on("background", (event) => {
      const data = event.data as { sessionID: string }
      ctx.ui.toast.show({ title: "Antigravity background reply", message: "Open /agy-work to read it.", sessionID: data.sessionID })
    })
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "antigravity.answer", title: "Answer Antigravity", slash: { name: "agy-answer" }, palette: true,
          async run() {
            const id = sessionID()
            if (id) await answer(id)
          },
        },
        {
          id: "antigravity.work", title: "Show Antigravity work", slash: { name: "agy-work" }, palette: true,
          async run() {
            const id = sessionID()
            if (!id) return
            const { steps, agents, replies } = await status(id)
            const entries = [
              ...steps.map((step) => ({ title: step.title, description: step.status, value: { text: step.status } })),
              ...agents.map((agent) => ({
                title: agent.title, description: agent.status,
                value: { text: agent.updates?.join("\n\n") ?? agent.status, child: agent.child },
              })),
              ...replies.map((reply, index) => ({
                title: `Background reply ${index + 1}`, description: reply.slice(0, 140), value: { text: reply },
              })),
            ]
            if (!entries.length) {
              await ctx.ui.dialog.alert({ title: "Antigravity work", message: "No Antigravity activity." })
              return
            }
            const detail = await ctx.ui.dialog.select<{ text: string; child?: string }>({ title: "Antigravity work", options: entries })
            if (!detail) return
            const result = detail.child ? await client().child({ sessionID: id, id: detail.child }, request()) as { text: string } : undefined
            await ctx.ui.dialog.alert({
              title: "Antigravity activity", message: [detail.text, result?.text].filter(Boolean).join("\n\n"),
            })
          },
        },
        {
          id: "antigravity.stop", title: "Stop Antigravity background work", slash: { name: "agy-stop" }, palette: true,
          async run() {
            const id = sessionID()
            if (id) await client().stop({ sessionID: id }, request())
          },
        },
      ],
    }))

    // withMediaRefs copies the methods off this same SDK object. Keep the native
    // optimistic composer path and only tag its next matching prompt request.
    const forward: typeof prompt = (input, options) => {
      const key = pending
      if (
        (key && key.expires >= Date.now() && key.text === input.text &&
          (key.forkOf ? ctx.data.session.get(input.sessionID)?.fork?.sessionID === key.forkOf
            : !key.sessionID || key.sessionID === input.sessionID)) ||
        (input.delivery === "queue" && ctx.ui.model.current()?.providerID === providerID)
      ) {
        pending = undefined
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
      if (typeof editor?.getClipboardText !== "function" || editor.plainText === undefined) return
      const origin = route.type === "session" ? route.sessionID : undefined
      const sideQuestion = origin && /^\/(?:side|btw)\s+(.+)\s*$/s.exec(editor.plainText)?.[1]?.trim()
      pending = {
        text: sideQuestion || editor.plainText,
        sessionID: sideQuestion ? undefined : origin,
        forkOf: sideQuestion ? origin : undefined,
        expires: Date.now() + 10_000,
      }
    }
    ctx.renderer.keyInput.prependListener("keypress", enter)

    return () => {
      off()
      offBackground()
      pending = undefined
      ctx.renderer.keyInput.off("keypress", enter)
      if (session.prompt === forward) session.prompt = prompt
    }
  },
})
