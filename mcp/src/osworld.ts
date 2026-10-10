import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { SaiApi } from './api.js'
import type { OsworldAttempt } from './types.js'

/**
 * OSWorld attempts (docs/plans/2026-10-07-osworld-runner-image.md §8): the harness sets a
 * task up on a fresh machine, the coding agent works it through direct control, the harness
 * grades it. Registered with SAI_OSWORLD=1 only: the routes are Benchmarks-gated, and an
 * account without access would only see three tools that answer 403.
 */

export const osworldToolSchemas = {
  osworld_start: {
    task_id: z
      .string()
      .regex(/^\d{3}$/)
      .describe('OSWorld V2.1 task id, "001" to "108".'),
  },
  osworld_ask_user: {
    attempt_id: z.string().min(1).describe('attempt_id from osworld_start.'),
    question: z.string().min(1).max(4000).describe('What to ask the task’s user.'),
  },
  osworld_submit: {
    attempt_id: z.string().min(1).describe('attempt_id from osworld_start.'),
    outcome: z
      .enum(['done', 'fail'])
      .optional()
      .describe(
        '"done" (default): you did the task. "fail": you concluded the task cannot be done as asked; ' +
          'some tasks are infeasible on purpose and are graded on that verdict.',
      ),
  },
  osworld_abandon: {
    attempt_id: z.string().min(1).describe('attempt_id from osworld_start.'),
  },
} as const

export const osworldToolDescriptions: Record<keyof typeof osworldToolSchemas, string> = {
  osworld_start:
    'Start an OSWorld task: a fresh cloud computer is created for you and the task is set up on it ' +
    '(waits until it is ready, often several minutes). Returns { attempt_id, state, machine_id, instruction, ' +
    'has_user }; state "failed" (with a reason) means the setup did not complete and you can start again. ' +
    'Then do the task on that computer: sai_control_open { machine_id } and sai_control_exec blocks of Simulang, ' +
    'and sai_control_close when you are done. Work only from the instruction and what you observe on the ' +
    'computer: do not look for the task’s files, configs, graders or reference results anywhere else. ' +
    'One attempt at a time: submit or abandon the current one before starting another.',
  osworld_ask_user:
    'Ask the task’s user a question, when osworld_start returned has_user: true and the instruction leaves ' +
    'something for them to decide. Returns { answer }.',
  osworld_submit:
    'Grade the attempt in the computer’s current state and release the computer. Call it once, when you ' +
    'are done, with outcome "fail" if you concluded the task cannot be done. Close control first. ' +
    'Returns { score, state }.',
  osworld_abandon:
    'End the attempt without grading and free its computer. Use it to restart a task: abandon, then ' +
    'osworld_start again for a fresh computer. Close control first. Returns { state }.',
}

export const osworldInstructions = [
  '',
  'OSWorld: osworld_start → work the task on its machine_id through direct control → osworld_submit (osworld_abandon to restart).',
].join('\n')

const POLL_MS = 5_000
/** Longer than the harness's own bound on a setup (machine create, task setup, settle). */
const START_DEADLINE_MS = 25 * 60_000

/** Start an attempt and poll it until it leaves `starting`. */
export async function startAndWait(
  api: Pick<SaiApi, 'osworldStart' | 'osworldGet'>,
  taskId: string,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<OsworldAttempt> {
  const deadline = clock.now() + START_DEADLINE_MS
  let attempt = await api.osworldStart(taskId)
  while (attempt.state === 'starting') {
    if (clock.now() >= deadline)
      throw new Error(
        `OSWorld attempt ${attempt.attemptId} is still starting after ${START_DEADLINE_MS / 60_000} minutes. ` +
          'It ends on its own; try osworld_start again later.',
      )
    await clock.sleep(POLL_MS)
    attempt = await api.osworldGet(attempt.attemptId)
  }
  return attempt
}

/** The attempt in the tools' snake_case. */
export function attemptView(a: OsworldAttempt): Record<string, unknown> {
  return {
    attempt_id: a.attemptId,
    task_id: a.taskId,
    state: a.state,
    machine_id: a.machineId,
    instruction: a.instruction,
    has_user: a.hasUser,
    score: a.score,
    ...(a.reason && { reason: a.reason }),
  }
}

export function registerOsworldTools(
  mcp: McpServer,
  api: SaiApi,
  run: (fn: () => Promise<unknown>) => Promise<CallToolResult>,
): void {
  mcp.registerTool(
    'osworld_start',
    {
      description: osworldToolDescriptions.osworld_start,
      inputSchema: osworldToolSchemas.osworld_start,
    },
    (args) => run(async () => attemptView(await startAndWait(api, args.task_id))),
  )
  mcp.registerTool(
    'osworld_ask_user',
    {
      description: osworldToolDescriptions.osworld_ask_user,
      inputSchema: osworldToolSchemas.osworld_ask_user,
    },
    (args) => run(() => api.osworldAskUser(args.attempt_id, args.question)),
  )
  mcp.registerTool(
    'osworld_submit',
    {
      description: osworldToolDescriptions.osworld_submit,
      inputSchema: osworldToolSchemas.osworld_submit,
    },
    (args) =>
      run(async () => attemptView(await api.osworldEvaluate(args.attempt_id, args.outcome))),
  )
  mcp.registerTool(
    'osworld_abandon',
    {
      description: osworldToolDescriptions.osworld_abandon,
      inputSchema: osworldToolSchemas.osworld_abandon,
    },
    (args) => run(async () => attemptView(await api.osworldAbandon(args.attempt_id))),
  )
}
