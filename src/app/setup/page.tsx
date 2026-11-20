"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DISMISSED_KEY_SETUP } from "@/components/ApiKeySetupRedirect";
import styles from "./page.module.css";

const API_KEYS = [
  { name: "OPENAI_API_KEY", provider: "OpenAI", description: "Storyboard generation, Prompt Assistant, and ChatGPT Image." },
  { name: "GEMINI_API_KEY", provider: "Google Gemini", description: "Nano Banana image generation." },
  { name: "ATLASCLOUD_API_KEY", provider: "Atlas Cloud", description: "Video generation, FLUX 3, uploads, and related models." },
  { name: "FAL_KEY", provider: "fal", description: "fal-hosted image generation." },
] as const;

type ApiKeyName = (typeof API_KEYS)[number]["name"];
type KeyState = Record<ApiKeyName, boolean>;
const isDesktopApp = process.env.NEXT_PUBLIC_FAL_FLOW_DESKTOP === "1";
const canConfigureKeys = process.env.NODE_ENV === "development" || isDesktopApp;

const EMPTY_KEY_STATE: KeyState = {
  OPENAI_API_KEY: false,
  GEMINI_API_KEY: false,
  ATLASCLOUD_API_KEY: false,
  FAL_KEY: false,
};

export default function SetupPage() {
  const router = useRouter();
  const [values, setValues] = useState<Record<ApiKeyName, string>>({
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    ATLASCLOUD_API_KEY: "",
    FAL_KEY: "",
  });
  const [configured, setConfigured] = useState<KeyState>(EMPTY_KEY_STATE);
  const [firstRun, setFirstRun] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/setup", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as { configured?: KeyState; error?: string };
        if (!response.ok) throw new Error(result.error || `Setup could not be loaded (status ${response.status}).`);
        setFirstRun(new URLSearchParams(window.location.search).get("firstRun") === "1");
        if (result.configured) setConfigured({ ...EMPTY_KEY_STATE, ...result.configured });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "Setup could not be loaded.");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, []);

  function leaveSetup() {
    try {
      window.localStorage.setItem(DISMISSED_KEY_SETUP, "1");
    } catch (storageError) {
      console.error("Could not save the API setup preference.", storageError);
      setError("Could not remember this choice in browser storage. Check your browser settings and try again.");
      return;
    }
    router.push("/");
  }

  async function saveKeys(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const result = await response.json() as { error?: string; configured?: KeyState };
      if (!response.ok) throw new Error(result.error || `Could not save API keys (status ${response.status}).`);
      if (result.configured) setConfigured({ ...EMPTY_KEY_STATE, ...result.configured });
      setValues({ OPENAI_API_KEY: "", GEMINI_API_KEY: "", ATLASCLOUD_API_KEY: "", FAL_KEY: "" });
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save API keys.");
    } finally {
      setSaving(false);
    }
  }

  if (!canConfigureKeys) {
    return (
      <main className={styles.page}>
        <section className={styles.card}>
          <h1>Local API key setup</h1>
          <p>This setup screen is only available when running the app in local development mode.</p>
          <button type="button" className={styles.secondaryButton} onClick={() => router.push("/")}>Back to app</button>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="setup-title">
        <div className={styles.brand}>F</div>
        <p className={styles.eyebrow}>fal flow · LOCAL SETUP</p>
        <h1 id="setup-title">{firstRun ? "Connect your AI providers" : "API key setup"}</h1>
        <p className={styles.intro}>
          {isDesktopApp
            ? "Add only the providers you plan to use. Keys are kept in this computer user's fal flow settings and are not included in project packages."
            : <>Add only the providers you plan to use. Keys are saved on this computer in <code>.env.local</code>, kept out of GitHub, and never sent back to the browser after saving.</>}
        </p>

        {loading ? (
          <p className={styles.status}>Checking local configuration…</p>
        ) : (
          <form onSubmit={saveKeys}>
            <div className={styles.keyList}>
              {API_KEYS.map(({ name, provider, description }) => (
                <label
                  className={`${styles.keyField} ${configured[name] ? styles.keyFieldConfigured : ""}`}
                  key={name}
                >
                  <span className={styles.fieldHeading}>
                    <strong>{provider}</strong>
                    <span className={configured[name] ? styles.configuredBadge : styles.optionalBadge}>
                      {configured[name] && <span aria-hidden="true">✓</span>}
                      {configured[name] ? "Configured" : "Optional"}
                    </span>
                  </span>
                  <span className={styles.description}>{description}</span>
                  <input
                    type="password"
                    name={name}
                    autoComplete="new-password"
                    spellCheck={false}
                    value={values[name]}
                    onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
                    placeholder={configured[name] ? "Already set" : `Paste ${name}`}
                    aria-label={`${provider} API key`}
                  />
                  {configured[name] && <span className={styles.configuredNote}>Key is saved · leave blank to keep it</span>}
                </label>
              ))}
            </div>

            {error && <p className={styles.error} role="alert">{error}</p>}
            {saved && (
              <p className={styles.success} role="status">
                {isDesktopApp ? "Saved on this computer. The keys are ready to use." : "Saved to .env.local. Restart the app before using newly added keys."}
              </p>
            )}

            <p className={styles.notice}>
              {isDesktopApp
                ? "The local settings file is not encrypted; protect this computer user account. Do not copy api-keys.json or include it in a project package."
                : "Keep this app private on your computer. Restart the development server after saving so the server can load the keys."}
            </p>
            <div className={styles.actions}>
              <button type="submit" className={styles.primaryButton} disabled={loading || saving}>
                {saving ? "Saving…" : "Save API keys"}
              </button>
              <button type="button" className={styles.secondaryButton} onClick={leaveSetup}>
                {firstRun ? "Skip for now" : "Back to app"}
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
