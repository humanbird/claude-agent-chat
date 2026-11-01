export type AgentRow = {
  id: string
  name: string
  label: string
  status: string
}

// in: to the agent (task, message), out: its reply, tool: a tool call
export type ChatLine = { who: 'in' | 'out' | 'tool'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-chat': {
      agents: Shaped<AgentRow[]>
      logs: Shaped<Record<string, ChatLine[]>>
      chosen: string
      target: string
      arming: string
    }
  }
}
