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
    if (process.env.AGY_MOCK_FEATURES) {
      await ctx.command.transform((editor) => editor.add({
        name: "mock-bring-back",
        description: "Write a test side-chat result",
        execute: async ({ sessionID }) => {
          await ctx.session.synthetic({
            sessionID, text: "Side chat found the missing fixture.",
            description: "Mock side-chat result", metadata: { source: "sidechat" }, resume: false,
          })
        },
      }))
    }
    await ctx.provider.transform((editor) => editor.add({
      info: { ...Provider.Info.empty(providerID), activation: "enabled", package: `aisdk:${packageName}` },
      models: [{
        ...Model.Info.default(providerID, modelID),
        name: "Mock parent model",
        capabilities: { input: ["text"], output: ["text"], tools: true },
      }],
    }))
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
            const titleRequest = history.includes("Reply with only the title.")
            const title = history.includes("Ask mock")
              ? history.includes("Here is the conversation so far:")
                ? "Package manager selection discussed"
                : "Choose a package manager"
              : "Check child wiring"
            const useOtherProvider = history.includes("Ask the other provider")
            const lowVariant = history.includes("Delegate to Antigravity with low")
            const completed = history.includes("Mock reply: ") && history.includes("Check the child wiring")
            const blocked = history.includes("Antigravity subagent delegation is disabled")
            const started = history.includes("Check the child wiring")
            return {
              stream: new ReadableStream({
                start(controller) {
                  if (!titleRequest && !started && !useOtherProvider) {
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: "mock-delegation",
                      toolName: "subagent",
                      input: JSON.stringify({
                        agent: "antigravity",
                        description: "Check child wiring",
                         prompt: lowVariant ? "Check the child wiring at low" : "Check the child wiring",
                         ...(lowVariant ? { model: "antigravity-acp/gemini-test#low" } : {}),
                      }),
                    })
                  } else {
                    const delta = titleRequest ? title : useOtherProvider ? "Other provider answered" : completed ? "Parent received Antigravity reply" :
                      blocked ? "Parent received delegation error" : "Parent is ready for the child report"
                    controller.enqueue({ type: "text-start", id: "parent" })
                    controller.enqueue({ type: "text-delta", id: "parent", delta })
                    controller.enqueue({ type: "text-end", id: "parent" })
                  }
                  controller.enqueue({ type: "finish", finishReason: { unified: titleRequest || started || useOtherProvider ? "stop" : "tool-calls" }, usage })
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
