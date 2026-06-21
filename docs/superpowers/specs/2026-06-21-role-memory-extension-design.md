# Role Memory Extension Design

## Goal

Add a role-switching workflow to pi through a default extension rather than a built-in command. Users can switch explicit roles such as `developer` or `ops`; each role has persistent profile and memory. Role state affects the system prompt for future turns without changing model, tools, permissions, or existing session history.

## Decisions

- Implement as an extension loaded by pi by default, not as a built-in slash command.
- Use explicit commands only. No natural-language role switching.
- Keep current session history when switching roles.
- Role behavior is prompt-only: no model, thinking-level, tool, permission, or environment binding.
- Use automatic memory extraction.
- Use two memory scopes: global role memory plus trusted project role memory.
- Auto-write memory without confirmation.

## User Interaction

The extension registers `/role`.

Commands:

- `/role`
  - Shows current role.
  - Lists existing roles.
  - Shows global and project profile/memory paths.

- `/role <name>`
  - Switches active role.
  - If the role does not exist and UI is available, prompts the user for a role description and creates `profile.md`.
  - If the role does not exist and UI is unavailable, errors with guidance to use `/role create <name> <description>`.

- `/role create <name> <description>`
  - Creates a role profile explicitly.
  - Initial implementation writes the global role profile.

- `/role save-memory`
  - Manually extracts memory for the current role.

- `/role memory`
  - Shows memory locations and a concise summary of loaded global/project memory.

Role names must be slugs such as `developer`, `ops`, or `sre-prod`. Reject names containing path separators, `..`, whitespace, or other unsafe characters.

## Storage Layout

Global role files:

```text
~/.pi/agent/roles/<role>/profile.md
~/.pi/agent/roles/<role>/memory.md
```

Project role files, only when the project is trusted:

```text
<cwd>/.pi/roles/<role>/profile.md
<cwd>/.pi/roles/<role>/memory.md
```

`profile.md` is user-authored identity and working-style guidance. `memory.md` is maintained by the extension.

The active role is persisted in the session as an extension custom entry, not in the LLM context. On `session_start`, the extension restores the latest active-role entry from the current branch.

## Prompt Injection

On `before_agent_start`, if an active role exists, append a role section to the system prompt containing:

1. Role name.
2. Global profile.
3. Global memory.
4. Project profile, if trusted and present.
5. Project memory, if trusted and present.

The extension must not replace the base prompt. It appends role context to `event.systemPrompt` so other pi prompt construction remains intact.

Switching roles only affects future turns. Existing session messages remain in context and may still influence the model.

## Memory Extraction

Triggers:

- Before switching away from the current role with `/role <new>`.
- On `session_shutdown` for quit, new session, resume, and fork.
- Manually via `/role save-memory`.

Skip extraction when:

- No active role exists.
- No new user/assistant messages have appeared since the last successful extraction.
- `session_shutdown.reason === "reload"`.

Extraction uses the current model and current authentication. It reads the current session branch, focuses on recent user/assistant conversation, and asks the model for a complete replacement for `memory.md`, not a patch.

The extraction prompt asks for structured output with:

- `globalMemory`: durable cross-project role preferences and stable operating style.
- `projectMemory`: current-project facts, decisions, and operational lessons.

Write targets:

- Always write `globalMemory` to the global role `memory.md`.
- Write `projectMemory` only when the project is trusted.

The extraction prompt must explicitly forbid storing secrets, tokens, passwords, private keys, one-time codes, or other credentials. It must also avoid moving project-specific details into global memory.

Failures must not block role switching or shutdown. In UI modes, show a warning notification.

## File Write Reliability

Memory writes should be safe for multiple pi processes:

- Use a per-file lock.
- Re-read current memory after acquiring the lock.
- Ask the extraction model to produce a complete merged memory document from current memory plus recent conversation.
- Write via temporary file plus atomic rename.

This avoids losing concurrent updates and avoids fragile patch application.

## UI Feedback

- Show current role in footer/status, for example `role: ops`.
- Notify on role switch, role creation, memory save success, and memory extraction warning.
- `/role` and `/role memory` should be useful in TUI, RPC, and print/json modes, but rich dialogs only run when `ctx.hasUI` is true.

## Extension Packaging

The role system should live as a bundled/default extension. The core remains minimal; the thin core integration only ensures this extension is discoverable/loaded by default and can be disabled with existing extension controls.

If default-extension loading needs new infrastructure, keep it generic: support bundled extensions without making role-specific core APIs.

## Testing

Cover these cases:

- `/role` lists current role and discovered roles.
- `/role <name>` switches to an existing role and persists active role to the session.
- `/role <missing>` prompts for a description when UI is available and creates a profile.
- `/role create <name> <description>` creates a profile in global storage.
- `before_agent_start` appends role profile and memory to the system prompt.
- Global and trusted project memory are merged in prompt order.
- Untrusted projects do not read or write project role files.
- Memory extraction writes global and trusted project memory.
- Memory extraction failure warns but does not block switching or shutdown.
- `session_shutdown` skips extraction on reload.
- Session custom entries restore active role on session resume.
