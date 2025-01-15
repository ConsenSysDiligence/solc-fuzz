import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { CompileResult } from "solc-typed-ast";

// get from ENV or default
const SOLC_WRAPPER_PATH = process.env.SOLC_WRAPPER_PATH || "solc_wrapper.sh";
const SOLC_PATH = process.env.SOLC_PATH || "solc";

const DEFAULT_COMPILER_VERSION = "0.8.27";

export async function compile(sourceCode: string): Promise<CompileResult> {
    // write source code to temp file
    const tempFilePath = path.join(os.tmpdir(), "eof_temp.sol");
    await fs.writeFile(tempFilePath, sourceCode);

    const child = spawn("bash", [SOLC_WRAPPER_PATH, tempFilePath, "-"], {});

    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
            stdout += data;
        });

        child.stderr.on("data", (data) => {
            stderr += data;
        });

        child.on("close", async (code) => {
            await fs.rm(tempFilePath);
            if (code !== 0) {
                reject(`Compiler exited with code ${code}, stderr: ${stderr}`);
                return;
            }

            if (stderr !== "" && stderr.includes("Error:")) {
                reject(`Compiler exited with non-empty stderr: ${stderr}`);
                return;
            }

            let outJson;

            try {
                outJson = JSON.parse(stdout);

                resolve({
                    data: {
                        contracts: outJson.contracts,
                        errors: [],
                        sources: outJson.sources
                    },
                    compilerVersion: outJson.version,
                    files: new Map(),
                    resolvedFileNames: new Map(),
                    inferredRemappings: new Map()
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}

export async function version(): Promise<string> {
    const child = spawn("bash", [SOLC_PATH, "--version"], {});
    return new Promise((resolve, reject) => {
        let stdout = "";

        child.stdout.on("data", (data) => {
            stdout += data;
        });

        child.on("close", async (code) => {
            if (code !== 0) {
                resolve(DEFAULT_COMPILER_VERSION);
                return;
            }
            const regex = /Version:\s(\d+\.\d+\.\d+)/;
            const match = stdout.match(regex);

            if (match) {
                resolve(match[1]);
            } else {
                resolve(DEFAULT_COMPILER_VERSION);
            }
        });
    });
    
}
