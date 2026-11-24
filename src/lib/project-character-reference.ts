import type { StoryboardCharacter } from "./StoryboardData";
import { storyboardReferenceImageDataUrl } from "./StoryboardImages";
import {
  readProjectMediaAssetFile,
  type ProjectFolderSession,
} from "./project-folder-storage";
import { loadProjectMediaFile } from "./project-media-storage";

export async function loadApprovedCharacterReferenceImage(
  character: StoryboardCharacter,
  projectSession: ProjectFolderSession | null,
): Promise<string> {
  const assetId = character.referenceImageMediaAssetId;
  if (!character.referenceImageApproved || !assetId) {
    throw new Error(`${character.name} needs an approved character reference before generation.`);
  }

  let file: File;
  if (projectSession) {
    try {
      file = await readProjectMediaAssetFile(
        projectSession.handle,
        projectSession.projectId,
        assetId,
      );
    } catch (projectError) {
      try {
        file = await loadProjectMediaFile(assetId);
      } catch {
        throw projectError;
      }
    }
  } else {
    file = await loadProjectMediaFile(assetId);
  }
  if (!file.type.startsWith("image/")) {
    throw new Error(`The saved reference for ${character.name} is not an image.`);
  }
  return storyboardReferenceImageDataUrl(file);
}
