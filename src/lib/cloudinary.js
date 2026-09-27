import crypto from "node:crypto";

// Attachments are uploaded by the browser straight to Cloudinary with a
// short-lived signature from us, so files never pass through the API (whose
// serverless request bodies are capped at 4.5 MB) and the API secret never
// leaves the server.
export const UPLOAD_FOLDER = "aurigin/issues";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function config() {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = process.env;
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary is not configured");
  return { cloudName, apiKey, apiSecret };
}

export function cloudinaryConfigured() {
  return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

// Cloudinary's signature: SHA-1 of the sorted params joined as a query
// string, with the secret appended.
function sign(params, apiSecret) {
  const payload = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(payload + apiSecret).digest("hex");
}

/** Params the browser needs to upload one file into our folder. Valid for about an hour. */
export function uploadSignature() {
  const { cloudName, apiKey, apiSecret } = config();
  const params = { folder: UPLOAD_FOLDER, timestamp: Math.floor(Date.now() / 1000) };
  return {
    cloudName,
    apiKey,
    ...params,
    signature: sign(params, apiSecret),
    maxBytes: MAX_UPLOAD_BYTES,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
  };
}

/**
 * Checks an attachment the browser says it uploaded really is one of ours
 * (our cloud, our folder) and returns the fields worth storing, or null.
 */
export function cleanAttachment(raw, uploadedBy) {
  const { cloudName } = config();
  const url = String(raw?.url ?? "");
  const publicId = String(raw?.publicId ?? "");
  if (!url.startsWith(`https://res.cloudinary.com/${cloudName}/`) || !publicId.startsWith(`${UPLOAD_FOLDER}/`)) {
    return null;
  }
  return {
    url,
    publicId,
    resourceType: ["image", "video", "raw"].includes(raw.resourceType) ? raw.resourceType : "raw",
    name: String(raw.name ?? publicId.split("/").pop()).slice(0, 200),
    bytes: Math.max(0, Number(raw.bytes) || 0),
    mimeType: String(raw.mimeType ?? "").slice(0, 100),
    uploadedBy,
  };
}

/** Deletes a file from Cloudinary. Failures are logged, not thrown — the reference is removed either way. */
export async function destroyUpload(publicId, resourceType = "image") {
  try {
    const { cloudName, apiKey, apiSecret } = config();
    const params = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000) };
    const body = new URLSearchParams({ ...params, api_key: apiKey, signature: sign(params, apiSecret) });
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`, {
      method: "POST",
      body,
    });
    if (!res.ok) console.error("Cloudinary destroy failed:", res.status, await res.text());
  } catch (err) {
    console.error("Cloudinary destroy failed:", err.message);
  }
}
