import { useEffect, useMemo, useState } from "react";
import { ImageIcon } from "lucide-react";

function proxiedImageUrl(url: string) {
    if (!url || url.startsWith("data:")) return url;
    try {
        const parsed = new URL(url);
        if (typeof window === "undefined") return url;
        if (parsed.origin === window.location.origin) return url;
        return `/api/image-proxy?url=${encodeURIComponent(parsed.toString())}`;
    } catch {
        return url;
    }
}

export function PromptImage({ src, alt, className }: { src?: string; alt: string; className?: string }) {
    const sources = useMemo(() => {
        const value = src?.trim();
        if (!value) return [];
        const proxy = proxiedImageUrl(value);
        return Array.from(new Set([proxy, value].filter(Boolean)));
    }, [src]);
    const [index, setIndex] = useState(0);

    useEffect(() => {
        setIndex(0);
    }, [src]);

    if (!sources.length || index >= sources.length) {
        return (
            <div className={`flex items-center justify-center bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-600 ${className || ""}`}>
                <div className="flex flex-col items-center gap-2 text-xs">
                    <ImageIcon className="size-6" />
                    <span>预览图不可用</span>
                </div>
            </div>
        );
    }

    return <img src={sources[index]} alt={alt} className={className} referrerPolicy="no-referrer" loading="lazy" onError={() => setIndex((value) => value + 1)} />;
}
