import type { PromptAssistantConnectedTarget } from "./prompt-assistant-profiles";

export const OLLAMA_CHAT_MAX_MESSAGES = 21;
export const OLLAMA_CHAT_MAX_MESSAGE_LENGTH = 40_000;
export const OLLAMA_CHAT_MAX_TOTAL_LENGTH = 60_000;
export const OLLAMA_PROMPT_CONTEXT_MAX_LENGTH = 30_000;

export type OllamaPromptContext = {
  id: string;
  workflowId: string;
  nodeId: string;
  currentPrompt: string;
  lastUserRequest: string;
  imageSetup: string[];
  connectedTargets: PromptAssistantConnectedTarget[];
};

export type OllamaPromptContextInput = Omit<OllamaPromptContext, "id" | "workflowId" | "lastUserRequest">;

export type OllamaApplyResult =
  | { ok: true }
  | { ok: false; error: string };

export type OllamaPromptApplyResult = OllamaApplyResult;
