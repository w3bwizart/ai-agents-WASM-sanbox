# Zero-Trust WASM Sandbox (Clean Sandwich Architecture)

This repository contains a localized Proof of Concept (POC) demonstrating **"Clean Sandwich Architecture"**—a highly secure method to isolate language-model generated code dynamically without risking the host machine.

## Architecture Highlights
The core philosophy is based on providing "Zero-Trust" guarantees for AI-generated code.
1. **The Python Host (`agent.py` & `server.py`)**: An `atomic-agents` powered LLM orchestration engine running over FastAPI. It requests code from the model and natively serves a real-time web dashboard using WebSockets/SSE.
2. **The WASM Bridge (`sandbox_manager.js`)**: A strict, zero-dependency Node.js execution boundary. It securely isolates Pyodide WebAssembly (WASM) inside `worker_threads`. 
3. **Implicit Clean-Up Strategy**: When the WASM worker finishes processing the Python code snippet, the main Node thread **explicitly destroys** the worker instance, preventing any lingering allocations, background loops, or memory leaks before returning the structured JSON execution format back to the Host.

This removes the need for containerized dockers, allowing for light, seamless, and instantaneous execution entirely local to the project directory.

## Getting Started

Because the Node.js bridge leverages a native Pyodide CDN downloader, it has structurally zero `node_modules`. All operations require configuring the Python environment.

### 1. Activate the Virtual Environment
> [!IMPORTANT]
> The dependencies (FastAPI, Atomic-Agents, Litellm) are installed safely inside the local `.venv`. 
> You **must** activate the virtual environment before running the server, or you will see `ModuleNotFoundError`.

**For macOS/Linux:**
```bash
source .venv/bin/activate
```

### 2. Configure Your LLM (Optional)
Out of the box, the `agent.py` connects locally to `ollama/llama3.1`. 
If you prefer mistral, or wish to use cloud providers (Gemini, Claude, GPT), simply create a `.env` file in this directory and append:

```env
LLM_MODEL=ollama/mistral
# Or for Claude:
# LLM_MODEL=claude-3-opus-20240229
# ANTHROPIC_API_KEY=your_key_here
```

### 3. Start the Dashboard Server
With the virtual environment active, host the frontend explicitly utilizing `uvicorn`:

```bash
uvicorn server:app --port 8000
# Alternatively:
# python -m uvicorn server:app --port 8000
```

### 4. Observe the Sandbox Lifecycle
* Navigate to `http://127.0.0.1:8000` in your browser.
* Click **Deploy LLM Agent**.
* Watch the exact lifecycle stages occur locally, concluding visually with the secure worker destruction.
