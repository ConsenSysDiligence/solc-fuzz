#!/usr/bin/env node
import { Command } from "commander";
import fse from "fs-extra";
import {
    applyNRandomRewrites,
    BaseRule,
    Diversity,
    GenEnv,
    GenRule,
    makeRewrite,
    parseRules,
    pickAny,
    RewriteRule,
    SyntaxError
} from "sol-fuzz";
import {
    assert,
    ASTReader,
    ASTWriter,
    CompilationOutput,
    CompileFailedError,
    CompileResult,
    CompilerKind,
    compileSol,
    compileSourceString,
    DefaultASTWriterMapping,
    LatestCompilerVersion,
    PrettyFormatter,
    SourceUnit,
    ContractDefinition
} from "solc-typed-ast";
import { compile as compileEOF, version as eofVersion } from "../eof";
import { EVMLog, EVMStorage, runEVM } from "../evmc";
import nodeAssert from "node:assert/strict";

const pkg = require("../../package.json");

function extractInputAndBytecode(
    contracts: any,
    version: string,
    contractName: string,
    testCallFunction: string
): {
    methodIdentifier?: string;
    bytecode?: string;
} {
    if (version == "eof") {
        const contract = contracts[Object.keys(contracts)[0]];
        const methodSig = Object.keys(contract.hashes).find((m) => m.startsWith(testCallFunction));
        if (methodSig === undefined) {
            console.error(`Method ${testCallFunction} not found in contract ${contractName}`);
            return { methodIdentifier: undefined, bytecode: undefined };
        }
        const methodIdentifier = contract.hashes[methodSig];
        const bytecode = contract.bin;
        return { methodIdentifier, bytecode };
    }

    const methodSig = Object.keys(contracts["foo.sol"][contractName].evm.methodIdentifiers).find(
        (m) => m.startsWith(testCallFunction)
    );
    if (methodSig === undefined) {
        console.error(`Method ${testCallFunction} not found in contract ${contractName}`);
        return { methodIdentifier: undefined, bytecode: undefined };
    }
    const methodIdentifier = contracts["foo.sol"][contractName].evm.methodIdentifiers[methodSig];
    const bytecode = contracts["foo.sol"][contractName].evm.bytecode.object;

    return { methodIdentifier, bytecode };
}

function write(s: SourceUnit, version: string): string {
    const writer = new ASTWriter(DefaultASTWriterMapping, new PrettyFormatter(4, 0), version);
    return writer.write(s);
}

async function compile(variantStr: string, version: string): Promise<CompileResult> {
    // compile regular & eof
    if (version == "eof") {
        return await compileEOF(variantStr);
    }
    return await compileSourceString(
        "foo.sol",
        variantStr,
        version,
        undefined,
        [CompilationOutput.ALL],
        undefined,
        CompilerKind.Native
    );
}

async function main() {
    const program = new Command();

    program
        .name("solc-fuzz")
        .description(pkg.description)
        .version(pkg.version, "-v, --version", "Print package version")
        .helpOption("-h, --help", "Print help message");

    program.argument("seeds", "Solidity files to use as seeds");

    program
        .option(
            "--compiler-versions <compilerVersion...>",
            `Solc versions to use: ${LatestCompilerVersion} (exact SemVer version specifier)`
        )
        .option(
            "--compiler-settings <compilerSettings>",
            `Additional settings passed to the solc compiler in the form of a JSON string (e.g. '{"optimizer": {"enabled": true, "runs": 200}}'). Note the double quotes. For more details see https://docs.soliditylang.org/en/latest/using-the-compiler.html#input-description.`
        )
        .option("--rewrites <rewritePath>", `Path to file containing AST re-writes`)
        .option("--rewrite-depth <rewriteDepth>", `Number of re-writes to apply`, "1")
        .option("--num-tests <numTests>", `Number of tests to run`, "1")
        .option("--save", `Save generated random variants`)
        .option(
            "--test-call-function <functionName>",
            "Call contract's function to test storage and logs",
            undefined
        )
        .option("--test-eof", "Test EOF", false)
        .option("--verbose <level>", `Verbose output`, "0");

    program.parse(process.argv);

    const args = program.args;
    const options = program.opts();

    if (options.help || (!args.length && !options.stdin)) {
        console.log(program.helpInformation());

        return;
    }

    let versions: string[] = [];

    if (options.compilerVersions) {
        versions = options.compilerVersions;
    } else {
        versions = [LatestCompilerVersion];
    }

    if (options.testEof) {
        versions.push("eof");
    }

    let compilerSettings: any = undefined;

    if (options.compilerSettings) {
        try {
            compilerSettings = JSON.parse(options.compilerSettings);
        } catch (e) {
            throw new Error(
                `Invalid compiler settings '${options.compilerSettings}'. Compiler settings must be a valid JSON object (${e}).`
            );
        }
    }

    let rules: BaseRule[] = [];

    if (options.rewrites) {
        try {
            rules = parseRules(fse.readFileSync(options.rewrites, { encoding: "utf-8" }));
        } catch (e) {
            if (e instanceof SyntaxError) {
                console.error(
                    `Error parsing rewrites: ${e.location.start.line}:${e.location.start.column}: ${e.message}`
                );
                return;
            }

            throw e;
        }
    }

    const genRules: GenRule[] = rules.filter((r) => r instanceof GenRule) as GenRule[];
    const env: GenEnv = new Map(genRules.map((r) => [r.name, r.pattern]));

    const rewriteRules: RewriteRule[] = rules.filter(
        (r) => r instanceof RewriteRule
    ) as RewriteRule[];

    if (rewriteRules.length === 0) {
        console.error(`No re-write rules specified. Exiting...`);
        return;
    }

    const rand = new Diversity();

    const rewrites = rewriteRules.map((r) => makeRewrite(r, env, rand));

    const compilerVersion: string = versions[0];

    let result: CompileResult;
    const seedUnits: SourceUnit[] = [];

    for (const fileName of args) {
        try {
            result = await compileSol(
                fileName,
                compilerVersion,
                undefined,
                [CompilationOutput.ALL],
                compilerSettings,
                CompilerKind.Native
            );
        } catch (e: any) {
            if (e instanceof CompileFailedError) {
                console.error("Compile errors encountered:");

                for (const failure of e.failures) {
                    console.error(
                        failure.compilerVersion
                            ? `SolcJS ${failure.compilerVersion}:`
                            : "Unknown compiler:"
                    );

                    for (const error of failure.errors) {
                        console.error(error);
                    }
                }

                throw new Error("Unable to compile due to errors above.");
            }

            throw e;
        }

        const reader = new ASTReader();
        const units = reader.read(result.data);
        assert(units.length === 1, `Expected a single source unit`);

        seedUnits.push(units[0]);
    }

    const rewriteDepth = Number(options.rewriteDepth);
    const numTests = Number(options.numTests);

    let numSuccess = 0;
    let numCompileError = 0;
    let numCrash = 0;

    const verbosity = Number(options.verbose);

    const results: Array<Array<"OK" | "CRASH" | "ERRORS">> = [];
    const runResults: Array<Array<"success" | "revert" | "n/a">> = [];
    const storages: Array<Array<EVMStorage | undefined>> = [];
    const logs: Array<Array<EVMLog[] | undefined>> = [];

    const testCallFunction = options.testCallFunction;

    for (let i = 0; i < numTests; i++) {
        const unit = pickAny(seedUnits);
        const variant = applyNRandomRewrites(unit, rewrites, rewriteDepth, rand);

        if (verbosity >= 2) {
            console.log("==================================================================");
            console.log(write(variant, versions[0]));
        }

        if (options.save) {
            fse.writeFileSync(`${args[0]}.variant.${i}.sol`, write(variant, versions[0]));
        }

        const curResults: Array<"OK" | "CRASH" | "ERRORS"> = [];

        const storagePerVersion: Array<EVMStorage | undefined> = versions.map(() => undefined);
        const logsPerVersion: Array<EVMLog[] | undefined> = versions.map(() => undefined);
        const runResultPerVersion: Array<"success" | "revert" | "n/a"> = versions.map(() => "n/a");

        const contractName = unit.children.find((el) => el instanceof ContractDefinition)?.name;

        let versionIndex = 0;
        for (const version of versions) {
            const variantStr = write(variant, version == "eof" ? await eofVersion() : version);
            try {
                const compilationResult = await compile(variantStr, version);
                numSuccess++;

                if (verbosity >= 1) {
                    console.error(`Test ${i} ${version}: Compiled!`);
                }

                if (contractName !== undefined && testCallFunction !== undefined) {
                    const { methodIdentifier, bytecode } = extractInputAndBytecode(
                        compilationResult.data.contracts,
                        version,
                        contractName,
                        testCallFunction
                    );

                    if (methodIdentifier === undefined || bytecode === undefined) {
                        continue;
                    }

                    let revision = 14;
                    if (version !== "eof") {
                        revision = 13;
                    }

                    const { storage, logs, result } = await runEVM({
                        bytecode,
                        input: methodIdentifier,
                        verbosity,
                        revision
                    });
                    storagePerVersion[versionIndex] = storage;
                    logsPerVersion[versionIndex] = logs;
                    runResultPerVersion[versionIndex] = result.result;
                    if (verbosity >= 1) {
                        console.error(`Test ${i} ${version}: Deployed and tested!`);
                    }
                }

                curResults.push("OK");
            } catch (e: any) {
                if (e instanceof CompileFailedError) {
                    curResults.push("ERRORS");
                    if (verbosity >= 1) {
                        console.error("Compile errors encountered:");

                        for (const failure of e.failures) {
                            console.error(
                                failure.compilerVersion
                                    ? `SolcJS ${failure.compilerVersion}:`
                                    : "Unknown compiler:"
                            );

                            for (const error of failure.errors) {
                                console.error(error);
                            }
                        }
                    }

                    numCompileError++;
                } else {
                    numCrash++;

                    curResults.push("CRASH");
                    if (verbosity >= 1) {
                        console.error(`${version}: Other errors!: ${e}`);
                    }
                }
            }
            versionIndex++;
        }

        results.push(curResults);
        storages.push(storagePerVersion);
        logs.push(logsPerVersion);
        runResults.push(runResultPerVersion);
    }

    console.log(
        "============================ COMPILATION RESULTS ======================================"
    );
    console.log(["Test #", ...versions].join(", "));
    for (let i = 0; i < results.length; i++) {
        console.log([`${i}`, ...results[i]].join(", "));
    }

    for (let i = 0; i < results.length; i++) {
        for (let j = 0; j < results[i].length; j++) {
            for (let k = j + 1; k < results[i].length; k++) {
                if (results[i][j] !== results[i][k]) {
                    console.error(
                        `WARNING: For test ${i} compilers ${versions[j]} and ${versions[k]} differ - ${results[i][j]} and ${results[i][k]} respectively.`
                    );
                }
            }
        }
    }

    if (testCallFunction !== undefined) {
        console.log(
            "============================ DEPLOY AND RUN RESULTS ======================================"
        );
        console.log(["Test #", ...versions].join(", "));
        for (let i = 0; i < runResults.length; i++) {
            console.log([`${i}`, ...runResults[i]].join(", "));
        }

        for (let i = 0; i < results.length; i++) {
            for (let j = 0; j < results[i].length; j++) {
                for (let k = j + 1; k < results[i].length; k++) {
                    if (!(results[i][j] === results[i][k] && results[i][j] === "OK")) {
                        // we only care about the cases where contract compiles
                        continue;
                    }
                    if (storages[i][j] !== undefined && storages[i][k] !== undefined) {
                        try {
                            nodeAssert.deepStrictEqual(storages[i][j], storages[i][k]);
                        } catch (e) {
                            console.error(
                                `WARNING: Storage mismatch for test ${i} compilers ${versions[j]} and ${versions[k]} - ${JSON.stringify(storages[i][j])} and ${JSON.stringify(storages[i][k])} respectively`
                            );
                        }
                    }

                    if (logs[i][j] !== undefined && logs[i][k] !== undefined) {
                        try {
                            nodeAssert.deepStrictEqual(logs[i][j], logs[i][k]);
                        } catch (e) {
                            console.error(
                                `WARNING: Logs mismatch for test ${i} compilers ${versions[j]} and ${versions[k]} - ${JSON.stringify(logs[i][j])} and ${JSON.stringify(logs[i][k])} respectively`
                            );
                        }
                    }
                }
            }
        }
    }

    console.log(
        `Total successful compilations: ${numSuccess} total failing compilations: ${numCompileError} total crashes: ${numCrash}`
    );
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((e) => {
        console.error(e.message);

        process.exit(1);
    });
