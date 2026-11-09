import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NextResponse } from "next/server";

export const maxDuration = 120;

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 600;
const AUDIO_SAMPLE_RATE = 48_000;
const MIN_WAVEFORM_INTERVAL_SAMPLES = 480;
const MAX_WAVEFORM_BINS = 1200;

type ProbeResult = {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string }>;
};

function runProcess(command: string, args: string[]) {
  return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
    }, 120_000);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= 1024 * 1024) return;
      const remaining = 1024 * 1024 - stdoutBytes;
      const next = chunk.subarray(0, remaining);
      stdout.push(next);
      stdoutBytes += next.length;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 32 * 1024) stderr += chunk.slice(0, 32 * 1024 - stderr.length);
    });

    const finish = (error?: Error, result?: { stdout: Buffer; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (result) resolve(result);
    };

    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(Object.assign(new Error(`Media processing exited with code ${code ?? "unknown"}.`), { stderr }));
      } else {
        finish(undefined, { stdout: Buffer.concat(stdout), stderr });
      }
    });
  });
}

function makeWaveform(metadata: Buffer) {
  const peaks = [...metadata.toString("utf8").matchAll(/lavfi\.astats\.Overall\.Peak_level=(-?(?:\d+(?:\.\d*)?|\.\d+)|-inf)/g)]
    .map((match) => match[1] === "-inf" ? 0 : Math.pow(10, Number(match[1]) / 20));
  if (peaks.length <= MAX_WAVEFORM_BINS) return peaks.map((peak) => Math.round(peak * 1000) / 1000);
  return Array.from({ length: MAX_WAVEFORM_BINS }, (_, bin) => {
    const start = Math.floor(bin * peaks.length / MAX_WAVEFORM_BINS);
    const end = Math.floor((bin + 1) * peaks.length / MAX_WAVEFORM_BINS);
    return Math.round(Math.max(...peaks.slice(start, end)) * 1000) / 1000;
  });
}

export async function POST(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_FILE_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: "Video files must be 512 MB or smaller to analyze their audio." }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Audio analysis requires a multipart video upload." }, { status: 400 });
  }
  const file = formData.get("clip");
  if (!(file instanceof File) || file.size < 1) {
    return NextResponse.json({ error: "Choose a non-empty video file to analyze." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "Video files must be 512 MB or smaller to analyze their audio." }, { status: 413 });
  }

  const directory = await mkdtemp(join(tmpdir(), "fal-flow-waveform-"));
  const inputPath = join(directory, "input");
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH && /[\\/]/.test(process.env.FFMPEG_PATH)
    ? join(dirname(process.env.FFMPEG_PATH), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    : "ffprobe");

  try {
    await writeFile(inputPath, new Uint8Array(await file.arrayBuffer()), { flag: "wx" });
    const { stdout: probeOutput } = await runProcess(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type",
      "-of", "json",
      inputPath,
    ]);
    const probe = JSON.parse(probeOutput.toString("utf8")) as ProbeResult;
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration) || !probe.streams?.some((stream) => stream.codec_type === "video")) {
      return NextResponse.json({ error: "This file does not contain a supported video stream." }, { status: 422 });
    }
    if (duration > MAX_VIDEO_SECONDS) {
      return NextResponse.json({ error: `Videos must be ${MAX_VIDEO_SECONDS / 60} minutes or shorter to analyze their audio.` }, { status: 413 });
    }
    if (!probe.streams.some((stream) => stream.codec_type === "audio")) {
      return NextResponse.json({ waveform: null });
    }

    const samplesPerBin = Math.max(
      MIN_WAVEFORM_INTERVAL_SAMPLES,
      Math.ceil((duration * AUDIO_SAMPLE_RATE) / (MAX_WAVEFORM_BINS - 1)),
    );
    const { stdout: metadata } = await runProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-i", inputPath,
      "-map", "0:a:0",
      "-vn",
      "-ac", "1",
      "-ar", String(AUDIO_SAMPLE_RATE),
      "-af", `asetnsamples=n=${samplesPerBin}:p=1,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-`,
      "-f", "null",
      process.platform === "win32" ? "NUL" : "-",
    ]);
    const waveform = makeWaveform(metadata);
    if (waveform.length === 0) {
      return NextResponse.json({ error: "FFmpeg could not decode samples from this video's audio stream." }, { status: 422 });
    }
    return NextResponse.json({ waveform });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "FFprobe returned invalid video metadata." }, { status: 422 });
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return NextResponse.json({
        error: "FFmpeg and FFprobe are required to display source-audio waveforms. Configure FFMPEG_PATH and FFPROBE_PATH if they are not on PATH.",
      }, { status: 503 });
    }
    const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr
      : "";
    console.error("Could not analyze source-video audio.", stderr || error);
    return NextResponse.json({ error: "Could not analyze this video's audio waveform." }, { status: 422 });
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      console.error("Could not remove temporary waveform files.", error);
    }
  }
}
