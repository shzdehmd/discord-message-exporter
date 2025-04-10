const { fetch } = require('undici');
require('dotenv').config(); // Ensure environment variables are loaded
const logger = require('./logger'); // Path is relative to this file within 'lib'

const BASE_API_URL = 'https://discord.com/api/v10'; // Use v10

// --- Helper function for making authenticated API requests ---
async function makeDiscordRequest(token, url, method = 'GET') {
    logger.logInfo(`Making Discord API request: ${method} ${url}`);
    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                Authorization: token, // User tokens might need "Bearer <token>" or just "<token>", Bot tokens need "Bot <token>" - check Discord docs if issues arise
                Accept: 'application/json', // Prefer JSON responses
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin',
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36', // Be a good API citizen // NO!
            },
            signal: AbortSignal.timeout(15000), // 15 second timeout
        });

        // Check for rate limits first
        if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after'); // Seconds
            const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000; // Default to 5s
            logger.logWarn(`Rate limited by Discord API. Waiting ${retryMs}ms. URL: ${url}`);
            await new Promise((resolve) => setTimeout(resolve, retryMs));
            // Retry the request once after waiting
            logger.logInfo(`Retrying request after rate limit wait: ${method} ${url}`);
            return makeDiscordRequest(token, url, method); // Recursive call for retry
        }

        // Check for other errors
        if (!response.ok) {
            let errorBody = null;
            let errorText = `Status ${response.status}: ${response.statusText}`;
            try {
                errorBody = await response.json();
                logger.logError(`Discord API request failed (${url})`, {
                    status: response.status,
                    statusText: response.statusText,
                    body: errorBody,
                });
                if (errorBody && errorBody.message) {
                    errorText += ` - ${errorBody.message}`;
                    if (errorBody.code) errorText += ` (Code: ${errorBody.code})`;
                }
            } catch (e) {
                try {
                    errorBody = await response.text(); // Read as text if not JSON
                    logger.logError(`Discord API request failed (${url}) and response body was not JSON`, {
                        status: response.status,
                        statusText: response.statusText,
                        body: errorBody, // Log the raw text
                    });
                } catch (textError) {
                    logger.logError(
                        `Discord API request failed (${url}) and failed to read response body`,
                        { status: response.status, statusText: response.statusText },
                        textError,
                    );
                }
            }
            const apiError = new Error(`Discord API Error: ${errorText}`);
            apiError.status = response.status;
            apiError.responseBody = errorBody;
            // Specific handling for common errors
            if (response.status === 401) apiError.message = 'Discord API Error: Unauthorized (Invalid Token?)';
            if (response.status === 403) apiError.message = 'Discord API Error: Forbidden (Missing Permissions?)';
            throw apiError;
        }

        // Check content type before parsing JSON
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            const data = await response.json();
            return data;
        } else {
            // Handle cases where response might be empty or not JSON (e.g., successful DELETE)
            logger.logWarn(
                `Discord API response for ${url} was not JSON (Content-Type: ${contentType}). Status: ${response.status}`,
            );
            return null; // Or handle as needed based on the specific endpoint
        }
    } catch (error) {
        // Handle network errors, timeouts, or errors thrown above
        if (error instanceof Error && error.message.startsWith('Discord API Error:')) {
            // Logged already, re-throw
            throw error;
        } else if (error.name === 'TimeoutError') {
            logger.logError(`Discord API request timed out: ${method} ${url}`, error);
            throw new Error(`Discord API Error: Request timed out (${url})`);
        } else {
            logger.logError(`Network or other error during Discord API request: ${method} ${url}`, error);
            throw new Error(`Network or other error during Discord API request: ${error.message}`); // Rethrow a generic error
        }
    }
}

/**
 * Fetches the list of guilds (servers) for the authorized Discord token.
 * @param {string} token - Discord User or Bot token.
 * @returns {Promise<Array<object>>} - A promise resolving to an array of guild objects.
 * @throws {Error} - Throws an error if the fetch fails or Discord API returns an error.
 */
const fetchGuilds = async (token) => {
    const url = `${BASE_API_URL}/users/@me/guilds`;
    try {
        const data = await makeDiscordRequest(token, url);
        if (!Array.isArray(data)) {
            logger.logWarn(`Unexpected response format from GET ${url} (expected array):`, data);
            throw new Error('Unexpected response format when fetching guilds.');
        }
        logger.logInfo(`Successfully fetched ${data.length} guilds.`);
        return data;
    } catch (error) {
        logger.logError(`Error during fetchGuilds operation`, error);
        // Don't log again here, makeDiscordRequest already logged details
        throw error; // Re-throw the error for the route handler
    }
};

/**
 * Fetches channels for a given guild.
 * @param {string} token - Discord User or Bot token.
 * @param {string} guildId - The ID of the guild.
 * @returns {Promise<Array<object>>} - A promise resolving to an array of channel objects.
 * @throws {Error} - Throws an error if the fetch fails or Discord API returns an error.
 */
const fetchChannels = async (token, guildId) => {
    const url = `${BASE_API_URL}/guilds/${guildId}/channels`;
    try {
        const data = await makeDiscordRequest(token, url);
        if (!Array.isArray(data)) {
            logger.logWarn(`Unexpected response format from GET ${url} (expected array):`, data);
            throw new Error(`Unexpected response format when fetching channels for guild ${guildId}.`);
        }

        // Optional: Filter for specific channel types relevant for exporting messages
        // 0: GUILD_TEXT, 5: GUILD_NEWS,
        // 10: GUILD_NEWS_THREAD, 11: GUILD_PUBLIC_THREAD, 12: GUILD_PRIVATE_THREAD
        // 4: GUILD_CATEGORY (useful for grouping)
        const relevantChannelTypes = [0, 4, 5, 10, 11, 12];
        const filteredChannels = data.filter((ch) => relevantChannelTypes.includes(ch.type));

        logger.logInfo(
            `Successfully fetched ${data.length} channels for guild ${guildId}, filtered to ${filteredChannels.length} relevant channels.`,
        );
        return filteredChannels; // Return the filtered list
        // return data; // Or return all channels if filtering isn't desired here
    } catch (error) {
        logger.logError(`Error during fetchChannels operation for guild ${guildId}`, error);
        throw error;
    }
};

/**
 * Fetches active and public archived threads for a given channel.
 * Discord API for threads can be complex (active, private archived, public archived).
 * This focuses on publicly accessible ones relevant for general export.
 * @param {string} token - Discord User or Bot token.
 * @param {string} channelId - The ID of the channel to fetch threads from.
 * @param {number} channelType - The numeric type of the channel (e.g., 0 for GUILD_TEXT).
 * @returns {Promise<Array<object>>} - A promise resolving to an array of combined thread objects.
 * @throws {Error} - Throws an error if any underlying fetch fails.
 */
const fetchThreads = async (token, channelId, channelType) => {
    // Types that can contain threads we can typically access
    const supportedParentTypes = [0, 5]; // GUILD_TEXT, GUILD_NEWS

    if (!supportedParentTypes.includes(channelType)) {
        // logger.logInfo(`Skipping thread fetch for channel ${channelId} (type ${channelType}) - parent type doesn't support threads.`);
        return []; // Not an error, just no threads expected
    }

    const activeUrl = `${BASE_API_URL}/channels/${channelId}/threads/active`;
    const archivedUrl = `${BASE_API_URL}/channels/${channelId}/threads/archived/public`; // Only public archived

    let activeThreads = [];
    let archivedThreads = [];

    try {
        // Fetch Active Threads
        logger.logInfo(`Fetching active threads for channel ${channelId}`);
        const activeData = await makeDiscordRequest(token, activeUrl);
        // API returns { threads: [...], members: [...] }
        if (activeData && Array.isArray(activeData.threads)) {
            activeThreads = activeData.threads.map((t) => ({ ...t, status: 'active' })); // Add status marker
            logger.logInfo(`Fetched ${activeThreads.length} active threads for channel ${channelId}`);
        } else {
            logger.logWarn(`Unexpected active threads response format for ${channelId}`, activeData);
        }
    } catch (error) {
        // 403 Forbidden might mean no access to the channel itself, 404 Not Found is less likely here
        if (error.status === 403 || error.status === 404) {
            logger.logWarn(
                `Could not fetch active threads for channel ${channelId} (Status: ${error.status}). Skipping active threads.`,
                error.message,
            );
        } else {
            logger.logError(`Error fetching active threads for channel ${channelId}.`, error);
            throw error; // Re-throw other errors
        }
    }

    try {
        // Fetch Public Archived Threads
        logger.logInfo(`Fetching public archived threads for channel ${channelId}`);
        const archivedData = await makeDiscordRequest(token, archivedUrl);
        // API returns { threads: [...], members: [...], has_more: bool }
        if (archivedData && Array.isArray(archivedData.threads)) {
            archivedThreads = archivedData.threads.map((t) => ({ ...t, status: 'archived' })); // Add status marker
            logger.logInfo(
                `Fetched ${archivedThreads.length} public archived threads for channel ${channelId}. Has More: ${archivedData.has_more}`,
            );
            // Note: We are ignoring has_more for simplicity now. Pagination would be needed for complete archives.
        } else {
            logger.logWarn(`Unexpected public archived threads response format for ${channelId}`, archivedData);
        }
    } catch (error) {
        if (error.status === 403 || error.status === 404) {
            logger.logWarn(
                `Could not fetch public archived threads for channel ${channelId} (Status: ${error.status}). Skipping archived threads.`,
                error.message,
            );
        } else {
            logger.logError(`Error fetching public archived threads for channel ${channelId}.`, error);
            throw error; // Re-throw other errors
        }
    }

    // Combine and return
    const allThreads = [...activeThreads, ...archivedThreads];
    logger.logInfo(`Total threads combined for channel ${channelId}: ${allThreads.length}`);
    return allThreads;
};

module.exports = {
    fetchGuilds,
    fetchChannels,
    fetchThreads,
    // We don't export makeDiscordRequest as it's an internal helper
};
