import { createWriteStream, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import https from 'https';
import http from 'http';

/**
 * Download file from Telegram servers
 * @param {string} fileId - Telegram file ID
 * @param {string} botToken - Telegram bot token
 * @param {string} extension - File extension (default: 'ogg')
 * @returns {Promise<string>} - Path to downloaded file
 */
export async function downloadTelegramFile(fileId, botToken, extension = 'ogg') {
  // Get file info from Telegram API
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Failed to get file info: ${data.description}`);
  }

  const filePath = data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const tempPath = `/tmp/${randomUUID()}.${extension}`;

  return new Promise((resolve, reject) => {
    const fileStream = createWriteStream(tempPath);
    const protocol = fileUrl.startsWith('https') ? https : http;

    protocol.get(fileUrl, (response) => {
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve(tempPath);
      });
    }).on('error', (err) => {
      try {
        unlinkSync(tempPath);
      } catch (e) {
        // Ignore cleanup errors
      }
      reject(err);
    });
  });
}

/**
 * Format Unix timestamp to readable filename format (YYYY-MM-DD_HH-mm-ss)
 * @param {number} unixTimestamp - Unix timestamp in seconds
 * @returns {string} - Formatted timestamp string
 */
export function formatTimestamp(unixTimestamp) {
  const date = new Date(unixTimestamp * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

/**
 * Format duration as "1m 3s" or "55s"
 * @param {number} seconds - Duration in seconds
 * @returns {string} - Formatted duration string
 */
export function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${remainingSeconds}s`;
  }
}

/**
 * Create authorization middleware for Telegram bot
 * @param {number} authorizedUserId - Authorized Telegram user ID
 * @returns {Function} - Middleware function
 */
export function createAuthMiddleware(authorizedUserId) {
  return (ctx, next) => {
    if (ctx.from?.id !== authorizedUserId) {
      console.log(`❌ Unauthorized access attempt from user ${ctx.from?.id}`);
      return; // Silently ignore unauthorized users
    }
    console.log(`✓ User authorized: ${ctx.from.id}`);
    return next();
  };
}

/**
 * Extract URLs from text
 * @param {string} text - Text to search for URLs
 * @returns {string[]} - Array of URLs found
 */
export function extractUrls(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(urlRegex);
  return matches || [];
}

/**
 * Check if text contains a URL
 * @param {string} text - Text to check
 * @returns {boolean} - True if text contains URL
 */
export function containsUrl(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return urlRegex.test(text);
}

/**
 * Get file extension from MIME type
 * @param {string} mimeType - MIME type
 * @returns {string} - File extension
 */
export function getExtensionFromMimeType(mimeType) {
  const mimeToExt = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
  };

  return mimeToExt[mimeType] || 'bin';
}
