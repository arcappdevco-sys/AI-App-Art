export type PortType = "text" | "image" | "video" | "audio" | "number" | "any";
export type NodeStatus = "idle" | "queued" | "running" | "done" | "error";

export interface ParamDef {
  key: string;
  label: string;
  kind: "text" | "textarea" | "number" | "file" | "select" | "toggle";
  options?: string[];
  optionsByParam?: { param: string; values: Record<string, string[]> };
  optionGroups?: { label: string; options: string[] }[];
  optionLabels?: Record<string, string>;
  visibleWhen?: { param: string; value: string | boolean };
  disabledWhen?: { param: string; value: string | boolean };
  helperText?: string;
  default?: any;
}

export interface ExecCtx {
  inputs: Record<string, any>;
  params: Record<string, any>;
  log: (message: string) => void;
  signal?: AbortSignal;
}

export interface NodeDef {
  type: string;
  label: string;
  category: "Input" | "fal" | "Google" | "OpenAI" | "Video" | "Output";
  integration?: "pending";
  autoPrompt?: boolean;
  inputs: Record<string, PortType>;
  conditionalInputs?: Record<string, { param: string; value: string }>;
  disabledInputs?: Record<string, string>;
  outputs: Record<string, PortType>;
  params: ParamDef[];
  execute: (ctx: ExecCtx) => Promise<Record<string, any>>;
}

// Serializable workflow format (what you save to disk)
export interface GraphNode { id: string; type: string; params: Record<string, any> }
export interface GraphEdge { source: string; sourceHandle: string; target: string; targetHandle: string }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }
