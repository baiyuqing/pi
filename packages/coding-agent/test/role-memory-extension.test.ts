import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getBuiltinExtensionFactories } from "../src/core/builtin-extensions/index.ts";
import roleMemoryExtension from "../src/core/builtin-extensions/role-memory/index.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./suite/harness.ts";

async function writeRoleFile(
	base: string,
	role: string,
	file: "profile.md" | "memory.md",
	content: string,
): Promise<void> {
	const dir = join(base, "roles", role);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, file), content, "utf8");
}

async function createRoleHarness(options: HarnessOptions = {}): Promise<{ harness: Harness; cleanup: () => void }> {
	const harness = await createHarness({
		...options,
		extensionFactories: [...(options.extensionFactories ?? []), roleMemoryExtension],
	});
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = join(harness.tempDir, "agent");
	return {
		harness,
		cleanup() {
			harness.cleanup();
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
		},
	};
}

function createRoleUiContext(options: {
	editor?: (title: string, prefill: string | undefined) => string | undefined;
	notify?: (message: string, type: "info" | "warning" | "error" | undefined) => void;
}): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: options.notify ?? (() => {}),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async (title, prefill) => options.editor?.(title, prefill),
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: (_theme: string | Theme) => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

describe("role memory extension", () => {
	it("switches to an existing role and appends role context to the system prompt", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			await writeRoleFile(join(harness.tempDir, ".pi"), "ops", "profile.md", "Project ops profile");
			await writeRoleFile(join(harness.tempDir, ".pi"), "ops", "memory.md", "Project ops memory");
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "memory.md", "Global ops memory");

			await harness.session.prompt("/role ops");
			harness.setResponses([
				(context) => {
					expect(context.systemPrompt ?? "").toContain("## Active Role: ops");
					expect(context.systemPrompt ?? "").toContain("Global ops profile");
					expect(context.systemPrompt ?? "").toContain("Global ops memory");
					expect(context.systemPrompt ?? "").toContain("Project ops profile");
					expect(context.systemPrompt ?? "").toContain("Project ops memory");
					return fauxAssistantMessage("ok");
				},
			]);

			await harness.session.prompt("hello");

			expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		} finally {
			cleanup();
		}
	});

	it("creates a global role profile with /role create", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			await harness.session.prompt("/role create ops Operate production systems cautiously.");
			await expect(
				readFile(join(harness.tempDir, "agent", "roles", "ops", "profile.md"), "utf8"),
			).resolves.toContain("Operate production systems cautiously.");
		} finally {
			cleanup();
		}
	});

	it("completes role names from global and trusted project roles", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await writeRoleFile(join(harness.tempDir, ".pi"), "frontend", "profile.md", "Project frontend profile");
			await harness.session.bindExtensions({});
			const command = harness.session.extensionRunner.getCommand("role");
			expect(command?.getArgumentCompletions).toBeDefined();

			const matchingCompletions = await command?.getArgumentCompletions?.("o");
			expect((matchingCompletions ?? []).map((item) => item.value)).toEqual(["ops"]);

			const allCompletions = await command?.getArgumentCompletions?.("");
			expect((allCompletions ?? []).map((item) => item.value)).toEqual(expect.arrayContaining(["frontend", "ops"]));
		} finally {
			cleanup();
		}
	});

	it("completes role subcommands and remember scope flags", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			await harness.session.bindExtensions({});
			const command = harness.session.extensionRunner.getCommand("role");
			expect(command?.getArgumentCompletions).toBeDefined();

			const subcommandCompletions = await command?.getArgumentCompletions?.("rem");
			expect((subcommandCompletions ?? []).map((item) => item.value)).toEqual(["remember "]);

			const projectFlagCompletions = await command?.getArgumentCompletions?.("remember --p");
			expect((projectFlagCompletions ?? []).map((item) => item.value)).toEqual(["remember --project "]);

			const saveCompletions = await command?.getArgumentCompletions?.("sav");
			expect((saveCompletions ?? []).map((item) => item.value)).toEqual(["save-memory"]);
		} finally {
			cleanup();
		}
	});

	it("does not complete project roles when the project is untrusted", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			harness.settingsManager.setProjectTrusted(false);
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await writeRoleFile(join(harness.tempDir, ".pi"), "frontend", "profile.md", "Project frontend profile");
			await harness.session.bindExtensions({});
			const command = harness.session.extensionRunner.getCommand("role");
			expect(command?.getArgumentCompletions).toBeDefined();

			const allCompletions = await command?.getArgumentCompletions?.("");
			const values = (allCompletions ?? []).map((item) => item.value);
			expect(values).toContain("ops");
			expect(values).not.toContain("frontend");
		} finally {
			cleanup();
		}
	});

	it("does not send /role commands to the provider", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			harness.setResponses([fauxAssistantMessage("unused")]);
			await harness.session.prompt("/role create ops Operate production systems cautiously.");
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.messages).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("restores active role from session custom entries", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			harness.sessionManager.appendCustomEntry("role-memory", { kind: "state", activeRole: "ops" });
			await harness.session.reload();
			harness.setResponses([
				(context) => {
					expect(context.systemPrompt ?? "").toContain("## Active Role: ops");
					return fauxAssistantMessage("ok");
				},
			]);

			await harness.session.prompt("hello");
			expect(getMessageText(harness.session.messages[0])).toBe("hello");
		} finally {
			cleanup();
		}
	});

	it("/role remember extracts candidate memory with LLM and saves edited global memory", async () => {
		const { harness, cleanup } = await createRoleHarness();
		const editorCalls: Array<{ title: string; prefill: string | undefined }> = [];
		try {
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "memory.md", "Existing global memory\n");
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: createRoleUiContext({
					editor: (title, prefill) => {
						editorCalls.push({ title, prefill });
						return "- Edited cluster memory.";
					},
				}),
			});
			await harness.session.prompt("/role ops");
			harness.setResponses([fauxAssistantMessage("We agreed to use kubectl for cluster checks.")]);
			await harness.session.prompt("Let's use kubectl for cluster checks.");
			harness.setResponses([fauxAssistantMessage("- Use kubectl for cluster checks.")]);

			await harness.session.prompt("/role remember 刚才讨论的内容");

			expect(harness.getPendingResponseCount()).toBe(0);
			expect(editorCalls).toEqual([
				{ title: "Review global role memory for ops", prefill: "- Use kubectl for cluster checks." },
			]);
			expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
			await expect(readFile(join(harness.tempDir, "agent", "roles", "ops", "memory.md"), "utf8")).resolves.toBe(
				"Existing global memory\n\n- Edited cluster memory.\n",
			);
		} finally {
			cleanup();
		}
	});

	it("/role remember --project extracts candidate memory and writes only trusted project memory", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: createRoleUiContext({ editor: () => "- Project cluster uses prod context." }),
			});
			await harness.session.prompt("/role ops");
			harness.setResponses([fauxAssistantMessage("- Project cluster uses prod context.")]);

			await harness.session.prompt("/role remember --project Project cluster context from discussion.");

			expect(harness.getPendingResponseCount()).toBe(0);
			await expect(readFile(join(harness.tempDir, ".pi", "roles", "ops", "memory.md"), "utf8")).resolves.toBe(
				"- Project cluster uses prod context.\n",
			);
			await expect(
				readFile(join(harness.tempDir, "agent", "roles", "ops", "memory.md"), "utf8"),
			).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			cleanup();
		}
	});

	it("/role remember does not write or call the LLM when confirmation UI is unavailable", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await harness.session.prompt("/role ops");
			harness.setResponses([fauxAssistantMessage("- Should not be consumed")]);

			await harness.session.prompt("/role remember Save the latest discussion.");

			expect(harness.getPendingResponseCount()).toBe(1);
			await expect(
				readFile(join(harness.tempDir, "agent", "roles", "ops", "memory.md"), "utf8"),
			).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			cleanup();
		}
	});

	it("/role remember --project does not write when project is untrusted", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			harness.settingsManager.setProjectTrusted(false);
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await harness.session.prompt("/role ops");

			await harness.session.prompt("/role remember --project Do not write this.");

			await expect(
				readFile(join(harness.tempDir, ".pi", "roles", "ops", "memory.md"), "utf8"),
			).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			cleanup();
		}
	});

	it("/role save-memory writes global and project memory", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await harness.session.prompt("/role ops");
			harness.setResponses([fauxAssistantMessage("remembered")]);
			await harness.session.prompt("Remember that I prefer kubectl for cluster checks.");
			harness.setResponses([
				fauxAssistantMessage(
					JSON.stringify({
						globalMemory: "Global memory updated",
						projectMemory: "Project memory updated",
					}),
				),
			]);

			await harness.session.prompt("/role save-memory");

			await expect(readFile(join(harness.tempDir, "agent", "roles", "ops", "memory.md"), "utf8")).resolves.toBe(
				"Global memory updated\n",
			);
			await expect(readFile(join(harness.tempDir, ".pi", "roles", "ops", "memory.md"), "utf8")).resolves.toBe(
				"Project memory updated\n",
			);
		} finally {
			cleanup();
		}
	});

	it("skips project memory writes when project is untrusted", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			harness.settingsManager.setProjectTrusted(false);
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await harness.session.prompt("/role ops");
			harness.setResponses([
				(context) => {
					expect(context.systemPrompt ?? "").toContain("## Active Role: ops");
					return fauxAssistantMessage("remembered");
				},
			]);
			await harness.session.prompt("Remember that I prefer kubectl for cluster checks.");
			expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
			harness.setResponses([
				fauxAssistantMessage(JSON.stringify({ globalMemory: "Global only", projectMemory: "Do not write" })),
			]);

			await harness.session.prompt("/role save-memory");
			expect(harness.getPendingResponseCount()).toBe(0);

			await expect(readFile(join(harness.tempDir, "agent", "roles", "ops", "memory.md"), "utf8")).resolves.toBe(
				"Global only\n",
			);
			await expect(
				readFile(join(harness.tempDir, ".pi", "roles", "ops", "memory.md"), "utf8"),
			).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			cleanup();
		}
	});

	it("does not run shutdown memory extraction on reload", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await harness.session.prompt("/role ops");
			harness.setResponses([
				fauxAssistantMessage(JSON.stringify({ globalMemory: "Should not be consumed", projectMemory: "No" })),
			]);

			await harness.session.reload();

			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("exposes role memory as a bundled extension factory", () => {
		const factories = getBuiltinExtensionFactories();
		expect(factories).toContain(roleMemoryExtension);
	});
});
