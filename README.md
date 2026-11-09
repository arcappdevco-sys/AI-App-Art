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

## Private invite-only deployment

Put the app behind a [Cloudflare Access self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) on a hostname routed through Cloudflare. Configure an Allow policy for only the email addresses you are inviting; Access denies users who do not match an Allow policy.

Set these variables in the app host's production environment:

```text
CLOUDFLARE_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=your-access-application-audience-tag
CLOUDFLARE_ACCESS_ALLOWED_EMAILS=you@example.com,invitee@example.com
```

Find the team domain in Cloudflare Zero Trust and the audience tag in the Access application's details. The email list is an additional origin-side allowlist: each invited person must be included in both this list and the Cloudflare Access policy. Redeploy after changing the environment variables. The Next.js request proxy verifies the Cloudflare-signed JWT, issuer, audience, expiration, and email for pages and API routes, so direct requests to the app origin are denied too. In production, missing or incomplete configuration denies requests; local development remains available when all three variables are unset.

Before sharing the link, confirm the Access application covers the entire hostname and verify an invited account can open the app while an uninvited account cannot. Add or remove invitees in both allowlists. Do not rely on a secret URL or an Access policy that allows all authenticated users.

## Video editor export

The video editor saves Footage media, sequences, video and audio clips, transitions, trims, selection, playhead, and the active tool in this browser using IndexedDB. This data is local to the browser and device; clearing site data removes it. Browser storage quotas vary, so keep backup copies of important footage. Media files larger than 512 MB are not saved to the editor.

Choose Midnight, Ocean, Violet, or Light from the Theme menu in the top bar. Set the accent color independently with the Buttons menu; available colors are Blue, Violet, Coral, Amber, and Slate. This colors primary buttons and accent text/highlights, while ordinary text and theme backgrounds retain their contrast. Both selections apply to the workflow builder and video editor and are saved in this browser.

Use Undo/Redo buttons or Ctrl/Cmd+Z and Ctrl/Cmd+Y to reverse editor changes. Undo history is limited to 50 actions and resets when the page reloads.

Remove uploaded items from Footage with the × button beside them. This removes the item from the library without removing clips already on a sequence; Undo restores it.

When a video is added to a sequence, the editor detects embedded audio and displays its waveform on the video clip, aligned with its trimmed source range. Waveforms are saved with the sequence. This analysis requires FFmpeg and FFprobe on the server; configure `FFMPEG_PATH` and `FFPROBE_PATH` when they are not on `PATH`.

Upload audio in Footage and click **+ Audio** to place it at the playhead. Audio clips can be repositioned, source-trimmed, volume-adjusted, and overlapped; playback is synchronized with the video timeline.

Choose the **Transition** tool and click the `+` at a clip boundary to add a cross dissolve. Drag either edge of the transition block to make it longer or shorter; select the block to see its duration or remove it. Transitions overlap adjacent clips, shorten the sequence, and crossfade source audio in both preview and export.

Select a timeline clip to keep its Chroma key controls open, whether keying is enabled or not. Use **Pick from preview** and click a pixel in the video to choose the screen color, then enable keying and adjust similarity, edge softness, and spill suppression. Press Esc or choose **Cancel picking** to exit color picking. Spill suppression uses the selected screen color and keyed alpha matte to reduce matching color spill around translucent edges while preserving luminance. Use **View channel** to inspect the keyed RGB image or its individual red, green, blue, and alpha channels; this changes preview display only. PNG-sequence exports include the key and spill suppression, while MOV/MP4 exports remain unchanged.

Zoom the video preview with the slider beneath it or scroll the mouse wheel over the preview. When zoomed in, hold the middle mouse button and drag to pan around the frame. Zoom and pan change only the preview, not exported framing.

The video editor can render each active sequence as a 1280 × 720 `.mov` or `.mp4` file with H.264 video and AAC audio, mixing audio-track clips with source audio from the video. It can also export a 30 fps sequence of transparent PNG frames in a ZIP file; per-clip chroma-key settings and cross dissolves are included. PNG sequences are limited to 60 seconds and 512 MB of rendered frames. Uploads the browser cannot preview are converted to browser-compatible H.264 MP4 before they are added to the timeline. Server-side export and video conversion require FFmpeg built with `libx264` and FFprobe available on the server's `PATH`. If they are installed elsewhere, configure `FFMPEG_PATH` and `FFPROBE_PATH` in the server environment.

The export route accepts up to 20 video clips and 20 audio clips, 200 MB per clip and 512 MB total, with a maximum combined trimmed video duration of 10 minutes. The deployment host must allow requests and server execution long enough for those media files to upload and render; some serverless hosts impose lower request-size or timeout limits. The editor reports an error if an export exceeds the host's limits or a clip cannot be read in the browser.

`next.config.ts` sets Next.js `experimental.proxyClientMaxBodySize` to `512mb` so the proxy does not truncate uploads at its 10 MB default. The proxy buffers request bodies in memory, so keep the upload limit aligned with the capacity of your deployment host.

## Workflow management

Workflows are auto-saved in this browser on this device. Use **New** to create another workflow and the workflow selector to switch between saved workflows. Rename the selected workflow in the title field.

Use **Export** to download the current workflow as JSON. **Import** adds a valid JSON workflow to the local workflow list without replacing existing workflows. Imported workflows are validated before they are opened.

Local workflows are stored in browser `localStorage`; clearing browser site data removes them. Export important workflows for backup or to move them to another browser or computer. Workflow images stored as data URLs are included in exported files and can make them large.
