// public/js/export-client.js

function convertEmoteMarkers(text) {
    // First, handle EMOTE<em>MARKER:... </em>
    let updated = text.replace(/EMOTE<em>(MARKER:[^<]+)<\/em>/g, (_, marker) => {
        return `EMOTE_${marker}_`;
    });

    // Handle EMOTEMARKER:downloadedfiles/...
    updated = updated.replace(
        /EMOTEMARKER:downloadedfiles\/([\w\/-]+\.(png|jpg|jpeg|gif|webp))(\w*)/gi,
        (_, filepath, _ext, after) => {
            return `EMOTE_MARKER:downloaded_files/${filepath}|${after}`;
        },
    );

    return updated;
}

document.addEventListener('DOMContentLoaded', () => {
    document.body.innerHTML = convertEmoteMarkers(document.body.innerHTML);
    // --- Get Constants from Data Attributes ---
    const emoteMarkerPrefix = document.body.dataset.emotePrefix || 'EMOTE_MARKER:'; // Fallback just in case
    const totalPages = parseInt(document.body.dataset.totalPages || '0', 10);

    // --- Emote Replacement ---
    try {
        // Build regex dynamically using the prefix from data attribute
        const escapedPrefix = emoteMarkerPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const markerRegex = new RegExp(`${escapedPrefix}([\\w\\/.-]+)\\|([^|]+)`, 'g');

        const elements = document.querySelectorAll(
            '.message-text, .embed-description, .embed-field-value, .reply-content-preview',
        );
        elements.forEach((el) => {
            if (!el.innerHTML) return;
            el.innerHTML = el.innerHTML.replace(markerRegex, (_match, relativePath, altText) => {
                if (!relativePath || relativePath.includes('..') || relativePath.startsWith('/')) {
                    console.warn('Skipping potentially unsafe emote path:', relativePath);
                    // Sanitize alt text before displaying as placeholder text
                    const safeAlt = altText.replace(/"/g, '"').replace(/</g, '<').replace(/>/g, '>');
                    return `[Invalid Emote: ${safeAlt}]`;
                }
                const safePath = encodeURI(relativePath); // Path relative to HTML file
                const safeAlt = altText.replace(/"/g, '"').replace(/</g, '<').replace(/>/g, '>');
                // Use class for styling defined in export-style.css
                return `<img src="${safePath}" alt="${safeAlt}" class="discord-emote" loading="lazy">`;
            });
        });
    } catch (e) {
        console.error('Error processing emote markers:', e);
    }

    // --- Avatar URL Fix (Safeguard) ---
    try {
        document.querySelectorAll('img.message-avatar[src*="cdn.discordapp.com/embed/avatars/"]').forEach((img) => {
            if (img.src.includes('/avatars/-')) {
                // Should be rare now
                console.log('Correcting legacy default avatar URL:', img.src);
                img.src = img.src.replace('/avatars/-', '/avatars/');
            }
        });
    } catch (e) {
        console.error('Error fixing avatar URLs:', e);
    }

    // --- Nav Buttons ---
    try {
        const pageMatch = window.location.pathname.match(/processed_html_(\d+)\.html$/);
        const currentPageIndex = pageMatch ? parseInt(pageMatch[1], 10) : -1;

        if (currentPageIndex !== -1 && totalPages > 0) {
            const createButton = (text, targetIndex, id, position) => {
                if (targetIndex < 0 || targetIndex >= totalPages) return; // Check bounds
                const btn = document.createElement('a');
                btn.textContent = text;
                btn.href = `processed_html_${targetIndex}.html`; // Relative link to other pages
                btn.id = id;
                btn.classList.add('nav-button'); // Style via CSS
                // Apply position dynamically (could also be done via CSS classes)
                btn.style.position = 'fixed';
                btn.style.right = '20px';
                btn.style[position] = '20px'; // 'bottom' or 'top'
                document.body.appendChild(btn);
            };
            createButton('⬅️ Previous', currentPageIndex - 1, 'prev-page-btn', 'bottom');
            createButton('Next ➡️', currentPageIndex + 1, 'next-page-btn', 'top');
        } else if (totalPages <= 1) {
            // Optionally hide or don't create buttons if only one page
            console.log('Navigation buttons skipped: Only one page or page index not found.');
        }
    } catch (e) {
        console.error('Error creating navigation buttons:', e);
    }

    // --- Video Autoplay ---
    try {
        document.querySelectorAll('video.attachment-video, video.embed-video').forEach((video) => {
            video.muted = true; // Required for autoplay usually
            video.autoplay = true;
            video.loop = true;
            video.setAttribute('playsinline', ''); // Good practice for mobile
            video.play().catch((e) => console.warn('Video autoplay failed:', e.message));
        });
    } catch (e) {
        console.error('Error setting up video autoplay:', e);
    }
});
