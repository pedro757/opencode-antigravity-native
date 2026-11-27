import type { Plugin } from "@opencode/plugin/tui"

type Value = string | number | boolean
type Option = { value: Value; title: string; description?: string }
type Field = {
  id: string
  title: string
  description?: string
  type: "string" | "number" | "integer" | "boolean"
  required: boolean
  choices?: Option[]
}
export type Question = { title: string; fields: [Field, ...Field[]] }
export type Answers = Record<string, Value>

type FormInput = Parameters<Plugin.Context["client"]["session"]["form"]["create"]>[0]
export type NativeQuestion = Omit<FormInput, "id"> & { id: string }
export const questionSource = "antigravity-acp"

function matches(type: Field["type"], value: unknown): value is Value {
  if (type === "integer") return Number.isInteger(value)
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  return typeof value === type
}

export function elicitation(params: {
  mode?: string
  message?: string
  requestedSchema?: { properties?: Record<string, unknown>; required?: string[] }
}): Question | undefined {
  if (params.mode !== "form" || !params.requestedSchema?.properties) return
  const fields: Field[] = []
  for (const [id, input] of Object.entries(params.requestedSchema.properties)) {
    if (!input || typeof input !== "object" || !("type" in input)) return
    const field = input as {
      type: Field["type"]; title?: string; description?: string; oneOf?: unknown[]; enum?: unknown[]
    }
    if (!["string", "integer", "number", "boolean"].includes(field.type)) return
    let choices: Option[] | undefined
    if (Array.isArray(field.oneOf)) {
      choices = field.oneOf.flatMap((option) => {
        if (!option || typeof option !== "object" || !("const" in option) || !matches(field.type, option.const)) return []
        return [{
          value: option.const,
          title: typeof option.title === "string" ? option.title : String(option.const),
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        }]
      })
    } else if (Array.isArray(field.enum)) {
      choices = field.enum.flatMap((value) =>
        matches(field.type, value) ? [{ value, title: String(value) }] : [],
      )
    }
    if (choices?.length === 0) return
    fields.push({
      id, type: field.type, title: field.title || field.description || id,
      description: field.title ? field.description : undefined,
      choices,
      required: params.requestedSchema.required?.includes(id) ?? false,
    })
  }
  const [first, ...rest] = fields
  if (first) return { title: params.message || "Antigravity question", fields: [first, ...rest] }
}

function nativeField(field: Field): FormInput["fields"][number] {
  const base = {
    key: field.id, title: field.title, required: field.required,
    ...(field.description ? { description: field.description } : {}),
  }
  if (!field.choices) return { ...base, type: field.type }
  return {
    ...base, type: "string",
    options: field.choices.map((option, index) => ({
      value: String(index), label: option.title,
      ...(option.description ? { description: option.description } : {}),
    })),
  }
}

export function nativeQuestion(sessionID: string, question: Question): NativeQuestion {
  const [first, ...rest] = question.fields
  return {
    id: `frm_${crypto.randomUUID()}`,
    sessionID,
    title: "Questions",
    metadata: { kind: "question", source: questionSource, message: question.title },
    fields: [nativeField(first), ...rest.map(nativeField)],
  }
}

export function readAnswers(question: Question, values: Readonly<Record<string, unknown>>): Answers | undefined {
  const answers: Array<[string, Value]> = []
  for (const field of question.fields) {
    if (!Object.hasOwn(values, field.id)) {
      if (field.required) return
      continue
    }
    const raw = values[field.id]
    // OpenCode represents choice values as strings. Restore the ACP option's original value.
    const value = field.choices ? field.choices.find((_, index) => String(index) === raw)?.value : raw
    if (!matches(field.type, value)) return
    answers.push([field.id, value])
  }
  return Object.fromEntries(answers)
}
