function readDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("Could not read the image file."));
    reader.onerror = () => reject(new Error("Could not read the image file."));
    reader.readAsDataURL(file);
  });
}

export async function storyboardImageDataUrl(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  const image = await createImageBitmap(file);
  try {
    if (Math.max(image.width, image.height) <= 2048) return await readDataUrl(file);
    const scale = 2048 / Math.max(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image resizing is not available in this browser.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const resized = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob
        ? resolve(blob)
        : reject(new Error("Could not resize the image.")), file.type, file.type === "image/png" ? undefined : 0.9);
    });
    if (resized.type !== file.type) {
      throw new Error(`This browser cannot preserve ${file.type.slice(6).toUpperCase()} while resizing the image.`);
    }
    return await readDataUrl(resized);
  } finally {
    image.close();
  }
}
