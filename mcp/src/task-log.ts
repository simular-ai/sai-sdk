/**
 * Which task each task view belongs to. A machine's `api` conversation is one
 * session, and `/events` only reports its current turn, so a view reopened
 * after a newer task started would show that newer task. This process started
 * every task its views show, so it knows their order: a view of an older task
 * gets the snapshot that view saved when its task ended, not the live turn.
 *
 * A newer task on the same machine also archives a view, even in another
 * session (`new_session`): the person using the computer from an ended task's
 * view must stop once Sai works on it again.
 *
 * In memory only: after a restart an old view is told its task expired.
 */
import { randomBytes } from 'node:crypto'

/** What a view saved when its task ended (validated by the tool's schema). */
export interface TaskSnapshot {
  status: string
  steps: Array<{ title: string; detail?: string }>
  text: string
  error?: string
  /** The last frame of the live screen, as a JPEG data URL. */
  frame?: string
}

interface TaskRecord {
  sessionId: string
  machineId?: string
  saved?: TaskSnapshot
}

const MAX_TASKS = 50

export class TaskLog {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly latest = new Map<string, string>()
  private readonly latestOnMachine = new Map<string, string>()

  /** A new task on `sessionId`: it becomes that session's (and machine's) live one. */
  start(sessionId: string, machineId?: string): string {
    const taskId = randomBytes(9).toString('base64url')
    this.tasks.set(taskId, { sessionId, ...(machineId && { machineId }) })
    this.latest.set(sessionId, taskId)
    if (machineId) this.latestOnMachine.set(machineId, taskId)
    while (this.tasks.size > MAX_TASKS) {
      const oldest = this.tasks.keys().next().value!
      this.tasks.delete(oldest)
    }
    return taskId
  }

  /**
   * `live`: still its session's and machine's newest task; `archived`: a newer
   * one started on either; `expired`: unknown.
   */
  state(taskId: string, sessionId: string): 'live' | 'archived' | 'expired' {
    const task = this.tasks.get(taskId)
    if (!task || task.sessionId !== sessionId) return 'expired'
    if (this.latest.get(sessionId) !== taskId) return 'archived'
    if (task.machineId && this.latestOnMachine.get(task.machineId) !== taskId) return 'archived'
    return 'live'
  }

  saved(taskId: string): TaskSnapshot | undefined {
    return this.tasks.get(taskId)?.saved
  }

  save(taskId: string, snapshot: TaskSnapshot): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    task.saved = snapshot
    return true
  }
}
