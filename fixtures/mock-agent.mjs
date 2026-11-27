#!/usr/bin/env node
import { createInterface } from "node:readline"

const fullAccess = process.argv.includes("--dangerously-skip-permissions")
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
const configOptions = [
  { id: "model", category: "model", type: "select", currentValue: "gemini-test", options: [
    { value: "gemini-test", name: "Gemini test" },
    { value: "gemini-other", name: "Gemini other" },
    { value: "third-party", name: "Third-party model" },
  ] },
  { id: "thought_level", category: "thought_level", type: "select", currentValue: "low", options: [
    { value: "low", name: "Low" }, { value: "high", name: "High" },
  ] },
  { id: "mode", category: "mode", type: "select", currentValue: "default", options: [
    { value: "default", name: "Default" }, { value: "plan", name: "Plan" },
  ] },
]
let approvalFor
let slow
const sessionId = fullAccess ? "unrestricted-test" : "test"
let currentSession = sessionId
const update = (update) => send({ method: "session/update", params: { sessionId: currentSession, update } })
const chunk = (sessionUpdate, text) => update({ sessionUpdate, content: { type: "text", text } })
const result = (id, value) => send({ id, result: value })
const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  const { id, method, params, result: reply } = JSON.parse(line)
  switch (method) {
    case "initialize":
      return result(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {}, resume: {} } } })
    case "session/new":
    case "session/load":
    case "session/resume":
      if ("systemPrompt" in params || params.mcpServers.length) throw Error("Expected a thin client")
      currentSession = params.sessionId ?? sessionId
      configOptions[0].currentValue = "gemini-test"
      configOptions[1].currentValue = "low"
      configOptions[1].options = [{ value: "low", name: "Low" }, { value: "high", name: "High" }]
      if (method === "session/load") {
        chunk("user_message_chunk", "Old question")
        chunk("agent_message_chunk", "Old answer")
      }
      return result(id, { sessionId: currentSession, configOptions })
    case "session/list":
      return result(id, { sessions: [{ sessionId: "old", title: "Old chat" }] })
    case "session/close":
      return result(id, {})
    case "session/set_config_option":
      configOptions.find((option) => option.id === params.configId).currentValue = params.value
      if (params.configId === "model") {
        const levels = params.value === "third-party"
          ? [{ value: "extra", name: "Extra" }]
          : [{ value: "low", name: "Low" }, { value: "high", name: "High" }]
        configOptions[1].currentValue = levels[0].value
        configOptions[1].options = levels
      }
      return result(id, { configOptions })
    case "session/prompt": {
      if (params.prompt.length !== 1 || params.prompt[0].type !== "text") throw Error("Expected a raw user prompt")
      const text = params.prompt[0].text
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
      return result(id, { stopReason: "end_turn" })
    }
    case "session/cancel":
      if (slow) result(slow, { stopReason: "cancelled" })
      return
    default:
      if (id === "permission") {
        chunk("agent_message_chunk", reply.outcome.optionId === "yes" ? "Mock edit approved" : "Mock edit denied")
        return result(approvalFor, { stopReason: "end_turn" })
      }
      throw Error(`Unexpected request: ${method}`)
  }
})
