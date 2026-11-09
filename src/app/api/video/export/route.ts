import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Zip, ZipPassThrough } from "fflate";
import { NextResponse } from "next/server";
import { createMatteAwareSpillFilter } from "@/lib/chroma-key";

export const maxDuration = 900;

const MAX_REQUEST_BYTES = 512 * 1024 * 1024;
const MAX_CLIP_BYTES = 200 * 1024 * 1024;
const MAX_CLIPS = 20;
const MAX_AUDIO_CLIPS = 20;
const MAX_SEQUENCE_SECONDS = 600;
const MAX_PNG_SEQUENCE_SECONDS = 60;
const MAX_PNG_SEQUENCE_BYTES = 512 * 1024 * 1024;
const MAX_PROCESS_MS = 15 * 60 * 1000;

type ClipTrim = {
  start: number;
  end: number;
};

type AudioClip = {
  fileIndex: number;
  start: number;
  trimStart: number;
  trimEnd: number;
  volume: number;
};

type ClipTransition = {
  afterClipIndex: number;
  duration: number;
};

type ClipKeyer = {
  enabled: boolean;
  color: string;
  similarity: number;
  softness: number;
  spillSuppression: number;
};

type ProbeResult = {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string }>;
};

class ProcessFailure extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

function runProcess(command: string, args: string[], signal: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, MAX_PROCESS_MS);
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 1024 * 1024) stdout += chunk.slice(0, 1024 * 1024 - stdout.length);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 32 * 1024) stderr += chunk.slice(0, 32 * 1024 - stderr.length);
    });

    const finish = (error?: Error, result?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (result) resolve(result);
    };

    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (signal.aborted) {
        finish(new Error("Video export was cancelled."));
      } else if (timedOut) {
        finish(new Error("FFmpeg took too long to export this sequence."));
      } else if (code !== 0) {
        finish(new ProcessFailure(`FFmpeg exited with code ${code ?? "unknown"}.`, stderr, code));
      } else {
        finish(undefined, { stdout, stderr });
      }
    });
  });
}

async function removeTemporaryDirectory(directory: string) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.error("Could not remove temporary video-export files.", error);
  }
}

function parseTimeline(value: FormDataEntryValue | null, clipCount: number): ClipTrim[] {
  if (typeof value !== "string") throw new Error("Export request is missing its clip timeline.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Export timeline must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== clipCount || clipCount < 1 || clipCount > MAX_CLIPS) {
    throw new Error(`Choose between 1 and ${MAX_CLIPS} clips to export.`);
  }

  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`Clip ${index + 1} has invalid trim settings.`);
    const { start, end } = item as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number"
      || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`Clip ${index + 1} has invalid trim settings.`);
    }
    return { start, end };
  });
}

function parseTransitions(value: FormDataEntryValue | null, timeline: ClipTrim[]): ClipTransition[] {
  if (value === null) return [];
  if (typeof value !== "string") throw new Error("Export transitions must be valid JSON.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Export transitions must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length > Math.max(0, timeline.length - 1)) {
    throw new Error("Export transitions have invalid boundaries.");
  }
  const seenBoundaries = new Set<number>();
  const transitions = parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`Transition ${index + 1} has invalid settings.`);
    const { afterClipIndex, duration } = item as Record<string, unknown>;
    if (!Number.isInteger(afterClipIndex) || typeof afterClipIndex !== "number"
      || afterClipIndex < 0 || afterClipIndex >= timeline.length - 1
      || seenBoundaries.has(afterClipIndex)
      || typeof duration !== "number" || !Number.isFinite(duration) || duration < 0.1) {
      throw new Error(`Transition ${index + 1} has invalid settings.`);
    }
    const maxDuration = Math.min(
      timeline[afterClipIndex].end - timeline[afterClipIndex].start,
      timeline[afterClipIndex + 1].end - timeline[afterClipIndex + 1].start,
    ) - 0.05;
    if (duration > maxDuration) throw new Error(`Transition ${index + 1} is longer than its adjacent clips.`);
    seenBoundaries.add(afterClipIndex);
    return { afterClipIndex, duration };
  });
  transitions.sort((left, right) => left.afterClipIndex - right.afterClipIndex);
  for (let index = 0; index < timeline.length; index += 1) {
    const incoming = transitions.find((transition) => transition.afterClipIndex === index - 1)?.duration ?? 0;
    const outgoing = transitions.find((transition) => transition.afterClipIndex === index)?.duration ?? 0;
    if (incoming + outgoing > timeline[index].end - timeline[index].start - 0.05) {
      throw new Error(`Transitions overlap too much on clip ${index + 1}.`);
    }
  }
  return transitions;
}

function parseAudioTimeline(value: FormDataEntryValue | null, fileCount: number): AudioClip[] {
  if (value === null && fileCount === 0) return [];
  if (typeof value !== "string") throw new Error("Export request is missing its audio timeline.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Audio timeline must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== fileCount || fileCount > MAX_AUDIO_CLIPS) {
    throw new Error(`Choose no more than ${MAX_AUDIO_CLIPS} audio clips to export.`);
  }
  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`Audio clip ${index + 1} has invalid settings.`);
    const { fileIndex, start, trimStart, trimEnd, volume } = item as Record<string, unknown>;
    if (!Number.isInteger(fileIndex) || fileIndex !== index
      || typeof start !== "number" || !Number.isFinite(start) || start < 0
      || typeof trimStart !== "number" || !Number.isFinite(trimStart) || trimStart < 0
      || typeof trimEnd !== "number" || !Number.isFinite(trimEnd) || trimEnd <= trimStart
      || typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 2) {
      throw new Error(`Audio clip ${index + 1} has invalid settings.`);
    }
    return { fileIndex, start, trimStart, trimEnd, volume };
  });
}

function parseKeyerTimeline(value: FormDataEntryValue | null, clipCount: number): ClipKeyer[] {
  if (typeof value !== "string") throw new Error("PNG export is missing its chroma-key settings.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PNG export keyer settings must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== clipCount) {
    throw new Error("PNG export keyer settings do not match the video clips.");
  }
  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`Clip ${index + 1} has invalid keyer settings.`);
    const { enabled, color, similarity, softness, spillSuppression } = item as Record<string, unknown>;
    if (typeof enabled !== "boolean" || typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)
      || typeof similarity !== "number" || !Number.isFinite(similarity) || similarity < 0 || similarity > 0.8
      || typeof softness !== "number" || !Number.isFinite(softness) || softness < 0.01 || softness > 0.6
      || typeof spillSuppression !== "number" || !Number.isFinite(spillSuppression)
      || spillSuppression < 0 || spillSuppression > 1) {
      throw new Error(`Clip ${index + 1} has invalid keyer settings.`);
    }
    return { enabled, color, similarity, softness, spillSuppression };
  });
}

function createKeyerFilter(keyer: ClipKeyer) {
  const color = keyer.color.slice(1);
  const keyColor = [
    Number.parseInt(color.slice(0, 2), 16),
    Number.parseInt(color.slice(2, 4), 16),
    Number.parseInt(color.slice(4, 6), 16),
  ] as const;
  const spillFilter = createMatteAwareSpillFilter(keyColor, keyer.spillSuppression);
  const keyFilter = `colorkey=color=0x${color}:similarity=${keyer.similarity.toFixed(3)}:blend=${keyer.softness.toFixed(3)}`;
  return spillFilter ? `${keyFilter},${spillFilter}` : keyFilter;
}

function createPngZipStream(framePaths: string[], directory: string) {
  let zip: Zip;
  let cancelled = false;
  let pullWaiter: (() => void) | null = null;
  let cleanupStarted = false;
  const cleanup = () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void removeTemporaryDirectory(directory);
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((error, chunk, final) => {
        if (error) {
          controller.error(error);
          cleanup();
          return;
        }
        if (!cancelled) controller.enqueue(chunk);
        if (final) {
          if (!cancelled) controller.close();
          cleanup();
        }
      });
      void (async () => {
        try {
          for (const [index, path] of framePaths.entries()) {
            if (cancelled) return;
            const entry = new ZipPassThrough(`frame-${String(index + 1).padStart(6, "0")}.png`);
            zip.add(entry);
            entry.push(new Uint8Array(await readFile(path)), true);
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              await new Promise<void>((resolve) => {
                pullWaiter = resolve;
              });
            }
          }
          if (!cancelled) zip.end();
        } catch (error) {
          if (!cancelled) controller.error(error);
          cleanup();
        }
      })();
    },
    pull() {
      pullWaiter?.();
      pullWaiter = null;
    },
    cancel() {
      cancelled = true;
      zip.terminate();
      pullWaiter?.();
      cleanup();
    },
  });
  return body;
}

export async function POST(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "The total media upload must be 512 MB or smaller." }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    console.error("Could not parse video export multipart form.", error);
    return NextResponse.json({ error: "Export requires a multipart form with the video clips." }, { status: 400 });
  }

  const files = formData.getAll("clip");
  const audioEntries = formData.getAll("audio");
  if (files.some((file) => !(file instanceof File))) {
    return NextResponse.json({ error: "Every sequence clip must be a video file." }, { status: 400 });
  }
  if (audioEntries.some((file) => !(file instanceof File))) {
    return NextResponse.json({ error: "Every audio track item must be an audio file." }, { status: 400 });
  }
  const requestedFormat = formData.get("format");
  if (requestedFormat !== null && requestedFormat !== "mov" && requestedFormat !== "mp4" && requestedFormat !== "png") {
    return NextResponse.json({ error: "Export format must be MOV, MP4, or PNG sequence." }, { status: 400 });
  }
  const format = requestedFormat ?? "mov";
  const videoFiles = files as File[];
  const audioFiles = audioEntries as File[];
  let timeline: ClipTrim[];
  let audioTimeline: AudioClip[];
  let transitions: ClipTransition[];
  let keyers: ClipKeyer[] = [];
  try {
    timeline = parseTimeline(formData.get("timeline"), videoFiles.length);
    transitions = parseTransitions(formData.get("transitions"), timeline);
    audioTimeline = parseAudioTimeline(formData.get("audioTimeline"), audioFiles.length);
    if (format === "png") keyers = parseKeyerTimeline(formData.get("keyers"), videoFiles.length);
    const sequenceDuration = timeline.reduce((sum, item) => sum + item.end - item.start, 0)
      - transitions.reduce((sum, transition) => sum + transition.duration, 0);
    if (sequenceDuration > MAX_SEQUENCE_SECONDS) {
      throw new Error(`Sequences must be ${MAX_SEQUENCE_SECONDS / 60} minutes or shorter to export.`);
    }
    if (format === "png" && sequenceDuration > MAX_PNG_SEQUENCE_SECONDS) {
      throw new Error(`PNG sequences must be ${MAX_PNG_SEQUENCE_SECONDS} seconds or shorter to export.`);
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Export timeline is invalid." }, { status: 400 });
  }
  const totalBytes = [...videoFiles, ...audioFiles].reduce((sum, file) => sum + file.size, 0);
  if (videoFiles.some((file) => file.size < 1 || file.size > MAX_CLIP_BYTES)) {
    return NextResponse.json({ error: "Each video clip must be 200 MB or smaller." }, { status: 413 });
  }
  if (audioFiles.some((file) => file.size < 1 || file.size > MAX_CLIP_BYTES)) {
    return NextResponse.json({ error: "Each audio clip must be 200 MB or smaller." }, { status: 413 });
  }
  if (totalBytes > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "The total media upload must be 512 MB or smaller." }, { status: 413 });
  }

  const directory = await mkdtemp(join(tmpdir(), "fal-flow-export-"));
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH && /[\\/]/.test(process.env.FFMPEG_PATH)
    ? join(dirname(process.env.FFMPEG_PATH), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    : "ffprobe");
  let retainDirectoryForResponse = false;

  try {
    const inputPaths: string[] = [];
    for (const [index, file] of videoFiles.entries()) {
      const path = join(directory, `clip-${index}.input`);
      await writeFile(path, new Uint8Array(await file.arrayBuffer()), { flag: "wx" });
      inputPaths.push(path);
    }
    const audioInputPaths: string[] = [];
    for (const [index, file] of audioFiles.entries()) {
      const path = join(directory, `audio-${index}.input`);
      await writeFile(path, new Uint8Array(await file.arrayBuffer()), { flag: "wx" });
      audioInputPaths.push(path);
    }

    const probeResults = await Promise.all(inputPaths.map(async (path) => {
      const { stdout } = await runProcess(ffprobe, [
        "-v", "error",
        "-show_entries", "format=duration:stream=codec_type",
        "-of", "json",
        path,
      ], request.signal);
      return JSON.parse(stdout) as ProbeResult;
    }));

    for (const [index, probe] of probeResults.entries()) {
      const duration = Number(probe.format?.duration);
      const trim = timeline[index];
      if (!Number.isFinite(duration) || !probe.streams?.some((stream) => stream.codec_type === "video")) {
        return NextResponse.json({ error: `Clip ${index + 1} is not a supported video file.` }, { status: 422 });
      }
      if (trim.end > duration + 0.25) {
        return NextResponse.json({ error: `Clip ${index + 1} ends beyond the video duration.` }, { status: 400 });
      }
    }
    if (format === "png") {
      const filterParts: string[] = [];
      const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
      for (const path of inputPaths) args.push("-i", path);
      for (const [index, trim] of timeline.entries()) {
        const keyerFilter = keyers[index].enabled ? `,${createKeyerFilter(keyers[index])}` : "";
        filterParts.push(
          `[${index}:v:0]trim=start=${trim.start.toFixed(3)}:end=${trim.end.toFixed(3)},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,format=rgba,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=30,settb=AVTB${keyerFilter}[v${index}]`,
        );
      }

      const transitionsByBoundary = new Map(transitions.map((transition) => [transition.afterClipIndex, transition]));
      let videoSequenceLabel = "v0";
      let combinedDuration = timeline[0].end - timeline[0].start;
      for (let index = 1; index < timeline.length; index += 1) {
        const videoOutput = `vseq${index}`;
        const transition = transitionsByBoundary.get(index - 1);
        if (transition) {
          filterParts.push(
            `[${videoSequenceLabel}][v${index}]xfade=transition=fade:duration=${transition.duration.toFixed(3)}:offset=${(combinedDuration - transition.duration).toFixed(3)}[${videoOutput}]`,
          );
          combinedDuration += timeline[index].end - timeline[index].start - transition.duration;
        } else {
          filterParts.push(`[${videoSequenceLabel}][v${index}]concat=n=2:v=1:a=0[${videoOutput}]`);
          combinedDuration += timeline[index].end - timeline[index].start;
        }
        videoSequenceLabel = videoOutput;
      }

      const outputPattern = join(directory, "frame-%06d.png");
      args.push(
        "-filter_complex_threads", "2",
        "-filter_complex", filterParts.join(";"),
        "-map", `[${videoSequenceLabel}]`,
        "-an",
        "-fps_mode", "cfr",
        "-r", "30",
        "-start_number", "1",
        outputPattern,
      );
      try {
        await runProcess(ffmpeg, args, request.signal);
      } catch (error) {
        if (error instanceof ProcessFailure) {
          console.error("FFmpeg PNG-sequence export failed.", error.stderr);
          return NextResponse.json({ error: "FFmpeg could not render the transparent PNG sequence. Check the clips and trim points, then try again." }, { status: 422 });
        }
        throw error;
      }

      const frameNames = (await readdir(directory))
        .filter((name) => /^frame-\d{6}\.png$/.test(name))
        .sort();
      if (frameNames.length === 0) {
        return NextResponse.json({ error: "FFmpeg did not produce any PNG frames." }, { status: 422 });
      }
      const framePaths = frameNames.map((name) => join(directory, name));
      const frameStats = await Promise.all(framePaths.map((path) => stat(path)));
      const totalFrameBytes = frameStats.reduce((sum, file) => sum + file.size, 0);
      if (totalFrameBytes > MAX_PNG_SEQUENCE_BYTES) {
        return NextResponse.json({ error: "The transparent PNG sequence exceeds the 512 MB export limit. Shorten the sequence and try again." }, { status: 413 });
      }

      const body = createPngZipStream(framePaths, directory);
      retainDirectoryForResponse = true;
      return new Response(body, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="sequence-transparent-frames.zip"',
          "Cache-Control": "no-store",
        },
      });
    }
    const audioProbeResults = await Promise.all(audioInputPaths.map(async (path) => {
      const { stdout } = await runProcess(ffprobe, [
        "-v", "error",
        "-show_entries", "format=duration:stream=codec_type",
        "-of", "json",
        path,
      ], request.signal);
      return JSON.parse(stdout) as ProbeResult;
    }));
    const totalDuration = timeline.reduce((sum, item) => sum + item.end - item.start, 0)
      - transitions.reduce((sum, transition) => sum + transition.duration, 0);
    for (const [index, probe] of audioProbeResults.entries()) {
      const duration = Number(probe.format?.duration);
      const trim = audioTimeline[index];
      if (!Number.isFinite(duration) || !probe.streams?.some((stream) => stream.codec_type === "audio")) {
        return NextResponse.json({ error: `Audio clip ${index + 1} is not a supported audio file.` }, { status: 422 });
      }
      if (trim.trimEnd > duration + 0.25 || trim.start >= totalDuration) {
        return NextResponse.json({ error: `Audio clip ${index + 1} has trim or placement outside the sequence.` }, { status: 400 });
      }
    }

    const filterParts: string[] = [];
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
    for (const path of inputPaths) args.push("-i", path);
    for (const path of audioInputPaths) args.push("-i", path);

    let silenceIndex = inputPaths.length + audioInputPaths.length;
    for (const [index, trim] of timeline.entries()) {
      const duration = trim.end - trim.start;
      const start = trim.start.toFixed(3);
      const end = trim.end.toFixed(3);
      filterParts.push(
        `[${index}:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,settb=AVTB,format=yuv420p[v${index}]`,
      );
      if (probeResults[index].streams?.some((stream) => stream.codec_type === "audio")) {
        filterParts.push(
          `[${index}:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`,
        );
      } else {
        const audioIndex = silenceIndex++;
        args.push("-f", "lavfi", "-t", duration.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
        filterParts.push(
          `[${audioIndex}:a:0]atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`,
        );
      }
    }

    const transitionsByBoundary = new Map(transitions.map((transition) => [transition.afterClipIndex, transition]));
    let videoSequenceLabel = "v0";
    let audioSequenceLabel = "a0";
    let combinedDuration = timeline[0].end - timeline[0].start;
    for (let index = 1; index < timeline.length; index += 1) {
      const videoOutput = `vseq${index}`;
      const audioOutput = `aseq${index}`;
      const transition = transitionsByBoundary.get(index - 1);
      if (transition) {
        const duration = transition.duration.toFixed(3);
        const offset = (combinedDuration - transition.duration).toFixed(3);
        filterParts.push(
          `[${videoSequenceLabel}][v${index}]xfade=transition=fade:duration=${duration}:offset=${offset}[${videoOutput}]`,
          `[${audioSequenceLabel}][a${index}]acrossfade=d=${duration}:c1=tri:c2=tri[${audioOutput}]`,
        );
        combinedDuration += timeline[index].end - timeline[index].start - transition.duration;
      } else {
        filterParts.push(
          `[${videoSequenceLabel}][v${index}]concat=n=2:v=1:a=0[${videoOutput}]`,
          `[${audioSequenceLabel}][a${index}]concat=n=2:v=0:a=1[${audioOutput}]`,
        );
        combinedDuration += timeline[index].end - timeline[index].start;
      }
      videoSequenceLabel = videoOutput;
      audioSequenceLabel = audioOutput;
    }
    for (const [index, audioClip] of audioTimeline.entries()) {
      const inputIndex = videoFiles.length + audioClip.fileIndex;
      const delay = Math.round(audioClip.start * 1000);
      filterParts.push(
        `[${inputIndex}:a:0]atrim=start=${audioClip.trimStart.toFixed(3)}:end=${audioClip.trimEnd.toFixed(3)},asetpts=PTS-STARTPTS,volume=${audioClip.volume.toFixed(3)},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${delay}|${delay},apad,atrim=duration=${totalDuration.toFixed(3)}[track${index}]`,
      );
    }
    if (audioTimeline.length > 0) {
      const mixInputs = [`[${audioSequenceLabel}]`, ...audioTimeline.map((_, index) => `[track${index}]`)].join("");
      filterParts.push(`${mixInputs}amix=inputs=${audioTimeline.length + 1}:duration=first:dropout_transition=0:normalize=0[amixed]`);
    }
    const outputPath = join(directory, `sequence.${format}`);
    args.push(
      "-filter_complex_threads", "2",
      "-filter_complex", filterParts.join(";"),
      "-map", `[${videoSequenceLabel}]`,
      "-map", audioTimeline.length > 0 ? "[amixed]" : `[${audioSequenceLabel}]`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-fps_mode", "cfr",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-ac", "2",
      "-movflags", "+faststart",
      "-f", format,
      outputPath,
    );

    try {
      await runProcess(ffmpeg, args, request.signal);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return NextResponse.json({
          error: "FFmpeg is not installed on the server. Install FFmpeg with libx264 support and set FFMPEG_PATH if it is not on PATH.",
        }, { status: 503 });
      }
      if (error instanceof ProcessFailure) {
        console.error("FFmpeg video export failed.", error.stderr);
        return NextResponse.json({ error: "FFmpeg could not export this sequence. Check the clips, trim points, and server libx264 support, then try again." }, { status: 422 });
      }
      throw error;
    }

    const outputStat = await stat(outputPath);
    const stream = createReadStream(outputPath);
    stream.once("close", () => void removeTemporaryDirectory(directory));
    const iterator = stream[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.();
        stream.destroy();
      },
    });
    retainDirectoryForResponse = true;
    return new Response(body, {
      headers: {
        "Content-Type": format === "mp4" ? "video/mp4" : "video/quicktime",
        "Content-Disposition": `attachment; filename="sequence.${format}"`,
        "Content-Length": String(outputStat.size),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (request.signal.aborted) {
      return NextResponse.json({ error: "Video export was cancelled." }, { status: 499 });
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return NextResponse.json({
        error: "FFmpeg is not installed on the server. Install FFmpeg with libx264 support and set FFMPEG_PATH if it is not on PATH.",
      }, { status: 503 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "FFprobe returned invalid video metadata." }, { status: 422 });
    }
    if (error instanceof ProcessFailure) {
      console.error("FFprobe could not inspect an uploaded video.", error.stderr);
      return NextResponse.json({ error: "FFprobe could not read one of the uploaded videos. Check that the clips are valid video files." }, { status: 422 });
    }
    console.error("Video export request failed.", error);
    return NextResponse.json({ error: "The server could not process this video export." }, { status: 500 });
  } finally {
    if (!retainDirectoryForResponse) await removeTemporaryDirectory(directory);
  }
}
