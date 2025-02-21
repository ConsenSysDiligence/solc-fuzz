import { SourceUnit } from "solc-typed-ast";
import { compile, Result as CompilationResult, unitToSourceCode } from "./compile";
import { Fuzzer, FuzzingResult } from "./fuzzer";
import { applyNRandomRewrites, pickAny, Rewrite } from "sol-fuzz";
import { deepStrictEqual } from "node:assert";
import logger from "./logging";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { exists } from "./utils";

function deepEqual(a: any, b: any) {
    try {
        deepStrictEqual(a, b);
    } catch (e) {
        return false;
    }
    return true;
}

async function saveVariant(variantFileName: string, variant: SourceUnit, version: string) {
    if (!(await exists(variantFileName))) {
        await writeFile(
            variantFileName,
            // versions[0] is the regular solc version
            await unitToSourceCode(variant, version)
        );
    }
}

export async function run({
    seedUnits,
    rewrites,
    rewriteDepth,
    versions,
    numberOfTests,
    testCallFunctionName,
    saveVariants,
    baseFileName,
    outputPath
}: {
    seedUnits: SourceUnit[];
    rewrites: Rewrite[];
    rewriteDepth: number;
    versions: string[];
    numberOfTests: number;
    testCallFunctionName: string;
    saveVariants: boolean;
    baseFileName: string;
    outputPath: string;
}): Promise<{
    compilationFailures: Array<[string, CompilationResult]>;
    fuzzingFailures: Array<[string, string, FuzzingResult]>;
}> {
    const compilationFailures: Array<[string, CompilationResult]> = [];
    const fuzzingFailures: Array<[string, string, FuzzingResult]> = [];

    for (let i = 0; i < numberOfTests; i++) {
        const compilationResults: CompilationResult[] = [];
        const fuzzingResults: Array<FuzzingResult | undefined> = [];

        const unit = pickAny(seedUnits);
        const variant = applyNRandomRewrites(unit, rewrites, rewriteDepth);
        const variantFileName = path.join(outputPath, `${baseFileName}.variant.${i}.sol`);
        if (saveVariants) {
            await saveVariant(variantFileName, variant, versions[0]);
        }
        const fuzzer = new Fuzzer(variant, testCallFunctionName, versions[0]);
        const contractName = unit.vContracts[0].name;
        for (const version of versions) {
            const compilationResult = await compile(variant, version);
            compilationResults.push(compilationResult);
            if (!compilationResult.success) {
                // If compilation failed for a specific version, skip the fuzzing
                continue;
            }

            const bytecode = compilationResult.bytecode(contractName);
            if (bytecode === undefined) {
                fuzzingResults.push(undefined);
                logger.debug(
                    `Bytecode not found for contract ${contractName}. Version: ${version}`
                );
            } else {
                const fuzzingResult = await fuzzer.fuzz(bytecode, version);
                fuzzingResults.push(fuzzingResult);
            }
        }

        if (compilationResults.every((result) => !result.success)) {
            // If all compilations failed, we assume the variant is invalid and skip other checks
            continue;
        }

        for (const compilationResult of compilationResults) {
            if (!compilationResult.success) {
                // if compilation failed for a specific version, add the variant and version to the list of compilation failures
                if (!saveVariants) {
                    // if we're not saving variants, we need to forcefully save the variant file for debugging
                    await saveVariant(variantFileName, variant, versions[0]);
                }
                compilationFailures.push([variantFileName, compilationResult]);
            }
        }

        const results = new Set(fuzzingResults.map((result) => result?.runResult.result.result));
        if (results.size === 1) {
            //there's the same result for all versions (i.e. no difference), so we can skip this test
            continue;
        }

        const baseResult = fuzzingResults.find(
            (result) => result?.runResult.result.result === "success"
        );
        if (baseResult === undefined) {
            // there's no success result, so we can't compare anything
            continue;
        }

        const baseOutput = baseResult.runResult.result.output;
        const baseStorage = baseResult.runResult.storage;
        const baseLogs = baseResult.runResult.logs;

        for (const [index, fuzzingResult] of fuzzingResults.entries()) {
            if (fuzzingResult === undefined) {
                if (!saveVariants) {
                    // if we're not saving variants, we need to forcefully save the variant file for debugging
                    await saveVariant(variantFileName, variant, versions[index]);
                }
                fuzzingFailures.push([
                    "no-fuzzing",
                    variantFileName,
                    fuzzer.emptyFuzzingResult(versions[index])
                ]);
                continue;
            }
            if (fuzzingResult === baseResult) {
                continue;
            }
            if (
                fuzzingResult.runResult.result.output !== baseOutput ||
                !deepEqual(fuzzingResult.runResult.storage, baseStorage) ||
                !deepEqual(fuzzingResult.runResult.logs, baseLogs)
            ) {
                if (!saveVariants) {
                    // if we're not saving variants, we need to forcefully save the variant file for debugging
                    await saveVariant(variantFileName, variant, versions[index]);
                }
                fuzzingFailures.push(["output-mismatch", variantFileName, fuzzingResult]);
            }
        }
    }

    return {
        compilationFailures,
        fuzzingFailures
    };
}
