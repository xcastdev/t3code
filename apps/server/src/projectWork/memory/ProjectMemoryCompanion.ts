// Electron can read virtual ASAR files; the external Python process requires their unpacked paths.
export const companionPathOutsideArchive = (path: string): string =>
  path.replace(/\.asar(?=[/\\])/gu, ".asar.unpacked");
