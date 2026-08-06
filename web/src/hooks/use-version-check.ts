import { useCallback, useMemo, useState } from "react";

import { APP_VERSION } from "@/constant/env";
import type { ReleaseInfo } from "@/lib/release";

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

/** Use only the release information embedded at build time; never make a remote version request. */
export function useVersionCheck() {
    const [open, setOpen] = useState(false);
    const releases = useMemo(readLocalReleases, []);
    const openReleaseModal = useCallback(() => setOpen(true), []);

    return { open, setOpen, openReleaseModal, latestVersion: APP_VERSION, releases, hasNewVersion: false };
}
