const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

// Resolve log directory relative to the project root where server.js runs
// __dirname here refers to the 'lib' directory. We go one level up.
const projectRoot = path.resolve(__dirname, '..');
const logDir = path.join(projectRoot, 'logs'); // Logs will be in projectRoot/logs/
const infoLogPath = path.join(logDir, 'info.log');
const errorLogPath = path.join(logDir, 'error.log');

let infoStream;
let errorStream;

// Ensure log directory exists synchronously during setup
try {
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
        console.log(`Log directory created at: ${logDir}`);
    } else {
        console.log(`Log directory exists: ${logDir}`);
    }
    // Create write streams in append mode *after* ensuring directory exists
    infoStream = fs.createWriteStream(infoLogPath, { flags: 'a' });
    errorStream = fs.createWriteStream(errorLogPath, { flags: 'a' });
    console.log(`Log streams initialized for info.log and error.log`);
} catch (err) {
    console.error('FATAL: Failed to create log directory or streams:', err);
    process.exit(1); // Exit if we can't log
}

// Helper to format log messages
function formatLog(level, args) {
    const timestamp = new Date().toISOString();
    // Use util.format to handle different argument types like console.log does
    // If the first arg is an object, util.format might inspect it deeply.
    // Consider JSON stringifying objects for consistent logging if needed.
    const message = util.format(...args);
    return `[${timestamp}] ${level}: ${message}\n`;
}

// Log informational messages
function logInfo(...args) {
    // Defensively check if stream is ready
    if (!infoStream || infoStream.destroyed) {
        console.error('Logger Error: Info stream not available.');
        console.info('[INFO fallback]', ...args);
        return;
    }
    const message = formatLog('INFO', args);
    infoStream.write(message, (err) => {
        if (err) console.error('Failed to write to info log:', err);
    });
    // Also log to console for immediate feedback during development/running
    console.log(`[INFO]`, ...args);
}

// Log warning messages
function logWarn(...args) {
    if (!infoStream || infoStream.destroyed || !errorStream || errorStream.destroyed) {
        console.error('Logger Error: Log streams not available.');
        console.warn('[WARN fallback]', ...args);
        return;
    }
    const message = formatLog('WARN', args);
    // Write warnings to both logs for context and easy error tracking
    infoStream.write(message, (err) => {
        if (err) console.error('Failed to write warning to info log:', err);
    });
    errorStream.write(message, (err) => {
        if (err) console.error('Failed to write warning to error log:', err);
    });
    console.warn(`[WARN]`, ...args);
}

// Log error messages
function logError(...args) {
    if (!infoStream || infoStream.destroyed || !errorStream || errorStream.destroyed) {
        console.error('Logger Error: Log streams not available.');
        console.error('[ERROR fallback]', ...args);
        return;
    }
    // Check if the last argument is an Error object to log stack trace
    let errorInstance = null;
    if (args.length > 0 && args[args.length - 1] instanceof Error) {
        errorInstance = args.pop(); // Remove error from args array
    }

    const basicMessage = formatLog('ERROR', args).trimEnd(); // Message without stack for info log
    let detailedMessage = basicMessage + '\n'; // Start detailed message

    if (errorInstance) {
        // Include error name and message directly in the first line for error log
        detailedMessage = `[${new Date().toISOString()}] ERROR: ${util.format(...args)} - ${errorInstance.name}: ${
            errorInstance.message
        }\nStack: ${errorInstance.stack}\n`;
    }

    // Write errors primarily to the error log
    errorStream.write(detailedMessage, (err) => {
        if (err) console.error('Failed to write to error log:', err); // Fallback
    });
    // Also write a concise version to the info log for sequence context
    const infoErrorMessage = basicMessage + (errorInstance ? ` - See error.log for details\n` : '\n');
    infoStream.write(infoErrorMessage, (err) => {
        if (err) console.error('Failed to write error summary to info log:', err);
    });
    // Log the error to the console as well
    console.error(`[ERROR]`, ...args, errorInstance || '');
}

// Function to close log streams (important for graceful shutdown)
function closeLogs() {
    console.log('Attempting to close log streams...'); // Console log during shutdown
    return new Promise((resolve) => {
        // Check if streams were initialized
        if (!infoStream || !errorStream) {
            console.log('Log streams were not initialized, nothing to close.');
            return resolve();
        }

        let closedCount = 0;
        const totalStreams = 2;
        let streamsClosed = false; // Guard against resolving multiple times

        const checkDone = (streamName) => (err) => {
            if (err) {
                console.error(`Error closing ${streamName} stream:`, err);
            } else {
                console.log(`${streamName} stream closed.`);
            }
            closedCount++;
            if (closedCount === totalStreams && !streamsClosed) {
                streamsClosed = true;
                console.log('All log streams closed.');
                resolve();
            }
        };

        // Check if streams are already ended or destroyed before calling end()
        if (!infoStream.destroyed && !infoStream.closed) {
            infoStream.end(checkDone('info'));
        } else {
            checkDone('info')(null); // Treat as closed
        }

        if (!errorStream.destroyed && !errorStream.closed) {
            errorStream.end(checkDone('error'));
        } else {
            checkDone('error')(null); // Treat as closed
        }

        // Timeout fallback in case 'finish' or 'close' events don't fire
        setTimeout(() => {
            if (!streamsClosed) {
                console.warn('Log stream close timed out. Forcing resolution.');
                streamsClosed = true;
                resolve();
            }
        }, 2000); // Wait max 2 seconds
    });
}

// --- Process Exit Handlers ---
// Ensure these are defined only once

// Flag to prevent multiple exits
let isExiting = false;

async function handleExit(signalOrCode, origin = 'exit') {
    if (isExiting) return;
    isExiting = true;
    console.log(`\n${origin} event received (${signalOrCode}). Closing log streams and exiting.`);
    try {
        await closeLogs();
    } catch (e) {
        console.error('Error during closeLogs on exit:', e);
    } finally {
        // Use process.exitCode for signals/exit, force exit for uncaughtException
        process.exitCode = typeof signalOrCode === 'number' ? signalOrCode : 0;
        if (origin === 'uncaughtException') {
            console.error('Exiting due to uncaught exception.');
            process.exit(1); // Force exit for uncaught exceptions
        } else {
            // Allow the process to exit naturally if possible, respecting exit code
            console.log(`Exiting with code ${process.exitCode}.`);
        }
    }
}

process.on('exit', (code) => {
    // This handler might not run all async code, good for final sync cleanup if needed
    // console.log(`Process cleanup on exit event with code ${code}.`);
    // Avoid calling handleExit here if relying on SIGINT/SIGTERM for async cleanup
});

process.on('SIGINT', () => handleExit('SIGINT', 'SIGINT')); // CTRL+C
process.on('SIGTERM', () => handleExit('SIGTERM', 'SIGTERM')); // Termination signal

// Handle uncaught exceptions
process.on('uncaughtException', (err, origin) => {
    const timestamp = new Date().toISOString();
    const fatalMessage = `[${timestamp}] FATAL: Uncaught Exception at: ${origin}\nError: ${err.name}: ${err.message}\nStack: ${err.stack}\n`;
    console.error(fatalMessage); // Log to console immediately

    try {
        // Try writing to error log synchronously in this critical situation
        if (errorStream && !errorStream.destroyed) {
            fs.appendFileSync(errorLogPath, fatalMessage);
        } else {
            console.error('Error stream unavailable for critical error logging.');
        }
        if (infoStream && !infoStream.destroyed) {
            fs.appendFileSync(infoLogPath, `[${timestamp}] FATAL: Uncaught Exception. See error.log.\n`);
        }
    } catch (logErr) {
        console.error('FATAL: Additionally failed to write uncaught exception to log file.', logErr);
    }

    // Ensure logs are attempted to be closed before exiting
    handleExit(1, 'uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    const timestamp = new Date().toISOString();
    let rejectionMessage = `[${timestamp}] ERROR: Unhandled Promise Rejection\n`;
    if (reason instanceof Error) {
        rejectionMessage += `Reason: ${reason.name}: ${reason.message}\nStack: ${reason.stack}\n`;
    } else {
        rejectionMessage += `Reason: ${util.inspect(reason)}\n`;
    }
    // Add promise information if available
    rejectionMessage += `Promise: ${util.inspect(promise)}\n`;

    console.error(rejectionMessage); // Log to console immediately

    // Log to error file
    if (errorStream && !errorStream.destroyed) {
        errorStream.write(rejectionMessage, (err) => {
            if (err) console.error('Failed to write unhandled rejection to error log:', err);
        });
    } else {
        console.error('Error stream unavailable for unhandled rejection logging.');
    }
    // Also log a note to info log
    if (infoStream && !infoStream.destroyed) {
        infoStream.write(`[${timestamp}] ERROR: Unhandled Promise Rejection. See error.log.\n`, (err) => {
            if (err) console.error('Failed to write unhandled rejection summary to info log:', err);
        });
    }

    // Recommended practice is often to treat unhandled rejections like uncaught exceptions
    // and exit, especially in newer Node versions. Uncomment below to enable this.
    // console.error("Exiting due to unhandled rejection.");
    // handleExit(1, 'unhandledRejection');
});

module.exports = {
    logInfo,
    logWarn,
    logError,
    closeLogs,
};
