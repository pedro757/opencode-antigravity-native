#!/usr/bin/env node
import { createInterface } from "node:readline"

const fullAccess = process.argv.includes("--dangerously-skip-permissions")
const exerciseFeatures = process.env.AGY_MOCK_FEATURES === "1"
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
const configOptions = [
  { id: "model", category: "model", type: "select", currentValue: "gemini-test", options: [
    { value: "gemini-test", name: "Gemini test" },
    { value: "gemini-other", name: "Gemini other" },
    { value: "third-party", name: "Third-party model" },
    { value: "fixed-effort", name: "Fixed effort model" },
  ] },
  { id: "thought_level", category: "thought_level", type: "select", currentValue: "low", options: [
    { value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "xhigh", name: "Extra High" },
  ] },
  { id: "mode", category: "mode", type: "select", currentValue: "default", options: [
    { value: "default", name: "Default" }, { value: "plan", name: "Plan" },
  ] },
]
let approvalFor
let slow
let questionFor
let firstFeatureSession
let freshFeatureSession
let rewindFeatureSession
const sessionId = fullAccess ? "unrestricted-test" : "test"
let currentSession = sessionId
let sessionCount = 0
let forkSource
const forkSessions = new Set()
const variantSessions = new Map()
const update = (update) => send({ method: "session/update", params: { sessionId: currentSession, update } })
const chunk = (sessionUpdate, text) => update({ sessionUpdate, content: { type: "text", text } })
const result = (id, value) => send({ id, result: value })
const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  const { id, method, params, result: reply } = JSON.parse(line)
  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: 1,
        ...(exerciseFeatures ? { agentInfo: { name: "Mock Antigravity", version: "1.5.18" } } : {}),
        agentCapabilities: {
          loadSession: true, promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { list: {}, close: {}, resume: {} },
        },
      })
    case "session/new":
    case "session/load":
    case "session/resume":
      if ("systemPrompt" in params || params.mcpServers.length) throw Error("Expected a thin client")
      currentSession = params.sessionId ?? (sessionCount++ === 0 ? sessionId : `${sessionId}-${sessionCount}`)
      configOptions[0].currentValue = "gemini-test"
      configOptions[1].currentValue = "low"
      configOptions[1].options = [{ value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "xhigh", name: "Extra High" }]
      if (method === "session/load") {
        chunk("user_message_chunk", "Old question")
        chunk("agent_message_chunk", exerciseFeatures && params.sessionId === "mock-child-session"
          ? "Read-only child transcript" : "Old answer")
      }
      if (exerciseFeatures) update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] })
      return result(id, { sessionId: currentSession, configOptions })
    case "session/list":
      return result(id, { sessions: [{ sessionId: "old", title: "Old chat" }] })
    case "session/close":
      return result(id, {})
    case "session/set_config_option":
      configOptions.find((option) => option.id === params.configId).currentValue = params.value
      if (params.configId === "model") {
        const levels = {
          "gemini-test": ["low", "high", "xhigh"],
          "gemini-other": ["medium", "high"],
          "third-party": ["extra"],
          "fixed-effort": [],
        }[params.value]
        const thought = configOptions[1]
        if (!levels.includes(thought.currentValue)) thought.currentValue = levels[0] ?? ""
        thought.options = levels.map((value) => ({ value, name: value }))
      }
      return result(id, { configOptions })
    case "session/prompt": {
      currentSession = params.sessionId
      const text = params.prompt[0]?.text
      if (text?.startsWith("Check variant ")) {
        const variant = configOptions[1].currentValue || "fixed"
        const previous = variantSessions.get(currentSession) ?? 0
        variantSessions.set(currentSession, previous + 1)
        chunk("agent_message_chunk", `ACP variant: ${configOptions[0].currentValue}/${variant} (turn ${previous + 1})`)
        return result(id, { stopReason: "end_turn" })
      }
      if (text?.includes("Check the child wiring")) {
        const expected = text.includes("at low") ? "low" : "high"
        if (configOptions[1].currentValue !== expected)
          throw Error(`The delegated model must use the ${expected} variant`)
      }
      if (exerciseFeatures) {
        if (text?.startsWith("Check attachment")) {
          const resource = params.prompt[1]?.resource
          if (resource?.text !== "Fixture attachment contents\n") throw Error("Attachment was not forwarded")
          chunk("agent_message_chunk", "Attachment reached Antigravity")
          return result(id, { stopReason: "end_turn" })
        }
        if (text === "Ask mock") {
          questionFor = id
          firstFeatureSession = currentSession
          send({ id: "question", method: "elicitation/create", params: {
            sessionId: currentSession, mode: "form", message: "The agent has a question.",
            requestedSchema: { type: "object", properties: {
              q0: { type: "string", title: "Choose the package manager", oneOf: [{ const: "pnpm", title: "pnpm" }] },
              q0_other: { type: "string", title: "Other (optional)" },
            } },
          } })
          return
        }
        if (text === "Ask mock choice" || text === "Dismiss mock choice") {
          const dismiss = text.startsWith("Dismiss")
          send({ id: `${dismiss ? "dismiss" : "pick"}-${id}`, method: "session/request_permission", params: {
            sessionId: currentSession,
            toolCall: { toolCallId: `interaction_${id}`, title: "Choose the test runner" },
            options: [{ optionId: "runner-1", name: "Bun" }],
          } })
          return
        }
        if (text === "Begin steer") {
          slow = id
          chunk("agent_message_chunk", "Steering is ready")
          return
        }
        if (text === "Begin queue") {
          chunk("agent_message_chunk", "Queue is ready")
          setTimeout(() => result(id, { stopReason: "end_turn" }), 1500)
          return
        }
        if (text === "Use native steer") {
          if (!slow) throw Error("A steer must reach ACP before the original prompt returns")
          result(slow, { stopReason: "end_turn" })
          slow = undefined
          chunk("agent_message_chunk", "Native steer reached Antigravity")
          return result(id, { stopReason: "end_turn" })
        }
        if (text === "/compact") {
          chunk("agent_message_chunk", `Native compaction ran at ${configOptions[1].currentValue}`)
          update({ sessionUpdate: "usage_update", used: 1200, size: 10000 })
          return result(id, { stopReason: "end_turn" })
        }
        if (text === "After clear") {
          if (currentSession === firstFeatureSession) throw Error("Clear must open a new native session")
          freshFeatureSession = currentSession
          chunk("agent_message_chunk", "A fresh Antigravity session answered")
          return result(id, { stopReason: "end_turn" })
        }
        if (text?.endsWith("Check side-chat result")) {
          if (!text.includes("Side chat found the missing fixture.") || text.includes("A fresh Antigravity session answered"))
            throw Error("Expected only the side-chat addition")
          chunk("agent_message_chunk", "Antigravity received the side-chat result")
          return result(id, { stopReason: "end_turn" })
        }
        if (text?.endsWith("Check switched history")) {
          if (currentSession === freshFeatureSession || !text.includes("Other provider answered"))
            throw Error("Provider switch must rebuild with the intervening history")
          chunk("agent_message_chunk", "Antigravity received the intervening history")
          return result(id, { stopReason: "end_turn" })
        }
        if (text === "Launch mock background") {
          const child = { toolCallId: "native-child", title: "Run invoke_subagent" }
          const owner = currentSession
          update({ ...child, sessionUpdate: "tool_call", status: "in_progress", rawInput: { Prompt: "Check the fixture" } })
          chunk("agent_message_chunk", "Native child was launched")
          result(id, { stopReason: "end_turn" })
          setTimeout(() => {
            currentSession = owner
            update({ ...child, sessionUpdate: "tool_call_update", status: "completed",
              rawOutput: { conversation_id: "mock-child-session" },
            })
            update({ ...child, sessionUpdate: "tool_call", toolCallId: "unlinked-child",
              title: "Run launch_subagent without session ID", status: "completed",
            })
            chunk("agent_message_chunk", "Mock detached result")
          }, 300)
          return
        }
        if (text === "Deliver queued turn" || text === "Keep this decision")
          update({ sessionUpdate: "usage_update", used: 3300, size: 10000 })
        if (text === "Remove this decision") {
          rewindFeatureSession = currentSession
          update({ sessionUpdate: "usage_update", used: 7200, size: 20000 })
          update({ sessionUpdate: "usage_update", used: 7200, size: 0 })
        }
        if (text?.endsWith("Check the rewind")) {
          if (currentSession === rewindFeatureSession || !text.includes("Keep this decision") || text.includes("Remove this decision"))
            throw Error("Expected the rewound transcript without the removed turn")
          chunk("agent_message_chunk", "Antigravity resumed with the rewound history")
          return result(id, { stopReason: "end_turn" })
        }
      }
      if (params.prompt.length !== 1 || params.prompt[0].type !== "text") throw Error("Expected a text prompt")
      if (process.env.AGY_MOCK_FORK) {
        if (text === "Fork source first") forkSource = currentSession
        if (text.endsWith("Fork first message")) {
          if (currentSession === forkSource || !text.endsWith("\n\nLatest user message:\nFork first message"))
            throw Error("Expected a new Antigravity session with a fork transcript")
          const history = JSON.parse(text.split("\n\n")[1])
          const expected = [{ role: "user", text: "Fork source first" }, { role: "assistant", text: "Mock reply: Fork source first" }]
          if (!text.includes("1 history entries omitted") || JSON.stringify(history) !== JSON.stringify(expected))
            throw Error("Incorrect or oversized fork history")
          forkSessions.add(currentSession)
          chunk("agent_message_chunk", "Fork received the earlier turn")
          return result(id, { stopReason: "end_turn" })
        }
        if (text === "Fork second message") {
          if (!forkSessions.has(currentSession)) throw Error("Expected the same seeded fork")
          chunk("agent_message_chunk", "Fork continued without resending history")
          return result(id, { stopReason: "end_turn" })
        }
      }
      if (text === "Check model") {
        if (configOptions[0].currentValue !== "third-party" || configOptions[1].currentValue !== "extra")
          throw Error("Expected the extra variant of the third-party model")
        chunk("agent_message_chunk", "Third-party model selected")
        return result(id, { stopReason: "end_turn" })
      }
      if (text === "Check plan") {
        if (fullAccess || configOptions.find((option) => option.id === "mode").currentValue !== "plan")
          throw Error("Expected a sandboxed Plan session")
        if (currentSession !== "unrestricted-test") throw Error("Expected Plan to resume the same conversation")
        chunk("agent_message_chunk", "Plan resumed in sandbox")
        return result(id, { stopReason: "end_turn" })
      }
      if (text === "Approve mock") {
        if (fullAccess) {
          chunk("agent_message_chunk", "Mock edit approved without prompting")
          return result(id, { stopReason: "end_turn" })
        }
        approvalFor = id
        send({ id: "permission", method: "session/request_permission", params: {
          sessionId: currentSession, toolCall: { title: "Mock edit", content: [{ type: "diff", path: "mock.txt", oldText: "old", newText: "new" }] },
          options: [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }],
        } })
        return
      }
      if (text === "Stop mock") {
        slow = id
        return
      }
      chunk("agent_message_chunk", "Mock reply: ")
      chunk("agent_message_chunk", text)
      if (process.env.AGY_MOCK_FORK && text === "Fork source first") {
        update({ sessionUpdate: "tool_call", toolCallId: "large-log", title: "Large log", status: "completed",
          content: [{ type: "content", content: { type: "text", text: "log ".repeat(16000) } }],
        })
      }
      return result(id, { stopReason: "end_turn" })
    }
    case "session/cancel":
      if (slow) result(slow, { stopReason: "cancelled" })
      return
    default:
      if (id === "question") {
        if (reply.action !== "accept" || reply.content?.q0 !== "pnpm" || "q0_other" in reply.content)
          throw Error("Question did not receive the selected answer or included the skipped field")
        update({ sessionUpdate: "tool_call", toolCallId: "steps-1", title: "Run update_steps", status: "completed",
          rawInput: { steps: [{ title: "Build hello", status: "done" }] },
        })
        chunk("agent_message_chunk", "Question was answered")
        return result(questionFor, { stopReason: "end_turn" })
      }
      if (typeof id === "string" && /^(pick|dismiss)-/.test(id)) {
        const [action, turn] = id.split("-")
        if (action === "pick" && (reply.outcome.outcome !== "selected" || reply.outcome.optionId !== "runner-1"))
          throw Error("The question did not receive the ACP option ID")
        if (action === "dismiss" && reply.outcome.outcome !== "cancelled")
          throw Error("Dismissing the question did not cancel the ACP request")
        chunk("agent_message_chunk", action === "pick" ? "Bun was selected" : "Choice was dismissed")
        return result(Number(turn), { stopReason: "end_turn" })
      }
      if (id === "permission") {
        chunk("agent_message_chunk", reply.outcome.optionId === "yes" ? "Mock edit approved" : "Mock edit denied")
        return result(approvalFor, { stopReason: "end_turn" })
      }
      throw Error(`Unexpected request: ${method}`)
  }
})
