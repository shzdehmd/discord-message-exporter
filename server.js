// Load environment variables
require('dotenv').config();

const express = require('express');
const nunjucks = require('nunjucks');
const path = require('node:path');
const logger = require('./lib/logger'); // Import our custom logger
const { fetchGuilds, fetchChannels, fetchThreads } = require('./lib/discordApi'); // Import API functions

const app = express();
const port = process.env.PORT || 3000;

// --- Nunjucks Setup ---
const nunjucksEnv = nunjucks.configure('views', {
    autoescape: true,
    express: app,
    watch: true, // Auto-reload templates during development
});
// Add custom Nunjucks filter 'find' if needed (useful for finding selected guild)
nunjucksEnv.addFilter('find', (array, predicate) => {
    if (!Array.isArray(array)) return undefined;
    return array.find(predicate);
});
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
    // Log form body for POST requests (be careful with sensitive data like tokens in real-world apps)
    if (req.method === 'POST' && req.body) {
        // Avoid logging the full token
        const bodyToLog = { ...req.body };
        if (bodyToLog.token) {
            bodyToLog.token = '********'; // Mask token
        }
        logger.logInfo(`Request Body: ${JSON.stringify(bodyToLog)}`);
    }
    next();
});

// --- Routes ---

// GET / - Display the initial form or guild/channel selection based on query params
app.get('/', (req, res) => {
    // Render the initial page with just the token form
    res.render('index', {
        pageTitle: 'Discord Exporter - Enter Token',
        // Use query parameters to potentially pre-fill or show errors on redirects
        token: req.query.token || '',
        guilds: null,
        selectedGuildId: null,
        channels: null,
        selectedChannelId: null,
        error: req.query.error || null,
    });
});

// POST /fetch-guilds - User submits token
app.post('/fetch-guilds', async (req, res) => {
    const token = req.body.token?.trim(); // Get token from form body

    if (!token) {
        logger.logWarn('Attempted to fetch guilds without providing a token.');
        // Redirect back to home page with an error message
        return res.redirect('/?error=' + encodeURIComponent('Token is required.'));
    }

    logger.logInfo('Received token, attempting to fetch guilds.');
    try {
        const guilds = await fetchGuilds(token);
        logger.logInfo(`Successfully fetched ${guilds.length} guilds.`);

        // Render the index page again, now showing the list of guilds
        res.render('index', {
            pageTitle: 'Discord Exporter - Select Server',
            token: token, // Pass token back to the template for the next step
            guilds: guilds.sort((a, b) => a.name.localeCompare(b.name)), // Sort guilds alphabetically
            selectedGuildId: null,
            channels: null,
            selectedChannelId: null,
            error: null,
        });
    } catch (error) {
        logger.logError('Failed to fetch guilds', error);
        // Determine a user-friendly error message
        let errorMessage = 'Failed to fetch servers. Check logs for details.';
        if (error.status === 401) {
            errorMessage = 'Invalid Discord Token provided.';
        } else if (error.message.includes('Network') || error.message.includes('timeout')) {
            errorMessage = 'Network error or timeout connecting to Discord API.';
        }
        // Redirect back to home page with the error and pre-filled token
        res.redirect(`/?error=${encodeURIComponent(errorMessage)}&token=${encodeURIComponent(token)}`);
    }
});

// POST /fetch-channels - User selects a guild
app.post('/fetch-channels', async (req, res) => {
    const token = req.body.token?.trim();
    const guildId = req.body.guildId?.trim();

    if (!token || !guildId) {
        logger.logWarn('Attempted to fetch channels without token or guildId.', { token: !!token, guildId: !!guildId });
        // Redirect back to home, ideally preserving token if available
        const queryParams = new URLSearchParams();
        if (token) queryParams.set('token', token);
        queryParams.set('error', 'Missing token or server ID.');
        return res.redirect('/?' + queryParams.toString());
    }

    logger.logInfo(`Fetching channels for guild ID: ${guildId}`);
    try {
        // Fetch guilds again to pass the full list back to the template for rendering
        const guilds = await fetchGuilds(token);

        // Fetch channels for the selected guild
        const channelsAndCategories = await fetchChannels(token, guildId); // This includes categories now

        // Fetch threads for all relevant channels in parallel
        const threadFetchPromises = channelsAndCategories
            .filter((c) => [0, 5].includes(c.type)) // Only fetch threads for Text and News channels
            .map((channel) =>
                fetchThreads(token, channel.id, channel.type)
                    .then((threads) => ({ channelId: channel.id, threads: threads }))
                    .catch((threadError) => {
                        // Log thread fetch errors but don't fail the whole channel request
                        logger.logWarn(
                            `Failed to fetch threads for channel ${channel.id} in guild ${guildId}`,
                            threadError,
                        );
                        return { channelId: channel.id, threads: [] }; // Return empty array on error
                    }),
            );

        const threadResults = await Promise.all(threadFetchPromises);

        // Create a map for easy lookup: channelId -> threads array
        const threadsMap = threadResults.reduce((map, result) => {
            map[result.channelId] = result.threads;
            return map;
        }, {});

        // Add the threads to their parent channels in the list
        const channelsWithThreads = channelsAndCategories.map((channel) => {
            return {
                ...channel,
                threads: threadsMap[channel.id] || [], // Add threads array (or empty if none/error)
            };
        });

        // Sort channels: Categories first, then others alphabetically
        // Note: Discord often returns channels in a semi-sorted position order.
        // You might want to preserve that or implement custom sorting (e.g., by position field).
        channelsWithThreads.sort((a, b) => {
            if (a.type === 4 && b.type !== 4) return -1; // Categories first
            if (a.type !== 4 && b.type === 4) return 1;
            // Could add sorting by 'position' field here if needed
            return (a.name || '').localeCompare(b.name || ''); // Then alphabetically
        });

        logger.logInfo(
            `Successfully fetched ${channelsAndCategories.length} channels/categories and associated threads for guild ${guildId}.`,
        );

        // Render the index page again, showing channels for the selected guild
        res.render('index', {
            pageTitle: 'Discord Exporter - Select Channel',
            token: token,
            guilds: guilds.sort((a, b) => a.name.localeCompare(b.name)), // Keep guilds sorted
            selectedGuildId: guildId,
            channels: channelsWithThreads, // Pass channels with threads included
            selectedChannelId: null,
            error: null,
        });
    } catch (error) {
        logger.logError(`Failed to fetch channels or guilds for guild ID ${guildId}`, error);
        let errorMessage = 'Failed to fetch channels. Check logs.';
        if (error.status === 401) {
            errorMessage = 'Invalid Discord Token.';
        } else if (error.status === 403) {
            errorMessage = 'Missing permissions to view channels in that server.';
        } else if (error.status === 404) {
            errorMessage = 'Server not found or you are no longer a member.';
        } else if (error.message.includes('Network') || error.message.includes('timeout')) {
            errorMessage = 'Network error or timeout connecting to Discord API.';
        }
        // Redirect back to the guild selection step (or home) with error
        // To redirect back to guild selection, we need the token again
        const guilds = req.body.token ? await fetchGuilds(req.body.token).catch(() => null) : null;
        if (guilds) {
            // Try rendering guild selection again with error
            res.render('index', {
                pageTitle: 'Discord Exporter - Select Server',
                token: req.body.token,
                guilds: guilds.sort((a, b) => a.name.localeCompare(b.name)),
                selectedGuildId: null,
                channels: null,
                selectedChannelId: null,
                error: errorMessage,
            });
        } else {
            // Fallback to home if fetching guilds also failed or no token
            res.redirect(`/?error=${encodeURIComponent(errorMessage)}&token=${encodeURIComponent(token || '')}`);
        }
    }
});

// POST /start-export - User selects channel and starts export (Initial Placeholder)
app.post('/start-export', async (req, res) => {
    const token = req.body.token?.trim();
    const guildId = req.body.guildId?.trim(); // Optional: useful for context/folder naming
    const channelId = req.body.channelId?.trim();

    if (!token || !channelId) {
        logger.logWarn('Attempted to start export without token or channelId.', {
            token: !!token,
            channelId: !!channelId,
        });
        // Redirect back to home or previous step with error
        // This depends on how much state we want to rebuild
        return res.redirect('/?error=' + encodeURIComponent('Missing token or channel ID for export.'));
    }

    logger.logInfo(`Export requested for Channel ID: ${channelId} (Guild ID: ${guildId || 'N/A'})`);

    // --- !!! ---
    // THIS IS WHERE THE EXPORT LOGIC WILL BE TRIGGERED LATER
    // For now, just acknowledge the request.
    // We will need to:
    // 1. Validate channelId further (optional: fetch channel info to get name)
    // 2. Create the export directory structure (e.g., Exports/ChannelName-ID-Timestamp/)
    // 3. Start the message fetching loop (from main.js logic)
    // 4. Start the processing/download loop (from main.js logic)
    // 5. Start the HTML conversion (from convertToHTML.js logic)
    // 6. Provide feedback to the frontend (likely via WebSockets or Server-Sent Events)
    // --- !!! ---

    // Send a simple response back to the browser for now
    // Later, this might redirect to a "progress" page or update the current page via JS
    res.status(202).send(`
        <html>
            <head>
                <title>Export Started</title>
                <link rel="stylesheet" href="/css/style.css">
                <meta http-equiv="refresh" content="5;url=/" /> <!-- Redirect back home after 5s -->
            </head>
            <body>
                <div class="container">
                    <h1>Export Process Initiated</h1>
                    <p>Export requested for Channel ID: <strong>${channelId}</strong>.</p>
                    <p>The export will run in the background on the server.</p>
                    <p><em>(This is a placeholder - actual export logic and progress reporting will be added later).</em></p>
                    <p>You will be redirected back to the home page shortly...</p>
                    <a href="/" class="btn btn-primary">Go Home Now</a>

                    <div id="export-progress">
                        <p class="status-message">Status: Initiated...</p>
                        {# Basic placeholder, real updates need JS #}
                    </div>
                </div>
            </body>
        </html>
    `);

    // --- Trigger Background Export ---
    // DO NOT 'await' the full export here - it will block the response.
    // Start the export process asynchronously.
    // startBackgroundExport(token, channelId, guildId); // A function we will define later
});

// --- Error Handling ---

// Catch 404 and forward to error handler
app.use((req, res, next) => {
    const error = new Error(`Not Found - ${req.originalUrl}`);
    error.status = 404;
    next(error); // Pass the error to the next middleware
});

// General error handler (should be defined last)
app.use((err, req, res, next) => {
    // Log the error internally
    logger.logError(`Unhandled error: ${err.message}`, { status: err.status || 500, stack: err.stack });

    // Set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = process.env.NODE_ENV === 'development' ? err : {}; // Only show stack in dev

    // Render the error page
    res.status(err.status || 500);
    res.render('error', {
        // Assumes you have an 'error.njk' template
        pageTitle: `Error ${err.status || 500}`,
        errorStatus: err.status || 500,
        errorMessage: err.message,
        // Only pass stack trace in development mode
        errorStack: process.env.NODE_ENV === 'development' ? err.stack : null,
    });
});

// --- Server Startup ---
const server = app.listen(port, () => {
    logger.logInfo(`Server listening on http://localhost:${port}`);
    console.log(`\n🚀 Discord Exporter App running! Access it at: http://localhost:${port}\n`);
});

// --- Graceful Shutdown ---
const shutdown = async (signal) => {
    logger.logWarn(`Received ${signal}. Starting graceful shutdown...`);
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);

    // Stop accepting new connections
    server.close(async (err) => {
        if (err) {
            logger.logError('Error during server shutdown:', err);
            console.error('Error closing server:', err);
            process.exitCode = 1;
        } else {
            logger.logInfo('Server closed. No longer accepting connections.');
            console.log('✅ Server closed.');
        }

        // Close logger streams
        try {
            logger.logInfo('Closing log streams...');
            await logger.closeLogs();
            logger.logInfo('Log streams closed.');
            console.log('✅ Log streams closed.');
        } catch (logCloseError) {
            logger.logError('Error closing log streams:', logCloseError);
            console.error('Error closing logs:', logCloseError);
            // Don't override exit code if server close failed
            if (process.exitCode === 0) process.exitCode = 1;
        } finally {
            // Exit the process
            logger.logInfo(`Shutdown complete. Exiting with code ${process.exitCode || 0}.`);
            process.exit(process.exitCode || 0);
        }
    });

    // Force shutdown after a timeout (e.g., 10 seconds)
    setTimeout(() => {
        logger.logError('Graceful shutdown timed out. Forcing exit.');
        console.error('Graceful shutdown timed out! Forcing exit.');
        process.exit(1);
    }, 10000); // 10 seconds
};

// Listen for termination signals
process.on('SIGINT', () => shutdown('SIGINT')); // CTRL+C
process.on('SIGTERM', () => shutdown('SIGTERM')); // Docker stop, systemd stop etc.
