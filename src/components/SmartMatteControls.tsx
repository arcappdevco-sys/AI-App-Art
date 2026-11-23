"use client";

import type { CompositorParams } from "@/lib/compositor";

export default function SmartMatteControls({ params, busy, disabled, onMode, onGenerate, onResume, onClear }: {
  params: CompositorParams;
  busy: boolean;
  disabled: boolean;
  onMode: (value: string) => void;
  onGenerate: () => void;
  onResume: () => void;
  onClear: () => void;
}) {
  const pending = typeof params.pendingRequest === "string" ? params.pendingRequest : "";
  const mode = params.mode === "manual" ? "manual" : "auto";
  return <>
    <label>Matte mode
      <select value={mode} disabled={busy} onChange={(event) => onMode(event.target.value)}>
        <option value="auto">Auto · LTX Alpha Gen</option>
        <option value="manual">Manual mask · offline</option>
      </select>
    </label>
    {mode === "auto" && <>
      <small>Connect a Media node containing the original video. fal.ai processes the entire clip; charges apply.</small>
      {pending === "submitting" ? <>
        <p>Submission status is unknown. Check fal.ai request history before clearing this state; the request may have been billed.</p>
        <button type="button" disabled={busy} onClick={onClear}>Clear uncertain submission</button>
      </> : pending ? <>
        <small>Saved fal.ai request: {pending}</small>
        <button type="button" disabled={busy || disabled} onClick={onResume}>Resume matte request</button>
        <button type="button" disabled={busy} onClick={onClear}>Clear saved request</button>
      </> : <button type="button" disabled={busy || disabled} onClick={onGenerate}>Generate matte</button>}
      <small>Maximum 200 MB, 3072 frames. Final pricing is set by fal.ai. SAM point selection is not yet available.</small>
    </>}
    {mode === "manual" && <small>Draw and animate a mask below. Manual masks work offline.</small>}
  </>;
}
