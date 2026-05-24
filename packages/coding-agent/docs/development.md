# Development

See [AGENTS.md](https://github.com/earendil-works/pi-mono/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/earendil-works/pi-mono
cd pi-mono
npm install
npm run build
```

Run from source:

```bash
/path/to/pi-mono/pi-test.sh
```

The script can be run from any directory. Pi keeps the caller's current working directory.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.pi/agent/pi-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Interaction Trace Log

Interactive mode can append the full `AgentSessionEvent` stream (including streaming deltas and tool execution lifecycle events) to a JSONL file:

```bash
PI_INTERACTION_LOG=1 ./pi-test.sh
PI_INTERACTION_LOG=/tmp/pi-traces ./pi-test.sh
PI_INTERACTION_LOG=/tmp/trace.jsonl ./pi-test.sh
./pi-test.sh --interaction-log
./pi-test.sh --interaction-log /tmp/trace.jsonl
```

Default directory: `~/.pi/agent/interaction-logs/interaction-<timestamp>-<pid>.jsonl`

Streaming delta events (`text_delta`, `thinking_delta`, `toolcall_delta`, `tool_execution_update`) are omitted; lifecycle events such as `message_start`, `message_end`, and `tool_execution_start` are kept.

Each line is a JSON object with `kind` of `header`, `event`, or `footer`. Filter events with:

```bash
jq -r 'select(.kind=="event") | .event.type' trace.jsonl
```

Logs may contain user input, tool arguments, and model output. Do not commit them to git.

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
