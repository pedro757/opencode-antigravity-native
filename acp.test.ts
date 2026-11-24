import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { Acp } from "./acp"

function mock() {
  const child = spawn("node", [fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url))], { stdio: "pipe" })
  const methods: string[] = []
  const chunks: string[] = []
  const acp = new Acp(child, (method, params) => {
    methods.push(method)
    if (method === "session/request_permission") return { outcome: { outcome: "selected", optionId: "no" } }
    const text = params.update?.content?.text
    if (typeof text === "string") chunks.push(text)
  }, () => {})
  const prompt = (text: string) => acp.request("session/prompt", {
    sessionId: "test",
    prompt: [{ type: "text", text }],
  }, 3000)
  return { acp, child, chunks, methods, prompt }
}

test("streams a direct user prompt and returns a scoped permission decision", async () => {
  const { acp, chunks, methods, prompt } = mock()
  try {
    expect(await acp.request("initialize", { protocolVersion: 1 })).toMatchObject({ protocolVersion: 1 })
    expect(await acp.request("session/new", { cwd: "/tmp", mcpServers: [] })).toMatchObject({ sessionId: "test" })
    await prompt("Hello")
    expect(chunks.join("")).toBe("Mock reply: Hello")
    await prompt("Approve mock")
    expect(methods).toContain("session/request_permission")
    expect(chunks.at(-1)).toBe("Mock edit denied")
  } finally {
    acp.close()
  }
})

test("cancels a pending turn without starting another prompt", async () => {
  const { acp, prompt } = mock()
  try {
    const pending = prompt("Stop mock")
    acp.notify("session/cancel", { sessionId: "test" })
    expect(await pending).toEqual({ stopReason: "cancelled" })
  } finally {
    acp.close()
  }
})

test("rejects pending requests on child exit", async () => {
  const { acp, child, prompt } = mock()
  try {
    const pending = prompt("Stop mock")
    child.kill()
    await expect(pending).rejects.toThrow(/exited|EPIPE/)
  } finally {
    acp.close()
  }
})
