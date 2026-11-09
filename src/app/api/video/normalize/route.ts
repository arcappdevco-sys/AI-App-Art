import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NextResponse } from "next/server";

export const maxDuration = 900;

const MAX_CLIP_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 600;
const MAX_PROCESS_MS = 15 * 60 * 1000;

type ProbeResult = {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string }>;
};

class ProcessFailure extends Error {
  constructor(message: string, readonly stderr: string) {
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
        finish(new Error("Video preparation was cancelled."));
      } else if (timedOut) {
        finish(new Error("FFmpeg took too long to prepare this video."));
      } else if (code !== 0) {
        finish(new ProcessFailure(`FFmpeg exited with code ${code ?? "unknown"}.`, stderr));
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
    console.error("Could not remove temporary video-normalization files.", error);
  }
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Video preparation requires a multipart upload." }, { status: 400 });
  }

  const file = formData.get("clip");
  if (!(file instanceof File) || file.size < 1) {
    return NextResponse.json({ error: "Choose a non-empty video file to prepare." }, { status: 400 });
  }
  if (file.size > MAX_CLIP_BYTES) {
    return NextResponse.json({ error: "Each video clip must be 200 MB or smaller." }, { status: 413 });
  }

  const directory = await mkdtemp(join(tmpdir(), "fal-flow-normalize-"));
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH && /[\\/]/.test(process.env.FFMPEG_PATH)
    ? join(dirname(process.env.FFMPEG_PATH), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    : "ffprobe");
  let retainDirectoryForResponse = false;

  try {
    const inputPath = join(directory, "input");
    const outputPath = join(directory, "preview.mp4");
    await writeFile(inputPath, new Uint8Array(await file.arrayBuffer()), { flag: "wx" });
    const { stdout } = await runProcess(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type",
      "-of", "json",
      inputPath,
    ], request.signal);
    const probe = JSON.parse(stdout) as ProbeResult;
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration) || !probe.streams?.some((stream) => stream.codec_type === "video")) {
      return NextResponse.json({ error: "This file does not contain a supported video stream." }, { status: 422 });
    }
    if (duration > MAX_VIDEO_SECONDS) {
      return NextResponse.json({ error: `Videos must be ${MAX_VIDEO_SECONDS / 60} minutes or shorter to prepare for preview.` }, { status: 413 });
    }

    await runProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-vf", "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-profile:v", "main",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "48000",
      "-ac", "2",
      "-movflags", "+faststart",
      "-f", "mp4",
      outputPath,
    ], request.signal);

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
        "Content-Type": "video/mp4",
        "Content-Length": String(outputStat.size),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (request.signal.aborted) {
      return NextResponse.json({ error: "Video preparation was cancelled." }, { status: 499 });
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
      console.error("FFmpeg could not prepare an uploaded video.", error.stderr);
      return NextResponse.json({ error: "FFmpeg could not convert this video to a browser-compatible preview." }, { status: 422 });
    }
    console.error("Video preparation request failed.", error);
    return NextResponse.json({ error: "The server could not prepare this video for preview." }, { status: 500 });
  } finally {
    if (!retainDirectoryForResponse) await removeTemporaryDirectory(directory);
  }
}
