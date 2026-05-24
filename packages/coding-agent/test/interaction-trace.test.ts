import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "os";
import { afterEach, describe, expect, test } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	InteractionTraceWriter,
	resolveInteractionLogPath,
	shouldRecordInteractionTraceEvent,
} from "../src/core/interaction-trace.ts";

const originalAgentDir = process.env[ENV_AGENT_DIR];
let tempDir: string | undefined;

afterEach(() => {
	if (originalAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = originalAgentDir;
	}
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createTempAgentDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "pi-interaction-trace-"));
	process.env[ENV_AGENT_DIR] = tempDir;
	return tempDir;
}

describe("resolveInteractionLogPath", () => {
	test("returns empty string when disabled", () => {
		expect(resolveInteractionLogPath("")).toBe("");
		expect(resolveInteractionLogPath("   ")).toBe("");
	});

	test("uses default interaction log dir for truthy values", () => {
		const agentDir = createTempAgentDir();
		const resolved = resolveInteractionLogPath("1");
		expect(resolved.startsWith(join(agentDir, "interaction-logs", "interaction-"))).toBe(true);
		expect(resolved.endsWith(".jsonl")).toBe(true);
		expect(resolveInteractionLogPath("true").startsWith(join(agentDir, "interaction-logs"))).toBe(true);
		expect(resolveInteractionLogPath("YES").startsWith(join(agentDir, "interaction-logs"))).toBe(true);
	});

	test("creates file inside an existing directory", () => {
		const agentDir = createTempAgentDir();
		const logDir = join(agentDir, "custom-logs");
		mkdirSync(logDir, { recursive: true });
		const resolved = resolveInteractionLogPath(logDir);
		expect(resolved.startsWith(join(logDir, "interaction-"))).toBe(true);
		expect(resolved.endsWith(".jsonl")).toBe(true);
	});

	test("uses explicit file path when not a directory", () => {
		const agentDir = createTempAgentDir();
		const filePath = join(agentDir, "trace.jsonl");
		expect(resolveInteractionLogPath(filePath)).toBe(filePath);
	});
});

describe("shouldRecordInteractionTraceEvent", () => {
	test("skips assistant message and tool execution delta events", () => {
		const partial = {
			role: "assistant" as const,
			content: [],
			api: "openai-codex-responses" as const,
			provider: "openai-codex",
			model: "gpt-5.5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		};

		expect(
			shouldRecordInteractionTraceEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{", partial },
			}),
		).toBe(false);
		expect(
			shouldRecordInteractionTraceEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial },
			}),
		).toBe(false);
		expect(
			shouldRecordInteractionTraceEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial },
			}),
		).toBe(false);
		expect(
			shouldRecordInteractionTraceEvent({
				type: "tool_execution_update",
				toolCallId: "call_1",
				toolName: "bash",
				args: {},
				partialResult: "partial",
			}),
		).toBe(false);
	});

	test("keeps lifecycle and completion events", () => {
		expect(shouldRecordInteractionTraceEvent({ type: "agent_start" })).toBe(true);
		expect(
			shouldRecordInteractionTraceEvent({
				type: "message_start",
				message: { role: "user", content: "hello", timestamp: 1 },
			}),
		).toBe(true);
		expect(
			shouldRecordInteractionTraceEvent({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command: "ls" },
			}),
		).toBe(true);
	});
});

describe("InteractionTraceWriter", () => {
	test("writes header, events, and footer as JSONL", () => {
		const agentDir = createTempAgentDir();
		const filePath = join(agentDir, "trace.jsonl");
		const writer = new InteractionTraceWriter(filePath);

		writer.writeHeader({
			cwd: "/tmp/project",
			sessionFile: "/tmp/project/session.jsonl",
			sessionId: "session-123",
		});
		writer.writeEvent({ type: "agent_start" });
		writer.writeEvent({
			type: "message_start",
			message: { role: "user", content: "hello", timestamp: 1 },
		});
		writer.close();

		const lines = readFileSync(filePath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(lines).toHaveLength(4);
		expect(lines[0]).toMatchObject({
			kind: "header",
			pid: process.pid,
			cwd: "/tmp/project",
			sessionFile: "/tmp/project/session.jsonl",
			sessionId: "session-123",
		});
		expect(lines[1]).toMatchObject({
			kind: "event",
			event: { type: "agent_start" },
		});
		expect(lines[2]).toMatchObject({
			kind: "event",
			event: {
				type: "message_start",
				message: { role: "user", content: "hello", timestamp: 1 },
			},
		});
		expect(lines[3]).toMatchObject({
			kind: "footer",
			pid: process.pid,
		});
	});

	test("does not write delta events", () => {
		const agentDir = createTempAgentDir();
		const filePath = join(agentDir, "trace.jsonl");
		const writer = new InteractionTraceWriter(filePath);
		const partial = {
			role: "assistant" as const,
			content: [],
			api: "openai-codex-responses" as const,
			provider: "openai-codex",
			model: "gpt-5.5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		};

		writer.writeEvent({ type: "agent_start" });
		writer.writeEvent({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{", partial },
		});
		writer.writeEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.5",
				usage: partial.usage,
				stopReason: "toolUse",
				timestamp: 1,
			},
		});
		writer.close();

		const lines = readFileSync(filePath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(lines).toHaveLength(3);
		expect(lines[0].event.type).toBe("agent_start");
		expect(lines[1].event.type).toBe("message_end");
		expect(lines[2].kind).toBe("footer");
	});
});
