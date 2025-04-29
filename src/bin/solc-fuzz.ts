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
    SourceUnit
} from "solc-typed-ast";

const pkg = require("../../package.json");

function write(s: SourceUnit, version: string): string {
    const writer = new ASTWriter(DefaultASTWriterMapping, new PrettyFormatter(4, 0), version);
    return writer.write(s);
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

        for (const version of versions) {
            const variantStr = write(variant, version);
            try {
                result = await compileSourceString(
                    "foo.sol",
                    variantStr,
                    version,
                    undefined,
                    [CompilationOutput.ALL],
                    undefined,
                    CompilerKind.Native
                );
                numSuccess++;

                if (verbosity >= 1) {
                    console.error(`Test ${i} ${version}: Compiled!`);
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
        }

        results.push(curResults);
    }

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
