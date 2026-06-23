import axios from "axios";

import { buildApiUrl, resolveModelRequestConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

export type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

export type ResponseInputMessage =
    | AiTextMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { role: "tool"; tool_call_id: string; content: string };

export type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

export type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = AiTextMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem =
    | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
    | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string };
type ResponseApiPayload = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string };

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number | string;
    message?: string;
    msg?: string;
};
type ImageAsyncTaskResponse = {
    task_id?: string;
    id?: string;
    status?: string;
    progress?: string | number;
    fail_reason?: string;
    result_url?: string;
    url?: string;
    data?: unknown;
    error?: { message?: string };
    code?: number | string;
    message?: string;
    msg?: string;
};
type RequestOptions = { signal?: AbortSignal; onTaskCreated?: (taskId: string) => void };

export class ImageTaskPollingError extends Error {
    taskId: string;

    constructor(taskId: string, message: string) {
        super(message);
        this.name = "ImageTaskPollingError";
        this.taskId = taskId;
    }
}

export function isImageTaskPollingError(error: unknown): error is ImageTaskPollingError {
    return error instanceof ImageTaskPollingError || Boolean(error && typeof error === "object" && "taskId" in error);
}

class ImageTaskPermanentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ImageTaskPermanentError";
    }
}

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseImageRatio(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("图像比例必须是正数，例如 9:16");
    if (Math.max(w, h) / Math.min(w, h) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    return { width: w, height: h };
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图像尺寸必须是正整数，例如 1024x1024");
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error("图像尺寸的宽高必须是 16 的倍数，请调整尺寸");
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error("图像尺寸最长边不能超过 3840px，请调整尺寸");
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error("图像总像素需在 655360 到 8294400 之间，请调整尺寸");
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
}

function isBananaImageModel(model: string) {
    const value = model.trim().toLowerCase();
    return value.includes("gemini-3-pro-image-preview") || value.includes("gemini-3.1-flash-image-preview") || value.includes("nano-banana") || value.includes("banana");
}

function resolveBananaQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    if (!value || value === "auto") return undefined;
    if (value === "1k") return "1K";
    if (value === "2k") return "2K";
    if (value === "4k") return "4K";
    if (value === "low" || value === "standard") return "1K";
    if (value === "medium" || value === "hd") return "2K";
    if (value === "high") return "4K";
    return undefined;
}

function resolveBananaAspectRatio(size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    if (value.includes(":")) {
        parseImageRatio(value);
        return value;
    }
    const dimensions = parseImageDimensions(value);
    if (!dimensions) throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    validateImageSize(dimensions.width, dimensions.height);
    const divisor = gcd(dimensions.width, dimensions.height);
    return `${dimensions.width / divisor}:${dimensions.height / divisor}`;
}

function gcd(a: number, b: number): number {
    let x = Math.abs(a);
    let y = Math.abs(b);
    while (y) {
        const next = x % y;
        x = y;
        y = next;
    }
    return x || 1;
}

type BananaAsyncPayload = {
    model: string;
    prompt: string;
    image?: string | string[];
    size?: string;
    quality?: string;
    n: number;
    extra_body?: { google: { image_config: { aspect_ratio?: string; image_size: string } } };
};

function buildBananaAsyncPayload(config: AiConfig, prompt: string, images?: string[]): BananaAsyncPayload {
    const quality = resolveBananaQuality(config.quality);
    const aspectRatio = resolveBananaAspectRatio(config.size);
    return {
        model: config.model,
        prompt: withSystemPrompt(config, prompt),
        ...(images?.length ? { image: images.length === 1 ? images[0] : images } : {}),
        ...(aspectRatio ? { size: aspectRatio } : {}),
        ...(quality ? { quality: quality === "4K" ? "2K" : quality } : {}),
        n: 1,
        ...(quality === "4K" ? { extra_body: { google: { image_config: { ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}), image_size: "4K" } } } } : {}),
    };
}

async function submitBananaAsyncTask(config: AiConfig, prompt: string, images: string[] | undefined, options?: RequestOptions) {
    const response = await axios.post<ImageAsyncTaskResponse>(aiApiUrl(config, "/images/generations/async"), buildBananaAsyncPayload(config, prompt, images), { headers: aiHeaders(config, "application/json"), signal: options?.signal });
    const taskId = resolveTaskId(response.data);
    options?.onTaskCreated?.(taskId);
    return await pollSubmittedImageTask(config, taskId, 1, options);
}

function resolveImageDataUrl(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse) {
    if (isFailureCode(payload.code)) {
        throw new Error(payload.msg || payload.message || "请求失败");
    }
    if (payload.error?.message) throw new Error(payload.error.message);
    const images =
        payload.data
            ?.map(resolveImageDataUrl)
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];

    if (images.length === 0) {
        throw new Error("接口没有返回图片");
    }

    return images;
}

function isFailureCode(code: unknown) {
    if (code === undefined || code === null || code === 0 || code === "0" || code === "success") return false;
    return true;
}

function unwrapTaskPayload(payload: ImageAsyncTaskResponse): ImageAsyncTaskResponse {
    if (isFailureCode(payload.code)) throw new Error(payload.msg || payload.message || "请求失败");
    if (payload.error?.message) throw new Error(payload.error.message);
    return isRecord(payload.data) ? { ...payload, ...(payload.data as ImageAsyncTaskResponse) } : payload;
}

function resolveTaskId(payload: ImageAsyncTaskResponse) {
    const task = unwrapTaskPayload(payload);
    const taskId = stringValue(task.task_id) || stringValue(task.id);
    if (!taskId) throw new Error("接口没有返回 task_id");
    return taskId;
}

function normalizeTaskStatus(status: unknown) {
    return String(status || "").trim().toUpperCase();
}

function resolveTaskResultUrls(task: ImageAsyncTaskResponse): string[] {
    const urls = [stringValue(task.result_url), stringValue(task.url)];
    const data = isRecord(task.data) ? task.data : undefined;
    const nestedData = data && isRecord(data.data) ? data.data : undefined;
    const nestedItems = Array.isArray(nestedData?.data) ? nestedData.data : Array.isArray(data?.data) ? data.data : [];
    for (const item of nestedItems) {
        if (isRecord(item)) urls.push(stringValue(item.url));
    }
    return Array.from(new Set(urls.filter(Boolean)));
}

function resolveTaskInlineImages(task: ImageAsyncTaskResponse) {
    const directData = Array.isArray(task.data) ? task.data : [];
    const data = isRecord(task.data) ? task.data : undefined;
    const nestedData = data && isRecord(data.data) ? data.data : undefined;
    const nestedItems = Array.isArray(nestedData?.data) ? nestedData.data : Array.isArray(data?.data) ? data.data : [];
    return [...directData, ...nestedItems]
        .filter(isRecord)
        .map(resolveImageDataUrl)
        .filter((value): value is string => Boolean(value));
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = globalThis.setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                globalThis.clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

async function blobToDataUrl(blob: Blob) {
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
        reader.readAsDataURL(blob);
    });
}

function resolveTaskResultUrl(config: AiConfig, url: string) {
    try {
        return new URL(url).toString();
    } catch {
        if (!url.startsWith("/")) return url;
        return new URL(url, aiApiUrl(config, "/")).toString();
    }
}

async function fetchProtectedImageDataUrl(config: AiConfig, url: string, options?: RequestOptions) {
    const response = await fetch(resolveTaskResultUrl(config, url), { headers: aiHeaders(config), signal: options?.signal });
    if (!response.ok) throw new ImageTaskPermanentError(await readFetchError(response, "获取图片结果失败"));
    return await blobToDataUrl(await response.blob());
}

async function pollSubmittedImageTask(config: AiConfig, taskId: string, expectedCount: number, options?: RequestOptions) {
    try {
        return await pollImageTask(config, taskId, expectedCount, options);
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (error instanceof ImageTaskPermanentError) throw error;
        if (axios.isAxiosError(error) && error.response) throw new ImageTaskPermanentError(readAxiosError(error, "任务查询失败"));
        throw new ImageTaskPollingError(taskId, "生图任务进行中，可等待3-5分钟后点击按钮查询图片");
    }
}

export async function resumeImageTask(config: AiConfig, taskId: string, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    return await pollSubmittedImageTask(requestConfig, taskId, 1, options);
}

async function pollImageTask(config: AiConfig, taskId: string, expectedCount: number, options?: RequestOptions) {
    const timeoutAt = Date.now() + 10 * 60 * 1000;
    let interval = 1200;
    while (Date.now() < timeoutAt) {
        const response = await axios.get<ImageAsyncTaskResponse>(aiApiUrl(config, `/images/tasks/${encodeURIComponent(taskId)}`), { headers: aiHeaders(config), signal: options?.signal });
        const task = unwrapTaskPayload(response.data);
        const status = normalizeTaskStatus(task.status);
        if (status === "FAILURE" || status === "FAILED" || status === "ERROR") throw new ImageTaskPermanentError(stringValue(task.fail_reason) || task.message || task.msg || "图片生成失败");
        if (status === "SUCCESS" || status === "SUCCEEDED" || status === "COMPLETED" || status === "DONE") {
            const inlineImages = resolveTaskInlineImages(task);
            const urls = resolveTaskResultUrls(task);
            const urlImages = await Promise.all(urls.slice(0, expectedCount || urls.length || 1).map((url) => fetchProtectedImageDataUrl(config, url, options)));
            const images = [...inlineImages, ...urlImages].filter(Boolean);
            if (!images.length) throw new Error("任务成功但没有返回图片地址");
            return images.slice(0, expectedCount || images.length).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        }
        await delay(interval, options?.signal);
        interval = Math.min(5000, Math.round(interval * 1.25));
    }
    throw new Error("图片生成任务超时，请稍后重试");
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || readStatusError(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? error.message : fallback;
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}：${status}` : fallback;
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [message];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function parseToolResponse(payload: ResponseApiPayload): ToolResponseResult {
    const output = payload.output || [];
    const content =
        payload.output_text ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    const toolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: item.call_id || item.id || "",
            type: "function" as const,
            function: { name: item.name || "", arguments: item.arguments || "{}" },
        }))
        .filter((item) => item.id && item.function.name);
    return { content, toolCalls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "请求失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return readStatusError(response.status, fallback);
    try {
        return responseErrorMessage(JSON.parse(text)) || readStatusError(response.status, fallback);
    } catch {
        return text.slice(0, 300) || readStatusError(response.status, fallback);
    }
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta?.(state.text);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta?.(state.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        consumeResponseStreamBlock(state.buffer.slice(0, match.index), state, onDelta);
        state.buffer = state.buffer.slice(match.index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    if (!response.body) {
        const payload = (await response.json()) as ResponseApiPayload;
        validateResponsePayload(payload);
        return parseToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeResponseStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeResponseStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    if (!state.payload) return { content: state.text, toolCalls: [] };
    validateResponsePayload(state.payload);
    const result = parseToolResponse(state.payload);
    return { ...result, content: state.text || result.content };
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    if (isBananaImageModel(requestConfig.model)) {
        try {
            return await submitBananaAsyncTask(requestConfig, prompt, undefined, options);
        } catch (error) {
            if (isImageTaskPollingError(error)) throw error;
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const formData = new FormData();
    formData.set("model", requestConfig.model);
    formData.set("prompt", withSystemPrompt(requestConfig, prompt));
    formData.set("response_format", "url");
    if (quality) {
        formData.set("quality", quality);
    }
    if (requestSize) {
        formData.set("size", requestSize);
    }

    try {
        const response = await axios.post<ImageAsyncTaskResponse>(aiApiUrl(requestConfig, "/images/generations/async"), formData, { headers: aiHeaders(requestConfig), signal: options?.signal });
        const taskId = resolveTaskId(response.data);
        options?.onTaskCreated?.(taskId);
        return await pollSubmittedImageTask(requestConfig, taskId, n, options);
    } catch (error) {
        if (isImageTaskPollingError(error)) throw error;
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    if (isBananaImageModel(requestConfig.model)) {
        try {
            const images = await Promise.all(references.map((image) => imageToDataUrl(image)));
            return await submitBananaAsyncTask(requestConfig, requestPrompt, images, options);
        } catch (error) {
            if (isImageTaskPollingError(error)) throw error;
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const formData = new FormData();
    formData.set("model", requestConfig.model);
    formData.set("prompt", withSystemPrompt(requestConfig, requestPrompt));
    formData.set("response_format", "url");
    if (quality) {
        formData.set("quality", quality);
    }
    if (requestSize) {
        formData.set("size", requestSize);
    }
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    const imageFieldName = files.length > 1 ? "image[]" : "image";
    files.forEach((file) => {
        formData.append(imageFieldName, file);
    });
    if (mask) formData.set("mask", dataUrlToFile(mask));

    try {
        const response = await axios.post<ImageAsyncTaskResponse>(aiApiUrl(requestConfig, "/images/generations/async"), formData, { headers: aiHeaders(requestConfig), signal: options?.signal });
        const taskId = resolveTaskId(response.data);
        options?.onTaskCreated?.(taskId);
        return await pollSubmittedImageTask(requestConfig, taskId, n, options);
    } catch (error) {
        if (isImageTaskPollingError(error)) throw error;
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    try {
        const answer = (await requestStreamingResponse(requestConfig, {
            model: requestConfig.model,
            input: toResponseInput(withSystemMessage(requestConfig, messages)),
        }, onDelta, options)).content || "没有返回内容";
        if (answer === "没有返回内容") onDelta(answer);
        return answer;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestToolResponse(config: AiConfig, messages: ResponseInputMessage[], tools: ResponseFunctionTool[], toolChoice: ToolChoice = "auto", onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    try {
        return await requestStreamingResponse(requestConfig, {
            model: requestConfig.model,
            input: toResponseInput(withSystemMessage(requestConfig, messages)),
            tools: tools.map(toResponseTool),
            tool_choice: toolChoice,
            parallel_tool_calls: false,
        }, onDelta, options);
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey">) {
    try {
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}

export async function fetchChannelModels(channel: ModelChannel) {
    return fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey });
}
