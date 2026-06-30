import { CLOUD_API_URL } from '../config.js'
import { apiFetch } from '../http.js'

interface ContextMessage {
  role: string
  content: string
  timestamp: number
}

interface ContextResponse {
  messages: ContextMessage[]
}

const NOT_CONTEXT_SENTINEL = '__NOT_CONTEXT__'

/**
 * Answers a question about conversation history using Claude Haiku via OpenRouter.
 *
 * Returns:
 *   string  — the answer, or "no history found" message
 *   null    — the question turned out not to be about history; caller should
 *             forward to Sai instead
 */
export async function queryContext(
  authToken: string,
  machineId: string,
  question: string,
): Promise<string | null> {
  // 1. Fetch recent conversation history
  const contextRes = await apiFetch(
    `${CLOUD_API_URL}/v1/agents/context?machineId=${encodeURIComponent(machineId)}&limit=30`,
    { headers: { Authorization: `Bearer ${authToken}` } },
  )

  if (!contextRes.ok) {
    const body = (await contextRes.json().catch(() => ({}))) as { error?: string }
    throw new Error(
      `Failed to fetch context (${contextRes.status}): ${body.error ?? contextRes.statusText}`,
    )
  }

  const { messages } = (await contextRes.json()) as ContextResponse

  if (messages.length === 0) {
    return null // no history — forward to Sai
  }

  // 2. Build conversation history for the LLM
  const historyText = messages
    .map((m) => {
      const speaker = m.role === 'assistant' ? 'Sai' : 'User'
      const time = new Date(m.timestamp).toLocaleString()
      return `[${time}] ${speaker}: ${m.content}`
    })
    .join('\n\n')

  const systemPrompt = `You are Sai, an AI agent. Answer the user's question about your recent conversation history speaking in first person — "I did X", "you asked me to Y". Be warm, direct, and brief.

IMPORTANT: Respond with exactly the text "${NOT_CONTEXT_SENTINEL}" (nothing else) in two cases:
1. The question is NOT about conversation history — it asks you to do something new, answer a general knowledge question, or act on current information.
2. The answer cannot be found in the history provided below.

Do NOT say "I couldn't find" or "I don't have information about" — use the sentinel instead and the question will be forwarded to Sai directly.

CONVERSATION HISTORY:
${historyText}`

  // 3. Ask Claude Haiku via the cloud-api OpenRouter proxy (OpenAI-compatible format)
  const llmRes = await apiFetch(`${CLOUD_API_URL}/v1/openrouter/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!llmRes.ok) {
    const body = (await llmRes.json().catch(() => ({}))) as {
      error?: string | { message?: string }
    }
    const detail =
      typeof body.error === 'string'
        ? body.error
        : ((body.error as { message?: string })?.message ?? llmRes.statusText)
    throw new Error(`Context query failed (${llmRes.status}): ${detail}`)
  }

  const data = (await llmRes.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const text = data.choices?.[0]?.message?.content?.trim() ?? ''

  if (!text || text === NOT_CONTEXT_SENTINEL) return null

  return text
}
