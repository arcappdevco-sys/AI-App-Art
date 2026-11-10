# fal flow

fal flow is a visual editor for building image and video generation workflows.
The **Compositor** tab provides a separate, locally saved node graph for images and video. Add Media nodes, connect processing nodes to the Viewer, and select nodes to edit their properties. Merge layers, transform them, apply rectangular masks, color correction and chroma keying. A Tracker analyzes one selected feature from frame zero at five samples per second. To choose the feature, show the tracker's input in the Viewer, pause at frame zero, select the Tracker, and click the feature. Run tracking and connect its motion output to a Transform or Mask.

The Viewer displays only its connected input. For example, connect Media → Color correction → Viewer to see color changes. Selecting an image node outside the Viewer path offers **Show in Viewer**, which replaces the Viewer's current input; the node still needs its own required inputs connected.

In the Viewer, scroll the mouse wheel to zoom around the pointer and hold the middle mouse button while dragging to pan. **Fit viewer** restores the original view. These controls affect only the preview, not exported media or tracker coordinates.

The compositor's **Templates** list offers pre-connected Color correction, Keyer, Masking, and Tracking graphs. Loading one replaces the current compositor project, including its media and tracking data, after confirmation; Undo can restore the previous project during the current session. Select a node marked **Media input** to upload an image or video. Color correction and Masking each have one Media input; Keyer has Background and Foreground inputs; Tracking has Background video and Overlay image inputs. For Tracking, upload a background video and overlay image first, select the Tracker, pause at frame zero and click a feature in the Viewer, then run tracking. Select Merge and click **Show in Viewer** to see the tracked overlay; use Transform to adjust its placement. The Viewer initially shows the unmodified background so you can select the tracking feature before a track exists.

The add-node list also includes the templates' named inputs: **Background**, **Foreground**, **Background video**, and **Overlay image**. These are Media nodes with descriptive names, so they have the same source choices and image output as Media. Add them individually and connect them to the desired inputs; they do not automatically create connections.

Use the compositor's **Undo** and **Redo** buttons, or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (Ctrl/Cmd+Y also redoes). Shortcuts work while adjusting numeric node controls; regular text fields retain their normal text undo. History covers graph edits, node settings, media, tracking and timeline In/Out points, including template replacement. It holds up to 50 actions and clears on reload; restored project changes are saved locally. Viewer navigation, display settings and playback are not history actions.

On the Viewer timeline, move the playhead and use **Set In (I)** and **Set Out (O)**, or adjust the In and Out sliders. The highlighted range loops during playback and determines the portion exported to WebM; PNG still exports the current playhead frame. **Clear In/Out** restores the full video range. Marks are saved locally and can be undone; loading a template clears them. If the connected video becomes shorter, the active range is clamped to its duration; if the clamped marks no longer form a range, the full video is used until the marks become valid again or are changed.

For the Keyer template, put the footage to be keyed in Foreground. The Background Media node can use an uploaded image/video, a solid color, or **Transparent (checkerboard)**. Image/video and solid-color backgrounds are part of the composite and export. Transparent mode produces an empty background: the Viewer shows a checkerboard, and PNG exports preserve transparency instead of including the pattern. WebM export does not preserve alpha. Switching source modes keeps the uploaded file. The Keyer offers screen color, similarity/tolerance, edge softness, spill suppression, black/white clipping, choke/expand and feather. **Pick from Viewer** samples the Keyer's input at the clicked coordinates, not the merged output; show its input in the Viewer when positioning the sample. Positive choke shrinks the matte and negative values expand it.

The Viewer's channel selector and checkerboard/custom transparency background are for inspection only and do not affect PNG or WebM exports. Alpha view shows the final Viewer output's matte; connect the Keyer directly to the Viewer to inspect its matte before merging. Viewer display settings are temporary, while node settings and media are saved with the project.

Color correction provides brightness, contrast, saturation, exposure (stops), gamma, temperature, tint, highlights, shadows and individual RGB gain. Curves apply a master curve followed by separate red, green and blue curves. Choose a channel, click to add up to 10 interior points, and drag or edit their input/output values; endpoints stay at input 0 and 255. Curves use linear interpolation and can be reset per channel. All color operations are applied to 8-bit display-referred pixels, not a color-managed HDR or linear-light pipeline.

To disconnect nodes, select the connection line and press Delete or Backspace, or click **Delete connection** in the sidebar. This removes the connection, not the nodes.

Select one or more compositor nodes and press **D** to disable them; press D again to re-enable them. The inspector also has a disable/enable button. Disabled effect nodes pass their image input through unchanged, a disabled Merge passes its background, and a disabled Tracker stops applying motion without deleting its track. Disabled Media and Viewer nodes behave as disconnected and report a render error. Disabling an upstream node invalidates affected tracking results. Disabled states are saved, affect preview and export, and can be undone or redone.

The tracker uses simple translation patch matching; fast movement, low contrast, occlusion and changing appearance can cause it to lose the feature. The preview stretches media to 640 × 360. PNG export uses the current frame; silent WebM export runs in real time at 10 fps and requires browser MediaRecorder support. Video tracking and the exported range are limited to 60 seconds, and individual files to 200 MB. Video audio, MP4 export, non-rectangular masks and high-resolution export are not supported. Media and the project are stored in this browser's IndexedDB, separately from the video editor.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Add provider API keys to `.env.local` as needed. Keep these keys private and do not expose them in client-side code.

The **ChatGPT Image** node uses `OPENAI_API_KEY` and OpenAI's GPT Image models. OpenAI API usage is billed separately and is not included in Nano Banana's free tier.

Video generation uses the server-side `ATLASCLOUD_API_KEY`. The Wan 3.0 and MiniMax H3 nodes send supported text-to-video, image-to-video, and reference-to-video requests through `/api/atlas/wan`; set `ATLASCLOUD_API_KEY` in `.env.local` before using **Generate**. The browser never receives the key. Wan documents are kept in this browser's IndexedDB, and uploaded media URLs are temporary generation inputs.

The FLUX 3 Image node (text to image and image edit) uses the same server route and key, submits to Atlas `generateImage`, and has a **Check Atlas key** button that makes one read-only request and never spends credits.

The FLUX 3 Video node covers text to video, image to video, first and last frame, keyframes, extend video and edit video. It submits to Atlas `generateVideo` (the documented path; Atlas's schema files list `generateImage` for some of these models, so this is unverified) and uses the same route, polling and **Check Atlas key** button.

The app also connects Kling, Seedance 2.5 text/image-to-video, Veo 3.1 (standard, Fast, and Lite supported tasks), and Gemini Omni to Atlas Cloud. Omni Flash (original) supports text, image, reference and video edit tasks; Omni 1.1 Flash and 1.2 Flash also support video extend. Omni 1.2 supports up to 15 seconds for text, image and reference generation, subject to task-specific input limits. Atlas video inputs for editing, extension and video references must be public MP4 URLs. Each variation is a separate paid generation.

For Kling motion transfer, select **Kling 2.6 Pro Motion Control** in the Kling node, provide the character image and motion reference video, and choose whether orientation follows the image (3–10 seconds) or video (3–30 seconds). The prompt is optional. Upload MP4/MOV up to 100 MB or paste a public video URL; Atlas validates URL-based media limits. Motion control is billed by the provider.

Atlas video previews in model and connected Preview nodes load through the app's media download route, since some Atlas files are served as attachments. The original URL remains available through **Download**; if preview loading fails, the node shows an error.

Adding a video model creates a connected Prompt and Preview automatically. The Preview displays the connected video output when it becomes available, including when a model is run directly. Existing workflows are not changed. Running the Preview itself can run its upstream model and may incur charges; adding or viewing it does not generate media.

**Run workflow** checks the entire canvas and asks for confirmation before submitting AI generation requests. Each run generates fresh results, including on separate branches; dependent nodes wait for their inputs. Provider charges may apply. **Stop** stops waiting, but already submitted jobs can continue and may still be billed. For Wan, MiniMax and FLUX nodes, use **Resume checking** to recover a submitted Atlas result.

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

Select a timeline clip to keep its Chroma key controls open, whether keying is enabled or not. Use **Pick from preview** and click a pixel in the video to choose the screen color, then enable keying and adjust similarity, edge softness, spill suppression, **Clip Black**, **Clip White**, **Choke / Expand**, and **Edge feather**. Clip Black and Clip White remap the alpha matte; positive Choke contracts it, negative Choke expands it, and Edge feather softens its boundary without blurring subject colors. The preview automatically switches to Alpha while matte controls are adjusted. Choose a checkerboard, a solid color, or a background image for the composite preview; color presets match the app themes and accent colors. This background is preview-only and is not included in exports. Press Esc or choose **Cancel picking** to exit color picking. Spill suppression uses the selected screen color and keyed alpha matte to reduce matching color spill around translucent edges while preserving luminance. Use **View channel** to inspect the keyed RGB image or its individual red, green, blue, and alpha channels; this changes preview display only. PNG-sequence exports include the key and matte controls, while MOV/MP4 exports remain unchanged.

Zoom the video preview with the slider beneath it or scroll the mouse wheel over the preview. When zoomed in, hold the middle mouse button and drag to pan around the frame. Zoom and pan change only the preview, not exported framing.

The video editor can render each active sequence as a 1280 × 720 `.mov` or `.mp4` file with H.264 video and AAC audio, mixing audio-track clips with source audio from the video. It can also export a 30 fps sequence of transparent PNG frames in a ZIP file; per-clip chroma-key settings and cross dissolves are included. PNG sequences are limited to 60 seconds and 512 MB of rendered frames. Uploads the browser cannot preview are converted to browser-compatible H.264 MP4 before they are added to the timeline. Server-side export and video conversion require FFmpeg built with `libx264` and FFprobe available on the server's `PATH`. If they are installed elsewhere, configure `FFMPEG_PATH` and `FFPROBE_PATH` in the server environment.

The export route accepts up to 20 video clips and 20 audio clips, 200 MB per clip and 512 MB total, with a maximum combined trimmed video duration of 10 minutes. The deployment host must allow requests and server execution long enough for those media files to upload and render; some serverless hosts impose lower request-size or timeout limits. The editor reports an error if an export exceeds the host's limits or a clip cannot be read in the browser.

`next.config.ts` sets Next.js `experimental.proxyClientMaxBodySize` to `512mb` so the proxy does not truncate uploads at its 10 MB default. The proxy buffers request bodies in memory, so keep the upload limit aligned with the capacity of your deployment host.

## Workflow management

Workflows are auto-saved in this browser on this device. Use **New** to create another workflow and the workflow selector to switch between saved workflows. Rename the selected workflow in the title field.

Use **Export** to download the current workflow as JSON. **Import** adds a valid JSON workflow to the local workflow list without replacing existing workflows. Imported workflows are validated before they are opened.

Local workflows are stored in browser `localStorage`; clearing browser site data removes them. Export important workflows for backup or to move them to another browser or computer. Workflow images stored as data URLs are included in exported files and can make them large.
