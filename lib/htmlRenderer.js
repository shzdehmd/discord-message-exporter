// lib/htmlRenderer.js
const logger = require('./logger'); // Use the shared logger

// Define the marker prefix - this MUST match the one used in fileProcessor.js
const EMOTE_MARKER_PREFIX = 'EMOTE_MARKER:';

// --- Sanitization Helper Functions ---

/**
 * Basic HTML entity encoding for content.
 * Encodes &, <, >, ", '
 * @param {string | any} text - Input text.
 * @returns {string} - Sanitized text.
 */
function sanitize(text) {
    if (typeof text !== 'string') return String(text); // Convert non-strings
    const map = { '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" };
    return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Sanitizes text specifically for use within HTML attribute values.
 * Encodes &, <, >, ", '
 * @param {string | any} text - Input text for attribute.
 * @returns {string} - Sanitized text suitable for attribute.
 */
function sanitizeAttribute(text) {
    // For attributes, same encoding as sanitize is generally safe and recommended
    return sanitize(text);
}

// --- Formatting Helper Functions ---

/**
 * Gets the avatar SRC value.
 * If user.avatar contains a slash, assumes it's the relative path from fileProcessor.
 * Otherwise, generates a default Discord avatar URL.
 * @param {object|null} user - The user object (needs id, avatar - path or null).
 * @param {number} [size=64] - Desired size for default fallback.
 * @returns {string} - The avatar SRC value (local path or default URL).
 */
function getAvatarUrl(user, size = 64) {
    const defaultSizeParam = `?size=${size}`;

    // Handle missing user object entirely
    if (!user || typeof user.id !== 'string') {
        logger.logWarn('getAvatarUrl called with invalid user object', user);
        // Fallback to a generic Discord default avatar
        return `https://cdn.discordapp.com/embed/avatars/0.png${defaultSizeParam}`;
    }

    // Check if user.avatar looks like a relative path (contains '/')
    // This path is expected to be relative to the *HTML file's location*
    // e.g., "downloaded_files/avatars/HASH.ext"
    if (typeof user.avatar === 'string' && user.avatar.includes('/')) {
        // Ensure it doesn't start with / or contain .. for basic safety
        if (user.avatar.startsWith('/') || user.avatar.includes('..')) {
            logger.logWarn(`Invalid avatar path detected for user ${user.id}: ${user.avatar}. Using default.`);
        } else {
            // It looks like a valid relative path, sanitize for attribute use
            return sanitizeAttribute(user.avatar);
        }
    }

    // If user.avatar is null, empty, or didn't look like a path, generate default URL
    // Uses the logic from Discord clients to pick one of the 6 default avatars based on ID
    // No need to handle the negative sign issue here, as we construct the URL correctly.
    const defaultAvatarIndex = (parseInt(user.id.slice(-1)) || 0) % 6; // Simpler modulo based on last digit
    // const defaultAvatarIndex = (parseInt(user.id) >> 22) % 6; // Alternative based on older clients/discriminator logic

    return `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png${defaultSizeParam}`;
}

/**
 * Formats an ISO timestamp into a locale-friendly string (e.g., 10/4, 1:33 PM).
 * @param {string|null} isoTimestamp - The ISO timestamp string.
 * @returns {string} - Formatted timestamp or original string on error/invalid input.
 */
function formatTimestamp(isoTimestamp) {
    if (!isoTimestamp || typeof isoTimestamp !== 'string') return '';
    try {
        const date = new Date(isoTimestamp);
        // Check if date is valid
        if (isNaN(date.getTime())) {
            logger.logWarn(`Invalid timestamp format received: ${isoTimestamp}`);
            return isoTimestamp; // Return original invalid string
        }
        // Format using locale settings
        return date.toLocaleString(undefined, {
            // undefined uses user's default locale
            // year: 'numeric', // Optional: Add year if desired
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric', // '2-digit'
            minute: '2-digit',
            hour12: true,
        });
    } catch (e) {
        logger.logError(`Error formatting timestamp: ${isoTimestamp}`, e);
        return isoTimestamp; // Fallback to original on error
    }
}

// --- Embed Rendering Functions ---

/**
 * Creates HTML for a single Discord embed object.
 * Handles various embed types and sanitizes all content.
 * @param {object} embed - The embed object from the processed message.
 * @returns {string} - HTML string representation of the embed.
 */
function createEmbedHtml(embed) {
    // --- Basic Embed Structure ---
    const borderColor = embed.color ? `#${embed.color.toString(16).padStart(6, '0')}` : '#202225'; // Default dark grey
    let html = `<div class="embed ${sanitizeAttribute(
        embed.type || 'rich',
    )}-embed" style="border-left-color: ${sanitizeAttribute(borderColor)};">`; // Main embed container

    // --- Provider ---
    if (embed.provider?.name) {
        html += `<div class="embed-provider">${sanitize(embed.provider.name)}</div>`;
    }

    // --- Author ---
    if (embed.author?.name) {
        html += `<div class="embed-author">`;
        const authorIcon = sanitizeAttribute(embed.author.proxy_icon_url || embed.author.icon_url);
        if (authorIcon) {
            html += `<img src="${authorIcon}" class="embed-author-icon" alt="" loading="lazy">`;
        }
        const authorName = sanitize(embed.author.name);
        if (embed.author.url) {
            html += `<a href="${sanitizeAttribute(
                embed.author.url,
            )}" target="_blank" rel="noopener noreferrer">${authorName}</a>`;
        } else {
            html += `<span>${authorName}</span>`;
        }
        html += `</div>`;
    }

    // --- Title ---
    if (embed.title) {
        const titleContent = sanitize(embed.title);
        html += `<div class="embed-title">`;
        if (embed.url) {
            html += `<a href="${sanitizeAttribute(
                embed.url,
            )}" target="_blank" rel="noopener noreferrer">${titleContent}</a>`;
        } else {
            html += titleContent;
        }
        html += `</div>`;
    }

    // --- Description (with basic markdown support) ---
    if (embed.description) {
        // Basic markdown replacements on *sanitized* text
        let descHtml = sanitize(embed.description)
            .replace(
                /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
                '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
            ) // Links [text](url)
            .replace(/(\*\*\*|___)(.*?)\1/g, '<strong><em>$2</em></strong>') // Bold + Italic
            .replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>') // Bold
            .replace(/(\*|_)(.*?)\1/g, '<em>$2</em>') // Italic
            .replace(/~~(.*?)~~/g, '<del>$1</del>') // Strikethrough
            .replace(/`([^`]+)`/g, '<code>$1</code>'); // Inline Code
        // Note: Does not handle code blocks, blockquotes, lists etc.
        html += `<div class="embed-description">${descHtml}</div>`;
    }

    // --- Fields ---
    if (Array.isArray(embed.fields) && embed.fields.length > 0) {
        html += `<div class="embed-fields">`;
        embed.fields.forEach((field) => {
            if (!field.name || !field.value) return; // Skip invalid fields
            // Apply same basic markdown to field values
            let fieldValueHtml = sanitize(field.value)
                .replace(
                    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
                    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
                )
                .replace(/(\*\*\*|___)(.*?)\1/g, '<strong><em>$2</em></strong>')
                .replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>')
                .replace(/(\*|_)(.*?)\1/g, '<em>$2</em>')
                .replace(/~~(.*?)~~/g, '<del>$1</del>')
                .replace(/`([^`]+)`/g, '<code>$1</code>');

            html += `<div class="embed-field ${field.inline ? 'inline' : ''}">
                        <div class="embed-field-name">${sanitize(field.name)}</div>
                        <div class="embed-field-value">${fieldValueHtml}</div>
                     </div>`;
        });
        html += `</div>`; // end embed-fields
    }

    // --- Thumbnail (if present, typically shown to the right) ---
    // Note: Layout handled by CSS (.embed-grid not implemented here for simplicity, rely on CSS classes)
    if (embed.thumbnail?.url) {
        const thumbnailUrl = sanitizeAttribute(embed.thumbnail.proxy_url || embed.thumbnail.url);
        html += `<div class="embed-thumbnail">
                     <img src="${thumbnailUrl}" alt="Thumbnail" loading="lazy">
                 </div>`;
    }

    // --- Image (if present, typically shown below content) ---
    if (embed.image?.url) {
        const imageUrl = sanitizeAttribute(embed.image.proxy_url || embed.image.url);
        // Wrap image in a link if embed has a main URL
        const linkStart = embed.url
            ? `<a href="${sanitizeAttribute(embed.url)}" target="_blank" rel="noopener noreferrer">`
            : '';
        const linkEnd = embed.url ? '</a>' : '';
        html += `<div class="embed-image">
                    ${linkStart}<img src="${imageUrl}" alt="Image" loading="lazy">${linkEnd}
                 </div>`;
    }

    // --- Video (render if primary type is video, or if URL is direct video link) ---
    // Simplified: Only render if 'video' object exists. More complex embeds (like YouTube) might need iframe.
    if (embed.video?.url) {
        const videoUrl = sanitizeAttribute(embed.video.proxy_url || embed.video.url);
        const posterUrl = sanitizeAttribute(embed.thumbnail?.proxy_url || embed.thumbnail?.url);
        const width = embed.video.width ? `width="${Math.min(embed.video.width, 520)}"` : ''; // Limit width
        const height = embed.video.height ? `height="${Math.min(embed.video.height, 340)}"` : ''; // Limit height

        // Basic video tag - won't work for YouTube embeds etc.
        html += `<div class="embed-video">
                    <video controls preload="metadata" src="${videoUrl}" poster="${
            posterUrl || ''
        }" ${width} ${height} title="Video Embed"></video>
                 </div>`;
        // Future improvement: check videoUrl for youtube/vimeo etc and use iframe instead.
    }

    // --- Footer ---
    if (embed.footer?.text) {
        html += `<div class="embed-footer">`;
        const footerIconUrl = sanitizeAttribute(embed.footer.proxy_icon_url || embed.footer.icon_url);
        if (footerIconUrl) {
            html += `<img src="${footerIconUrl}" class="embed-footer-icon" alt="" loading="lazy">`;
        }
        html += `<span>${sanitize(embed.footer.text)}</span>`;
        // Add timestamp if present in footer *or* top-level embed
        const timestamp = embed.timestamp || embed.footer.timestamp; // Check both places
        if (timestamp) {
            html += ` • <span class="embed-footer-timestamp" title="${sanitizeAttribute(timestamp)}">${formatTimestamp(
                timestamp,
            )}</span>`;
        }
        html += `</div>`;
    }

    html += `</div>`; // end embed container
    return html;
}

// --- Message Content Processing ---

/**
 * Processes raw message content string for HTML display.
 * Handles basic markdown, mentions, and leaves EMOTE_MARKERs intact.
 * @param {string} rawContent - The message content string (potentially with markers).
 * @param {Array<object>} mentions - Array of user mention objects from the message.
 * @param {object} message - The full message object (for context like channel/role mentions).
 * @returns {string} - Processed HTML string ready for insertion.
 */
function processMessageContent(rawContent, mentions = [], message = {}) {
    if (typeof rawContent !== 'string' || !rawContent) return '';

    // 1. Sanitize initial content (encode &, <, >)
    let processedContent = rawContent.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');

    // // --- Placeholder Strategy for Emote Markers ---
    // const markerPlaceholders = [];
    // const placeholderPrefix = 'GKGKEMOTEGKGKPLACEHOLDERGKGK';
    // const escapedEmotePrefix = EMOTE_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // // Regex to find the entire marker structure
    // const markerFinderRegex = new RegExp(`(${escapedEmotePrefix}[^\\s]+)`, 'g');

    // // Temporarily replace markers with safe placeholders
    // processedContent = processedContent.replace(markerFinderRegex, (match) => {
    //     const placeholder = `${placeholderPrefix}${markerPlaceholders.length}___`;
    //     markerPlaceholders.push(match); // Store the original marker
    //     return placeholder;
    // });
    // // --- End Placeholder Strategy ---

    // 2. Apply basic Markdown (similar to embed description)
    // Order matters: bold/italic combined first
    processedContent = processedContent
        .replace(/(\*\*\*|___)(.*?)\1/g, '<strong><em>$2</em></strong>')
        .replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>')
        .replace(/(\*|_)(.*?)\1/g, '<em>$2</em>')
        .replace(/~~(.*?)~~/g, '<del>$1</del>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    // TODO: Add support for multiline code blocks (```), blockquotes (>), spoilers (||) if needed.

    // 3. Process Mentions (User, Channel, Role)
    // User mentions: Use the provided mentions array for better names
    mentions.forEach((mention) => {
        if (mention?.id) {
            const name = sanitize(mention.global_name || mention.username || `User ${mention.id}`);
            // Regex to find <@USER_ID> or <@!USER_ID> (nickname mention)
            const mentionRegex = new RegExp(`<@!?${mention.id}>`, 'g');
            processedContent = processedContent.replace(
                mentionRegex,
                `<span class="mention user-mention" title="${sanitizeAttribute(name)} (ID: ${
                    mention.id
                })">@${name}</span>`,
            );
        }
    });

    // Channel mentions: <#CHANNEL_ID>
    processedContent = processedContent.replace(/<#(\d+)>/g, (match, channelId) => {
        // Try to find channel name from message.mention_channels if available
        const mentionedChannel = message.mention_channels?.find((ch) => ch.id === channelId);
        const name = sanitize(mentionedChannel?.name || `channel-${channelId}`);
        return `<span class="mention channel-mention" title="Channel ID: ${channelId}">#${name}</span>`;
    });

    // Role mentions: <@&ROLE_ID>
    processedContent = processedContent.replace(/<@&(\d+)>/g, (match, roleId) => {
        // Finding role names is harder without guild context, use placeholder
        const name = `Role ${roleId}`;
        return `<span class="mention role-mention" title="Role ID: ${roleId}">@${sanitize(name)}</span>`;
    });

    // 4. Convert Newlines to <br> tags for HTML display
    processedContent = processedContent.replace(/\n/g, '<br>\n');

    // // --- Restore Emote Markers ---
    // // Put the original markers back where the placeholders were
    // processedContent = processedContent.replace(/GKGKEMOTEGKGKPLACEHOLDERGKGK(\d+)___/g, (match, index) => {
    //     const originalMarker = markerPlaceholders[parseInt(index, 10)];
    //     // Return the original marker, ensuring it wasn't accidentally sanitized earlier
    //     // (It shouldn't have been because '<' and '>' were replaced by placeholders)
    //     return originalMarker || match; // Fallback just in case
    // });
    // // --- End Restore ---

    // EMOTE_MARKERs are left untouched here - they will be handled by front-end JS

    return processedContent;
}

// --- Main Message Rendering Functions ---

/**
 * Converts a single processed Discord message object into an HTML string.
 * Assumes file URLs, avatars, and emotes have been processed into local paths/markers.
 * @param {object} message - The processed Discord message object.
 * @param {boolean} isGrouped - Whether this message is grouped with the previous one.
 * @returns {string} - HTML string for the message.
 */
function discordMessageToHtmlSingle(message, isGrouped = false) {
    // Basic validation
    if (!message || !message.author || !message.id || !message.timestamp) {
        logger.logWarn('Skipping rendering invalid message object:', message?.id || 'No ID');
        return `<!-- Invalid msg data: ${message?.id || 'No ID'} -->`;
    }

    const author = message.author;
    const authorName = sanitize(author.global_name || author.username || 'Unknown User');
    // getAvatarUrl expects relative path like "downloaded_files/avatars/HASH.ext" or null
    const avatarUrl = getAvatarUrl(author);
    const timestampStr = formatTimestamp(message.timestamp);
    const editedStr = message.edited_timestamp
        ? `<span class="message-edited-indicator" title="Edited: ${formatTimestamp(
              message.edited_timestamp,
          )}">(edited)</span>`
        : '';

    let messageClasses = 'message-container';
    if (isGrouped) messageClasses += ' grouped';

    let html = `<div class="${messageClasses}" id="message-${message.id}">`; // Start message container

    // --- Gutter (Avatar) ---
    html += `<div class="message-gutter">`;
    if (!isGrouped) {
        // Only show avatar for the first message in a group
        html += `<img class="message-avatar" src="${avatarUrl}" alt="" title="${sanitizeAttribute(authorName)} (ID: ${
            author.id
        })" loading="lazy">`;
    }
    html += `</div>`; // End gutter

    // --- Content ---
    html += `<div class="message-content">`;

    // --- Header (Username, Badges, Timestamp) ---
    if (!isGrouped) {
        // Only show header for the first message in a group
        html += `<div class="message-header">`;
        html += `<span class="message-author-name">${authorName}</span>`;
        // Add BOT tag if applicable
        if (author.bot) html += `<span class="bot-tag">BOT</span>`;
        // Could add other badges here (system message indicator, etc.)
        html += `<span class="message-timestamp" title="${sanitizeAttribute(
            message.timestamp,
        )}">${timestampStr}</span>`;
        html += editedStr;
        html += `</div>`; // End header
    }

    // --- Reply Context ---
    // Render if message is a reply and referenced message data exists
    if ((message.type === 19 || message.message_reference) && message.referenced_message) {
        const repliedMsg = message.referenced_message;
        const repliedAuthor = repliedMsg.author;
        html += `<div class="reply-context" onclick="document.getElementById('message-${repliedMsg.id}')?.scrollIntoView({ behavior: 'smooth', block: 'center' })" title="Reply to message ID: ${repliedMsg.id}">`;
        if (repliedAuthor?.id) {
            const repliedAuthorName = sanitize(repliedAuthor.global_name || repliedAuthor.username || 'Unknown User');
            const repliedAvatarUrl = getAvatarUrl(repliedAuthor, 32);
            let previewText = '';

            // --- Generate Preview Text - Smarter Truncation ---
            const MAX_PREVIEW_LENGTH = 80; // Define max length

            if (repliedMsg.content) {
                previewText = repliedMsg.content;

                // Simplify mentions FIRST (replace with a simple string)
                previewText = previewText.replace(/<[@#][!&]?\d+>/g, `@mention`);

                // Now, check length and truncate carefully
                if (previewText.length > MAX_PREVIEW_LENGTH) {
                    let truncated = previewText.substring(0, MAX_PREVIEW_LENGTH);
                    // Check if the truncation point is inside a potential marker
                    // A simple check: does the truncated part contain the prefix but not the closing part (e.g., '|')?
                    const markerPrefixIndex = truncated.lastIndexOf(EMOTE_MARKER_PREFIX);
                    if (markerPrefixIndex !== -1 && !truncated.substring(markerPrefixIndex).includes('|')) {
                        // Truncated inside a marker, cut *before* the marker starts
                        truncated = previewText.substring(0, markerPrefixIndex);
                        // Trim trailing whitespace if any after cutting before marker
                        truncated = truncated.trimEnd();
                    }
                    previewText = truncated + '...';
                }

                // Sanitize the final preview text AFTER potential truncation
                previewText = sanitize(previewText);
            } else if (repliedMsg.sticker_items?.length > 0) {
                previewText = `[Sticker: ${sanitize(repliedMsg.sticker_items[0].name)}]`;
            } else if (repliedMsg.attachments?.length > 0) {
                previewText = `[Attachment: ${sanitize(repliedMsg.attachments[0].filename)}]`;
            } else if (repliedMsg.embeds?.length > 0) {
                previewText = `[Embed: ${sanitize(repliedMsg.embeds[0].title || 'Embed')}]`;
            } else {
                previewText = '[Empty Message]';
            }
            // --- End Preview Text Generation ---

            html += `<img class="reply-avatar" src="${repliedAvatarUrl}" alt="" loading="lazy">`;
            html += `<span class="reply-author-name">${repliedAuthorName}</span>`;
            html += `<span class="reply-content-preview">${previewText}</span>`; // previewText contains markers if they survived truncation
        } else {
            html += `<span class="reply-deleted">[Original Message Deleted/Unknown]</span>`;
        }
        html += `</div>`; // End reply-context
    }

    // --- Message Text Content ---
    // Use the processor function, passing mentions and the message object
    const messageTextHtml = processMessageContent(message.content, message.mentions, message);
    if (messageTextHtml) {
        html += `<div class="message-text">${messageTextHtml}</div>`;
    }

    // --- Attachments ---
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        html += `<div class="message-attachments">`;
        message.attachments.forEach((att) => {
            // attachment.url should now be the *relative local path* from fileProcessor
            const url = sanitizeAttribute(att.url || ''); // Sanitize the local path
            const filename = sanitizeAttribute(att.filename || 'attachment');
            const ct = att.content_type || '';
            const isImage = ct.startsWith('image/');
            const isVideo = ct.startsWith('video/');
            const isAudio = ct.startsWith('audio/');
            const isSpoiler = (att.flags & 8192) === 8192; // Check spoiler flag

            // Basic structure, might need refinement based on attachment type
            html += `<div class="attachment ${isSpoiler ? 'spoiler' : ''}" ${
                isSpoiler ? 'onclick="this.classList.toggle(\'revealed\')"' : ''
            }>`;
            if (isSpoiler) html += `<span class="spoiler-text">SPOILER</span>`; // Clickable spoiler overlay handled by CSS/JS

            if (isImage) {
                html += `<a href="${url}" target="_blank" rel="noopener noreferrer" class="attachment-link">
                            <img src="${url}" alt="${filename}" title="${filename}" loading="lazy" class="attachment-image">
                         </a>`;
            } else if (isVideo) {
                html += `<video controls preload="metadata" src="${url}" title="${filename}" class="attachment-video"></video>`;
            } else if (isAudio) {
                html += `<audio controls preload="metadata" src="${url}" title="${filename}" class="attachment-audio"></audio>`;
            } else {
                // Generic file download link
                const size = att.size ? `(${(att.size / 1024).toFixed(1)} KB)` : '';
                html += `<a href="${url}" target="_blank" rel="noopener noreferrer" download="${filename}" class="attachment-link file-attachment">
                            📄 <span class="attachment-filename">${filename}</span> <span class="attachment-filesize">${size}</span>
                         </a>`;
            }
            html += `</div>`; // end attachment
        });
        html += `</div>`; // end message-attachments
    }

    // --- Embeds ---
    if (Array.isArray(message.embeds) && message.embeds.length > 0) {
        html += `<div class="message-embeds">`;
        message.embeds.forEach((embed) => {
            html += createEmbedHtml(embed); // Use the dedicated embed renderer
        });
        html += `</div>`; // end message-embeds
    }

    // --- Stickers ---
    if (Array.isArray(message.sticker_items) && message.sticker_items.length > 0) {
        html += `<div class="message-stickers">`;
        message.sticker_items.forEach((sticker) => {
            // Sticker URLs are usually direct CDN links and not downloaded locally by default
            // Adjust if fileProcessor is modified to download stickers
            let stickerUrl = '';
            if (sticker.format_type === 1)
                stickerUrl = `https://media.discordapp.net/stickers/${sticker.id}.png?size=160`; // Standard PNG
            else if (sticker.format_type === 2)
                stickerUrl = `https://media.discordapp.net/stickers/${sticker.id}.png?size=160`; // APNG (treat as PNG)
            else if (sticker.format_type === 3)
                stickerUrl = `https://media.discordapp.net/stickers/${sticker.id}.lottie`; // Lottie (JSON) - harder to render directly
            else if (sticker.format_type === 4)
                stickerUrl = `https://media.discordapp.net/stickers/${sticker.id}.gif?size=160`; // GIF

            if (stickerUrl && sticker.format_type !== 3) {
                // Render PNG/GIF
                html += `<img class="sticker" src="${sanitizeAttribute(stickerUrl)}" alt="${sanitizeAttribute(
                    sticker.name,
                )}" title="${sanitizeAttribute(sticker.name)}" loading="lazy">`;
            } else if (sticker.format_type === 3) {
                html += `<div class="sticker sticker-lottie" title="${sanitizeAttribute(
                    sticker.name,
                )}">[Lottie Sticker: ${sanitize(sticker.name)}]</div>`; // Placeholder for Lottie
            }
        });
        html += `</div>`; // end message-stickers
    }

    // --- Reactions ---
    if (Array.isArray(message.reactions) && message.reactions.length > 0) {
        html += `<div class="message-reactions">`;
        message.reactions.forEach((reaction) => {
            const emoji = reaction.emoji;
            let emojiHtml = '';
            if (emoji.id) {
                // Custom emote
                // Assume custom reaction emojis are NOT downloaded locally by default
                // Construct CDN URL. Use 'webp' for potentially smaller size, fallback 'png'.
                const emoteUrl = `https://cdn.discordapp.com/emojis/${emoji.id}.webp?size=48`;
                // Could add a fallback src to .png if webp fails, or just rely on browser support
                emojiHtml = `<img class="reaction-emoji custom-emoji" src="${sanitizeAttribute(
                    emoteUrl,
                )}" alt="${sanitizeAttribute(emoji.name || '')}" loading="lazy">`;
            } else {
                // Standard Unicode emoji
                emojiHtml = `<span class="reaction-emoji unicode-emoji">${sanitize(emoji.name)}</span>`;
            }
            const count = reaction.count > 1 ? `<span class="reaction-count">${reaction.count}</span>` : '';
            html += `<span class="reaction" title="${sanitizeAttribute(emoji.name || '')}">${emojiHtml}${count}</span>`;
        });
        html += `</div>`; // end message-reactions
    }

    // --- Components Placeholder ---
    if (Array.isArray(message.components) && message.components.length > 0) {
        html += `<div class="message-components">[Interactive Components Not Rendered]</div>`;
    }

    html += `</div>`; // End message-content
    html += `</div>`; // End message-container
    return html;
}

/**
 * Converts an array of processed Discord message objects into a single HTML block.
 * Groups consecutive messages by the same author within a threshold.
 * Messages should be chronologically sorted (oldest first) before passing here.
 * @param {Array<object>} messagesArray - Array of processed messages (oldest first).
 * @returns {string} - Combined HTML string for the chat log.
 */
function discordMessagesToHtml(messagesArray) {
    if (!Array.isArray(messagesArray)) {
        logger.logError('discordMessagesToHtml received non-array input:', typeof messagesArray);
        return '<div class="chat-log error">Error: Invalid message data provided for rendering.</div>';
    }
    if (messagesArray.length === 0) {
        return '<div class="chat-log empty">No messages to display.</div>';
    }

    let finalHtml = '<div class="chat-log">\n';
    // Time threshold for grouping messages (e.g., 7 minutes)
    const groupingThresholdMs = 7 * 60 * 1000;

    for (let i = 0; i < messagesArray.length; i++) {
        const currentMsg = messagesArray[i];
        const prevMsg = i > 0 ? messagesArray[i - 1] : null;
        let isGrouped = false;

        // Determine if the current message should be grouped with the previous one
        if (
            prevMsg &&
            currentMsg.author?.id && // Ensure current author exists
            prevMsg.author?.id === currentMsg.author.id && // Same author
            !currentMsg.referenced_message && // Not a reply
            !currentMsg.message_reference && // Not a reply (redundant check?)
            (currentMsg.type === 0 || currentMsg.type === 19) && // Standard message or reply type
            (prevMsg.type === 0 || prevMsg.type === 19) && // Previous was standard or reply
            !currentMsg.call && // Not a call message
            currentMsg.webhook_id === prevMsg.webhook_id && // Ensure not switching between user/webhook
            currentMsg.author.bot === prevMsg.author.bot && // Ensure not switching between user/bot
            new Date(currentMsg.timestamp).getTime() - new Date(prevMsg.timestamp).getTime() < groupingThresholdMs // Within time threshold
        ) {
            isGrouped = true;
        }

        // Render the single message HTML, passing the grouping status
        try {
            finalHtml += discordMessageToHtmlSingle(currentMsg, isGrouped) + '\n';
        } catch (renderError) {
            logger.logError(`Error rendering single message ID ${currentMsg?.id}`, renderError);
            finalHtml += `<!-- Error rendering message ID ${currentMsg?.id}: ${sanitize(renderError.message)} -->\n`;
        }
    }

    finalHtml += '</div>'; // End chat-log
    return finalHtml;
}

// Export the main function needed by the conversion script
module.exports = {
    discordMessagesToHtml,
    discordMessageToHtmlSingle,
    // Expose EMOTE_MARKER_PREFIX if needed by the conversion script for the front-end script generation
    EMOTE_MARKER_PREFIX,
};
