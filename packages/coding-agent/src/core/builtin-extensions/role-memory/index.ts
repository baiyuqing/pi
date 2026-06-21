import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../extensions/index.ts";
import { extractAndWriteRoleMemory } from "./memory.ts";
import { assertRoleName, resolveRolePaths } from "./paths.ts";
import { formatRolePromptSection } from "./prompt.ts";
import { restoreRoleState } from "./session-state.ts";
import { appendMemoryBullet, createGlobalRoleProfile, listRoles, loadRoleBundle } from "./storage.ts";
import { ROLE_MEMORY_CUSTOM_TYPE } from "./types.ts";

interface RoleMemoryState {
	activeRole: string | undefined;
	lastExtractionEntryId: string | null | undefined;
}

function persistState(pi: ExtensionAPI, state: RoleMemoryState): void {
	pi.appendEntry(ROLE_MEMORY_CUSTOM_TYPE, {
		kind: "state",
		activeRole: state.activeRole,
		lastExtractionLeafId: state.lastExtractionEntryId ?? null,
	});
}

function getConversationMessages(ctx: ExtensionContext): AgentMessage[] {
	return ctx.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message)
		.filter((message) => message.role === "user" || message.role === "assistant");
}

function getLatestConversationEntryId(ctx: ExtensionContext): string | null {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
			return entry.id;
		}
	}
	return null;
}

async function saveMemory(
	pi: ExtensionAPI,
	state: RoleMemoryState,
	ctx: ExtensionContext,
	notifySuccess: boolean,
): Promise<boolean> {
	if (!state.activeRole) {
		if (notifySuccess) {
			ctx.ui.notify("No active role", "warning");
		}
		return false;
	}
	const latestConversationEntryId = getLatestConversationEntryId(ctx);
	if (!latestConversationEntryId || latestConversationEntryId === state.lastExtractionEntryId) {
		if (notifySuccess) {
			ctx.ui.notify("No new role memory to save", "info");
		}
		return false;
	}
	try {
		const paths = resolveRolePaths({
			agentDir: getAgentDir(),
			cwd: ctx.cwd,
			role: state.activeRole,
			projectTrusted: ctx.isProjectTrusted(),
		});
		const saved = await extractAndWriteRoleMemory({
			model: ctx.model as Model<Api> | undefined,
			modelRegistry: ctx.modelRegistry,
			paths,
			bundle: await loadRoleBundle(paths),
			messages: getConversationMessages(ctx),
			signal: ctx.signal,
		});
		if (!saved) {
			if (notifySuccess) {
				ctx.ui.notify("No role memory was saved", "warning");
			}
			return false;
		}
		state.lastExtractionEntryId = latestConversationEntryId;
		persistState(pi, state);
		if (notifySuccess) {
			ctx.ui.notify(`Saved memory for role ${state.activeRole}`, "info");
		}
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to save role memory: ${message}`, "warning");
		return false;
	}
}

async function showRoleInfo(state: RoleMemoryState, ctx: ExtensionCommandContext): Promise<void> {
	const roles = await listRoles({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
	const role = state.activeRole ? assertRoleName(state.activeRole) : undefined;
	const pathLines = role
		? (() => {
				const paths = resolveRolePaths({
					agentDir: getAgentDir(),
					cwd: ctx.cwd,
					role,
					projectTrusted: ctx.isProjectTrusted(),
				});
				return [
					`Global profile: ${paths.global.profile}`,
					`Global memory: ${paths.global.memory}`,
					...(paths.project
						? [`Project profile: ${paths.project.profile}`, `Project memory: ${paths.project.memory}`]
						: []),
				];
			})()
		: [];
	const message = [
		`Current role: ${state.activeRole ?? "none"}`,
		`Roles: ${roles.length > 0 ? roles.join(", ") : "none"}`,
		...pathLines,
	].join("\n");
	ctx.ui.notify(message, "info");
}

async function showRoleMemory(state: RoleMemoryState, ctx: ExtensionCommandContext): Promise<void> {
	if (!state.activeRole) {
		ctx.ui.notify("No active role", "warning");
		return;
	}
	const paths = resolveRolePaths({
		agentDir: getAgentDir(),
		cwd: ctx.cwd,
		role: state.activeRole,
		projectTrusted: ctx.isProjectTrusted(),
	});
	const bundle = await loadRoleBundle(paths);
	const lines = [
		`Role: ${state.activeRole}`,
		`Global memory: ${paths.global.memory}`,
		bundle.global.memory?.trim() ?? "(empty)",
	];
	if (paths.project) {
		lines.push(`Project memory: ${paths.project.memory}`, bundle.project?.memory?.trim() ?? "(empty)");
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

async function switchRole(
	pi: ExtensionAPI,
	state: RoleMemoryState,
	roleArg: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const role = assertRoleName(roleArg);
	if (state.activeRole && state.activeRole !== role) {
		await saveMemory(pi, state, ctx, false);
	}
	const paths = resolveRolePaths({
		agentDir: getAgentDir(),
		cwd: ctx.cwd,
		role,
		projectTrusted: ctx.isProjectTrusted(),
	});
	const bundle = await loadRoleBundle(paths);
	if (!bundle.global.profile && !bundle.project?.profile) {
		if (!ctx.hasUI) {
			throw new Error(`Role "${role}" does not exist. Use /role create ${role} <description>.`);
		}
		const description = await ctx.ui.input(`Create role: ${role}`, "Describe this role");
		if (!description?.trim()) {
			ctx.ui.notify("Role creation cancelled", "warning");
			return;
		}
		await createGlobalRoleProfile(paths, description);
	}
	state.activeRole = role;
	persistState(pi, state);
	ctx.ui.setStatus("role-memory", `role: ${role}`);
	ctx.ui.notify(`Role switched to ${role}`, "info");
}

function parseRememberArgs(args: string): { scope: "global" | "project"; text: string } {
	const trimmed = args.trim();
	if (trimmed.startsWith("--global ")) {
		return { scope: "global", text: trimmed.slice("--global ".length).trim() };
	}
	if (trimmed.startsWith("--project ")) {
		return { scope: "project", text: trimmed.slice("--project ".length).trim() };
	}
	if (trimmed.startsWith("--")) {
		throw new Error("Usage: /role remember [--global|--project] <memory>");
	}
	return { scope: "global", text: trimmed };
}

async function rememberRoleMemory(state: RoleMemoryState, args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!state.activeRole) {
		ctx.ui.notify("No active role", "warning");
		return;
	}
	const { scope, text } = parseRememberArgs(args);
	if (!text) {
		throw new Error("Usage: /role remember [--global|--project] <memory>");
	}
	const paths = resolveRolePaths({
		agentDir: getAgentDir(),
		cwd: ctx.cwd,
		role: state.activeRole,
		projectTrusted: ctx.isProjectTrusted(),
	});
	if (scope === "project") {
		if (!paths.project) {
			ctx.ui.notify("Project role memory is unavailable because this project is not trusted", "warning");
			return;
		}
		await appendMemoryBullet(paths.project.memory, text);
		ctx.ui.notify(`Remembered project memory for role ${state.activeRole}`, "info");
		return;
	}
	await appendMemoryBullet(paths.global.memory, text);
	ctx.ui.notify(`Remembered global memory for role ${state.activeRole}`, "info");
}

async function createRole(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const [rawRole, ...descriptionParts] = args.trim().split(/\s+/);
	if (!rawRole || descriptionParts.length === 0) {
		throw new Error("Usage: /role create <name> <description>");
	}
	const role = assertRoleName(rawRole);
	const paths = resolveRolePaths({
		agentDir: getAgentDir(),
		cwd: ctx.cwd,
		role,
		projectTrusted: ctx.isProjectTrusted(),
	});
	await createGlobalRoleProfile(paths, descriptionParts.join(" "));
	ctx.ui.notify(`Created role ${role}`, "info");
}

export default function roleMemoryExtension(pi: ExtensionAPI): void {
	const state: RoleMemoryState = {
		activeRole: undefined,
		lastExtractionEntryId: undefined,
	};

	pi.on("session_start", (_event, ctx) => {
		const restored = restoreRoleState(ctx.sessionManager.getBranch());
		state.activeRole = restored.activeRole;
		state.lastExtractionEntryId = restored.lastExtractionLeafId;
		ctx.ui.setStatus("role-memory", state.activeRole ? `role: ${state.activeRole}` : undefined);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "reload") {
			return;
		}
		await saveMemory(pi, state, ctx, false);
	});

	pi.registerCommand("role", {
		description: "Switch role and manage role memory",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await showRoleInfo(state, ctx);
				return;
			}
			if (trimmed.startsWith("create ")) {
				await createRole(trimmed.slice("create ".length), ctx);
				return;
			}
			if (trimmed === "memory") {
				await showRoleMemory(state, ctx);
				return;
			}
			if (trimmed.startsWith("remember ")) {
				await rememberRoleMemory(state, trimmed.slice("remember ".length), ctx);
				return;
			}
			if (trimmed === "remember") {
				throw new Error("Usage: /role remember [--global|--project] <memory>");
			}
			if (trimmed === "save-memory") {
				await saveMemory(pi, state, ctx, true);
				return;
			}
			await switchRole(pi, state, trimmed, ctx);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state.activeRole) {
			return undefined;
		}
		const paths = resolveRolePaths({
			agentDir: getAgentDir(),
			cwd: ctx.cwd,
			role: state.activeRole,
			projectTrusted: ctx.isProjectTrusted(),
		});
		const section = formatRolePromptSection(await loadRoleBundle(paths));
		return section ? { systemPrompt: `${event.systemPrompt}\n\n${section}` } : undefined;
	});
}
