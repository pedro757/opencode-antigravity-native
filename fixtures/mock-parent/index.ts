import { Model, Plugin, Provider } from "@opencode/plugin"

const providerID = Provider.ID.make("mock-parent")
const modelID = Model.ID.make("test")
const packageName = "@local/mock-parent"
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

export default Plugin.define({
  id: "test.antigravity-mock-parent",
  async setup(ctx) {
    await ctx.provider.transform((editor) => editor.add({
      info: { ...Provider.Info.empty(providerID), activation: "enabled", package: `aisdk:${packageName}` },
      models: [{
        ...Model.Info.default(providerID, modelID),
        name: "Mock parent model",
        capabilities: { input: ["text"], output: ["text"], tools: true },
      }],
    }))
    await ctx.session.hook("title", (event) => { event.result = "Mock parent" }, { providerID })
    await ctx.aisdk.hook("sdk", (event) => {
      if (event.package !== packageName) return
      event.sdk = {
        languageModel: () => ({
          specificationVersion: "v3",
          provider: providerID,
          modelId: modelID,
          supportedUrls: {},
          async doStream(options: { prompt: unknown }) {
            const history = JSON.stringify(options.prompt)
            const completed = history.includes("Mock reply: ") && history.includes("Check the child wiring")
            const blocked = history.includes("Antigravity subagent delegation is disabled")
            const started = history.includes("Check the child wiring")
            return {
              stream: new ReadableStream({
                start(controller) {
                  if (!started) {
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: "mock-delegation",
                      toolName: "subagent",
                      input: JSON.stringify({
                        agent: "antigravity",
                        description: "Check child wiring",
                        prompt: "Check the child wiring",
                      }),
                    })
                  } else {
                    const delta = completed ? "Parent received Antigravity reply" :
                      blocked ? "Parent received delegation error" : "Parent is ready for the child report"
                    controller.enqueue({ type: "text-start", id: "parent" })
                    controller.enqueue({ type: "text-delta", id: "parent", delta })
                    controller.enqueue({ type: "text-end", id: "parent" })
                  }
                  controller.enqueue({ type: "finish", finishReason: { unified: started ? "stop" : "tool-calls" }, usage })
                  controller.close()
                },
              }),
            }
          },
        }),
      }
    }, { providerID })
  },
})
