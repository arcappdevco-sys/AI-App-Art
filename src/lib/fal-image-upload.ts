import { fal } from "@fal-ai/client";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export async function uploadFalImageReferences(images: readonly string[]): Promise<string[]> {
  return Promise.all(images.map(async (image) => {
    if (/^https:\/\/\S+$/i.test(image)) return image;
    if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(image)) {
      throw new Error("fal reference images must be PNG, JPEG, or WebP images.");
    }
    const response = await fetch(image);
    if (!response.ok) throw new Error("Could not read a fal reference image.");
    const blob = await response.blob();
    const type = blob.type.toLowerCase();
    if (!IMAGE_TYPES.has(type) || blob.size <= 0 || blob.size > MAX_IMAGE_BYTES) {
      throw new Error("fal reference images must be non-empty PNG, JPEG, or WebP files of 20 MB or less.");
    }
    const extension = type === "image/jpeg" ? "jpg" : type.slice("image/".length);
    return fal.storage.upload(new File([blob], `character-reference.${extension}`, { type }));
  }));
}
