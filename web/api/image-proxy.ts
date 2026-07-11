import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_BYTES = 8 * 1024 * 1024;

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
    if (!rawUrl) {
        res.status(400).send("Missing url");
        return;
    }

    let target: URL;
    try {
        target = new URL(rawUrl);
    } catch {
        res.status(400).send("Invalid url");
        return;
    }

    if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
        res.status(400).send("Unsupported protocol");
        return;
    }

    try {
        const upstream = await fetch(target.toString(), {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
                Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                Referer: "https://github.com/",
            },
        });

        if (!upstream.ok) {
            res.status(upstream.status).send("Image fetch failed");
            return;
        }

        const contentType = upstream.headers.get("content-type") || "";
        if (!contentType.toLowerCase().startsWith("image/")) {
            res.status(415).send("Unsupported content type");
            return;
        }

        const contentLength = Number(upstream.headers.get("content-length") || 0);
        if (contentLength > MAX_BYTES) {
            res.status(413).send("Image too large");
            return;
        }

        const arrayBuffer = await upstream.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_BYTES) {
            res.status(413).send("Image too large");
            return;
        }

        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800");
        res.send(Buffer.from(arrayBuffer));
    } catch {
        res.status(502).send("Image proxy failed");
    }
}
