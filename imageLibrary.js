'use strict';

/**
 * Member image library.
 *
 * Image bytes are hosted by the same ImgBB integration used for profile and
 * chat images; MongoDB stores a searchable category record and ownership.
 * The model and router are factories/injected so route behaviour can be tested
 * over HTTP without a live MongoDB or ImgBB account.
 */
const express = require('express');
const multer = require('multer');
const roles = require('./roles');

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_CAPTION_LENGTH = 240;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 48;
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

const IMAGE_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'fighter-photos', label: 'Fighter Photos' }),
  Object.freeze({ id: 'gear-attire', label: 'Gear & Attire' }),
  Object.freeze({ id: 'artwork', label: 'Artwork' }),
  Object.freeze({ id: 'match-moments', label: 'Match Moments' }),
  Object.freeze({ id: 'events', label: 'Events & Meetups' }),
  Object.freeze({ id: 'other', label: 'Other' })
]);
const CATEGORY_IDS = new Set(IMAGE_CATEGORIES.map(category => category.id));

function isImgBBUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' &&
      (url.hostname === 'ibb.co' || url.hostname.endsWith('.ibb.co'));
  } catch (_) {
    return false;
  }
}

function normalizeCategory(value) {
  const category = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CATEGORY_IDS.has(category) ? category : null;
}

function cleanCaption(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Return the raster MIME type proved by the file signature, or null. */
function detectRasterImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;

  // PNG signature.
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  // JPEG Start Of Image + marker prefix.
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF87a / GIF89a.
  if (buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  // WebP is a RIFF container whose form type is WEBP.
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function validateRasterUpload(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) return { ok: false, error: 'no_file' };
  if (file.size > MAX_IMAGE_SIZE) return { ok: false, error: 'file_too_large' };

  const detectedType = detectRasterImageType(file.buffer);
  const declaredType = String(file.mimetype || '').trim().toLowerCase();
  const normalizedDeclaredType = declaredType === 'image/jpg' || declaredType === 'image/pjpeg'
    ? 'image/jpeg'
    : declaredType;
  const declaredTypeIsUnspecified = !normalizedDeclaredType || normalizedDeclaredType === 'application/octet-stream';

  // Trust the bytes, not only the browser-provided MIME type. SVG is excluded
  // because it can contain active content when hosted as a public image URL.
  // Some mobile file pickers report application/octet-stream; a valid raster
  // signature is sufficient in that case.
  if (!detectedType || (!declaredTypeIsUnspecified && normalizedDeclaredType !== detectedType)) {
    return { ok: false, error: 'invalid_file_type' };
  }
  return { ok: true, mimetype: detectedType };
}

function isStaffUser(user) {
  return !!user && !user.banned && (
    roles.isAdministratorAccount(user.username) || roles.isStaffRole(user.role)
  );
}

function serializeImage(image, username, staff) {
  return {
    _id: String(image._id),
    imageUrl: image.imageUrl,
    category: image.category,
    caption: image.caption || '',
    uploadedBy: image.uploadedBy,
    createdAt: image.createdAt || null,
    canDelete: image.uploadedBy === username || staff
  };
}

function createImageLibraryModel(mongoose) {
  const modelName = 'ImageLibraryImage';
  if (mongoose.models && mongoose.models[modelName]) return mongoose.models[modelName];

  const schema = new mongoose.Schema({
    imageUrl: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: isImgBBUrl,
        message: 'Image library files must be hosted on ImgBB'
      }
    },
    category: { type: String, required: true, enum: Array.from(CATEGORY_IDS) },
    caption: { type: String, trim: true, default: '', maxlength: MAX_CAPTION_LENGTH },
    uploadedBy: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now }
  }, {
    collection: 'image_library',
    versionKey: false
  });

  schema.index({ category: 1, createdAt: -1, _id: -1 });
  schema.index({ createdAt: -1, _id: -1 });
  schema.index({ uploadedBy: 1, createdAt: -1 });
  return mongoose.model(modelName, schema);
}

function createImageLibraryRouter({
  ImageLibraryImage,
  requireUser,
  uploadImageToImgBB,
  writeLimiter = (_req, _res, next) => next(),
  noRevalidate = (_req, _res, next) => next()
} = {}) {
  if (!ImageLibraryImage || typeof ImageLibraryImage.find !== 'function') {
    throw new TypeError('ImageLibraryImage model is required');
  }
  if (typeof requireUser !== 'function') throw new TypeError('requireUser middleware is required');
  if (typeof uploadImageToImgBB !== 'function') throw new TypeError('uploadImageToImgBB helper is required');

  // Keep this feature's multipart limits isolated from profile and chat forms.
  // The image lives in memory only long enough to be handed to ImgBB; MongoDB
  // stores the hosted URL and metadata, never the uploaded bytes.
  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_IMAGE_SIZE,
      fieldSize: MAX_CAPTION_LENGTH * 4 + 64,
      fields: 3,
      files: 1,
      parts: 5
    }
  });

  const router = express.Router();

  router.get('/', noRevalidate, requireUser, async (req, res) => {
    const rawCategory = typeof req.query.category === 'string' ? req.query.category.trim() : '';
    const category = rawCategory && rawCategory.toLowerCase() !== 'all'
      ? normalizeCategory(rawCategory)
      : null;
    if (rawCategory && rawCategory.toLowerCase() !== 'all' && !category) {
      return res.status(400).json({ ok: false, error: 'invalid_category' });
    }

    const rawPage = req.query.page == null ? '1' : String(req.query.page);
    const rawLimit = req.query.limit == null ? String(DEFAULT_PAGE_SIZE) : String(req.query.limit);
    const page = /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
    const requestedLimit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 ||
        !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      return res.status(400).json({ ok: false, error: 'invalid_pagination' });
    }
    const limit = Math.min(requestedLimit, MAX_PAGE_SIZE);
    const filter = category ? { category } : {};

    try {
      const staff = isStaffUser(req.user);
      const images = await ImageLibraryImage.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit + 1)
        .lean();
      const hasMore = images.length > limit;

      return res.json({
        ok: true,
        category: category || 'all',
        categories: IMAGE_CATEGORIES,
        images: images.slice(0, limit).map(image => serializeImage(image, req.username, staff)),
        page,
        limit,
        hasMore
      });
    } catch (err) {
      console.error('image library list error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  const receiveImage = imageUpload.single('image');
  const parseImageUpload = (req, res, next) => {
    receiveImage(req, res, err => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, error: 'file_too_large', maxFileSize: MAX_IMAGE_SIZE });
      }
      if (err.code === 'LIMIT_FIELD_VALUE') {
        return res.status(400).json({ ok: false, error: 'field_too_large' });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ ok: false, error: 'unexpected_file_field' });
      }
      return res.status(400).json({ ok: false, error: 'invalid_upload' });
    });
  };

  router.post('/', requireUser, writeLimiter, parseImageUpload, async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });

    const category = normalizeCategory(req.body && req.body.category);
    if (!category) return res.status(400).json({ ok: false, error: 'invalid_category' });

    const caption = cleanCaption(req.body && req.body.caption);
    if (caption.length > MAX_CAPTION_LENGTH) {
      return res.status(400).json({ ok: false, error: 'caption_too_long', maxLength: MAX_CAPTION_LENGTH });
    }

    const validation = validateRasterUpload(req.file);
    if (!validation.ok) {
      const status = validation.error === 'file_too_large' ? 413 : 400;
      return res.status(status).json({
        ok: false,
        error: validation.error,
        ...(validation.error === 'file_too_large' ? { maxFileSize: MAX_IMAGE_SIZE } : {})
      });
    }
    // Pass the verified type to the host API instead of trusting the multipart
    // header. No image bytes are persisted in MongoDB.
    req.file.mimetype = validation.mimetype;

    try {
      const hosted = await uploadImageToImgBB(req.file);
      if (!hosted || !isImgBBUrl(hosted.imageUrl)) {
        return res.status(502).json({ ok: false, error: 'upload_failed' });
      }

      const image = await ImageLibraryImage.create({
        imageUrl: hosted.imageUrl,
        category,
        caption,
        uploadedBy: req.username,
        createdAt: new Date()
      });

      return res.status(201).json({
        ok: true,
        image: serializeImage(image, req.username, isStaffUser(req.user))
      });
    } catch (err) {
      console.error('image library upload error:', err?.code || err?.message || err);
      const status = err?.code === 'no_imgbb_key' ? 503
        : err?.code === 'invalid_file_type' || err?.code === 'no_file' ? 400
          : err?.code === 'upload_failed' ? 502 : 500;
      return res.status(status).json({
        ok: false,
        error: err?.code || 'upload_error'
      });
    }
  });

  router.delete('/:id', requireUser, writeLimiter, async (req, res) => {
    const id = String(req.params.id || '');
    if (!OBJECT_ID_RE.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }

    try {
      const image = await ImageLibraryImage.findById(id).lean();
      if (!image) return res.status(404).json({ ok: false, error: 'not_found' });

      const staff = isStaffUser(req.user);
      if (image.uploadedBy !== req.username && !staff) {
        return res.status(403).json({ ok: false, error: 'not_owner' });
      }

      await ImageLibraryImage.deleteOne({ _id: image._id });
      return res.json({ ok: true });
    } catch (err) {
      console.error('image library delete error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  return router;
}

module.exports = {
  IMAGE_CATEGORIES,
  MAX_IMAGE_SIZE,
  MAX_CAPTION_LENGTH,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  isImgBBUrl,
  normalizeCategory,
  cleanCaption,
  detectRasterImageType,
  validateRasterUpload,
  createImageLibraryModel,
  createImageLibraryRouter
};
