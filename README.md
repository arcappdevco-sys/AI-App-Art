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

The video editor can render each active sequence as a 1280 × 720 `.mov` or `.mp4` file with H.264 video and AAC audio. Server-side export requires FFmpeg built with `libx264` and FFprobe available on the server's `PATH`. If they are installed elsewhere, configure `FFMPEG_PATH` and `FFPROBE_PATH` in the server environment.

The export route accepts up to 20 clips, 200 MB per clip and 512 MB per sequence, with a maximum combined trimmed duration of 10 minutes. The deployment host must allow requests and server execution long enough for those video files to upload and render; some serverless hosts impose lower request-size or timeout limits. The editor reports an error if an export exceeds the host's limits or a clip cannot be read in the browser.

## Workflow management

Workflows are auto-saved in this browser on this device. Use **New** to create another workflow and the workflow selector to switch between saved workflows. Rename the selected workflow in the title field.

Use **Export** to download the current workflow as JSON. **Import** adds a valid JSON workflow to the local workflow list without replacing existing workflows. Imported workflows are validated before they are opened.

Local workflows are stored in browser `localStorage`; clearing browser site data removes them. Export important workflows for backup or to move them to another browser or computer. Workflow images stored as data URLs are included in exported files and can make them large.
