# Agent Chat for Claude Code

Steer background agents as if each had its own chat. When Claude runs subagents or teammates in the background, a pane next to the chat shows each one with its status and history. One click points the app's normal prompt at one of those agents instead of Claude, so you can redirect it without interrupting the main chat.

## Install

**Claude Code desktop app:** click **+** next to the prompt → **Plugins** → **Add marketplace** with `humanbird/claude-agent-chat` → **Add plugin** on *agent-chat*.

**Claude Code in a terminal**, at the prompt:

```
/plugin install agent-chat --marketplace humanbird/claude-agent-chat
```

or from a shell:

```bash
claude plugin install agent-chat --marketplace humanbird/claude-agent-chat
```

Answer `Add marketplace?` with `y`, then pick the *user* scope (Enter). From then on the mod is active in every new session.

## How it works

The **Agent Chat** pane opens next to the chat when a session starts. If you close it, `/agent-chat` brings it back.

- **List:** every agent in the session with its status – ● running, ◐ waiting, ◌ idle, ✓ done, ✕ failed, ■ stopped. Click one to select it.
- **History:** what was sent to the agent (→), its replies and, dimmed, its tool calls (↳). Refreshes by itself.
- **Write to …:** from then on, whatever you type into the app's prompt goes to that agent. Above the prompt a bar reads *Prompt → name*, with **Back to Claude** as the one way back. In the chat, *→ sent to name* confirms the message went out.
- **Open chat:** shows the agent's full history as its own chat window. There the prompt goes to that agent anyway; the bar is left out, and a click in the list switches the window too.
- **Stop …** asks first (*Yes, stop* / *Cancel*; the question lapses after 4 seconds).
- **Finished agents** (done, failed, stopped) keep their history and show no buttons. If the prompt was pointed at one, it goes back to Claude, and a notice says so.

## Good to know

- Only what you type yourself is redirected. Slash commands, notifications and messages from other sessions still go to Claude.
- Agents receive text only. Images and attachments stay behind, and a notice tells you so.
- If sending fails, your text is put back into the prompt.
- On the phone the pane shows the list and history; you write through the normal prompt there.
- The mod uses Claude Code's plugin API (function hooks), which is in early access and may change between releases.

## Development

`claude plugin validate .` checks the manifest and the module, `claude plugin test .` runs the tests in `tests/`.
