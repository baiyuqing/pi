import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../../src/core/slash-commands.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../../src/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type NewSessionCommandContext = {
	session: {
		isStreaming: boolean;
		setSessionName: (name: string) => void;
	};
	runtimeHost: {
		newSession: () => Promise<{ cancelled: boolean }>;
	};
	loadingAnimation?: { stop: () => void };
	statusContainer: { clear: () => void };
	ui: {
		terminal: { clearScreen: () => void };
		invalidate: () => void;
		requestRender: () => void;
	};
	renderCurrentSessionState: () => void;
	chatContainer: { addChild: (child: unknown) => void };
	showWarning: (message: string) => void;
	handleFatalRuntimeError: (message: string, error: unknown) => Promise<void>;
};

type InteractiveModePrototype = {
	handleNewSessionCommand(
		this: NewSessionCommandContext,
		options: {
			clearTerminal: boolean;
			previousSessionName?: string;
			successMessage: string;
		},
	): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createNewSessionCommandContext(overrides?: Partial<NewSessionCommandContext>): NewSessionCommandContext {
	const newSession = vi.fn(async () => ({ cancelled: false }));
	const setSessionName = vi.fn();
	const clearScreen = vi.fn();
	const invalidate = vi.fn();
	const requestRender = vi.fn();
	const renderCurrentSessionState = vi.fn();
	const showWarning = vi.fn();
	const statusClear = vi.fn();
	const addChild = vi.fn();

	return {
		session: {
			isStreaming: false,
			setSessionName,
		},
		runtimeHost: { newSession },
		statusContainer: { clear: statusClear },
		ui: {
			terminal: { clearScreen },
			invalidate,
			requestRender,
		},
		renderCurrentSessionState,
		chatContainer: { addChild },
		showWarning,
		handleFatalRuntimeError: vi.fn(async () => {}),
		...overrides,
	};
}

describe("/clear command", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("registers clear, reset, and updated new in builtin slash commands", () => {
		const byName = Object.fromEntries(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command.description]));
		expect(byName.clear).toBe("Clear terminal and start a fresh session");
		expect(byName.reset).toBe("Alias for /clear");
		expect(byName.new).toBe("Start a new session (keeps terminal scrollback)");
	});

	it("rejects new session while streaming", async () => {
		const context = createNewSessionCommandContext({
			session: {
				isStreaming: true,
				setSessionName: vi.fn(),
			},
		});

		await interactiveModePrototype.handleNewSessionCommand.call(context, {
			clearTerminal: true,
			successMessage: "Context cleared",
		});

		expect(context.showWarning).toHaveBeenCalledWith(
			"Cannot start a new session while the agent is working (press Escape to abort)",
		);
		expect(context.runtimeHost.newSession).not.toHaveBeenCalled();
		expect(context.ui.terminal.clearScreen).not.toHaveBeenCalled();
	});

	it("clears the terminal for /clear semantics", async () => {
		const context = createNewSessionCommandContext();

		await interactiveModePrototype.handleNewSessionCommand.call(context, {
			clearTerminal: true,
			successMessage: "Context cleared",
		});

		expect(context.runtimeHost.newSession).toHaveBeenCalled();
		expect(context.ui.terminal.clearScreen).toHaveBeenCalled();
		expect(context.ui.invalidate).toHaveBeenCalled();
		expect(context.renderCurrentSessionState).toHaveBeenCalled();
	});

	it("does not clear the terminal for /new semantics", async () => {
		const context = createNewSessionCommandContext();

		await interactiveModePrototype.handleNewSessionCommand.call(context, {
			clearTerminal: false,
			successMessage: "New session started",
		});

		expect(context.runtimeHost.newSession).toHaveBeenCalled();
		expect(context.ui.terminal.clearScreen).not.toHaveBeenCalled();
		expect(context.ui.invalidate).not.toHaveBeenCalled();
	});

	it("names the previous session before starting a new one", async () => {
		const context = createNewSessionCommandContext();

		await interactiveModePrototype.handleNewSessionCommand.call(context, {
			clearTerminal: true,
			previousSessionName: "auth refactor",
			successMessage: "Context cleared",
		});

		expect(context.session.setSessionName).toHaveBeenCalledWith("auth refactor");
		expect(context.runtimeHost.newSession).toHaveBeenCalled();
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-clear-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		faux.setResponses([fauxAssistantMessage("hello")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime };
	}

	it("starts a fresh session and preserves the named previous session file", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile!;

		runtime.session.setSessionName("auth refactor");
		const result = await runtime.newSession();
		expect(result.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session.messages).toEqual([]);

		const reopened = SessionManager.open(originalSessionFile);
		expect(reopened.getSessionName()).toBe("auth refactor");
	});
});
