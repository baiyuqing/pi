import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import type { RolePaths } from "./types.ts";

const ROLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidRoleName(name: string): boolean {
	return ROLE_NAME_RE.test(name);
}

export function assertRoleName(name: string): string {
	const normalized = name.trim().toLowerCase();
	if (!isValidRoleName(normalized)) {
		throw new Error(`Invalid role name "${name}". Use lowercase letters, numbers, and hyphens only.`);
	}
	return normalized;
}

export function resolveRolePaths(input: {
	agentDir: string;
	cwd: string;
	role: string;
	projectTrusted: boolean;
}): RolePaths {
	const role = assertRoleName(input.role);
	const globalRoleDir = join(input.agentDir, "roles", role);
	const projectRoleDir = join(input.cwd, CONFIG_DIR_NAME, "roles", role);
	return {
		role,
		global: {
			profile: join(globalRoleDir, "profile.md"),
			memory: join(globalRoleDir, "memory.md"),
		},
		...(input.projectTrusted
			? {
					project: {
						profile: join(projectRoleDir, "profile.md"),
						memory: join(projectRoleDir, "memory.md"),
					},
				}
			: {}),
	};
}
