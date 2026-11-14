const configuredOrigins = () => [
    process.env.CLIENT_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null,
    "http://localhost:3000"
].filter(Boolean).map(value => {
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}).filter(Boolean);

const isAllowedOrigin = origin => !origin || configuredOrigins().includes(origin);

const corsOrigin = (origin, callback) => callback(null, isAllowedOrigin(origin));

const mediaUploadOrigins = () => {
    if (!process.env.MEDIA_BUCKET) return [];
    try {
        const region = process.env.AWS_REGION || "us-east-1";
        const endpoint = new URL(process.env.S3_ENDPOINT || `https://s3.${region}.amazonaws.com`);
        const host = process.env.S3_FORCE_PATH_STYLE === "true"
            ? endpoint.host
            : `${process.env.MEDIA_BUCKET}.${endpoint.host}`;
        return [`${endpoint.protocol}//${host}`];
    } catch {
        return [];
    }
};

module.exports = { configuredOrigins, isAllowedOrigin, corsOrigin, mediaUploadOrigins };
