import { Model, Plugin, Provider } from "@opencode/plugin"
import type { Context } from "@opencode/plugin"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { Acp, AcpError } from "./acp"

const providerID = Provider.ID.make("antigravity-acp")
const sdkPackage = "@local/antigravity-acp"
const interactive = "antigravity-acp/interactive"
const tokenKey = "antigravity-acp/ticket"
const text = (value: unknown) => typeof value === "string" ? value : ""
const gemini = (id: string) => /^gemini(?:[-_. ]|$)/i.test(id)

type Choice = { value: string; name: string }
type Config = {
  id: string
  category?: string
  currentValue: string
  options: Array<Choice | { options: Choice[] }>
}
type Setup = {
  sessionId?: string
  configOptions?: Config[]
  models?: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> }
}
type Capabilities = { sessionCapabilities?: { close?: object; resume?: object } }
type Usage = { inputTokens?: number; outputTokens?: number; thoughtTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number }
type View = { controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>; sessionID: string; agent?: string; cancelled: boolean }
type Thread = { id: string; options: Config[]; closeAfter: boolean }

function configs(setup: Setup): Config[] {
  if (setup.configOptions?.length) return setup.configOptions
  if (!setup.models) return []
  return [{
    id: "legacy-model",
    category: "model",
    currentValue: setup.models.currentModelId,
    options: setup.models.availableModels.map((item) => ({ value: item.modelId, name: item.name })),
  }]
}

const options = (config: Config | undefined) => (config?.options ?? []).flatMap((item) => "options" in item ? item.options : [item])
const find = (items: Config[], name: string) => items.find((item) => item.category === name || item.id === name)
const disconnected = "Antigravity session is not ready. If signed out, run agy and sign in, then /reload."

export default Plugin.define({
  id: "local.antigravity-native",
  async setup(ctx) {
    const cwd = ctx.location.directory
    if (ctx.location.workspaceID) return
    const tickets = new Map<string, { sessionID: string; text: string }>()
    const threads = new Map<string, Thread>()
    const turns = new Map<string, View>()
    let connection: { client: Acp; caps: Capabilities } | undefined
    let opening: Promise<{ client: Acp; caps: Capabilities }> | undefined
    let closed = false
    let engaged = 0
    const state = { models: [] as Model.Info[] }

    function connect() {
      if (connection) return Promise.resolve(connection)
      if (opening) return opening
      if (closed) return Promise.reject(new Error(disconnected))
      const client = Acp.launch(cwd, (method, params) => {
        const view = turns.get(params?.sessionId)
        if (method === "session/request_permission") return permission(ctx, view, params)
        if (method !== "session/update") throw new AcpError(`Client does not support ${method}`, -32601)
        if (!view?.cancelled) updates.get(params?.sessionId)?.(params.update)
      }, () => {
        connection = undefined
        threads.clear()
      })
      opening = client.request<{ protocolVersion: number; agentCapabilities?: Capabilities }>("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "opencode-antigravity-client", title: "OpenCode – Antigravity Client", version: "0.1.0" },
      }).then((result) => {
        if (closed || result.protocolVersion !== 1) throw new Error(disconnected)
        connection = { client, caps: result.agentCapabilities ?? {} }
        return connection
      }).catch((error) => {
        client.close()
        throw error
      }).finally(() => { opening = undefined })
      return opening
    }

    const updates = new Map<string, (update: unknown) => void>()
    const scope = { providerID }
    const status = (error: unknown) =>
      error instanceof AcpError && error.code === -32000 ? new Error(disconnected) : error

    async function thread(sessionID: string, linked: { client: Acp; caps: Capabilities }) {
      const current = threads.get(sessionID)
      if (current) return current
      const oldID = await ctx.storage.get(`acp/${sessionID}`)
      const input = { cwd, mcpServers: [] }
      const saved = typeof oldID === "string" && linked.caps.sessionCapabilities?.resume
        ? await linked.client.request<Setup>("session/resume", { ...input, sessionId: oldID })
            .then((item) => ({ ...item, sessionId: item.sessionId ?? oldID }))
            .catch((error) => {
              if (!(error instanceof AcpError) || error.code !== -32002) throw error
              return undefined
            })
        : undefined
      const setup = saved ?? await linked.client.request<Setup>("session/new", input)
      if (!setup.sessionId) throw new Error("Antigravity did not return a conversation ID.")
      const item = { id: setup.sessionId, options: configs(setup), closeAfter: Boolean(linked.caps.sessionCapabilities?.close) }
      await ctx.storage.set(`acp/${sessionID}`, item.id)
      threads.set(sessionID, item)
      return item
    }

    async function select(client: Acp, item: Thread, name: string, value: string, required = true) {
      const config = find(item.options, name)
      if (config?.currentValue === value) return
      if (!options(config).some((option) => option.value === value)) {
        if (required) throw new Error(`Antigravity does not offer ${name} ${value} in this session.`)
        return
      }
      if (config!.id === "legacy-model") {
        await client.request("session/set_model", { sessionId: item.id, modelId: value })
      } else {
        const response = await client.request<Setup>("session/set_config_option", {
          sessionId: item.id, configId: config!.id, value,
        })
        if (response.configOptions) {
          item.options = response.configOptions
          return
        }
      }
      config!.currentValue = value
    }

    function language(modelId: string): LanguageModelV3 {
      return {
        specificationVersion: "v3",
        provider: providerID,
        modelId,
        supportedUrls: {},
        async doGenerate() { throw new Error("Antigravity only accepts interactive streaming prompts.") },
        async doStream(request: LanguageModelV3CallOptions) {
          const sessionID = request.headers?.["x-opencode-session-id"]
          const settings = request.providerOptions?.[providerID]
          const key = text(settings?.ticket)
          const ticket = tickets.get(key)
          tickets.delete(key)
          if (!sessionID || request.headers?.["x-opencode-parent-session-id"] || ticket?.sessionID !== sessionID)
            throw new Error("Send a new message with Enter in the native Antigravity TUI. Background prompts and replays are disabled.")
          if (request.abortSignal?.aborted) throw request.abortSignal.reason
          const agent = request.headers?.["x-antigravity-agent"]
          const reset = new AbortController()
          let stop: (() => void) | undefined
          const stream = new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              const view = { controller, sessionID, agent, cancelled: false }
              stop = () => { view.cancelled = true; reset.abort() }
              const signal = request.abortSignal ? AbortSignal.any([reset.signal, request.abortSignal]) : reset.signal
              engaged++
              void (async () => {
                const linked = await connect()
                const item = await thread(sessionID, linked)
                const client = linked.client
                if (turns.has(item.id)) throw new Error("Antigravity is already answering in this session.")
                signal.throwIfAborted()
                await select(client, item, "model", modelId)
                if (settings?.effort) await select(client, item, "thought_level", text(settings.effort))
                // Preserve a real read-only agent mode. Never silently substitute a writable mode for Plan.
                await select(client, item, "mode", agent === "plan" ? "plan" : "default", agent === "plan")
                signal.throwIfAborted()
                const renderer = render(controller)
                turns.set(item.id, view)
                updates.set(item.id, renderer.update)
                const cancel = () => client.notify("session/cancel", { sessionId: item.id })
                signal.addEventListener("abort", cancel, { once: true })
                try {
                  controller.enqueue({ type: "stream-start", warnings: [] })
                  const outcome = await client.request<{ stopReason: string; usage?: Usage }>("session/prompt", {
                    sessionId: item.id,
                    prompt: [{ type: "text", text: ticket.text }],
                  }, 0)
                  if (view.cancelled) return
                  renderer.end()
                  // This was a complete ACP turn. Do not let the host loop continue it or retry a tool.
                  const usage = outcome.usage
                  controller.enqueue({
                    type: "finish",
                    finishReason: { unified: "stop", raw: outcome.stopReason },
                    usage: {
                      inputTokens: { total: usage?.inputTokens, noCache: undefined, cacheRead: usage?.cachedReadTokens, cacheWrite: usage?.cachedWriteTokens },
                      outputTokens: { total: usage?.outputTokens, text: undefined, reasoning: usage?.thoughtTokens },
                    },
                  })
                  controller.close()
                } finally {
                  signal.removeEventListener("abort", cancel)
                  updates.delete(item.id)
                  turns.delete(item.id)
                }
              })().catch((error) => {
                if (!view.cancelled) controller.error(status(error))
              }).finally(() => { engaged-- })
            },
            cancel() { stop?.() },
          })
          return { stream }
        },
      }
    }

    await ctx.provider.transform((editor) => editor.add({
      info: {
        ...Provider.Info.empty(providerID),
        name: "Google Antigravity",
        activation: "enabled",
        package: `aisdk:${sdkPackage}`,
      },
      models: state.models,
    }))
    await ctx.aisdk.hook("sdk", (event) => {
      if (event.package === sdkPackage) event.sdk = { languageModel: language }
    }, scope)
    await ctx.session.hook("prompt", (event) => {
      if (event.metadata?.[interactive] !== true) return
      delete event.metadata[interactive]
      const key = crypto.randomUUID()
      // Only a fresh composer submission can claim a turn. Do not restore these tickets after reload or restart.
      if (tickets.size >= 100) tickets.delete(tickets.keys().next().value!)
      tickets.set(key, { sessionID: event.sessionID, text: event.prompt.text })
      event.metadata[tokenKey] = key
    })
    await ctx.session.hook("context", (event) => {
      event.tools = {}
      const message = event.messages.findLast((item) => item.role === "user")
      event.options.ticket = message?.metadata?.[tokenKey]
    }, scope)
    await ctx.session.hook("model.request", (event) => {
      event.headers["x-antigravity-agent"] = event.agent
    }, scope)
    await ctx.session.hook("title", async (event) => {
      if (event.model.providerID === providerID) {
        event.result = "Antigravity chat"
        return
      }
      // The user's title agent can point at a different provider. Keep these
      // chats from silently sending a second model call just to get a title.
      const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
      if (session?.model?.providerID === providerID) event.result = "Antigravity chat"
    })
    await ctx.session.hook("compaction", (event) => { event.result = { summary: "Antigravity manages this chat's context." } }, scope)
    await ctx.session.hook("retry", (event) => { event.decision = { retry: false } }, scope)
    await ctx.permission.hook("evaluate", (event) => {
      // An approval requested by Antigravity is explicit, even when native Build usually allows this action.
      if (event.metadata?.provider === "Antigravity" && event.effect === "allow") event.effect = "ask"
    })

    const lifetime = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.deleted"], signal: lifetime.signal })) {
        const id = event.data.sessionID
        const current = threads.get(id)
        threads.delete(id)
        if (current?.closeAfter && connection)
          await connection.client.request("session/close", { sessionId: current.id }).catch(() => {})
        await ctx.storage.remove(`acp/${id}`)
      }
    })().catch(() => {})
    void (async () => {
      const cached = await ctx.storage.get("catalog")
      if (closed) return
      if (cached && typeof cached === "object" && !Array.isArray(cached) && Array.isArray(cached.models)) {
        state.models = cached.models.map((item) => Model.Info.make(item as Model.Info))
        await ctx.provider.reload()
        if (typeof cached.at === "number" && Date.now() - cached.at < 30 * 60_000) return
      }
      const { client, caps } = await connect()
      try {
        const setup = await client.request<Setup>("session/new", { cwd, mcpServers: [] })
        const values = configs(setup)
        const levels = options(find(values, "thought_level"))
        state.models = options(find(values, "model")).filter((option) => gemini(option.value)).map((item) => ({
          ...Model.Info.default(providerID, Model.ID.make(item.value)),
          name: item.name,
          limit: { context: 0, output: 0 },
          capabilities: { input: ["text"], output: ["text"], tools: false },
          cost: [],
          variants: levels.map((level) => ({ id: Model.VariantID.make(level.value), settings: { effort: level.value } })),
        }))
        if (closed) return
        if (state.models.length) {
          await ctx.storage.set("catalog", { at: Date.now(), models: state.models as never })
          await ctx.provider.reload()
        }
        if (setup.sessionId && caps.sessionCapabilities?.close)
          await client.request("session/close", { sessionId: setup.sessionId })
      } finally {
        if (!engaged && !threads.size) client.close()
      }
    })().catch((error) => { if (!closed) console.warn("Antigravity ACP: could not load models", status(error)) })

    return () => {
      closed = true
      lifetime.abort()
      connection?.client.close()
      tickets.clear()
      threads.clear()
    }
  },
})

type ToolCall = { id: string; name: string; input: unknown; done: boolean }
function render(controller: View["controller"]) {
  const calls = new Map<string, ToolCall>()
  let last: "text" | "reasoning" | undefined
  let index = 0
  const send = (event: LanguageModelV3StreamPart) => controller.enqueue(event)
  const end = () => {
    if (last) send({ type: `${last}-end`, id: String(index) })
    last = undefined
  }
  function settle(call: ToolCall, state: string, content?: unknown) {
    if (call.done) return
    call.done = true
    send({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.input ?? {}), providerExecuted: true })
    send({
      type: "tool-result", toolCallId: call.id, toolName: call.name,
      result: { status: state, ...(content === undefined ? {} : { content }) },
      isError: state !== "completed",
    })
  }
  return {
    update(raw: unknown) {
      if (!raw || typeof raw !== "object") return
      const update = raw as {
        sessionUpdate?: string; content?: { type?: string; text?: string }; toolCallId?: string
        name?: string; title?: string; rawInput?: unknown; status?: string
      }
      const type = update.sessionUpdate
      if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
        if (update.content?.type !== "text" || !update.content.text) return
        const kind = type === "agent_message_chunk" ? "text" : "reasoning"
        if (kind !== last) {
          end()
          send({ type: `${kind}-start`, id: String(++index) })
          last = kind
        }
        send({ type: `${kind}-delta`, id: String(index), delta: update.content.text })
        return
      }
      if ((type !== "tool_call" && type !== "tool_call_update") || !update.toolCallId) return
      end()
      const id = update.toolCallId
      const call = calls.get(id) ?? { id, name: text(update.name || update.title) || "Antigravity tool", input: update.rawInput, done: false }
      calls.set(id, call)
      if (update.rawInput !== undefined) call.input = update.rawInput
      if (update.status === "completed" || update.status === "failed") settle(call, update.status, update.content)
    },
    end() {
      end()
      for (const call of calls.values()) settle(call, "incomplete")
    },
  }
}

async function permission(ctx: Context, view: View | undefined, params: {
  toolCall?: {
    title?: string
    kind?: string
    rawInput?: { command?: string; CommandLine?: string }
    locations?: Array<{ path: string }>
    content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>
  }
  options?: Array<{ kind: string; optionId: string }>
}) {
  const cancelled = { outcome: { outcome: "cancelled" } }
  if (!view || view.cancelled) return cancelled
  const reject = params.options?.find((option) => option.kind === "reject_once")
  const allow = params.options?.find((option) => option.kind === "allow_once")
  if (!allow) return cancelled
  const call = params.toolCall
  const title = text(call?.title) || "Antigravity tool"
  const diff = call?.content?.find((part) => part.type === "diff" && part.path)
  const locations = [...new Set([...(call?.locations?.map((location) => location.path) ?? []), diff?.path].filter((path): path is string => !!path))]
  const action = ({ edit: "edit", delete: "edit", move: "edit", execute: "shell", read: "read", search: "grep", fetch: "webfetch" } as Record<string, string>)[call?.kind ?? ""] ?? (diff ? "edit" : "antigravity")
  const command = text(call?.rawInput?.command || call?.rawInput?.CommandLine)
  const oldLines = diff?.oldText?.trimEnd().split("\n") ?? []
  const newLines = diff?.newText?.trimEnd().split("\n") ?? []
  const patch = diff?.path && oldLines.length + newLines.length <= 200
    ? [
        `--- ${diff.path}`, `+++ ${diff.path}`,
        `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
        ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`),
      ].join("\n")
    : undefined
  const choice = await ctx.permission.assert({
    sessionID: view.sessionID,
    agent: view.agent,
    action,
    resources: action === "shell" ? [command || title] : locations.length ? locations : [title],
    metadata: { title, provider: "Antigravity", ...(patch ? { diff: patch } : {}) },
  }).then(() => allow, () => reject)
  return choice && !view.cancelled ? { outcome: { outcome: "selected", optionId: choice.optionId } } : cancelled
}
