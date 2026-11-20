export class LibraryAssetUnavailable extends Error {
  static code = 'OPENPE_LIBRARY_ASSET_UNAVAILABLE';
}

export function libraryAssetFailure(error) {
  return {
    error: String(error.message).slice(0, 4000),
    ...(error instanceof LibraryAssetUnavailable ? { code: LibraryAssetUnavailable.code } : {}),
  };
}
