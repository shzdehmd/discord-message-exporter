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
    timeout: 25000,
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
    if (avatarHash.length < 10) return null; // Skip likely default/invalid hashes
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
            await axiosInstance.head(url, { responseType: 'arraybuffer', timeout: 7000 });
            return { url, ext };
        } catch (error) {
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
 * Downloads a file, calculates its MD5 hash, saves it using the hash name if unique,
 * and returns the relative path. Handles deduplication.
 *
 * @param {string} url - URL to download.
 * @param {string} targetDirectory - Absolute path to the directory for the final hashed file (e.g., .../downloaded_files/avatars).
 * @param {string} baseExportDir - Absolute path to the base export dir (e.g., .../Exports/Channel-123) - needed for relative path calculation.
 * @param {string|null} [forcedExtension=null] - Forced extension.
 * @returns {Promise<string>} - Resolves to the relative path (e.g., "downloaded_files/avatars/HASH.ext").
 * @throws {Error} - If download, hashing, or saving fails.
 */
async function downloadAndDeduplicateFile(url, targetDirectory, baseExportDir, forcedExtension = null) {
    // --- 1. Determine Extension ---
    let derivedExtension = '';
    if (forcedExtension) {
        derivedExtension = forcedExtension.startsWith('.') ? forcedExtension : `.${forcedExtension}`;
    } else {
        try {
            const pathname = new URL(url).pathname;
            derivedExtension = path.extname(pathname);
            if (!derivedExtension) {
                derivedExtension = path.extname(url.split('?')[0]);
            }
        } catch (e) {
            logger.logWarn(`URL parse error for extension: ${url}. Falling back.`, e.message);
            derivedExtension = path.extname(url.split('?')[0]);
        }
    }
    const finalExt =
        derivedExtension && derivedExtension.length > 1
            ? derivedExtension
                  .split('?')[0]
                  .toLowerCase()
                  .replace(/[^a-z0-9.]/g, '') // Basic sanitize extension
            : '.unknown';

    // --- 2. Prepare Temporary Download ---
    let tempDir = null; // Define scope outside try
    let tempFilePath = null;
    let writer = null;
    let fileHash = '';

    try {
        // Create a unique temporary directory
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-export-'));
        tempFilePath = path.join(tempDir, `download${finalExt}`);

        // Ensure the final target directory exists
        await fs.mkdir(targetDirectory, { recursive: true });

        // --- 3. Download and Hash Simultaneously ---
        const response = await axiosInstance.get(url, { responseType: 'stream', timeout: 60000 }); // Longer timeout for download+hash
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`HTTP Error ${response.status} ${response.statusText} for ${url}`);
        }

        const hash = crypto.createHash('md5');
        writer = fsSync.createWriteStream(tempFilePath);

        await new Promise((resolve, reject) => {
            response.data
                .on('data', (chunk) => hash.update(chunk)) // Update hash
                .pipe(writer) // Write to temp file
                .on('finish', () => {
                    fileHash = hash.digest('hex');
                    logger.logInfo(`Download complete, hash: ${fileHash} for ${url}`);
                    resolve();
                })
                .on('error', reject); // Propagate stream errors
        });
        // Explicitly close writer here after finish event to ensure file handle is released
        await new Promise((resolve) => writer.close(resolve));
        writer = null; // Indicate writer is closed

        // --- 4. Determine Final Path & Check Existence ---
        const finalFileName = `${fileHash}${finalExt}`;
        const finalAbsolutePath = path.join(targetDirectory, finalFileName);

        // Check if the final file already exists
        try {
            await fs.access(finalAbsolutePath, fs.constants.F_OK);
            // File EXISTS - Deduplication successful
            logger.logInfo(`Deduplicated: File ${finalFileName} already exists.`);
            // No need to move file, temp dir/file will be cleaned up in finally.
        } catch (accessError) {
            // File DOES NOT EXIST - Move the temp file to the final location
            logger.logInfo(`Saving new file: ${finalFileName}`);
            await fs.rename(tempFilePath, finalAbsolutePath);
            // Temp file is now moved, prevent cleanup code from trying to delete it later from temp path
            tempFilePath = null;
        }

        // --- 5. Calculate and Return Relative Path ---
        // Path relative to the main export directory (e.g., "downloaded_files/avatars/hash.png")
        const relativePath = path
            .relative(baseExportDir, finalAbsolutePath)
            .split(path.sep) // Use forward slashes
            .join('/');
        return relativePath;
    } catch (error) {
        // --- Error Handling ---
        logger.logError(`Download/Hash/Save failed for ${url}`, error);

        // Re-throw standardized error
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
        // Ensure writer stream is destroyed if it exists and wasn't closed properly
        if (writer && !writer.destroyed) {
            writer.destroy();
        }
        // Remove the temporary directory and its contents (including the temp file if it wasn't moved)
        if (tempDir) {
            try {
                await fs.rm(tempDir, { recursive: true, force: true });
            } catch (cleanupError) {
                logger.logWarn(`Failed to cleanup temp directory ${tempDir}`, cleanupError);
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
 * Downloads a user's avatar if present and valid. Modifies the user object directly.
 * Uses downloadAndDeduplicateFile.
 * @param {object} userObj - User object (modified in place).
 * @param {string} baseDownloadFolderAbsPath - Absolute path to base download folder (.../downloaded_files).
 * @param {string} baseExportDir - Absolute path to the root export directory (.../Exports/Channel-ID-...).
 */
async function processUserAvatar(userObj, baseDownloadFolderAbsPath, baseExportDir) {
    if (!isUserObject(userObj)) return;

    const userId = userObj.id;
    const avatarHash = userObj.avatar;
    const avatarInfo = constructAvatarCdnUrl(userId, avatarHash);

    if (avatarInfo) {
        const avatarDownloadFolder = path.join(baseDownloadFolderAbsPath, 'avatars');
        try {
            // Use the deduplicating download function
            const localAvatarRelativePath = await downloadAndDeduplicateFile(
                avatarInfo.url,
                avatarDownloadFolder,
                baseExportDir, // Pass base export dir for relative path calculation
                avatarInfo.ext,
            );
            userObj.avatar = localAvatarRelativePath; // Store relative path
            // logger.logInfo(`Processed avatar for user ${userId} to ${localAvatarRelativePath}`); // download func logs success
        } catch (error) {
            logger.logWarn(
                `Avatar processing failed for user ${userId}. Setting avatar to null. Error: ${error.message}`,
            );
            userObj.avatar = null;
        }
    } else {
        userObj.avatar = null;
    }
}

/**
 * Processes Discord emote markdown, downloading and deduplicating the emote image.
 * Replaces markdown with EMOTE_MARKER:local_path|alt_text format on success.
 * @param {string} fullMatch - Original markdown tag.
 * @param {string} _animatedMarker - 'a' or ''.
 * @param {string} emoteName - Emote name.
 * @param {string} emoteId - Emote ID.
 * @param {string} baseDownloadFolderAbsPath - Absolute path to base download folder (.../downloaded_files).
 * @param {string} baseExportDir - Absolute path to the root export directory (.../Exports/Channel-ID-...).
 * @returns {Promise<string>} - Marker string or original markdown.
 */
async function processSingleEmote(
    fullMatch,
    _animatedMarker,
    emoteName,
    emoteId,
    baseDownloadFolderAbsPath,
    baseExportDir,
) {
    const emoteInfo = await findEmoteUrl(emoteId);

    if (emoteInfo) {
        const emoteDownloadFolder = path.join(baseDownloadFolderAbsPath, 'emotes');
        try {
            // Use the deduplicating download function
            const localEmoteRelativePath = await downloadAndDeduplicateFile(
                emoteInfo.url,
                emoteDownloadFolder,
                baseExportDir, // Pass base export dir
                emoteInfo.ext,
            );

            const safeAlt = emoteName.replace(/\|/g, '').replace(/\s+/g, ' ').trim();
            const marker = `${EMOTE_MARKER_PREFIX}${localEmoteRelativePath}|${safeAlt}`;
            // logger.logInfo(`Processed emote ${emoteName}(${emoteId}) to marker`); // download func logs success
            return marker;
        } catch (error) {
            logger.logWarn(
                `Emote processing failed for ${emoteName}(${emoteId}). Keeping markdown. Error: ${error.message}`,
            );
            return fullMatch;
        }
    } else {
        logger.logWarn(`No CDN URL found for emote ${emoteName}(${emoteId}). Keeping markdown.`);
        return fullMatch;
    }
}

/**
 * Recursively traverses data, processing strings, avatars, and emotes.
 * Uses downloadAndDeduplicateFile for all downloads.
 * @param {*} data - Data structure to process.
 * @param {string} baseDownloadFolderAbsPath - Absolute path to base download folder (.../downloaded_files).
 * @param {string} baseExportDir - Absolute path to the root export directory (.../Exports/Channel-ID-...).
 * @param {WeakSet<object>} [seen=new WeakSet()] - For cycle detection.
 * @returns {Promise<*>} - Processed data structure.
 */
async function processDataRecursively(data, baseDownloadFolderAbsPath, baseExportDir, seen = new WeakSet()) {
    // --- Primitives and Null ---
    if (data === null || typeof data !== 'object') {
        // --- String Processing ---
        if (typeof data === 'string') {
            let currentString = data;
            const gifDomains = /https?:\/\/(?:media\.tenor\.com|.*\.giphy\.com|gfycat\.com)/i;

            if (!gifDomains.test(currentString)) {
                // --- Attachment/URL Processing ---
                const fileUrlMatches = Array.from(currentString.matchAll(fileUrlRegex));
                if (fileUrlMatches.length > 0) {
                    // Process potential file URLs sequentially within a string to simplify replacement
                    for (const match of fileUrlMatches) {
                        const originalUrl = match[0];
                        try {
                            const attachmentsFolder = path.join(baseDownloadFolderAbsPath, 'attachments');
                            // Use the deduplicating download function
                            const localPath = await downloadAndDeduplicateFile(
                                originalUrl,
                                attachmentsFolder,
                                baseExportDir, // Pass base export dir
                            );
                            // Replace only the first occurrence in case of multiple identical links
                            // Use replaceAll carefully if needed, ensuring already processed paths aren't re-matched
                            currentString = currentString.replace(originalUrl, localPath);
                        } catch (e) {
                            logger.logWarn(
                                `Keeping original URL ${originalUrl} (download failed in string): ${e.message}`,
                            );
                        }
                    }
                }
            }

            // --- Emote Processing ---
            if (currentString.includes('<') && currentString.includes(':') && currentString.includes('>')) {
                const emoteMatches = Array.from(currentString.matchAll(emoteRegex));
                if (emoteMatches.length > 0) {
                    // Process emotes sequentially within a string too
                    for (const match of emoteMatches) {
                        const originalMarkdown = match[0];
                        const replacement = await processSingleEmote(
                            originalMarkdown,
                            match[1], // animated marker
                            match[2], // name
                            match[3], // id
                            baseDownloadFolderAbsPath,
                            baseExportDir, // Pass base export dir
                        );
                        if (originalMarkdown !== replacement) {
                            currentString = currentString.replace(originalMarkdown, replacement);
                        }
                    }
                }
            }
            return currentString; // Return the potentially modified string
        } else {
            return data; // Other primitives
        }
    }

    // --- Cycle Detection ---
    if (seen.has(data)) return '[Circular Reference]';
    seen.add(data);

    // --- Object / Array Processing ---
    let processedData;
    if (Array.isArray(data)) {
        // Process array items (could be parallel with Promise.all or sequential)
        processedData = [];
        for (const item of data) {
            processedData.push(await processDataRecursively(item, baseDownloadFolderAbsPath, baseExportDir, seen));
        }
        // Or parallel:
        // processedData = await Promise.all(
        //     data.map(item => processDataRecursively(item, baseDownloadFolderAbsPath, baseExportDir, seen))
        // );
    } else {
        // Object
        // --- Special Handling for User Objects (Avatars) ---
        // Pass baseExportDir here as well
        await processUserAvatar(data, baseDownloadFolderAbsPath, baseExportDir); // Modifies 'data' in place

        // --- Recursively process object properties ---
        const newObj = {};
        for (const key of Object.keys(data)) {
            // Ensure the current key's value isn't the modified avatar we just potentially processed if it's primitive
            if (key === 'avatar' && typeof data[key] === 'string') {
                newObj[key] = data[key]; // Keep the already processed path
            } else {
                newObj[key] = await processDataRecursively(data[key], baseDownloadFolderAbsPath, baseExportDir, seen);
            }
        }
        processedData = newObj;
    }

    seen.delete(data);
    return processedData;
}

/**
 * Main function to process an array of message objects using MD5 deduplication for downloads.
 *
 * @param {Array<object>} messagesArray - Array of raw message objects.
 * @param {string} exportBaseDir - Absolute path to the root directory for THIS export run.
 * @returns {Promise<Array<object>>} - New array with processed message objects.
 * @throws {Error} - If base directories cannot be created or processing fails critically.
 */
async function processMessages(messagesArray, exportBaseDir) {
    if (!Array.isArray(messagesArray)) throw new Error('Input must be an array.');
    if (!exportBaseDir || typeof exportBaseDir !== 'string')
        throw new Error('exportBaseDir must be a valid string path.');

    // Base directory for all downloads within this specific export
    const baseDownloadFolderAbsPath = path.resolve(exportBaseDir, 'downloaded_files');

    try {
        // Ensure download subdirectories exist (download func also ensures specific target dir)
        await fs.mkdir(path.join(baseDownloadFolderAbsPath, 'avatars'), { recursive: true });
        await fs.mkdir(path.join(baseDownloadFolderAbsPath, 'emotes'), { recursive: true });
        await fs.mkdir(path.join(baseDownloadFolderAbsPath, 'attachments'), { recursive: true });
        logger.logInfo(`Ensured base download directories exist under: ${baseDownloadFolderAbsPath}`);
    } catch (err) {
        logger.logError(`FATAL: Failed to create base download directories in ${exportBaseDir}`, err);
        throw new Error(`Cannot create required download directories: ${err.message}`);
    }

    // Deep copy the messages array to avoid modifying the original raw data
    const messagesCopy = JSON.parse(JSON.stringify(messagesArray));

    try {
        // Start recursive processing, passing the necessary base paths
        const processedMessages = await processDataRecursively(
            messagesCopy,
            baseDownloadFolderAbsPath,
            exportBaseDir,
            new WeakSet(),
        );
        logger.logInfo('Finished processing messages batch with deduplication.');
        return processedMessages;
    } catch (processingError) {
        logger.logError('Critical error during recursive message processing.', processingError);
        throw processingError;
    }
}

module.exports = {
    processMessages,
};
