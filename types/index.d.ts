export type HudOutcome = 'ok' | 'error' | 'denied'

export type HudStep = {
  id: string
  tool: string
  label: string
  detail: string
  startedAt: number
  durationMs?: number
  outcome?: HudOutcome
}

export type HudTodo = {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

export type HudDecisionKind = 'panel' | 'lens' | 'advisor' | 'ratify'

export type HudDecision = { kind: HudDecisionKind; text: string; at: number }

export type HudAgent = { id: string; title: string; lastAction: string; startedAt: number }

export type HudSession = {
  since: number
  turns: number
  steps: number
  errors: number
  lastCheckpoint: string
}

declare module 'claude-code' {
  interface PluginState {
    'autonomy-hud': {
      session: HudSession | null
      current: HudStep | null
      recent: HudStep[]
      todos: HudTodo[]
      decisions: HudDecision[]
      agents: HudAgent[]
      now: number
    }
  }
}
