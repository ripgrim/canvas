export const applicationCopy = {
  productName: 'Comp Canvas',
  fileLabel: 'File',
  openingFile: 'Opening file',
  backToFiles: 'Back to files',
  openDefaultPage: 'Open the saved page',
  missingFileTitle: 'This file is not in this browser',
  missingFileBody: (fileId: string) => `No local file with the id ${fileId} exists here. Files stay in the browser that created them, so a link only opens on that device and profile.`,
  missingPageTitle: (fileName: string) => `${fileName} has no page with that id`,
  missingPageBody: 'The page may have been removed, or the link points at another file. The saved page can still be opened.',
  unavailableTitle: 'File URLs are not available here',
  errorTitle: 'The file could not be opened',
  invalidFileId: 'The file id in this address is not valid.',
} as const
