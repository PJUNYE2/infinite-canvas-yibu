import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "../config.js";
import { logger } from "../utils/logger.js";
import { field, type JsonRecord } from "../utils/value.js";
import type { CodexNotificationParams, CodexPlanUpdate, CodexRequestMethod, CodexRequestParams, CodexRequestResult, CodexTurnInput } from "./codex-protocol.js";
import type { AgentEmit, AgentPermissionMode } from "./types.js";

type AgentEvent = JsonRecord & { type: string; usage?: unknown };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type ItemDeltaParams = { threadId: string; turnId: string; itemId: string; delta: string };
type PendingDelta = { delta: string; itemType: string; params: ItemDeltaParams; timer: ReturnType<typeof setTimeout> };

const canvasAgentMcp = canvasAgentMcpCommand();
const require = createRequire(import.meta.url);
const STREAM_UPDATE_INTERVAL_MS = 40;

/** 封装 Codex app-server 的 JSON-RPC 通信与事件转换。 */
export class CodexAppClient {
    private nextId = 1;
    private buffer = "";
    private currentThreadId = "";
    private currentTurnId = "";
    private textByItem = new Map<string, string>();
    private lastUsage: unknown = null;
    private pending = new Map<number, PendingRequest>();
    private activeTurns = new Map<string, PendingRequest>();
    private completedTurns = new Map<string, Error | null>();
    private pendingDeltas = new Map<string, PendingDelta>();
    private plansByTurn = new Map<string, CodexPlanUpdate>();
    private approvalRequests = new Map<string, { id: number; method: string; params: JsonRecord }>();

    /** 保存 app-server 子进程和事件出口。 */
    private constructor(private child: ChildProcess, private emit: AgentEmit) {}

    /** 启动并初始化 Codex app-server。 */
    static async start(emit: AgentEmit, onExit: () => void) {
        logger.info("Starting Codex app-server", { executable: process.execPath, codex: codexBin() });
        const child = spawn(process.execPath, [codexBin(), "app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const client = new CodexAppClient(child, emit);
        child.stdout?.on("data", (chunk) => client.read(chunk.toString()));
        child.stderr?.on("data", (chunk) => {
            const text = chunk.toString();
            logger.warn("Codex app-server stderr", { text });
            emit("agent_log", { text });
        });
        child.on("error", (error) => {
            logger.error("Codex app-server process error", error);
            emit("agent_error", { message: error.message });
        });
        child.on("exit", (code) => {
            logger.warn("Codex app-server exited", { code });
            client.failAll(`Codex app-server exited: ${code ?? 0}`);
            onExit();
            emit("agent_log", { text: `Codex app-server exited: ${code ?? 0}` });
        });
        await client.request("initialize", { clientInfo: { name: "canvas-agent", title: "Infinite Canvas Agent", version: VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
        client.notify("initialized");
        return client;
    }

    /** 创建新的 Codex 线程。 */
    async startThread(cwd?: string, permissionMode: AgentPermissionMode = "request") {
        const { thread } = await this.request("thread/start", { ...threadSettings(permissionMode), ...(cwd ? { cwd } : {}), threadSource: "user" });
        if (!thread.id) throw new Error("Codex app-server 没有返回 thread id");
        return thread;
    }

    /** 恢复已有 Codex 线程。 */
    async resumeThread(threadId: string, cwd?: string, permissionMode: AgentPermissionMode = "request") {
        const { thread } = await this.request("thread/resume", { threadId, ...threadSettings(permissionMode), ...(cwd ? { cwd } : {}) });
        if (!thread.id) throw new Error("Codex app-server 没有返回 thread id");
        return thread;
    }

    /** 查询 Codex 线程列表。 */
    listThreads(params: CodexRequestParams<"thread/list">) {
        return this.request("thread/list", params);
    }

    /** 读取指定 Codex 线程。 */
    readThread(threadId: string, includeTurns = true) {
        return this.request("thread/read", { threadId, includeTurns });
    }

    /** 归档指定 Codex 线程。 */
    archiveThread(threadId: string) {
        return this.request("thread/archive", { threadId });
    }

    /** 返回指定线程在当前进程中收到的最新任务计划。 */
    planUpdates(threadId: string) {
        return [...this.plansByTurn.values()].filter((item) => item.threadId === threadId);
    }

    /** 清理已归档线程的任务计划缓存。 */
    clearPlanUpdates(threadId: string) {
        this.plansByTurn.forEach((item, turnId) => {
            if (item.threadId === threadId) this.plansByTurn.delete(turnId);
        });
    }

    /** 启动一个 Codex turn 并等待完成通知。 */
    async startTurn(threadId: string, prompt: string, images: string[], permissionMode: AgentPermissionMode, onTurn?: (turnId: string) => void) {
        this.currentThreadId = threadId;
        const { turn } = await this.request("turn/start", { threadId, input: codexInput(prompt, images), ...turnSettings(permissionMode) });
        const turnId = turn.id;
        if (!turnId) throw new Error("Codex app-server 没有返回 turn id");
        this.currentTurnId = turnId;
        onTurn?.(turnId);
        const completed = this.completedTurns.get(turnId);
        if (this.completedTurns.has(turnId)) {
            this.completedTurns.delete(turnId);
            this.currentThreadId = "";
            this.currentTurnId = "";
            if (completed) throw completed;
            return;
        }
        await new Promise((resolve, reject) => this.activeTurns.set(turnId, { resolve, reject }));
    }

    /** 中断当前正在运行的 Codex turn。 */
    async interruptCurrentTurn() {
        const threadId = this.currentThreadId;
        const turnId = this.currentTurnId;
        if (!threadId || !turnId) return false;
        try {
            logger.warn("Interrupting active Codex turn", { threadId, turnId });
            await this.request("turn/interrupt", { threadId, turnId });
            return true;
        } catch (error) {
            logger.warn("Failed to interrupt Codex turn", { error, threadId, turnId });
            return false;
        }
    }

    /** 回复网页端已经确认的 Codex 权限请求。 */
    resolveApproval(requestId: string, decision: string) {
        const request = this.approvalRequests.get(requestId);
        if (!request) return false;
        this.approvalRequests.delete(requestId);
        const permissions = field(request.params, "permissions") || field(request.params, "requestedPermissions");
        const result = request.method === "item/permissions/requestApproval"
            ? { permissions: decision === "decline" ? {} : permissions || {}, scope: decision === "acceptForSession" ? "session" : "turn" }
            : { decision };
        this.write({ id: request.id, result });
        return true;
    }

    /** 发送 JSON-RPC 请求并保存待处理 Promise。 */
    private request<Method extends CodexRequestMethod>(method: Method, params: CodexRequestParams<Method>) {
        const id = this.nextId++;
        this.write({ id, method, params });
        return new Promise<CodexRequestResult<Method>>((resolve, reject) => this.pending.set(id, { resolve: (result) => resolve(result as CodexRequestResult<Method>), reject }));
    }

    /** 发送无需响应的 JSON-RPC 通知。 */
    private notify(method: string, params?: unknown) {
        this.write(params === undefined ? { method } : { method, params });
    }

    /** 将 JSON-RPC 消息写入 app-server 标准输入。 */
    private write(value: unknown) {
        const method = String(field(value, "method") || "");
        const params = field(value, "params");
        if (method) logger.debug(`Codex ${method}`, { id: field(value, "id"), threadId: field(params, "threadId") });
        this.child.stdin?.write(`${JSON.stringify(value)}\n`);
    }

    /** 按行解析 app-server 标准输出。 */
    private read(chunk: string) {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || "";
        lines.filter(Boolean).forEach((line) => {
            try {
                this.handle(JSON.parse(line) as JsonRecord);
            } catch (error) {
                logger.warn("Invalid Codex app-server output", { error, line });
                this.emit("agent_log", { text: line });
            }
        });
    }

    /** 分派单条 JSON-RPC 响应、请求或通知。 */
    private handle(message: JsonRecord) {
        const id = Number(message.id);
        if (message.error && this.pending.has(id)) {
            const error = String(field(message.error, "message") || "Codex request failed");
            if (/not materialized yet.*includeTurns/i.test(error)) logger.debug("Codex thread has no messages yet", { id });
            else logger.warn("Codex request failed", { id, error });
            return this.reject(id, error);
        }
        if (this.pending.has(id)) return this.resolve(id, message.result);
        if (typeof message.method === "string" && "id" in message) return this.answerServerRequest(message);
        if (typeof message.method === "string") this.handleNotification(message.method, (message.params || {}) as JsonRecord);
    }

    /** 转换并广播 app-server 通知。 */
    private handleNotification(method: string, params: JsonRecord) {
        if (method === "serverRequest/resolved") {
            const requestId = String(field(params, "requestId") || "");
            if (requestId) this.approvalRequests.delete(requestId);
            this.emit("codex_approval_resolved", { requestId, ...params });
            return;
        }
        if (!field(params, "threadId") && this.currentThreadId && (method === "turn/started" || method === "turn/completed" || method === "turn/plan/updated")) params = { ...params, threadId: this.currentThreadId };
        if (method === "item/agentMessage/delta") {
            const value = params as unknown as CodexNotificationParams<"item/agentMessage/delta">;
            this.textByItem.set(value.itemId, `${this.textByItem.get(value.itemId) || ""}${value.delta}`);
            return this.emitDelta("agent_message", value);
        }
        if (method === "item/plan/delta") return this.emitDelta("plan", params as unknown as CodexNotificationParams<"item/plan/delta">);
        if (method === "item/reasoning/summaryTextDelta") return this.emitDelta("reasoning", params as unknown as CodexNotificationParams<"item/reasoning/summaryTextDelta">);
        if (method === "item/commandExecution/outputDelta") return this.emitDelta("command_execution", params as unknown as CodexNotificationParams<"item/commandExecution/outputDelta">);
        if (method === "turn/plan/updated") {
            const value = params as unknown as CodexNotificationParams<"turn/plan/updated">;
            const update: CodexPlanUpdate = { ...value, threadId: value.threadId || "" };
            if (update.threadId && update.turnId) this.plansByTurn.set(update.turnId, update);
            params = update as unknown as JsonRecord;
        }
        if (method === "thread/tokenUsage/updated") {
            this.lastUsage = normalizeUsage(params as unknown as CodexNotificationParams<"thread/tokenUsage/updated">);
            this.emit("agent_event", { agent: "codex", type: "usage.updated", usage: this.lastUsage, ...codexEventScope(params) });
            return;
        }
        const event = normalizeCodexNotification(method, params);
        if (!event) return;
        if (event.type === "item.completed") {
            const item = field(event, "item") as JsonRecord | undefined;
            const id = String(field(item, "id") || "");
            this.flushDelta(id);
            const streamedText = this.textByItem.get(id);
            if (item?.type === "agent_message" && streamedText && !item.text) item.text = streamedText;
            if (id) this.textByItem.delete(id);
        }
        if (event.type === "turn.completed") {
            const turn = field(params, "turn");
            const turnId = String(field(turn, "id") || field(params, "turnId") || "");
            const plan = this.plansByTurn.get(turnId);
            if (plan) this.plansByTurn.set(turnId, { ...plan, turnStatus: String(field(turn, "status") || "completed") });
        }
        if (event.type === "turn.completed") event.usage = this.lastUsage;
        this.emit("agent_event", { agent: "codex", ...event });
        if (event.type === "turn.completed") {
            const turn = (params as unknown as CodexNotificationParams<"turn/completed">).turn;
            const turnId = turn.id;
            const pending = this.activeTurns.get(turnId);
            const error = turn.error;
            if (pending) {
                this.activeTurns.delete(turnId);
                error ? pending.reject(new Error(error.message || "Codex turn failed")) : pending.resolve(event);
            } else if (turnId) {
                this.completedTurns.set(turnId, error ? new Error(error.message || "Codex turn failed") : null);
            }
            if (turnId === this.currentTurnId) {
                this.currentThreadId = "";
                this.currentTurnId = "";
            }
            this.emit("agent_done", { agent: "codex", usage: event.usage, ...codexEventScope(params) });
        }
    }

    /** 合并并广播 Agent 文本或执行输出增量。 */
    private emitDelta(itemType: string, params: ItemDeltaParams) {
        const id = params.itemId;
        const pending = this.pendingDeltas.get(id);
        if (pending) {
            pending.delta += params.delta;
            pending.itemType = itemType;
            pending.params = params;
            return;
        }
        this.pendingDeltas.set(id, {
            delta: params.delta,
            itemType,
            params,
            timer: setTimeout(() => this.flushDelta(id), STREAM_UPDATE_INTERVAL_MS),
        });
    }

    /** 合并短时间内的文本增量，减少 SSE 传输和前端渲染次数。 */
    private flushDelta(id: string) {
        const pending = this.pendingDeltas.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingDeltas.delete(id);
        if (pending.delta) this.emit("agent_event", { agent: "codex", type: "item.updated", item: { id, type: pending.itemType, delta: pending.delta }, ...codexEventScope(pending.params as unknown as JsonRecord) });
    }

    /** 自动回复 app-server 发起的授权或交互请求。 */
    private answerServerRequest(message: JsonRecord) {
        const method = String(message.method);
        const params = (field(message, "params") as JsonRecord) || {};
        if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(method)) {
            const requestId = String(message.id);
            this.approvalRequests.set(requestId, { id: Number(message.id), method, params });
            this.emit("codex_approval", { requestId, method, ...params });
            return;
        }
        const result = method === "mcpServer/elicitation/request" ? { action: "accept", content: {}, _meta: null } : { decision: "decline" };
        this.write({ id: message.id, result });
        this.emit("agent_event", { agent: "codex", type: "server.request", method, params, result });
    }

    /** 完成指定 JSON-RPC 请求。 */
    private resolve(id: number, result: unknown) {
        const pending = this.pending.get(id);
        if (pending) (this.pending.delete(id), pending.resolve(result));
    }

    /** 拒绝指定 JSON-RPC 请求。 */
    private reject(id: number, message: string) {
        const pending = this.pending.get(id);
        if (pending) (this.pending.delete(id), pending.reject(new Error(message)));
    }

    /** 拒绝进程退出时仍未完成的请求与 turn。 */
    private failAll(message: string) {
        [...this.pending.values(), ...this.activeTurns.values()].forEach((item) => item.reject(new Error(message)));
        this.pendingDeltas.forEach((item) => clearTimeout(item.timer));
        this.pending.clear();
        this.activeTurns.clear();
        this.pendingDeltas.clear();
        this.textByItem.clear();
        this.approvalRequests.clear();
        this.currentThreadId = "";
        this.currentTurnId = "";
    }
}

/** 生成 Codex 调用 Canvas Agent MCP 的启动命令。 */
function canvasAgentMcpCommand() {
    const current = process.argv.find((arg) => /index\.(t|j)s$/.test(arg)) || "";
    const entry = path.resolve(current || fileURLToPath(new URL("../index.js", import.meta.url)));
    const tsx = path.join(path.dirname(entry), "..", "node_modules", "tsx", "dist", "cli.mjs");
    return entry.endsWith(".ts") ? { command: process.execPath, args: [tsx, entry, "mcp"] } : { command: process.execPath, args: [entry, "mcp"] };
}

/** 生成 Codex app-server 使用的 MCP 配置。 */
function codexConfig(permissionMode: AgentPermissionMode) {
    return { model_reasoning_summary: "auto", ...(permissionMode === "automatic" ? { approvals_reviewer: "auto_review" } : {}), mcp_servers: { "infinite-canvas": { command: canvasAgentMcp.command, args: canvasAgentMcp.args, default_tools_approval_mode: "approve", startup_timeout_sec: 20, tool_timeout_sec: 90 } } };
}

function threadSettings(permissionMode: AgentPermissionMode) {
    return { approvalPolicy: permissionMode === "full" ? "never" as const : "on-request" as const, sandbox: permissionMode === "full" ? "danger-full-access" as const : "workspace-write" as const, config: codexConfig(permissionMode) };
}

function turnSettings(permissionMode: AgentPermissionMode) {
    return {
        approvalPolicy: permissionMode === "full" ? "never" as const : "on-request" as const,
        sandboxPolicy: permissionMode === "full" ? { type: "dangerFullAccess" as const } : { type: "workspaceWrite" as const, networkAccess: false },
    };
}

/** 将文本和本地图片转换为 Codex turn 输入。 */
function codexInput(prompt: string, images: string[]): CodexTurnInput[] {
    return [{ type: "text", text: prompt, text_elements: [] }, ...images.map<CodexTurnInput>((file) => ({ type: "localImage", path: file }))];
}

/** 将 app-server 通知转换为前端使用的 Agent 事件。 */
function normalizeCodexNotification(method: string, params: JsonRecord): AgentEvent | null {
    const scope = codexEventScope(params);
    if (method === "thread/started") return { type: "thread.started", ...scope };
    if (method === "turn/started") return { type: "turn.started", ...scope };
    if (method === "turn/completed") return { type: "turn.completed", status: field(field(params, "turn"), "status"), error: field(field(params, "turn"), "error"), usage: null, duration_ms: field(field(params, "turn"), "durationMs"), ...scope };
    if (method === "turn/plan/updated") return { type: "plan.updated", explanation: field(params, "explanation"), plan: field(params, "plan"), ...scope };
    if (method === "item/started") return { type: "item.started", item: normalizeItem(field(params, "item")), ...scope };
    if (method === "item/completed") return { type: "item.completed", item: normalizeItem(field(params, "item")), ...scope };
    if (method === "error") return { type: "error", message: field(field(params, "error"), "message"), ...scope };
    return null;
}

/** 提取 Codex 事件所属的线程和 turn。 */
function codexEventScope(params: JsonRecord) {
    const threadId = String(field(params, "threadId") || field(field(params, "thread"), "id") || "");
    const turnId = String(field(params, "turnId") || field(field(params, "turn"), "id") || "");
    return { ...(threadId ? { thread_id: threadId } : {}), ...(turnId ? { turn_id: turnId } : {}) };
}

/** 统一 app-server item 的类型和参数格式。 */
function normalizeItem(item: unknown) {
    const value = item && typeof item === "object" ? { ...(item as JsonRecord) } : {};
    if (value.type === "agentMessage") value.type = "agent_message";
    if (value.type === "mcpToolCall") value.type = "mcp_tool_call";
    if (value.type === "commandExecution") value.type = "command_execution";
    if (value.type === "fileChange") value.type = "file_change";
    if (value.type === "dynamicToolCall") value.type = "dynamic_tool_call";
    if (value.type === "collabToolCall") value.type = "collab_tool_call";
    if (value.type === "webSearch") value.type = "web_search";
    if (value.type === "imageView") value.type = "image_view";
    if (value.type === "imageGeneration") value.type = "image_generation";
    if (value.type === "contextCompaction") value.type = "context_compaction";
    if (value.type === "agent_message" && typeof value.id === "string") value.text = String(value.text || "");
    if ("arguments" in value) value.arguments = parseMaybeJson(value.arguments);
    return value;
}

/** 将 Codex token usage 转换为前端字段。 */
function normalizeUsage(params: CodexNotificationParams<"thread/tokenUsage/updated">) {
    const last = params.tokenUsage.last;
    return {
        input_tokens: last.inputTokens,
        cached_input_tokens: last.cachedInputTokens,
        output_tokens: last.outputTokens,
        reasoning_output_tokens: last.reasoningOutputTokens,
    };
}

/** 尝试将字符串解析为 JSON，失败时保留原值。 */
function parseMaybeJson(value: unknown) {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

/** 定位当前依赖中 Codex CLI 的执行文件。 */
function codexBin() {
    return path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
}
