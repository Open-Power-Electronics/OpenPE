export const maxPCBTextCachePolygons = 4096;
export const maxPCBTextCachePolygonVertices = 4096;
export const maxPCBTextCacheBoardVertices = 200000;
export const pcbTextCacheCoordinatePattern = '-?(?:[0-9]{1,5}(?:\\.[0-9]{1,6})?|100000)';
const pcbTextCachePointPattern = `${pcbTextCacheCoordinatePattern},${pcbTextCacheCoordinatePattern}`;
export const pcbTextCachePolygonPattern = `^${pcbTextCachePointPattern}(?: ${pcbTextCachePointPattern}){2,${maxPCBTextCachePolygonVertices - 1}}$`;
