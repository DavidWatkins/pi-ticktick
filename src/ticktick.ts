/**
 * pi-ticktick - TickTick task manager integration for pi
 *
 * Wraps the TickTick Open API v1 into pi tools the LLM can call naturally.
 *
 * Setup:
 *   1. Get a Bearer token from TickTick:
 *      Web app → avatar → Settings → Account → API Token
 *   2. Create config at ~/.pi/agent/pi-ticktick-config.json:
 *      {"token": "your-bearer-token-here"}
 *   3. Copy dist/ticktick.mjs to ~/.pi/agent/extensions/ticktick.mjs
 *   4. The tools appear automatically in your next session.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TickTickConfig {
	token: string;
}

interface TickTickTask {
	id: string;
	title: string;
	content: string;
	project: string;
	list: string;
	order: number;
	reminder?: number;
	repeat?: string;
	priority?: number; // 0=none, 1=none, 2=low, 3=medium, 4=high (varies by endpoint)
	dueDate?: string;
	scheduledDate?: string;
	context?: string;
	tags?: string[];
	type: string;
}

interface TickTickList {
	listId: string;
	listName: string;
	color: string;
	sort: number;
	listType: number;
}

interface TickTickProject {
	projectId: string;
	projectName: string;
	projectColor: string;
	projectOrder: number;
	projectType: number;
	shared: boolean;
}

interface TickTickHabit {
	habitId: string;
	title: string;
	description: string;
	cycleType: string;
	frequency?: number;
	timeZone?: string;
	remind?: string;
	reminder?: boolean;
	isEnabled: boolean;
	totalScore: number;
}

interface TickTickFocusRecord {
	userId: string;
	time: string;
	type: string;
	content: string;
	duration: number;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const API_BASE = "https://api.ticktick.com/open/v1";

async function ticktickRequest<T>(
	ctx: ExtensionContext,
	path: string,
	method: string = "GET",
	body?: unknown,
): Promise<{ ok: boolean; data?: T; error?: string }> {
	const config = loadConfig(ctx);
	if (!config.ok) {
		return { ok: false, error: config.error ?? "TickTick not configured. See /ticktick-setup for help." };
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${config.token}`,
		"Content-Type": "application/json",
	};

	try {
		const opts: RequestInit = { method, headers };
		if (body !== undefined && (method === "POST" || method === "PUT")) {
			opts.body = JSON.stringify(body);
		}

		const resp = await fetch(`${API_BASE}${path}`, opts);

		if (!resp.ok) {
			const text = await resp.text().catch(() => "");
			return {
				ok: false,
				error: `TickTick API ${resp.status}: ${text || resp.statusText}`,
			};
		}

		const data: T = await resp.json();
		return { ok: true, data };
	} catch (e) {
		return { ok: false, error: `TickTick request failed: ${(e as Error).message}` };
	}
}

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------

const CONFIG_PATH = `${process.env.HOME}/.pi/agent/pi-ticktick-config.json`;

function loadConfig(_ctx: ExtensionContext): { ok: boolean; token?: string; error?: string } {
	const cache = getGlobalConfigCache();
	if (cache.token) return { ok: true, token: cache.token };

	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const config: TickTickConfig = JSON.parse(raw);
		cache.token = config.token;
		return { ok: true, token: config.token };
	} catch {
		return {
			ok: false,
			error: `Config not found at ${CONFIG_PATH}. Run /ticktick-setup to configure.`,
		};
	}
}

function loadConfigFile(): { ok: boolean; token?: string; error?: string } {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const config: TickTickConfig = JSON.parse(raw);
		return { ok: true, token: config.token };
	} catch {
		return {
			ok: false,
			error: `Config not found at ${CONFIG_PATH}.`,
		};
	}
}

function saveConfigFile(config: TickTickConfig): boolean {
	try {
		const dir = dirname(CONFIG_PATH);
		mkdirSync(dir, { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
		return true;
	} catch {
		return false;
	}
}

// Global cache so we don't re-read the file every tool call
interface ConfigCache {
	token?: string;
}

let configCache: ConfigCache = {};

function getGlobalConfigCache(): ConfigCache {
	// Re-read from global if cache is empty (handles multi-session)
	if (!configCache.token) {
		const fileResult = loadConfigFile();
		if (fileResult.ok) configCache.token = fileResult.token;
	}
	return configCache;
}

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const TaskQueryParams = Type.Object({
	action: StringEnum(["list_tasks", "get_task"] as const),
	taskId: Type.Optional(
		Type.String({ description: "Task ID (required for get_task)" })
	),
	project: Type.Optional(
		Type.String({ description: "Project ID (list or project identifier)" })
	),
	list: Type.Optional(
		Type.String({ description: "List ID (inbox, collection, or project)" })
	),
	done: Type.Optional(
		Type.Boolean({ description: "Filter by completion status (true=completed, false=active)" })
	),
	priority: Type.Optional(
		Type.Number({ description: "Priority filter: 0=none, 1=none, 2=low, 3=medium, 4=high" })
	),
	dueDateStart: Type.Optional(
		Type.String({ description: "Filter tasks due from this date (YYYY-MM-DD)" })
	),
	dueDateEnd: Type.Optional(
		Type.String({ description: "Filter tasks due until this date (YYYY-MM-DD)" })
	),
	hasReminder: Type.Optional(
		Type.Boolean({ description: "Filter tasks that have a reminder set" })
	),
	search: Type.Optional(
		Type.String({ description: "Search tasks by content/title" })
	),
});

const CreateTaskParams = Type.Object({
	action: StringEnum(["create_task"] as const),
	title: Type.String({ description: "Task title/subject" }),
	content: Type.Optional(
		Type.String({ description: "Task description/body content" })
	),
	project: Type.Optional(
		Type.String({ description: "Project ID to add the task to" })
	),
	list: Type.Optional(
		Type.String({ description: "List ID (e.g., 'inbox', 'collection', or a specific list)" })
	),
	priority: Type.Optional(
		Type.Number({ description: "Priority: 0=none, 1=none, 2=low, 3=medium, 4=high" })
	),
	dueDate: Type.Optional(
		Type.String({ description: "Due date (YYYY-MM-DD, or e.g. 'tomorrow', 'today', '2025-06-15')" })
	),
	scheduledDate: Type.Optional(
		Type.String({ description: "Scheduled date when task becomes visible (YYYY-MM-DD)" })
	),
	context: Type.Optional(
		Type.String({ description: "Context/location tag" })
	),
	tags: Type.Optional(
		Type.Array(Type.String(), { description: "List of tags" })
	),
	reminder: Type.Optional(
		Type.String({ description: "Reminder time offset (e.g. '-5m', '-1h', '-1d')" })
	),
});

const UpdateTaskParams = Type.Object({
	action: StringEnum(["update_task"] as const),
	taskId: Type.String({ description: "Task ID to update" }),
	title: Type.Optional(Type.String({ description: "New title" })),
	content: Type.Optional(Type.String({ description: "New description" })),
	project: Type.Optional(Type.String({ description: "New project ID" })),
	list: Type.Optional(Type.String({ description: "New list ID" })),
	priority: Type.Optional(Type.Number({ description: "New priority: 0=none, 1=none, 2=low, 3=medium, 4=high" })),
	dueDate: Type.Optional(Type.String({ description: "New due date (YYYY-MM-DD)" })),
	scheduledDate: Type.Optional(Type.String({ description: "New scheduled date (YYYY-MM-DD)" })),
	context: Type.Optional(Type.String({ description: "New context tag" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "New list of tags" })),
	reminder: Type.Optional(Type.String({ description: "New reminder (e.g. '-5m', '-1h')" })),
});

const DoneTaskParams = Type.Object({
	action: StringEnum(["done_task"] as const),
	taskId: Type.String({ description: "Task ID to mark as completed" }),
});

const ListParams = Type.Object({
	action: StringEnum(["list_lists", "get_list", "create_list", "update_list"] as const),
	listId: Type.Optional(
		Type.String({ description: "List ID (required for get_list, update_list, and delete operations)" })
	),
	listName: Type.Optional(
		Type.String({ description: "List name (required for create_list, optional for update_list)" })
	),
	listType: Type.Optional(
		Type.Number({ description: "List type: 0=inbox, 1=collection, 2=project" })
	),
	color: Type.Optional(
		Type.String({ description: "List color (e.g. '#FF5722')" })
	),
	sort: Type.Optional(
		Type.Number({ description: "Sort order" })
	),
});

const ProjectParams = Type.Object({
	action: StringEnum(["list_projects", "get_project", "create_project", "update_project"] as const),
	projectId: Type.Optional(
		Type.String({ description: "Project ID (required for get_project and update_project)" })
	),
	projectName: Type.Optional(
		Type.String({ description: "Project name (required for create_project, optional for update_project)" })
	),
	description: Type.Optional(Type.String({ description: "Project description" })),
	projectType: Type.Optional(
		Type.Number({ description: "Project type: 0=personal, 1=shared" })
	),
	projectColor: Type.Optional(
		Type.String({ description: "Project color (e.g. '#FF5722')" })
	),
	projectOrder: Type.Optional(
		Type.Number({ description: "Project sort order" })
	),
});

const HabitParams = Type.Object({
	action: StringEnum(["list_habits", "get_habit", "create_habit", "update_habit"] as const),
	habitId: Type.Optional(
		Type.String({ description: "Habit ID (required for get_habit, update_habit)" })
	),
	habitName: Type.Optional(
		Type.String({ description: "Habit name/title (required for create_habit, optional for update_habit)" })
	),
	description: Type.Optional(Type.String({ description: "Habit description" })),
	cycleType: Type.Optional(
		Type.String({ description: "Cycle type: d=day, w=week, m=month, y=year, bi=biweekly, q=quarterly" })
	),
	frequency: Type.Optional(
		Type.Number({ description: "Frequency (e.g. 2 for 'every 2 days')" })
	),
	timeZone: Type.Optional(
		Type.String({ description: "Timezone for habit tracking (e.g. 'America/New_York')" })
	),
	remind: Type.Optional(
		Type.String({ description: "Reminder setting" })
	),
	enabled: Type.Optional(
		Type.Boolean({ description: "Whether habit is enabled" })
	),
});

const FocusParams = Type.Object({
	action: StringEnum(["list_focus"] as const),
	userId: Type.Optional(
		Type.String({ description: "User ID filter" })
	),
	dateFrom: Type.Optional(
		Type.String({ description: "Start date (YYYY-MM-DD)" })
	),
	dateTo: Type.Optional(
		Type.String({ description: "End date (YYYY-MM-DD)" })
	),
	type: Type.Optional(
		Type.String({ description: "Focus type filter" })
	),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
	return d.toISOString().split("T")[0];
}

function formatTask(t: TickTickTask): string {
	const lines: string[] = [];
	lines.push(`• ${t.title}`);
	if (t.content) lines.push(`  Description: ${t.content.substring(0, 200)}`);
	if (t.project) lines.push(`  Project: ${t.project}`);
	if (t.list) lines.push(`  List: ${t.list}`);
	if (t.priority) lines.push(`  Priority: ${t.priority}`);
	if (t.dueDate) lines.push(`  Due: ${t.dueDate}`);
	if (t.scheduledDate) lines.push(`  Scheduled: ${t.scheduledDate}`);
	if (t.context) lines.push(`  Context: ${t.context}`);
	if (t.tags && t.tags.length) lines.push(`  Tags: ${t.tags.join(", ")}`);
	if (t.reminder) lines.push(`  Reminder: ${t.reminder}`);
	return lines.join("\n");
}

function formatList(l: TickTickList): string {
	const typeNames = ["Inbox", "Collection", "Project"];
	return `• ${l.listName} (ID: ${l.listId}, Type: ${typeNames[l.listType] ?? l.listType}, Color: ${l.color})`;
}

function formatProject(p: TickTickProject): string {
	return `• ${p.projectName} (ID: ${p.projectId}, Type: ${p.projectType}, Shared: ${p.shared})`;
}

function formatHabit(h: TickTickHabit): string {
	return `• ${h.title} (ID: ${h.habitId}, Cycle: ${h.cycleType}, Enabled: ${h.isEnabled})`;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export default function ticktickExtension(pi: ExtensionAPI): void {
	// Task tools
	pi.registerTool({
		name: "ticktick_tasks",
		label: "TickTick Tasks",
		description:
			"Query TickTick tasks. Actions: list_tasks (filter/search tasks), get_task (get one by ID). Use list_tasks to find tasks, then get_task for details.",
		parameters: TaskQueryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadConfig(ctx);
			if (!config.ok) {
				return {
					content: [{ type: "text", text: `Error: ${config.error}` }],
					details: {},
				};
			}

			if (params.action === "list_tasks") {
				return await handleListTasks(params, config);
			}

			if (params.action === "get_task" && params.taskId) {
				return await handleGetTask(params.taskId, config);
			}

			return {
				content: [{ type: "text", text: "Invalid task action or missing required parameter." }],
				details: {},
			};
		},

		renderCall(args, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_tasks ")) + theme.fg("muted", args.action);
			if (args.taskId) label += ` ${theme.fg("accent", args.taskId)}`;
			return new Text(label, 0, 0);
		},
	});

	pi.registerTool({
		name: "ticktick_create_task",
		label: "TickTick Create Task",
		description:
			"Create a new TickTick task. Required: title. Optional: content (description), project (project ID), priority (0-4), dueDate (YYYY-MM-DD), scheduledDate, context, tags, reminder.",
		parameters: CreateTaskParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadConfig(ctx);
			if (!config.ok) {
				return {
					content: [{ type: "text", text: `Error: ${config.error}` }],
					details: {},
				};
			}

			return await handleCreateTask(params, config);
		},

		renderCall(args, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_create_task ")) + theme.fg("muted", `"${args.title}"`);
			if (args.dueDate) label += ` ${theme.fg("dim", `due ${args.dueDate}`)}`;
			return new Text(label, 0, 0);
		},
	});

	pi.registerTool({
		name: "ticktick_update_task",
		label: "TickTick Update Task",
		description:
			"Update an existing TickTick task. Required: taskId. Provide any fields to update: title, content, project, list, priority, dueDate, scheduledDate, context, tags, reminder.",
		parameters: UpdateTaskParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadConfig(ctx);
			if (!config.ok) {
				return {
					content: [{ type: "text", text: `Error: ${config.error}` }],
					details: {},
				};
			}

			return await handleUpdateTask(params, config);
		},

		renderCall(args, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_update_task ")) + theme.fg("accent", args.taskId);
			const updates = Object.keys(args)
				.filter((k) => k !== "action" && k !== "taskId")
				.map((k) => k);
			if (updates.length) label += ` ${theme.fg("muted", `update: ${updates.join(", ")}`)}`;
			return new Text(label, 0, 0);
		},
	});

	pi.registerTool({
		name: "ticktick_done_task",
		label: "TickTick Done Task",
		description: "Mark a TickTick task as completed. Required: taskId.",
		parameters: DoneTaskParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadConfig(ctx);
			if (!config.ok) {
				return {
					content: [{ type: "text", text: `Error: ${config.error}` }],
					details: {},
				};
			}

			if (!params.taskId) {
				return {
					content: [{ type: "text", text: "Error: taskId is required" }],
					details: {},
				};
			}

			const result = await ticktickRequest<{ success: boolean }>(
				ctx,
				`/tasks/${params.taskId}/done`,
				"POST",
			);

			if (!result.ok) {
				return {
					content: [{ type: "text", text: `Error completing task: ${result.error}` }],
					details: {},
				};
			}

			return {
				content: [{ type: "text", text: `Task ${params.taskId} marked as done.` }],
				details: {},
			};
		},

		renderCall(args, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_done_task ")) + theme.fg("accent", args.taskId);
			return new Text(label, 0, 0);
		},
	});

	// List tools
	pi.registerTool({
		name: "ticktick_lists",
		label: "TickTick Lists",
		description:
			"Manage TickTick lists. Actions: list_lists (show all), get_list, create_list (requires listName), update_list (requires listId).",
		parameters: ListParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadConfig(ctx);
			if (!config.ok) {
				return {
					content: [{ type: "text", text: `Error: ${config.error}` }],
					details: {},
				};
			}

			switch (params.action) {
				case "list_lists":
					return await handleListLists(params, config);
				case "get_list":
					return await handleGetList(params, config);
				case "create_list":
					return await handleCreateList(params, config);
				case "update_list":
					return await handleUpdateList(params, config);
				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {},
					};
			}
		},

		renderCall(args, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_lists ")) + theme.fg("muted", args.action);
			if (args.listName) label += ` "${args.listName}"`;
			if (args.listId) label += ` ${theme.fg("accent", args.listId)}`;
			return new Text(label, 0, 0);
		},
	});

	// Project tools
	pi.registerTool({
		name: "ticktick_projects",
		label: "TickTick Projects",
		description:
			"Manage TickTick projects. Actions: list_projects (show all), get_project, create_project (requires projectName), update_project (requires projectId).",
		parameters: ProjectParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadConfig(ctx);
			if (!config.ok) {
				return {
					content: [{ type: "text", text: `Error: ${config.error}` }],
					details: {},
				};
			}

			switch (params.action) {
				case "list_projects":
					return await handleListProjects(params, config);
				case "get_project":
					return await handleGetProject(params, config);
				case "create_project":
					return await handleCreateProject(params, config);
				case "update_project":
					return await handleUpdateProject(params, config);
				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {},
					};
			}
		},

		renderCall(args, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_projects ")) + theme.fg("muted", args.action);
			if (args.projectName) label += ` "${args.projectName}"`;
			if (args.projectId) label += ` ${theme.fg("accent", args.projectId)}`;
			return new Text(label, 0, 0);
		},
	});

	// Habit tools
	pi.registerTool({
		name: "ticktick_habits",
		label: "TickTick Habits",
		description:
			"Manage TickTick habits. Actions: list_habits (show all), get_habit, create_habit (requires habitName, cycleType), update_habit (requires habitId).",
		parameters: HabitParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadConfig(ctx);
			if (!config.ok) {
				return {
					content: [{ type: "text", text: `Error: ${config.error}` }],
					details: {},
				};
			}

			switch (params.action) {
				case "list_habits":
					return await handleListHabits(params, config);
				case "get_habit":
					return await handleGetHabit(params, config);
				case "create_habit":
					return await handleCreateHabit(params, config);
				case "update_habit":
					return await handleUpdateHabit(params, config);
				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {},
					};
			}
		},

		renderCall(args, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_habits ")) + theme.fg("muted", args.action);
			if (args.habitName) label += ` "${args.habitName}"`;
			if (args.habitId) label += ` ${theme.fg("accent", args.habitId)}`;
			return new Text(label, 0, 0);
		},
	});

	// Focus tools
	pi.registerTool({
		name: "ticktick_focus",
		label: "TickTick Focus",
		description:
			"Query TickTick focus/meditation records. Action: list_focus (filter by date range, type, user).",
		parameters: FocusParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadConfig(ctx);
			if (!config.ok) {
				return {
					content: [{ type: "text", text: `Error: ${config.error}` }],
					details: {},
				};
			}

			if (params.action !== "list_focus") {
				return {
					content: [{ type: "text", text: `Unknown action: ${params.action}` }],
					details: {},
				};
			}

			const queryParams: Record<string, string> = {};
			if (params.userId) queryParams.userId = params.userId;
			if (params.dateFrom) queryParams.dateFrom = params.dateFrom;
			if (params.dateTo) queryParams.dateTo = params.dateTo;
			if (params.type) queryParams.type = params.type;

			const path = buildPath("/focus", queryParams);
			const result = await ticktickRequest<TickTickFocusRecord[]>(ctx, path);

			if (!result.ok) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					details: {},
				};
			}

			const records = result.data ?? [];
			if (records.length === 0) {
				return {
					content: [{ type: "text", text: "No focus records found." }],
					details: {},
				};
			}

			const lines = records.map((r) => {
				const dur = r.duration > 60 ? `${Math.round(r.duration / 60)}m` : `${r.duration}s`;
				return `• ${r.type}: ${dur} on ${r.time.split("T")[0]}`;
			});

			return {
				content: [{ type: "text", text: `${records.length} focus record(s):\n\n${lines.join("\n")}` }],
				details: {},
			};
		},

		renderCall(args, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_focus ")) + theme.fg("muted", args.action);
			if (args.dateFrom) label += ` ${theme.fg("dim", `${args.dateFrom}→${args.dateTo ?? "now"}`)}`;
			return new Text(label, 0, 0);
		},
	});

	// /ticktick command
	pi.registerCommand("ticktick", {
		description: "View TickTick status and configuration",
		handler: async (args, ctx) => {
			const subcmd = (args ?? "").trim().split(/\s+/)[0];

			if (!ctx.hasUI) {
				ctx.ui.notify("/ticktick requires interactive mode", "error");
				return;
			}

			if (subcmd === "setup") {
				await showSetupUI(ctx);
				return;
			}

			if (subcmd === "list" || subcmd === "tasks") {
				const config = loadConfig(ctx);
				if (!config.ok) {
					ctx.ui.notify(`Error: ${config.error}`, "error");
					return;
				}
				const result = await ticktickRequest<TickTickTask[]>(ctx, "/tasks", "GET", { limit: 50 });
				if (!result.ok) {
					ctx.ui.notify(`Error: ${result.error}`, "error");
					return;
				}
				const tasks = result.data ?? [];
				const active = tasks.filter((t) => !t.type || t.type !== "done");
				const done = tasks.filter((t) => t.type === "done");

				await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
					return new TickTickListView(tasks, active, done, theme, () => done());
				});
				return;
			}

			// Default: show status
			const config = loadConfig(ctx);
			let statusText = "";
			if (config.ok) {
				statusText = `TickTick: connected (token configured)\n`;
			} else {
				statusText = `TickTick: not configured\n`;
			}
			statusText += `Run /ticktick-setup to configure your API token.`;

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				const lines: string[] = [
					"",
					theme.fg("accent", " TickTick Status "),
					"",
					...statusText.split("\n").map((l) => theme.fg("text", l)),
					"",
					theme.fg("dim", "Run /ticktick-setup to configure"),
					"",
					theme.fg("dim", "Press Escape to close"),
					"",
				];
				return {
					render: (_w: number) => lines,
					invalidate: () => {},
					handleInput: (data: string) => {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done();
					},
				};
			});
		},
	});

	pi.registerCommand("ticktick-setup", {
		description: "Set up or update your TickTick API token",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/ticktick-setup requires interactive mode", "error");
				return;
			}
			await showSetupUI(ctx);
		},
	});
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleListTasks(
	params: {
		action: string;
		taskId?: string;
		project?: string;
		list?: string;
		done?: boolean;
		priority?: number;
		dueDateStart?: string;
		dueDateEnd?: string;
		hasReminder?: boolean;
		search?: string;
	},
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	// Use the /tasks endpoint with filter parameters
	// TickTick supports various filter params
	const pathParams: Record<string, string> = {};
	if (params.project) pathParams.project = params.project;
	if (params.list) pathParams.list = params.list;
	if (params.done !== undefined) pathParams.done = String(params.done);
	if (params.priority !== undefined) pathParams.priority = String(params.priority);
	if (params.dueDateStart) pathParams.dateFrom = params.dueDateStart;
	if (params.dueDateEnd) pathParams.dateTo = params.dueDateEnd;
	if (params.hasReminder !== undefined) pathParams.hasReminder = String(params.hasReminder);

	const path = buildPath("/tasks", pathParams);
	const result = await ticktickRequest<TickTickTask[]>(null as any, path);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error: ${result.error}` }],
			details: {},
		};
	}

	const tasks = result.data ?? [];
	if (tasks.length === 0) {
		return {
			content: [{ type: "text", text: "No tasks found matching the criteria." }],
			details: {},
		};
	}

	// If search was requested, filter client-side (API may not support text search)
	let filtered = tasks;
	if (params.search) {
		const q = params.search.toLowerCase();
		filtered = tasks.filter(
			(t) =>
				t.title.toLowerCase().includes(q) || (t.content && t.content.toLowerCase().includes(q)),
		);
	}

	const lines = filtered.map((t) => formatTask(t));
	return {
		content: [{ type: "text", text: `${filtered.length} task(s):\n\n${lines.join("\n\n")}` }],
		details: { count: filtered.length, tasks: filtered.slice(0, 50) },
	};
}

async function handleGetTask(
	taskId: string,
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	const result = await ticktickRequest<TickTickTask>(null as any, `/tasks/${taskId}`);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error: ${result.error}` }],
			details: {},
		};
	}

	const task = result.data!;
	return {
		content: [{ type: "text", text: formatTask(task) }],
		details: { task },
	};
}

async function handleCreateTask(
	params: {
		action: string;
		title: string;
		content?: string;
		project?: string;
		list?: string;
		priority?: number;
		dueDate?: string;
		scheduledDate?: string;
		context?: string;
		tags?: string[];
		reminder?: string;
	},
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	if (!params.title) {
		return {
			content: [{ type: "text", text: "Error: title is required" }],
			details: {},
		};
	}

	const body: Record<string, unknown> = {
		title: params.title,
	};

	if (params.content) body.content = params.content;
	if (params.project) body.project = params.project;
	if (params.list) body.list = params.list;
	if (params.priority !== undefined) body.priority = params.priority;
	if (params.dueDate) body.dueDate = params.dueDate;
	if (params.scheduledDate) body.scheduledDate = params.scheduledDate;
	if (params.context) body.context = params.context;
	if (params.tags) body.tags = params.tags;
	if (params.reminder) body.reminder = params.reminder;

	const result = await ticktickRequest<TickTickTask>(
		null as any,
		"/tasks",
		"POST",
		body,
	);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error creating task: ${result.error}` }],
			details: {},
		};
	}

	const task = result.data!;
	return {
		content: [{ type: "text", text: `Created task: ${task.title}\nID: ${task.id}\n${formatTask(task)}` }],
		details: { task },
	};
}

async function handleUpdateTask(
	params: {
		action: string;
		taskId: string;
		title?: string;
		content?: string;
		project?: string;
		list?: string;
		priority?: number;
		dueDate?: string;
		scheduledDate?: string;
		context?: string;
		tags?: string[];
		reminder?: string;
	},
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	if (!params.taskId) {
		return {
			content: [{ type: "text", text: "Error: taskId is required" }],
			details: {},
		};
	}

	const body: Record<string, unknown> = {};
	if (params.title !== undefined) body.title = params.title;
	if (params.content !== undefined) body.content = params.content;
	if (params.project !== undefined) body.project = params.project;
	if (params.list !== undefined) body.list = params.list;
	if (params.priority !== undefined) body.priority = params.priority;
	if (params.dueDate !== undefined) body.dueDate = params.dueDate;
	if (params.scheduledDate !== undefined) body.scheduledDate = params.scheduledDate;
	if (params.context !== undefined) body.context = params.context;
	if (params.tags !== undefined) body.tags = params.tags;
	if (params.reminder !== undefined) body.reminder = params.reminder;

	if (Object.keys(body).length === 0) {
		return {
			content: [{ type: "text", text: "Error: no fields to update. Provide at least one field." }],
			details: {},
		};
	}

	const result = await ticktickRequest<TickTickTask>(
		null as any,
		`/tasks/${params.taskId}`,
		"PUT",
		body,
	);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error updating task: ${result.error}` }],
			details: {},
		};
	}

	const task = result.data!;
	const updated = Object.keys(body).filter((k) => k !== "title" && k !== "content");
	return {
		content: [{ type: "text", text: `Updated task: ${task.title} (${updated.join(", ")})\n${formatTask(task)}` }],
		details: { task },
	};
}

// ---------------------------------------------------------------------------
// List handlers
// ---------------------------------------------------------------------------

async function handleListLists(
	params: { listType?: number; action: string },
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	const queryParams: Record<string, string> = {};
	if (params.listType !== undefined) queryParams.listType = String(params.listType);

	const path = buildPath("/lists", queryParams);
	const result = await ticktickRequest<TickTickList[]>(null as any, path);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error: ${result.error}` }],
			details: {},
		};
	}

	const lists = result.data ?? [];
	if (lists.length === 0) {
		return {
			content: [{ type: "text", text: "No lists found." }],
			details: {},
		};
	}

	const lines = lists.map((l) => formatList(l));
	return {
		content: [{ type: "text", text: `${lists.length} list(s):\n\n${lines.join("\n")}` }],
		details: { lists },
	};
}

async function handleGetList(
	params: { listId?: string; action: string },
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	if (!params.listId) {
		return {
			content: [{ type: "text", text: "Error: listId is required" }],
			details: {},
		};
	}

	const result = await ticktickRequest<TickTickList>(null as any, `/lists/${params.listId}`);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error: ${result.error}` }],
			details: {},
		};
	}

	return {
		content: [{ type: "text", text: formatList(result.data!) }],
		details: { list: result.data },
	};
}

async function handleCreateList(
	params: {
		action: string;
		listName?: string;
		listType?: number;
		color?: string;
		sort?: number;
	},
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	if (!params.listName) {
		return {
			content: [{ type: "text", text: "Error: listName is required" }],
			details: {},
		};
	}

	const body: Record<string, unknown> = { listName: params.listName };
	if (params.listType !== undefined) body.listType = params.listType;
	if (params.color) body.color = params.color;
	if (params.sort !== undefined) body.sort = params.sort;

	const result = await ticktickRequest<TickTickList>(null as any, "/lists", "POST", body);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error creating list: ${result.error}` }],
			details: {},
		};
	}

	return {
		content: [{ type: "text", text: `Created list: ${result.data!.listName} (ID: ${result.data!.listId})` }],
		details: { list: result.data },
	};
}

async function handleUpdateList(
	params: {
		action: string;
		listId?: string;
		listName?: string;
		listType?: number;
		color?: string;
		sort?: number;
	},
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	if (!params.listId) {
		return {
			content: [{ type: "text", text: "Error: listId is required" }],
			details: {},
		};
	}

	const body: Record<string, unknown> = {};
	if (params.listName !== undefined) body.listName = params.listName;
	if (params.listType !== undefined) body.listType = params.listType;
	if (params.color) body.color = params.color;
	if (params.sort !== undefined) body.sort = params.sort;

	if (Object.keys(body).length === 0) {
		return {
			content: [{ type: "text", text: "Error: no fields to update" }],
			details: {},
		};
	}

	const result = await ticktickRequest<TickTickList>(null as any, `/lists/${params.listId}`, "PUT", body);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error updating list: ${result.error}` }],
			details: {},
		};
	}

	return {
		content: [{ type: "text", text: `Updated list: ${result.data!.listName}` }],
		details: { list: result.data },
	};
}

// ---------------------------------------------------------------------------
// Project handlers
// ---------------------------------------------------------------------------

async function handleListProjects(
	params: { projectType?: number; action: string },
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	const queryParams: Record<string, string> = {};
	if (params.projectType !== undefined) queryParams.projectType = String(params.projectType);

	const path = buildPath("/projects", queryParams);
	const result = await ticktickRequest<TickTickProject[]>(null as any, path);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error: ${result.error}` }],
			details: {},
		};
	}

	const projects = result.data ?? [];
	if (projects.length === 0) {
		return {
			content: [{ type: "text", text: "No projects found." }],
			details: {},
		};
	}

	const lines = projects.map((p) => formatProject(p));
	return {
		content: [{ type: "text", text: `${projects.length} project(s):\n\n${lines.join("\n")}` }],
		details: { projects },
	};
}

async function handleGetProject(
	params: { projectId?: string; action: string },
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	if (!params.projectId) {
		return {
			content: [{ type: "text", text: "Error: projectId is required" }],
			details: {},
		};
	}

	const result = await ticktickRequest<TickTickProject>(null as any, `/projects/${params.projectId}`);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error: ${result.error}` }],
			details: {},
		};
	}

	return {
		content: [{ type: "text", text: formatProject(result.data!) }],
		details: { project: result.data },
	};
}

async function handleCreateProject(
	params: {
		action: string;
		projectName?: string;
		description?: string;
		projectType?: number;
		projectColor?: string;
		projectOrder?: number;
	},
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	if (!params.projectName) {
		return {
			content: [{ type: "text", text: "Error: projectName is required" }],
			details: {},
		};
	}

	const body: Record<string, unknown> = { projectName: params.projectName };
	if (params.description) body.description = params.description;
	if (params.projectType !== undefined) body.projectType = params.projectType;
	if (params.projectColor) body.projectColor = params.projectColor;
	if (params.projectOrder !== undefined) body.projectOrder = params.projectOrder;

	const result = await ticktickRequest<TickTickProject>(null as any, "/projects", "POST", body);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error creating project: ${result.error}` }],
			details: {},
		};
	}

	return {
		content: [{ type: "text", text: `Created project: ${result.data!.projectName} (ID: ${result.data!.projectId})` }],
		details: { project: result.data },
	};
}

async function handleUpdateProject(
	params: {
		action: string;
		projectId?: string;
		projectName?: string;
		description?: string;
		projectType?: number;
		projectColor?: string;
		projectOrder?: number;
	},
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	if (!params.projectId) {
		return {
			content: [{ type: "text", text: "Error: projectId is required" }],
			details: {},
		};
	}

	const body: Record<string, unknown> = {};
	if (params.projectName !== undefined) body.projectName = params.projectName;
	if (params.description !== undefined) body.description = params.description;
	if (params.projectType !== undefined) body.projectType = params.projectType;
	if (params.projectColor) body.projectColor = params.projectColor;
	if (params.projectOrder !== undefined) body.projectOrder = params.projectOrder;

	if (Object.keys(body).length === 0) {
		return {
			content: [{ type: "text", text: "Error: no fields to update" }],
			details: {},
		};
	}

	const result = await ticktickRequest<TickTickProject>(null as any, `/projects/${params.projectId}`, "PUT", body);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error updating project: ${result.error}` }],
			details: {},
		};
	}

	return {
		content: [{ type: "text", text: `Updated project: ${result.data!.projectName}` }],
		details: { project: result.data },
	};
}

// ---------------------------------------------------------------------------
// Habit handlers
// ---------------------------------------------------------------------------

async function handleListHabits(
	params: { action: string },
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	const result = await ticktickRequest<TickTickHabit[]>(null as any, "/habits");

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error: ${result.error}` }],
			details: {},
		};
	}

	const habits = result.data ?? [];
	if (habits.length === 0) {
		return {
			content: [{ type: "text", text: "No habits found." }],
			details: {},
		};
	}

	const lines = habits.map((h) => formatHabit(h));
	return {
		content: [{ type: "text", text: `${habits.length} habit(s):\n\n${lines.join("\n")}` }],
		details: { habits },
	};
}

async function handleGetHabit(
	params: { habitId?: string; action: string },
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	if (!params.habitId) {
		return {
			content: [{ type: "text", text: "Error: habitId is required" }],
			details: {},
		};
	}

	const result = await ticktickRequest<TickTickHabit>(null as any, `/habits/${params.habitId}`);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error: ${result.error}` }],
			details: {},
		};
	}

	return {
		content: [{ type: "text", text: formatHabit(result.data!) }],
		details: { habit: result.data },
	};
}

async function handleCreateHabit(
	params: {
		action: string;
		habitName?: string;
		description?: string;
		cycleType?: string;
		frequency?: number;
		timeZone?: string;
		remind?: string;
		enabled?: boolean;
	},
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	if (!params.habitName) {
		return {
			content: [{ type: "text", text: "Error: habitName is required" }],
			details: {},
		};
	}

	const body: Record<string, unknown> = {
		title: params.habitName,
		cycleType: params.cycleType ?? "d",
	};

	if (params.description) body.description = params.description;
	if (params.frequency !== undefined) body.frequency = params.frequency;
	if (params.timeZone) body.timeZone = params.timeZone;
	if (params.remind) body.remind = params.remind;
	if (params.enabled !== undefined) body.enabled = params.enabled;

	const result = await ticktickRequest<TickTickHabit>(null as any, "/habits", "POST", body);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error creating habit: ${result.error}` }],
			details: {},
		};
	}

	return {
		content: [{ type: "text", text: `Created habit: ${result.data!.title} (ID: ${result.data!.habitId})` }],
		details: { habit: result.data },
	};
}

async function handleUpdateHabit(
	params: {
		action: string;
		habitId?: string;
		habitName?: string;
		description?: string;
		cycleType?: string;
		frequency?: number;
		timeZone?: string;
		remind?: string;
		enabled?: boolean;
	},
	config: { ok: boolean; token?: string; error?: string },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	if (!params.habitId) {
		return {
			content: [{ type: "text", text: "Error: habitId is required" }],
			details: {},
		};
	}

	const body: Record<string, unknown> = {};
	if (params.habitName !== undefined) body.title = params.habitName;
	if (params.description !== undefined) body.description = params.description;
	if (params.cycleType) body.cycleType = params.cycleType;
	if (params.frequency !== undefined) body.frequency = params.frequency;
	if (params.timeZone) body.timeZone = params.timeZone;
	if (params.remind) body.remind = params.remind;
	if (params.enabled !== undefined) body.enabled = params.enabled;

	if (Object.keys(body).length === 0) {
		return {
			content: [{ type: "text", text: "Error: no fields to update" }],
			details: {},
		};
	}

	const result = await ticktickRequest<TickTickHabit>(null as any, `/habits/${params.habitId}`, "PUT", body);

	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error updating habit: ${result.error}` }],
			details: {},
		};
	}

	return {
		content: [{ type: "text", text: `Updated habit: ${result.data!.title}` }],
		details: { habit: result.data },
	};
}

// ---------------------------------------------------------------------------
// Path building
// ---------------------------------------------------------------------------

function buildPath(path: string, queryParams: Record<string, string> = {}): string {
	const entries = Object.entries(queryParams);
	if (entries.length === 0) return path;
	const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
	return `${path}?${query}`;
}

// ---------------------------------------------------------------------------
// UI components
// ---------------------------------------------------------------------------

class TickTickListView {
	private tasks: TickTickTask[];
	private active: TickTickTask[];
	private done: TickTickTask[];
	private theme: Theme;
	private onClose: () => void;

	constructor(
		tasks: TickTickTask[],
		active: TickTickTask[],
		done: TickTickTask[],
		theme: Theme,
		onClose: () => void,
	) {
		this.tasks = tasks;
		this.active = active;
		this.done = done;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		lines.push("");
		const title = th.fg("accent", " TickTick Tasks ");
		const bar = th.fg("borderMuted", "─".repeat(Math.max(0, width - title.length - 2)));
		lines.push(th.fg("borderMuted", "─") + title + bar);
		lines.push("");

		// Active tasks
		lines.push(th.fg("accent", " Active tasks ") + th.fg("muted", ` (${this.active.length})`));
		if (this.active.length === 0) {
			lines.push(th.fg("dim", "  (none)"));
		} else {
			const display = this.active.slice(0, 15);
			for (const t of display) {
				const prio = t.priority ? ` [P${t.priority}]` : "";
				const due = t.dueDate ? ` [due: ${t.dueDate}]` : "";
				lines.push(th.fg("text", `  ○ ${t.title}${prio}${due}`));
			}
			if (this.active.length > 15) {
				lines.push(th.fg("dim", `  ... ${this.active.length - 15} more`));
			}
		}

		lines.push("");

		// Completed tasks (last 5)
		if (this.done.length > 0) {
			lines.push(th.fg("accent", " Completed ") + th.fg("muted", `(last ${Math.min(5, this.done.length)})`));
			const recent = this.done.slice(-5).reverse();
			for (const t of recent) {
				lines.push(th.fg("dim", `  ✓ ${t.title}`));
			}
		}

		lines.push("");
		lines.push(th.fg("dim", "  Press Escape to close"));
		lines.push("");

		return lines;
	}

	invalidate(): void {
		// No-op
	}
}

// ---------------------------------------------------------------------------
// Setup UI
// ---------------------------------------------------------------------------

async function showSetupUI(ctx: ExtensionCommandContext): Promise<void> {
	const existing = loadConfigFile();
	const current = existing.ok ? (existing.token?.substring(0, 8) + "…") : "(not set)";

	await ctx.ui.input({
		prompt: ctx.ui.theme.fg("accent", "TickTick API Token"),
		placeholder: "Paste your Bearer token here",
		initialValue: current !== "(not set)" ? "" : undefined,
	}, async (value) => {
		if (!value || value.trim() === "") {
			ctx.ui.notify("Token cannot be empty", "warning");
			return;
		}

		const token = value.trim();
		const ok = saveConfigFile({ token });

		if (ok) {
			// Invalidate global cache so next calls pick up the new token
			configCache = {};
			// Also update the per-context cache
			(configCache as any) = {};

			// Verify the token works
			const verifyResult = await ticktickRequest(null as any, "/lists", "GET");
			if (verifyResult.ok) {
				ctx.ui.notify("TickTick connected successfully!", "success");
			} else {
				ctx.ui.notify(`Token saved but verification failed: ${verifyResult.error}`, "warning");
			}
		} else {
			ctx.ui.notify("Failed to save config file", "error");
		}
	});
}
