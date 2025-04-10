const fs = require('node:fs/promises');
const path = require('node:path');
const nunjucks = require('nunjucks'); // Import nunjucks
const logger = require('../lib/logger');
const { discordMessageToHtmlSingle, EMOTE_MARKER_PREFIX } = require('../lib/htmlRenderer');

// --- Configure Nunjucks ---
// Point to the main views directory, assuming chat_page.njk is in views/export/
const viewsPath = path.resolve(__dirname, '..', 'views');
nunjucks.configure(viewsPath, {
    autoescape: true,
    noCache: true, // Good for development/scripting use
});

// Regex to identify processed message files and extract batch index
const inputFileRegex = /^processed_messages_batch_(\d+)_\d+\.json$/;

// Basic HTML entity encoding (still needed for titles etc. passed to template)
function sanitize(text) {
    if (typeof text !== 'string') return String(text);
    const map = { '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" };
    return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Generates HTML files from processed JSON batches using Nunjucks templates.
 * Copies necessary CSS/JS assets to the output directory.
 *
 * @param {string} processedMessagesDir Absolute path to processed JSON directory.
 * @param {string} htmlOutputDir Absolute path for HTML output.
 * @param {string} _cssFilePath Ignored parameter.
 * @returns {Promise<void>}
 */
async function generateHtmlFiles(processedMessagesDir, htmlOutputDir, _cssFilePath) {
    logger.logInfo(
        `Starting HTML generation using Nunjucks... Input: ${processedMessagesDir}, Output: ${htmlOutputDir}`,
    );

    // Define paths for static assets to be copied
    const staticAssetSourceDir = path.resolve(__dirname, '..', 'public');
    const cssSourcePath = path.join(staticAssetSourceDir, 'css', 'export-style.css');
    const jsSourcePath = path.join(staticAssetSourceDir, 'js', 'export-client.js');
    const cssDestPath = path.join(htmlOutputDir, 'export-style.css');
    const jsDestPath = path.join(htmlOutputDir, 'export-client.js');

    try {
        // Ensure output directory exists
        await fs.mkdir(htmlOutputDir, { recursive: true });
        // Copy static assets needed by the template
        await fs.copyFile(cssSourcePath, cssDestPath);
        await fs.copyFile(jsSourcePath, jsDestPath);
        logger.logInfo(`Copied export CSS and JS to ${htmlOutputDir}`);
    } catch (err) {
        logger.logError(`FATAL: Failed create HTML output dir or copy assets: ${htmlOutputDir}`, err);
        throw err;
    }

    // 1. Read and identify processed JSON files
    let filesToProcess = [];
    try {
        const af = await fs.readdir(processedMessagesDir);
        for (const fn of af) {
            const m = fn.match(inputFileRegex);
            if (m && m[1]) {
                const i = parseInt(m[1], 10);
                if (!isNaN(i)) {
                    filesToProcess.push({ index: i, filename: fn, inputPath: path.join(processedMessagesDir, fn) });
                }
            }
        }
    } catch (e) {
        logger.logError('Failed read input dir', e);
        throw e;
    }
    if (filesToProcess.length === 0) {
        logger.logWarn('No processed JSON files found.');
        return;
    }

    // 2. Sort files by original batch index DESCENDING (N, N-1, ..., 0)
    filesToProcess.sort((a, b) => b.index - a.index);
    const totalPages = filesToProcess.length;
    logger.logInfo(`Found ${totalPages} processed JSON files to convert into HTML pages.`);

    // 3. Loop through sorted files and generate one HTML page per file
    for (let i = 0; i < filesToProcess.length; i++) {
        const fileData = filesToProcess[i];
        const outputPageIndex = i; // Page 0 = oldest batch (highest original index)
        const outputFilename = `processed_html_${outputPageIndex}.html`;
        const outputPath = path.join(htmlOutputDir, outputFilename);
        const htmlTitle = `Chat Export - Page ${outputPageIndex + 1} / ${totalPages}`;

        logger.logInfo(`Generating ${outputFilename} from ${fileData.filename}...`);

        try {
            // Read JSON for this page
            const jsonContent = await fs.readFile(fileData.inputPath, 'utf-8');
            const messages = JSON.parse(jsonContent);
            if (!Array.isArray(messages)) {
                logger.logWarn(`Skipping ${outputFilename}: Not array.`);
                continue;
            }

            // Render messages in REVERSE order within this batch
            let pageHtmlContent = '<div class="chat-log">\n';
            let lastMessageAuthorId = null;
            let lastMessageTimestamp = null;
            const groupingThresholdMs = 7 * 60 * 1000;
            for (let j = messages.length - 1; j >= 0; j--) {
                const currentMsg = messages[j];
                let isGrouped = false;
                // Simplified grouping check based on last rendered message
                if (
                    lastMessageAuthorId === currentMsg.author?.id &&
                    lastMessageTimestamp &&
                    new Date(currentMsg.timestamp).getTime() - lastMessageTimestamp < groupingThresholdMs &&
                    !currentMsg.referenced_message &&
                    (currentMsg.type === 0 || currentMsg.type === 19)
                ) {
                    isGrouped = true;
                }
                pageHtmlContent += discordMessageToHtmlSingle(currentMsg, isGrouped) + '\n'; // Use single renderer
                if (!isGrouped) {
                    lastMessageAuthorId = currentMsg.author?.id;
                    lastMessageTimestamp = new Date(currentMsg.timestamp).getTime();
                }
            }
            pageHtmlContent += '</div>';

            // Prepare data for Nunjucks template
            const templateData = {
                pageTitle: htmlTitle, // Already sanitized title is fine for template var
                pageNumber: outputPageIndex + 1,
                totalPages: totalPages,
                messageCount: messages.length,
                originalBatchIndex: fileData.index,
                chatLogHtml: pageHtmlContent, // Pass the generated HTML block
                emoteMarkerPrefix: EMOTE_MARKER_PREFIX, // Pass prefix for client-side JS
            };

            // Render the Nunjucks template
            const renderedPage = nunjucks.render('export/chat_page.njk', templateData); // Use relative path within views dir

            // Write the rendered HTML to file
            await fs.writeFile(outputPath, renderedPage);
            logger.logInfo(` -> Successfully generated ${outputFilename} using Nunjucks.`);
        } catch (pageError) {
            logger.logError(`Error processing/writing ${outputFilename} from ${fileData.filename}`, pageError);
            // Continue to next file
        }
    } // End loop through files

    logger.logInfo('HTML generation process finished.');
}

// --- Main Execution (for standalone use) ---
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: node scripts/generateHtml.js <processedDir> <outputDir> [cssFile - Ignored]');
        process.exit(1);
    }
    const [pd, od] = args.map((p) => path.resolve(p));
    generateHtmlFiles(pd, od, null)
        .then(() => {
            logger.logInfo('Standalone HTML gen OK.');
            logger.closeLogs();
        })
        .catch((err) => {
            logger.logError('Standalone HTML gen FAIL:', err);
            logger.closeLogs();
            process.exit(1);
        });
}

// Export the main function
module.exports = {
    generateHtmlFiles,
};
