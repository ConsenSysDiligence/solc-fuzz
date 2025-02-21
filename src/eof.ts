import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import os from "os";
import logger from "./logging";
import { CompileResult, CompilerKind, getCompilerForVersion } from "solc-typed-ast";

// get from ENV or default
const SOLC_WRAPPER_PATH = process.env.SOLC_WRAPPER_PATH || "solc_wrapper.sh";
const SOLC_VERSION_WRAPPER_PATH =
    process.env.SOLC_VERSION_WRAPPER_PATH || "solc_version_wrapper.sh";

const DEFAULT_COMPILER_VERSION = "0.8.27";

let __compilerVersion__: Record<string, string> = {};

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
                logger.error(`Compiler exited with code ${code}. Stderr: ${stderr}`);
                reject(`Compiler exited with code ${code}, stderr: ${stderr}`);
                return;
            }

            if (stderr !== "" && stderr.includes("Error:")) {
                logger.error(`Compiler exited with non-empty stderr: ${stderr}`);
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
                logger.error(`Error parsing compiler output: ${e}`);
                reject(e);
            }
        });
    });
}

async function version(compilerPath: string): Promise<string> {
    if (__compilerVersion__[compilerPath] !== undefined) {
        return __compilerVersion__[compilerPath];
    }

    const child = spawn("bash", [SOLC_VERSION_WRAPPER_PATH, compilerPath], {});
    return new Promise((resolve) => {
        let stdout = "";

        child.stdout.on("data", (data) => {
            stdout += data;
        });

        child.on("close", async (code) => {
            if (code !== 0) {
                logger.debug(
                    `Returning default compiler version. Code: ${code}. Stdout: ${stdout}`
                );
                __compilerVersion__[compilerPath] = DEFAULT_COMPILER_VERSION;
                resolve(__compilerVersion__[compilerPath]);
                return;
            }
            const regex = /Version:\s(\d+\.\d+\.\d+)/;
            const match = stdout.match(regex);

            if (match) {
                __compilerVersion__[compilerPath] = match[1];
            } else {
                logger.debug(`Returning default compiler version. Stdout: ${stdout}`);
                __compilerVersion__[compilerPath] = DEFAULT_COMPILER_VERSION;
            }
            resolve(__compilerVersion__[compilerPath]);
        });
    });
}

export async function resolveCompilerVersion(versionString: string): Promise<string> {
    if (versionString == "eof") {
        versionString = `custom:${process.env.SOLC_PATH}`;
    }
    const compiler = await getCompilerForVersion(versionString, CompilerKind.Native);
    let _version;
    if (compiler) {
        _version = await version(compiler.path);
    } else {
        _version = versionString;
    }
    logger.debug(`Resolved compiler version ${versionString} => ${_version}`);
    return _version;
}
