const vm = require('vm');
async function run() {
    const res = await fetch('https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js');
    const scriptText = await res.text();
    const sandbox = { ...global, fetch, require, console, process, URL, setTimeout, clearTimeout };
    vm.createContext(sandbox);
    vm.runInContext(scriptText, sandbox);
    const pyodide = await sandbox.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/' });
    console.log(await pyodide.runPythonAsync("1+1"));
}
run();
