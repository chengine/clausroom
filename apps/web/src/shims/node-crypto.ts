/**
 * Browser stub for node:crypto. @clausroom/protocol's ids.ts imports
 * createHash/randomBytes at module scope; the web UI never calls the id/token
 * helpers, so these throw if anything ever does.
 */

function unavailable(name: string): never {
  throw new Error(`node:crypto.${name} is not available in the browser`);
}

export function createHash(): never {
  return unavailable('createHash');
}

export function randomBytes(): never {
  return unavailable('randomBytes');
}

export default { createHash, randomBytes };
