/**
 * Browser stub for node:buffer. @clausroom/protocol's join.js imports Buffer at
 * module scope for the base64url join-blob codec (encodeJoinBlob/decodeJoinBlob).
 * The web UI never encodes or decodes join blobs — the server builds the
 * `join_command` string and the /join route reads plain tokens straight from the
 * URL fragment — so the codec is never called in the browser. If it ever is, this
 * throws instead of silently mis-encoding.
 */

function unavailable(): never {
  throw new Error('node:buffer Buffer is not available in the browser');
}

export const Buffer = {
  from: unavailable,
};

export default { Buffer };
