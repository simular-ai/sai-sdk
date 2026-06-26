/**
 * Concierge: classifies a user message as a task for Sai or a context/history lookup.
 *
 * Uses heuristic pattern matching (no network call) to avoid adding latency to
 * every message. The patterns target the distinguishing surface forms of history
 * questions, which are structurally different from action/task requests.
 *
 * False-positive cost is low: a misclassified context question just goes to Sai,
 * which can still answer it. Defaults to 'task' on ambiguous input.
 */

export type MessageClass = 'task' | 'context'

// Continuation/action phrases that are always tasks even if they reference the past.
// Checked before CONTEXT_PATTERNS so they take priority.
const TASK_OVERRIDE_PATTERNS: RegExp[] = [
  // "go back to", "continue", "resume", "pick up", "carry on", "keep going" — all mean "do this"
  /\bgo back to\b/i,
  /\bcontinue (the |with |where |that |this )/i,
  /\bresume (the |this |that |where )/i,
  /\bpick up (where|the|this|that)\b/i,
  /\bcarry on\b/i,
  /\bkeep going\b/i,
  // "go ahead and", "now do", "next do" — clear task initiators
  /\bgo ahead (and|with)\b/i,
]

// Patterns that strongly indicate "tell me about a past interaction"
const CONTEXT_PATTERNS: RegExp[] = [
  // Reference to what Sai previously said or did
  /\b(you said|you told me|you mentioned|you explained|you wrote|you created|you built|you found|you showed)\b/i,
  // Reference to a prior session or conversation — "earlier" now requires a qualifier
  /\b(last time|last session|previous(ly)?|earlier (today|session|conversation|chat)|last conversation|before today)\b/i,
  // Direct request to recall / recap
  /\b(remind me|what happened|recap|summarize (the |our |this )?conversation|conversation history|chat history|message history)\b/i,
  // Temporal past references implying "what we did then"
  /\b(yesterday|last week|last month)\b/i,
  // "What did you / we …" construction — looking back at prior actions
  /\bwhat (did|were|have|was) (you|we|sai)\b/i,
  // "What was/is/were the last …" / "what's the last …" / "show me the last …"
  /\b(what('s| was| were| is)?|show me) (the |a )?last\b/i,
  // "When did we …" / "how many times did …"
  /\b(when|how many times) did (you|we|sai)\b/i,
  // "Did you / have you …" — checking whether Sai completed a past action
  /\b(did|have) you\b/i,
  // "I asked you to / I told you to"
  /\bI (asked|told) (you|sai)\b/i,
  // "What happened with/to X"
  /\bwhat happened (with|to)\b/i,
  // "Are you still / done / finished …"
  /\bare you (still|done|finished)\b/i,
]

/**
 * Synchronous heuristic classification — no network call, microsecond latency.
 * Returns 'context' if the message looks like a history/recall question,
 * 'task' otherwise.
 */
export function classifyMessage(message: string): MessageClass {
  for (const pattern of TASK_OVERRIDE_PATTERNS) {
    if (pattern.test(message)) return 'task'
  }
  for (const pattern of CONTEXT_PATTERNS) {
    if (pattern.test(message)) return 'context'
  }
  return 'task'
}
