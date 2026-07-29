import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {inspect} from "node:util";

import winston, {format, transports, type Logger as WinstonLogger} from "winston";

import {formatDateForFilename} from "./date.js";

/** 管理 Canvas Agent 的终端与文件 Debug 日志。 */
export class Logger {
    readonly enabled = process.argv.includes("--debug");
    readonly filePath = this.enabled ? path.join(os.homedir(), ".infinite-canvas", "logs", `canvas-agent-${formatDateForFilename()}.log`) : "";
    private readonly logger: WinstonLogger | null;

    /** 根据命令行 Debug 参数初始化日志输出。 */
    constructor() {
        if (!this.enabled) {
            this.logger = null;
            return;
        }
        fs.mkdirSync(path.dirname(this.filePath), {recursive: true});
        const line = format.printf(({level, message, timestamp, details}) => `${timestamp} ${level.toUpperCase()} ${message}${formatDetails(details)}`);
        this.logger = winston.createLogger({
            level: "debug",
            transports: [
                new transports.Console({format: format.combine(format.timestamp({format: "HH:mm:ss"}), line)}),
                new transports.File({filename: this.filePath, format: format.combine(format.timestamp({format: "HH:mm:ss"}), line)}),
            ],
        });
    }

    /** 输出 Debug 级别日志。 */
    debug(message: string, details?: unknown) {
        if (details === undefined) this.logger?.debug(message);
        else this.logger?.debug(message, {details: sanitize(details)});
    }

    /** 输出 Info 级别日志。 */
    info(message: string, details?: unknown) {
        if (details === undefined) this.logger?.info(message);
        else this.logger?.info(message, {details: sanitize(details)});
    }

    /** 输出 Warn 级别日志。 */
    warn(message: string, details?: unknown) {
        if (details === undefined) this.logger?.warn(message);
        else this.logger?.warn(message, {details: sanitize(details)});
    }

    /** 输出 Error 级别日志。 */
    error(message: string, details?: unknown) {
        if (details === undefined) this.logger?.error(message);
        else this.logger?.error(message, {details: sanitize(details)});
    }
}

/** 将日志详情格式化为紧凑的单行文本。 */
function formatDetails(details: unknown) {
    if (details === undefined) return "";
    if (!details || typeof details !== "object" || Array.isArray(details)) return ` ${inspect(details, {depth: null, breakLength: Infinity})}`;
    const text = Object.entries(details).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${inspect(value, {depth: null, breakLength: Infinity})}`).join(" ");
    return text ? ` ${text}` : "";
}

/** 清理日志内容中的敏感数据和不可序列化引用。 */
function sanitize(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
    if (/token|authorization|api.?key|dataurl/i.test(key)) return "[REDACTED]";
    if (typeof value === "string" && value.startsWith("data:")) return `[DATA URL ${value.length} chars]`;
    if (value instanceof Error) return {name: value.name, message: value.message, stack: value.stack};
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => sanitize(item, key, seen));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([field, item]) => [field, sanitize(item, field, seen)]));
}

export const logger = new Logger();
