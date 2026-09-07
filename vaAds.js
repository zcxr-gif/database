// vaAds.js
// S3 image helpers for the Virtual Airline Advertisement system.
//
// Mirrors the structure of airports.js: image processing + upload live here so
// the route handlers in server.js stay lean. A VA ad has two distinct images:
//   - banner : wide marketing banner shown on the directory card / detail page.
//   - logo   : square airline logo / roundel.
// Both are normalized to WebP for storage efficiency, exactly like the rest of
// the project's media pipeline.

const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const fs = require('fs');

// Per-kind sizing. Banners keep their aspect ratio but are capped so we never
// store a 4K upload; logos are fit inside a square box without enlarging.
const IMAGE_PROFILES = {
    banner: { width: 1600, height: 600, fit: 'inside' },
    logo:   { width: 512,  height: 512, fit: 'inside' },
    // Event banners are the hero image on an event card. A wide 16:9-ish cap
    // keeps them crisp on a big card without ever storing a full-res upload.
    event:  { width: 1600, height: 900, fit: 'inside' },
    // A picture a VA puts on their own website. The only kind here with no
    // shape of its own — it might be a hero running the width of a monitor, a
    // card in a grid, or a portrait beside two paragraphs — so it is capped on
    // the LONG EDGE and left to keep its own aspect ratio.
    //
    // 2000 rather than 1600: this is the one that can end up full-bleed behind
    // a headline, and a 1600px-wide hero on a 2x laptop is visibly soft. The
    // extra pixels cost about 40 KB after WebP and buy the one case where
    // softness would be obvious.
    site:   { width: 2000, height: 2000, fit: 'inside' }
};

// Animated banners/logos are re-encoded as animated WebP, keeping EVERY frame
// and the full loop. Encoding cost is dominated by decoding + resizing every
// frame, so the frame COUNT (not just resolution) drives how long the request
// takes — a tight dimension cap keeps both the output small AND the encode fast
// enough to finish inside the HTTP timeout.
const ANIMATED_PROFILES = {
    banner: { width: 720, height: 270, fit: 'inside' },
    logo:   { width: 320, height: 320, fit: 'inside' },
    event:  { width: 720, height: 405, fit: 'inside' },
    // An animated picture on a website is a GIF somebody dropped in, and the
    // cost of one is measured in the frames nobody asked for. Same tight cap as
    // the rest: every frame is kept, at a size that encodes inside the request.
    site:   { width: 720, height: 720, fit: 'inside' }
};

// Hard ceiling on total source pixels to decode for an animated upload
// (frames × width × height). Above this the synchronous encode would risk
// exceeding the request timeout, so we reject fast with a clear message instead
// of letting the request hang. ~120 MP ≈ a ~4s GIF at 720p, or a longer one at
// lower resolution — comfortably covers normal banner GIFs.
const MAX_ANIMATED_SOURCE_PIXELS = 120 * 1000 * 1000;

// Build a clean, collision-resistant S3 key for a VA image.
const buildKey = (vaRef, kind) => {
    const cleanRef = (vaRef || 'va').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || 'va';
    // Website pictures get their own prefix rather than sitting under va-ads/.
    // They are the one kind a member of the public uploaded rather than staff
    // approved, so when a takedown lands the thing you need is every picture
    // one airline put on its site — which is a prefix listing, not a search.
    const prefix = kind === 'site' ? 'va-sites' : 'va-ads';
    return `${prefix}/${kind}/${cleanRef}-${Date.now()}-${Math.round(Math.random() * 1e6)}.webp`;
};

/**
 * Optimize a single VA image (banner or logo) and upload it to S3.
 * Accepts both Multer disk files (file.path) and raw buffers (file.buffer),
 * so the same helper works from the web dashboard and from a bot/automation.
 *
 * Animation is preserved: an animated source (GIF or animated WebP) is
 * re-encoded as ANIMATED WebP with every frame resized, so event banners can
 * move. A still image takes the normal single-frame path. Output is always
 * `.webp` at the same key/content-type, so the URL, the public API and the
 * widget's <img> are identical whether or not the banner animates.
 *
 * Returns the public URL, and — since v2 — the dimensions and byte count of
 * what was actually stored. Callers that only want the URL can carry on
 * treating it as a string: see `uploadVaImageMeta` below for the full record.
 */
const uploadVaImage = async (s3Client, file, vaRef, kind = 'banner') =>
    (await uploadVaImageMeta(s3Client, file, vaRef, kind)).url;

/**
 * The same upload, with what it stored.
 *
 * A media library has to say how much room is left, and it cannot do that from
 * the SOURCE file's size: everything here is re-encoded to WebP at a capped
 * dimension, so a 9 MB phone photograph lands as maybe 300 KB. Charging a VA
 * for the 9 MB would make the quota a lie in the direction that annoys them.
 *
 * The width and height come back for the same reason an <img> wants them: so a
 * grid can reserve the right box before the picture arrives.
 */
const uploadVaImageMeta = async (s3Client, file, vaRef, kind = 'banner') => {
    const bucketName = process.env.AWS_S3_BUCKET_NAME;

    const inputSource = file.path ? file.path : file.buffer;

    // Probe the source. metadata() only reads the header, so this is cheap and
    // tells us the frame count (pages) and per-frame dimensions up front.
    let meta = {};
    try { meta = await sharp(inputSource).metadata(); } catch { meta = {}; }
    const frames = meta.pages || 1;
    const animated = frames > 1;

    // Fast-fail an animation that's too long/large to re-encode inside the
    // request timeout (the encode decodes + resizes EVERY frame). Rejecting here
    // — before the multi-second encode — turns a hung "saving…" into an instant,
    // clear message. Tagged so the route can surface it as a 413.
    if (animated) {
        const sourcePixels = frames * (meta.width || 0) * (meta.height || 0);
        if (sourcePixels > MAX_ANIMATED_SOURCE_PIXELS) {
            const err = new Error(
                'That animated banner is too long or too high-resolution to process. ' +
                'Please use a shorter GIF, or one at a smaller resolution.'
            );
            err.status = 413;
            if (file.path) fs.unlink(file.path, () => {});
            throw err;
        }
    }

    const profile = (animated ? ANIMATED_PROFILES : IMAGE_PROFILES)[kind]
        || (animated ? ANIMATED_PROFILES : IMAGE_PROFILES).banner;

    // Animated path: keep every frame + the loop (full-length animation), but
    // squeeze size hard — lower quality, smart chroma subsampling and a tight
    // dimension cap. effort:4 (not 6) keeps the encode fast; frame decode already
    // dominates, so max effort buys little size but a lot of time.
    const readOpts = animated ? { animated: true, limitInputPixels: 200_000_000 } : {};
    const webpOpts = animated
        ? { quality: 58, effort: 4, smartSubsample: true }
        : { quality: 82 };

    const optimizedBuffer = await sharp(inputSource, readOpts)
        .resize({ ...profile, withoutEnlargement: true })
        .webp(webpOpts)
        .toBuffer();

    const key = buildKey(vaRef, kind);

    await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: optimizedBuffer,
        ContentType: 'image/webp'
    }));

    // Clean up the temp upload only if it came from disk (Multer).
    if (file.path) fs.unlink(file.path, () => {});

    // Measured on the OUTPUT, not the source: sharp has already resized and
    // re-encoded, and these are the numbers a quota and an <img> both want.
    let out = {};
    try { out = await sharp(optimizedBuffer).metadata(); } catch { out = {}; }

    return {
        url: `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
        bytes: optimizedBuffer.length,
        width: out.width || 0,
        height: out.height || 0,
        animated,
    };
};

/**
 * Delete a VA image from S3 given its public URL. Safe to call with null/empty.
 */
const deleteVaImage = async (s3Client, imageUrl) => {
    if (!imageUrl) return;
    try {
        const key = new URL(imageUrl).pathname.substring(1); // strip leading '/'
        await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: key
        }));
    } catch (error) {
        // Non-fatal: a missing/oddly-formed URL shouldn't break the request.
        console.error(`Error deleting VA image: ${imageUrl}`, error.message);
    }
};

module.exports = { uploadVaImage, uploadVaImageMeta, deleteVaImage };
