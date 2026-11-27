import type { Answers, Field, Option, Question } from "./rpc"

export function elicitation(params: {
  mode?: string
  message?: string
  requestedSchema?: { properties?: Record<string, unknown>; required?: string[] }
}): Omit<Question, "id"> | undefined {
  if (params.mode !== "form" || !params.requestedSchema?.properties) return
  const fields: Field[] = []
  for (const [id, input] of Object.entries(params.requestedSchema.properties)) {
    if (!input || typeof input !== "object" || !("type" in input)) return
    const field = input as {
      type: Field["type"]; title?: string; description?: string; oneOf?: unknown[]; enum?: Option["value"][]
    }
    if (!["string", "integer", "number", "boolean"].includes(field.type)) return
    let choices: Option[] | undefined
    if (Array.isArray(field.oneOf)) {
      choices = field.oneOf.flatMap((option) =>
        option && typeof option === "object" && "const" in option && typeof option.const === "string"
          ? [{ value: option.const, title: typeof option.title === "string" ? option.title : option.const }]
          : [],
      )
    } else if (Array.isArray(field.enum)) {
      choices = field.enum.flatMap((value) =>
        ["string", "number", "boolean"].includes(typeof value) ? [{ value, title: String(value) }] : [],
      )
    } else if (field.type === "boolean") {
      choices = [{ title: "Yes", value: true }, { title: "No", value: false }]
    }
    if (choices?.length === 0) return
    fields.push({
      id, type: field.type, title: field.description || field.title || id,
      choices, required: params.requestedSchema.required?.includes(id),
    })
  }
  if (fields.length) return { title: params.message || "Antigravity question", fields }
}

export function validAnswers(question: Question, values: Answers) {
  return question.fields.every((field) => {
    if (!Object.hasOwn(values, field.id)) return !field.required
    const value = values[field.id]
    if (field.choices) return field.choices.some((option) => option.value === value)
    if (field.type === "integer") return Number.isInteger(value)
    return typeof value === field.type
  })
}
