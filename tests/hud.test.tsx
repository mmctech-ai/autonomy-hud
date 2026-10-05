import { expect, test } from 'claude-code/testing'

import { decisionFor, describe, formatElapsed, shortTool } from '../hooks/register'

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
