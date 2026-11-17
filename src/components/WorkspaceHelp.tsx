type WorkspaceView = "storyboard" | "workflow" | "editor" | "compositor";

type WorkspaceGuide = {
  title: string;
  steps: string[];
};

const GUIDES: Record<WorkspaceView, WorkspaceGuide> = {
  storyboard: {
    title: "Storyboard",
    steps: [
      "Add scenes and shots, or paste a script and choose Build storyboard.",
      "Add a frame image to each shot or generate one. Provider usage may be billed.",
      "Choose To workflow on a shot to send its frame into the workflow builder.",
    ],
  },
  workflow: {
    title: "Workflow",
    steps: [
      "Add input and model nodes from the library, then connect their ports.",
      "Configure nodes and check the run mode and cost estimate before running; provider usage may be billed.",
      "Camera-track JSON is prompt guidance only; it does not lock a model to exact 3D motion.",
    ],
  },
  editor: {
    title: "Video editor",
    steps: [
      "Add a shared workflow video with +, or upload video and audio in Footage.",
      "Arrange and trim clips; choose Transition, then click between clips to add a dissolve.",
      "Export MOV or MP4 when ready. Server export requires FFmpeg with libx264.",
    ],
  },
  compositor: {
    title: "Compositor",
    steps: [
      "Start with a template or add nodes, then connect their image ports.",
      "Choose media in a Media node and preview the result in Viewer.",
      "Hover over a node for a short description. Connect Tracker motion to a Mask or Transform when needed.",
    ],
  },
};

export default function WorkspaceHelp({ activeView }: { activeView: WorkspaceView }) {
  const guide = GUIDES[activeView];

  return (
    <details className="ff-workspace-help" aria-label={`${guide.title} quick guide`}>
      <summary>Quick guide</summary>
      <section className="ff-workspace-help-panel" aria-label={`${guide.title} instructions`}>
        <h2>{guide.title} quick guide</h2>
        <ol>
          {guide.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      </section>
    </details>
  );
}
