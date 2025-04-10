// scripts/generateHtml.js

const fs = require('node:fs/promises');
const path = require('node:path');
const logger = require('../lib/logger');
const { discordMessagesToHtml, EMOTE_MARKER_PREFIX } = require('../lib/htmlRenderer');

// Regex to identify processed message files and extract batch index
const inputFileRegex = /^processed_messages_batch_(\d+)_\d+\.json$/;

/** Basic HTML entity encoding */
function sanitize(text) {
    if (typeof text !== 'string') return String(text);
    const map = { '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" };
    return text.replace(/[&<>"']/g, (m) => map[m]);
}

/** Generates the client-side JS */
function generateFrontendScript() {
    const escapedPrefix = EMOTE_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const markerRegex = new RegExp(`${escapedPrefix}([\\w\\/.-]+)\\|([^|]+)`, 'g');
    return `
document.addEventListener('DOMContentLoaded', () => {
    // Emote replacement
    const markerRegex = /${markerRegex.source}/g;
    const elements = document.querySelectorAll('.message-text, .embed-description, .embed-field-value');
    elements.forEach(el => { if(!el.innerHTML) return; el.innerHTML = el.innerHTML.replace(markerRegex, (_m, p, a)=>{ if(!p || p.includes('..') || p.startsWith('/')){ console.warn('Skipping unsafe emote:',p); return \`[Invalid Emote: \${a}]\`; } const sP=encodeURI(p); const sA=a.replace(/"/g,'"').replace(/</g,'<').replace(/>/g,'>'); return \`<img src="\${sP}" alt="\${sA}" class="discord-emote" loading="lazy">\`; }); });
    // Avatar URL fix (safeguard)
    document.querySelectorAll('img.message-avatar[src*="cdn.discordapp.com/embed/avatars/"]').forEach(img => { if (img.src.includes('/avatars/-')) { img.src = img.src.replace('/avatars/-','/avatars/'); } });
    // Nav buttons
    const pageMatch = window.location.pathname.match(/processed_html_(\\d+)\\.html$/); const current = pageMatch ? parseInt(pageMatch[1],10) : -1; const total = parseInt(document.body.dataset.totalPages||'0',10);
    if(current!==-1 && total>0){ const cB=(t,i,id,pos)=>{ if(i<0||i>=total)return; const b=document.createElement('a'); b.textContent=t; b.href=\`processed_html_\${i}.html\`; b.id=id; b.classList.add('nav-button'); document.body.appendChild(b); }; cB('⬅️ Prev',current-1,'prev-page-btn','bottom'); cB('Next ➡️',current+1,'next-page-btn','top'); }
    // Video autoplay
    document.querySelectorAll('video.attachment-video, video.embed-video').forEach(v => { v.muted=true; v.autoplay=true; v.loop=true; v.setAttribute('playsinline',''); v.play().catch(e=>console.warn('Vid autoplay failed:',e.message)); });
    // Spoiler click handler (already included inline)
});`;
}

/**
 * Generates HTML files from processed JSON message batches.
 * @param {string} processedMessagesDir Absolute path to processed JSON directory.
 * @param {string} htmlOutputDir Absolute path for HTML output.
 * @param {string} _cssFilePath Ignored parameter. CSS is now embedded.
 * @returns {Promise<void>}
 */
async function generateHtmlFiles(processedMessagesDir, htmlOutputDir, _cssFilePath) {
    // Mark cssFilePath as unused
    logger.logInfo(`Starting HTML generation... Input: ${processedMessagesDir}, Output: ${htmlOutputDir}`);

    try {
        await fs.mkdir(htmlOutputDir, { recursive: true });
    } catch (err) {
        logger.logError(`FATAL: Failed create HTML output dir: ${htmlOutputDir}`, err);
        throw err;
    }

    let filesToProcess = [];
    try {
        const af = await fs.readdir(processedMessagesDir);
        for (const fn of af) {
            const m = fn.match(inputFileRegex);
            if (m && m[1]) {
                const i = parseInt(m[1], 10);
                if (!isNaN(i)) {
                    filesToProcess.push({ index: i, fn: fn, ip: path.join(processedMessagesDir, fn) });
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
    filesToProcess.sort((a, b) => a.index - b.index);
    logger.logInfo(`Found ${filesToProcess.length} processed JSON files.`);

    let allMessages = [];
    for (const fd of filesToProcess) {
        try {
            const js = await fs.readFile(fd.ip, 'utf-8');
            const ms = JSON.parse(js);
            if (Array.isArray(ms)) {
                allMessages.unshift(...ms);
            }
        } catch (re) {
            logger.logError(`Err read/parse ${fd.fn}`, re);
        }
    }
    logger.logInfo(`Total messages loaded for HTML: ${allMessages.length}`);
    if (allMessages.length === 0) {
        logger.logWarn('No valid messages. HTML gen stopped.');
        return;
    }

    const totalPages = 1;
    const htmlContent = discordMessagesToHtml(allMessages);
    const frontendScript = generateFrontendScript();
    const outputPageIndex = 0;
    const outputFilename = `processed_html_${outputPageIndex}.html`;
    const outputPath = path.join(htmlOutputDir, outputFilename);
    const htmlTitle = `Chat Export - Page ${outputPageIndex + 1}`;

    // --- Embedded Discord Dark Mode CSS ---
    const embeddedCss = `
        /* Discord Dark Mode CSS for Exported HTML */
        :root {
            --background-primary: #313338; --background-secondary: #2b2d31; --background-tertiary: #1e1f22;
            --channeltextarea-background: #383a40; --header-primary: #ffffff; --header-secondary: #b8bbbf;
            --text-normal: #dbdee1; --text-muted: #949aa3; --text-link: #00a8fc; --interactive-normal: #b8bbbf;
            --interactive-hover: #dcddde; --interactive-active: #ffffff; --border-color: #40444b;
            --border-subtle: #2a2c31; --mention-color: #7289da; --mention-bg: rgba(88, 101, 242, 0.15);
            --mention-hover-bg: rgba(88, 101, 242, 0.3); --code-bg: #2b2d31; --spoiler-bg: #202225;
            --spoiler-revealed-bg: #292b2f; --bot-tag-bg: #5865f2; --reaction-bg: #2b2d31;
            --reaction-hover-bg: #3c3f45; --reply-border: #4f545c; --scrollbar-thin-thumb: #202225;
            --scrollbar-thin-track: transparent; --scrollbar-auto-thumb: #202225; --scrollbar-auto-track: #2e3338;
            --font-primary: "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
            --font-display: "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
            --font-code: Consolas, "Andale Mono WT", "Andale Mono", "Lucida Console", "Lucida Sans Typewriter", "DejaVu Sans Mono", "Bitstream Vera Sans Mono", "Liberation Mono", "Nimbus Mono L", Monaco, "Courier New", Courier, monospace;
        }
        /* Scrollbar styling */
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-corner { background-color: transparent; }
        ::-webkit-scrollbar-thumb { background-color: var(--scrollbar-auto-thumb); border-radius: 4px; }
        ::-webkit-scrollbar-track { background-color: var(--scrollbar-auto-track); border-radius: 4px; }

        body { background-color: var(--background-primary); color: var(--text-normal); font-family: var(--font-primary); font-size: 16px; margin: 0; padding: 0; overflow-x: hidden; }
        h1 { color: var(--header-primary); font-family: var(--font-display); text-align: center; padding: 20px 10px; margin: 0 0 10px 0; font-weight: 600; border-bottom: 1px solid var(--border-color); background-color: var(--background-secondary); }
        body > p { text-align: center; color: var(--text-muted); font-size: 0.9em; margin-bottom: 20px; }
        .chat-log { padding: 0 10px 20px 10px; }
        .message-container { display: flex; padding: 2px 10px 2px 20px; position: relative; word-wrap: break-word; line-height: 1.375rem; }
        .message-container:hover { background-color: rgba(4, 4, 5, 0.07); }
        .message-gutter { flex-shrink: 0; width: 56px; position: relative; padding-top: 2px; }
        .message-avatar { width: 40px; height: 40px; border-radius: 50%; overflow: hidden; cursor: pointer; margin-right: 16px; position: absolute; left: 0; }
        .message-content { flex-grow: 1; padding-left: 10px; min-width: 0; padding-top: 2px; }
        .message-header { display: flex; align-items: baseline; margin-bottom: 0; white-space: nowrap; }
        .message-author-name { color: var(--header-primary); font-weight: 500; font-size: 1rem; margin-right: 0.25rem; cursor: pointer; }
        .message-author-name:hover { text-decoration: underline; }
        .bot-tag { background-color: var(--bot-tag-bg); color: #fff; font-size: 0.625rem; font-weight: 500; padding: 1px 4px; border-radius: 3px; text-transform: uppercase; margin-left: 4px; vertical-align: baseline; height: 14px; line-height: 14px; }
        .message-timestamp { color: var(--text-muted); font-size: 0.75rem; margin-left: 0.5rem; cursor: default; }
        .message-edited-indicator { color: var(--text-muted); font-size: 0.6875rem; margin-left: 0.25rem; cursor: default; }
        .message-container.grouped { padding-top: 0.1rem; padding-bottom: 0.1rem; margin-top: -1px; }
        .message-container.grouped .message-gutter, .message-container.grouped .message-header { display: none; }
        .message-container.grouped .message-content { padding-left: 66px; }
        .message-container.grouped:hover .message-timestamp { display: inline-block; position: absolute; left: 10px; top: 3px; background: var(--background-primary); padding: 0 5px; }
        .message-container.grouped .message-timestamp { display: none; }
        .reply-context { display: flex; align-items: center; color: var(--interactive-normal); font-size: 0.875rem; margin-bottom: 4px; padding-left: 10px; position: relative; cursor: pointer; }
        .reply-context::before { content: ''; position: absolute; left: 0; top: 50%; width: 20px; height: 10px; border-left: 2px solid var(--reply-border); border-bottom: 2px solid var(--reply-border); border-bottom-left-radius: 6px; transform: translateY(-100%); }
        .reply-avatar { width: 16px; height: 16px; border-radius: 50%; margin-right: 4px; }
        .reply-author-name { color: var(--header-secondary); font-weight: 500; margin-right: 4px; }
        .reply-author-name:hover { text-decoration: underline; }
        .reply-content-preview { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.7; }
        .reply-deleted { color: var(--text-muted); font-style: italic; }
        .message-text { color: var(--text-normal); word-wrap: break-word; white-space: pre-wrap; overflow-wrap: break-word; }
        .message-text a { color: var(--text-link); text-decoration: none; }
        .message-text a:hover { text-decoration: underline; }
        .message-text code, .embed-description code, .embed-field-value code { font-family: var(--font-code); background-color: var(--code-bg); padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.875em; white-space: pre-wrap; word-break: break-all; }
        .mention { color: var(--mention-color); background-color: var(--mention-bg); font-weight: 500; padding: 0 2px; border-radius: 3px; cursor: pointer; transition: background-color 0.1s ease-out; }
        .mention:hover { background-color: var(--mention-hover-bg); color: #fff; text-decoration: none; }
        img.discord-emote { width: 1.375rem; height: 1.375rem; vertical-align: bottom; margin: 0 1px; object-fit: contain; }
        .message-attachments { margin-top: 4px; }
        .attachment { background: none; border: none; padding: 0; margin-top: 5px; display: block; /* Display block for better layout */ max-width: 100%; }
        .attachment-image, .attachment-video, .attachment-audio { max-width: min(100%, 600px); /* Limit width */ max-height: 450px; height: auto; border-radius: 3px; display: block; }
        .attachment-video, .attachment-audio { background-color: #000; }
        .file-attachment { display: flex; align-items: center; background-color: var(--background-secondary); border: 1px solid var(--border-color); padding: 8px 12px; border-radius: 3px; color: var(--text-normal); text-decoration: none; max-width: 400px; }
        .file-attachment:hover { background-color: var(--border-color); }
        .file-attachment span { margin-left: 8px; }
        .attachment-filename { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .attachment-filesize { color: var(--text-muted); font-size: 0.8em; margin-left: auto; padding-left: 10px; }
        .attachment.spoiler { position: relative; cursor: pointer; border-radius: 3px; overflow: hidden; background-color: var(--spoiler-bg); width: fit-content; display: inline-block; } /* Fit content for spoilers */
        .attachment.spoiler:not(.revealed) > *:not(.spoiler-text) { visibility: hidden; }
        .attachment.spoiler.revealed > *:not(.spoiler-text) { visibility: visible; }
        .attachment.spoiler:hover:not(.revealed) { background-color: var(--spoiler-revealed-bg); }
        .attachment.spoiler .spoiler-text { display: none; position: absolute; top: 0; left: 0; width:100%; height:100%; justify-content: center; align-items: center; color: var(--header-secondary); font-weight: 600; font-size: 0.9em; user-select: none; pointer-events: none; padding: 5px 10px; }
        .attachment.spoiler:not(.revealed) .spoiler-text { display: flex; }
        .message-embeds { margin-top: 4px; }
        .embed { background: none; border: none; padding: 0; display: flex; background-color: var(--background-tertiary); border-left: 4px solid var(--border-color); border-radius: 3px; max-width: 520px; margin-bottom: 8px; border: 1px solid var(--border-subtle); } /* Added tertiary bg and subtle border */
        .embed-content { padding: 8px 16px 12px 12px; flex-grow: 1; min-width: 0; }
        .embed-provider, .embed-author, .embed-title, .embed-description, .embed-fields, .embed-footer { margin-bottom: 4px; }
        .embed-provider { color: var(--text-muted); font-size: 0.75rem; }
        .embed-author { display: flex; align-items: center; font-size: 0.875rem; font-weight: 500; }
        .embed-author-icon { width: 20px; height: 20px; border-radius: 50%; margin-right: 8px; }
        .embed-author a, .embed-author span { color: var(--header-primary); text-decoration: none; }
        .embed-author a:hover { text-decoration: underline; }
        .embed-title { font-size: 1rem; font-weight: 600; color: var(--header-primary); }
        .embed-title a { color: var(--text-link); text-decoration: none; }
        .embed-title a:hover { text-decoration: underline; }
        .embed-description { font-size: 0.875rem; color: var(--text-normal); line-height: 1.3; }
        .embed-fields { display: grid; grid-gap: 8px; margin-top: 8px; }
        .embed-field { font-size: 0.875rem; line-height: 1.2; }
        .embed-field-name { font-weight: 600; color: var(--header-primary); margin-bottom: 2px; }
        .embed-field-value { color: var(--text-normal); }
        .embed-thumbnail { flex-shrink: 0; padding: 8px 8px 8px 0; margin-left: 16px; max-width: 80px; max-height: 80px; display: flex; justify-content: center; align-items: center; }
        .embed-thumbnail img { max-width: 100%; max-height: 80px; border-radius: 3px; object-fit: contain; }
        .embed-image { margin-top: 12px; padding: 0 16px 12px 12px; }
        .embed-image img { max-width: 100%; height: auto; max-height: 300px; border-radius: 3px; cursor: pointer; display: block; }
        .embed-video { margin-top: 12px; padding: 0 16px 12px 12px; }
        .embed-video video, .embed-video iframe { max-width: 100%; height: auto; border-radius: 3px; border: none; display: block; }
        .embed-footer { display: flex; align-items: center; font-size: 0.75rem; color: var(--text-muted); margin-top: 8px; }
        .embed-footer-icon { width: 16px; height: 16px; border-radius: 50%; margin-right: 6px; }
        .message-stickers { margin-top: 4px; }
        .sticker { width: 160px; height: 160px; object-fit: contain; margin: 2px; } /* Max sticker size */
        .sticker-lottie { display: inline-block; width: 160px; height: 160px; background: var(--background-tertiary); border: 1px dashed var(--border-color); color: var(--text-muted); font-size: 0.8em; text-align: center; line-height: 160px; border-radius: 5px; }
        .message-reactions { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
        .reaction { background-color: var(--reaction-bg); border: 1px solid var(--border-color); border-radius: 6px; padding: 3px 6px; display: flex; align-items: center; cursor: default; transition: background-color 0.1s ease-out; }
        .reaction:hover { background-color: var(--reaction-hover-bg); border-color: var(--interactive-normal); }
        .reaction-emoji { height: 16px; width: 16px; object-fit: contain; margin-right: 4px; vertical-align: middle; }
        .reaction-count { color: var(--interactive-normal); font-size: 0.875rem; font-weight: 500; min-width: 9px; text-align: center; }
        .message-components { margin-top: 8px; padding: 8px; border: 1px dashed var(--border-color); color: var(--text-muted); font-size: 0.8em; border-radius: 3px; }
        .nav-button { padding: 8px 15px; background-color: var(--button-primary-bg); color: white; border-radius: 5px; text-decoration: none; font-size: 14px; z-index: 1000; box-shadow: 0 2px 5px rgba(0,0,0,0.2); opacity: 0.8; transition: opacity 0.2s; position: fixed; right: 20px; }
        .nav-button:hover { opacity: 1; background-color: var(--button-primary-hover); }
        #prev-page-btn { bottom: 20px; }
        #next-page-btn { top: 20px; }
        video { max-width: 100%; height: auto; } /* Base responsive video */
    `;

    // Create Full HTML Document
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${sanitize(htmlTitle)}</title>
    <style>
        ${embeddedCss}
    </style>
</head>
<body data-total-pages="${totalPages}">
    <h1>${sanitize(htmlTitle)}</h1>
    <p>Total Messages: ${allMessages.length}</p>
    ${htmlContent}
    <script>
        ${frontendScript}
    </script>
</body>
</html>`;

    try {
        await fs.writeFile(outputPath, fullHtml);
        logger.logInfo(`Successfully generated HTML file: ${outputPath}`);
    } catch (writeErr) {
        logger.logError(`Failed to write HTML file: ${outputPath}`, writeErr);
        throw writeErr;
    }
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
    // Pass null or an empty string for cssFilePath as it's ignored
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
