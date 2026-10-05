import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  HudAgent,
  HudDecision,
  HudDecisionKind,
  HudOutcome,
  HudStep,
  HudTodo,
} from '../types'

const PANE = 'autonomy-hud'
const TITLE = 'Autonomy'
const COMMAND = 'autonomy-hud'

const RECENT_KEPT = 40
const DECISIONS_KEPT = 12

const AUTONOMY_SKILL = /(^|:)autonomy$/
const PANEL_SKILL = /(^|:)panel$/
const RELEASE = /\b(stop autonomy|autonomy off|ask me first|i am here now|i'm here now|i'm back)\b/i

const session = atom({ plugin: 'autonomy-hud', key: 'session' } as const, null)
const current = atom({ plugin: 'autonomy-hud', key: 'current' } as const, null)
const recent = atom({ plugin: 'autonomy-hud', key: 'recent' } as const, [])
const todos = atom({ plugin: 'autonomy-hud', key: 'todos' } as const, [])
const decisions = atom({ plugin: 'autonomy-hud', key: 'decisions' } as const, [])
const agents = atom({ plugin: 'autonomy-hud', key: 'agents' } as const, [])
const clockNow = atom({ plugin: 'autonomy-hud', key: 'now' } as const, 0)

type Engine = EngineInterface
type Input = Record<string, unknown>

// ---------- formatting ----------

const pad2 = (n: number) => String(n).padStart(2, '0')

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${pad2(m)}m`
  if (m > 0) return `${m}m ${pad2(s)}s`
  return `${s}s`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return formatElapsed(ms)
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return 'just now'
  return `${formatElapsed(ms).split(' ')[0]} ago`
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

const firstLine = (text: string) =>
  text
    .split('\n')
    .map(line => line.replace(/^[#>*\-\s`]+/, '').replace(/[*_`]/g, '').trim())
    .find(line => line.length > 0) ?? ''

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const str = (input: Input, key: string) => {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

// ---------- describing a step ----------

export function shortTool(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return `${mcp[1]?.replace(/^(claude_ai_|plugin_)/, '')}·${mcp[2]}`
  return tool
}

export function describe(tool: string, input: Input): { label: string; detail: string } {
  switch (tool) {
    case 'Bash': {
      const command = str(input, 'command')
      return { label: str(input, 'description') || firstLine(command), detail: firstLine(command) }
    }
    case 'Read':
      return { label: `Reading ${basename(str(input, 'file_path'))}`, detail: str(input, 'file_path') }
    case 'Edit':
      return { label: `Editing ${basename(str(input, 'file_path'))}`, detail: str(input, 'file_path') }
    case 'Write':
      return { label: `Writing ${basename(str(input, 'file_path'))}`, detail: str(input, 'file_path') }
    case 'NotebookEdit':
      return { label: `Editing ${basename(str(input, 'notebook_path'))}`, detail: str(input, 'notebook_path') }
    case 'Grep':
    case 'Glob':
      return { label: `Searching ${str(input, 'pattern')}`, detail: str(input, 'path') }
    case 'Agent': {
      const type = str(input, 'subagent_type') || 'general-purpose'
      return { label: str(input, 'description') || 'Delegating', detail: `agent · ${type}` }
    }
    case 'Skill':
      return { label: `Loading skill ${str(input, 'skill')}`, detail: str(input, 'args') }
    case 'WebFetch':
      return { label: 'Fetching a page', detail: str(input, 'url') }
    case 'WebSearch':
      return { label: `Searching the web`, detail: str(input, 'query') }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { label: 'Updating the plan', detail: str(input, 'subject') }
    case 'ToolSearch':
      return { label: 'Loading tools', detail: str(input, 'query') }
    case 'Workflow':
      return { label: 'Running a workflow', detail: '' }
    default:
      return { label: shortTool(tool), detail: '' }
  }
}

export function decisionFor(tool: string, input: Input): { kind: HudDecisionKind; text: string } | null {
  if (tool === 'Agent') {
    const type = str(input, 'subagent_type')
    if (/(^|:)panel-/.test(type)) return { kind: 'lens', text: `Panel lens · ${type.split(':').pop()}` }
  }
  if (tool === 'Bash') {
    const command = str(input, 'command')
    if (/needs-ratification/.test(command)) return { kind: 'ratify', text: 'Ratification item filed' }
    if (/\bcodex\s+exec\b/.test(command)) return { kind: 'lens', text: 'Panel lens · Codex' }
    if (/(^|[\s/])agy\s/.test(command)) return { kind: 'lens', text: 'Panel lens · agy' }
  }
  if (/advisor/i.test(tool)) return { kind: 'advisor', text: 'Advisor consulted' }
  return null
}

// ---------- state changes ----------

let isActive = false
let stopTick: { cancel: () => void } | undefined

async function record($: Engine, kind: HudDecisionKind, text: string) {
  const at = await $.clock.now()
  const decision: HudDecision = { kind, text, at }
  await update($, decisions, list => [...list, decision].slice(-DECISIONS_KEPT))
}

async function refreshStatus($: Engine) {
  if (!isActive) {
    $.ui.status(undefined)
    return
  }
  const [held, step, plan, now] = await Promise.all([
    read($, session),
    read($, current),
    read($, todos),
    $.clock.now(),
  ])
  if (held === null) return
  const done = plan.filter(todo => todo.status === 'completed').length
  const parts = [`◆ autonomy ${formatElapsed(now - held.since)}`]
  if (plan.length > 0) parts.push(`${done}/${plan.length}`)
  if (step !== null) parts.push(clip(step.label, 40))
  $.ui.status(parts.join(' · '))
}

function startTicker($: Engine) {
  stopTick?.cancel()
  stopTick = $.clock.every(1000, () => {
    void $.clock.now().then(async now => {
      await update($, clockNow, () => now)
      await refreshStatus($)
    })
  })
}

async function showPane($: Engine, isAsked: boolean) {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (!opened.isPlaced && !isAsked) {
    $.ui.toast(`Autonomy HUD is ready: widen the terminal or run /${COMMAND}`)
  }
}

async function activate($: Engine) {
  const now = await $.clock.now()
  if ((await read($, session)) === null) {
    await Promise.all([
      update($, session, () => ({ since: now, turns: 0, steps: 0, errors: 0, lastCheckpoint: '' })),
      update($, current, () => null),
      update($, recent, () => []),
      update($, todos, () => []),
      update($, decisions, () => []),
      update($, agents, () => []),
      update($, clockNow, () => now),
    ])
  }
  isActive = true
  startTicker($)
  await showPane($, false)
  await refreshStatus($)
}

async function deactivate($: Engine, why: string) {
  if (!isActive) return
  const [held, now] = await Promise.all([read($, session), $.clock.now()])
  isActive = false
  stopTick?.cancel()
  stopTick = undefined
  await Promise.all([update($, session, () => null), update($, current, () => null), update($, agents, () => [])])
  $.ui.status(undefined)
  await $.ui.close({ id: PANE })
  if (held !== null) {
    $.ui.toast(`Autonomy ${why} after ${formatElapsed(now - held.since)} · ${held.steps} steps · ${held.errors} errors`)
  }
}

function applyTodoWrite(list: Input): HudTodo[] {
  const raw = Array.isArray(list['todos']) ? (list['todos'] as Input[]) : []
  return raw.map(todo => ({
    content: str(todo, 'content'),
    status: (str(todo, 'status') || 'pending') as HudTodo['status'],
    activeForm: str(todo, 'activeForm'),
  }))
}

// ---------- the hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Autonomy HUD: open the pane; "on" starts tracking, "off" stops it',
    })
    if ((await read($, session)) !== null) {
      isActive = true
      startTicker($)
      const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
      if (!isUp) await showPane($, false)
      await refreshStatus($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await deactivate($, 'cleared')
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      if (!isActive) return { text: 'Autonomy HUD is not tracking.' }
      await deactivate($, 'tracking stopped')
      return { text: 'Autonomy HUD stopped tracking.' }
    }
    if (arg === 'on') {
      await activate($)
      await showPane($, true)
      return { text: 'Autonomy HUD is tracking this session.' }
    }
    await showPane($, true)
    return { text: isActive ? 'Autonomy HUD opened.' : 'Autonomy HUD opened (idle until /autonomy runs).' }
  })

  on('skill.prompt', async ($, e, next) => {
    if (AUTONOMY_SKILL.test(e.skill)) await activate($)
    else if (isActive && PANEL_SKILL.test(e.skill)) await record($, 'panel', 'Panel convened')
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (isActive && RELEASE.test(e.text)) await deactivate($, 'handed back')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Input

    if (!isActive && tool === 'Skill' && AUTONOMY_SKILL.test(str(input, 'skill'))) await activate($)
    if (!isActive) return next(e)

    const startedAt = await $.clock.now()
    const { label, detail } = describe(tool, input)

    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await update($, agents, list =>
        list.map(agent => (agent.id === agentId ? { ...agent, lastAction: label } : agent)),
      )
      return next(e)
    }

    const step: HudStep = {
      id: e.tool_use_id ?? `step-${startedAt}`,
      tool: shortTool(tool),
      label: clip(label, 200),
      detail: clip(detail, 300),
      startedAt,
    }
    await update($, current, () => step)
    const decision = decisionFor(tool, input)
    if (decision !== null) await record($, decision.kind, decision.text)
    if (tool === 'TodoWrite') await update($, todos, () => applyTodoWrite(input))
    await refreshStatus($)

    const ran = await next(e)

    const endedAt = await $.clock.now()
    const outcome: HudOutcome =
      ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
    const finished: HudStep = { ...step, durationMs: endedAt - startedAt, outcome }

    if (outcome === 'ok' && tool === 'TaskCreate') {
      const result = (ran as { result?: { task?: { id?: string } } }).result
      const todo: HudTodo = {
        id: result?.task?.id,
        content: str(input, 'subject'),
        status: 'pending',
        activeForm: str(input, 'activeForm'),
      }
      await update($, todos, list => [...list, todo])
    }
    if (outcome === 'ok' && tool === 'TaskUpdate') {
      const id = str(input, 'taskId')
      const status = str(input, 'status')
      await update($, todos, list =>
        status === 'deleted'
          ? list.filter(todo => todo.id !== id)
          : list.map(todo =>
              todo.id !== id
                ? todo
                : {
                    ...todo,
                    content: str(input, 'subject') || todo.content,
                    activeForm: str(input, 'activeForm') || todo.activeForm,
                    status: (status || todo.status) as HudTodo['status'],
                  },
            ),
      )
    }

    await Promise.all([
      update($, recent, list => [...list, finished].slice(-RECENT_KEPT)),
      update($, session, held =>
        held === null
          ? null
          : { ...held, steps: held.steps + 1, errors: held.errors + (outcome === 'ok' ? 0 : 1) },
      ),
      update($, current, now => (now !== null && now.id === step.id ? null : now)),
    ])
    await refreshStatus($)
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (isActive && spawned.deny === undefined && spawned.agentId !== undefined) {
      const agent: HudAgent = {
        id: spawned.agentId,
        title: clip(e.description || e.subagentType, 80),
        lastAction: 'starting',
        startedAt: await $.clock.now(),
      }
      await update($, agents, list => [...list.filter(one => one.id !== agent.id), agent])
    }
    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    if (!isActive) return next(e)
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await update($, agents, list => list.filter(agent => agent.id !== agentId))
      return next(e)
    }
    const checkpoint = clip(firstLine(e.answer), 240)
    await update($, session, held =>
      held === null
        ? null
        : { ...held, turns: held.turns + 1, lastCheckpoint: checkpoint || held.lastCheckpoint },
    )
    if (/\bPROVISIONAL\b/.test(e.answer)) await record($, 'ratify', 'Provisional decision recorded')
    return next(e)
  })

  // ---------- the pane ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const rows = e.viewport?.rows ?? 40

    const [held, step, history, plan, choices, helpers, ticked] = await Promise.all([
      read($, session),
      read($, current),
      read($, recent),
      read($, todos),
      read($, decisions),
      read($, agents),
      read($, clockNow),
    ])

    const rule = <Text dimColor>{'─'.repeat(width)}</Text>

    const heading = (label: string, right?: string) => (
      <Box justifyContent="space-between" marginTop={1}>
        <Text bold color="cyan">
          {label}
        </Text>
        {right !== undefined && <Text dimColor>{right}</Text>}
      </Box>
    )

    if (held === null) {
      return (
        <Box flexDirection="column">
          <Text bold>
            <Text color="gray">○</Text> AUTONOMY <Text dimColor>idle</Text>
          </Text>
          {rule}
          <Text dimColor wrap="wrap">
            Loads with the autonomy skill. Run /autonomy to grant it, or /{COMMAND} on to track this
            session anyway.
          </Text>
        </Box>
      )
    }

    const now = Math.max(ticked, step?.startedAt ?? 0, held.since)

    // NOW
    const nowBlock =
      step !== null ? (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color="yellow">{Math.floor(now / 1000) % 2 === 0 ? '▶' : '▷'}</Text>{' '}
              <Text bold>{step.label}</Text>
            </Text>
            <Text color="yellow">{formatElapsed(now - step.startedAt)}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {step.tool}
            {step.detail && step.detail !== step.label ? ` · ${step.detail}` : ''}
          </Text>
        </Box>
      ) : (
        <Text dimColor>
          {'  '}Thinking{'.'.repeat((Math.floor(now / 1000) % 3) + 1)}
        </Text>
      )

    // PLAN
    const done = plan.filter(todo => todo.status === 'completed').length
    const barWidth = Math.max(8, Math.min(30, width - 12))
    const filled = plan.length === 0 ? 0 : Math.round((done / plan.length) * barWidth)
    const active = plan.find(todo => todo.status === 'in_progress')
    const planRoom = Math.max(4, Math.floor(rows / 4))
    const startAt = Math.max(0, Math.min(plan.indexOf(active as HudTodo) - 1, plan.length - planRoom))
    const shown = plan.slice(startAt, startAt + planRoom)
    const planBlock =
      plan.length === 0 ? null : (
        <Box flexDirection="column">
          {heading('PLAN', `${done}/${plan.length}`)}
          <Text>
            <Text color="green">{'█'.repeat(filled)}</Text>
            <Text dimColor>{'░'.repeat(barWidth - filled)}</Text>
            <Text dimColor> {Math.round((done / plan.length) * 100)}%</Text>
          </Text>
          {startAt > 0 && <Text dimColor>  ↑ {startAt} more</Text>}
          {shown.map(todo =>
            todo.status === 'completed' ? (
              <Text dimColor wrap="truncate-end">
                <Text color="green">✔</Text> {todo.content}
              </Text>
            ) : todo.status === 'in_progress' ? (
              <Text wrap="truncate-end">
                <Text color="yellow">▸</Text> <Text bold>{todo.activeForm || todo.content}</Text>
              </Text>
            ) : (
              <Text wrap="truncate-end">
                <Text dimColor>○</Text> {todo.content}
              </Text>
            ),
          )}
          {startAt + planRoom < plan.length && (
            <Text dimColor>  ↓ {plan.length - startAt - planRoom} more</Text>
          )}
        </Box>
      )

    // AGENTS
    const agentsBlock =
      helpers.length === 0 ? null : (
        <Box flexDirection="column">
          {heading('SUBAGENTS', String(helpers.length))}
          {helpers.map(agent => (
            <Box flexDirection="column">
              <Box justifyContent="space-between">
                <Text wrap="truncate-end">
                  <Text color="magenta">◇</Text> {agent.title}
                </Text>
                <Text dimColor>{formatElapsed(now - agent.startedAt)}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {'  '}↳ {agent.lastAction}
              </Text>
            </Box>
          ))}
        </Box>
      )

    // DECISIONS
    const glyph: Record<HudDecisionKind, [string, string]> = {
      panel: ['⚖', 'magenta'],
      lens: ['◎', 'blue'],
      advisor: ['✦', 'cyan'],
      ratify: ['⚑', 'yellow'],
    }
    const decisionsBlock =
      choices.length === 0 ? null : (
        <Box flexDirection="column">
          {heading('DECISIONS', String(choices.length))}
          {choices.slice(-5).map(decision => (
            <Box justifyContent="space-between">
              <Text wrap="truncate-end">
                <Text color={glyph[decision.kind][1]}>{glyph[decision.kind][0]}</Text> {decision.text}
              </Text>
              <Text dimColor>{formatAgo(now - decision.at)}</Text>
            </Box>
          ))}
        </Box>
      )

    // RECENT
    const used = 8 + (plan.length > 0 ? shown.length + 3 : 0) + helpers.length * 2 + Math.min(5, choices.length) + 6
    const recentRoom = Math.max(3, rows - used)
    const recentBlock = (
      <Box flexDirection="column">
        {heading('RECENT', history.length > 0 ? `${history.length} kept` : undefined)}
        {history.length === 0 && <Text dimColor>  No steps yet.</Text>}
        {history
          .slice(-recentRoom)
          .reverse()
          .map(done => (
            <Box justifyContent="space-between">
              <Text wrap="truncate-end" dimColor={done.outcome === 'ok'}>
                <Text color={done.outcome === 'ok' ? 'green' : done.outcome === 'denied' ? 'yellow' : 'red'}>
                  {done.outcome === 'ok' ? '✔' : done.outcome === 'denied' ? '⊘' : '✖'}
                </Text>{' '}
                {done.label}
              </Text>
              <Text dimColor>{formatDuration(done.durationMs ?? 0)}</Text>
            </Box>
          ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold>
            <Text color="green">●</Text> AUTONOMY <Text color="green">active</Text>
          </Text>
          <Text dimColor>{formatElapsed(now - held.since)}</Text>
        </Box>
        <Text dimColor>
          {held.turns} turns · {held.steps} steps
          {held.errors > 0 ? ' · ' : ''}
          {held.errors > 0 && <Text color="red">{held.errors} errors</Text>}
        </Text>
        {rule}
        {heading('NOW')}
        {nowBlock}
        {held.lastCheckpoint !== '' && (
          <Text italic dimColor wrap="wrap">
            {'  '}“{held.lastCheckpoint}”
          </Text>
        )}
        {planBlock}
        {agentsBlock}
        {decisionsBlock}
        {recentBlock}
        <Box marginTop={1}>
          <Button key="stop" label="Stop tracking" hotkey="x" onPress={() => deactivate($, 'tracking stopped')} />
        </Box>
      </Box>
    )
  })
}
