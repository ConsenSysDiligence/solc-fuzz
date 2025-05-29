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

function resultEq(
    r1: CompilationResult | FuzzingResult,
    r2: CompilationResult | FuzzingResult
): boolean {
    if (r1 instanceof CompilationResult && r2 instanceof CompilationResult) {
        return r1.success === r2.success;
    }

    if ("runResult" in r1 && "runResult" in r2) {
        return (
            r1.runResult.result.output === r2.runResult.result.output &&
            deepEqual(r1.runResult.storage, r2.runResult.storage) &&
            deepEqual(r1.runResult.logs, r2.runResult.logs)
        );
    }

    return false;
}

export type ResultRow = Array<CompilationResult | FuzzingResult>;

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
}): Promise<Array<[string, string, ResultRow]>> {
    const inconsistentRows: Array<[string, string, ResultRow]> = [];

    for (let i = 0; i < numberOfTests; i++) {
        const unit = pickAny(seedUnits);
        const variant = applyNRandomRewrites(unit, rewrites, rewriteDepth);
        const variantFileName = path.join(outputPath, `${baseFileName}.variant.${i}.sol`);
        if (saveVariants) {
            await saveVariant(variantFileName, variant, versions[0]);
        }
        const fuzzer = new Fuzzer(variant, testCallFunctionName, versions[0]);
        const contractName = unit.vContracts[0].name;
        const results: ResultRow = [];

        for (const version of versions) {
            const compilationResult = await compile(variant, version);
            if (!compilationResult.success) {
                // If compilation failed for a specific version, skip the fuzzing
                results.push(compilationResult);
                continue;
            }

            const bytecode = compilationResult.bytecode(contractName);
            if (bytecode === undefined) {
                results.push(compilationResult);
                logger.debug(
                    `Bytecode not found for contract ${contractName}. Version: ${version}`
                );
            } else {
                const fuzzingResult = await fuzzer.fuzz(bytecode, version);
                results.push(fuzzingResult);
            }
        }

        for (let i = 0; i < results.length; i++) {
            for (let j = i + 1; j < results.length; j++) {
                if (!resultEq(results[i], results[j])) {
                    inconsistentRows.push([variantFileName, contractName, results]);
                }
            }
        }
    }

    return inconsistentRows;
}
