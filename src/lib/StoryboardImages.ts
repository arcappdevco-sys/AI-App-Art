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

export async function storyboardReferenceImageDataUrl(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Character references must be PNG, JPEG, or WebP images.");
  }
  if (file.size <= 0 || file.size > 20 * 1024 * 1024) {
    throw new Error("Character references must be 20 MB or smaller.");
  }
  const image = await createImageBitmap(file);
  try {
    let scale = Math.min(1, 1536 / Math.max(image.width, image.height));
    const qualities = [0.88, 0.8, 0.72, 0.64, 0.56];
    for (let attempt = 0; attempt < qualities.length; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image resizing is not available in this browser.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const compressed = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob
          ? resolve(blob)
          : reject(new Error("Could not prepare the character reference image.")),
        "image/jpeg", qualities[attempt]);
      });
      if (compressed.size <= 6 * 1024 * 1024) return readDataUrl(compressed);
      scale *= 0.8;
    }
    throw new Error("The character reference could not be reduced below 6 MB.");
  } finally {
    image.close();
  }
}
