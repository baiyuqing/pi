import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getBuiltinExtensionFactories } from "../src/core/builtin-extensions/index.ts";
import roleMemoryExtension from "../src/core/builtin-extensions/role-memory/index.ts";
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

	it("/role remember appends a global memory bullet without provider call", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "memory.md", "Existing global memory\n");
			await harness.session.prompt("/role ops");
			harness.setResponses([fauxAssistantMessage("unused")]);

			await harness.session.prompt("/role remember Prefer kubectl for cluster checks.");

			expect(harness.getPendingResponseCount()).toBe(1);
			await expect(readFile(join(harness.tempDir, "agent", "roles", "ops", "memory.md"), "utf8")).resolves.toBe(
				"Existing global memory\n\n- Prefer kubectl for cluster checks.\n",
			);
		} finally {
			cleanup();
		}
	});

	it("/role remember --project appends trusted project memory", async () => {
		const { harness, cleanup } = await createRoleHarness();
		try {
			await writeRoleFile(join(harness.tempDir, "agent"), "ops", "profile.md", "Global ops profile");
			await harness.session.prompt("/role ops");
			harness.setResponses([fauxAssistantMessage("unused")]);

			await harness.session.prompt("/role remember --project Project cluster uses prod context.");

			expect(harness.getPendingResponseCount()).toBe(1);
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
