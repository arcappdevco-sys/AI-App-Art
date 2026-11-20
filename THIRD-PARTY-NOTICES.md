# Third-party software notices

## FFmpeg and FFprobe

fal flow desktop installers bundle FFmpeg and FFprobe for media conversion, waveform analysis, and video export. The `ffmpeg-static` npm package (version 5.3.0) supplies FFmpeg 6.1.1 binaries. The `ffprobe-static` npm package (version 3.1.0) supplies FFprobe 4.0.2 binaries; these are separate versions, not a matching FFmpeg/FFprobe release.

The `ffmpeg-static` JavaScript package is distributed under GPL-3.0-or-later. The FFmpeg and FFprobe binaries have their own licenses; the installed FFprobe build identifies itself as GPL-enabled. The upstream packages document their binary sources at:

- https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- https://github.com/eugeneware/ffmpeg-static
- https://www.gyan.dev/ffmpeg/builds/ (Windows)
- https://johnvansickle.com/ffmpeg/ (Linux)
- https://evermeet.cx/ffmpeg/ (macOS Intel)
- https://osxexperts.net/ (macOS Apple Silicon)
- https://github.com/joshwnj/ffprobe-static (FFprobe 4.0.2 package and build-source references)
- https://ffmpeg.org/legal.html

The `ffprobe-static` JavaScript package is distributed under MIT; this does not change the licenses of its bundled binaries. Review the applicable source and license obligations for each platform's binary before redistributing installers.
