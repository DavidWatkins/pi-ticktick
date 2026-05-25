/**
 * pi-ticktick - TickTick task manager integration via MCP
 *
 * Connects to TickTick's MCP server at https://mcp.ticktick.com/
 * using the token from Settings → Account → API Token.
 *
 * Setup:
 *   1. Get token: TickTick web → avatar → Settings → Account → API Token
 *   2. Config at: ~/.pi/agent/pi-ticktick-config.json  ({"token": "..."})
 *   3. Copy this file to ~/.pi/agent/extensions/ticktick.ts
 *   4. Restart pi
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// ────────────────────── Config ──────────────────────

const CONFIG_PATH = `${process.env.HOME}/.pi/agent/pi-ticktick-config.json`;
let cachedConfig: { token?: string } = {};

function loadConfig(): { ok: boolean; token?: string; error?: string } {
	if (cachedConfig.token) return { ok: true, token: cachedConfig.token };
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const config: { token: string } = JSON.parse(raw);
		cachedConfig.token = config.token;
		return { ok: true, token: config.token };
	} catch {
		return { ok: false, error: `Config not found at ${CONFIG_PATH}. Run /ticktick-setup.` };
	}
}

function saveConfig(token: string): boolean {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ token }, null, 2));
		cachedConfig.token = token;
		return true;
	} catch {
		return false;
	}
}

// ────────────────────── MCP Client ──────────────────────

const MCP_URL = "https://mcp.ticktick.com/";
let requestIdCounter = 0;

async function mcpCall(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content?: Array<{ type: string; text: string }>; error?: string }> {
	const token = cachedConfig.token;
	if (!token) return { ok: false, error: "Not configured" };

	const body = { jsonrpc: "2.0", method: "tools/call", params: { name: tool, arguments: args }, id: ++requestIdCounter };
	try {
		const resp = await fetch(MCP_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		});
		if (!resp.ok) {
			const text = await resp.text().catch(() => "");
			return { ok: false, error: `MCP ${resp.status}: ${text}` };
		}
		const data = await resp.json();
		if (data.error) return { ok: false, error: `MCP error ${data.error.code}: ${data.error.message}` };
		const mc = data.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
		if (mc?.isError) return { ok: false, error: mc.content?.[0]?.text ?? "Unknown error" };
		const content = (mc?.content ?? []).filter((c): c is { type: string; text: string } => c.type === "text" && c.text);
		return { ok: true, content };
	} catch (e) {
		return { ok: false, error: `MCP request failed: ${(e as Error).message}` };
	}
}

// ────────────────────── Helpers ──────────────────────

function formatDate(d: Date): string { return d.toISOString().split("T")[0]; }
function today(): string { return formatDate(new Date()); }
function paramsHas(obj: Record<string, unknown>, key: string): boolean { return obj[key] !== undefined && obj[key] !== null; }

// ────────────────────── Tools ──────────────────────

export default function ticktickExtension(pi: ExtensionAPI): void {

	// ── Tasks ─────────────────────────────────────────────

	pi.registerTool({
		name: "ticktick_tasks",
		label: "TickTick Tasks",
		description:
			"Query tasks. Actions: list (today's tasks), list_by_date (date like '2026-05-24'|'tomorrow'|'this_week'|'last_7_days'), list_by_query (time query: 'today'|'tomorrow'|'last24hour'|'last7day'|'next24hour'|'next7day'), search (search by keyword), get (by task_id), filter (by project_id), list_completed (today's completed).",
		parameters: Type.Object({
			action: StringEnum(["list", "list_by_date", "list_by_query", "search", "get", "filter", "list_completed"] as const),
			query: Type.Optional(Type.String({ description: "Date, time query, search keyword, or project ID depending on action" })),
			taskId: Type.Optional(Type.String({ description: "Task ID for get action" })),
			project: Type.Optional(Type.String({ description: "Project ID for filter action" })),
			limit: Type.Optional(Type.Number({ description: "Max results" })),
		}),
		async execute(_tcid, params, _sig, _onUpdate) {
			if (!cachedConfig.token) return { content: [{ type: "text", text: "Error: not configured. Run /ticktick-setup." }], details: {} };

			switch (params.action) {
				case "list": {
					const r = await mcpCall("list_undone_tasks_by_date", { search: { startDate: today(), endDate: today() }, limit: params.limit ?? 50 });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "list_by_date": {
					if (!params.query) return { content: [{ type: "text", text: "Error: date is required" }], details: {} };
					const q = params.query.toLowerCase();
					let start: string, end: string;
					const td = new Date();
					if (q === "today") { start = today(); end = today(); }
					else if (q === "tomorrow") { const t = new Date(td); t.setDate(t.getDate()+1); start=formatDate(t); end=start; }
					else if (q === "this_week") {
						const m = new Date(td); m.setDate(m.getDate() - (m.getDay()===0?6:m.getDay()-1));
						start=formatDate(m); end=formatDate(new Date(m.getTime()+6*864e5));
					} else if (q === "last_7_days") { start=formatDate(new Date(td.getTime()-7*864e5)); end=today(); }
					else { start=q; end=q; }
					const r = await mcpCall("list_undone_tasks_by_date", { search: { startDate: start, endDate: end }, limit: params.limit ?? 50 });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "list_by_query": {
					if (!params.query) return { content: [{ type: "text", text: "Error: query is required" }], details: {} };
					const r = await mcpCall("list_undone_tasks_by_time_query", { query_command: params.query.toLowerCase() });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "search": {
					if (!params.query) return { content: [{ type: "text", text: "Error: search keyword is required" }], details: {} };
					const r = await mcpCall("search_task", { query: params.query });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "get": {
					if (!params.taskId) return { content: [{ type: "text", text: "Error: taskId is required" }], details: {} };
					const r = await mcpCall("get_task_by_id", { task_id: params.taskId });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "filter": {
					if (!params.project) return { content: [{ type: "text", text: "Error: project ID is required" }], details: {} };
					const r = await mcpCall("filter_tasks", { filter: { projectIds: [params.project] } });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "list_completed": {
					const r = await mcpCall("list_completed_tasks_by_date", { search: { startDate: today(), endDate: today() } });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				default: return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
			}
		},
		renderCall(p, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_tasks ")) + theme.fg("muted", p.action);
			if (p.query) label += ` ${theme.fg("dim", p.query)}`;
			if (p.taskId) label += ` ${theme.fg("accent", p.taskId)}`;
			return new Text(label, 0, 0);
		},
	});

	// ── Create/Update/Complete Tasks ──────────────────────

	pi.registerTool({
		name: "ticktick_create_task",
		label: "TickTick Create Task",
		description: "Create a task. Provide fields: title, content (body), project_id, list_id, priority (0/1/3/5), due_date, start_date, tags (array), reminders (array like TRIGGER:-PT60M), repeat (RRULE).",
		parameters: Type.Object({
			action: StringEnum(["create_task"] as const),
			title: Type.String({ description: "Task title" }),
			content: Type.Optional(Type.String({ description: "Task body" })),
			project_id: Type.Optional(Type.String({ description: "Project ID" })),
			list_id: Type.Optional(Type.String({ description: "List ID" })),
			priority: Type.Optional(Type.Number({ description: "0=none, 1=low, 3=medium, 5=high" })),
			due_date: Type.Optional(Type.String({ description: "Due date (YYYY-MM-DD)" })),
			start_date: Type.Optional(Type.String({ description: "Start date (YYYY-MM-DD)" })),
			tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
			reminders: Type.Optional(Type.String({ description: "Comma-separated reminders (e.g. TRIGGER:-PT60M)" })),
			repeat: Type.Optional(Type.String({ description: "RRULE string" })),
		}),
		async execute(_tcid, params, _sig, _onUpdate) {
			const task: Record<string, unknown> = { title: params.title };
			if (params.content) task.content = params.content;
			if (params.project_id) task.project_id = params.project_id;
			if (params.list_id) task.list_id = params.list_id;
			if (params.priority !== undefined) task.priority = params.priority;
			if (params.due_date) task.due_date = params.due_date;
			if (params.start_date) task.start_date = params.start_date;
			if (params.tags) task.tags = params.tags.split(",").map((t: string) => t.trim());
			if (params.reminders) task.reminders = params.reminders.split(",").map((r: string) => r.trim());
			if (params.repeat) task.repeat = params.repeat;
			if (!params.title) return { content: [{ type: "text", text: "Error: title required" }], details: {} };
			const r = await mcpCall("create_task", { task });
			if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
			return { content: r.content!, details: {} };
		},
		renderCall(p, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_create_task ")) + theme.fg("muted", `"${p.title}"`);
			if (p.due_date) label += ` ${theme.fg("dim", p.due_date)}`;
			return new Text(label, 0, 0);
		},
	});

	pi.registerTool({
		name: "ticktick_update_task",
		label: "TickTick Update Task",
		description: "Update a task. Required: task_id. Fields: title, content, project_id, list_id, priority, due_date, start_date, tags (array), reminders (array), repeat.",
		parameters: Type.Object({
			action: StringEnum(["update_task"] as const),
			task_id: Type.String({ description: "Task ID to update" }),
			title: Type.Optional(Type.String()),
			content: Type.Optional(Type.String()),
			project_id: Type.Optional(Type.String()),
			list_id: Type.Optional(Type.String()),
			priority: Type.Optional(Type.Number()),
			due_date: Type.Optional(Type.String()),
			start_date: Type.Optional(Type.String()),
			tags: Type.Optional(Type.String()),
			reminders: Type.Optional(Type.String()),
			repeat: Type.Optional(Type.String()),
		}),
		async execute(_tcid, params, _sig, _onUpdate) {
			if (!params.task_id) return { content: [{ type: "text", text: "Error: task_id required" }], details: {} };
			const task: Record<string, unknown> = {};
			if (params.title !== undefined) task.title = params.title;
			if (params.content !== undefined) task.content = params.content;
			if (params.project_id !== undefined) task.project_id = params.project_id;
			if (params.list_id !== undefined) task.list_id = params.list_id;
			if (params.priority !== undefined) task.priority = params.priority;
			if (params.due_date !== undefined) task.due_date = params.due_date;
			if (params.start_date !== undefined) task.start_date = params.start_date;
			if (params.tags !== undefined) task.tags = params.tags.split(",").map((t: string) => t.trim());
			if (params.reminders !== undefined) task.reminders = params.reminders.split(",").map((r: string) => r.trim());
			if (params.repeat !== undefined) task.repeat = params.repeat;
			if (Object.keys(task).length === 0) return { content: [{ type: "text", text: "Error: no fields to update" }], details: {} };
			const r = await mcpCall("update_task", { task_id: params.task_id, task });
			if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
			return { content: r.content!, details: {} };
		},
		renderCall(p, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_update_task ")) + theme.fg("accent", p.task_id);
			const updates = Object.keys(p).filter((k) => k !== "action" && k !== "task_id");
			if (updates.length) label += ` ${theme.fg("muted", `update: ${updates.join(", ")}`)}`;
			return new Text(label, 0, 0);
		},
	});

	pi.registerTool({
		name: "ticktick_complete_task",
		label: "TickTick Complete Task",
		description: "Complete a single task (requires task_id + project_id) or all tasks in a project (requires project_id + task_ids array).",
		parameters: Type.Object({
			action: StringEnum(["complete_task", "complete_project"] as const),
			task_id: Type.Optional(Type.String({ description: "Task ID for complete_task action" })),
			project_id: Type.Optional(Type.String({ description: "Project ID for complete_task action, or required for complete_project" })),
			task_ids: Type.Optional(Type.String({ description: "Comma-separated task IDs for complete_project action" })),
		}),
		async execute(_tcid, params, _sig, _onUpdate) {
			if (params.action === "complete_task") {
				if (!params.task_id) return { content: [{ type: "text", text: "Error: task_id required" }], details: {} };
				if (!params.project_id) return { content: [{ type: "text", text: "Error: project_id also required for complete_task" }], details: {} };
				const r = await mcpCall("complete_task", { task_id: params.task_id, project_id: params.project_id });
				if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
				return { content: r.content!, details: {} };
			}
			// complete_project
			if (!params.project_id) return { content: [{ type: "text", text: "Error: project_id required" }], details: {} };
			if (!params.task_ids) return { content: [{ type: "text", text: "Error: task_ids required" }], details: {} };
			const r = await mcpCall("complete_tasks_in_project", { project_id: params.project_id, task_ids: params.task_ids.split(",").map((t: string) => t.trim()) });
			if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
			return { content: r.content!, details: {} };
		},
		renderCall(p, theme) {
			let label = theme.fg("toolTitle", theme.bold(`ticktick_${p.action === "complete_project" ? "complete_project" : "complete_task"} `));
			label += p.task_id ? theme.fg("accent", p.task_id) : theme.fg("accent", p.project_id ?? "");
			return new Text(label, 0, 0);
		},
	});

	// ── Projects ──────────────────────────────────────────

	pi.registerTool({
		name: "ticktick_projects",
		label: "TickTick Projects",
		description: "Manage projects. Actions: list, get (by project_id), get_with_tasks (by project_id), create (requires name), update (requires project_id + fields).",
		parameters: Type.Object({
			action: StringEnum(["list", "get", "get_with_tasks", "create", "update"] as const),
			project_id: Type.Optional(Type.String({ description: "Project ID for get/update/get_with_tasks" })),
			name: Type.Optional(Type.String({ description: "Project name (for create/update)" })),
			description: Type.Optional(Type.String()),
			sort_order: Type.Optional(Type.Number()),
			sort_type: Type.Optional(Type.Number()),
		}),
		async execute(_tcid, params, _sig, _onUpdate) {
			switch (params.action) {
				case "list": {
					const r = await mcpCall("list_projects", {});
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "get": {
					if (!params.project_id) return { content: [{ type: "text", text: "Error: project_id required" }], details: {} };
					const r = await mcpCall("get_project_by_id", { project_id: params.project_id });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "get_with_tasks": {
					if (!params.project_id) return { content: [{ type: "text", text: "Error: project_id required" }], details: {} };
					const r = await mcpCall("get_project_with_undone_tasks", { project_id: params.project_id });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "create": {
					if (!params.name) return { content: [{ type: "text", text: "Error: name required" }], details: {} };
					const args: Record<string, unknown> = { name: params.name };
					if (params.sort_order !== undefined) args.sort_order = params.sort_order;
					if (params.description) args.description = params.description;
					const r = await mcpCall("create_project", args);
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "update": {
					if (!params.project_id) return { content: [{ type: "text", text: "Error: project_id required" }], details: {} };
					const args: Record<string, unknown> = { project_id: params.project_id };
					if (params.name !== undefined) args.name = params.name;
					if (params.sort_order !== undefined) args.sort_order = params.sort_order;
					if (params.description !== undefined) args.description = params.description;
					if (Object.keys(args).length === 1) return { content: [{ type: "text", text: "Error: provide at least one field" }], details: {} };
					const r = await mcpCall("update_project", args);
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				default: return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
			}
		},
		renderCall(p, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_projects ")) + theme.fg("muted", p.action);
			if (paramsHas(p, "name")) label += ` "${p.name}"`;
			if (paramsHas(p, "project_id")) label += ` ${theme.fg("accent", p.project_id)}`;
			return new Text(label, 0, 0);
		},
	});

	// ── Habits ────────────────────────────────────────────

	pi.registerTool({
		name: "ticktick_habits",
		label: "TickTick Habits",
		description: "Manage habits. Actions: list, list_sections, get (habit_id), create (requires habit object), update (habit_id + habit), checkin (habit_id + checkin_data), list_checkins (habit_ids, from_stamp, to_stamp).",
		parameters: Type.Object({
			action: StringEnum(["list", "list_sections", "get", "create", "update", "checkin", "list_checkins"] as const),
			habit_id: Type.Optional(Type.String({ description: "Habit ID for get/update/checkin/list_checkins" })),
			name: Type.Optional(Type.String({ description: "Habit name (for create)" })),
			description: Type.Optional(Type.String()),
			cycle_type: Type.Optional(Type.String({ description: "d=day, w=week, m=month, y=year, bi=biweekly, q=quarterly" })),
			frequency: Type.Optional(Type.Number()),
			time_zone: Type.Optional(Type.String()),
			check_in_date: Type.Optional(Type.String({ description: "YYYY-MM-DD for checkin" })),
			score: Type.Optional(Type.Number({ description: "1-7 for checkin" })),
			habit_ids: Type.Optional(Type.String({ description: "Comma-separated habit IDs for list_checkins" })),
			from_stamp: Type.Optional(Type.Number({ description: "Timestamp for list_checkins" })),
			to_stamp: Type.Optional(Type.Number({ description: "Timestamp for list_checkins" })),
		}),
		async execute(_tcid, params, _sig, _onUpdate) {
			switch (params.action) {
				case "list": {
					const r = await mcpCall("list_habits", {});
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "list_sections": {
					const r = await mcpCall("list_habit_sections", {});
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "get": {
					if (!params.habit_id) return { content: [{ type: "text", text: "Error: habit_id required" }], details: {} };
					const r = await mcpCall("get_habit", { habit_id: params.habit_id });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "create": {
					if (!params.name) return { content: [{ type: "text", text: "Error: name required" }], details: {} };
					const habit: Record<string, unknown> = { name: params.name };
					if (params.description) habit.description = params.description;
					if (params.cycle_type) habit.cycle_type = params.cycle_type;
					if (params.frequency !== undefined) habit.frequency = params.frequency;
					if (params.time_zone) habit.time_zone = params.time_zone;
					const r = await mcpCall("create_habit", { habit });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "update": {
					if (!params.habit_id) return { content: [{ type: "text", text: "Error: habit_id required" }], details: {} };
					const habit: Record<string, unknown> = {};
					if (params.name !== undefined) habit.name = params.name;
					if (params.description !== undefined) habit.description = params.description;
					if (params.cycle_type !== undefined) habit.cycle_type = params.cycle_type;
					if (params.frequency !== undefined) habit.frequency = params.frequency;
					if (params.time_zone !== undefined) habit.time_zone = params.time_zone;
					if (Object.keys(habit).length === 0) return { content: [{ type: "text", text: "Error: provide fields to update" }], details: {} };
					const r = await mcpCall("update_habit", { habit_id: params.habit_id, habit });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "checkin": {
					if (!params.habit_id) return { content: [{ type: "text", text: "Error: habit_id required" }], details: {} };
					const checkin_data: Record<string, unknown> = { check_in_date: params.check_in_date ?? today() };
					if (params.score !== undefined) checkin_data.score = params.score;
					const r = await mcpCall("upsert_habit_checkins", { habit_id: params.habit_id, checkin_data });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "list_checkins": {
					if (!params.habit_ids) return { content: [{ type: "text", text: "Error: habit_ids required" }], details: {} };
					if (!params.from_stamp || !params.to_stamp) return { content: [{ type: "text", text: "Error: from_stamp and to_stamp required" }], details: {} };
					const r = await mcpCall("get_habit_checkins", { habit_ids: params.habit_ids.split(",").map((t: string) => t.trim()), from_stamp: params.from_stamp, to_stamp: params.to_stamp });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				default: return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
			}
		},
		renderCall(p, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_habits ")) + theme.fg("muted", p.action);
			if (paramsHas(p, "name")) label += ` "${p.name}"`;
			if (paramsHas(p, "habit_id")) label += ` ${theme.fg("accent", p.habit_id)}`;
			return new Text(label, 0, 0);
		},
	});

	// ── Focus ─────────────────────────────────────────────

	pi.registerTool({
		name: "ticktick_focus",
		label: "TickTick Focus",
		description: "Query focus sessions. Actions: get (today's focus, needs focus_id + type), get_by_time (needs from_time, to_time, type), delete (focus_id + type). type: 0=focus, 1=meditation.",
		parameters: Type.Object({
			action: StringEnum(["get", "get_by_time", "delete"] as const),
			focus_id: Type.Optional(Type.String()),
			type: Type.Optional(Type.Number({ description: "0=focus, 1=meditation" })),
			from_time: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
			to_time: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
		}),
		async execute(_tcid, params, _sig, _onUpdate) {
			switch (params.action) {
				case "get": {
					if (!params.focus_id) return { content: [{ type: "text", text: "Error: focus_id required" }], details: {} };
					if (!params.type) return { content: [{ type: "text", text: "Error: type required (0=focus, 1=meditation)" }], details: {} };
					const r = await mcpCall("get_focus", { focus_id: params.focus_id, type: params.type });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "get_by_time": {
					if (!params.from_time || !params.to_time) return { content: [{ type: "text", text: "Error: from_time and to_time required" }], details: {} };
					if (!params.type) return { content: [{ type: "text", text: "Error: type required (0=focus, 1=meditation)" }], details: {} };
					const r = await mcpCall("get_focuses_by_time", { from_time: params.from_time, to_time: params.to_time, type: params.type });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				case "delete": {
					if (!params.focus_id) return { content: [{ type: "text", text: "Error: focus_id required" }], details: {} };
					if (!params.type) return { content: [{ type: "text", text: "Error: type required (0=focus, 1=meditation)" }], details: {} };
					const r = await mcpCall("delete_focus", { focus_id: params.focus_id, type: params.type });
					if (!r.ok) return { content: [{ type: "text", text: r.error! }], details: {} };
					return { content: r.content!, details: {} };
				}
				default: return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
			}
		},
		renderCall(p, theme) {
			let label = theme.fg("toolTitle", theme.bold("ticktick_focus ")) + theme.fg("muted", p.action);
			if (p.focus_id) label += ` ${theme.fg("dim", p.focus_id)}`;
			return new Text(label, 0, 0);
		},
	});

	// ── Commands ──────────────────────────────────────────

	pi.registerCommand("ticktick", {
		description: "View TickTick status and configuration",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) { ctx.ui.notify("/ticktick requires interactive mode", "error"); return; }
			const cfg = loadConfig();
			if (!cfg.ok) {
				ctx.ui.notify(cfg.error ?? "TickTick not configured", "warning");
			} else {
				ctx.ui.notify(`TickTick connected\nToken: ${cfg.token!.slice(0, 8)}...\nRun /ticktick-setup to change.`, "info");
			}
		},
	});

	pi.registerCommand("ticktick-setup", {
		description: "Set up or update your TickTick API token",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) { ctx.ui.notify("/ticktick-setup requires interactive mode", "error"); return; }
			const existing = loadConfig();
			const placeholder = existing.ok ? "Paste your new token here" : "Paste your TickTick API token here";
			const prompt = ctx.ui.theme.fg("accent", "TickTick API Token");
			const value = await ctx.ui.input(prompt, placeholder);
			if (!value || value.trim() === "") { ctx.ui.notify("Token cannot be empty", "warning"); return; }
			const token = value.trim();
			if (saveConfig(token)) {
				cachedConfig.token = token;
				const test = await mcpCall("list_projects", {});
				ctx.ui.notify(test.ok ? "TickTick connected!" : `Token saved but failed: ${test.error}`, test.ok ? "success" : "warning");
			} else ctx.ui.notify("Failed to save config", "error");
		},
	});
}
