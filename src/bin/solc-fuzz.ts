#!/usr/bin/env node
import fs from "node:fs";
import { SourceUnit } from "solc-typed-ast";
import { NoOpError, Config, prepareConfig } from "../config";
import { run } from "../runner";
import { exists } from "../utils";
import { prepareSeedUnits, Result as CompilationResult } from "../compile";
import { FuzzingResult } from "../fuzzer";
import logger from "../logging";
import path from "node:path";
import { mkdir } from "node:fs/promises";

function writeToStream(output: fs.WriteStream, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
        output.write(data, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

async function prepareOutputPath(outputPath: string): Promise<string> {
    if (!path.isAbsolute(outputPath)) {
        // resolve relative to this file's directory
        outputPath = path.join(__dirname, outputPath);
    }
    // create output directory if it doesn't exist
    if (!(await exists(outputPath))) {
        logger.debug(`Creating output directory at  ${outputPath}`);
        await mkdir(outputPath, { recursive: true });
    }
    logger.debug(`Results will be written to: ${outputPath}`);
    return outputPath;
}

async function processResults(
    outputStream: fs.WriteStream,
    compilationFailures: Array<[string, CompilationResult]>,
    fuzzingFailures: Array<[string, string, FuzzingResult]>
) {
    logger.debug(`Writing ${compilationFailures.length} compilation failures`);
    for (const [fileName, compilationResult] of compilationFailures) {
        await writeToStream(
            outputStream,
            JSON.stringify({
                failure: "compilation:error",
                contractPath: fileName,
                error: compilationResult.error as string,
                version: compilationResult.version
            }) + "\n"
        );
    }

    logger.debug(`Writing ${fuzzingFailures.length} fuzzing failures`);
    for (const [reason, fileName, fuzzingResult] of fuzzingFailures) {
        await writeToStream(
            outputStream,
            JSON.stringify({
                failure: `fuzzing:${reason}`,
                contractPath: fileName,
                encodedCall: fuzzingResult.encodedCall,
                callParameters: fuzzingResult.callParameters,
                functionName: fuzzingResult.functionName,
                version: fuzzingResult.version,
                result: fuzzingResult.runResult.result.result,
                output: fuzzingResult.runResult.result.output,
                storage: fuzzingResult.runResult.storage,
                logs: fuzzingResult.runResult.logs
            }) + "\n"
        );
    }
}

async function main() {
    let config: Config;
    try {
        config = await prepareConfig();
    } catch (e) {
        if (e instanceof NoOpError) {
            process.exit(0);
        }
        throw e;
    }

    const seedUnits: SourceUnit[] = await prepareSeedUnits(
        config.files,
        config.compilerVersion,
        config.compilerSettings
    );

    const startTime = Date.now();
    const outputPath = await prepareOutputPath(config.outputPath);

    // open file for streaming write
    const resultsFile = fs.createWriteStream(path.join(outputPath, "results.jsonl"));
    const resultsProcessor = processResults.bind(null, resultsFile);

    let numberOfTestsPerformed = 0;
    let compilationFailuresEncountered = 0;
    let fuzzingFailuresEncountered = 0;

    if (config.timeLimit !== undefined) {
        while (Date.now() - startTime < config.timeLimit) {
            const { compilationFailures, fuzzingFailures } = await run({
                seedUnits,
                rewrites: config.rewrites,
                rewriteDepth: config.rewriteDepth,
                versions: config.versions,
                // if time limit is set, run only one test per iteration
                numberOfTests: 1,
                // cast to string because we know it's defined and checked in prepareConfig
                testCallFunctionName: config.testCallFunction as string,
                saveVariants: config.saveVariants,
                baseFileName: path.basename(config.files[0]),
                outputPath
            });
            await resultsProcessor(compilationFailures, fuzzingFailures);
            numberOfTestsPerformed++;
            compilationFailuresEncountered += compilationFailures.length;
            fuzzingFailuresEncountered += fuzzingFailures.length;
        }
        console.log(`Time limit of ${config.timeLimit}ms reached. Exiting...`);
        process.exit(0);
    } else {
        const { compilationFailures, fuzzingFailures } = await run({
            seedUnits,
            rewrites: config.rewrites,
            rewriteDepth: config.rewriteDepth,
            versions: config.versions,
            numberOfTests: config.numTests,
            // cast to string because we know it's defined and checked in prepareConfig
            testCallFunctionName: config.testCallFunction as string,
            saveVariants: config.saveVariants,
            baseFileName: path.basename(config.files[0]),
            outputPath
        });
        await resultsProcessor(compilationFailures, fuzzingFailures);
        numberOfTestsPerformed += config.numTests;
        compilationFailuresEncountered += compilationFailures.length;
        fuzzingFailuresEncountered += fuzzingFailures.length;
    }

    console.log(`Performed ${numberOfTestsPerformed} tests`);
    console.log(`Compilation failures encountered: ${compilationFailuresEncountered}`);
    console.log(`Fuzzing failures encountered: ${fuzzingFailuresEncountered}`);

    resultsFile.end();
    resultsFile.close();
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((e) => {
        console.error(e.message);

        process.exit(1);
    });
