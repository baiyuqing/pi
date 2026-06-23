import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, complete, type Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "../../model-registry.ts";
import { writeMemoryAtomic } from "./storage.ts";
import type { MemoryExtractionResult, RoleBundle, RolePaths } from "./types.ts";

export interface BuildMemoryExtractionPromptInput {
	role: string;
	bundle: RoleBundle;
	conversationText: string;
}

export interface ExtractRoleMemoryInput {
	model: Model<Api> | undefined;
	modelRegistry: ModelRegistry;
	paths: RolePaths;
	bundle: RoleBundle;
	messages: AgentMessage[];
	signal?: AbortSignal;
}

export interface BuildRememberMemoryPromptInput {
	role: string;
	scope: "global" | "project";
	instruction: string;
	bundle: RoleBundle;
	conversationText: string;
}

export interface ExtractRememberRoleMemoryInput {
	model: Model<Api> | undefined;
	modelRegistry: ModelRegistry;
	paths: RolePaths;
	bundle: RoleBundle;
	messages: AgentMessage[];
	scope: "global" | "project";
	instruction: string;
	signal?: AbortSignal;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
	return (
		typeof part === "object" &&
		part !== null &&
		"type" in part &&
		part.type === "text" &&
		"text" in part &&
		typeof part.text === "string"
	);
}

function extractText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("\n");
}

export function buildConversationText(messages: AgentMessage[]): string {
	return messages
		.filter((message) => message.role === "user" || message.role === "assistant")
		.map((message) => {
			const text = extractText(message.content).trim();
			return text ? `${message.role}: ${text}` : "";
		})
		.filter((text) => text.length > 0)
		.join("\n\n");
}

export function buildMemoryExtractionPrompt(input: BuildMemoryExtractionPromptInput): string {
	return [
		`You maintain long-term memory for the pi role "${input.role}".`,
		"Return ONLY valid JSON with exactly these string fields: globalMemory, projectMemory.",
		"Do not include markdown fences or commentary.",
		"Never store secrets, tokens, passwords, private keys, one-time codes, or credentials.",
		"globalMemory is only durable cross-project user preferences and stable role operating style.",
		"projectMemory is only current-project facts, decisions, lessons, and open operational context.",
		"Return complete replacement memory documents, not patches.",
		"",
		"<current_global_memory>",
		input.bundle.global.memory?.trim() ?? "",
		"</current_global_memory>",
		"",
		"<current_project_memory>",
		input.bundle.project?.memory?.trim() ?? "",
		"</current_project_memory>",
		"",
		"<recent_conversation>",
		input.conversationText,
		"</recent_conversation>",
	].join("\n");
}

export function buildRememberMemoryPrompt(input: BuildRememberMemoryPromptInput): string {
	const currentMemory =
		input.scope === "project"
			? (input.bundle.project?.memory?.trim() ?? "")
			: (input.bundle.global.memory?.trim() ?? "");
	return [
		`You prepare long-term memory for the pi role "${input.role}".`,
		`Target memory scope: ${input.scope}.`,
		"Treat the user's remember text as an instruction for what to extract, not as memory to store verbatim.",
		"Return ONLY the concise markdown memory entry or entries to append to the target memory file.",
		"Do not include commentary, explanations, titles, or markdown fences.",
		"Use stable facts, preferences, decisions, lessons, and operating context. Skip transient chat wording.",
		"Never store secrets, tokens, passwords, private keys, one-time codes, or credentials.",
		"If there is no safe durable memory matching the instruction, return an empty response.",
		"global memory is cross-project user preferences and stable role operating style.",
		"project memory is only current-project facts, decisions, lessons, and open operational context.",
		"",
		"<remember_instruction>",
		input.instruction,
		"</remember_instruction>",
		"",
		"<current_target_memory>",
		currentMemory,
		"</current_target_memory>",
		"",
		"<recent_conversation>",
		input.conversationText,
		"</recent_conversation>",
	].join("\n");
}

function stripJsonFence(text: string): string {
	const trimmed = text.trim();
	const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return match?.[1]?.trim() ?? trimmed;
}

function stripMemoryCandidateFence(text: string): string {
	const trimmed = text.trim();
	const match = /^```(?:[a-z0-9_-]+)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return match?.[1]?.trim() ?? trimmed;
}

export function parseMemoryExtractionResponse(text: string): MemoryExtractionResult {
	const parsed = JSON.parse(stripJsonFence(text)) as { globalMemory?: unknown; projectMemory?: unknown };
	if (typeof parsed.globalMemory !== "string" || typeof parsed.projectMemory !== "string") {
		throw new Error("Memory extraction response must include string globalMemory and projectMemory fields");
	}
	return {
		globalMemory: parsed.globalMemory.trim(),
		projectMemory: parsed.projectMemory.trim(),
	};
}

async function completeMemoryPrompt(input: {
	model: Model<Api>;
	modelRegistry: ModelRegistry;
	prompt: string;
	signal?: AbortSignal;
}): Promise<string | undefined> {
	const auth = await input.modelRegistry.getApiKeyAndHeaders(input.model);
	if (!auth.ok || !auth.apiKey) {
		return undefined;
	}
	const response = await complete(
		input.model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: input.prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: input.signal,
		},
	);
	return response.content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("\n");
}

export async function extractRememberRoleMemory(input: ExtractRememberRoleMemoryInput): Promise<string | undefined> {
	if (!input.model) {
		return undefined;
	}
	const conversationText = buildConversationText(input.messages);
	const text = await completeMemoryPrompt({
		model: input.model,
		modelRegistry: input.modelRegistry,
		prompt: buildRememberMemoryPrompt({
			role: input.paths.role,
			scope: input.scope,
			instruction: input.instruction,
			bundle: input.bundle,
			conversationText,
		}),
		signal: input.signal,
	});
	const candidate = text ? stripMemoryCandidateFence(text) : "";
	return candidate.trim() ? candidate.trim() : undefined;
}

export async function extractAndWriteRoleMemory(input: ExtractRoleMemoryInput): Promise<boolean> {
	if (!input.model) {
		return false;
	}
	const conversationText = buildConversationText(input.messages);
	if (!conversationText.trim()) {
		return false;
	}
	const text = await completeMemoryPrompt({
		model: input.model,
		modelRegistry: input.modelRegistry,
		prompt: buildMemoryExtractionPrompt({
			role: input.paths.role,
			bundle: input.bundle,
			conversationText,
		}),
		signal: input.signal,
	});
	if (!text) {
		return false;
	}
	const result = parseMemoryExtractionResponse(text);
	await writeMemoryAtomic(input.paths.global.memory, `${result.globalMemory}\n`);
	if (input.paths.project) {
		await writeMemoryAtomic(input.paths.project.memory, `${result.projectMemory}\n`);
	}
	return true;
}
