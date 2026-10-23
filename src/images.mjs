const MAX_IMAGE_BYTES = 1024 * 1024;
const magic = {
  'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  'image/jpeg': bytes => bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9,
  'image/gif': bytes => bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a',
  'image/webp': bytes => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
};

export function normalizeImages(raw = []) {
  if (!Array.isArray(raw) || raw.length > 4) throw new Error('Invalid inline images');
  let total = 0;
  return raw.map(image => {
    if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).some(key => !['mimeType', 'data'].includes(key)) ||
      !Object.hasOwn(magic, image.mimeType) || typeof image.data !== 'string' || image.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 ||
      image.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw new Error('Invalid inline image encoding or MIME');
    const bytes = Buffer.from(image.data, 'base64'); total += bytes.length;
    if (!bytes.length || total > MAX_IMAGE_BYTES || !magic[image.mimeType](bytes) || bytes.toString('base64') !== image.data) throw new Error('Invalid inline image content or size');
    return { type: 'image', mimeType: image.mimeType, data: image.data };
  });
}

export function modelSupportsImages(model) {
  return Array.isArray(model?.input) && model.input.includes('image');
}
