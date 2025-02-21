import { spawn } from "child_process";
import path from "path";
import os from "os";
import fs from "fs/promises";
import logger from "./logging";

export type EVMLog = {
    address: string;
    topics: string[];
    data: string;
};

export type EVMStorage = Record<string, any>;

export type Result = {
    result: "success" | "revert" | "out of gas" | "no-op";
    output: string;
};

export type RunEVMResult = {
    result: Result;
    storage: EVMStorage;
    logs: EVMLog[];
};

// get from ENV or default
const EVM_PATH = process.env.EVM_PATH || "evmone.so";
const EVMC_PATH = process.env.EVMC_PATH || "evmc";

const OUTPUT_REGEX = /Output:([ \w]+)/;
const RESULT_REGEX = /Result:([ \w]+)/;

export async function runEVM({
    bytecode,
    input,
    revision = 14,
    vmPath = EVM_PATH
}: {
    bytecode: string;
    input: string;
    revision?: number;
    vmPath?: string;
}): Promise<RunEVMResult> {
    // create temp files for storage and logs
    const storageTempFile = path.join(os.tmpdir(), "storage.json");
    const logsTempFile = path.join(os.tmpdir(), "logs.json");

    logger.debug(`Running EVM for revision ${revision}`);

    const child = spawn(EVMC_PATH, [
        "run",
        "--vm",
        vmPath,
        "--rev",
        revision.toString(),
        bytecode,
        "--create",
        "--input",
        input,
        "--storage-dump-file",
        storageTempFile,
        "--logs-dump-file",
        logsTempFile
    ]);

    return new Promise((resolve, reject) => {
        let stderr = "";
        let stdout = "";
        child.stderr.on("data", (data) => {
            stderr += data;
        });

        child.stdout.on("data", (data) => {
            stdout += data;
        });

        child.on("close", async (code) => {
            if (code === 0) {
                try {
                    const storage = JSON.parse(await fs.readFile(storageTempFile, "utf8"));
                    const logs = JSON.parse(await fs.readFile(logsTempFile, "utf8"));
                    logger.debug(`EVM output: ${stdout}`);

                    let runResult: "success" | "revert" | "out of gas";
                    const r = stdout.match(RESULT_REGEX);
                    if (r !== null) {
                        runResult = r[1].trim() as "success" | "revert" | "out of gas";
                    } else {
                        logger.error(`Error parsing EVM result status`);
                        reject(stdout);
                        return;
                    }

                    let output = "";
                    const o = stdout.match(OUTPUT_REGEX);
                    if (o !== null) {
                        output = o[1].trim();
                    }

                    const result = {
                        result: runResult,
                        output
                    };
                    resolve({ storage, logs, result });
                } catch (e) {
                    logger.error(`Error parsing EVM output: ${e}`);
                    reject(e);
                    return;
                }
            } else {
                logger.debug(`EVM error: ${stderr}`);
                reject(stderr);
                return;
            }
            await fs.rm(storageTempFile);
            await fs.rm(logsTempFile);
        });
    });
}
