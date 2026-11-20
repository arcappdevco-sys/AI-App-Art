import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const nextCli = resolve("node_modules", "next", "dist", "bin", "next");
const result = spawnSync(process.execPath, [nextCli, "build"], {
  stdio: "inherit",
  env: { ...process.env, FAL_FLOW_DESKTOP: "1" },
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const standaloneDirectory = resolve(".next", "standalone");
for (const entry of readdirSync(standaloneDirectory, { withFileTypes: true })) {
  if (entry.isFile() && /^\.env(?:\..*)?$/.test(entry.name)) {
    rmSync(join(standaloneDirectory, entry.name));
  }
}
rmSync(join(standaloneDirectory, "release"), { recursive: true, force: true });

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
if (typeof ffmpegPath !== "string" || typeof ffprobePath !== "string") {
  throw new Error(`FFmpeg binaries are not available for ${process.platform}-${process.arch}.`);
}

const binaryDirectory = join(".desktop-build", "ffmpeg", `${process.platform}-${process.arch}`);
mkdirSync(binaryDirectory, { recursive: true });
const executableExtension = process.platform === "win32" ? ".exe" : "";
const bundledBinaries = [
  [ffmpegPath, join(binaryDirectory, `ffmpeg${executableExtension}`)],
  [ffprobePath, join(binaryDirectory, `ffprobe${executableExtension}`)],
];
for (const [source, destination] of bundledBinaries) {
  copyFileSync(source, destination);
  if (process.platform !== "win32") chmodSync(destination, 0o755);
}

const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const electronProjectDirectory = resolve(".desktop-build", "electron-project");
mkdirSync(electronProjectDirectory, { recursive: true });
copyFileSync("electron/main.cjs", join(electronProjectDirectory, "main.cjs"));
const resource = (from, to) => ({
  from: relative(electronProjectDirectory, resolve(from)),
  to,
});
const electronBuildConfig = {
  appId: "com.arcappdevco.falflow",
  productName: "fal flow",
  directories: {
    output: relative(electronProjectDirectory, resolve("release")),
  },
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  files: ["main.cjs", "package.json"],
  extraResources: [
    resource(".next/standalone", "standalone"),
    resource(".next/static", "standalone/.next/static"),
    resource("public", "standalone/public"),
    resource("THIRD-PARTY-NOTICES.md", "THIRD-PARTY-NOTICES.md"),
    resource(".desktop-build/ffmpeg", "ffmpeg"),
  ],
  win: { target: "nsis" },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  mac: { target: "dmg", category: "public.app-category.video" },
  linux: { target: ["AppImage", "deb"], category: "AudioVideo" },
};
writeFileSync(join(electronProjectDirectory, "package.json"), `${JSON.stringify({
  name: "fal-flow-desktop",
  version: rootPackage.version,
  private: true,
  main: "main.cjs",
  description: "Visual editor for building image and video generation workflows",
  devDependencies: { electron: require("electron/package.json").version },
  build: { ...electronBuildConfig, electronVersion: require("electron/package.json").version },
}, null, 2)}\n`);
