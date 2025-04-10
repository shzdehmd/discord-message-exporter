// Load environment variables FIRST
require('dotenv').config();

const express = require('express');
const nunjucks = require('nunjucks');
const path = require('node:path');
const fs = require('node:fs/promises'); // Need fs promises
const logger = require('./lib/logger'); // Import our custom logger
const { fetchGuilds, fetchChannels, fetchThreads, makeDiscordRequest } = require('./lib/discordApi'); // Import API functions, including makeDiscordRequest if needed directly
const { fetchMessagesBatch } = require('./lib/messageFetcher'); // Import message fetcher
const { processMessages } = require('./lib/fileProcessor'); // Import file processor
const { generateHtmlFiles } = require('./scripts/generateHtml.js'); // Import HTML generator

const app = express();
const port = process.env.PORT || 3000;

// --- Helper function for delays ---
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Nunjucks Setup ---
const nunjucksEnv = nunjucks.configure('views', {
    autoescape: true,
    express: app,
    watch: true, // Auto-reload templates during development
});
// REMOVED the custom 'find' filter as logic is moved to the route
app.set('view engine', 'njk');

// --- Middleware ---
// Serve static files (CSS, client-side JS) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
// Parse URL-encoded bodies (as sent by HTML forms)
app.use(express.urlencoded({ extended: true }));
// Parse JSON bodies (for potential future API use)
app.use(express.json());

// Custom middleware for logging requests
app.use((req, res, next) => {
    logger.logInfo(`Request received: ${req.method} ${req.originalUrl}`);
    // Log form body for POST requests (mask token)
    if (req.method === 'POST' && req.body) {
        const bodyToLog = { ...req.body };
        if (bodyToLog.token) {
            bodyToLog.token = '********'; // Mask token
        }
        logger.logInfo(`Request Body: ${JSON.stringify(bodyToLog)}`);
    }
    next();
});

// --- Base directory for all exports ---
const EXPORTS_BASE_DIR = path.resolve(__dirname, 'Exports');

// --- Background Export Function ---
/**
 * Runs the entire export process for a given channel.
 * Intended to be run asynchronously (fire-and-forget from the route handler).
 * @param {string} token Discord token
 * @param {string} channelId Channel/Thread ID to export
 * @param {string} guildId Guild ID (for context)
 * @param {string} channelName Channel Name (for folder naming)
 */
async function runExportProcess(token, channelId, guildId, channelName) {
    const startTime = Date.now();
    // Sanitize channel name for directory creation
    const safeChannelName = channelName ? channelName.replace(/[^a-zA-Z0-9_-]/g, '_') : 'UnknownChannel';
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, ''); // Simple timestamp YYYY-MM-DDTHH-MM-SS
    const exportFolderName = `${safeChannelName}_${channelId}_${timestamp}`;
    const exportDir = path.join(EXPORTS_BASE_DIR, exportFolderName);

    // Define subdirectories
    const rawDir = path.join(exportDir, 'messages');
    const processedDir = path.join(exportDir, 'processed_messages');
    const htmlDir = path.join(exportDir, 'processed_html');
    const downloadsDir = path.join(exportDir, 'downloaded_files'); // Initially created by fileProcessor
    const finalDownloadsDir = path.join(htmlDir, 'downloaded_files'); // Where downloads need to end up

    const jobId = `Export-${channelId}-${startTime}`; // Unique ID for logging this job
    logger.logInfo(`[${jobId}] Starting export process for channel: ${channelName} (${channelId})`);
    logger.logInfo(`[${jobId}] Export directory: ${exportDir}`);

    try {
        // 1. Create Export Directories
        await fs.mkdir(rawDir, { recursive: true });
        await fs.mkdir(processedDir, { recursive: true });
        await fs.mkdir(htmlDir, { recursive: true }); // Create HTML dir upfront
        logger.logInfo(`[${jobId}] Created export subdirectories.`);

        // 2. Fetch Messages Loop
        let beforeId = null;
        let batchIndex = 0;
        const limitPerBatch = 100; // Fetch max per request
        const FETCH_DELAY_MS = 1000; // Delay between fetches (adjust as needed)
        const MAX_BATCHES = 5; // Set to a number to limit total batches for testing, null for no limit

        logger.logInfo(`[${jobId}] Starting message fetch loop...`);

        while (true) {
            if (MAX_BATCHES !== null && batchIndex >= MAX_BATCHES) {
                logger.logWarn(`[${jobId}] Reached MAX_BATCHES limit (${MAX_BATCHES}). Stopping fetch.`);
                break;
            }

            logger.logInfo(`[${jobId}] Fetching batch ${batchIndex}, before ID: ${beforeId || 'None'}`);
            let messages = [];
            try {
                messages = await fetchMessagesBatch(token, channelId, limitPerBatch, { before: beforeId });
            } catch (fetchError) {
                logger.logError(
                    `[${jobId}] Error fetching message batch ${batchIndex}. Status: ${fetchError.status}`,
                    fetchError,
                );
                // Implement retry logic or fail the export? For now, let's retry once after a delay.
                logger.logWarn(`[${jobId}] Waiting 5 seconds before retrying batch ${batchIndex}...`);
                await sleep(5000);
                try {
                    messages = await fetchMessagesBatch(token, channelId, limitPerBatch, { before: beforeId });
                } catch (retryError) {
                    logger.logError(
                        `[${jobId}] Retry failed for batch ${batchIndex}. Aborting export. Status: ${retryError.status}`,
                        retryError,
                    );
                    await fs.writeFile(
                        path.join(exportDir, 'EXPORT_FAILED.txt'),
                        `Failed during fetch batch ${batchIndex}: ${retryError.message}`,
                    );
                    return; // Stop the export
                }
            }

            const count = messages.length;
            logger.logInfo(`[${jobId}] Fetched ${count} messages in batch ${batchIndex}.`);

            if (count === 0) {
                logger.logInfo(`[${jobId}] No more messages found. Fetch loop complete.`);
                break; // Exit loop
            }

            // Save Raw Batch
            const rawFilePath = path.join(rawDir, `messages_batch_${batchIndex}_${count}.json`);
            try {
                await fs.writeFile(rawFilePath, JSON.stringify(messages, null, 2));
                // logger.logInfo(`[${jobId}] Saved raw batch ${batchIndex} to ${rawFilePath}`); // Reduce log verbosity
            } catch (writeError) {
                logger.logError(`[${jobId}] Failed to write raw batch ${batchIndex}`, writeError);
            }

            // Process Batch (Downloads etc.)
            logger.logInfo(`[${jobId}] Processing batch ${batchIndex} (Downloads/Markers)...`);
            let processedMessages = [];
            try {
                processedMessages = await processMessages(messages, exportDir);
            } catch (processError) {
                logger.logError(`[${jobId}] Error processing batch ${batchIndex}. Aborting export.`, processError);
                await fs.writeFile(
                    path.join(exportDir, 'EXPORT_FAILED.txt'),
                    `Failed during processing batch ${batchIndex}: ${processError.message}`,
                );
                return; // Stop export
            }

            // Save Processed Batch
            const processedFilePath = path.join(processedDir, `processed_messages_batch_${batchIndex}_${count}.json`);
            try {
                await fs.writeFile(processedFilePath, JSON.stringify(processedMessages, null, 2));
                // logger.logInfo(`[${jobId}] Saved processed batch ${batchIndex} to ${processedFilePath}`); // Reduce log verbosity
            } catch (writeError) {
                logger.logError(`[${jobId}] Failed to write processed batch ${batchIndex}`, writeError);
            }

            // Prepare for next iteration
            beforeId = messages[count - 1].id; // Oldest message ID in this batch
            batchIndex++;

            logger.logInfo(`[${jobId}] Batch ${batchIndex - 1} complete. Waiting ${FETCH_DELAY_MS}ms...`);
            await sleep(FETCH_DELAY_MS); // Wait before next fetch
        }

        logger.logInfo(`[${jobId}] Finished fetching all message batches. Total batches: ${batchIndex}.`);

        // 3. Generate HTML
        logger.logInfo(`[${jobId}] Starting HTML generation...`);
        const cssPath = path.resolve(__dirname, 'public', 'css', 'style.css'); // Path to main CSS
        try {
            // generateHtmlFiles reads from processedDir, writes to htmlDir
            await generateHtmlFiles(processedDir, htmlDir, cssPath);
            logger.logInfo(`[${jobId}] HTML generation complete.`);
        } catch (htmlError) {
            logger.logError(`[${jobId}] HTML generation failed. Aborting.`, htmlError);
            await fs.writeFile(
                path.join(exportDir, 'EXPORT_FAILED.txt'),
                `HTML generation failed: ${htmlError.message}`,
            );
            return; // Stop export
        }

        // 4. Move downloaded_files into html directory
        logger.logInfo(`[${jobId}] Moving downloaded files to HTML directory...`);
        try {
            // Check if downloadsDir actually exists
            try {
                await fs.access(downloadsDir); // Check if source exists
                await fs.rename(downloadsDir, finalDownloadsDir); // Move the directory
                logger.logInfo(`[${jobId}] Moved ${downloadsDir} to ${finalDownloadsDir}`);
            } catch (accessError) {
                // If access fails, directory likely doesn't exist (ENOENT)
                logger.logInfo(
                    `[${jobId}] No 'downloaded_files' directory found at ${downloadsDir} to move (perhaps no files needed downloading). Skipping move.`,
                );
            }
        } catch (moveError) {
            logger.logError(
                `[${jobId}] Failed to move downloaded_files directory from ${downloadsDir}. HTML files might have broken links.`,
                moveError,
            );
            await fs.writeFile(
                path.join(exportDir, 'EXPORT_WARNING_MOVE_FAILED.txt'),
                `Failed to move downloaded_files: ${moveError.message}`,
            );
        }

        // 5. Mark Export as Complete
        const endTime = Date.now();
        const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
        const summary = `Export completed successfully at ${new Date().toISOString()}.\nDuration: ${durationSeconds} seconds.\nTotal batches fetched: ${batchIndex}.`;
        await fs.writeFile(path.join(exportDir, 'EXPORT_SUCCESS.txt'), summary);
        logger.logInfo(`[${jobId}] ${summary}`);
    } catch (error) {
        // Catch any unexpected errors during the overall process
        logger.logError(`[${jobId}] UNEXPECTED ERROR during export for channel ${channelId}.`, error);
        try {
            // Ensure exportDir exists before trying to write failure file
            await fs.mkdir(exportDir, { recursive: true }).catch(() => {}); // Ignore error if exists
            await fs.writeFile(
                path.join(exportDir, 'EXPORT_FAILED.txt'),
                `Unexpected error: ${error.message}\n${error.stack}`,
            );
        } catch (writeErr) {
            logger.logError(`[${jobId}] Additionally failed to write final failure notice.`, writeErr);
        }
    }
}

// --- Routes ---

// GET / - Renders the initial page
app.get('/', (req, res) => {
    res.render('index', {
        pageTitle: 'Discord Exporter - Enter Token',
        token: req.query.token || '',
        guilds: null,
        selectedGuildId: null,
        selectedGuild: null,
        channels: null,
        selectedChannelId: null,
        error: req.query.error || null,
    });
});

// POST /fetch-guilds - Fetches guilds for the token
app.post('/fetch-guilds', async (req, res) => {
    const token = req.body.token?.trim();
    if (!token) {
        return res.redirect('/?error=' + encodeURIComponent('Token is required.'));
    }
    logger.logInfo('Received token, attempting to fetch guilds.');
    try {
        const guilds = await fetchGuilds(token);
        logger.logInfo(`Successfully fetched ${guilds.length} guilds.`);
        res.render('index', {
            pageTitle: 'Discord Exporter - Select Server',
            token: token,
            guilds: guilds.sort((a, b) => a.name.localeCompare(b.name)),
            selectedGuildId: null,
            selectedGuild: null,
            channels: null,
            selectedChannelId: null,
            error: null,
        });
    } catch (error) {
        logger.logError('Failed to fetch guilds', error);
        let errorMessage = 'Failed to fetch servers. Check logs.';
        if (error.status === 401) errorMessage = 'Invalid Discord Token provided.';
        else if (error.message.includes('Network') || error.message.includes('timeout'))
            errorMessage = 'Network error or timeout connecting to Discord API.';
        res.redirect(`/?error=${encodeURIComponent(errorMessage)}&token=${encodeURIComponent(token)}`);
    }
});

// POST /fetch-channels - Fetches channels and threads for the selected guild (Sequential Thread Fetch)
app.post('/fetch-channels', async (req, res) => {
    const token = req.body.token?.trim();
    const guildId = req.body.guildId?.trim();
    if (!token || !guildId) {
        logger.logWarn('Attempted to fetch channels without token or guildId.');
        const queryParams = new URLSearchParams();
        if (token) queryParams.set('token', token);
        queryParams.set('error', 'Missing token or server ID.');
        return res.redirect('/?' + queryParams.toString());
    }

    logger.logInfo(`Fetching channels for guild ID: ${guildId}`);
    try {
        const guilds = await fetchGuilds(token);
        const selectedGuildObject = guilds.find((g) => g.id === guildId);
        if (!selectedGuildObject) {
            logger.logWarn(`Selected guildId ${guildId} not found in fetched guilds.`);
            return res.render('index', {
                pageTitle: 'Discord Exporter - Select Server',
                token: token,
                guilds: guilds.sort((a, b) => a.name.localeCompare(b.name)),
                selectedGuildId: null,
                selectedGuild: null,
                channels: null,
                selectedChannelId: null,
                error: `Could not find selected server (ID: ${guildId}).`,
            });
        }
        const channelsAndCategories = await fetchChannels(token, guildId);

        logger.logInfo(
            `Starting sequential thread fetch for ${channelsAndCategories.length} channels in guild ${guildId}...`,
        );
        const threadsMap = {};
        const THREAD_FETCH_DELAY_MS = 300;
        for (const channel of channelsAndCategories) {
            if ([0, 5].includes(channel.type)) {
                try {
                    // logger.logInfo(`Fetching threads for channel: ${channel.name} (${channel.id})`); // Reduce verbosity
                    const threads = await fetchThreads(token, channel.id, channel.type);
                    threadsMap[channel.id] = threads || [];
                    // logger.logInfo(` -> Fetched ${threadsMap[channel.id].length} threads for ${channel.name}. Waiting ${THREAD_FETCH_DELAY_MS}ms.`); // Reduce verbosity
                    await sleep(THREAD_FETCH_DELAY_MS);
                } catch (threadError) {
                    logger.logWarn(`Failed to fetch threads for channel ${channel.id} (${channel.name})`, threadError);
                    threadsMap[channel.id] = [];
                }
            } else {
                threadsMap[channel.id] = [];
            }
        }
        logger.logInfo(`Finished sequential thread fetch for guild ${guildId}.`);

        const channelsWithThreads = channelsAndCategories.map((channel) => ({
            ...channel,
            threads: threadsMap[channel.id] || [],
        }));
        channelsWithThreads.sort((a, b) => {
            if (a.type === 4 && b.type !== 4) return -1;
            if (a.type !== 4 && b.type === 4) return 1;
            return (a.name || '').localeCompare(b.name || '');
        });

        logger.logInfo(`Successfully fetched channels/categories and threads for guild ${guildId}.`);
        res.render('index', {
            pageTitle: 'Discord Exporter - Select Channel',
            token: token,
            guilds: guilds.sort((a, b) => a.name.localeCompare(b.name)),
            selectedGuildId: guildId,
            selectedGuild: selectedGuildObject,
            channels: channelsWithThreads,
            selectedChannelId: null,
            error: null,
        });
    } catch (error) {
        logger.logError(`Failed to fetch channels or guilds for guild ID ${guildId}`, error);
        let errorMessage = 'Failed to fetch channels. Check logs.';
        if (error.status === 401) errorMessage = 'Invalid Discord Token.';
        else if (error.status === 403) errorMessage = 'Missing permissions to view channels.';
        else if (error.status === 404) errorMessage = 'Server not found.';
        else if (error.message.includes('Network') || error.message.includes('timeout'))
            errorMessage = 'Network error or timeout.';
        try {
            const guildsOnError = token ? await fetchGuilds(token).catch(() => null) : null;
            res.render('index', {
                pageTitle: 'Discord Exporter - Select Server',
                token: token,
                guilds: guildsOnError?.sort((a, b) => a.name.localeCompare(b.name)),
                selectedGuildId: null,
                selectedGuild: null,
                channels: null,
                selectedChannelId: null,
                error: errorMessage,
            });
        } catch (renderError) {
            logger.logError('Failed even to render guild selection on error path', renderError);
            res.redirect(`/?error=${encodeURIComponent(errorMessage)}&token=${encodeURIComponent(token || '')}`);
        }
    }
});

// POST /start-export - User selects channel and STARTS the background export
app.post('/start-export', async (req, res) => {
    // --- Validate inputs ---
    const rawToken = req.body.token[0];
    const rawGuildId = req.body.guildId;
    const rawChannelId = req.body.channelId;

    const token = typeof rawToken === 'string' ? rawToken.trim() : null;
    const guildId = typeof rawGuildId === 'string' ? rawGuildId.trim() : null; // Optional but useful for context
    const channelId = typeof rawChannelId === 'string' ? rawChannelId.trim() : null;

    if (!token || !channelId) {
        logger.logWarn('Attempted to start export with invalid or missing token/channelId.');
        return res.redirect('/?error=' + encodeURIComponent('Missing token or channel ID format for export.'));
    }

    // --- Get Channel Name (for folder naming) ---
    let channelName = `Channel_${channelId}`; // Default name
    try {
        // Use the imported makeDiscordRequest
        const channelInfo = await makeDiscordRequest(token, `https://discord.com/api/v10/channels/${channelId}`);
        if (channelInfo && channelInfo.name) {
            channelName = channelInfo.name;
            logger.logInfo(`Retrieved channel name: ${channelName}`);
        } else {
            logger.logWarn(`Could not retrieve channel name for ${channelId} from API response.`);
        }
    } catch (nameError) {
        logger.logWarn(
            `Could not fetch channel details for name (ID: ${channelId}). Using default name. Error: ${nameError.message}`,
        );
    }

    logger.logInfo(`Export requested for Channel: ${channelName} (${channelId})`);

    // --- Trigger Background Task ---
    runExportProcess(token, channelId, guildId, channelName).catch((err) => {
        logger.logError(`FATAL error in background runExportProcess for channel ${channelId}`, err);
        // Optionally, update a global status or write to a general error file
    });

    // --- Respond Immediately ---
    res.status(202).send(`
        <html><head><title>Export Started</title><link rel="stylesheet" href="/css/style.css"></head>
            <body><div class="container"><h1>Export Process Started</h1>
            <p>Export has been initiated in the background for channel:</p>
            <p><strong>${sanitize(channelName)} (${channelId})</strong></p>
            <p>This may take some time depending on the number of messages and attachments.</p>
            <p>You can monitor the server logs and check the 'Exports' directory (inside the application folder) for results.</p>
            <p><em>(Real-time progress updates will be added later).</em></p>
            <br>
            <a href="/" class="btn btn-primary">Go Back Home</a>
            </div></body></html>
    `);
});

// --- Error Handling ---
// 404 Handler
app.use((req, res, next) => {
    const error = new Error(`Not Found - ${req.originalUrl}`);
    error.status = 404;
    next(error);
});

// General Error Handler
app.use((err, req, res, next) => {
    logger.logError(`Unhandled error: ${err.message}`, { status: err.status || 500, stack: err.stack });
    res.locals.message = err.message;
    res.locals.error = process.env.NODE_ENV === 'development' ? err : {}; // Only show stack in dev
    res.status(err.status || 500);
    res.render('error', {
        // Assumes 'error.njk' template exists
        pageTitle: `Error ${err.status || 500}`,
        errorStatus: err.status || 500,
        errorMessage: err.message,
        errorStack: process.env.NODE_ENV === 'development' ? err.stack : null,
    });
});

// --- Server Startup ---
const server = app.listen(port, () => {
    logger.logInfo(`Server listening on http://localhost:${port}`);
    console.log(`\n🚀 Discord Exporter App running! Access it at: http://localhost:${port}\n`);
    // Ensure Exports base directory exists on startup
    fs.mkdir(EXPORTS_BASE_DIR, { recursive: true })
        .then(() => logger.logInfo(`Ensured Exports directory exists: ${EXPORTS_BASE_DIR}`))
        .catch((err) => logger.logError(`Failed to create base Exports directory ${EXPORTS_BASE_DIR}`, err));
});

// --- Graceful Shutdown ---
let isExiting = false; // Define flag for shutdown guard
const shutdown = async (signal) => {
    if (isExiting) return;
    isExiting = true;
    logger.logWarn(`Received ${signal}. Starting graceful shutdown...`);
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    // Add logic here to track/cancel ongoing exports if possible/needed

    server.close(async (err) => {
        if (err) {
            logger.logError('Error during server shutdown:', err);
            console.error('Error closing server:', err);
            process.exitCode = 1;
        } else {
            logger.logInfo('Server closed.');
            console.log('✅ Server closed.');
        }
        try {
            logger.logInfo('Closing log streams...');
            await logger.closeLogs();
            logger.logInfo('Log streams closed.');
            console.log('✅ Log streams closed.');
        } catch (logCloseError) {
            logger.logError('Error closing log streams:', logCloseError);
            console.error('Error closing logs:', logCloseError);
            if (!process.exitCode) process.exitCode = 1;
        } finally {
            logger.logInfo(`Shutdown complete. Exiting with code ${process.exitCode || 0}.`);
            process.exit(process.exitCode || 0);
        }
    });
    // Force exit after timeout
    setTimeout(() => {
        logger.logError('Graceful shutdown timed out. Forcing exit.');
        console.error('Graceful shutdown timed out! Forcing exit.');
        process.exit(1);
    }, 10000); // 10 seconds
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Add helper for sanitization needed in start-export response
function sanitize(text) {
    if (typeof text !== 'string') return String(text);
    const map = { '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" };
    return text.replace(/[&<>"']/g, (m) => map[m]);
}
