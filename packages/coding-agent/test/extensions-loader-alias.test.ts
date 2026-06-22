import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";

describe("extension loader aliases", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extension-loader-alias-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads extensions that import pi-ai root compat API", async () => {
		const extensionPath = path.join(tempDir, "uses-pi-ai-root.ts");
		fs.writeFileSync(
			extensionPath,
			`
				import { DynamicBorder } from "@earendil-works/pi-coding-agent";
				import { getModel } from "@earendil-works/pi-ai";

				export default function(pi) {
					new DynamicBorder();
					getModel("anthropic", "claude-sonnet-4-5");
					pi.registerCommand("alias-ok", { handler: async () => {} });
				}
			`,
		);

		const result = await loadExtensions([extensionPath], tempDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("alias-ok")).toBe(true);
	});
});
