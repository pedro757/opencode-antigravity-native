import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"
import { contextUsageKey, readContextUsage } from "./context-usage"

export function registerContextFooter(ctx: Plugin.Context, providerID: string) {
  ctx.ui.slot({
    append: "prompt.footer.status",
    render: (props) => {
      const usage = createMemo(() => {
        if (!props.sessionID || props.mode !== "normal" || !props.showDetails) return
        const selected = ctx.ui.model.current()
        if (selected?.providerID !== providerID) return
        const messages = ctx.data.session.message.list(props.sessionID)
        const boundary = ctx.data.session.get(props.sessionID)?.revert?.messageID
        const end = boundary ? messages.findIndex((message) => message.id === boundary) : messages.length
        const checkpoint = messages.findLast((message, index) =>
          index < end && (
            (message.type === "assistant" && message.time.completed !== undefined) ||
            (message.type === "compaction" && message.status === "completed")
          ))
        if (checkpoint?.model?.providerID !== providerID || checkpoint.model.id !== selected.modelID) return
        return readContextUsage(checkpoint.native?.[contextUsageKey])
      })
      return (
        <Show when={usage()}>
          {(value) => (
            <text fg={ctx.theme.text.muted} wrapMode="none" flexShrink={0}>
              {Math.round((value().used / value().size) * 100)}% context
            </text>
          )}
        </Show>
      )
    },
  })
}
