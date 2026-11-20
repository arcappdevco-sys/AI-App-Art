export const PROJECT_WORKSPACE_DOCUMENT_FILE_NAME = "fal-flow.workspace.json";
export const PROJECT_WORKSPACE_DOCUMENT_FORMAT = "fal-flow-workspace";
export const PROJECT_WORKSPACE_DOCUMENT_VERSION = 1;

export type ProjectWorkspaceView = "storyboard" | "workflow" | "editor" | "compositor";

export type ProjectWorkspaceState = {
  version: 1;
  activeWorkflowId: string;
  workflows: unknown[];
  activeView: ProjectWorkspaceView;
};

export type ProjectWorkspaceDocument = {
  format: typeof PROJECT_WORKSPACE_DOCUMENT_FORMAT;
  schemaVersion: typeof PROJECT_WORKSPACE_DOCUMENT_VERSION;
  projectId: string;
  updatedAt: string;
  state: ProjectWorkspaceState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isProjectWorkspaceView(value: unknown): value is ProjectWorkspaceView {
  return value === "storyboard" || value === "workflow" || value === "editor" || value === "compositor";
}

function normalizeState(value: unknown): ProjectWorkspaceState {
  if (!isRecord(value) || value.version !== 1 || !isText(value.activeWorkflowId)
    || !Array.isArray(value.workflows) || value.workflows.length === 0) {
    throw new Error("The project workspace document contains invalid workflow data.");
  }
  if (value.activeView !== undefined && !isProjectWorkspaceView(value.activeView)) {
    throw new Error("The project workspace document contains an invalid active view.");
  }
  const workflowIds = value.workflows.map((workflow) => {
    if (!isRecord(workflow) || !isText(workflow.id)) {
      throw new Error("The project workspace document contains an invalid workflow.");
    }
    return workflow.id;
  });
  if (new Set(workflowIds).size !== workflowIds.length) {
    throw new Error("The project workspace document contains duplicate workflow IDs.");
  }
  if (!workflowIds.includes(value.activeWorkflowId)) {
    throw new Error("The active workflow is missing from the project workspace document.");
  }
  return {
    version: 1,
    activeWorkflowId: value.activeWorkflowId,
    workflows: value.workflows,
    activeView: isProjectWorkspaceView(value.activeView) ? value.activeView : "workflow",
  };
}

export function createProjectWorkspaceDocument(
  state: ProjectWorkspaceState,
  projectId: string,
): ProjectWorkspaceDocument {
  return {
    format: PROJECT_WORKSPACE_DOCUMENT_FORMAT,
    schemaVersion: PROJECT_WORKSPACE_DOCUMENT_VERSION,
    projectId,
    updatedAt: new Date().toISOString(),
    state: normalizeState(state),
  };
}

export function normalizeProjectWorkspaceDocument(
  value: unknown,
  expectedProjectId: string,
): ProjectWorkspaceDocument {
  if (!isRecord(value)) throw new Error("Project workspace document must be an object.");
  if (value.format !== PROJECT_WORKSPACE_DOCUMENT_FORMAT) {
    throw new Error(`Project workspace format must be "${PROJECT_WORKSPACE_DOCUMENT_FORMAT}".`);
  }
  if (value.schemaVersion !== PROJECT_WORKSPACE_DOCUMENT_VERSION) {
    throw new Error(`Project workspace schema version ${String(value.schemaVersion)} is not supported.`);
  }
  if (value.projectId !== expectedProjectId) {
    throw new Error("Project workspace document belongs to a different project.");
  }
  if (!isText(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("Project workspace update time must be a valid date.");
  }
  return {
    format: PROJECT_WORKSPACE_DOCUMENT_FORMAT,
    schemaVersion: PROJECT_WORKSPACE_DOCUMENT_VERSION,
    projectId: expectedProjectId,
    updatedAt: new Date(value.updatedAt).toISOString(),
    state: normalizeState(value.state),
  };
}
