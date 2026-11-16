"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const DISMISSED_KEY_SETUP = "fal-flow:api-key-setup-dismissed";

export default function ApiKeySetupRedirect() {
  const router = useRouter();

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    try {
      if (window.localStorage.getItem(DISMISSED_KEY_SETUP)) return;
    } catch (error) {
      console.error("Could not check whether API key setup was dismissed.", error);
      return;
    }

    const controller = new AbortController();
    void fetch("/api/setup", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`API key setup check failed with status ${response.status}.`);
        return response.json() as Promise<{ anyConfigured?: boolean }>;
      })
      .then((result) => {
        if (result.anyConfigured === false) router.replace("/setup?firstRun=1");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Could not check local API key configuration.", error);
      });

    return () => controller.abort();
  }, [router]);

  return null;
}

export { DISMISSED_KEY_SETUP };
