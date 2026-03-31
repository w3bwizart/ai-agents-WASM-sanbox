/**
 * ==============================================================================
 * app.js
 * ==============================================================================
 * Central Front-End logic for the WASM Sandbox Dashboard.
 * Responsibilities:
 * 1. Listening to UI interaction (Execute Agent Button).
 * 2. Connecting to the FastAPI Server-Sent Events (SSE) Stream at `/api/run`.
 * 3. Dynamically decoding and appending the streaming execution payload directly
 *    into the visible Terminal Window UI.
 * ==============================================================================
 */

document.addEventListener('DOMContentLoaded', () => {
    // Cache DOM Elements for performance
    const runBtn = document.getElementById('runBtn');
    const terminal = document.getElementById('terminal');
    const statusIndicator = document.querySelector('.status-indicator');
    
    // Hold the active Server-Sent Events stream connection object globally within scope
    // so we can cleanly terminate it on errors or subsequent executions.
    let eventSource = null;

    /**
     * Constructs a log line dynamically and appends it to the DOM immediately.
     * @param {string} step - The categorization of the log ('system', 'agent', 'bridge', 'sandbox', 'error'). Automatically maps to CSS coloring classes.
     * @param {string} message - The textual message to render. Can contain multi-line code which is preserved.
     */
    function appendLog(step, message) {
        const div = document.createElement('div');
        div.className = `log-entry ${step}`;
        
        // Generate a real-time timestamp like "[14:24:05]" for the UI Trace
        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
        
        // Prevents DOM injection attacks by sanitizing payload
        div.innerHTML = `<span class="timestamp">[${timeStr}]</span> ${escapeHTML(message)}`;
        
        // Automatically append to the bottom of the visible console area
        terminal.appendChild(div);
        
        // Scroll lock strategy: Keep scroll forced at the bottom to watch logs "roll in"
        terminal.scrollTop = terminal.scrollHeight;
    }

    /**
     * Hard-escapes HTML characters so code injected from `print("<script>")`
     * safely visualizes instead of immediately rendering.
     * @param {string} str - Raw text.
     * @returns {string} - Escaped text safe for innerHTML
     */
    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, tag => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[tag]));
    }

    // Initialize execution pipeline on "Deploy LLM Agent" click.
    runBtn.addEventListener('click', () => {
        // If an old stream is left hanging around, force close it before spawning
        if (eventSource) eventSource.close();
        
        // Reset Terminal output and lock UI button
        terminal.innerHTML = '';
        runBtn.disabled = true;
        
        // Update Status indicator
        statusIndicator.textContent = 'Running Pipeline...';
        statusIndicator.className = 'status-indicator active';
        
        // Emit a native UI log
        appendLog('system', 'Initiating Sandwich Architecture Pipeline...');
        
        // Connect natively using Web API `EventSource` which inherently establishes long-polling SSE
        eventSource = new EventSource('/api/run');
        
        // This fires continuously every single time `yield` is triggered in FastAPI
        eventSource.onmessage = (e) => {
            // Re-hydrate the Python JSON object string back into JS
            const data = JSON.parse(e.data);
            
            // Check for the termination sentinel from Python (which guarantees execution halted)
            if (data.step === 'complete') {
                eventSource.close();
                runBtn.disabled = false; // Free the UI
                statusIndicator.textContent = 'Idle';
                statusIndicator.className = 'status-indicator';
                appendLog('system', 'Pipeline completed successfully.');
            } else if (data.step === 'error') {
                // Critical unhandled error layer
                runBtn.disabled = false;
                statusIndicator.textContent = 'Error';
                statusIndicator.className = 'status-indicator error';
                appendLog('error', data.message);
                eventSource.close();
            } else {
                // Happy path: Append standard colored log entry
                appendLog(data.step, data.message);
            }
        };
        
        // Handles network timeouts or server unreachability (HTTP 500)
        eventSource.onerror = () => {
            eventSource.close();
            runBtn.disabled = false;
            statusIndicator.textContent = 'Connection Error';
            statusIndicator.className = 'status-indicator error';
            appendLog('error', 'Lost connection to streaming server.');
        };
    });
});
