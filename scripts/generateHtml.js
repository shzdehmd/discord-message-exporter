// scripts/generateHtml.js

const fs = require('node:fs/promises');
const path = require('node:path');
// Assuming logger, htmlRenderer are in ../lib relative to this script
const logger = require('../lib/logger');
const { discordMessagesToHtml, EMOTE_MARKER_PREFIX } = require('../lib/htmlRenderer'); // Import marker too

// --- Configuration ---
// Input/Output directories will eventually be passed dynamically or determined contextually
// For now, we can use placeholders or make them arguments. Let's make them arguments.

// Regex to identify processed message files and extract batch index
const inputFileRegex = /^processed_messages_batch_(\d+)_\d+\.json$/;

/**
 * Reads CSS content from a file.
 * @param {string} cssPath - Absolute path to the CSS file.
 * @returns {Promise<string>} - CSS content or fallback styles on error.
 */
async function readCssFile(cssPath) {
    try {
        const cssContent = await fs.readFile(cssPath, 'utf-8');
        logger.logInfo(`Successfully read CSS file from: ${cssPath}`);
        return cssContent;
    } catch (err) {
        logger.logWarn(
            `Warning: Could not read CSS file at ${cssPath}. HTML files will use basic fallback styles.`,
            err.message,
        );
        return `/* CSS file not found or unreadable */\nbody { background-color: #313338; color: #dbdee1; font-family: sans-serif; margin: 0; padding: 1em; }\n.chat-log { background-color: #313338; } /* Basic Discord-like background */`;
    }
}

/**
 * Generates the client-side JavaScript for handling emote markers.
 * @returns {string} - The script content.
 */
function generateFrontendScript() {
    // IMPORTANT: EMOTE_MARKER_PREFIX must be correctly escaped for use in a RegExp string literal
    const escapedPrefix = EMOTE_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Regex finds: PREFIX capture(relativePath)|capture(altText)
    // Allows paths with forward slashes, letters, numbers, underscores, hyphens, dots.
    // Allows alt text that doesn't contain '|'.
    const markerRegex = new RegExp(`${escapedPrefix}([\\w\\/.-]+)\\|([^|]+)`, 'g');

    // This script will run in the browser on the generated HTML page
    return `
// Front-end script to replace emote markers with img tags
document.addEventListener('DOMContentLoaded', () => {
    const markerRegex = /${markerRegex.source}/g; // Use the source of the server-generated regex
    const allElements = document.querySelectorAll('.message-text, .embed-description, .embed-field-value'); // Target specific elements for safety

    allElements.forEach(element => {
        if (!element.innerHTML) return; // Skip empty elements

        element.innerHTML = element.innerHTML.replace(
            markerRegex,
            (_match, relativePath, altText) => {
                // Basic path safety check (redundant but good practice)
                if (!relativePath || relativePath.includes('..') || relativePath.startsWith('/')) {
                     console.warn('Skipping potentially unsafe emote path:', relativePath);
                     return \`[Invalid Emote Path: \${altText}]\`; // Render placeholder instead of original marker
                }

                // Paths are relative to the HTML file, e.g., "downloaded_files/emotes/HASH.ext"
                // We assume the 'downloaded_files' directory is correctly placed relative to the HTML.
                const safePath = encodeURI(relativePath); // Encode for URL context
                // Sanitize alt text for attribute safety (double quotes, <, >)
                const safeAlt = altText.replace(/"/g, '"').replace(/</g, '<').replace(/>/g, '>');

                // Return the img tag - Use classes for styling, avoid inline styles where possible
                // Style via style.css for .discord-emote class
                return \`<img src="\${safePath}" alt="\${safeAlt}" class="discord-emote" loading="lazy">\`;
            }
        );
    });

    // --- Additional Frontend Enhancements ---

    // 1. Fix Default Avatar URLs (remove potential '-' sign if needed - should be fixed in getAvatarUrl now)
    //    Keeping this temporarily as a safeguard or if default avatar logic changes.
    document.querySelectorAll('img.message-avatar[src*="cdn.discordapp.com/embed/avatars/"]').forEach(img => {
        if (img.src.includes('/avatars/-')) {
            console.log('Correcting legacy default avatar URL:', img.src);
            img.src = img.src.replace('/avatars/-', '/avatars/');
        }
    });

    // 2. Next/Previous Buttons (Requires knowing total number of pages)
    const pageMatch = window.location.pathname.match(/processed_html_(\\d+)\\.html$/);
    const currentPageIndex = pageMatch ? parseInt(pageMatch[1], 10) : -1;
    // We need the total number of pages to know if "Next" is possible.
    // This needs to be passed from the generation script (e.g., via a data attribute or another script tag).
    const totalPages = parseInt(document.body.dataset.totalPages || '0', 10); // Example: Read from data-total-pages attribute on body

    if (currentPageIndex !== -1 && totalPages > 0) {
        const createButton = (text, targetIndex, id, position) => {
            if (targetIndex < 0 || targetIndex >= totalPages) return; // Bounds check

            const btn = document.createElement('a');
            btn.textContent = text;
            btn.href = \`processed_html_\${targetIndex}.html\`; // Relative link
            btn.id = id;
            btn.classList.add('nav-button');
            btn.style.position = 'fixed';
            btn.style.right = '20px';
            btn.style[position] = '20px'; // 'bottom' or 'top'
            // Add other styles via CSS class .nav-button if preferred
            document.body.appendChild(btn);
        };

        createButton('⬅️ Previous', currentPageIndex - 1, 'prev-page-btn', 'bottom');
        createButton('Next ➡️', currentPageIndex + 1, 'next-page-btn', 'top'); // Example: place Next at top right
    }

    // 3. Styling Adjustments (e.g., video autoplay, cleaning borders) - Better done via CSS if possible
    // Example: Auto-play videos (muted is required by most browsers for autoplay)
    document.querySelectorAll('video.attachment-video, video.embed-video').forEach(video => {
        video.muted = true;
        video.autoplay = true;
        video.loop = true;
        video.setAttribute('playsinline', ''); // Important for mobile
        video.play().catch(e => console.warn('Video autoplay failed:', e.message));
         // Optional: remove controls if desired via JS or CSS
         // video.controls = false;
    });

});
    `;
}

/**
 * Generates HTML files from processed JSON message batches.
 *
 * @param {string} processedMessagesDir - Absolute path to the directory containing processed JSON files.
 * @param {string} htmlOutputDir - Absolute path to the directory where HTML files should be saved.
 * @param {string} cssFilePath - Absolute path to the CSS file to embed.
 * @returns {Promise<void>}
 */
async function generateHtmlFiles(processedMessagesDir, htmlOutputDir, cssFilePath) {
    logger.logInfo(`Starting HTML generation...`);
    logger.logInfo(`Input directory: ${processedMessagesDir}`);
    logger.logInfo(`Output directory: ${htmlOutputDir}`);
    logger.logInfo(`CSS file: ${cssFilePath}`);

    // 1. Read CSS content
    const cssContent = await readCssFile(cssFilePath);

    // 2. Ensure output directory exists
    try {
        await fs.mkdir(htmlOutputDir, { recursive: true });
        logger.logInfo(`Ensured HTML output directory exists: ${htmlOutputDir}`);
    } catch (err) {
        logger.logError(`FATAL: Failed to create HTML output directory: ${htmlOutputDir}`, err);
        throw new Error(`Cannot create HTML output directory: ${err.message}`);
    }

    // 3. Read and identify processed JSON files
    let filesToProcess = [];
    try {
        const allFiles = await fs.readdir(processedMessagesDir);
        for (const filename of allFiles) {
            const match = filename.match(inputFileRegex);
            if (match && match[1]) {
                const index = parseInt(match[1], 10);
                if (!isNaN(index)) {
                    filesToProcess.push({
                        index: index, // Original batch index (0 = newest batch from API)
                        filename: filename,
                        inputPath: path.join(processedMessagesDir, filename),
                    });
                } else {
                    logger.logWarn(`Skipping file with non-numeric index: ${filename}`);
                }
            } else {
                logger.logWarn(`Skipping file that doesn't match pattern: ${filename}`);
            }
        }
    } catch (err) {
        logger.logError(`Failed to read input directory: ${processedMessagesDir}`, err);
        throw new Error(`Cannot read processed messages directory: ${err.message}`);
    }

    if (filesToProcess.length === 0) {
        logger.logWarn('No processed message JSON files found matching the pattern in', processedMessagesDir);
        return; // Nothing to do
    }

    // 4. Sort files by original batch index (ASCENDING - 0, 1, 2...)
    // This means index 0 contains the *latest* messages fetched from Discord.
    filesToProcess.sort((a, b) => a.index - b.index);
    logger.logInfo(`Found ${filesToProcess.length} processed JSON files to convert.`);

    // 5. Read all message data and combine in chronological order (oldest first)
    let allMessages = [];
    for (const fileData of filesToProcess) {
        try {
            const jsonContent = await fs.readFile(fileData.inputPath, 'utf-8');
            const messages = JSON.parse(jsonContent);
            if (Array.isArray(messages)) {
                // Add messages from this batch to the *beginning* of the array,
                // because batch 0 is newest, batch 1 is older, etc.
                // We want the final array sorted oldest -> newest.
                allMessages.unshift(...messages);
            } else {
                logger.logWarn(`Skipping file ${fileData.filename}: Content is not a JSON array.`);
            }
        } catch (readErr) {
            logger.logError(`Error reading or parsing file ${fileData.filename}`, readErr);
            // Decide whether to skip this file or stop the process
        }
    }

    logger.logInfo(`Total messages loaded for HTML generation: ${allMessages.length}`);
    if (allMessages.length === 0) {
        logger.logWarn('No valid messages found in input files. HTML generation stopped.');
        return;
    }

    // --- Here you could split allMessages into multiple HTML pages if needed ---
    // For now, generate a single HTML file containing all messages.
    // If splitting: determine messagesPerPage, calculate totalPages, loop through pages.

    const totalPages = 1; // Hardcoded for single-page output for now
    const htmlContent = discordMessagesToHtml(allMessages); // Generate HTML for ALL messages

    // 6. Generate Frontend Script (including dynamic data like totalPages)
    const frontendScript = generateFrontendScript(); // Contains logic for emotes, nav buttons etc.

    // 7. Create Full HTML Document
    const outputPageIndex = 0; // For single-page output
    const outputFilename = `processed_html_${outputPageIndex}.html`;
    const outputPath = path.join(htmlOutputDir, outputFilename);
    const htmlTitle = `Chat Export - Page ${outputPageIndex + 1}`; // Adjust if splitting later

    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${sanitize(htmlTitle)}</title>
    <style>
        /* Embed CSS */
        ${cssContent}

        /* --- Additional Base Styles --- */
        /* Ensure visibility of grouped message timestamps if needed */
        /* .message-container.grouped .message-timestamp { display: inline-block; margin-left: 0.5em; font-size: 0.8em; color: #aaa; } */

        /* Emote styling */
        img.discord-emote {
            width: 1.375rem; /* Standard emote size */
            height: 1.375rem;
            vertical-align: bottom; /* Align with text bottom */
            margin: 0 1px;
            object-fit: contain; /* Prevent distortion */
        }
        /* Styles for spoiler attachments */
        .attachment.spoiler { position: relative; cursor: pointer; border-radius: 3px; overflow: hidden; }
        .attachment.spoiler:not(.revealed) > *:not(.spoiler-text) { filter: blur(5px); pointer-events: none; }
        .attachment.spoiler.revealed > *:not(.spoiler-text) { filter: none; }
        .attachment.spoiler .spoiler-text { display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background-color: rgba(0,0,0,0.75); color: white; padding: 4px 8px; border-radius: 5px; font-size: 0.9em; pointer-events: none; text-align: center; user-select: none; }
        .attachment.spoiler:not(.revealed) .spoiler-text { display: inline-block; }

         /* Basic styling for Nav buttons */
         .nav-button {
             padding: 8px 15px; background-color: #007bff; color: white;
             border-radius: 5px; text-decoration: none; font-size: 14px;
             z-index: 1000; box-shadow: 0 2px 5px rgba(0,0,0,0.2);
             opacity: 0.8; transition: opacity 0.2s;
         }
         .nav-button:hover { opacity: 1; }
         #prev-page-btn { bottom: 20px; }
         #next-page-btn { top: 20px; } /* Example positioning */

         /* Styling adjustments from user scripts - better done here */
         .attachment, .embed { border: none; background: none; padding: 0; margin-bottom: 4px; } /* Clean borders/bg */
         /* Adjust message content font size if desired */
         /* .message-text { font-size: 16px; } */ /* Example: Adjust size */
         video { max-width: 100%; height: auto; } /* Responsive videos */

    </style>
</head>
<body data-total-pages="${totalPages}"> {/* Add total pages for JS nav */}
    <h1>Chat Export</h1>
    <p>Total Messages: ${allMessages.length}</p>

    ${htmlContent}

    <script>
        // Embed Frontend Script
        ${frontendScript}
    </script>
</body>
</html>`;

    // 8. Write HTML file
    try {
        await fs.writeFile(outputPath, fullHtml);
        logger.logInfo(`Successfully generated HTML file: ${outputPath}`);
    } catch (writeErr) {
        logger.logError(`Failed to write HTML file: ${outputPath}`, writeErr);
        // Decide if this is fatal or if we can continue (if processing multiple pages)
        throw new Error(`Failed to write HTML file: ${writeErr.message}`);
    }

    logger.logInfo('HTML generation process finished.');
}

// --- Main Execution (Example: if run directly) ---
// This part allows running the script standalone, e.g., `node scripts/generateHtml.js <inputDir> <outputDir> <cssPath>`
// In the web app, we will call the `generateHtmlFiles` function directly.
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 3) {
        console.error('Usage: node scripts/generateHtml.js <processedMessagesDir> <htmlOutputDir> <cssFilePath>');
        process.exit(1);
    }

    const [processedDir, outputDir, cssFile] = args.map((p) => path.resolve(p)); // Resolve to absolute paths

    generateHtmlFiles(processedDir, outputDir, cssFile)
        .then(() => {
            logger.logInfo('Standalone HTML generation completed successfully.');
            logger.closeLogs(); // Close logs when run standalone
        })
        .catch((err) => {
            logger.logError('Standalone HTML generation failed:', err);
            logger.closeLogs(); // Close logs on error too
            process.exit(1);
        });
}

// Export the main function for use in the server
module.exports = {
    generateHtmlFiles,
};
