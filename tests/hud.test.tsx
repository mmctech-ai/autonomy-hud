import { expect, test } from 'claude-code/testing'

import { decisionFor, describe, formatElapsed, programOf, shortTool, stripPrelude } from '../hooks/register'

test('formats elapsed time', () => {
  expect(formatElapsed(4_000)).toBe('4s')
  expect(formatElapsed(125_000)).toBe('2m 05s')
  expect(formatElapsed(3_900_000)).toBe('1h 05m')
})

test('describes steps and shortens MCP tool names', () => {
  expect(describe('Read', { file_path: '/a/b/c.ts' }).label).toBe('Reading c.ts')
  expect(describe('Bash', { command: 'npm test\nmore', description: 'Run tests' }).label).toBe('Run tests')
  expect(shortTool('mcp__claude_ai_Slack__slack_send_message')).toBe('Slack·slack_send_message')
})

test('recognises panel and ratification decisions', () => {
  expect(decisionFor('Agent', { subagent_type: 'autonomy:panel-lens-b' })?.kind).toBe('lens')
  expect(decisionFor('Bash', { command: 'gh issue create -l needs-ratification' })?.kind).toBe('ratify')
  expect(decisionFor('Read', {})).toBeNull()
})

test('opens the pane when the autonomy skill loads', async ($, on) => {
  const opened = await $.ui.mount({
    plugin: 'autonomy-hud',
    surface: 'terminal',
    component: 'Pane',
    props: { title: 'Autonomy', isFocused: false, bodyColumns: 40, placement: 'dock' },
    requestId: 'autonomy-hud',
  } as never)
  expect(await opened.find({ type: 'Text', text: /idle/ })).toBeDefined()
  await opened.unmount()
})

test('names a bare command by its program, without the cd prelude or home paths', () => {
  const command = 'cd /Users/someone/src/app; python3 - <<EOF\nprint(1)\nEOF'
  expect(stripPrelude(command).startsWith('python3')).toBe(true)
  expect(programOf('cd "/a b" && FOO=1 sudo /usr/bin/grep -rn x .')).toBe('grep')
  expect(describe('Bash', { command }).label).toBe('Running python3')
  expect(describe('Bash', { command: 'cd /Users/someone/x && ls /Users/someone/y' }).detail).toBe('ls ~/y')
  expect(describe('Bash', { command, description: 'Patch the file' }).label).toBe('Patch the file')
  expect(describe('ScheduleWakeup', { reason: 'wait' }).label).toBe('Scheduling a wake-up')
})

test('Stop tracking ends tracking from the pane', async ($, on) => {
  const panes = new Set<string>()
  const closed: string[] = []
  on('clock.now', () => ({ value: 1000 }) as never)
  on('clock.every', () => ({ value: { cancel: () => {} } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.open', (_$, e) => {
    panes.add(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id })) }) as never)
  on('ui.close', (_$, e) => {
    panes.delete(e.id)
    closed.push(e.id)
    return { value: undefined } as never
  })
  on('command.run', () => ({ text: '' }))
  const run = (args: string) =>
    $.command.run({ command: 'autonomy-hud', args, origin: 'person' } as never) as Promise<{ text?: string }>
  await run('on')
  expect(panes.has('autonomy-hud')).toBe(true)
  const opened = await $.ui.mount({
    plugin: 'autonomy-hud',
    surface: 'terminal',
    component: 'Pane',
    props: { title: 'Autonomy', isFocused: false, bodyColumns: 40, placement: 'dock' },
    requestId: 'autonomy-hud',
  } as never)
  await opened.press({ key: 'stop' })
  expect(closed).toEqual(['autonomy-hud'])
  expect((await run('off')).text).toBe('Autonomy HUD is not tracking.')
  await opened.unmount()
})
