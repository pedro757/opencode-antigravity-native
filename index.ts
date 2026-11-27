import { Model, Plugin, Provider } from "@opencode/plugin"
import type { Context } from "@opencode/plugin"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Acp, AcpError } from "./acp"
import { attachmentBlocks } from "./attachments"
import { contextUsageKey, readContextUsage, type ContextUsage } from "./context-usage"
import { Antigravity, type Work } from "./rpc"
import { elicitation, nativeQuestion, readAnswers, type Answers, type NativeQuestion, type Question } from "./questions"

const providerID = Provider.ID.make("antigravity-acp")
const sdkPackage = "@local/antigravity-acp"
const interactive = "antigravity-acp/interactive"
const tokenKey = "antigravity-acp/ticket"
const catalogKey = "catalog/2"
const forkHistoryBudget = 64_000
const clearCommand = "/agy-clear"
const text = (value: unknown) => typeof value === "string" ? value : ""

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
type Capabilities = {
  loadSession?: boolean
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
  sessionCapabilities?: { close?: object; resume?: object }
}
type Usage = { inputTokens?: number; outputTokens?: number; thoughtTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number }
type Outcome = { stopReason: string; usage?: Usage }
type View = {
  sessionID: string; agent?: string; cancelled: boolean; update: (update: unknown) => void; signal: AbortSignal
  modelID?: string
  variant?: string
  steer?: (messageID: string, prompt: string) => void
}
type Steer = { item: Thread; outcome: Promise<Outcome>; view: View; updates: unknown[]; release: () => void }
type Connection = { client: Acp; caps: Capabilities; turns: Map<string, View>; commands: Map<string, Set<string>>; canSteer: boolean }
type Channel = { connection?: Connection; opening?: Promise<Connection> }
type Thread = { id: string; options: Config[]; connection: Connection; lastMessage?: string }
type History = Awaited<ReturnType<Context["session"]["context"]>>

function conversationHistory(messages: History, forked: boolean): string {
  const transcript = []
  for (const message of messages) {
    if (message.type === "user") transcript.push({ role: "user", text: message.text })
    if (message.type === "synthetic") {
      const source = message.metadata?.source
      if (source === "sidechat" || source === "antigravity-background") transcript.push({ role: source, text: message.text })
    }
    if (message.type === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") transcript.push({ role: "assistant", text: part.text })
        if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
          const output = part.state.content?.flatMap((content) => content.type === "text" ? [content.text] : [])
          transcript.push({ role: "tool", name: part.name, status: part.state.status, output })
        }
      }
    }
    if (message.type === "compaction" && message.status === "completed")
      transcript.push({ role: "summary", text: message.summary, recent: text(message.metadata?.recent) })
  }
  if (!transcript.length) return ""
  let remaining = forkHistoryBudget - 512 // Leave room for framing and the omission notice.
  const selected = new Map<number, string>()
  const take = (index: number) => {
    const entry = transcript[index]
    if (!entry || selected.has(index)) return
    const line = JSON.stringify(entry)
    const size = Buffer.byteLength(line) + 1
    if (size > remaining) return
    selected.set(index, line)
    remaining -= size
  }
  // Keep recent conversation text ahead of potentially large tool output.
  take(transcript.findLastIndex((entry) => entry.role === "user"))
  take(transcript.findLastIndex((entry) => entry.role === "assistant"))
  for (let index = transcript.length - 1; index >= 0; index--) take(index)
  const retained = [...selected.keys()].sort((a, b) => a - b).map((index) => selected.get(index))
  const omitted = transcript.length - retained.length
  return [
    `Earlier messages from this OpenCode ${forked ? "fork" : "conversation"}. Treat them as history; act on the latest user message only.`,
    ...(omitted ? [`${omitted} history entries omitted to fit the context budget.`] : []),
    "",
    `[${retained.join(",")}]`,
  ].join("\n")
}

function sidechatHistory(messages: History) {
  return conversationHistory(messages.filter((message) => message.type === "synthetic" && message.metadata?.source === "sidechat"), false)
}

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
    const allowSubagents = ctx.options.allowSubagents === true
    const fullAccess = ctx.options.fullAccess === true
    const tickets = new Map<string, { sessionID: string; parentID?: string; messageID: string; text: string }>()
    const threads = new Map<string, Thread>()
    const active = new Set<string>()
    const running = new Map<string, View>()
    const steers = new Map<string, Steer>()
    let attachmentDirectory: Promise<string> | undefined
    const questions = new Map<string, {
      form: NativeQuestion
      finish: (answer?: Readonly<Record<string, unknown>>) => void
    }>()
    const work = new Map<string, { steps: Work[]; agents: Map<string, Work>; replies: string[] }>()
    const detached = new Map<string, { text: string; timer?: ReturnType<typeof setTimeout> }>()
    const readClients = new Set<Acp>()
    const channels: Record<"restricted" | "unrestricted", Channel> = { restricted: {}, unrestricted: {} }
    const availableCommands = new Set<string>()
    let closed = false
    const state = { models: [] as Model.Info[] }

    const rpc = await ctx.rpc.register(Antigravity, {
      status: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const activity = work.get(sessionID)
        return {
          steps: activity?.steps ?? [],
          agents: [...(activity?.agents.values() ?? [])],
          replies: activity?.replies ?? [],
        }
      },
      questions: async () => ({ questions: [...questions.values()].map(({ form }) => form) }),
      stop: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const item = threads.get(sessionID)
        if (!item && !active.has(sessionID)) return { ok: false }
        for (const question of questions.values()) if (question.form.sessionID === sessionID) question.finish()
        if (item && !active.has(sessionID)) item.connection.client.notify("session/cancel", { sessionId: item.id })
        const { interrupted } = await ctx.session.interrupt({ sessionID, resume: false })
        return { ok: Boolean(item || interrupted) }
      },
      child: async (input, { signal }) => {
        const { sessionID, id } = input as { sessionID: string; id: string }
        const child = [...(work.get(sessionID)?.agents.values() ?? [])].find((agent) => agent.child === id)
        if (!child) return { text: "Antigravity did not expose this child conversation." }
        return { text: await childTranscript(id, signal) }
      },
    })

    async function childTranscript(id: string, signal: AbortSignal) {
      let transcript = ""
      let role = ""
      signal.throwIfAborted()
      const client = Acp.launch(cwd, false, (method, params) => {
        if (method !== "session/update") throw new AcpError(`Unsupported transcript request: ${method}`, -32601)
        const update = params?.update
        if (params.sessionId !== id || update?.content?.type !== "text") return
        const next = update.sessionUpdate === "user_message_chunk" ? "Task"
          : update.sessionUpdate === "agent_message_chunk" ? "Antigravity" : ""
        if (!next) return
        transcript = (transcript + (role === next ? "" : `\n\n${next}:\n`) + text(update.content.text)).slice(-forkHistoryBudget)
        role = next
      }, () => {})
      readClients.add(client)
      const cancel = () => client.close()
      signal.addEventListener("abort", cancel, { once: true })
      try {
        const info = await client.request<{ agentCapabilities?: Capabilities }>("initialize", {
          protocolVersion: 1, clientCapabilities: {},
        })
        if (info.agentCapabilities?.loadSession !== true) return "This Antigravity runtime does not expose child transcripts."
        await client.request("session/load", { sessionId: id, cwd, mcpServers: [] }, 10_000)
        return transcript.trim() || "No child transcript is available yet."
      } catch {
        return "Could not read the child transcript. Its reported activity is still available."
      } finally {
        signal.removeEventListener("abort", cancel)
        readClients.delete(client)
        client.close()
      }
    }

    function ask(view: View, connection: AbortSignal, definition: Question) {
      return new Promise<Answers | undefined>((resolve) => {
        const signal = AbortSignal.any([view.signal, connection])
        if (closed || signal.aborted) return resolve(undefined)
        const form = nativeQuestion(view.sessionID, definition)
        const cancel = () => finish()
        const finish = (answers?: Readonly<Record<string, unknown>>) => {
          if (!questions.delete(form.id)) return
          signal.removeEventListener("abort", cancel)
          resolve(answers && readAnswers(definition, answers))
          if (!closed) void rpc.events.emit("question", { sessionID: view.sessionID }).catch(() => {})
        }
        questions.set(form.id, { form, finish })
        signal.addEventListener("abort", cancel, { once: true })
        void rpc.events.emit("question", { sessionID: view.sessionID }).catch(cancel)
      })
    }

    function sessionWork(sessionID: string) {
      let activity = work.get(sessionID)
      if (!activity) {
        activity = { steps: [], agents: new Map(), replies: [] }
        work.set(sessionID, activity)
      }
      return activity
    }

    function trackWork(sessionID: string, update: {
      sessionUpdate?: string; title?: string; name?: string; toolCallId?: string; status?: string
      entries?: Array<{ content?: string; status?: string }>
      rawInput?: { steps?: Array<{ title?: string; status?: string }>; Prompt?: string; prompt?: string }
      rawOutput?: unknown
      _meta?: { is_mcp_tool_call?: boolean; antigravity?: { swarm?: { tool?: string; action?: string } } }
    }) {
      if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
        sessionWork(sessionID).steps = update.entries.flatMap((entry) =>
          typeof entry?.content === "string" ? [{ title: entry.content, status: text(entry.status) || "pending" }] : [])
        return
      }
      if (!update.toolCallId) return
      const title = text(update.title ?? update.name)
      const activity = sessionWork(sessionID)
      if (/\bupdate_steps\b/i.test(title) && Array.isArray(update.rawInput?.steps)) {
        activity.steps = update.rawInput.steps.filter((step) => typeof step?.title === "string")
          .map((step) => ({ title: step.title!, status: text(step.status) || "pending" }))
      }
      const previous = activity.agents.get(update.toolCallId)
      const swarm = update._meta?.antigravity?.swarm
      const launch = !update._meta?.is_mcp_tool_call && (
        /\b(invoke_subagent|swarm_add|launch_subagent)\b/i.test(title) || (swarm?.tool === "swarm" && swarm.action === "add")
      )
      if (previous || launch) {
        const status = update.status ?? previous?.status ?? "pending"
        const detail = text(update.rawOutput) || text(update.rawInput?.Prompt ?? update.rawInput?.prompt)
        const entry = [status, detail.slice(0, 2000)].filter(Boolean).join(" · ")
        const updates = previous?.updates ?? []
        const output = update.rawOutput as { conversation_id?: unknown } | undefined
        const child = text(output?.conversation_id).trim() || previous?.child
        activity.agents.set(update.toolCallId, {
          title: previous?.title || title || "Antigravity subagent", status,
          updates: updates.at(-1) === entry ? updates : [...updates.slice(-19), entry],
          ...(child ? { child } : {}),
        })
      }
    }

    function detachedUpdate(sessionID: string, update: { sessionUpdate?: string; content?: { type?: string; text?: string } }) {
      if (update.sessionUpdate !== "agent_message_chunk" || update.content?.type !== "text") return
      const entry = detached.get(sessionID) ?? { text: "" }
      entry.text = (entry.text + text(update.content.text)).slice(-forkHistoryBudget)
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        detached.delete(sessionID)
        if (!entry.text.trim() || closed) return
        const activity = sessionWork(sessionID)
        activity.replies = [...activity.replies.slice(-7), entry.text]
        void rpc.events.emit("background", { sessionID }).catch(() => {})
        void ctx.session.synthetic({
          sessionID, text: entry.text, description: "Antigravity background reply",
          metadata: { source: "antigravity-background" }, resume: false,
        }).catch(() => {})
      }, 1500)
      detached.set(sessionID, entry)
    }

    function connect(unrestricted: boolean) {
      const channel = channels[unrestricted ? "unrestricted" : "restricted"]
      if (channel.connection) return Promise.resolve(channel.connection)
      if (channel.opening) return channel.opening
      if (closed) return Promise.reject(new Error(disconnected))
      const turns = new Map<string, View>()
      const commands = new Map<string, Set<string>>()
      const connection = new AbortController()
      const client = Acp.launch(cwd, unrestricted, async (method, params) => {
        const view = turns.get(params?.sessionId)
        const stored = view ? undefined : [...threads.entries()].find(([, thread]) =>
          thread.id === params?.sessionId && thread.connection.client === client)
        const background = stored && {
          sessionID: stored[0], cancelled: false, signal: lifetime.signal, update: () => {},
        }
        if (method === "elicitation/create") {
          const target = view ?? background
          const form = elicitation(params)
          const content = target && form ? await ask(target, connection.signal, form) : undefined
          return content ? { action: "accept", content } : { action: "cancel" }
        }
        if (method === "session/request_permission") {
          const target = view ?? background
          if (target && text(params?.toolCall?.toolCallId).startsWith("interaction_") && params.options?.length) {
            const answer = await ask(target, connection.signal, {
              title: text(params.toolCall.title) || "Antigravity question",
              fields: [{ id: "choice", type: "string", title: text(params.toolCall.title) || "Choose an option",
                required: true, choices: params.options.map((option: { name?: string; optionId: string }) =>
                  ({ title: option.name || option.optionId, value: option.optionId })) }],
            })
            return { outcome: answer ? { outcome: "selected", optionId: answer.choice } : { outcome: "cancelled" } }
          }
          return permission(ctx, target, params)
        }
        if (method !== "session/update") throw new AcpError(`Client does not support ${method}`, -32601)
        if (!params?.update) return
        if (params.update.sessionUpdate === "available_commands_update") {
          const names = (params.update.availableCommands ?? []).map((command: { name: string }) => command.name)
          commands.set(params.sessionId, new Set(names))
          for (const name of names) availableCommands.add(name)
        }
        const sessionID = view?.sessionID ?? stored?.[0]
        if (sessionID) trackWork(sessionID, params.update)
        if (view && !view.cancelled) view.update(params.update)
        if (stored) detachedUpdate(stored[0], params.update)
      }, () => {
        connection.abort()
        channel.connection = undefined
        for (const [sessionID, item] of threads) {
          if (item.connection.client === client) threads.delete(sessionID)
        }
      })
      channel.opening = client.request<{
        protocolVersion: number; agentCapabilities?: Capabilities; agentInfo?: { version?: string }
      }>("initialize", {
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
        clientInfo: { name: "opencode-antigravity-client", title: "OpenCode – Antigravity Client", version: "0.1.0" },
      }).then((result) => {
        if (closed || result.protocolVersion !== 1) throw new Error(disconnected)
        const [, major, minor] = /^(?:v|agy_acp_server_)?(\d+)\.(\d+)\./.exec(result.agentInfo?.version ?? "") ?? []
        const canSteer = Number(major) > 1 || (Number(major) === 1 && Number(minor) >= 5)
        channel.connection = { client, caps: result.agentCapabilities ?? {}, turns, commands, canSteer }
        return channel.connection
      }).catch((error) => {
        client.close()
        throw error
      }).finally(() => { channel.opening = undefined })
      return channel.opening
    }

    const scope = { providerID }
    const status = (error: unknown) =>
      error instanceof AcpError && error.code === -32000 ? new Error(disconnected) : error

    async function rememberThread(sessionID: string, item: Thread, forked: boolean) {
      await ctx.storage.set(`acp/${sessionID}`, {
        id: item.id, forkContext: forked, ...(item.lastMessage ? { lastMessage: item.lastMessage } : {}),
      })
      threads.set(sessionID, item)
    }

    async function thread(sessionID: string, before: History, forked: boolean, linked: Connection, clear: boolean) {
      const current = threads.get(sessionID)
      const stored = current ? undefined : await ctx.storage.get(`acp/${sessionID}`)
      const record = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : undefined
      const lastMessage = current?.lastMessage ?? text(record?.lastMessage)
      const lastIndex = lastMessage ? before.findIndex((message) => message.id === lastMessage) : -1
      const compacted = before[0]?.type === "compaction" && before[0].metadata?.["antigravity/lastMessage"] === lastMessage
      const newer = before.slice(lastIndex + 1)
      const switched = newer.some((message) => message.type === "assistant" && message.model.providerID !== providerID)
      const rebuild = clear || Boolean(lastMessage && lastIndex < 0 && !compacted) || switched
      if (current?.connection === linked && !rebuild) return { item: current, history: sidechatHistory(newer) }
      if (current) {
        // The approval flag belongs to the ACP process. Move the conversation when switching to or from Plan.
        if (!rebuild && (!current.connection.caps.sessionCapabilities?.close || !linked.caps.sessionCapabilities?.resume))
          throw new Error("This Antigravity version cannot switch permissions in an existing session. Start a new session.")
        if (current.connection.caps.sessionCapabilities?.close)
          await current.connection.client.request("session/close", { sessionId: current.id })
        threads.delete(sessionID)
      }
      // Forks linked by older versions started without their inherited context.
      const oldID = rebuild ? "" : current?.id ?? (
        forked && record?.forkContext !== true ? "" : text(record?.id ?? stored)
      )
      const input = { cwd, mcpServers: [] }
      const saved = oldID && linked.caps.sessionCapabilities?.resume
        ? await linked.client.request<Setup>("session/resume", { ...input, sessionId: oldID })
            .then((item) => ({ ...item, sessionId: item.sessionId ?? oldID }))
            .catch((error) => {
              if (!(error instanceof AcpError) || error.code !== -32002) throw error
              return undefined
            })
        : undefined
      const history = clear ? "" : saved ? sidechatHistory(newer) : conversationHistory(before, forked)
      const setup = saved ?? await linked.client.request<Setup>("session/new", input)
      if (!setup.sessionId) throw new Error("Antigravity did not return a conversation ID.")
      const item: Thread = { id: setup.sessionId, options: configs(setup), connection: linked, lastMessage: saved ? lastMessage : undefined }
      return { item, history, opened: true }
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
          if (required && find(item.options, name)?.currentValue !== value)
            throw new Error(`Antigravity did not apply ${name} ${value}.`)
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
          const parentID = request.headers?.["x-opencode-parent-session-id"]
          const settings = request.providerOptions?.[providerID]
          const key = text(settings?.ticket)
          const ticket = tickets.get(key)
          if (parentID && !allowSubagents)
            throw new Error(
              "Antigravity subagent delegation is disabled. Set the plugin's allowSubagents option to true to opt in.",
            )
          if (!sessionID || !ticket || ticket.sessionID !== sessionID || ticket.parentID !== parentID)
            throw new Error(parentID
              ? "Send a new task to this Antigravity subagent. Old prompts are not replayed."
              : "Send a new message with Enter in the native Antigravity TUI. Background prompts and replays are disabled.")
          tickets.delete(key)
          if (request.abortSignal?.aborted) throw request.abortSignal.reason
          if (active.has(sessionID)) throw new Error("Antigravity is already answering in this session.")
          const agent = request.headers?.["x-antigravity-agent"]
          const reset = new AbortController()
          let stop: (() => void) | undefined
          const stream = new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              const renderer = render(controller)
              const signal = request.abortSignal ? AbortSignal.any([reset.signal, request.abortSignal]) : reset.signal
              const view: View = { sessionID, agent, cancelled: false, update: renderer.update, signal }
              stop = () => { view.cancelled = true; reset.abort() }
              active.add(sessionID)
              void (async () => {
                const transferred = steers.get(ticket.messageID)
                steers.delete(ticket.messageID)
                transferred?.release()
                const linked = transferred?.item.connection ?? await connect(fullAccess && agent !== "plan")
                const session = await ctx.session.get({ sessionID })
                const messages = await ctx.session.context({ sessionID })
                const boundary = messages.findIndex((message) => message.id === ticket.messageID)
                const current = messages[boundary]
                if (current?.type !== "user") throw new Error("OpenCode could not locate the current prompt.")
                const earlier = messages.slice(0, boundary)
                // OpenCode can promote several steer messages at one boundary and dispatch only the latest.
                // Drain a steer already sent for an earlier message before reusing its ACP conversation.
                for (const [messageID, pending] of steers) {
                  if (pending.view.sessionID !== sessionID || !earlier.some((message) => message.id === messageID)) continue
                  steers.delete(messageID)
                  const cancelPending = () => pending.item.connection.client.notify("session/cancel", { sessionId: pending.item.id })
                  signal.addEventListener("abort", cancelPending, { once: true })
                  try {
                    if (signal.aborted) cancelPending()
                    const pendingOutcome = await pending.outcome
                    if (pendingOutcome.stopReason !== "cancelled") {
                      pending.item.lastMessage = messageID
                      await rememberThread(sessionID, pending.item, Boolean(session.fork))
                    }
                  } finally {
                    signal.removeEventListener("abort", cancelPending)
                    pending.release()
                    const turns = pending.item.connection.turns
                    if (turns.get(pending.item.id) === pending.view) turns.delete(pending.item.id)
                  }
                }
                const lastClear = earlier.findLastIndex((message) => message.type === "user" && message.text.trim() === clearCommand)
                const before = earlier.slice(Math.max(0, lastClear))
                const forked = Boolean(session.fork)
                const clear = ticket.text.trim() === clearCommand
                const { item, history, opened } = transferred
                  ? { item: transferred.item, history: "", opened: false }
                  : await thread(sessionID, before, forked, linked, clear)
                const { client, turns, caps } = linked
                if (turns.has(item.id) && turns.get(item.id) !== transferred?.view)
                  throw new Error("Antigravity is already answering in this session.")
                let remembered = !opened
                const cancel = () => client.notify("session/cancel", { sessionId: item.id })
                try {
                  signal.throwIfAborted()
                  if (!transferred) {
                    await select(client, item, "model", modelId)
                    const effort = text(settings?.effort)
                    if (effort) await select(client, item, "thought_level", effort)
                    // Preserve a real read-only agent mode.
                    await select(client, item, "mode", agent === "plan" ? "plan" : "default", agent === "plan")
                  }
                  signal.throwIfAborted()
                  turns.set(item.id, view)
                  signal.addEventListener("abort", cancel, { once: true })
                  controller.enqueue({ type: "stream-start", warnings: [] })
                  const latest = [...(current.skills ?? []).flatMap((skill) => skill.text ? [skill.text] : []), current.text].join("\n\n")
                  const promptText = history ? `${history}\n\nLatest user message:\n${latest}` : latest
                  const files = current.files ?? []
                  const directory = files.length && !clear
                    ? join(await (attachmentDirectory ??= mkdtemp(join(tmpdir(), "opencode-antigravity-"))), sessionID, ticket.messageID)
                    : undefined
                  const attachments = clear ? [] : await attachmentBlocks(files, caps.promptCapabilities, directory)
                  signal.throwIfAborted()
                  if (linked.canSteer && !clear) {
                    view.modelID = modelId
                    view.variant = session.model?.variant
                    view.steer = (messageID, prompt) => {
                      if (!view.steer || signal.aborted || turns.get(item.id) !== view) return
                      view.steer = undefined
                      const updates: unknown[] = []
                      const waiting: View = {
                        ...view, steer: undefined,
                        update: (update) => updates.push(update),
                      }
                      turns.set(item.id, waiting)
                      const outcome = client.request<Outcome>("session/prompt", {
                        sessionId: item.id, prompt: [{ type: "text", text: prompt }],
                      }, 0)
                      void outcome.catch(() => {})
                      const expire = setTimeout(() => {
                        steers.delete(messageID)
                        for (const [key, ticket] of tickets) if (ticket.messageID === messageID) tickets.delete(key)
                        if (turns.get(item.id) === waiting) {
                          turns.delete(item.id)
                          cancel()
                        }
                      }, 30_000)
                      expire.unref()
                      steers.set(messageID, { item, outcome, view: waiting, updates, release: () => clearTimeout(expire) })
                    }
                    running.set(sessionID, view)
                  }
                  if (transferred) for (const update of transferred.updates) view.update(update)
                  const outcome = transferred
                    ? await transferred.outcome
                    : clear
                      ? { stopReason: "end_turn", usage: undefined }
                      : await client.request<Outcome>("session/prompt", {
                        sessionId: item.id,
                        prompt: [...(promptText ? [{ type: "text", text: promptText }] : []), ...attachments],
                      }, 0)
                  if (clear) renderer.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Started a fresh Antigravity conversation." } })
                  // The next turn can resume normally only after ACP accepted the inherited context.
                  if (!signal.aborted && outcome.stopReason !== "cancelled") {
                    item.lastMessage = ticket.messageID
                    await rememberThread(sessionID, item, forked)
                    remembered = true
                  }
                  if (view.cancelled) return
                  renderer.end()
                  // This was a complete ACP turn. Do not let the host loop continue it or retry a tool.
                  const usage = outcome.usage
                  controller.enqueue({
                    type: "finish",
                    finishReason: { unified: "stop", raw: outcome.stopReason },
                    ...(renderer.contextUsage && {
                      providerMetadata: { [providerID]: { [contextUsageKey]: renderer.contextUsage } },
                    }),
                    usage: {
                      inputTokens: { total: usage?.inputTokens, noCache: undefined, cacheRead: usage?.cachedReadTokens, cacheWrite: usage?.cachedWriteTokens },
                      outputTokens: { total: usage?.outputTokens, text: undefined, reasoning: usage?.thoughtTokens },
                    },
                  })
                  controller.close()
                } finally {
                  signal.removeEventListener("abort", cancel)
                  if (running.get(sessionID) === view) running.delete(sessionID)
                  if (turns.get(item.id) === view) turns.delete(item.id)
                  if (!remembered && !turns.has(item.id) && caps.sessionCapabilities?.close)
                    await client.request("session/close", { sessionId: item.id }).catch(() => {})
                }
              })().catch((error) => {
                if (!view.cancelled) controller.error(status(error))
              }).finally(() => { active.delete(sessionID) })
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
    await ctx.command.transform((editor) => editor.add({
      name: clearCommand.slice(1),
      description: "Start a fresh Antigravity conversation in this OpenCode session",
      async execute({ sessionID, delivery }) {
        const session = await ctx.session.get({ sessionID })
        if (session.model?.providerID !== providerID) throw new Error("Select an Antigravity model first.")
        await ctx.session.prompt({ sessionID, text: clearCommand, delivery, metadata: { [interactive]: true } })
      },
    }))
    await ctx.session.hook("prompt", async (event) => {
      const direct = event.metadata?.[interactive] === true
      if (direct) delete event.metadata?.[interactive]
      if (!direct && !allowSubagents) return

      const session = allowSubagents
        ? await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
        : undefined
      const parentID = session?.parentID
      if (!direct && (!parentID || session?.model?.providerID !== providerID)) return

      const key = crypto.randomUUID()
      // Each admission authorizes one ACP prompt. Continuations and restart recovery cannot replay it.
      if (tickets.size >= 100) tickets.delete(tickets.keys().next().value!)
      tickets.set(key, { sessionID: event.sessionID, parentID, messageID: event.messageID, text: event.prompt.text })
      event.metadata = { ...event.metadata, [tokenKey]: key }
    })
    await ctx.session.hook("context", (event) => {
      event.tools = {}
      const message = event.messages.findLast((item) => item.role === "user")
      event.options.ticket = message?.metadata?.[tokenKey]
    }, scope)
    await ctx.session.hook("model.request", (event) => {
      event.headers["x-antigravity-agent"] = event.agent
    }, scope)
    await ctx.session.hook("compaction", async (event) => {
      const sessionID = event.sessionID
      const messages = await ctx.session.context({ sessionID })
      const fallback = conversationHistory(messages, false)
      let item = threads.get(sessionID)
      if (!item && availableCommands.has("compact")) {
        const linked = await connect(fullAccess && event.agent !== "plan")
        const session = await ctx.session.get({ sessionID })
        const restored = await thread(sessionID, messages, Boolean(session.fork), linked, false)
        if (!restored.history) {
          item = restored.item
          await rememberThread(sessionID, item, Boolean(session.fork))
        } else if (restored.opened && linked.caps.sessionCapabilities?.close) {
          await linked.client.request("session/close", { sessionId: restored.item.id }).catch(() => {})
        }
      }
      const metadata = item?.lastMessage ? { "antigravity/lastMessage": item.lastMessage } : undefined
      if (!item || !(item.connection.commands.get(item.id) ?? availableCommands).has("compact")) {
        event.result = { summary: fallback || "No earlier messages.", metadata }
        return
      }
      const { client, turns } = item.connection
      const operation = new AbortController()
      const signal = AbortSignal.any([operation.signal, lifetime.signal])
      let reply = ""
      let contextUsage: ContextUsage | undefined
      turns.set(item.id, {
        sessionID, agent: event.agent, signal, cancelled: false,
        update(value) {
          const update = value as { sessionUpdate?: string; content?: { type?: string; text?: string } }
          if (update.sessionUpdate === "usage_update") contextUsage = readContextUsage(update) ?? contextUsage
          if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text")
            reply += text(update.content.text)
        },
      })
      try {
        const outcome = await client.request<{ stopReason: string }>("session/prompt", {
          sessionId: item.id, prompt: [{ type: "text", text: "/compact" }],
        }, 120_000)
        if (outcome.stopReason === "cancelled") throw new Error("Antigravity compaction was cancelled.")
        event.result = {
          summary: [reply.trim(), fallback].filter(Boolean).join("\n\n") || "Antigravity compacted this conversation.",
          metadata,
          ...(contextUsage && { native: { [contextUsageKey]: contextUsage } }),
        }
      } finally {
        operation.abort()
        turns.delete(item.id)
      }
    }, scope)
    await ctx.session.hook("retry", (event) => { event.decision = { retry: false } }, scope)
    await ctx.permission.hook("evaluate", (event) => {
      // An approval requested by Antigravity is explicit, even when native Build usually allows this action.
      if (event.metadata?.provider === "Antigravity" && event.effect === "allow") event.effect = "ask"
    })

    const lifetime = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["form.replied", "form.cancelled"], signal: lifetime.signal,
      })) {
        const question = questions.get(event.data.id)
        if (question?.form.sessionID === event.data.sessionID)
          question.finish(event.type === "form.replied" ? event.data.answer : undefined)
      }
    })().catch(() => {})
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.deleted", "session.inbox.enqueued"], signal: lifetime.signal,
      })) {
        if (event.type === "session.inbox.enqueued") {
          const { sessionID, inboxID, item } = event.data
          if (item.type !== "user" || item.delivery !== "steer" || item.payload.files?.length || item.payload.skills?.length) continue
          const ticket = tickets.get(text(item.payload.metadata?.[tokenKey]))
          if (!ticket || ticket.sessionID !== sessionID || ticket.messageID !== inboxID || item.payload.text.trim().startsWith("/")) continue
          const view = running.get(sessionID)
          if (view?.steer) {
            const selected = await ctx.session.get({ sessionID }).catch(() => undefined)
            if (
              selected?.agent === view.agent && selected?.model?.providerID === providerID &&
              selected.model.id === view.modelID && selected.model.variant === view.variant
            )
              view.steer?.(inboxID, item.payload.text)
          }
          continue
        }
        const id = event.data.sessionID
        const current = threads.get(id)
        threads.delete(id)
        work.delete(id)
        clearTimeout(detached.get(id)?.timer)
        detached.delete(id)
        for (const question of questions.values()) if (question.form.sessionID === id) question.finish()
        if (current?.connection.caps.sessionCapabilities?.close)
          await current.connection.client.request("session/close", { sessionId: current.id }).catch(() => {})
        await ctx.storage.remove(`acp/${id}`)
        if (attachmentDirectory)
          await attachmentDirectory.then((path) => rm(join(path, id), { recursive: true, force: true })).catch(() => {})
      }
    })().catch(() => {})
    void (async () => {
      const cached = await ctx.storage.get(catalogKey)
      if (closed) return
      if (cached && typeof cached === "object" && !Array.isArray(cached) && Array.isArray(cached.models)) {
        state.models = cached.models.map((item) => Model.Info.make(item as Model.Info))
        await ctx.provider.reload()
      }
      const connection = await connect(false)
      const { client, caps } = connection
      let sessionId: string | undefined
      try {
        const setup = await client.request<Setup>("session/new", { cwd, mcpServers: [] })
        sessionId = setup.sessionId
        if (!sessionId) throw new Error("Antigravity did not return a conversation ID.")
        const catalog = { id: sessionId, options: configs(setup), connection }
        const model = find(catalog.options, "model")
        const initialEffort = find(catalog.options, "thought_level")?.currentValue
        const choices = options(model)
        const efforts = new Map<string, { current?: string; levels: Choice[] }>()
        let withoutEffort: string | undefined
        for (const choice of choices) {
          if (closed) return
          // Modern ACP reports thinking levels for the selected model only.
          if (model?.id !== "legacy-model") await select(client, catalog, "model", choice.value)
          const thought = find(catalog.options, "thought_level")
          const levels = options(thought)
          efforts.set(choice.value, { current: thought?.currentValue, levels })
          if (!levels.length) withoutEffort ??= choice.value
        }
        const models: Model.Info[] = []
        for (const choice of choices) {
          if (closed) return
          const { current, levels } = efforts.get(choice.value)!
          let defaultEffort = levels.some((level) => level.value === initialEffort) ? initialEffort : current
          if (levels.length && withoutEffort) {
            // agy carries a compatible level between models. A model without levels clears
            // that selection, so switching back reports the target model's native default.
            await select(client, catalog, "model", withoutEffort)
            await select(client, catalog, "model", choice.value)
            defaultEffort = find(catalog.options, "thought_level")?.currentValue
          }
          models.push({
            ...Model.Info.default(providerID, Model.ID.make(choice.value)),
            name: choice.name,
            limit: { context: 0, output: 0 },
            capabilities: {
              input: [
                "text",
                ...(caps.promptCapabilities?.image ? ["image" as const] : []),
                ...(caps.promptCapabilities?.audio ? ["audio" as const] : []),
                ...(caps.promptCapabilities?.embeddedContext ? ["pdf" as const] : []),
                "video",
              ],
              output: ["text"], tools: false,
            },
            cost: [],
            ...(defaultEffort ? { settings: { effort: defaultEffort } } : {}),
            variants: levels.map((level) => ({ id: Model.VariantID.make(level.value), settings: { effort: level.value } })),
          })
        }
        if (!closed && models.length) {
          state.models = models
          await ctx.storage.set(catalogKey, { models: models as never })
          await ctx.provider.reload()
        }
      } finally {
        if (sessionId && caps.sessionCapabilities?.close)
          await client.request("session/close", { sessionId }).catch(() => {})
        if (!active.size && !threads.size) client.close()
      }
    })().catch((error) => { if (!closed) console.warn("Antigravity ACP: could not load models", status(error)) })

    return async () => {
      closed = true
      lifetime.abort()
      for (const channel of Object.values(channels)) channel.connection?.client.close()
      for (const client of readClients) client.close()
      for (const question of questions.values()) question.finish()
      for (const entry of detached.values()) clearTimeout(entry.timer)
      for (const entry of steers.values()) entry.release()
      tickets.clear()
      threads.clear()
      await attachmentDirectory?.then((path) => rm(path, { recursive: true, force: true })).catch(() => {})
    }
  },
})

type ToolCall = { id: string; name: string; input: unknown; done: boolean }
function render(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) {
  const calls = new Map<string, ToolCall>()
  let contextUsage: ContextUsage | undefined
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
    get contextUsage() { return contextUsage },
    update(raw: unknown) {
      if (!raw || typeof raw !== "object") return
      const update = raw as {
        sessionUpdate?: string; content?: { type?: string; text?: string }; toolCallId?: string
        name?: string; title?: string; rawInput?: unknown; status?: string
      }
      const type = update.sessionUpdate
      if (type === "usage_update") {
        contextUsage = readContextUsage(raw) ?? contextUsage
        return
      }
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
