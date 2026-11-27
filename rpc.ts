import { Rpc } from "@opencode/plugin/rpc"

const session = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
} as const
const result = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } as const

export const Antigravity = Rpc.define({
  id: "antigravity-native",
  methods: {
    status: { input: session, output: { type: "object", additionalProperties: true } },
    questions: { input: { type: "object" }, output: { type: "object", additionalProperties: true } },
    stop: { input: session, output: result },
    child: {
      input: {
        type: "object",
        properties: { ...session.properties, id: { type: "string" } },
        required: ["sessionID", "id"],
      },
      output: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
  events: { question: { schema: session }, background: { schema: session } },
})

export type Work = { title: string; status: string; updates?: string[]; child?: string }
