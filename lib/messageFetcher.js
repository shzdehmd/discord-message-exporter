// lib/messageFetcher.js
const logger = require('./logger');
// Import the centralized request maker from discordApi.js
const { makeDiscordRequest } = require('./discordApi');

// Base URL for messages endpoint (using v9 as in original script, though v10 is also common)
// Note: discordApi.js uses v10 for guilds/channels. Consistency might be good,
// but let's stick to v9 for messages for now as specified in the original fetchMessages.
const MESSAGES_API_URL_BASE = 'https://discord.com/api/v9/channels/';

/**
 * Fetches a batch of messages from a specific Discord channel.
 * Uses the centralized makeDiscordRequest for API calls.
 *
 * @param {string} token - Discord User or Bot token.
 * @param {string} channelId - The ID of the channel/thread to fetch messages from.
 * @param {number} [limit=100] - Max number of messages per batch (1-100). Discord default is 50.
 * @param {object} [queryOpts={ before: null, after: null }] - Options for message filtering.
 * @param {string|null} [queryOpts.before] - Get messages before this message ID.
 * @param {string|null} [queryOpts.after] - Get messages after this message ID. (Mutually exclusive with 'before' in practice)
 * @returns {Promise<Array<object>>} - A promise resolving to an array of message objects fetched.
 * @throws {Error} - Throws errors forwarded from makeDiscordRequest (e.g., API errors, network issues, timeouts).
 */
const fetchMessagesBatch = async (token, channelId, limit = 100, queryOpts = { before: null, after: null }) => {
    // Construct the API URL for the specific channel
    const apiUrl = `${MESSAGES_API_URL_BASE}${channelId}/messages`;

    // Clamp the limit between 1 and 100
    const actualLimit = Math.max(1, Math.min(100, limit));

    // Build query parameters
    const params = new URLSearchParams({
        limit: actualLimit.toString(),
    });

    // Add 'before' or 'after' if provided (Discord API generally prioritizes 'before' if both are sent)
    if (queryOpts.before) {
        params.set('before', queryOpts.before);
        logger.logInfo(`Fetching messages for channel ${channelId} BEFORE ${queryOpts.before} (Limit: ${actualLimit})`);
    } else if (queryOpts.after) {
        params.set('after', queryOpts.after);
        logger.logInfo(`Fetching messages for channel ${channelId} AFTER ${queryOpts.after} (Limit: ${actualLimit})`);
    } else {
        logger.logInfo(`Fetching latest messages for channel ${channelId} (Limit: ${actualLimit})`);
    }

    const urlWithParams = `${apiUrl}?${params.toString()}`;

    try {
        // Use the centralized makeDiscordRequest helper
        const messages = await makeDiscordRequest(token, urlWithParams, 'GET');

        // Validate the response structure (makeDiscordRequest should handle non-OK statuses)
        if (!Array.isArray(messages)) {
            logger.logWarn(`Unexpected response format from ${urlWithParams}. Expected array, got:`, typeof messages);
            // Depending on strictness, could throw an error or return empty array
            // throw new Error('Unexpected response format when fetching messages.');
            return []; // Return empty array if response is not as expected but request was 'ok'
        }

        logger.logInfo(`Successfully fetched ${messages.length} messages from ${urlWithParams}`);
        return messages; // Return the array of message objects
    } catch (error) {
        // Errors (API errors, network, timeout) are already logged by makeDiscordRequest
        logger.logError(`Error during fetchMessagesBatch for channel ${channelId}`, error.message); // Add context
        // Re-throw the error so the calling function (the main export loop later) can handle it
        throw error;
    }
};

module.exports = {
    fetchMessagesBatch,
};
