/**
 * MCP Bridge Extension
 *
 * Bridges local MCP servers into native Pi tools by speaking the MCP
 * JSON-RPC protocol over stdio. Each MCP tool is registered as a Pi tool so
 * the model can call it directly.
 *
 * Configured servers:
 *   - obscura   : stealth headless browser for AI agents (37 browser_* tools)
 *   - scrapling : stealth HTTP / real-browser scraping (13 tools)
 *
 * Commands:
 *   /mcp-status        - show server process + tool counts
 *   /mcp-restart       - restart all MCP servers and re-register tools
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Server definitions
// ---------------------------------------------------------------------------

interface McpServerDef {
	name: string;
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
	/** Optional prefix to namespace tools, avoids collisions. */
	toolPrefix?: string;
	/** Only expose tools whose name starts with one of these (empty = all). */
	only?: string[];
}

function findWorkerRoot(start: string): string | undefined {
	let dir = resolve(start);
	for (;;) {
		if (existsSync(join(dir, "scrapling-deep", "agent-skill", "research-contact", "SKILL.md"))) return dir;
		const parent = dirname(dir);
		if (parent === dir || dir === parse(dir).root) return undefined;
		dir = parent;
	}
}

const workerRoot = process.env.RESEARCH_CONTACT_REPO_ROOT ||
	findWorkerRoot(process.cwd()) || findWorkerRoot(dirname(fileURLToPath(import.meta.url)));
const scraplingRoot = workerRoot ? join(workerRoot, "scrapling-deep") : undefined;
const scraplingBin = process.env.SCRAPLING_MCP_BIN || (scraplingRoot
	? join(scraplingRoot, ".venv", process.platform === "win32" ? "Scripts" : "bin",
		process.platform === "win32" ? "scrapling-mcp.exe" : "scrapling-mcp")
	: "scrapling-mcp");
const obscuraBin = process.env.OBSCURA_BIN ||
	(existsSync("D:/Tools/obscura/obscura.exe") ? "D:/Tools/obscura/obscura.exe" : "obscura");

const SERVERS: McpServerDef[] = [
	{
		name: "obscura",
		command: obscuraBin,
		args: ["mcp", "--stealth"],
		toolPrefix: "obscura",
	},
	{
		name: "scrapling",
		command: scraplingBin,
		args: [],
		cwd: scraplingRoot,
		toolPrefix: "scrapling",
	},
];

// ---------------------------------------------------------------------------
// Minimal MCP stdio client
// ---------------------------------------------------------------------------

interface McpTool {
	name: string;
	description?: string;
	inputSchema?: {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
	};
}

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

class McpClient {
	readonly def: McpServerDef;
	private child?: ChildProcess;
	private buf = "";
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private initialized = false;
	private _tools: McpTool[] = [];
	private _lastError?: string;

	constructor(def: McpServerDef) {
		this.def = def;
	}

	get tools(): McpTool[] {
		return this._tools;
	}

	get lastError(): string | undefined {
		return this._lastError;
	}

	get running(): boolean {
		return !!this.child && !this.child.killed && this.initialized;
	}

	async start(): Promise<void> {
		this._lastError = undefined;
		if ((this.def.command.includes("/") || this.def.command.includes("\\")) && !existsSync(this.def.command)) {
			throw new Error(`${this.def.command} is not installed`);
		}
		const env = { ...process.env, ...(this.def.env ?? {}) };
		this.child = spawn(this.def.command, this.def.args, {
			cwd: this.def.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
		});

		this.child.stderr?.on("data", (d: Buffer) => {
			// Keep last stderr line for diagnostics, don't spam the UI.
			const text = d.toString();
			const trimmed = text.trim();
			if (trimmed) this._lastError = trimmed;
		});

		this.child.on("exit", (code) => {
			this.initialized = false;
			this.rejectPending(new Error(`MCP ${this.def.name} exited before answering`));
			if (code !== 0 && code !== null) {
				this._lastError = `exited with code ${code}`;
			}
		});

		this.child.stdout?.on("data", (d: Buffer) => this.onData(d.toString()));
		this.child.on("error", (err) => {
			this._lastError = err.message;
			this.rejectPending(err);
		});

		const initResult = (await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "pi-mcp-bridge", version: "1.0.0" },
		})) as { serverInfo?: { name?: string; version?: string } };

		this.notify("notifications/initialized", {});
		this.initialized = true;

		const listResult = (await this.request("tools/list", {})) as { tools?: McpTool[] };
		this._tools = listResult.tools ?? [];

		if (this.def.only && this.def.only.length > 0) {
			this._tools = this._tools.filter((t) => this.def.only!.some((p) => t.name.startsWith(p)));
		}

		void initResult;
	}

	stop(): void {
		this.initialized = false;
		this.rejectPending(new Error(`MCP ${this.def.name} stopped`));
		if (this.child) {
			try {
				this.child.kill();
			} catch {
				/* ignore */
			}
			this.child = undefined;
		}
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		return this.request("tools/call", { name, arguments: args });
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		let idx: number;
		while ((idx = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, idx);
			this.buf = this.buf.slice(idx + 1);
			if (!line.trim()) continue;
			let msg: JsonRpcMessage;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof msg.id === "number" && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				clearTimeout(p.timer);
				if (msg.error) p.reject(new Error(msg.error.message));
				else p.resolve(msg.result);
			}
		}
	}

	private notify(method: string, params: unknown): void {
		this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`MCP request timeout: ${method}`));
				}
			}, 60000);
			this.pending.set(id, { resolve, reject, timer });
			const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
			this.child?.stdin?.write(payload);
		});
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPiToolName(server: McpServerDef, mcpName: string): string {
	const sanitized = mcpName.replace(/[^a-zA-Z0-9_]/g, "_");
	// Browser tools already read well without the prefix (browser_navigate).
	if (server.name === "obscura" && sanitized.startsWith("browser_")) {
		return sanitized;
	}
	return `${server.toolPrefix ?? server.name}_${sanitized}`;
}

function jsonSchemaToTypeBox(schema: McpTool["inputSchema"]): ReturnType<typeof Type.Object> {
	const props: Record<string, unknown> = {};
	const properties = schema?.properties ?? {};
	const required = new Set(schema?.required ?? []);

	for (const [key, raw] of Object.entries(properties)) {
		props[key] = convertSchema(raw as Record<string, unknown>, required.has(key));
	}

	return Type.Object(props as Record<string, never>, { additionalProperties: true });
}

function convertSchema(node: Record<string, unknown>, required: boolean): unknown {
	const desc = typeof node.description === "string" ? node.description : undefined;
	const withDesc = <T extends object>(base: T): T =>
		desc ? ({ ...base, description: desc } as T) : base;

	let type = node.type;
	if (Array.isArray(type)) type = type.find((t) => t !== "null") ?? type[0];
	// enum without explicit type -> string enum
	if (!type && Array.isArray(node.enum)) type = "string";

	switch (type) {
		case "string":
			if (Array.isArray(node.enum)) {
				return withDesc(Type.Union(node.enum.map((v) => Type.Literal(String(v)))));
			}
			return withDesc(required ? Type.String() : Type.Optional(Type.String()));
		case "number":
		case "integer":
			return withDesc(required ? Type.Number() : Type.Optional(Type.Number()));
		case "boolean":
			return withDesc(required ? Type.Boolean() : Type.Optional(Type.Boolean()));
		case "array":
			return withDesc(
				(required ? Type.Array(Type.Any()) : Type.Optional(Type.Array(Type.Any()))),
			);
		case "object":
			return withDesc(
				(required ? Type.Object({}, { additionalProperties: true }) : Type.Optional(Type.Object({}, { additionalProperties: true }))),
			);
		default:
			// Unknown / union -> accept anything
			return withDesc(required ? Type.Any() : Type.Optional(Type.Any()));
	}
}

function resultToText(result: unknown): { text: string; isError: boolean } {
	if (!result || typeof result !== "object") {
		return { text: JSON.stringify(result ?? null, null, 2), isError: false };
	}
	const r = result as {
		isError?: boolean;
		content?: Array<Record<string, unknown>>;
	};
	const isError = !!r.isError;
	const parts: string[] = [];
	for (const item of r.content ?? []) {
		if (item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		} else if (item.type === "image") {
			parts.push(`[image: ${item.mimeType ?? "unknown"}]`);
		} else if (item.type === "resource" && item.resource) {
			parts.push(JSON.stringify(item.resource));
		} else {
			parts.push(JSON.stringify(item));
		}
	}
	return { text: parts.join("\n") || "(empty result)", isError };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function mcpBridgeExtension(pi: ExtensionAPI) {
	const clients = new Map<string, McpClient>();
	const registered = new Set<string>();

	const shutdown = () => {
		for (const c of clients.values()) c.stop();
		clients.clear();
	};

	async function registerServer(server: McpServerDef, ctx?: ExtensionContext): Promise<number> {
		let client = clients.get(server.name);
		if (!client) {
			client = new McpClient(server);
			clients.set(server.name, client);
		}
		await client.start();

		let count = 0;
		for (const tool of client.tools) {
			const toolName = toPiToolName(server, tool.name);
			if (registered.has(toolName)) continue;
			registered.add(toolName);

			const parameters = jsonSchemaToTypeBox(tool.inputSchema);
			pi.registerTool({
				name: toolName,
				label: `${server.name}: ${tool.name}`,
				description: `[MCP ${server.name}] ${tool.description ?? tool.name}`,
				parameters,
				async execute(_id, params, _signal, _onUpdate, _ctx) {
					const res = await client!.callTool(tool.name, params as Record<string, unknown>);
					const { text, isError } = resultToText(res);
					if (isError) {
						throw new Error(text);
					}
					return {
						content: [{ type: "text", text }],
						details: { server: server.name, tool: tool.name },
					};
				},
			});
			count++;
		}
		ctx?.ui.notify(`MCP ${server.name}: ${count} tool(s) registered`, "info");
		return count;
	}

	pi.on("session_start", async (_event, ctx) => {
		for (const server of SERVERS) {
			try {
				await registerServer(server, ctx);
			} catch (err) {
				ctx.ui.notify(
					`MCP ${server.name} failed: ${(err as Error).message}`,
					"error",
				);
			}
		}
	});

	pi.on("session_shutdown", () => {
		shutdown();
	});

	pi.registerCommand("mcp-status", {
		description: "Show status of bridged MCP servers",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			for (const server of SERVERS) {
				const c = clients.get(server.name);
				const status = c?.running ? "running" : "stopped";
				lines.push(
					`${server.name}: ${status}, ${c?.tools.length ?? 0} tools` +
						(c?.lastError ? ` (last: ${c.lastError})` : ""),
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("mcp-restart", {
		description: "Restart all bridged MCP servers and re-register tools",
		handler: async (_args, ctx) => {
			for (const c of clients.values()) c.stop();
			clients.clear();
			registered.clear();
			for (const server of SERVERS) {
				try {
					await registerServer(server, ctx);
				} catch (err) {
					ctx.ui.notify(`MCP ${server.name} failed: ${(err as Error).message}`, "error");
				}
			}
		},
	});
}
