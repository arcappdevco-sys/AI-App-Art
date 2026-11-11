"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type ChatMessage = { role: "user" | "assistant"; content: string };

export default function OllamaChat() {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const modelsController = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    controller.current?.abort();
    modelsController.current?.abort();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, pending, open]);

  const refreshModels = async () => {
    modelsController.current?.abort();
    const current = new AbortController();
    modelsController.current = current;
    setLoadingModels(true);
    setError("");
    try {
      const response = await fetch("/api/ollama-chat", { signal: current.signal });
      const result: unknown = await response.json();
      if (!response.ok || !result || typeof result !== "object"
        || !("models" in result) || !Array.isArray(result.models)
        || !result.models.every((item: unknown) => typeof item === "string")) {
        const detail = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error : "Could not load Ollama models.";
        throw new Error(detail);
      }
      const next: string[] = result.models;
      setModels(next);
      setModel((previous) => next.includes(previous) ? previous : next[0] ?? "");
      if (!next.length) setError("No local models found. Install a model in Ollama, then refresh.");
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load Ollama models.");
    } finally {
      if (modelsController.current === current) {
        modelsController.current = null;
        setLoadingModels(false);
      }
    }
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !model || controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setPending(content);
    setDraft("");
    setError("");
    const history: ChatMessage[] = [];
    let remaining = 30000 - content.length;
    for (const message of messages.slice(-20).reverse()) {
      if (message.content.length > 6000 || message.content.length > remaining) break;
      history.unshift(message);
      remaining -= message.content.length;
    }
    try {
      const response = await fetch("/api/ollama-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [...history, { role: "user", content }] }),
        signal: current.signal,
      });
      const result: unknown = await response.json();
      if (!response.ok || !result || typeof result !== "object"
        || !("content" in result) || typeof result.content !== "string" || !result.content.trim()) {
        const detail = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error : "Ollama could not respond.";
        throw new Error(detail);
      }
      const answer = result.content;
      setMessages((previous) => [...previous, { role: "user", content }, { role: "assistant", content: answer }]);
    } catch (cause) {
      setDraft(content);
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : "Ollama could not respond.");
    } finally {
      if (controller.current === current) controller.current = null;
      setPending("");
    }
  };

  return (
    <>
      <button type="button" className="ff-toolbar-button" aria-expanded={open} aria-controls="ollama-chat"
        onClick={() => { if (!open) void refreshModels(); setOpen(!open); }}>Chat</button>
      {open && (
        <section id="ollama-chat" className="ff-ollama-chat" aria-label="Ollama chat">
          <header className="ff-ollama-header">
            <div><strong>Local chat</strong><small>Ollama · conversation stays in this session</small></div>
            <button type="button" aria-label="Close chat" onClick={() => setOpen(false)}>×</button>
          </header>
          <div className="ff-ollama-model">
            <label htmlFor="ollama-model">Model</label>
            <select id="ollama-model" value={model} disabled={loadingModels || Boolean(pending)}
              onChange={(event) => setModel(event.target.value)}>
              {!model && <option value="">No local models</option>}
              {models.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <button type="button" onClick={() => void refreshModels()} disabled={loadingModels || Boolean(pending)}>
              {loadingModels ? "Loading…" : "Refresh"}
            </button>
          </div>
          <div className="ff-ollama-messages" ref={listRef} aria-live="polite">
            {!messages.length && !pending && <p className="ff-ollama-empty">Ask a question or get help writing a prompt.</p>}
            {messages.map((message, index) => (
              <div className={`ff-ollama-message ff-ollama-${message.role}`} key={index}>
                <strong>{message.role === "user" ? "You" : "Ollama"}</strong>
                <p>{message.content}</p>
              </div>
            ))}
            {pending && <><div className="ff-ollama-message ff-ollama-user"><strong>You</strong><p>{pending}</p></div><p className="ff-ollama-empty">Ollama is thinking…</p></>}
          </div>
          {error && <p className="ff-ollama-error" role="alert">{error}</p>}
          <form className="ff-ollama-form" onSubmit={(event) => void send(event)}>
            <textarea aria-label="Chat message" placeholder="Type a message…" value={draft} maxLength={6000} disabled={Boolean(pending)}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }} />
            <div className="ff-ollama-actions">
              <button type="button" disabled={!messages.length || Boolean(pending)} onClick={() => { setMessages([]); setError(""); }}>Clear chat</button>
              {pending
                ? <button type="button" onClick={() => controller.current?.abort()}>Stop</button>
                : <button type="submit" disabled={!model || !draft.trim() || loadingModels}>Send</button>}
            </div>
          </form>
        </section>
      )}
    </>
  );
}
