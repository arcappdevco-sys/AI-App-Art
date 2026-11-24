export const OLLAMA_WORKFLOW_CONTEXT_MAX_LENGTH = 30_000;

type WorkflowContextNode = {
  id: string;
  data: {
    type?: unknown;
    title?: unknown;
    params?: unknown;
  };
};

type WorkflowContextEdge = {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
};

type SafeWorkflowValue = string | number | boolean | null | SafeWorkflowValue[] | { [key: string]: SafeWorkflowValue };

export type OllamaWorkflowContext = {
  workflowId: string;
  scopeId: string;
  text: string;
  tooLong: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeString(value: string) {
  return !/(?:https?|data|blob|file):\S+/i.test(value);
}

const SENSITIVE_PARAM_KEY = /(?:auth|key|token|secret|password|credential|url|uri|endpoint|file|media|image|video|frame|audio|path|asset|upload|output|reference)/i;

function safeValue(value: unknown, depth: number): SafeWorkflowValue | undefined {
  if (depth > 5) return undefined;
  if (typeof value === "string") return isSafeString(value) ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const safe = safeValue(item, depth + 1);
      return safe === undefined ? [] : [safe];
    });
  }
  if (isRecord(value)) return safeParams(value, depth + 1);
  return undefined;
}

function safeParams(value: unknown, depth = 0): Record<string, SafeWorkflowValue> {
  if (!isRecord(value) || depth > 5) return {};
  const safe: Record<string, SafeWorkflowValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_PARAM_KEY.test(key)) continue;
    const safeItem = safeValue(item, depth + 1);
    if (safeItem !== undefined) safe[key] = safeItem;
  }
  return safe;
}

export function createOllamaWorkflowContext(
  nodes: readonly WorkflowContextNode[],
  edges: readonly WorkflowContextEdge[],
  workflowId: string,
  scopeId: string,
): OllamaWorkflowContext {
  const labels = new Map(nodes.map((node) => [
    node.id,
    typeof node.data.title === "string" && node.data.title.trim() && isSafeString(node.data.title)
      ? node.data.title.trim()
      : `${typeof node.data.type === "string" ? node.data.type : "Workflow node"} (${node.id})`,
  ]));
  const text = JSON.stringify({
    nodes: nodes.map((node) => ({
      name: labels.get(node.id),
      type: typeof node.data.type === "string" ? node.data.type : "unknown",
      settings: safeParams(node.data.params),
    })),
    connections: edges.flatMap((edge) => {
      const source = labels.get(edge.source);
      const target = labels.get(edge.target);
      return source && target ? [{
        from: source,
        output: edge.sourceHandle ?? "",
        to: target,
        input: edge.targetHandle ?? "",
      }] : [];
    }),
  });
  return {
    workflowId,
    scopeId,
    text,
    tooLong: text.length > OLLAMA_WORKFLOW_CONTEXT_MAX_LENGTH,
  };
}
