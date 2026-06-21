import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertRoleName, isValidRoleName, resolveRolePaths } from "../src/core/builtin-extensions/role-memory/paths.ts";
import {
	createGlobalRoleProfile,
	listRoles,
	loadRoleBundle,
	writeMemoryAtomic,
} from "../src/core/builtin-extensions/role-memory/storage.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "pi-role-memory-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("role memory paths", () => {
	it("accepts slug role names and rejects unsafe names", () => {
		expect(isValidRoleName("developer")).toBe(true);
		expect(isValidRoleName("sre-prod")).toBe(true);
		expect(isValidRoleName("ops2")).toBe(true);
		expect(isValidRoleName("../ops")).toBe(false);
		expect(isValidRoleName("ops/prod")).toBe(false);
		expect(isValidRoleName("ops prod")).toBe(false);
		expect(isValidRoleName(".hidden")).toBe(false);
		expect(() => assertRoleName("../ops")).toThrow("Invalid role name");
	});

	it("omits project paths when project is not trusted", () =>
		withTempDir(async (dir) => {
			const paths = resolveRolePaths({
				agentDir: join(dir, "agent"),
				cwd: join(dir, "repo"),
				role: "ops",
				projectTrusted: false,
			});

			expect(paths.global.profile.endsWith("/agent/roles/ops/profile.md")).toBe(true);
			expect(paths.global.memory.endsWith("/agent/roles/ops/memory.md")).toBe(true);
			expect(paths.project).toBeUndefined();
		}));

	it("includes project paths when project is trusted", () =>
		withTempDir(async (dir) => {
			const paths = resolveRolePaths({
				agentDir: join(dir, "agent"),
				cwd: join(dir, "repo"),
				role: "ops",
				projectTrusted: true,
			});

			expect(paths.project?.profile.endsWith("/repo/.pi/roles/ops/profile.md")).toBe(true);
			expect(paths.project?.memory.endsWith("/repo/.pi/roles/ops/memory.md")).toBe(true);
		}));
});

describe("role memory storage", () => {
	it("loads global and trusted project profile and memory", () =>
		withTempDir(async (dir) => {
			const paths = resolveRolePaths({
				agentDir: join(dir, "agent"),
				cwd: join(dir, "repo"),
				role: "ops",
				projectTrusted: true,
			});
			await writeMemoryAtomic(paths.global.profile, "global profile");
			await writeMemoryAtomic(paths.global.memory, "global memory");
			await writeMemoryAtomic(paths.project!.profile, "project profile");
			await writeMemoryAtomic(paths.project!.memory, "project memory");

			const bundle = await loadRoleBundle(paths);

			expect(bundle.global.profile).toBe("global profile");
			expect(bundle.global.memory).toBe("global memory");
			expect(bundle.project?.profile).toBe("project profile");
			expect(bundle.project?.memory).toBe("project memory");
		}));

	it("lists roles from global and trusted project directories", () =>
		withTempDir(async (dir) => {
			await writeFile(join(dir, "sentinel"), "x");
			const devPaths = resolveRolePaths({
				agentDir: join(dir, "agent"),
				cwd: join(dir, "repo"),
				role: "developer",
				projectTrusted: true,
			});
			const opsPaths = resolveRolePaths({
				agentDir: join(dir, "agent"),
				cwd: join(dir, "repo"),
				role: "ops",
				projectTrusted: true,
			});
			await writeMemoryAtomic(devPaths.global.profile, "dev");
			await writeMemoryAtomic(opsPaths.project!.profile, "ops");

			await expect(
				listRoles({ agentDir: join(dir, "agent"), cwd: join(dir, "repo"), projectTrusted: true }),
			).resolves.toEqual(["developer", "ops"]);
			await expect(
				listRoles({ agentDir: join(dir, "agent"), cwd: join(dir, "repo"), projectTrusted: false }),
			).resolves.toEqual(["developer"]);
		}));

	it("creates global role profile from description", () =>
		withTempDir(async (dir) => {
			const paths = resolveRolePaths({
				agentDir: join(dir, "agent"),
				cwd: join(dir, "repo"),
				role: "ops",
				projectTrusted: false,
			});
			await createGlobalRoleProfile(paths, "Operate production systems cautiously.");

			await expect(readFile(paths.global.profile, "utf8")).resolves.toContain(
				"Operate production systems cautiously.",
			);
		}));
});
