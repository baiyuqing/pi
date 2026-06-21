import type { ExtensionFactory } from "../extensions/index.ts";
import roleMemoryExtension from "./role-memory/index.ts";

export function getBuiltinExtensionFactories(): ExtensionFactory[] {
	return [roleMemoryExtension];
}
