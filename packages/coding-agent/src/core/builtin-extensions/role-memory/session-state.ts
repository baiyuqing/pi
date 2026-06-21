import type { SessionEntry } from "../../session-manager.ts";
import { assertRoleName } from "./paths.ts";
import { ROLE_MEMORY_CUSTOM_TYPE, type RoleStateEntryData } from "./types.ts";

function readRoleStateData(data: unknown): RoleStateEntryData | undefined {
	if (typeof data !== "object" || data === null) {
		return undefined;
	}
	const record = data as Record<string, unknown>;
	if (record.kind !== "state") {
		return undefined;
	}
	const activeRole = typeof record.activeRole === "string" ? assertRoleName(record.activeRole) : undefined;
	const lastExtractionLeafId =
		typeof record.lastExtractionLeafId === "string" || record.lastExtractionLeafId === null
			? record.lastExtractionLeafId
			: undefined;
	return { kind: "state", activeRole, lastExtractionLeafId };
}

export function restoreRoleState(entries: readonly SessionEntry[]): RoleStateEntryData {
	let restored: RoleStateEntryData = { kind: "state", activeRole: undefined };
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ROLE_MEMORY_CUSTOM_TYPE) {
			continue;
		}
		const data = readRoleStateData(entry.data);
		if (data) {
			restored = data;
		}
	}
	return restored;
}
