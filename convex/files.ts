import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function getR2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

// Generate a presigned GET URL for an R2 key. Used at execution time so
// the Python sandbox can fetch the file without the bucket being public.
export async function generateDownloadUrl(
  key: string,
  expiresIn = 3600
): Promise<string> {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME not configured");
  const client = getR2Client();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn });
}

// Generate R2 presigned PUT URL for file uploads.
// 1hr TTL for upload. File accessible for 30 days (lifecycle rule in R2 bucket).
export const getUploadUrl = action({
  args: {
    filename: v.string(),
    contentType: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const bucket = process.env.R2_BUCKET_NAME;
    if (!bucket) {
      throw new Error("R2 not configured");
    }

    // Sanitize filename to prevent path traversal
    const safeName = args.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uuid = crypto.randomUUID();
    const key = `uploads/${identity.subject}/${uuid}/${safeName}`;

    const client = getR2Client();
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: args.contentType,
    });

    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 3600 });

    return { uploadUrl, fileKey: key };
  },
});

// Public file upload for published automations. No auth required.
// Scopes uploads under the automation's slug to keep them organized.
export const getPublishedUploadUrl = action({
  args: {
    slug: v.string(),
    filename: v.string(),
    contentType: v.string(),
  },
  handler: async (ctx, args) => {
    // Verify automation is published and active
    const automation = await ctx.runQuery(
      internal.automations.getPublishedInternal,
      { slug: args.slug }
    );
    if (!automation) throw new Error("Automation not found");

    const bucket = process.env.R2_BUCKET_NAME;
    if (!bucket) throw new Error("R2 not configured");

    const safeName = args.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uuid = crypto.randomUUID();
    const key = `uploads/published/${args.slug}/${uuid}/${safeName}`;

    const client = getR2Client();
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: args.contentType,
    });

    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 3600 });

    return { uploadUrl, fileKey: key };
  },
});
