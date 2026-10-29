import { BadRequestError, NotFoundError } from './errors.js'
import type { Http } from './http.js'
import { parseMachine, type LiveView, type Machine } from './types.js'

export type MachineRef = Machine | string

/** Machines: the computers Sai works on. Cloud computers, or the customer's own PC with the Sai app. */
export class Machines {
  constructor(private readonly http: Http) {}

  async list(): Promise<Machine[]> {
    const d = await this.http.json<{ machines?: Record<string, unknown>[] }>(
      'GET',
      '/v1/agents/machines',
    )
    return (d.machines ?? []).map(parseMachine)
  }

  async get(machineId: string): Promise<Machine> {
    const m = (await this.list()).find((x) => x.id === machineId)
    if (!m)
      throw new NotFoundError(`Machine ${machineId} not found on this account.`, { status: 404 })
    return m
  }

  /**
   * The live screen: `liveUrl`, a page a person can open without a Simular sign-in, and a Guacamole
   * tunnel for a viewer of your own. The machine must be running.
   */
  async live(machine: MachineRef): Promise<LiveView> {
    const id = idOf(machine)
    const d = await this.http.json<Record<string, unknown>>(
      'POST',
      `/v1/agents/machines/${encodeURIComponent(id)}/live`,
    )
    return {
      machineId: typeof d.machineId === 'string' ? d.machineId : id,
      liveUrl: typeof d.liveUrl === 'string' ? d.liveUrl : null,
      expiresAt: typeof d.expiresAt === 'number' ? d.expiresAt : null,
      websocketUrl: String(d.websocketUrl),
      width: Number(d.width ?? 0),
      height: Number(d.height ?? 0),
    }
  }

  /**
   * Revokes every `liveUrl` handed out for the machine; resolves with how many. A page already
   * showing the screen keeps its connection until it closes, but stops taking input within seconds.
   */
  async revokeLive(machine: MachineRef): Promise<number> {
    const d = await this.http.json<Record<string, unknown> | null>(
      'DELETE',
      `/v1/agents/machines/${encodeURIComponent(idOf(machine))}/live`,
    )
    return Number(d?.revoked ?? 0)
  }

  /** @internal */
  async resolveId(machine: MachineRef | undefined): Promise<string> {
    if (machine) return idOf(machine)
    const machines = await this.list()
    if (machines.length === 1) return machines[0]!.id
    if (machines.length === 0) {
      throw new BadRequestError(
        'No computer on this account. Create one in the Sai app or the portal.',
        { status: 400 },
      )
    }
    const names = machines.map((m) => (m.name ? `${m.id} (${m.name})` : m.id)).join(', ')
    throw new BadRequestError(
      `Several computers on this account; pass machine. Candidates: ${names}`,
      { status: 400 },
    )
  }
}

export function idOf(machine: MachineRef): string {
  return typeof machine === 'string' ? machine : machine.id
}
