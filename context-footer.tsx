import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"
import { contextUsageKey, readContextUsage } from "./context-usage"

export function registerContextFooter(ctx: Plugin.Context, providerID: string) {
  ctx.ui.slot({
    append: "prompt.footer.status",
    render: (props) => {
      const label = createMemo(() => {
        if (!props.sessionID || props.mode !== "normal" || !props.showDetails) return
        const selected = ctx.ui.model.current()
        if (selected?.providerID !== providerID) return
        const messages = ctx.data.session.message.list(props.sessionID)
        const boundary = ctx.data.session.get(props.sessionID)?.revert?.messageID
        const end = boundary ? messages.findIndex((message) => message.id === boundary) : messages.length
        let newerTurn = false
        for (let index = end - 1; index >= 0; index--) {
          const message = messages[index]
          if (message.type === "user" && message.text.trim() === "/agy-clear") break
          const compacted = message.type === "compaction" && message.status === "completed"
          if (!compacted && (message.type !== "assistant" || message.time.completed === undefined)) continue
          if (message.model?.providerID !== providerID || message.model.id !== selected.modelID) break
          const usage = readContextUsage(message.native?.[contextUsageKey])
          if (usage) {
            const percent = Math.round((usage.used / usage.size) * 100)
            return newerTurn ? `${percent}% context (last reported)` : `${percent}% context`
          }
          newerTurn = true
          if (compacted) break
        }
      })
      return (
        <Show when={label()}>
          {(value) => <text fg={ctx.theme.text.muted} wrapMode="none" flexShrink={0}>{value()}</text>}
        </Show>
      )
    },
  })
}
