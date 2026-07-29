import { field } from "../utils/value.js";
import type { CodexPlanUpdate } from "./codex-protocol.js";

type AgentHistoryMessage = { id: string; role: "user" | "assistant" | "tool" | "error"; title?: string; text: string; detail?: unknown; streamId?: string };

/** 将 Codex 线程转换为列表展示所需的摘要。 */
export function summarizeCodexThread(thread: unknown) {
    return {
        id: String(field(thread, "id") || ""),
        sessionId: String(field(thread, "sessionId") || ""),
        preview: displayUserText(String(field(thread, "preview") || "")),
        name: stringOrNull(field(thread, "name")),
        cwd: String(field(thread, "cwd") || ""),
        status: String(field(thread, "status") || ""),
        source: field(thread, "source"),
        threadSource: field(thread, "threadSource"),
        createdAt: Number(field(thread, "createdAt") || 0),
        updatedAt: Number(field(thread, "updatedAt") || 0),
    };
}

/** 将 Codex turn items 转换为网页聊天历史。 */
export function threadMessages(thread: unknown, planUpdates: CodexPlanUpdate[] = []): AgentHistoryMessage[] {
    const turns = arrayValue(field(thread, "turns"));
    const plansByTurn = new Map(planUpdates.map((item) => [item.turnId, item]));
    const messages: AgentHistoryMessage[] = [];
    turns.forEach((turn, turnIndex) => {
        const turnId = String(field(turn, "id") || turnIndex);
        const turnError = String(field(field(turn, "error"), "message") || "").trim();
        const planMessage = structuredPlanMessage(plansByTurn.get(turnId) || { threadId: "", turnId, explanation: stringOrNull(field(turn, "explanation")), plan: arrayValue(field(turn, "plan")) as CodexPlanUpdate["plan"], turnStatus: String(field(turn, "status") || "") });
        let planAdded = false;
        arrayValue(field(turn, "items")).forEach((item, itemIndex) => {
            const type = String(field(item, "type") || "");
            const id = String(field(item, "id") || `${turnIndex}-${itemIndex}`);
            if (type === "userMessage") {
                const text = displayUserText(userInputText(field(item, "content")));
                if (text) messages.push({ id, role: "user", text });
                if (planMessage && !planAdded) {
                    messages.push(planMessage);
                    planAdded = true;
                }
            }
            if (type === "agentMessage") {
                const text = String(field(item, "text") || "").trim();
                if (text) messages.push({ id, role: "assistant", title: "Codex", text });
            }
            if (type === "mcpToolCall") {
                const tool = String(field(item, "tool") || "工具调用");
                const error = String(field(field(item, "error"), "message") || "");
                const input = toolArguments(field(item, "arguments"));
                messages.push({ id, role: "tool", title: toolName(tool), text: error || toolHistorySummary(tool, input), detail: toolHistoryDetail(tool, item, input, error) });
            }
            if (type === "commandExecution") {
                const command = String(field(item, "command") || "").trim();
                if (command) messages.push({ id, role: "tool", title: "执行命令", text: command, detail: commandDetail(item) });
            }
            if (type === "fileChange") {
                const changes = arrayValue(field(item, "changes"));
                messages.push({ id, role: "tool", title: "修改文件", text: fileChangeSummary(changes), detail: { kind: "file", status: field(item, "status"), files: changes.map((change) => ({ path: String(field(change, "path") || "未知文件"), action: changeKind(field(change, "kind")) })) } });
            }
            if (type === "reasoning") {
                const text = readableText(field(item, "summary"));
                if (text) messages.push({ id, role: "tool", title: "思考摘要", text, detail: { kind: "reasoning", status: "completed" } });
            }
            if (type === "plan") {
                const text = String(field(item, "text") || "").trim();
                if (text) messages.push({ id, role: "tool", title: "执行计划", text, detail: { kind: "plan", status: "completed" } });
            }
            if (type === "webSearch") messages.push({ id, role: "tool", title: "搜索资料", text: webSearchSummary(item), detail: { kind: "search", status: "completed", rows: webSearchRows(item) } });
            if (type === "imageView") messages.push({ id, role: "tool", title: "查看图片", text: String(field(item, "path") || "已查看图片"), detail: { kind: "image", status: "completed" } });
            if (type === "imageGeneration") messages.push({ id, role: "tool", title: "内置生图", text: String(field(item, "savedPath") || "图片生成完成"), detail: { kind: "image", status: field(item, "status"), savedPath: field(item, "savedPath") } });
            if (type === "contextCompaction") messages.push({ id, role: "tool", title: "整理上下文", text: "已整理当前对话，继续处理任务", detail: { kind: "context", status: "completed" } });
            if (type === "dynamicToolCall") messages.push({ id, role: "tool", title: "使用工具", text: "已完成工具操作", detail: { kind: "tool", status: field(item, "status") } });
            if (type === "collabToolCall") messages.push({ id, role: "tool", title: "协作处理", text: "已完成协作任务", detail: { kind: "tool", status: field(item, "status") } });
        });
        if (planMessage && !planAdded) messages.push(planMessage);
        if (turnError) {
            const error = userFacingCodexError(turnError);
            messages.push({ id: `error-${turnId}`, role: "error", title: error.title, text: error.text });
        }
    });
    return messages.filter((item) => item.text).slice(-120);
}

/** 将结构化任务计划转换为聊天进度卡片。 */
function structuredPlanMessage(update: CodexPlanUpdate): AgentHistoryMessage | null {
    const tasks = arrayValue(update.plan).flatMap((item) => {
        const step = String(field(item, "step") || "").trim();
        return step ? [{ step, status: String(field(item, "status") || "pending") }] : [];
    });
    if (!tasks.length) return null;
    const completed = tasks.filter((item) => item.status === "completed").length;
    return {
        id: `plan-${update.turnId}`,
        role: "tool",
        title: "任务进度",
        text: `已完成 ${completed}/${tasks.length} 项`,
        detail: { kind: "todo", status: planStatus(tasks, update.turnStatus), tasks, explanation: update.explanation || "" },
    };
}

/** 根据步骤和 turn 状态生成任务卡片状态。 */
function planStatus(tasks: Array<{ status: string }>, turnStatus?: string) {
    if (turnStatus === "failed") return "failed";
    if (turnStatus === "interrupted") return "interrupted";
    if (tasks.every((item) => item.status === "completed")) return "completed";
    return turnStatus === "completed" ? "finished" : "inProgress";
}

/** 将常见 Codex 错误转换为普通用户可理解的提示。 */
function userFacingCodexError(message: string) {
    if (/selected model is at capacity/i.test(message)) return { title: "模型暂时繁忙", text: "当前选择的模型请求量过大，暂时无法处理。请稍后重试，或切换其他模型后再试。" };
    return { title: "任务失败", text: message || "Codex 未能完成本次任务，请稍后重试。" };
}

/** 提取用户输入条目中的文本与附件占位信息。 */
function userInputText(content: unknown) {
    return arrayValue(content)
        .map((item) => {
            const type = String(field(item, "type") || "");
            if (type === "text") return String(field(item, "text") || "");
            if (type === "image" || type === "localImage") return "图片附件";
            if (type === "mention") return `@${String(field(item, "name") || "文件")}`;
            return "";
        })
        .filter(Boolean)
        .join("\n");
}

/** 移除用户消息中由旧流程拼接的 Agent 前置提示词。 */
function displayUserText(text: string) {
    const value = text.trim();
    const marker = "用户请求：";
    const index = value.lastIndexOf(marker);
    const prompt = index >= 0 ? value.slice(index + marker.length) : value;
    return prompt.split("\n\n本轮可用图片附件（顺序与图片输入一致）：", 1)[0].trim();
}

/** 将未知值转换为数组。 */
function arrayValue(value: unknown) {
    return Array.isArray(value) ? value : [];
}

/** 将非空字符串保留为字符串，否则返回 null。 */
function stringOrNull(value: unknown) {
    return typeof value === "string" && value.trim() ? value : null;
}

/** 生成命令执行的用户可读详情。 */
function commandDetail(item: unknown) {
    const rows = [
        textRow("工作目录", field(item, "cwd")),
        textRow("退出状态", field(item, "exitCode")),
        durationRow(field(item, "durationMs")),
    ].filter(Boolean);
    return { kind: "command", status: field(item, "status"), rows, output: String(field(item, "aggregatedOutput") || "").trim() };
}

/** 生成 MCP 工具的用户可读详情。 */
function toolHistoryDetail(tool: string, item: unknown, input: unknown, error: string) {
    return { kind: "tool", status: error ? "failed" : field(item, "status"), rows: toolInputRows(tool, input), ...(error ? { output: error } : {}) };
}

/** 生成 MCP 工具在对话中的结果摘要。 */
function toolHistorySummary(tool: string, input: unknown) {
    if (tool === "site_navigate") return `已打开${routeName(String(field(input, "path") || "/"))}`;
    if (tool === "canvas_list_projects") return "已读取画布列表";
    if (tool === "canvas_get_state") return "已读取当前画布内容";
    if (tool === "canvas_get_selection") return "已读取当前选中内容";
    if (tool === "prompts_search") return `已搜索提示词“${String(field(input, "query") || "") || "全部"}”`;
    if (tool === "assets_list") return "已读取我的素材";
    if (tool === "generation_get_status") return "已检查生成任务状态";
    return `${toolName(tool)}已完成`;
}

/** 提取工具参数中适合普通用户查看的信息。 */
function toolInputRows(tool: string, input: unknown) {
    if (tool === "site_navigate") return [textRow("目标页面", routeName(String(field(input, "path") || "/")))].filter(Boolean);
    if (tool === "prompts_search") return [textRow("搜索内容", field(input, "query"))].filter(Boolean);
    if (tool === "canvas_create_text_node") return [textRow("文本内容", field(input, "text"))].filter(Boolean);
    if (tool === "canvas_apply_ops") return [textRow("操作数量", arrayValue(field(input, "ops")).length)].filter(Boolean);
    return [];
}

/** 生成人类可读的文件变更摘要。 */
function fileChangeSummary(changes: unknown[]) {
    if (!changes.length) return "已完成文件修改";
    const names = changes.slice(0, 3).map((change) => String(field(change, "path") || "未知文件"));
    if (changes.length === 1) return `${changeKind(field(changes[0], "kind"))}${names[0]}`;
    return `涉及 ${changes.length} 个文件：${names.join("、")}${changes.length > names.length ? " 等" : ""}`;
}

/** 生成网页搜索摘要。 */
function webSearchSummary(item: unknown) {
    const action = field(item, "action");
    const type = String(field(action, "type") || "");
    if (type === "openPage") return `打开网页：${String(field(action, "url") || "")}`;
    if (type === "findInPage") return `在网页中查找“${String(field(action, "pattern") || "内容")}”`;
    return `搜索：${String(field(item, "query") || field(action, "query") || "相关资料")}`;
}

/** 生成网页搜索详情行。 */
function webSearchRows(item: unknown) {
    const action = field(item, "action");
    return [textRow("关键词", field(item, "query") || field(action, "query")), textRow("网页", field(action, "url"))].filter(Boolean);
}

/** 从 reasoning 结构中提取可读文本。 */
function readableText(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) return value.map(readableText).filter(Boolean).join("\n");
    return readableText(field(value, "text"));
}

/** 将历史工具参数解析为对象。 */
function toolArguments(value: unknown) {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return {};
    }
}

/** 创建非空详情行。 */
function textRow(label: string, value: unknown) {
    return value === undefined || value === null || value === "" ? null : { label, value: String(value) };
}

/** 创建命令耗时详情行。 */
function durationRow(value: unknown) {
    const duration = Number(value || 0);
    return duration > 0 ? { label: "耗时", value: `${(duration / 1000).toFixed(1)} 秒` } : null;
}

/** 将文件变更类型转换为中文。 */
function changeKind(value: unknown) {
    if (value === "add") return "新增";
    if (value === "delete") return "删除";
    return "修改";
}

/** 将站点路由转换为中文页面名称。 */
function routeName(path: string) {
    if (path === "/") return "首页";
    if (path === "/canvas") return "画布页面";
    if (path.startsWith("/canvas/")) return "指定画布";
    if (path.startsWith("/image")) return "生图工作台";
    if (path.startsWith("/video")) return "视频工作台";
    if (path.startsWith("/prompts")) return "提示词中心";
    if (path.startsWith("/assets")) return "我的素材";
    if (path.startsWith("/config")) return "配置页面";
    return path;
}

/** 将 MCP 工具名称转换为聊天记录中的中文标题。 */
function toolName(name: string) {
    if (name === "site_navigate") return "打开页面";
    if (name === "canvas_list_projects") return "查看画布列表";
    if (name === "canvas_apply_ops") return "画布操作";
    if (name === "canvas_get_state") return "读取画布";
    if (name === "canvas_get_selection") return "读取选区";
    if (name === "canvas_export_snapshot") return "导出快照";
    if (name === "canvas_create_node") return "创建节点";
    if (name === "canvas_create_attachment_nodes") return "添加附件图片";
    if (name === "canvas_create_text_node") return "创建文本";
    if (name === "canvas_create_text_nodes") return "批量创建文本";
    if (name === "canvas_create_config_node") return "创建生成配置";
    if (name === "canvas_create_image_prompt_flow") return "创建生图流程";
    if (name === "canvas_create_generation_flow") return "创建生成流程";
    if (name === "canvas_generate_text") return "生成文本";
    if (name === "canvas_generate_image") return "生成图片";
    if (name === "canvas_generate_video") return "生成视频";
    if (name === "canvas_generate_audio") return "生成音频";
    if (name === "canvas_update_node") return "更新节点";
    if (name === "canvas_update_node_text") return "更新文本";
    if (name === "canvas_move_nodes") return "移动节点";
    if (name === "canvas_resize_node") return "调整节点尺寸";
    if (name === "canvas_delete_nodes") return "删除节点";
    if (name === "canvas_connect_nodes") return "连接节点";
    if (name === "canvas_select_nodes") return "选择节点";
    if (name === "canvas_set_viewport") return "调整视口";
    if (name === "canvas_run_generation") return "触发生成";
    if (name === "workbench_image_get_config") return "读取生图设置";
    if (name === "workbench_image_generate") return "在生图工作台生成";
    if (name === "workbench_video_get_config") return "读取视频设置";
    if (name === "workbench_video_generate") return "在视频工作台生成";
    if (name === "prompts_search") return "搜索提示词";
    if (name === "assets_list") return "查看我的素材";
    if (name === "assets_add") return "添加到我的素材";
    if (name === "generation_get_status") return "查看生成状态";
    return "工具操作";
}
