import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'agent-chat',
  component: 'Pane',
  requestId: 'agent-chat',
  props: {
    title: 'Agent Chat',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'agent-chat',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const AGENT = {
  id: 'a1',
  name: 'research',
  description: 'Collect sources',
  type: 'general-purpose',
  status: 'running',
} as const

const IN_AGENT_CHAT = { view: { agentId: 'a1' } } as const

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const

// Stands for the engine beneath the mod: one agent with a short history.
function engine(on: On) {
  const sent: { to: string; text: string }[] = []
  const stopped: unknown[] = []
  let status: 'running' | 'killed' = 'running'
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'agent-chat' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [{ ...AGENT, status }] }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Find sources', toolUses: [] },
      {
        role: 'assistant',
        text: 'Searching',
        toolUses: [{ tool_use_id: 't1', tool: 'WebSearch', input: { query: 'water hardness' } }],
      },
    ],
  }))
  on('session.send', (_, e) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('tool.call', (_, e) => {
    stopped.push({ tool: e.tool, task_id: 'task_id' in e ? e.task_id : undefined })
    if (e.tool === 'TaskStop') status = 'killed'
    return { result: {} }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return { sent, stopped }
}

test('main chat: the button points the prompt at the agent, the bar leads back', async ($, on) => {
  const { sent } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // With no target the prompt goes to Claude as always.
  expect((await $.prompt.submit(typed('Hello Claude'))).text).toBe('Hello Claude')
  expect(sent.length).toBe(0)

  expect((await pane.find({ type: 'Text', text: /Searching/ }))?.text).toBe('research: Searching')
  expect(await pane.find({ type: 'Text', text: /WebSearch water hardness/ })).toBeDefined()
  await pane.press({ key: 'aim-a1' })
  // No second way back in the pane, only the hint at the bar.
  expect(await pane.find({ key: 'aim-a1' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /prompt is going to research/ })).toBeDefined()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /Prompt → research/ })).toBeDefined()

  const routed = await $.prompt.submit(typed('Primary sources only'))
  expect(routed.drop).toBe('→ sent to research')
  expect(sent).toEqual([{ to: 'a1', text: 'Primary sources only' }])

  await band.press({ key: 'agent-chat-back' })
  expect((await $.prompt.submit(typed('Back to you'))).text).toBe('Back to you')
  expect(sent.length).toBe(1)
  await band.unmount()
  await pane.unmount()
})

test("agent's chat window: no bar, no redirect, the view wins", async ($, on) => {
  const { sent } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const main = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await main.press({ key: 'aim-a1' })
  await main.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...IN_AGENT_CHAT }, surface })
    expect(await band.find({ type: 'Text', text: /Prompt →/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /engine/ })).toBeDefined()
    await band.unmount()
  }

  const pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, ...IN_AGENT_CHAT }, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /prompt goes straight to research/ })).toBeDefined()
  expect(await pane.find({ key: 'view-a1' })).toBeUndefined()

  // The app routes to the agent in view by itself; the mod lets the prompt pass.
  expect((await $.prompt.submit(typed('Keep going'))).text).toBe('Keep going')
  expect(sent.length).toBe(0)
  await pane.unmount()
})

test('Stop asks first; cancel and confirm', async ($, on) => {
  const { stopped } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'stop-a1' })
  expect(await pane.find({ type: 'Text', text: /Stop research\?/ })).toBeDefined()
  await pane.press({ key: 'stop-cancel-a1' })
  expect(await pane.find({ key: 'stop-a1' })).toBeDefined()
  expect(stopped.length).toBe(0)

  await pane.press({ key: 'stop-a1' })
  await pane.press({ key: 'stop-confirm-a1' })
  expect(stopped).toEqual([{ tool: 'TaskStop', task_id: 'a1' }])
  expect(await pane.find({ type: 'Text', text: /research was stopped. History only./ })).toBeDefined()
  expect(await pane.findAll({ type: 'Button', text: /Write to|Open chat|Stop/ })).toHaveLength(0)
  await pane.unmount()
})

test('a finished agent: history only, and the prompt goes back to Claude', async ($, on) => {
  const sent: unknown[] = []
  let status: 'running' | 'completed' = 'running'
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'agent-chat' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [{ ...AGENT, status }] }))
  on('session.messages', () => ({ value: [] }))
  on('session.send', (_, e) => {
    sent.push(e)
    return { isDelivered: true }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'aim-a1' })

  status = 'completed'
  await clock.advance(1500)

  expect(await pane.find({ type: 'Text', text: /research is done\. History only\./ })).toBeDefined()
  expect(await pane.findAll({ type: 'Button', text: /Write to|Open chat|Stop/ })).toHaveLength(0)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /Prompt →/ })).toBeUndefined()
  expect((await $.prompt.submit(typed('Hello Claude'))).text).toBe('Hello Claude')
  expect(sent.length).toBe(0)
  await band.unmount()
  await pane.unmount()
})

test('no agents: a hint instead of a list', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'agent-chat' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /No background agents/ })).toBeDefined()
    await ui.unmount()
  }
})
