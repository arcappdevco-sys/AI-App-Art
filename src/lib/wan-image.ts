import { validateWanImageMetadata } from "./wan";

export async function inspectWanImage(file: File) {
  const basicMetadata = { type: file.type, size: file.size, width: 240, height: 240, hasAlpha: false };
  const basicErrors = validateWanImageMetadata(basicMetadata);
  if (basicErrors.some((error) => error.includes("20 MB") || error.includes("JPEG, PNG"))) {
    return { ...basicMetadata, width: 0, height: 0, errors: basicErrors };
  }
  const bitmap = await createImageBitmap(file);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let hasAlpha = false;
    if (file.type === "image/png" && bytes.length > 25) {
      hasAlpha = bytes[25] === 4 || bytes[25] === 6;
      for (let offset = 8; !hasAlpha && offset + 12 <= bytes.length;) {
        const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
        const chunk = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
        if (chunk === "tRNS") hasAlpha = true;
        if (length > bytes.length - offset - 12) break;
        offset += length + 12;
      }
    }
    if (file.type === "image/bmp" && bytes.length >= 30) {
      hasAlpha = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(28, true) === 32;
    }
    if (file.type === "image/webp" && bytes.length >= 21
      && String.fromCharCode(...bytes.slice(12, 16)) === "VP8X") {
      hasAlpha = (bytes[20] & 0x10) !== 0;
    }
    const metadata = { type: file.type, size: file.size, width: bitmap.width, height: bitmap.height, hasAlpha };
    return { ...metadata, errors: validateWanImageMetadata(metadata) };
  } finally {
    bitmap.close();
  }
}
