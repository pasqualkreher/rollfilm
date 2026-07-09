// Shared helpers for the browser's native folder picker (webkitdirectory),
// used by the Import screen and the "add photos from a folder" action.

export const RECOGNIZED_EXT = /\.(jpe?g|png|cr2|cr3|nef|arw|dng|raf|orf|rw2|pef|srw)$/i;

export function pickImportableFiles(fileList: FileList): File[] {
  return Array.from(fileList).filter((f) => !f.name.startsWith(".") && RECOGNIZED_EXT.test(f.name));
}

export function sourceLabelFor(fileList: FileList): string {
  const first = fileList[0] as (File & { webkitRelativePath?: string }) | undefined;
  const rel = first?.webkitRelativePath;
  return rel && rel.includes("/") ? rel.split("/")[0] : "Uploaded folder";
}
