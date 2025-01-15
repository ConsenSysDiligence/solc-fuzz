import { spawn } from "child_process";
import path from "path";
import os from "os";
import fs from "fs/promises";

export type EVMLog = {
    address: string;
    topics: string[];
    data: string;
};

export type EVMStorage = Record<string, any>;

export type Result = {
    result: "success" | "revert";
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

export async function runEVM({
    bytecode,
    input,
    revision = 14,
    vmPath = EVM_PATH,
    verbosity = 0
}: {
    bytecode: string;
    input: string;
    revision?: number;
    vmPath?: string;
    verbosity?: number;
}): Promise<RunEVMResult> {
    // create temp files for storage and logs
    const storageTempFile = path.join(os.tmpdir(), "storage.json");
    const logsTempFile = path.join(os.tmpdir(), "logs.json");

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
                    if (verbosity >= 2) {
                        console.log(`EVM OUTPUT: ${stdout}`);
                    }
                    const lines = stdout.split("\n");
                    const result = {
                        result: lines[lines.length - 4].split(":")[1].trim() as
                            | "success"
                            | "revert",
                        output: lines[lines.length - 2].split(":")[1].trim()
                    };
                    resolve({ storage, logs, result });
                } catch (e) {
                    reject(e);
                }
            } else {
                reject(stderr);
            }
            await fs.rm(storageTempFile);
            await fs.rm(logsTempFile);
        });
    });
}
