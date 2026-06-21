import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, complete, type Model } from "@earendil-works/pi-ai";
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

function stripJsonFence(text: string): string {
	const trimmed = text.trim();
	const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
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

export async function extractAndWriteRoleMemory(input: ExtractRoleMemoryInput): Promise<boolean> {
	if (!input.model) {
		return false;
	}
	const conversationText = buildConversationText(input.messages);
	if (!conversationText.trim()) {
		return false;
	}
	const auth = await input.modelRegistry.getApiKeyAndHeaders(input.model);
	if (!auth.ok || !auth.apiKey) {
		return false;
	}
	const response = await complete(
		input.model,
		{
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: buildMemoryExtractionPrompt({
								role: input.paths.role,
								bundle: input.bundle,
								conversationText,
							}),
						},
					],
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
	const text = response.content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("\n");
	const result = parseMemoryExtractionResponse(text);
	await writeMemoryAtomic(input.paths.global.memory, `${result.globalMemory}\n`);
	if (input.paths.project) {
		await writeMemoryAtomic(input.paths.project.memory, `${result.projectMemory}\n`);
	}
	return true;
}
