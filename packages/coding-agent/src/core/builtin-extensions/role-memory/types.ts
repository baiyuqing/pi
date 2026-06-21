export const ROLE_MEMORY_CUSTOM_TYPE = "role-memory";

export interface RoleStateEntryData {
	kind: "state";
	activeRole: string | undefined;
	lastExtractionLeafId?: string | null;
}

export interface RoleScopeFiles {
	profile: string;
	memory: string;
}

export interface RolePaths {
	role: string;
	global: RoleScopeFiles;
	project?: RoleScopeFiles;
}

export interface RoleScopeContent {
	profile?: string;
	memory?: string;
}

export interface RoleBundle {
	role: string;
	global: RoleScopeContent;
	project?: RoleScopeContent;
}

export interface MemoryExtractionResult {
	globalMemory: string;
	projectMemory: string;
}
