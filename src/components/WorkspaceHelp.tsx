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
      "Use Auto layout to arrange connected workflows and group related nodes.",
      "Use the VFX relighting workflow to extract a frame, create a lighting reference, and guide a video edit.",
      "The extracted frame can be edited with any listed image-edit model that accepts image references.",
      "Configure nodes and check the run mode and cost estimate before running; provider usage may be billed.",
      "Camera-track JSON is prompt guidance only; it does not lock a model to exact 3D motion.",
    ],
  },
  editor: {
    title: "Video editor",
    steps: [
      "Add a shared workflow video with +, or upload video and audio in Footage.",
      "Drag the divider below the viewer to resize the preview and timeline panels.",
      "Arrange and trim clips; choose Transition, then click between clips to add a dissolve.",
      "Export MOV or MP4 when ready. Server export requires FFmpeg with libx264.",
    ],
  },
  compositor: {
    title: "Compositor",
    steps: [
      "Drag the divider below the Viewer to resize it and the node graph.",
      "Start with a template or add nodes, then connect their image ports.",
      "Send frame exports to Workflow as 640 × 360 images for use as lighting references.",
      "Choose media in a Media node and preview the result in Viewer.",
      "Connect a video Media node directly to Smart Matte for paid LTX generation, or use its offline manual mask mode.",
      "Smart Matte saves its result; resume interrupted requests and check fal.ai before clearing them. PNG preserves alpha; WebM does not.",
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
