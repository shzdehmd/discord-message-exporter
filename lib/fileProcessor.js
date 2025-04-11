// lib/fileProcessor.js

const fs = require('node:fs/promises');
const fsSync = require('node:fs'); // For sync checks/writes if needed
const path = require('node:path');
const axios = require('axios');
const { pipeline } = require('node:stream');
const { promisify } = require('node:util');
const crypto = require('node:crypto'); // For MD5 hashing
const os = require('node:os'); // For temporary directory path
const logger = require('./logger'); // Use the shared logger

const streamPipeline = promisify(pipeline);
const EMOTE_MARKER_PREFIX = 'EMOTE_MARKER:'; // Marker for front-end JS/HTML renderer

// --- Regex definitions ---
const fileUrlRegex = /https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|mp4|mov|avi|mkv|webm|webp|mp3|ogg|wav|pdf)(?:\?[^\s]*)?/gi;
const emoteRegex = /<(a?):([a-zA-Z0-9_]{2,32}):(\d{17,20})>/g; // Discord emote markdown

// --- Axios Instance ---
const axiosInstance = axios.create({
    timeout: 25000, // Default timeout
    headers: { 'User-Agent': 'DiscordExporterApp/1.0 FileDownloader (Node.js)' },
    responseType: 'stream', // Default to stream for downloads
});

// --- Helper Functions ---

/**
 * Constructs the CDN URL for a user avatar.
 * @param {string} userId
 * @param {string} avatarHash
 * @param {number} [size=128]
 * @returns {{url: string, ext: string} | null}
 */
function constructAvatarCdnUrl(userId, avatarHash, size = 128) {
    if (!avatarHash || typeof avatarHash !== 'string') return null;
    // Heuristic check for default/invalid hash length
    if (avatarHash.length < 10) return null;
    const format = avatarHash.startsWith('a_') ? 'gif' : 'png';
    const url = `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${format}?size=${size}`;
    return { url, ext: format };
}

/**
 * Checks Discord CDN for the best available emote image format.
 * @param {string} emoteId
 * @returns {Promise<{url: string, ext: string} | null>}
 */
async function findEmoteUrl(emoteId) {
    const baseUrl = `https://cdn.discordapp.com/emojis/${emoteId}`;
    const extensions = ['gif', 'png', 'webp', 'jpg'];
    for (const ext of extensions) {
        const url = `${baseUrl}.${ext}`;
        try {
            // Use HEAD request to check existence efficiently
            await axiosInstance.head(url, { responseType: 'arraybuffer', timeout: 7000 });
            return { url, ext };
        } catch (error) {
            // Log only unexpected errors (not 404)
            if (axios.isAxiosError(error) && error.response?.status !== 404) {
                logger.logWarn(`Error checking emote HEAD ${url} (Status: ${error.response?.status})`, error.message);
            } else if (!axios.isAxiosError(error)) {
                logger.logWarn(`Non-axios error checking emote HEAD ${url}`, error);
            }
        }
    }
    logger.logWarn(`No valid image format found for emote ID ${emoteId} on CDN.`);
    return null;
}

/**
 * Downloads a file if not already cached, calculates MD5, saves if unique, handles cross-device moves,
 * sends status updates, and caches the result.
 *
 * @param {string} url - URL to download.
 * @param {string} targetDirectory - Absolute path for the final hashed file (e.g., .../downloaded_files/avatars).
 * @param {string} baseExportDir - Absolute path to the base export dir (e.g., .../Exports/Channel-123) - needed for relative path calculation.
 * @param {string|null} [forcedExtension=null] - Forced extension.
 * @param {string} jobId - The ID for the current export job (for status updates).
 * @param {function} sendUpdate - The callback function to send status updates (e.g., sendJobUpdate from server.js).
 * @param {Map<string, string>} downloadCache - Cache map (URL -> relativePath).
 * @returns {Promise<string>} - Resolves to the relative path (e.g., "downloaded_files/avatars/HASH.ext").
 * @throws {Error} - If download/hash/save fails (after cache miss).
 */
async function downloadAndDeduplicateFile(
    url,
    targetDirectory,
    baseExportDir,
    forcedExtension = null,
    jobId,
    sendUpdate,
    downloadCache,
) {
    logger.logInfo(`[${jobId}] Download func called for: ${url}`); // <<< ADDED: Log entry

    // --- Cache Check ---
    if (downloadCache.has(url)) {
        const cachedPath = downloadCache.get(url);
        logger.logInfo(`[${jobId}] Cache HIT for ${url} -> ${cachedPath}`); // <<< MODIFIED: Make explicit
        return cachedPath;
    } else {
        logger.logInfo(`[${jobId}] Cache MISS for ${url}. Proceeding with download.`); // <<< ADDED: Log cache miss
    }
    // --- End Cache Check ---

    // --- 1. Determine Extension ---
    let derivedExtension = '';
    if (forcedExtension) {
        derivedExtension = forcedExtension.startsWith('.') ? forcedExtension : `.${forcedExtension}`;
    } else {
        try {
            const p = new URL(url).pathname;
            derivedExtension = path.extname(p);
            if (!derivedExtension) {
                derivedExtension = path.extname(url.split('?')[0]);
            }
        } catch (e) {
            logger.logWarn(`URL parse error for ext: ${url}. Fallback.`, e.message);
            derivedExtension = path.extname(url.split('?')[0]);
        }
    }
    const finalExt =
        derivedExtension && derivedExtension.length > 1
            ? derivedExtension
                  .split('?')[0]
                  .toLowerCase()
                  .replace(/[^a-z0-9.]/g, '')
            : '.unknown';

    // --- 2. Prepare Temporary Download ---
    let tempDir = null;
    let tempFilePath = null;
    let writer = null;
    let fileHash = '';

    try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-export-'));
        tempFilePath = path.join(tempDir, `download${finalExt}`);
        await fs.mkdir(targetDirectory, { recursive: true });

        // --- 3. Download and Hash Simultaneously ---
        // logger.logInfo(`[${jobId}] Cache miss. Downloading ${url}`); // Reduce log noise
        const response = await axiosInstance.get(url, { responseType: 'stream', timeout: 60000 }); // Longer timeout for download+hash
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
        }

        const hash = crypto.createHash('md5');
        writer = fsSync.createWriteStream(tempFilePath);
        let downloadedBytes = 0;
        // const totalBytes = response.headers['content-length'] ? parseInt(response.headers['content-length'], 10) : null; // Optional for % progress

        await new Promise((resolve, reject) => {
            response.data
                .on('data', (chunk) => {
                    hash.update(chunk);
                    downloadedBytes += chunk.length;
                    // Optional: Send download % update - can be very noisy
                    // if (totalBytes) { const percent = Math.round((downloadedBytes / totalBytes) * 100); sendUpdate(jobId, { status: 'progress', message: `DL ${path.basename(url)} ${percent}%`, percent: percent }); }
                })
                .pipe(writer)
                .on('finish', () => {
                    fileHash = hash.digest('hex');
                    resolve();
                }) // Get hash after stream finishes
                .on('error', reject);
        });
        // Ensure writer is closed before proceeding to prevent file access issues
        await new Promise((resolve, reject) => {
            writer.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        writer = null; // Mark as closed
        // logger.logInfo(`[${jobId}] Hash: ${fileHash} for ${url}`); // Reduce log noise

        // --- 4. Determine Final Path & Check Existence ---
        const finalFileName = `${fileHash}${finalExt}`;
        const finalAbsolutePath = path.join(targetDirectory, finalFileName);
        const shortFilenameForUpdate = path.basename(url).split('?')[0] || finalFileName; // For readable status message

        let fileExisted = false;
        try {
            await fs.access(finalAbsolutePath, fs.constants.F_OK);
            fileExisted = true;
            // Send update for successful deduplication
            sendUpdate(jobId, { status: 'progress', message: `Deduplicated: ${shortFilenameForUpdate}` });
        } catch (accessError) {
            // File DOES NOT EXIST - Need to move/copy it
            try {
                // Attempt Rename First
                await fs.rename(tempFilePath, finalAbsolutePath);
                tempFilePath = null; // Mark as moved
                // Send update for successful save (rename)
                sendUpdate(jobId, { status: 'progress', message: `Saved: ${shortFilenameForUpdate}` });
            } catch (renameError) {
                // If rename fails with EXDEV, fallback to Copy + Unlink
                if (renameError.code === 'EXDEV') {
                    // logger.logWarn(`[${jobId}] Rename failed (cross-device). Fallback copy for ${finalFileName}.`); // Reduce log noise
                    await fs.copyFile(tempFilePath, finalAbsolutePath);
                    // Send update for successful save (copy)
                    sendUpdate(jobId, { status: 'progress', message: `Saved (copied): ${shortFilenameForUpdate}` });
                    // Temp file still exists, will be deleted in finally block
                } else {
                    logger.logError(`[${jobId}] Rename failed: ${renameError.code}`, renameError);
                    throw renameError; // Re-throw other rename errors
                }
            }
        }

        // --- 5. Calculate Relative Path & Store in Cache ---
        const relativePath = path.relative(baseExportDir, finalAbsolutePath).split(path.sep).join('/');
        logger.logInfo(`[${jobId}] Calculated relativePath: ${relativePath} for ${url}`); // <<< ADDED: Log calculated path
        if (!relativePath || typeof relativePath !== 'string') {
            // <<< ADDED: Check if path is valid
            logger.logError(`[${jobId}] ERROR: Calculated relativePath is invalid! URL: ${url}`, {
                path: relativePath,
            });
            throw new Error('Invalid relative path calculated'); // Fail if path is bad
        }
        downloadCache.set(url, relativePath); // Add valid path to cache
        logger.logInfo(`[${jobId}] Added to cache: ${url} -> ${relativePath}`); // <<< ADDED: Log cache add
        return relativePath;
    } catch (error) {
        // --- Error Handling ---
        logger.logError(`[${jobId}] Download/Process FAILED for ${url}. Error: ${error.message}`, error);
        let thrownError = error;
        if (axios.isAxiosError(error)) {
            if (error.code === 'ECONNABORTED' || error.message.toLowerCase().includes('timeout')) {
                thrownError = new Error(`Timeout processing ${url}`);
            } else if (error.response) {
                thrownError = new Error(`HTTP ${error.response.status} ${error.response.statusText} for ${url}`);
            }
            thrownError.originalError = error;
        } else if (!(error instanceof Error)) {
            thrownError = new Error(`An unexpected error occurred: ${error}`);
        }
        if (error.response?.status && !thrownError.message.includes(`HTTP ${error.response.status}`)) {
            thrownError.message += ` (Status: ${error.response.status})`;
        }
        throw thrownError;
    } finally {
        // --- 6. Cleanup ---
        if (writer && !writer.destroyed) writer.destroy();
        if (tempDir) {
            try {
                await fs.rm(tempDir, { recursive: true, force: true });
            } catch (cleanupError) {
                logger.logWarn(`[${jobId}] Failed cleanup temp dir ${tempDir}`, cleanupError);
            }
        }
    }
}

/**
 * Checks if an object looks like a Discord User object.
 * @param {any} obj
 * @returns {boolean}
 */
function isUserObject(obj) {
    return (
        obj &&
        typeof obj === 'object' &&
        typeof obj.id === 'string' &&
        typeof obj.username === 'string' &&
        Object.prototype.hasOwnProperty.call(obj, 'avatar')
    );
}

/**
 * Processes user avatar, ensuring all args are passed down.
 * @param {object} userObj
 * @param {string} baseDownloadFolderAbsPath
 * @param {string} baseExportDir
 * @param {string} jobId
 * @param {function} sendUpdate
 * @param {Map<string, string>} downloadCache
 */
async function processUserAvatar(userObj, baseDownloadFolderAbsPath, baseExportDir, jobId, sendUpdate, downloadCache) {
    if (!isUserObject(userObj)) return;
    const userId = userObj.id;
    const avatarHash = userObj.avatar;
    const avatarInfo = constructAvatarCdnUrl(userId, avatarHash);

    if (avatarInfo) {
        const avatarDownloadFolder = path.join(baseDownloadFolderAbsPath, 'avatars');
        try {
            const localAvatarRelativePath = await downloadAndDeduplicateFile(
                avatarInfo.url,
                avatarDownloadFolder,
                baseExportDir,
                avatarInfo.ext,
                jobId,
                sendUpdate,
                downloadCache, // Pass ALL args
            );
            userObj.avatar = localAvatarRelativePath;
        } catch (error) {
            logger.logWarn(`[${jobId}] Avatar processing failed user ${userId}. Set null. Err: ${error.message}`);
            userObj.avatar = null;
        }
    } else {
        userObj.avatar = null;
    }
}

/**
 * Processes single emote, ensuring all args are passed down.
 * @param {string} fullMatch
 * @param {string} _animatedMarker
 * @param {string} emoteName
 * @param {string} emoteId
 * @param {string} baseDownloadFolderAbsPath
 * @param {string} baseExportDir
 * @param {string} jobId
 * @param {function} sendUpdate
 * @param {Map<string, string>} downloadCache
 * @returns {Promise<string>}
 */
async function processSingleEmote(
    fullMatch,
    _animatedMarker,
    emoteName,
    emoteId,
    baseDownloadFolderAbsPath,
    baseExportDir,
    jobId,
    sendUpdate,
    downloadCache,
) {
    const emoteInfo = await findEmoteUrl(emoteId);
    if (emoteInfo) {
        const emoteDownloadFolder = path.join(baseDownloadFolderAbsPath, 'emotes');
        try {
            const localEmoteRelativePath = await downloadAndDeduplicateFile(
                emoteInfo.url,
                emoteDownloadFolder,
                baseExportDir,
                emoteInfo.ext,
                jobId,
                sendUpdate,
                downloadCache, // Pass ALL args
            );
            const safeAlt = emoteName.replace(/\|/g, '').replace(/\s+/g, ' ').trim();
            const marker = `${EMOTE_MARKER_PREFIX}${localEmoteRelativePath}|${safeAlt}`;
            return marker;
        } catch (error) {
            logger.logWarn(
                `[${jobId}] Emote processing failed ${emoteName}(${emoteId}). Keep markdown. Err: ${error.message}`,
            );
            return fullMatch;
        }
    } else {
        return fullMatch;
    } // findEmoteUrl already logs warning
}

/**
 * Recursively processes data, ensuring all args are passed down correctly.
 * @param {*} data
 * @param {string} baseDownloadFolderAbsPath
 * @param {string} baseExportDir
 * @param {string} jobId
 * @param {function} sendUpdate
 * @param {Map<string, string>} downloadCache
 * @param {WeakSet<object>} [seen=new WeakSet()]
 * @returns {Promise<*>}
 */
async function processDataRecursively(
    data,
    baseDownloadFolderAbsPath,
    baseExportDir,
    jobId,
    sendUpdate,
    downloadCache,
    seen = new WeakSet(),
) {
    if (data === null || typeof data !== 'object') {
        if (typeof data === 'string') {
            let currentString = data;
            const gifDomains = /https?:\/\/(?:media\.tenor\.com|.*\.giphy\.com|gfycat\.com)/i;
            if (!gifDomains.test(currentString)) {
                const fileUrlMatches = Array.from(currentString.matchAll(fileUrlRegex));
                if (fileUrlMatches.length > 0) {
                    // Process sequentially
                    for (const match of fileUrlMatches) {
                        const originalUrl = match[0];
                        try {
                            const attachmentsFolder = path.join(baseDownloadFolderAbsPath, 'attachments');
                            const localPath = await downloadAndDeduplicateFile(
                                originalUrl,
                                attachmentsFolder,
                                baseExportDir,
                                null,
                                jobId,
                                sendUpdate,
                                downloadCache, // Pass ALL args
                            );
                            currentString = currentString.replace(originalUrl, localPath);
                        } catch (e) {
                            logger.logWarn(`[${jobId}] Keep URL ${originalUrl} (DL fail in string): ${e.message}`);
                        }
                    }
                }
            }
            if (currentString.includes('<') && currentString.includes(':') && currentString.includes('>')) {
                const emoteMatches = Array.from(currentString.matchAll(emoteRegex));
                if (emoteMatches.length > 0) {
                    // Process sequentially
                    for (const match of emoteMatches) {
                        const originalMarkdown = match[0];
                        const replacement = await processSingleEmote(
                            originalMarkdown,
                            match[1],
                            match[2],
                            match[3],
                            baseDownloadFolderAbsPath,
                            baseExportDir,
                            jobId,
                            sendUpdate,
                            downloadCache, // Pass ALL args
                        );
                        if (originalMarkdown !== replacement) {
                            currentString = currentString.replace(originalMarkdown, replacement);
                        }
                    }
                }
            }
            return currentString;
        } else {
            return data;
        }
    }
    if (seen.has(data)) {
        return '[Circular Reference]';
    }
    seen.add(data);

    let processedData;
    if (Array.isArray(data)) {
        processedData = []; // Sequential processing for array items too
        for (const item of data) {
            // *** RECURSIVE CALL for Array Item ***
            processedData.push(
                await processDataRecursively(
                    item,
                    baseDownloadFolderAbsPath,
                    baseExportDir,
                    jobId,
                    sendUpdate,
                    downloadCache,
                    seen,
                ),
            ); // Pass ALL args down
        }
    } else {
        // Object
        // *** CALL to processUserAvatar ***
        await processUserAvatar(data, baseDownloadFolderAbsPath, baseExportDir, jobId, sendUpdate, downloadCache); // Pass ALL args down

        const newObj = {};
        for (const key of Object.keys(data)) {
            if (key === 'avatar' && typeof data[key] === 'string') {
                newObj[key] = data[key];
            } // Avoid re-processing avatar string path
            else {
                // *** RECURSIVE CALL for Object Property ***
                newObj[key] = await processDataRecursively(
                    data[key],
                    baseDownloadFolderAbsPath,
                    baseExportDir,
                    jobId,
                    sendUpdate,
                    downloadCache,
                    seen,
                ); // Pass ALL args down
            }
        }
        processedData = newObj;
    }
    seen.delete(data);
    return processedData;
}

/**
 * Main function, passes all necessary args down.
 * @param {Array<object>} messagesArray
 * @param {string} exportBaseDir
 * @param {string} jobId
 * @param {function} sendUpdate
 * @param {Map<string, string>} downloadCache
 * @returns {Promise<Array<object>>}
 */
async function processMessages(messagesArray, exportBaseDir, jobId, sendUpdate, downloadCache) {
    if (!Array.isArray(messagesArray)) throw new Error('Input must be array.');
    // *** Check baseExportDir ***
    if (!exportBaseDir || typeof exportBaseDir !== 'string') {
        logger.logError(`[${jobId}] Invalid baseExportDir passed to processMessages:`, exportBaseDir);
        throw new Error('processMessages requires a valid exportBaseDir string path.');
    }

    const baseDownloadFolderAbsPath = path.resolve(exportBaseDir, 'downloaded_files');
    try {
        await fs.mkdir(path.join(baseDownloadFolderAbsPath, 'avatars'), { recursive: true });
        await fs.mkdir(path.join(baseDownloadFolderAbsPath, 'emotes'), { recursive: true });
        await fs.mkdir(path.join(baseDownloadFolderAbsPath, 'attachments'), {
            recursive: true,
        }); /* logger.logInfo(`[${jobId}] Ensured download dirs: ${baseDownloadFolderAbsPath}`); */
    } catch (err) {
        logger.logError(`[${jobId}] FATAL: Failed create download dirs ${exportBaseDir}`, err);
        throw err;
    }

    const messagesCopy = JSON.parse(JSON.stringify(messagesArray));
    try {
        // Pass all args down to the recursive processor
        const processedMessages = await processDataRecursively(
            messagesCopy,
            baseDownloadFolderAbsPath,
            exportBaseDir,
            jobId,
            sendUpdate,
            downloadCache,
            new WeakSet(),
        );
        // logger.logInfo(`[${jobId}] Finished processing batch with cache.`); // Reduce log noise
        return processedMessages;
    } catch (processingError) {
        logger.logError(`[${jobId}] Critical error during recursive processing.`, processingError);
        throw processingError;
    }
}

module.exports = {
    processMessages,
};
