import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import { isValidRoleName } from "./paths.ts";
import type { RoleBundle, RolePaths, RoleScopeContent } from "./types.ts";

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readOptionalText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return undefined;
		}
		throw error;
	}
}

async function loadScope(profile: string, memory: string): Promise<RoleScopeContent> {
	return {
		profile: await readOptionalText(profile),
		memory: await readOptionalText(memory),
	};
}

export async function loadRoleBundle(paths: RolePaths): Promise<RoleBundle> {
	return {
		role: paths.role,
		global: await loadScope(paths.global.profile, paths.global.memory),
		...(paths.project ? { project: await loadScope(paths.project.profile, paths.project.memory) } : {}),
	};
}

async function listRoleNames(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory() && isValidRoleName(entry.name)).map((entry) => entry.name);
	} catch (error) {
		if (isEnoent(error)) {
			return [];
		}
		throw error;
	}
}

export async function listRoles(input: { agentDir: string; cwd: string; projectTrusted: boolean }): Promise<string[]> {
	const names = new Set<string>();
	for (const name of await listRoleNames(join(input.agentDir, "roles"))) {
		names.add(name);
	}
	if (input.projectTrusted) {
		for (const name of await listRoleNames(join(input.cwd, CONFIG_DIR_NAME, "roles"))) {
			names.add(name);
		}
	}
	return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export async function writeMemoryAtomic(filePath: string, content: string): Promise<void> {
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true });
	const release = await lockfile.lock(dir, { realpath: false });
	const tempPath = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	try {
		await writeFile(tempPath, content, "utf8");
		await rename(tempPath, filePath);
	} finally {
		await rm(tempPath, { force: true });
		await release();
	}
}

export async function appendMemoryBlock(filePath: string, text: string): Promise<void> {
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true });
	const release = await lockfile.lock(dir, { realpath: false });
	const tempPath = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	try {
		const existing = (await readOptionalText(filePath)) ?? "";
		const block = `${text.trim()}\n`;
		const content = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}` : block;
		await writeFile(tempPath, content, "utf8");
		await rename(tempPath, filePath);
	} finally {
		await rm(tempPath, { force: true });
		await release();
	}
}

export async function appendMemoryBullet(filePath: string, text: string): Promise<void> {
	await appendMemoryBlock(filePath, `- ${text.trim()}`);
}

export async function createGlobalRoleProfile(paths: RolePaths, description: string): Promise<void> {
	if (existsSync(paths.global.profile)) {
		return;
	}
	const content = [`# ${paths.role}`, "", description.trim(), ""].join("\n");
	await writeMemoryAtomic(paths.global.profile, content);
}
