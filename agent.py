# ==============================================================================
# agent.py
# ==============================================================================
# The Python Host for the Zero-Trust WASM Sandbox, powered by `atomic-agents`.
# This file bridges the high-level language model orchestration with the low-level 
# Node.js Worker Thread bridging (where Pyodide WASM resides).
# 
# Main Components:
# 1. Pydantic Schemas (WasmSandboxInputSchema, WasmSandboxOutputSchema)
# 2. The custom Atomic Agent tool (`WasmSandboxTool`) that calls the bridge via `subprocess`
# 3. The `run_agent_loop` which orchestrates prompt generation, tool execution, 
#    and logs output state to the Dashboard's async stream via `log_callback`.
# ==============================================================================

import os
import json
import subprocess
from pydantic import Field

# Atomic Agents Base Classes and Tool Architecture
from atomic_agents.base.base_tool import BaseTool, BaseToolConfig
from atomic_agents.base.base_io_schema import BaseIOSchema
from atomic_agents.agents.atomic_agent import AtomicAgent, AgentConfig
from atomic_agents.context.system_prompt_generator import SystemPromptGenerator
from atomic_agents.context.chat_history import ChatHistory

# ==============================================================================
# Wasm Sandbox Tool Definition
# ==============================================================================

class WasmSandboxInputSchema(BaseIOSchema):
    """
    Schema for executing Python code in the Pyodide sandboxed environment.
    This informs the Agent EXACTLY what it needs to generate.
    """
    code: str = Field(..., description="The Python code to execute securely inside the isolated WASM sandbox.")

class WasmSandboxOutputSchema(BaseIOSchema):
    """
    Schema representing the structured result returned by the underlying Node.js bridge.
    Used by the framework to guarantee execution formats.
    """
    success: bool
    result: str | None = None
    evalResult: str | None = None
    error: str | None = None

class WasmSandboxToolConfig(BaseToolConfig):
    """Configuration class for the sandbox tool (can hold optional overrides)."""
    pass

class WasmSandboxTool(BaseTool[WasmSandboxInputSchema, WasmSandboxOutputSchema]):
    """
    Core Tool implementation for Atomic Agents.
    Instead of executing python natively and risking our host environment, this 
    tool pipes the generated code into the `sandbox_manager.js` script.
    """
    
    def __init__(self, config: WasmSandboxToolConfig = WasmSandboxToolConfig()):
        super().__init__(config)
        
    def run(self, params: WasmSandboxInputSchema) -> WasmSandboxOutputSchema:
        """
        Executes the Node.js bridge across a sub-process boundary.
        
        Security Note: The subprocess guarantees separation of memory, and the Node.js 
        process itself will further isolate the execution using Pyodide inside a Worker.
        """
        try:
            # Popen streams inputs and captures stdout and stderr via pipes.
            process = subprocess.Popen(
                ['node', 'sandbox_manager.js'],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True # Treats streams natively as strings (utf-8)
            )
            
            # Pipe the code into the STDIN of Node.js. Time out heavily if execution freezes.
            stdout_data, stderr_data = process.communicate(input=params.code, timeout=12)
            
            try:
                # The Node Bridge contract stipulates the FINAL line it prints to STDOUT
                # will ALWAYS be a rigorous JSON struct resembling WasmSandboxOutputSchema.
                lines = stdout_data.strip().split('\n')
                result_json = json.loads(lines[-1])
                return WasmSandboxOutputSchema(**result_json)
            except json.JSONDecodeError:
                # If the bridge crashed before valid JSON could be emitted, capture the entire stream.
                return WasmSandboxOutputSchema(
                    success=False,
                    error=f"Failed to decode Sandbox Output. STDOUT: {stdout_data} STDERR: {stderr_data}"
                )
        except Exception as e:
            # Extremely hard fallback for timeouts or missing node installations
            return WasmSandboxOutputSchema(
                success=False,
                error=str(e)
            )

# ==============================================================================
# Main Execution Loop
# ==============================================================================

async def run_agent_loop(log_callback):
    """
    Orchestrates the LLM to generate the "Hello World" function and executes it 
    through the WasmSandboxTool, streaming all status logs back via `log_callback`.
    """
    
    # 1. Model Configuration (Agnostic fallback pattern powered by litellm under the hood)
    model_name = os.getenv("LLM_MODEL", "ollama/llama3.1")
    api_key = os.getenv("LLM_API_KEY", "dummy")
    api_base = os.getenv("LLM_API_BASE", "http://localhost:11434")

    # Only strictly apply API Base/Key for Ollama; otherwise litellm handles API keys automatically 
    # (e.g. OPENAI_API_KEY environment variables)
    model_config = {
        "model": model_name
    }
    if model_name.startswith("ollama/"):
        model_config["api_base"] = api_base
        model_config["api_key"] = api_key
    
    import litellm
    import instructor
    
    # Patch the generic completion client via Instructor to ensure structural outputs
    client = instructor.from_litellm(litellm.completion)
    
    await log_callback("agent", f"Initializing Agent with model: {model_name}...")
    
    # 2. Prepare the System Prompt using Atomic Agents generators
    sys_prompt = SystemPromptGenerator(
        background=[
            "You are an expert Python AI developer strictly operating in a zero-trust setting.",
            "Your singular purpose is to output valid Python code to be executed securely in a Pyodide WASM environment."
        ],
        steps=[
            "Generate a complex or creative 'Hello World' Python function.",
            "Call the function locally in the code.",
            "Ensure the total output is strictly the Python code, completely devoid of Markdown formatting.",
        ],
        output_instructions=["Return ONLY valid Python code."]
    )
    
    # 3. Create the chat history (memory) layer and instantiate the Agent
    history = ChatHistory()
    agent = AtomicAgent(
        config=AgentConfig(
            client=client,
            model=model_name,
            system_prompt_generator=sys_prompt,
            history=history
        )
    )
    
    await log_callback("agent", "Agent thinking and generating code...")
    
    try:
        # 4. Trigger standard run to formulate the code based on the prompt
        response = agent.run(
            agent.input_schema(chat_message="Write the Hello World code to test the pyodide bridge! Return it as raw code.")
        )
        generated_code = response.chat_message
        
        # Protective measure: LLMs frequently wrap code in markdown despite instructions.
        # This parses out the python code block safely.
        if "```" in generated_code:
            lines = generated_code.split("```")
            for line in lines:
                if line.startswith("python"):
                    generated_code = line[6:].strip()
                elif line.strip():
                    generated_code = line.strip()
                    break

        await log_callback("bridge", f"Tool input code:\n{generated_code}")
        
        # 5. Connect the generated code to the low-level WASM Sandbox Tool explicitly
        sandbox_tool = WasmSandboxTool()
        result = sandbox_tool.run(WasmSandboxInputSchema(code=generated_code))
        
        # 6. Parse results and callback to UI Stream
        if result.success:
            await log_callback("sandbox", f"Execution Successful!\nStdout: {result.result}\nEval: {result.evalResult}")
        else:
            await log_callback("sandbox", f"Execution Failed!\nError: {result.error}")
            
        await log_callback("system", "Sandbox worker thread explicitly destroyed. Memory released.")
        
    except Exception as e:
        await log_callback("error", f"Agent loop critically failed: {str(e)}")
