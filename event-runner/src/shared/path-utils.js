/**
 * Tiện ích xử lý đường dẫn file Windows / đường dẫn tương đối sang file:// URL
 * Dùng url.pathToFileURL để xử lý đúng dấu cách, tiếng Việt, ký tự đặc biệt (#, %, ?).
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

/**
 * Giải quyết đường dẫn media (tuyệt đối hoặc tương đối so với file dự án)
 */
function resolveMediaPath(mediaPath, projectFilePath) {
  if (typeof mediaPath !== 'string' || !mediaPath.trim()) return null;
  const trimmed = mediaPath.trim();

  if (/^file:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }

  if (projectFilePath && typeof projectFilePath === 'string') {
    const baseDir = path.dirname(projectFilePath);
    return path.resolve(baseDir, trimmed);
  }

  return path.resolve(trimmed);
}

/**
 * Chuyển đường dẫn file sang URL an toàn bằng url.pathToFileURL
 */
function toSafeFileUrl(mediaPath, projectFilePath) {
  if (typeof mediaPath !== 'string' || !mediaPath.trim()) return '';
  const trimmed = mediaPath.trim();
  if (/^(file|blob|data):/i.test(trimmed)) {
    return trimmed;
  }
  const resolved = resolveMediaPath(trimmed, projectFilePath);
  if (!resolved) return '';
  return pathToFileURL(resolved).href;
}

/**
 * Lấy tên file không kèm phần mở rộng (dùng khi thêm hàng loạt cue từ ảnh/video)
 */
function baseNameWithoutExt(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return 'Cue mới';
  const base = path.basename(filePath.trim());
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

module.exports = {
  resolveMediaPath,
  toSafeFileUrl,
  baseNameWithoutExt
};
