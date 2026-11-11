export async function prepareEditorVideoSource(
  asset: { src: string; name: string; file?: File },
  download: (src: string, name: string) => Promise<File>,
) {
  if (asset.file) return { file: asset.file, src: asset.src, ownedUrl: null };
  const file = await download(asset.src, asset.name);
  const src = URL.createObjectURL(file);
  return { file, src, ownedUrl: src };
}
