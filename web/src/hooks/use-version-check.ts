import { useCallback, useMemo, useState } from "react";

import { APP_VERSION } from "@/constant/env";
import type { ReleaseInfo } from "@/lib/release";

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

/** 版本信息仅使用构建时内置内容，不发起任何远程检查请求。 */
export function useVersionCheck() {
    const [open, setOpen] = useState(false);
    const releases = useMemo(readLocalReleases, []);
    const openReleaseModal = useCallback(() => setOpen(true), []);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion: APP_VERSION,
        releases,
        hasNewVersion: false,
    };
}
