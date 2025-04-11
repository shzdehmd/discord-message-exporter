# Discord Channel Exporter Web App

This Node.js web application allows you to securely export messages and attachments from a Discord channel or thread you have access to, generating local HTML files for offline viewing.

It features:

-   A web interface for entering your Discord token and selecting the server/channel.
-   Background processing to handle potentially long export jobs without blocking the UI.
-   Real-time progress updates via Server-Sent Events (SSE).
-   Downloading of message attachments, custom emotes, and user avatars.
-   MD5-based file hashing for deduplication (saves disk space by storing identical files only once).
-   Generation of paginated HTML files styled to resemble Discord's dark mode.
-   Robust error handling and logging.

## Features

-   **Web UI:** Easy selection of server and channel/thread via a web interface.
-   **Secure Token Handling:** Token is entered via the UI, used for API requests during the session, and not stored persistently by the application.
-   **Message Fetching:** Retrieves messages in batches from the Discord API.
-   **Attachment/Asset Downloading:** Downloads images, videos, audio files, PDFs, user avatars, and custom emotes linked in messages.
-   **Deduplication:** Uses MD5 hashing to store identical downloaded files only once, saving significant disk space.
-   **HTML Generation:** Converts messages into user-friendly HTML files.
    -   **Dark Mode Styling:** CSS mimics Discord's dark theme.
    -   **Pagination:** Exports are automatically split into multiple HTML pages for large channels.
    -   **Interactive Elements:** Includes client-side JavaScript for handling custom emotes, video autoplay, spoiler tags, and next/previous page navigation.
-   **Background Processing:** Exports run asynchronously on the server, allowing you to close the browser tab.
-   **Real-time Progress:** View export progress (fetching, processing, downloading files, generating HTML) directly in your browser via SSE.
-   **Logging:** Detailed logs (`info.log`, `error.log`) are created in the `logs/` directory for debugging.
-   **Configuration:** Control fetch limits and delays via `.env` file.

## Setup and Installation

1.  **Prerequisites:**

    -   [Node.js](https://nodejs.org/) (LTS version recommended, e.g., v18 or later)
    -   npm (usually included with Node.js)

2.  **Clone the Repository:**

    ```bash
    git clone <your-repository-url>
    cd discord-exporter-app
    ```

3.  **Install Dependencies:**

    ```bash
    npm install
    ```

    This will install Express, Nunjucks, Undici, Axios, and other necessary packages.

4.  **Create `.env` File:**

    -   Copy the example environment file:
        ```bash
        cp .env.example .env
        ```
    -   Edit the `.env` file:

        ```dotenv
        # .env

        # --- Server Configuration ---
        # Optional: Port the web application will run on
        PORT=3000

        # --- Download Limits (Optional) ---
        # Set MAX_BATCHES to a number to limit total batches fetched for testing. Comment out or set to null/0 for no limit.
        # MAX_BATCHES=5
        # Number of messages per API request batch (Discord Max: 100, Default: 100)
        LIMIT_PER_BATCH=100
        # Delay in milliseconds between Discord API message fetch requests (helps avoid rate limits)
        FETCH_DELAY_MS=1000

        # NOTE: A Discord Token is NOT set here. It is entered via the Web UI for security.
        ```

        -   Adjust `PORT` if needed.
        -   Configure `MAX_BATCHES`, `LIMIT_PER_BATCH`, and `FETCH_DELAY_MS` as desired for controlling the export process.

5.  **Ensure `Exports` Directory:** The application will automatically create an `Exports` directory in the project root when the first export starts. Ensure the application has write permissions in the project directory.

## Running the Application

1.  **Start the Server:**

    ```bash
    npm start
    ```

    Or, for development with automatic restarts on file changes (requires `nodemon`):

    ```bash
    npm install --save-dev nodemon
    npm run dev
    ```

2.  **Access the Web UI:** Open your web browser and navigate to `http://localhost:3000` (or the port you specified in `.env`).

3.  **Enter Discord Token:**

    -   Go to Discord in your browser (not the desktop app).
    -   Open Developer Tools (usually F12).
    -   Go to the "Network" tab.
    -   Type something in Discord (e.g., in any channel) to trigger API requests.
    -   Filter requests by `/api/` or `/messages`. Find a request (like fetching messages or typing).
    -   Look at the Request Headers for the `Authorization` header. Copy its value (it's a long string). **This is your user token. Keep it absolutely private!**
    -   Paste this token into the "Discord Token" field in the web application UI.

4.  **Select Server & Channel:**

    -   Click "Fetch My Servers".
    -   Select the desired server (guild) from the dropdown.
    -   Click "Select Server".
    -   Select the desired channel or thread from the next dropdown.

5.  **Start Export:**

    -   Click "Start Export".

6.  **Monitor Progress:**

    -   You will be taken to a status page showing real-time updates as the export runs in the background.
    -   You can monitor the server console/logs for more detailed information.

7.  **Find Exported Files:**
    -   Once complete (or if stopped), the exported files will be located in a new subfolder inside the `Exports/` directory in the project root. The folder name will be like `ChannelName_ChannelID_Timestamp`.
    -   Inside this folder:
        -   `messages/`: Raw JSON data fetched from Discord (one file per batch).
        -   `processed_messages/`: JSON data after processing (local paths for files).
        -   `processed_html/`: The final generated HTML files.
            -   `downloaded_files/`: Contains all downloaded attachments, avatars, and emotes (deduplicated). This folder is moved here at the end.
            -   `export-style.css`: Stylesheet for the HTML pages.
            -   `export-client.js`: JavaScript for the HTML pages.
            -   `processed_html_0.html`, `processed_html_1.html`, etc.: The viewable chat log pages (Page 0 contains the oldest messages from the export).
        -   `EXPORT_SUCCESS.txt` or `EXPORT_FAILED.txt`: A status file indicating the outcome.

## Project Structure

```
discord-exporter-app/
├── Exports/ # Output directory for all exports
├── logs/ # Log files (info.log, error.log)
├── node_modules/ # Dependencies
├── public/ # Static assets for the web UI & exports
│ ├── css/
│ │ ├── export-style.css # CSS for exported HTML
│ │ └── style.css # CSS for the main web UI
│ └── js/
│ └── export-client.js # JS for exported HTML
├── scripts/ # Helper scripts (HTML generation)
│ └── generateHtml.js
├── views/ # Nunjucks templates
│ ├── export/
│ │ └── chat_page.njk # Template for exported HTML pages
│ ├── error.njk
│ ├── index.njk
│ └── layout.njk
├── lib/ # Core application logic
│ ├── discordApi.js # Functions for Discord API interaction
│ ├── fileProcessor.js # File downloading, hashing, processing logic
│ ├── logger.js # Logging utility
│ └── messageFetcher.js # Message fetching logic
├── .env # Local environment variables (ignored by git)
├── .env.example # Example environment file
├── .gitignore # Files/folders ignored by git
├── nodemon.json # Nodemon configuration (ignores Exports/, logs/)
├── package-lock.json
├── package.json
└── server.js # Main Express application file
```

## Security Warning

**NEVER share your Discord token.** It provides complete access to your account. This tool processes the token entered in the UI only for direct communication with the Discord API during the export process and does not store it long-term. Use at your own risk and ensure the machine running this application is secure. Consider using Bot tokens where feasible, although fetching all user guilds typically requires a User Token.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
