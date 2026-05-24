/**
 * Append-only JSONL trace of AgentSessionEvent streams for interactive mode debugging.
 */

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDefaultInteractionLogDir } from "../config.ts";
import type { AgentSessionEvent } from "./agent-session.ts";

const TRUTHY_VALUES = new Set(["1", "true", "yes"]);

function formatTimestampForFilename(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}_${String(date.getHours()).padStart(2, "0")}-${String(date.getMinutes()).padStart(2, "0")}-${String(date.getSeconds()).padStart(2, "0")}`;
}

function createInteractionLogFilename(): string {
	const now = new Date();
	return `interaction-${formatTimestampForFilename(now)}-${process.pid}.jsonl`;
}

function isTruthySpec(spec: string): boolean {
	return TRUTHY_VALUES.has(spec.trim().toLowerCase());
}

/**
 * Resolve interaction log path from CLI flag or PI_INTERACTION_LOG.
 * Returns empty string when tracing is disabled.
 */
export function resolveInteractionLogPath(spec: string): string {
	const trimmed = spec.trim();
	if (!trimmed) {
		return "";
	}

	if (isTruthySpec(trimmed)) {
		return join(getDefaultInteractionLogDir(), createInteractionLogFilename());
	}

	try {
		if (statSync(trimmed).isDirectory()) {
			return join(trimmed, createInteractionLogFilename());
		}
	} catch {
		// Not an existing directory — use as file path
	}

	return trimmed;
}

export interface InteractionTraceHeader {
	cwd: string;
	sessionFile?: string;
	sessionId?: string;
}

type TraceRecord =
	| {
			kind: "header";
			ts: string;
			pid: number;
			cwd: string;
			sessionFile?: string;
			sessionId?: string;
	  }
	| {
			kind: "event";
			ts: string;
			event: AgentSessionEvent;
	  }
	| {
			kind: "footer";
			ts: string;
			pid: number;
	  };

function isoTimestamp(): string {
	return new Date().toISOString();
}

const ASSISTANT_MESSAGE_DELTA_TYPES = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

/** Whether an agent session event should be written to the interaction trace log. */
export function shouldRecordInteractionTraceEvent(event: AgentSessionEvent): boolean {
	if (event.type === "message_update") {
		return !ASSISTANT_MESSAGE_DELTA_TYPES.has(event.assistantMessageEvent.type);
	}
	if (event.type === "tool_execution_update") {
		return false;
	}
	return true;
}

export class InteractionTraceWriter {
	readonly filePath: string;
	private closed = false;

	constructor(filePath: string) {
		this.filePath = filePath;
		mkdirSync(join(filePath, ".."), { recursive: true });
		if (!existsSync(filePath)) {
			writeFileSync(filePath, "", "utf8");
		}
	}

	writeHeader(meta: InteractionTraceHeader): void {
		if (this.closed) return;
		const record: TraceRecord = {
			kind: "header",
			ts: isoTimestamp(),
			pid: process.pid,
			cwd: meta.cwd,
			sessionFile: meta.sessionFile,
			sessionId: meta.sessionId,
		};
		this.appendRecord(record);
	}

	writeEvent(event: AgentSessionEvent): void {
		if (this.closed || !shouldRecordInteractionTraceEvent(event)) return;
		const record: TraceRecord = {
			kind: "event",
			ts: isoTimestamp(),
			event,
		};
		this.appendRecord(record);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const record: TraceRecord = {
			kind: "footer",
			ts: isoTimestamp(),
			pid: process.pid,
		};
		this.appendRecord(record);
	}

	private appendRecord(record: TraceRecord): void {
		appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
	}
}

export function createInteractionTraceWriter(filePath: string): InteractionTraceWriter | undefined {
	if (!filePath) {
		return undefined;
	}
	return new InteractionTraceWriter(filePath);
}
