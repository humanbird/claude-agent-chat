import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  EngineInterface,
  Register,
  SessionMessage,
  ToolUseSummary,
} from 'claude-code'

import type { AgentRow, ChatLine } from '../types'

const PANE = 'agent-chat'
const TITLE = 'Agent Chat'
const POLL_MS = 1500
const MAX_AGENTS = 12
const MAX_LINES = 60
const MAX_TEXT = 1200

// Change the tag whenever the fields change: stored values outlive a reload
// and would otherwise be misread.
const agents = atom({ plugin: 'agent-chat', key: 'agents' } as const, [], {
  shape: 'agents-1',
})
const logs = atom({ plugin: 'agent-chat', key: 'logs' } as const, {}, {
  shape: 'logs-1',
})
const chosen = atom({ plugin: 'agent-chat', key: 'chosen' } as const, '')
// Where the app's prompt currently goes: an agent's id, '' = Claude
const TARGET = { plugin: 'agent-chat', key: 'target' } as const
const target = atom(TARGET, '')
// The agent whose "Stop" was pressed once and now waits for confirmation
const arming = atom({ plugin: 'agent-chat', key: 'arming' } as const, '')

const STATUS: Record<string, string> = {
  pending: 'starting',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}
const DOT: Record<string, string> = {
  pending: '○',
  running: '●',
  waiting: '◐',
  idle: '◌',
  completed: '✓',
  failed: '✕',
  killed: '■',
}
// Only what the person types into the prompt (terminal, app, phone) is
// redirected; never notifications, peers or plugins.
const TYPED = new Set(['composer', 'bridge', 'sdk', 'unclassified'])

// How a finished agent ended, as a sentence part
const ENDED: Record<string, string> = {
  completed: 'is done',
  failed: 'failed',
  killed: 'was stopped',
}

const isOver = (status: string) =>
  status === 'completed' || status === 'failed' || status === 'killed'

const clip = (text: string, max = MAX_TEXT) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const strip = (text: string) =>
  text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

const toRow = (a: AgentInfo): AgentRow => ({
  id: a.id,
  name: a.name ?? a.type,
  label: a.description || a.type,
  status: a.status,
})

function describeTool(use: ToolUseSummary): string {
  const input = use.input
  const arg = [
    'description',
    'file_path',
    'command',
    'pattern',
    'url',
    'query',
    'prompt',
  ]
    .map(k => input[k])
    .find((v): v is string => typeof v === 'string')
  const mark = use.isError ? ' ✕' : use.text === undefined ? ' …' : ''

  return clip(`${use.tool}${arg ? ` ${arg.replace(/\s+/g, ' ')}` : ''}`, 90) + mark
}

function toLines(messages: readonly SessionMessage[]): ChatLine[] {
  const lines: ChatLine[] = []
  for (const m of messages) {
    const text = strip(m.text)
    if (m.role === 'user') {
      if (text) lines.push({ who: 'in', text: clip(text) })
      continue
    }
    if (text) lines.push({ who: 'out', text: clip(text) })
    for (const use of m.toolUses) lines.push({ who: 'tool', text: describeTool(use) })
  }

  return lines.slice(-MAX_LINES)
}

// Module variables: empty after a reload, then written once more.
let agentsSig = ''
let logsSig = ''
let cache: Record<string, ChatLine[]> = {}
let seenStatus: Record<string, string> = {}
// Names stay even after the engine drops a finished agent from its list.
const names: Record<string, string> = {}
// The agent whose chat the app shows right now (from the render hooks); there
// the view wins: the prompt goes to that agent anyway.
let viewing: string | undefined
let isPolling = false

async function poll($: EngineInterface) {
  if (isPolling) return
  isPolling = true
  try {
    const rows = (await $.agent.list()).map(toRow).slice(-MAX_AGENTS)
    for (const a of rows) names[a.id] = a.name
    const sig = JSON.stringify(rows)
    if (sig !== agentsSig) {
      agentsSig = sig
      await update($, agents, () => rows)
    }

    const next: Record<string, ChatLine[]> = {}
    for (const a of rows) {
      const isFresh =
        cache[a.id] !== undefined && isOver(a.status) && seenStatus[a.id] === a.status
      if (isFresh) {
        next[a.id] = cache[a.id] ?? []
        continue
      }
      const found = await $.session.messages({ agentId: a.id })
      next[a.id] = 'deny' in found ? [] : toLines(found)
    }
    cache = next
    seenStatus = Object.fromEntries(rows.map(a => [a.id, a.status]))

    // When the agent the prompt goes to ends, the prompt goes back to Claude.
    const { value: aimed = '' } = await $.state.get(TARGET)
    const ended = rows.find(a => a.id === aimed && isOver(a.status))
    if (ended) {
      await update($, target, t => (t === ended.id ? '' : t))
      $.ui.toast(`${ended.name} ${ENDED[ended.status]}; the prompt goes to Claude again.`)
    }

    const nextSig = JSON.stringify(next)
    if (nextSig !== logsSig) {
      logsSig = nextSig
      await update($, logs, () => next)
    }
  } catch (error) {
    $.ui.status(`Agent Chat: ${String(error)}`)
  } finally {
    isPolling = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-chat',
      description: 'Open Agent Chat: background agents with their history, steerable from the prompt',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    await poll($)
    try {
      $.clock.every(POLL_MS, () => void poll($))
    } catch (error) {
      $.ui.status(`Agent Chat is not refreshing: ${String(error)}`)
    }

    return next(e)
  })

  on('command.run', { command: 'agent-chat' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void poll($)

    return { text: 'Agent Chat opened.' }
  })

  // The app's prompt writes to the chosen agent instead of Claude.
  on('prompt.submit', async ($, e, next) => {
    const isTyped = TYPED.has(e.origin.kind)
    if (e.command !== undefined || e.isMeta || !isTyped || viewing) return next(e)
    const { value: id = '' } = await $.state.get(TARGET)
    const text = e.text.trim()
    if (!id || !text) return next(e)

    const name = names[id] ?? 'agent'
    const status = seenStatus[id]
    if (status !== undefined && isOver(status)) {
      await update($, target, t => (t === id ? '' : t))
      void $.prompt.fill({ text: e.text, mode: 'replace' })
      return { drop: `${name} ${ENDED[status]}; your text is back in the prompt for Claude.` }
    }
    const result = await $.session.send({ to: { agentId: id }, text })
    if (!result.isDelivered) {
      void $.prompt.fill({ text: e.text, mode: 'replace' })
      return { drop: `Not sent to ${name}: ${result.reason}` }
    }
    if (e.attachments?.length) {
      $.ui.toast(`Only the text went to ${name}; images and attachments did not.`)
    }
    void poll($)

    return { drop: `→ sent to ${name}` }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    void $.prompt.fill({ text: e.text, mode: 'replace' })
    return { drop: 'Agent Chat: message not forwarded; your text is back in the prompt.' }
  })

  // A bar above the prompt while, in the main chat, it goes to an agent.
  // In an agent's own chat window it is left out: the recipient is clear there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    viewing = e.props.view.agentId
    const id = await read($, target)
    if (!id || e.props.hasSurvey || viewing) return next(e)
    const rows = await read($, agents)
    const agent = rows.find(a => a.id === id)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
        <Text>
          Prompt → <Text bold>{agent?.name ?? names[id] ?? 'agent'}</Text>
          {agent && <Text dimColor> · {STATUS[agent.status] ?? agent.status}</Text>}
        </Text>
        <Button
          key="agent-chat-back"
          label="Back to Claude"
          onPress={() => update($, target, () => '')}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)

    const rows = await read($, agents)
    const pick = await read($, chosen)
    const all = await read($, logs)
    const aim = await read($, target)
    const armed = await read($, arming)
    viewing = e.props.view.agentId

    if (rows.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>No background agents yet</Text>
          <Text dimColor wrap="wrap">
            When a subagent or teammate starts in this session, it shows up here
            with its history, and you can write to it from the prompt.
          </Text>
        </Box>
      )
    }

    // The open view wins over the pick in the list.
    const inView = e.props.view.agentId
    const current =
      rows.find(a => a.id === inView) ??
      rows.find(a => a.id === pick) ??
      [...rows].reverse().find(a => !isOver(a.status)) ??
      rows[rows.length - 1]
    if (current === undefined) return <Text dimColor>…</Text>

    const lines = all[current.id] ?? []
    const cols = Math.max(20, e.props.bodyColumns - 2)
    const budget = Math.max(6, e.props.scroll.bodyRows - rows.length - 10)
    const shown: ChatLine[] = []
    let used = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (line === undefined) continue
      const height = line.text
        .split('\n')
        .reduce((sum, part) => sum + Math.max(1, Math.ceil((part.length + 3) / cols)), 0)
      if (used + height > budget && shown.length > 0) break
      used += height
      shown.unshift(line)
    }
    const hidden = lines.length - shown.length

    const isAimed = aim === current.id
    const isViewing = inView === current.id
    const isArmed = armed === current.id

    // The first press asks, only the second stops; the question lapses after 4 s.
    const arm = async () => {
      const id = current.id
      await update($, arming, () => id)
      $.clock.after(4000, () => void update($, arming, a => (a === id ? '' : a)))
    }

    const stop = async () => {
      const id = current.id
      await update($, arming, () => '')
      // A stopped agent should not be restarted by the next prompt.
      await update($, target, t => (t === id ? '' : t))
      // Show it as stopped at once, so no button is left to press meanwhile.
      await update($, agents, list =>
        list.map(a => (a.id === id ? { ...a, status: 'killed' } : a)),
      )
      agentsSig = ''
      const result = await $.tool.call({ tool: 'TaskStop', task_id: id })
      $.ui.toast('deny' in result ? `Not stopped: ${result.deny}` : `${current.name} stopped`)
      void poll($)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {rows.map(a => (
            <Button
              key={`agent-${a.id}`}
              plain
              onPress={async () => {
                await update($, chosen, () => a.id)
                // In an agent's chat window a click switches the window too.
                if (inView && inView !== a.id) await $.ui.view({ agentId: a.id })
              }}
            >
              {a.id === current.id ? '▸ ' : '  '}
              {DOT[a.status] ?? '·'} {a.name}{' '}
              <Text dimColor>
                {STATUS[a.status] ?? a.status} · {clip(a.label, 40)}
              </Text>
            </Button>
          ))}
        </Box>

        <Box flexDirection="column">
          {hidden > 0 && <Text dimColor>… {hidden} earlier entries</Text>}
          {shown.length === 0 && <Text dimColor>No history yet.</Text>}
          {shown.map(line =>
            line.who === 'tool' ? (
              <Text dimColor wrap="truncate-end">
                {'  ↳ '}
                {line.text}
              </Text>
            ) : (
              <Text wrap="wrap">
                <Text bold color={line.who === 'in' ? 'cyan' : undefined}>
                  {line.who === 'in' ? '→ ' : `${current.name}: `}
                </Text>
                {line.text}
              </Text>
            ),
          )}
        </Box>

        {isOver(current.status) ? (
          // A finished agent keeps its history and nothing else: no button
          // that could only lead nowhere.
          <Text dimColor wrap="wrap">
            {current.name} {ENDED[current.status]}. History only.
          </Text>
        ) : isViewing ? (
          <Text dimColor wrap="wrap">
            In this window the prompt goes straight to {current.name}.
          </Text>
        ) : isAimed ? (
          <Text dimColor wrap="wrap">
            The prompt is going to {current.name}. Switch back with “Back to
            Claude” right above the prompt.
          </Text>
        ) : null}

        {isOver(current.status) ? null : isArmed ? (
          <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
            <Text bold>Stop {current.name}?</Text>
            <Button
              key={`stop-confirm-${current.id}`}
              label="Yes, stop"
              onPress={() => void stop()}
            />
            <Button
              key={`stop-cancel-${current.id}`}
              label="Cancel"
              onPress={() => update($, arming, () => '')}
            />
          </Box>
        ) : (
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {!isViewing && !isAimed && (
              <Button
                key={`aim-${current.id}`}
                variant="primary"
                label={`Write to ${current.name}`}
                onPress={() => update($, target, () => current.id)}
              />
            )}
            {!isViewing && (
              <Button
                key={`view-${current.id}`}
                label="Open chat"
                onPress={() => void $.ui.view({ agentId: current.id })}
              />
            )}
            <Button
              key={`stop-${current.id}`}
              label="Stop …"
              onPress={() => void arm()}
            />
          </Box>
        )}
      </Box>
    )
  })
}
