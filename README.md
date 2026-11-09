# fal flow

fal flow is a visual editor for building image and video generation workflows.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Add provider API keys to `.env.local` as needed. Keep these keys private and do not expose them in client-side code.

The **ChatGPT Image** node uses `OPENAI_API_KEY` and OpenAI's GPT Image models. OpenAI API usage is billed separately and is not included in Nano Banana's free tier.

Video generation uses the server-side `ATLASCLOUD_API_KEY`. The app connects Kling, Seedance 2.5 text/image-to-video, Veo 3.1 (standard, Fast, and Lite supported tasks), and Gemini Omni Flash (original) text/image/reference/video-edit tasks to Atlas Cloud. Gemini Omni 1.1 and Gemini Omni video-extend are not listed in Atlas Cloud's current video API catalog, so they are not offered as runnable choices.

## Video editor export

The video editor saves Footage media, sequences, video and audio clips, trims, selection, playhead, and the active tool in this browser using IndexedDB. This data is local to the browser and device; clearing site data removes it. Browser storage quotas vary, so keep backup copies of important footage. Media files larger than 512 MB are not saved to the editor.

Use Undo/Redo buttons or Ctrl/Cmd+Z and Ctrl/Cmd+Y to reverse editor changes. Undo history is limited to 50 actions and resets when the page reloads.

Upload audio in Footage and click **+ Audio** to place it at the playhead. Audio clips can be repositioned, source-trimmed, volume-adjusted, and overlapped; playback is synchronized with the video timeline.

The video editor can render each active sequence as a 1280 × 720 `.mov` or `.mp4` file with H.264 video and AAC audio, mixing audio-track clips with any source audio in the video. Uploads the browser cannot preview are converted to browser-compatible H.264 MP4 before they are added to the timeline. Server-side export and video conversion require FFmpeg built with `libx264` and FFprobe available on the server's `PATH`. If they are installed elsewhere, configure `FFMPEG_PATH` and `FFPROBE_PATH` in the server environment.

The export route accepts up to 20 video clips and 20 audio clips, 200 MB per clip and 512 MB total, with a maximum combined trimmed video duration of 10 minutes. The deployment host must allow requests and server execution long enough for those media files to upload and render; some serverless hosts impose lower request-size or timeout limits. The editor reports an error if an export exceeds the host's limits or a clip cannot be read in the browser.

## Workflow management

Workflows are auto-saved in this browser on this device. Use **New** to create another workflow and the workflow selector to switch between saved workflows. Rename the selected workflow in the title field.

Use **Export** to download the current workflow as JSON. **Import** adds a valid JSON workflow to the local workflow list without replacing existing workflows. Imported workflows are validated before they are opened.

Local workflows are stored in browser `localStorage`; clearing browser site data removes them. Export important workflows for backup or to move them to another browser or computer. Workflow images stored as data URLs are included in exported files and can make them large.
