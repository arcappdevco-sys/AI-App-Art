import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NextResponse } from "next/server";
import {
  MAX_STILL_IMAGE_BYTES,
  STILL_VIDEO_MOTIONS,
  isStillVideoMotion,
  stillVideoFilter,
  validateStillImage,
  validateStillVideoSettings,
} from "@/lib/still-video";
import { getVideoExportDimensions } from "@/lib/video-export-settings";

export const maxDuration = 900;

const MAX_PROCESS_MS = 15 * 60 * 1000;

type ProbeResult = { streams?: Array<{ codec_type?: string; width?: number; height?: number }> };

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
      if (signal.aborted) finish(new Error("Still-image clip creation was cancelled."));
      else if (timedOut) finish(new Error("FFmpeg took too long to create the still-image clip."));
      else if (code !== 0) finish(new ProcessFailure(`FFmpeg exited with code ${code ?? "unknown"}.`, stderr));
      else finish(undefined, { stdout, stderr });
    });
  });
}

async function removeTemporaryDirectory(directory: string) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.error("Could not remove temporary still-image clip files.", error);
  }
}

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_STILL_IMAGE_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: "Still images must be no larger than 200 MB." }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Still-image clip creation requires a multipart upload." }, { status: 400 });
  }

  const image = formData.get("image");
  if (!(image instanceof File) || image.size < 1) {
    return NextResponse.json({ error: "Choose a non-empty image." }, { status: 400 });
  }
  if (image.size > MAX_STILL_IMAGE_BYTES) {
    return NextResponse.json({ error: "Still images must be no larger than 200 MB." }, { status: 413 });
  }
  const duration = Number(formData.get("duration"));
  const motion = formData.get("motion");
  try {
    validateStillVideoSettings(duration, motion);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Still-image clip settings are invalid." }, { status: 400 });
  }
  let outputDimensions: { width: number; height: number };
  try {
    outputDimensions = getVideoExportDimensions(
      formData.get("resolution") ?? "720p",
      formData.get("orientation") ?? "landscape",
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Still-image output settings are invalid." }, { status: 400 });
  }

  const directory = await mkdtemp(join(tmpdir(), "fal-flow-still-"));
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH && /[\\/]/.test(process.env.FFMPEG_PATH)
    ? join(dirname(process.env.FFMPEG_PATH), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    : "ffprobe");
  let retainDirectoryForResponse = false;

  try {
    const inputPath = join(directory, "image");
    const outputPath = join(directory, "still.mp4");
    await writeFile(inputPath, new Uint8Array(await image.arrayBuffer()), { flag: "wx" });
    const { stdout } = await runProcess(ffprobe, [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height", "-of", "json", inputPath,
    ], request.signal);
    const probe = JSON.parse(stdout) as ProbeResult;
    const stream = probe.streams?.[0];
    if (stream?.codec_type !== "video" || typeof stream.width !== "number" || typeof stream.height !== "number") {
      return NextResponse.json({ error: "The uploaded file is not a supported still image." }, { status: 422 });
    }
    try {
      validateStillImage(image.type, image.size, stream.width, stream.height);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Still image is invalid." }, { status: 400 });
    }
    if (!isStillVideoMotion(motion)) {
      return NextResponse.json({ error: `Choose one of: ${STILL_VIDEO_MOTIONS.join(", ")}.` }, { status: 400 });
    }

    await runProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-loop", "1", "-framerate", "30", "-i", inputPath,
      "-t", String(duration),
      "-vf", stillVideoFilter(duration, motion, outputDimensions.width, outputDimensions.height),
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "main",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", outputPath,
    ], request.signal);

    const outputStat = await stat(outputPath);
    if (!outputStat.size || outputStat.size > MAX_STILL_IMAGE_BYTES) {
      return NextResponse.json({ error: "The prepared still clip is empty or exceeds the 200 MB limit." }, { status: 413 });
    }
    const streamFile = createReadStream(outputPath);
    streamFile.once("close", () => void removeTemporaryDirectory(directory));
    const iterator = streamFile[Symbol.asyncIterator]();
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
        streamFile.destroy();
      },
    });
    retainDirectoryForResponse = true;
    return new Response(body, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(outputStat.size),
        "Cache-Control": "no-store",
        "X-Still-Clip-Duration": String(duration),
        "X-Still-Clip-Size": `${outputDimensions.width}x${outputDimensions.height}`,
      },
    });
  } catch (error) {
    if (request.signal.aborted) return NextResponse.json({ error: "Still-image clip creation was cancelled." }, { status: 499 });
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return NextResponse.json({
        error: "FFmpeg is not installed on the server. Install FFmpeg with libx264 support and set FFMPEG_PATH if it is not on PATH.",
      }, { status: 503 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "FFprobe returned invalid image metadata." }, { status: 422 });
    }
    if (error instanceof ProcessFailure) {
      console.error("FFmpeg could not create a still-image clip.", error.stderr);
      return NextResponse.json({ error: "FFmpeg could not convert this image into a video clip." }, { status: 422 });
    }
    console.error("Still-image clip creation failed.", error);
    return NextResponse.json({ error: "The server could not create the still-image clip." }, { status: 500 });
  } finally {
    if (!retainDirectoryForResponse) await removeTemporaryDirectory(directory);
  }
}
