// Load environment variables FIRST
require('dotenv').config();

const express = require('express');
const nunjucks = require('nunjucks');
const path = require('node:path');
const fs = require('node:fs/promises'); // Need fs promises
const logger = require('./lib/logger'); // Import our custom logger
const { fetchGuilds, fetchChannels, fetchThreads, makeDiscordRequest } = require('./lib/discordApi'); // Import API functions, including makeDiscordRequest
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
app.set('view engine', 'njk');

// --- Middleware ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
    logger.logInfo(`Request received: ${req.method} ${req.originalUrl}`);
    if (req.method === 'POST' && req.body) {
        const bodyToLog = { ...req.body };
        if (bodyToLog.token) {
            bodyToLog.token = '********';
        }
        logger.logInfo(`Request Body: ${JSON.stringify(bodyToLog)}`);
    }
    next();
});

// --- Base directory for all exports ---
const EXPORTS_BASE_DIR = path.resolve(__dirname, 'Exports');

// --- SSE Job Management ---
const activeJobs = {}; // { jobId: [res1, res2, ...], ... }

/** Sends SSE update */
function sendJobUpdate(jobId, data, event = 'message') {
    if (!activeJobs[jobId]) return;
    const messageString = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    activeJobs[jobId] = activeJobs[jobId].filter((res, index) => {
        if (res.writableEnded || res.destroyed) {
            logger.logInfo(`[SSE ${jobId}] Removed disconnected client #${index}`);
            return false;
        } else {
            try {
                res.write(messageString);
                return true;
            } catch (writeError) {
                logger.logError(`[SSE ${jobId}] Error writing to client #${index}`, writeError);
                res.end();
                return false;
            }
        }
    });
    if (activeJobs[jobId].length === 0) {
        delete activeJobs[jobId];
        logger.logInfo(`[SSE ${jobId}] Removed job entry.`);
    }
}

// --- Background Export Function (Passes sendJobUpdate to processMessages) ---
/** Runs the entire export process */
async function runExportProcess(token, channelId, guildId, channelName, jobId) {
    const startTime = Date.now();
    const safeChannelName = channelName ? channelName.replace(/[^a-zA-Z0-9_-]/g, '_') : 'UnknownChannel';
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const exportFolderName = `${safeChannelName}_${channelId}_${timestamp}`;
    const exportDir = path.join(EXPORTS_BASE_DIR, exportFolderName);

    const rawDir = path.join(exportDir, 'messages');
    const processedDir = path.join(exportDir, 'processed_messages');
    const htmlDir = path.join(exportDir, 'processed_html');
    const downloadsDir = path.join(exportDir, 'downloaded_files');
    const finalDownloadsDir = path.join(htmlDir, 'downloaded_files');

    logger.logInfo(`[${jobId}] Starting export process for channel: ${channelName} (${channelId})`);
    sendJobUpdate(jobId, {
        status: 'starting',
        message: `Starting export for ${channelName}...`,
        directory: exportFolderName,
    });

    // --- Create Download Cache for this specific job ---
    const downloadCache = new Map(); // <<< Cache is created here
    logger.logInfo(`[${jobId}] Initialized download cache.`);

    try {
        // 1. Create Directories
        await fs.mkdir(rawDir, { recursive: true });
        await fs.mkdir(processedDir, { recursive: true });
        await fs.mkdir(htmlDir, { recursive: true });
        logger.logInfo(`[${jobId}] Created directories.`);
        sendJobUpdate(jobId, { status: 'progress', message: 'Created directories.' });

        // 2. Fetch Messages Loop
        let beforeId = null;
        let batchIndex = 0;
        const limitPerBatch = process.env.LIMIT_PER_BATCH || 50;
        const FETCH_DELAY_MS = process.env.FETCH_DEPLAY_MS || 1000;
        const MAX_BATCHES = process.env.MAX_BATCHES || null;
        let totalMessagesFetched = 0;
        logger.logInfo(`[${jobId}] Starting fetch loop...`);
        sendJobUpdate(jobId, { status: 'progress', message: 'Starting message fetch...' });

        while (true) {
            if (MAX_BATCHES !== null && batchIndex >= MAX_BATCHES) {
                /* ... handle batch limit ... */ break;
            }
            const currentBatchMsg = `Fetching batch ${batchIndex}...`;
            logger.logInfo(`[${jobId}] ${currentBatchMsg}`);
            sendJobUpdate(jobId, { status: 'progress', message: currentBatchMsg, batch: batchIndex });

            let messages = [];
            try {
                messages = await fetchMessagesBatch(token, channelId, limitPerBatch, { before: beforeId });
            } catch (fetchError) {
                /* ... handle retry ... */ logger.logError(
                    `[${jobId}] Error fetch batch ${batchIndex}. Status: ${fetchError.status}`,
                    fetchError,
                );
                sendJobUpdate(jobId, {
                    status: 'warning',
                    message: `Error fetch batch ${batchIndex}: ${fetchError.message}. Retrying...`,
                    batch: batchIndex,
                });
                await sleep(5000);
                try {
                    messages = await fetchMessagesBatch(token, channelId, limitPerBatch, { before: beforeId });
                } catch (retryError) {
                    logger.logError(`[${jobId}] Retry failed. Abort. Status: ${retryError.status}`, retryError);
                    sendJobUpdate(
                        jobId,
                        {
                            status: 'error',
                            message: `Retry failed batch ${batchIndex}. Abort: ${retryError.message}`,
                            batch: batchIndex,
                        },
                        'error',
                    );
                    await fs.writeFile(
                        path.join(exportDir, 'EXPORT_FAILED.txt'),
                        `Failed fetch batch ${batchIndex}: ${retryError.message}`,
                    );
                    return;
                }
            }

            const count = messages.length;
            totalMessagesFetched += count;
            logger.logInfo(`[${jobId}] Fetched ${count} in batch ${batchIndex}. Total: ${totalMessagesFetched}`);
            sendJobUpdate(jobId, {
                status: 'progress',
                message: `Fetched ${count} messages in batch ${batchIndex}. Total: ${totalMessagesFetched}`,
                batch: batchIndex,
                count: count,
                total: totalMessagesFetched,
            });
            if (count === 0) {
                logger.logInfo(`[${jobId}] No more messages.`);
                sendJobUpdate(jobId, { status: 'progress', message: 'Finished fetching messages.' });
                break;
            }

            // Save Raw
            try {
                await fs.writeFile(
                    path.join(rawDir, `messages_batch_${batchIndex}_${count}.json`),
                    JSON.stringify(messages, null, 2),
                );
            } catch (writeError) {
                logger.logError(`[${jobId}] Failed write raw ${batchIndex}`, writeError);
            }

            // Process Batch (Downloads/Deduplication) - Pass sendJobUpdate
            const processMsg = `Processing batch ${batchIndex} (Downloads)...`;
            logger.logInfo(`[${jobId}] ${processMsg}`);
            sendJobUpdate(jobId, { status: 'progress', message: processMsg, batch: batchIndex });
            try {
                // *** Pass jobId and sendJobUpdate to processMessages ***
                const processedMessages = await processMessages(
                    messages,
                    exportDir,
                    jobId,
                    sendJobUpdate,
                    downloadCache,
                );
                // Save Processed
                try {
                    await fs.writeFile(
                        path.join(processedDir, `processed_messages_batch_${batchIndex}_${count}.json`),
                        JSON.stringify(processedMessages, null, 2),
                    );
                } catch (writeError) {
                    logger.logError(`[${jobId}] Failed write processed ${batchIndex}`, writeError);
                }
            } catch (processError) {
                /* ... handle processing error ... */ logger.logError(
                    `[${jobId}] Error process batch ${batchIndex}. Abort.`,
                    processError,
                );
                sendJobUpdate(
                    jobId,
                    {
                        status: 'error',
                        message: `Error process batch ${batchIndex}. Abort: ${processError.message}`,
                        batch: batchIndex,
                    },
                    'error',
                );
                await fs.writeFile(
                    path.join(exportDir, 'EXPORT_FAILED.txt'),
                    `Failed process batch ${batchIndex}: ${processError.message}`,
                );
                return;
            }
            sendJobUpdate(jobId, {
                status: 'progress',
                message: `Finished processing batch ${batchIndex}.`,
                batch: batchIndex,
            });

            beforeId = messages[count - 1].id;
            batchIndex++;
            await sleep(FETCH_DELAY_MS);
        } // End while loop

        logger.logInfo(
            `[${jobId}] Finished fetch/process. Batches: ${batchIndex}. Total Msgs: ${totalMessagesFetched}.`,
        );
        sendJobUpdate(jobId, { status: 'progress', message: `Starting HTML generation...` });

        // 3. Generate HTML
        logger.logInfo(`[${jobId}] Starting HTML generation...`);
        const cssPath = null; // Not used anymore
        try {
            await generateHtmlFiles(processedDir, htmlDir, cssPath);
            logger.logInfo(`[${jobId}] HTML gen complete.`);
            sendJobUpdate(jobId, { status: 'progress', message: 'HTML generation complete.' });
        } catch (htmlError) {
            /* ... handle HTML error ... */ logger.logError(`[${jobId}] HTML gen failed. Abort.`, htmlError);
            sendJobUpdate(jobId, { status: 'error', message: `HTML gen failed. Abort: ${htmlError.message}` }, 'error');
            await fs.writeFile(path.join(exportDir, 'EXPORT_FAILED.txt'), `HTML gen failed: ${htmlError.message}`);
            return;
        }

        // 4. Move downloaded_files
        logger.logInfo(`[${jobId}] Moving downloads...`);
        sendJobUpdate(jobId, { status: 'progress', message: 'Moving downloaded files...' });
        try {
            try {
                await fs.access(downloadsDir);
                await fs.rename(downloadsDir, finalDownloadsDir);
                logger.logInfo(`[${jobId}] Moved downloads.`);
                sendJobUpdate(jobId, { status: 'progress', message: 'Moved downloaded files.' });
            } catch (accessError) {
                if (accessError.code === 'ENOENT') {
                    logger.logInfo(`[${jobId}] No downloads dir to move.`);
                    sendJobUpdate(jobId, { status: 'progress', message: 'No downloaded files to move.' });
                } else {
                    throw accessError;
                }
            }
        } catch (moveError) {
            /* ... handle move error ... */ logger.logError(`[${jobId}] Failed move downloads.`, moveError);
            sendJobUpdate(jobId, { status: 'warning', message: `Failed move downloads: ${moveError.message}` });
            await fs.writeFile(
                path.join(exportDir, 'EXPORT_WARNING_MOVE_FAILED.txt'),
                `Failed move: ${moveError.message}`,
            );
        }

        // 5. Mark Complete
        const endTime = Date.now();
        const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
        const summary = `Export completed successfully at ${new Date().toISOString()}. Duration: ${durationSeconds}s. Batches: ${batchIndex}. Messages: ${totalMessagesFetched}.`;
        await fs.writeFile(path.join(exportDir, 'EXPORT_SUCCESS.txt'), summary);
        logger.logInfo(`[${jobId}] ${summary}`);
        sendJobUpdate(
            jobId,
            { status: 'complete', message: 'Export finished successfully!', summary: summary },
            'complete',
        );
    } catch (error) {
        /* ... handle main catch ... */ logger.logError(`[${jobId}] UNEXPECTED ERROR export ${channelId}.`, error);
        sendJobUpdate(jobId, { status: 'error', message: `Unexpected fatal error: ${error.message}` }, 'error');
        try {
            await fs.mkdir(exportDir, { recursive: true }).catch(() => {});
            await fs.writeFile(
                path.join(exportDir, 'EXPORT_FAILED.txt'),
                `Unexpected error: ${error.message}\n${error.stack}`,
            );
        } catch (writeErr) {
            logger.logError(`[${jobId}] Failed write final failure notice.`, writeErr);
        }
    } finally {
        delete activeJobs[jobId];
        logger.logInfo(`[${jobId}] Background process finished. Cleaned SSE job.`);
    }
}

// --- Routes ---
// GET /
app.get('/', (req, res) => {
    res.render('index', {
        pageTitle: 'Discord Exporter - Enter Token',
        token: req.query.token || '',
        guilds: null,
        selectedGuildId: null,
        selectedGuild: null,
        channels: null,
        error: req.query.error || null,
    });
});
// POST /fetch-guilds
app.post('/fetch-guilds', async (req, res) => {
    /* ... Omitted for brevity - No changes ... */ const token = req.body.token?.trim();
    if (!token) {
        return res.redirect('/?error=' + encodeURIComponent('Token required.'));
    }
    try {
        const guilds = await fetchGuilds(token);
        res.render('index', {
            pageTitle: 'Select Server',
            token: token,
            guilds: guilds.sort((a, b) => a.name.localeCompare(b.name)),
            error: null,
        });
    } catch (error) {
        logger.logError('Failed fetch guilds', error);
        let msg = 'Failed fetch servers.';
        if (error.status === 401) msg = 'Invalid Token.';
        else if (error.message.includes('Network')) msg = 'Network error/timeout.';
        res.redirect(`/?error=${encodeURIComponent(msg)}&token=${encodeURIComponent(token)}`);
    }
});
// POST /fetch-channels
app.post('/fetch-channels', async (req, res) => {
    /* ... Omitted for brevity - No changes ... */ const token = req.body.token?.trim();
    const guildId = req.body.guildId?.trim();
    const hasFetchThreads = req.body['fetch-threads'] === 'on' ? true : false;
    if (!token || !guildId) {
        const q = new URLSearchParams();
        if (token) q.set('token', token);
        q.set('error', 'Missing token/server ID.');
        return res.redirect('/?' + q.toString());
    }
    try {
        const guilds = await fetchGuilds(token);
        const selGuild = guilds.find((g) => g.id === guildId);
        if (!selGuild) {
            return res.render('index', {
                pageTitle: 'Select Server',
                token: token,
                guilds: guilds.sort((a, b) => a.name.localeCompare(b.name)),
                error: `Could not find server (ID: ${guildId}).`,
            });
        }
        const channelsCats = await fetchChannels(token, guildId);
        const threadsMap = {};
        const DELAY = 300;
        if (hasFetchThreads) {
            for (const c of channelsCats) {
                if ([0, 5].includes(c.type)) {
                    try {
                        const t = await fetchThreads(token, c.id, c.type);
                        threadsMap[c.id] = t || [];
                        await sleep(DELAY);
                    } catch (e) {
                        logger.logWarn(`Failed fetch threads ${c.id}`, e);
                        threadsMap[c.id] = [];
                    }
                } else {
                    threadsMap[c.id] = [];
                }
            }
        }
        const channels = channelsCats.map((c) => ({ ...c, threads: threadsMap[c.id] || [] }));
        channels.sort((a, b) => {
            if (a.type === 4 && b.type !== 4) return -1;
            if (a.type !== 4 && b.type === 4) return 1;
            return (a.name || '').localeCompare(b.name || '');
        });
        res.render('index', {
            pageTitle: 'Select Channel',
            token: token,
            guilds: guilds.sort((a, b) => a.name.localeCompare(b.name)),
            selectedGuildId: guildId,
            selectedGuild: selGuild,
            channels: channels,
            error: null,
        });
    } catch (error) {
        logger.logError(`Failed fetch channels ${guildId}`, error);
        let msg = 'Failed fetch channels.';
        if (error.status === 401) msg = 'Invalid Token.';
        else if (error.status === 403) msg = 'Missing permissions.';
        else if (error.status === 404) msg = 'Server not found.';
        else if (error.message.includes('Network')) msg = 'Network error/timeout.';
        try {
            const errGuilds = token ? await fetchGuilds(token).catch(() => null) : null;
            res.render('index', {
                pageTitle: 'Select Server',
                token: token,
                guilds: errGuilds?.sort((a, b) => a.name.localeCompare(b.name)),
                error: msg,
            });
        } catch (renderErr) {
            res.redirect(`/?error=${encodeURIComponent(msg)}&token=${encodeURIComponent(token || '')}`);
        }
    }
});

// GET /export-status/:jobId (SSE Endpoint)
app.get('/export-status/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    if (!jobId) {
        return res.status(400).send('Missing Job ID');
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();
    logger.logInfo(`[SSE ${jobId}] Client connected.`);
    if (!activeJobs[jobId]) {
        activeJobs[jobId] = [];
    }
    activeJobs[jobId].push(res);
    sendJobUpdate(jobId, { status: 'connected', message: 'Connected...' }); // Initial connect message
    req.on('close', () => {
        logger.logInfo(`[SSE ${jobId}] Client disconnected.`);
        if (activeJobs[jobId]) {
            const i = activeJobs[jobId].indexOf(res);
            if (i !== -1) {
                activeJobs[jobId].splice(i, 1);
            }
            if (activeJobs[jobId].length === 0) {
                delete activeJobs[jobId];
                logger.logInfo(`[SSE ${jobId}] Removed job entry.`);
            }
        }
        res.end();
    });
});

// POST /start-export (Triggers background task)
app.post('/start-export', async (req, res) => {
    const token = typeof req.body.token[0] === 'string' ? req.body.token[0].trim() : null;
    const guildId = typeof req.body.guildId === 'string' ? req.body.guildId.trim() : null;
    const channelId = typeof req.body.channelId === 'string' ? req.body.channelId.trim() : null;
    if (!token || !channelId) {
        return res.redirect('/?error=' + encodeURIComponent('Missing token/channel ID'));
    }
    let channelName = `Channel_${channelId}`;
    try {
        const cInfo = await makeDiscordRequest(token, `https://discord.com/api/v10/channels/${channelId}`);
        if (cInfo && cInfo.name) {
            channelName = cInfo.name;
        }
    } catch (e) {
        logger.logWarn(`Could not get channel name ${channelId}`, e.message);
    }
    const jobId = `Export-${channelId}-${Date.now()}`;
    logger.logInfo(`[${jobId}] Export requested for Channel: ${channelName} (${channelId})`);
    // Trigger background task (NO await)
    runExportProcess(token, channelId, guildId, channelName, jobId).catch((err) => {
        logger.logError(`[${jobId}] FATAL error in background runExportProcess`, err);
        sendJobUpdate(jobId, { status: 'error', message: `FATAL background task error: ${err.message}` }, 'error');
        delete activeJobs[jobId];
    });
    // Respond Immediately with embedded SSE listener
    res.status(202).send(
        `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Export Started: ${sanitize(
            channelName,
        )}</title><link rel="stylesheet" href="/css/style.css"></head><body><div class="container"><h1>Export Process Started</h1><p>Export initiated for channel:</p><p><strong>${sanitize(
            channelName,
        )} (${channelId})</strong></p><p>Job ID: <code>${jobId}</code></p><p>Status updates below. Check 'Exports' folder later.</p><a href="/" class="btn btn-secondary" style="margin-top: 10px;">Go Back Home</a><div id="export-progress"><p class="status-message">Status: Initializing...</p><div class="progress-bar-container" style="display: none;"><div class="progress-bar"></div></div><div id="progress-log" style="max-height: 300px; overflow-y: auto; margin-top: 10px; border-top: 1px solid var(--border-color); padding-top: 5px; font-size: 0.85em; line-height: 1.4;"></div></div></div><script>const jobId="${jobId}"; const progDiv=document.getElementById('export-progress'); const statEl=progDiv.querySelector('.status-message'); const logEl=document.getElementById('progress-log'); const barCont=progDiv.querySelector('.progress-bar-container'); const bar=progDiv.querySelector('.progress-bar'); function addL(m,t='info'){const p=document.createElement('p'); p.style.margin='2px 0'; p.textContent=\`[\${new Date().toLocaleTimeString()}] \${m}\`; if(t==='error')p.style.color='hsl(359, 82%, 72%)'; if(t==='warning')p.style.color='hsl(38, 95%, 70%)'; if(t==='success')p.style.color='hsl(139, 68%, 70%)'; logEl.prepend(p); while(logEl.childElementCount>50)logEl.removeChild(logEl.lastChild);} if(jobId){const es=new EventSource(\`/export-status/\${jobId}\`); addL('Connecting...'); es.onopen=()=>{console.log('SSE open.');addL('Connected.');statEl.textContent='Status: Connected...';}; es.addEventListener('message',(e)=>{try{const d=JSON.parse(e.data); console.log('SSE msg:',d); if(d.message){statEl.textContent=\`Status: \${d.message}\`;addL(d.message,d.status==='error'?'error':d.status==='warning'?'warning':'info');} if(typeof d.percent==='number'&&bar){barCont.style.display='block'; bar.style.width=d.percent+'%';}}catch(err){console.error('SSE parse err:',e.data,err);addL('Bad status update.','error');}}); es.addEventListener('complete',(e)=>{console.log('SSE complete:',e.data); const d=JSON.parse(e.data); statEl.textContent=\`Status: \${d.message||'Complete!'}\`; addL(d.summary||'Export finished!','success'); if(bar)bar.style.width='100%'; es.close();}); es.addEventListener('error',(e)=>{if(e.target.readyState===EventSource.CLOSED){console.log('SSE closed.');addL('Connection closed.','warning');if(!statEl.textContent.includes('Complete')&&!statEl.textContent.includes('Error')){statEl.textContent='Status: Connection closed.';}}else if(e.target.readyState===EventSource.CONNECTING){console.log('SSE reconnecting...');addL('Reconnecting...');}else{console.error('SSE error:',e);addL('Status update error.','error');statEl.textContent='Status: Error receiving updates.';es.close();}}); } else {statEl.textContent='Status: Error - No Job ID.';addL('No Job ID to track status.','error');}</script></body></html>`,
    );
});

// --- Error Handling ---
app.use((req, res, next) => {
    const e = new Error(`Not Found: ${req.originalUrl}`);
    e.status = 404;
    next(e);
});
app.use((err, req, res, next) => {
    logger.logError(`Unhandled: ${err.message}`, { status: err.status || 500, stack: err.stack });
    res.locals.message = err.message;
    res.locals.error = process.env.NODE_ENV === 'development' ? err : {};
    res.status(err.status || 500);
    res.render('error', {
        pageTitle: `Error ${err.status || 500}`,
        errorStatus: err.status || 500,
        errorMessage: err.message,
        errorStack: process.env.NODE_ENV === 'development' ? err.stack : null,
    });
});

// --- Server Startup ---
const server = app.listen(port, () => {
    logger.logInfo(`Server listening on http://localhost:${port}`);
    console.log(`\n🚀 App running: http://localhost:${port}\n`);
    fs.mkdir(EXPORTS_BASE_DIR, { recursive: true })
        .then(() => logger.logInfo(`Exports dir OK: ${EXPORTS_BASE_DIR}`))
        .catch((e) => logger.logError(`Failed create Exports dir ${EXPORTS_BASE_DIR}`, e));
});

// --- Graceful Shutdown ---
let isExiting = false;
const shutdown = async (sig) => {
    if (isExiting) return;
    isExiting = true;
    logger.logWarn(`Received ${sig}. Shutdown...`);
    console.log(`\nReceived ${sig}. Shutdown...`);
    server.close(async (err) => {
        if (err) {
            logger.logError('Server close err:', err);
            console.error('Server close err:', err);
            process.exitCode = 1;
        } else {
            logger.logInfo('Server closed.');
            console.log('✅ Server closed.');
        }
        try {
            logger.logInfo('Closing logs...');
            await logger.closeLogs();
            logger.logInfo('Logs closed.');
            console.log('✅ Logs closed.');
        } catch (e) {
            logger.logError('Logs close err:', e);
            console.error('Logs close err:', e);
            if (!process.exitCode) process.exitCode = 1;
        } finally {
            logger.logInfo(`Exit code ${process.exitCode || 0}.`);
            process.exit(process.exitCode || 0);
        }
    });
    setTimeout(() => {
        logger.logError('Shutdown timed out! Force exit.');
        console.error('Shutdown timed out! Force exit.');
        process.exit(1);
    }, 10000);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Helper for sanitization needed in start-export response
function sanitize(text) {
    if (typeof text !== 'string') return String(text);
    const m = { '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" };
    return text.replace(/[&<>"']/g, (c) => m[c]);
}
