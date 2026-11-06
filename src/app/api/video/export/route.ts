import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NextResponse } from "next/server";

export const maxDuration = 900;

const MAX_REQUEST_BYTES = 512 * 1024 * 1024;
const MAX_CLIP_BYTES = 200 * 1024 * 1024;
const MAX_CLIPS = 20;
const MAX_SEQUENCE_SECONDS = 600;
const MAX_PROCESS_MS = 15 * 60 * 1000;

type ClipTrim = {
  start: number;
  end: number;
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

  let totalDuration = 0;
  const timeline = parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`Clip ${index + 1} has invalid trim settings.`);
    const { start, end } = item as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number"
      || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`Clip ${index + 1} has invalid trim settings.`);
    }
    totalDuration += end - start;
    return { start, end };
  });
  if (totalDuration > MAX_SEQUENCE_SECONDS) {
    throw new Error(`Sequences must be ${MAX_SEQUENCE_SECONDS / 60} minutes or shorter to export.`);
  }
  return timeline;
}

export async function POST(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "The total video upload must be 512 MB or smaller." }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Export requires a multipart form with the video clips." }, { status: 400 });
  }

  const files = formData.getAll("clip");
  if (files.some((file) => !(file instanceof File))) {
    return NextResponse.json({ error: "Every sequence clip must be a video file." }, { status: 400 });
  }
  const videoFiles = files as File[];
  let timeline: ClipTrim[];
  try {
    timeline = parseTimeline(formData.get("timeline"), videoFiles.length);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Export timeline is invalid." }, { status: 400 });
  }
  const totalBytes = videoFiles.reduce((sum, file) => sum + file.size, 0);
  if (videoFiles.some((file) => file.size < 1 || file.size > MAX_CLIP_BYTES)) {
    return NextResponse.json({ error: "Each video clip must be 200 MB or smaller." }, { status: 413 });
  }
  if (totalBytes > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "The total video upload must be 512 MB or smaller." }, { status: 413 });
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

    const filterParts: string[] = [];
    const concatInputs: string[] = [];
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
    for (const path of inputPaths) args.push("-i", path);

    let silenceIndex = inputPaths.length;
    for (const [index, trim] of timeline.entries()) {
      const duration = trim.end - trim.start;
      const start = trim.start.toFixed(3);
      const end = trim.end.toFixed(3);
      filterParts.push(
        `[${index}:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${index}]`,
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
      concatInputs.push(`[v${index}][a${index}]`);
    }

    filterParts.push(`${concatInputs.join("")}concat=n=${timeline.length}:v=1:a=1[vout][aout]`);
    const outputPath = join(directory, "sequence.mov");
    args.push(
      "-filter_complex_threads", "2",
      "-filter_complex", filterParts.join(";"),
      "-map", "[vout]",
      "-map", "[aout]",
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
      "-f", "mov",
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
        "Content-Type": "video/quicktime",
        "Content-Disposition": 'attachment; filename="sequence.mov"',
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
