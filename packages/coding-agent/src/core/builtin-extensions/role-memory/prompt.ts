import type { RoleBundle, RoleScopeContent } from "./types.ts";

function appendScope(lines: string[], label: string, scope: RoleScopeContent | undefined): void {
	if (!scope) {
		return;
	}
	if (scope.profile?.trim()) {
		lines.push(`### ${label} Profile`, scope.profile.trim(), "");
	}
	if (scope.memory?.trim()) {
		lines.push(`### ${label} Memory`, scope.memory.trim(), "");
	}
}

export function formatRolePromptSection(bundle: RoleBundle): string | undefined {
	const lines = [`## Active Role: ${bundle.role}`, ""];
	appendScope(lines, "Global", bundle.global);
	appendScope(lines, "Project", bundle.project);
	if (lines.length <= 2) {
		lines.push(`You are operating as the ${bundle.role} role.`);
	}
	return lines.join("\n").trim();
}
