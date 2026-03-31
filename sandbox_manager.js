/**
 * ==============================================================================
 * sandbox_manager.js
 * ==============================================================================
 * This script serves as the isolated bridge between the Python host process
 * and the WebAssembly (WASM) execution environment running Pyodide.
 * 
 * Key Features:
 * 1. Zero-dependency design (No `package.json` required at all).
 * 2. Strict thread safety via Node.js `worker_threads` to segregate LLM code.
 * 3. Implicit clean-up. The worker is forcefully terminated (`worker.terminate()`)
 *    after processing ensuring all WASM memory allocations die with it.
 * 4. Automatic native HTTPS fetching of the Pyodide runtime to maintain a clean filesystem.
 * ==============================================================================
 */

const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { existsSync } = require('fs');

if (isMainThread) {
    // ==========================================================================
    // MAIN THREAD: Data Ingestion & Thread Orchestration
    // ==========================================================================

    let code = '';
    // Interpret STDIN byte stream as raw utf-8 text (captures piped code from Python)
    process.stdin.setEncoding('utf8');
    
    // Accumulate the python code chunk by chunk
    process.stdin.on('data', chunk => { code += chunk; });
    
    // Once the Python sub-process signals EOF, we have the complete LLM generated code
    process.stdin.on('end', () => {
        // Instantiate a new worker utilizing THIS SAME SCRIPT (__filename) 
        // passing the aggregated code securely into workerData memory layout.
        const worker = new Worker(__filename, { workerData: { code } });
        
        let sentMessage = false;
        
        // Formatter guarantee: Ensure STDOUT only ever prints the final JSON payload
        const finish = (result) => {
            if (sentMessage) return; // Prevent dual invocations (like timeout + exit racing)
            sentMessage = true;
            process.stdout.write(JSON.stringify(result) + '\n');
            
            // SECURITY: The worker thread is forcibly terminated the moment execution results are yielded.
            worker.terminate();
            
            // Exit clearly for subprocess monitoring. 0 for success, 1 for failures.
            process.exit(result.success ? 0 : 1);
        };

        // SAFETY FALLBACK: The WASM execution could enter a `while(true)` loop.
        // Cap maximum block time to 10000ms.
        const timeout = setTimeout(() => {
            finish({ success: false, result: null, error: 'Execution timed out (10s limit)' });
        }, 10000);
        
        // Listeners for successful or crashed worker processes
        worker.on('message', (msg) => {
            clearTimeout(timeout);
            finish(msg);
        });
        
        worker.on('error', (err) => {
            clearTimeout(timeout);
            finish({ success: false, result: null, error: err.toString() });
        });
        
        // Failsafe for untrapped worker deaths (e.g. fatal OOM)
        worker.on('exit', (code) => {
            if (code !== 0 && !sentMessage) {
                finish({ success: false, result: null, error: `Worker stopped with exit code ${code}` });
            }
        });
    });

} else {
    // ==========================================================================
    // WORKER THREAD: WASM Pyodide Initialization & Code Execution
    // ==========================================================================

    const run = async () => {
        try {
            // Configuration for dynamically pulling Pyodide from JSDelivr CDN
            const version = 'v0.25.0';
            const baseUrl = `https://cdn.jsdelivr.net/pyodide/${version}/full`;
            const tmpDir = path.join(os.tmpdir(), `pyodide_${version}`);
            
            // The bare minimum files Pyodide requires to operate smoothly in a Node environment
            const files = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
            
            // Evaluate if any file is missing to determine cache presence
            const needsDownload = files.some(file => !existsSync(path.join(tmpDir, file)));
            
            if (needsDownload) {
                // If dependencies are missing, fetch them securely and store them natively in the OS /tmp dir
                await fs.mkdir(tmpDir, { recursive: true });
                for (const file of files) {
                    const res = await fetch(`${baseUrl}/${file}`);
                    const buffer = Buffer.from(await res.arrayBuffer());
                    await fs.writeFile(path.join(tmpDir, file), buffer);
                }
            }
            
            // We use native dynamic import() with the absolute cached path
            const mjsPath = path.join(tmpDir, 'pyodide.mjs');
            const { loadPyodide } = await import(mjsPath);
            
            // Logs redirection mechanism (capture `print()` calls intercepting STDOUT streams natively)
            let stdoutLog = '';
            let stderrLog = '';
            const pyodide = await loadPyodide({
                indexURL: tmpDir + '/', // Inform Pyodide where to locate the bundled WASM + Zip files
                stdout: (msg) => { stdoutLog += msg + '\n'; },
                stderr: (msg) => { stderrLog += msg + '\n'; }
            });
            
            // Core Execution: Hand over the LLM python code securely to the initialized Pyodide WASM instance
            const evalResult = await pyodide.runPythonAsync(workerData.code);
            
            // Structure the output strictly matching WasmSandboxOutputSchema expectations and yield back to Main Thread
            parentPort.postMessage({ 
                success: true, 
                result: stdoutLog.trim() || undefined, 
                evalResult: evalResult !== undefined ? evalResult.toString() : null,
                stderr: stderrLog.trim() || undefined
            });
            
        } catch (err) {
            // Unconditionally catch compilation or runtime logic errors in the python code itself
            parentPort.postMessage({ success: false, result: null, error: err.toString() });
        }
    };
    run();
}
