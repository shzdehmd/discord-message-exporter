// lib/discordApi.js
const { fetch } = require('undici');
require('dotenv').config(); // Ensure environment variables are loaded
const logger = require('./logger'); // Ensure you have a logger module at this path

// Use v10 for all endpoints
const BASE_API_URL = 'https://discord.com/api/v10';

/**
 * Helper function for making authenticated Discord API requests.
 * Includes headers often required for user tokens and handles rate limiting.
 * @param {string} token - Discord User or Bot token (ensure correct format, e.g., Bot tokens need "Bot prefix").
 * @param {string} url - The full Discord API URL to request.
 * @param {string} [method='GET'] - The HTTP method (GET, POST, PUT, DELETE, etc.).
 * @returns {Promise<object|string|null>} - A promise resolving to the parsed JSON response, raw text, or null for empty responses.
 * @throws {Error} - Throws a detailed error if the request fails, times out, or Discord returns an error status.
 */
async function makeDiscordRequest(token, url, method = 'GET') {
    logger.logInfo(`Making Discord API request: ${method} ${url}`);

    // Define headers based on user specification, ensuring Authorization uses the passed token
    const headers = {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        authorization: token, // Use the passed token
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        priority: 'u=1, i',
        'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'x-debug-options': 'bugReporterEnabled',
        'x-discord-locale': 'en-US',
        'x-discord-timezone': 'Asia/Karachi',
        'x-super-properties': Buffer.from(
            JSON.stringify({
                os: 'Linux',
                browser: 'Chrome',
                device: '',
                system_locale: 'en-US',
                has_client_mods: false,
                browser_user_agent:
                    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
                browser_version: '135.0.0.0',
                os_version: '',
                referrer: '',
                referring_domain: '',
                referrer_current: '',
                referring_domain_current: '',
                release_channel: 'stable',
                client_build_number: 388773,
                client_event_source: null,
            }),
        ).toString('base64'),
        Referer: url.includes('/channels/')
            ? `https://discord.com/channels/@me/${url.split('/channels/')[1].split('/')[0]}`
            : 'https://discord.com/',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
    };

    try {
        const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(20000) });

        // Rate Limit Handling
        if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 + 500 : 5000;
            logger.logWarn(`Rate limited by Discord API. Waiting ${retryMs}ms. URL: ${url}`);
            await new Promise((resolve) => setTimeout(resolve, retryMs));
            logger.logInfo(`Retrying request after rate limit wait: ${method} ${url}`);
            return makeDiscordRequest(token, url, method);
        }

        // Error Handling
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
                if (errorBody?.message) errorText += ` - ${errorBody.message}`;
                if (errorBody?.code) errorText += ` (Code: ${errorBody.code})`;
                if (response.status === 401 && errorBody?.message === '401: Unauthorized')
                    errorText = 'Discord API Error: Unauthorized (Invalid Token or Headers/Flags issue)';
                if (response.status === 403)
                    errorText =
                        'Discord API Error: Forbidden (Missing Permissions, endpoint requires different auth/flags, or User Account flagged?)';
            } catch (e) {
                try {
                    errorBody = await response.text();
                    logger.logError(`Discord API request failed (${url}) and response body was not JSON`, {
                        status: response.status,
                        statusText: response.statusText,
                        body: errorBody,
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
            throw apiError;
        }

        // Success Handling
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
            return await response.json();
        }
        if (response.status === 204) {
            logger.logInfo(`Discord API request successful with 204 No Content: ${method} ${url}`);
            return null;
        }
        logger.logWarn(
            `Discord API response for ${url} was not JSON (Content-Type: ${contentType}). Status: ${response.status}`,
        );
        try {
            const textData = await response.text();
            logger.logInfo(`Non-JSON response body for ${url}: ${textData.substring(0, 100)}...`);
            return textData;
        } catch {
            return null;
        }
    } catch (error) {
        // Handle network errors, timeouts, or errors thrown from response handling
        if (error instanceof Error && error.message.startsWith('Discord API Error:')) {
            throw error;
        }
        if (error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError') {
            logger.logError(`Discord API request timed out: ${method} ${url}`, error);
            throw new Error(`Discord API Error: Request timed out (${url})`);
        }
        logger.logError(`Network or other error during Discord API request: ${method} ${url}`, error);
        throw new Error(`Network or other error during Discord API request: ${error.message}`);
    }
}

// --- fetchGuilds ---
/**
 * Fetches the list of guilds (servers) for the authorized Discord token.
 * @param {string} token - Discord User or Bot token.
 * @returns {Promise<Array<object>>} - A promise resolving to an array of guild objects.
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
        throw error;
    }
};

// --- fetchChannels ---
/**
 * Fetches channels for a given guild.
 * @param {string} token - Discord User or Bot token.
 * @param {string} guildId - The ID of the guild.
 * @returns {Promise<Array<object>>} - A promise resolving to an array of channel objects (filtered).
 */
const fetchChannels = async (token, guildId) => {
    const url = `${BASE_API_URL}/guilds/${guildId}/channels`;
    try {
        const data = await makeDiscordRequest(token, url);
        if (!Array.isArray(data)) {
            logger.logWarn(`Unexpected response format from GET ${url} (expected array):`, data);
            throw new Error(`Unexpected response format when fetching channels for guild ${guildId}.`);
        }
        const relevantChannelTypes = [0, 4, 5, 10, 11, 12]; // Text, Category, News, Threads...
        const filteredChannels = data.filter((ch) => relevantChannelTypes.includes(ch.type));
        logger.logInfo(
            `Successfully fetched ${data.length} channels for guild ${guildId}, filtered to ${filteredChannels.length} relevant channels.`,
        );
        return filteredChannels;
    } catch (error) {
        logger.logError(`Error during fetchChannels operation for guild ${guildId}`, error);
        throw error;
    }
};

// --- Internal Helper for Paginated Thread Search ---
/**
 * Performs a paginated search for threads (either active or archived).
 * @param {string} token - Discord User token.
 * @param {string} channelId - The ID of the channel to search in.
 * @param {boolean} searchArchived - If true, searches archived threads; otherwise searches active.
 * @returns {Promise<Array<object>>} - A promise resolving to an array of threads found.
 */
const _searchThreadsPaginated = async (token, channelId, searchArchived) => {
    let threads = [];
    let offset = 0;
    const limit = 25;
    let hasMore = true;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;
    const searchType = searchArchived ? 'archived' : 'active';

    logger.logInfo(`Starting paginated search for ${searchType} threads in channel ${channelId}`);

    while (hasMore && consecutiveErrors < maxConsecutiveErrors) {
        // Build base URL part
        const baseUrl = `${BASE_API_URL}/channels/${channelId}/threads/search`;
        // Build query parameters using URLSearchParams
        const params = new URLSearchParams({
            sort_by: 'last_message_time',
            sort_order: 'desc',
            limit: limit.toString(),
            offset: offset.toString(),
            tag_setting: 'match_some',
        });
        // Conditionally add the 'archived' parameter
        if (searchArchived) {
            params.append('archived', 'true');
        }
        // Full URL with query string
        const searchUrl = `${baseUrl}?${params.toString()}`;

        try {
            logger.logInfo(
                `Fetching ${searchType} threads batch for channel ${channelId} with offset ${offset}, limit ${limit}`,
            );
            const data = await makeDiscordRequest(token, searchUrl);
            consecutiveErrors = 0; // Reset errors on success

            if (!data || !Array.isArray(data.threads)) {
                logger.logWarn(
                    `Unexpected response format or missing threads array from ${searchType} thread search for channel ${channelId} (offset ${offset}). Stopping pagination for ${searchType}. Response:`,
                    data ? JSON.stringify(data).substring(0, 200) + '...' : 'undefined/null',
                );
                hasMore = false;
                break;
            }

            const threadsInBatch = data.threads;
            threads = threads.concat(threadsInBatch); // Add to this search's results
            logger.logInfo(
                `Fetched ${threadsInBatch.length} ${searchType} threads for channel ${channelId} (offset ${offset}). Total ${searchType} now: ${threads.length}. Has More reported: ${data.has_more}`,
            );

            // Determine if pagination should continue
            if (data.has_more === true && threadsInBatch.length === limit) {
                hasMore = true;
                offset += limit;
                await new Promise((resolve) => setTimeout(resolve, 450));
            } else {
                hasMore = false;
            }
        } catch (error) {
            consecutiveErrors++;
            logger.logError(
                `Error fetching ${searchType} threads batch for channel ${channelId} (offset ${offset}). Error ${consecutiveErrors}/${maxConsecutiveErrors}.`,
                error,
            );

            if (error.status === 403 || error.status === 404) {
                logger.logWarn(
                    `Could not search ${searchType} threads for channel ${channelId} due to ${error.status} error (offset ${offset}). Stopping ${searchType} search for this channel. Message: ${error.message}`,
                );
                hasMore = false;
                break;
            }
            if (consecutiveErrors >= maxConsecutiveErrors) {
                logger.logError(
                    `Reached max consecutive errors (${maxConsecutiveErrors}) fetching ${searchType} threads for channel ${channelId}. Stopping pagination for ${searchType}.`,
                );
                hasMore = false;
            } else {
                await new Promise((resolve) => setTimeout(resolve, 1000 * consecutiveErrors));
            }
        }
    } // End while loop

    if (consecutiveErrors > 0 && consecutiveErrors < maxConsecutiveErrors) {
        logger.logWarn(
            `${
                searchType.charAt(0).toUpperCase() + searchType.slice(1)
            } thread search for channel ${channelId} completed but encountered ${consecutiveErrors} error(s) during pagination.`,
        );
    }

    logger.logInfo(
        `Finished paginated search for ${searchType} threads in channel ${channelId}. Found ${threads.length} ${searchType} threads.`,
    );
    return threads;
};

// --- fetchThreads ---
/**
 * Fetches both active and archived threads for a given channel using the search endpoint.
 * Handles pagination and de-duplicates results.
 * @param {string} token - Discord User token.
 * @param {string} channelId - The ID of the channel to fetch threads from.
 * @param {number} channelType - The numeric type of the channel.
 * @returns {Promise<Array<object>>} - A promise resolving to an array of unique thread objects.
 */
const fetchThreads = async (token, channelId, channelType) => {
    const supportedParentTypes = [0, 5]; // GUILD_TEXT, GUILD_NEWS
    if (!supportedParentTypes.includes(channelType)) {
        logger.logInfo(
            `Skipping thread fetch for channel ${channelId} (type ${channelType}) - parent type not supported for search.`,
        );
        return [];
    }

    logger.logInfo(`Starting combined thread search (active & archived) for channel ${channelId}`);

    try {
        // Run searches for active and archived threads (can run in parallel)
        const [activeThreads, archivedThreads] = await Promise.all([
            _searchThreadsPaginated(token, channelId, false), // Search for active (searchArchived = false)
            _searchThreadsPaginated(token, channelId, true), // Search for archived (searchArchived = true)
        ]);

        // Combine results
        const combinedThreads = [...activeThreads, ...archivedThreads];
        logger.logInfo(
            `Combined threads count before de-duplication for channel ${channelId}: ${combinedThreads.length} (Active: ${activeThreads.length}, Archived: ${archivedThreads.length})`,
        );

        // De-duplicate based on thread ID
        const uniqueThreadsMap = new Map();
        combinedThreads.forEach((thread) => {
            // Keep the first encountered version if duplicate IDs exist
            if (!uniqueThreadsMap.has(thread.id)) {
                uniqueThreadsMap.set(thread.id, thread);
            }
            // Optional: Could add logic here to prefer the "active" version if a thread
            // appears in both active and archived searches, though this shouldn't typically happen.
        });

        const finalThreads = Array.from(uniqueThreadsMap.values());
        logger.logInfo(
            `Finished combined thread search for channel ${channelId}. Total unique threads found: ${finalThreads.length}`,
        );
        return finalThreads;
    } catch (error) {
        // Catch potential errors from Promise.all or initial setup if any
        logger.logError(`Fatal error during combined thread search for channel ${channelId}.`, error);
        // Rethrowing the error to indicate failure to the caller
        throw new Error(`Failed to complete combined thread search for channel ${channelId}: ${error.message}`);
        // Alternative: return []; // Return empty array on failure
    }
};

// --- Exports ---
module.exports = {
    fetchGuilds,
    fetchChannels,
    fetchThreads,
    makeDiscordRequest, // Export the helper function
};
