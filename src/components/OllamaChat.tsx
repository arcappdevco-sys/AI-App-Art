"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { parseStructuredStoryboardScript } from "@/lib/StoryboardScript";
import {
  OLLAMA_CHAT_MAX_MESSAGE_LENGTH,
  OLLAMA_CHAT_MAX_TOTAL_LENGTH,
  type OllamaApplyResult,
  type OllamaPromptApplyResult,
  type OllamaPromptContext,
} from "@/lib/ollama-chat";
import type { StoryboardScriptResult } from "@/lib/StoryboardScript";
import {
  formatOllamaStoryboardPromptContext,
  normalizeOllamaStoryboardPrompt,
  resolveOllamaStoryboardShot,
  validateOllamaStoryboardPrompt,
  type OllamaStoryboardContext,
} from "@/lib/ollama-storyboard-context";
import type { OllamaWorkflowContext } from "@/lib/ollama-workflow-context";
import { validatePromptAssistantCandidate } from "@/lib/prompt-assistant-profiles";

type ChatMode = "prompt" | "workflow" | "general";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  request?: string;
  storyboardTarget?: {
    workflowId: string;
    scopeId: string;
    shotId: string;
    number: number;
    expectedDescription: string;
    expectedPrompt: string;
    aspectRatio: NonNullable<OllamaStoryboardContext>["aspectRatio"];
  };
};

export default function OllamaChat({
  onApplyStoryboard,
  promptContext,
  storyboardContext,
  workflowContext,
  onApplyPrompt,
  onApplyStoryboardShot,
  onEndPromptHelp,
}: {
  onApplyStoryboard: (storyboard: StoryboardScriptResult) => boolean;
  promptContext: OllamaPromptContext | null;
  storyboardContext: OllamaStoryboardContext | null;
  workflowContext: OllamaWorkflowContext | null;
  onApplyPrompt: (context: OllamaPromptContext, candidate: string, request: string) => OllamaPromptApplyResult;
  onApplyStoryboardShot: (
    context: Pick<OllamaStoryboardContext, "workflowId" | "scopeId">,
    shotId: string,
    expectedNumber: number,
    expectedDescription: string,
    expectedPrompt: string,
    candidate: string,
  ) => OllamaApplyResult;
  onEndPromptHelp: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [promptMessages, setPromptMessages] = useState<ChatMessage[]>([]);
  const [storyboardPromptMessages, setStoryboardPromptMessages] = useState<ChatMessage[]>([]);
  const [workflowMessages, setWorkflowMessages] = useState<ChatMessage[]>([]);
  const [selectedMode, setSelectedMode] = useState<ChatMode | null>(null);
  const [appliedStoryboardReplies, setAppliedStoryboardReplies] = useState<Set<number>>(() => new Set());
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const modelsController = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const promptContextId = promptContext?.id ?? null;
  const mode: ChatMode | "node-prompt" = promptContext ? "node-prompt"
    : selectedMode === "prompt" && storyboardContext ? "prompt"
      : selectedMode === "workflow" && workflowContext ? "workflow"
        : selectedMode === "general" ? "general"
          : storyboardContext ? "prompt" : workflowContext ? "workflow" : "general";
  const activeStoryboardContext = mode === "prompt" ? storyboardContext : null;
  const activeWorkflowContext = mode === "workflow" ? workflowContext : null;
  const storyboardScopeId = activeStoryboardContext?.scopeId ?? null;
  const workflowScopeId = activeWorkflowContext?.scopeId ?? null;
  const activeMessages = promptContext ? promptMessages
    : mode === "prompt" ? storyboardPromptMessages
      : mode === "workflow" ? workflowMessages : messages;
  const parsedResponses = useMemo(() => activeMessages.map((message) => (
    message.role === "assistant" ? parseStructuredStoryboardScript(message.content) : null
  )), [activeMessages]);
  const lastPromptContextId = useRef<string | null>(null);
  const lastStoryboardScopeId = useRef<string | null>(null);
  const lastWorkflowScopeId = useRef<string | null>(null);

  useEffect(() => () => {
    controller.current?.abort();
    modelsController.current?.abort();
  }, []);

  const refreshModels = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    if (!promptContextId || lastPromptContextId.current === promptContextId) return;
    lastPromptContextId.current = promptContextId;
    controller.current?.abort();
    setPending("");
    setDraft("");
    setError("");
    setPromptMessages([]);
    setOpen(true);
    void refreshModels();
  }, [promptContextId, refreshModels]);

  useEffect(() => {
    if (!storyboardScopeId || lastStoryboardScopeId.current === storyboardScopeId) return;
    lastStoryboardScopeId.current = storyboardScopeId;
    controller.current?.abort();
    setPending("");
    setDraft("");
    setError("");
    setStoryboardPromptMessages([]);
    setAppliedStoryboardReplies(new Set());
  }, [storyboardScopeId]);

  useEffect(() => {
    if (!workflowScopeId || lastWorkflowScopeId.current === workflowScopeId) return;
    lastWorkflowScopeId.current = workflowScopeId;
    controller.current?.abort();
    setPending("");
    setDraft("");
    setError("");
    setWorkflowMessages([]);
  }, [workflowScopeId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [activeMessages, pending, open]);

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    const requestStoryboardContext = activeStoryboardContext;
    const referencedShot = requestStoryboardContext
      ? resolveOllamaStoryboardShot(content, requestStoryboardContext.shots)
      : null;
    if (requestStoryboardContext && !referencedShot) {
      setError("Mention exactly one existing shot number, such as Shot 04, so the assistant uses the correct description.");
      return;
    }
    const storyboardPromptContext = requestStoryboardContext && referencedShot
      ? formatOllamaStoryboardPromptContext(requestStoryboardContext, referencedShot)
      : null;
    if (storyboardPromptContext?.tooLong) {
      setError("This shot and its style bible exceed the context limit. Shorten the shot description or global style notes.");
      return;
    }
    if (activeWorkflowContext?.tooLong) {
      setError("This workflow context is too large to share with Ollama. Reduce the amount of text in its node settings.");
      return;
    }
    if (!content || !model || controller.current) return;
    const current = new AbortController();
    controller.current = current;
    const activePromptContext = promptContext;
    const requestWorkflowContext = activeWorkflowContext;
    setPending(content);
    setDraft("");
    setError("");
    const history: ChatMessage[] = [];
    let remaining = OLLAMA_CHAT_MAX_TOTAL_LENGTH - content.length;
    if (!requestStoryboardContext) {
      for (const message of activeMessages.slice(-20).reverse()) {
        if (message.content.length > OLLAMA_CHAT_MAX_MESSAGE_LENGTH || message.content.length > remaining) break;
        history.unshift(message);
        remaining -= message.content.length;
      }
    }
    try {
      const response = await fetch("/api/ollama-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [...history, { role: "user", content }],
          ...(activePromptContext ? { promptContext: {
            currentPrompt: activePromptContext.currentPrompt,
            imageSetup: activePromptContext.imageSetup,
            connectedTargets: activePromptContext.connectedTargets,
          } } : {}),
          ...(storyboardPromptContext ? { storyboardContext: storyboardPromptContext.text } : {}),
          ...(requestStoryboardContext ? {
            storyboardMode: "prompt",
            storyboardAspectRatio: requestStoryboardContext.aspectRatio,
          } : {}),
          ...(requestWorkflowContext ? { workflowContext: requestWorkflowContext.text } : {}),
        }),
        signal: current.signal,
      });
      const result: unknown = await response.json();
      if (!response.ok || !result || typeof result !== "object"
        || !("content" in result) || typeof result.content !== "string" || !result.content.trim()) {
        const detail = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error : "Ollama could not respond.";
        throw new Error(detail);
      }
      const answer = requestStoryboardContext
        ? normalizeOllamaStoryboardPrompt(result.content, requestStoryboardContext.aspectRatio)
        : result.content;
      const storyboardPromptError = requestStoryboardContext
        ? validateOllamaStoryboardPrompt(answer, requestStoryboardContext.aspectRatio)
        : null;
      const nextMessages = [
        ...activeMessages,
        { role: "user" as const, content },
        {
          role: "assistant" as const,
          content: answer,
          ...(activePromptContext ? { request: content } : {}),
          ...(requestStoryboardContext && referencedShot && !storyboardPromptError ? { storyboardTarget: {
            workflowId: requestStoryboardContext.workflowId,
            scopeId: requestStoryboardContext.scopeId,
            shotId: referencedShot.id,
            number: referencedShot.number,
            expectedDescription: referencedShot.description,
            expectedPrompt: referencedShot.prompt,
            aspectRatio: requestStoryboardContext.aspectRatio,
          } } : {}),
        },
      ];
      if (storyboardPromptError) setError(`Prompt Assistant response was not applied: ${storyboardPromptError}`);
      if (activePromptContext) {
        if (promptContextId === activePromptContext.id) setPromptMessages(nextMessages);
      } else {
        if (requestStoryboardContext) {
          if (storyboardContext?.scopeId === requestStoryboardContext.scopeId) setStoryboardPromptMessages(nextMessages);
        } else if (requestWorkflowContext) {
          if (workflowContext?.scopeId === requestWorkflowContext.scopeId) setWorkflowMessages(nextMessages);
        } else {
          setMessages(nextMessages);
        }
      }
    } catch (cause) {
      if (!current.signal.aborted) setDraft(content);
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : "Ollama could not respond.");
    } finally {
      if (controller.current === current) controller.current = null;
      setPending("");
    }
  };

  const applyPromptReply = (message: ChatMessage) => {
    if (!promptContext) return;
    const request = message.request ?? "";
    const validationError = validatePromptAssistantCandidate(
      promptContext.currentPrompt,
      request,
      message.content,
      promptContext.connectedTargets,
    );
    if (validationError) {
      setError(validationError);
      return;
    }
    const result = onApplyPrompt(promptContext, message.content, request);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError("");
  };

  const applyStoryboardReply = (message: ChatMessage, index: number) => {
    const target = message.storyboardTarget;
    const prompt = message.content.trim();
    if (!activeStoryboardContext || !target
      || target.aspectRatio !== activeStoryboardContext.aspectRatio
      || validateOllamaStoryboardPrompt(prompt, activeStoryboardContext.aspectRatio)) {
      setError("This Prompt Assistant reply is invalid or no longer matches the active storyboard.");
      return;
    }
    const result = onApplyStoryboardShot(
      { workflowId: target.workflowId, scopeId: target.scopeId },
      target.shotId,
      target.number,
      target.expectedDescription,
      target.expectedPrompt,
      prompt,
    );
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAppliedStoryboardReplies((current) => new Set(current).add(index));
    setError("");
  };

  return (
    <>
      <button type="button" className="ff-toolbar-button" aria-expanded={open} aria-controls="ollama-chat"
        onClick={() => { if (!open) void refreshModels(); setOpen(!open); }}>
        {mode === "prompt" ? "Prompt Assistant" : mode === "workflow" ? "Workflow Help" : "Chat"}
      </button>
      {open && (
        <section id="ollama-chat" className="ff-ollama-chat" aria-label="Ollama chat">
          <header className="ff-ollama-header">
            <div>
              <strong>{promptContext ? "Prompt help" : mode === "prompt"
                ? "Prompt Assistant" : mode === "workflow" ? "Workflow Help" : "General Chat"}</strong>
              <small>{promptContext
                ? "Ollama · review and explicitly apply a reply"
                : activeStoryboardContext
                  ? "Ollama · creates a 90-150 word image prompt"
                  : activeWorkflowContext
                    ? "Ollama · uses active node settings and connections"
                  : "Ollama · can prepare storyboards for you to apply"}</small>
            </div>
            <button type="button" aria-label="Close chat" onClick={() => setOpen(false)}>×</button>
          </header>
          {!promptContext && (
            <div className="ff-ollama-model">
              <label htmlFor="ollama-chat-mode">Mode</label>
              <select id="ollama-chat-mode" value={mode} disabled={Boolean(pending)}
                onChange={(event) => {
                  const nextMode = event.target.value;
                  if (nextMode === "prompt" || nextMode === "workflow" || nextMode === "general") {
                    setSelectedMode(nextMode);
                    setError("");
                  }
                }}>
                <option value="prompt" disabled={!storyboardContext}>Prompt Assistant</option>
                <option value="workflow" disabled={!workflowContext}>Workflow Help</option>
                <option value="general">General Chat</option>
              </select>
            </div>
          )}
          {promptContext && (
            <div className="ff-ollama-prompt-context">
              <span>Prompt node: {promptContext.nodeId}</span>
              <p>{promptContext.currentPrompt || "No prompt text yet."}</p>
              <button type="button" disabled={Boolean(pending)} onClick={onEndPromptHelp}>End prompt help</button>
            </div>
          )}
          {activeStoryboardContext && (
            <div className="ff-ollama-prompt-context">
              <span>Storyboard · {activeStoryboardContext.shots.length} shots · text details only</span>
              <p>Ask for a prompt for one shot number. Descriptions stay intact; Ollama only suggests a 90-150 word Prompt. Frame images are not shared.</p>
            </div>
          )}
          {activeWorkflowContext && (
            <div className="ff-ollama-prompt-context">
              <span>Active workflow · text settings and connections only</span>
              <p>Media, credentials, outputs, and resource URLs are excluded from the context.</p>
              {activeWorkflowContext.tooLong && (
                <strong className="ff-ollama-error" role="alert">
                  Workflow context exceeds the limit. Reduce the amount of text in node settings before sending.
                </strong>
              )}
            </div>
          )}
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
            {!activeMessages.length && !pending && <p className="ff-ollama-empty">{promptContext
              ? "Ask Ollama to revise this prompt or answer a question about it. Nothing changes until you apply a reply."
              : activeStoryboardContext
                ? "Ask for an image prompt for a shot, such as “Write a prompt for Shot 04.”"
                : activeWorkflowContext
                  ? "Ask how the active workflow is configured or how to connect its nodes."
                : "Ask a question, build a script, or request an importable storyboard."}</p>}
            {activeMessages.map((message, index) => (
              <div className={`ff-ollama-message ff-ollama-${message.role}`} key={index}>
                <strong>{message.role === "user" ? "You" : "Ollama"}</strong>
                <p>{message.content}</p>
                {promptContext && message.role === "assistant" && (
                  <button type="button" className="ff-ollama-apply" disabled={Boolean(pending)}
                    onClick={() => applyPromptReply(message)}>
                    Apply this reply to prompt
                  </button>
                )}
                {activeStoryboardContext && message.role === "assistant" && message.storyboardTarget && (
                    <button
                      type="button"
                      className="ff-ollama-apply"
                      disabled={Boolean(pending) || appliedStoryboardReplies.has(index)}
                      onClick={() => applyStoryboardReply(message, index)}
                    >
                      {appliedStoryboardReplies.has(index)
                        ? `Applied to Shot ${String(message.storyboardTarget.number).padStart(2, "0")}`
                        : `Apply suggestion to Shot ${String(message.storyboardTarget.number).padStart(2, "0")} prompt`}
                    </button>
                  )}
                {!promptContext && !activeStoryboardContext && parsedResponses[index] && (
                  <button type="button" className="ff-ollama-apply"
                    onClick={() => {
                      if (parsedResponses[index] && onApplyStoryboard(parsedResponses[index])) setOpen(false);
                    }}>
                    Use in storyboard ({parsedResponses[index].scenes.reduce(
                      (count, scene) => count + scene.shots.length, 0,
                    )} shots)
                  </button>
                )}
              </div>
            ))}
            {pending && <><div className="ff-ollama-message ff-ollama-user"><strong>You</strong><p>{pending}</p></div><p className="ff-ollama-empty">Ollama is thinking…</p></>}
          </div>
          {error && <p className="ff-ollama-error" role="alert">{error}</p>}
          <form className="ff-ollama-form" onSubmit={(event) => void send(event)}>
            <textarea
              aria-label="Chat message"
              placeholder={promptContext
                ? "Ask about this prompt…"
                : activeStoryboardContext
                  ? "e.g. “Write a prompt for Shot 04”…"
                  : activeWorkflowContext
                    ? "Ask about this workflow…"
                  : "Type a message…"}
              value={draft}
              maxLength={OLLAMA_CHAT_MAX_MESSAGE_LENGTH} disabled={Boolean(pending)}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }} />
            <div className="ff-ollama-actions">
              <button type="button" disabled={!activeMessages.length || Boolean(pending)} onClick={() => {
                if (promptContext) setPromptMessages([]);
                else if (activeStoryboardContext) {
                  setStoryboardPromptMessages([]);
                  setAppliedStoryboardReplies(new Set());
                } else if (activeWorkflowContext) setWorkflowMessages([]);
                else setMessages([]);
                setError("");
              }}>Clear chat</button>
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
