// Response compression mounted by the server entrypoint: JSON API bodies and
// hashed client assets.
export { compressJsonResponses, createCompressedAssetHandler } from './http-compression.middleware.js';
