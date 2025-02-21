import { Command } from "commander";
import {
    BaseRule,
    GenEnv,
    GenRule,
    makeRewrite,
    parseRules,
    Rewrite,
    RewriteRule,
    SyntaxError
} from "sol-fuzz";
import { LatestCompilerVersion } from "solc-typed-ast";
import fs from "node:fs/promises";

const pkg = require("../package.json");

export class NoOpError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NoOpError";
    }
}

export type Config = {
    files: string[];
    rewriteDepth: number;
    numTests: number;
    testCallFunction: string | undefined;
    testEof: boolean;
    verbose: number;
    timeLimit: number | undefined;
    config: string | undefined;
    versions: string[];
    compilerVersion: string;
    compilerSettings: any;
    rewrites: Rewrite[];
    outputPath: string;
    saveVariants: boolean;
};

export async function prepareConfig(): Promise<Config> {
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
        .option("--verbose <level>", `Verbose output`, "0")
        .option("--time-limit <timeLimit>", `Time limit for each test in seconds`, undefined)
        .option("--config <configPath>", `Path to config file`, undefined)
        .option("--output <outputPath>", `Path to output files`, "fuzzer-results");

    program.parse(process.argv);

    const args = program.args;
    const options = program.opts();

    if (options.help || (!args.length && !options.stdin)) {
        console.log(program.helpInformation());
        throw new NoOpError("Help message printed");
    }

    if (options.logPretty) {
        process.env.LOG_PRETTY = "true";
    }

    if (options.logLevel) {
        process.env.LOG_LEVEL = options.logLevel;
    }

    const versions: string[] = options.compilerVersions ?? [LatestCompilerVersion];

    if (options.testEof) {
        versions.push("eof");
    }

    if (options.testEof && options.testCallFunction === undefined) {
        console.error(`No test call function specified. Exiting...`);
        throw new NoOpError("No test call function specified");
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
            rules = parseRules(await fs.readFile(options.rewrites, { encoding: "utf-8" }));
        } catch (e) {
            if (e instanceof SyntaxError) {
                console.error(
                    `Error parsing rewrites: ${e.location.start.line}:${e.location.start.column}: ${e.message}`
                );
                throw new NoOpError("Error parsing rewrites");
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
        throw new NoOpError("No re-write rules specified");
    }

    const rewrites: Rewrite[] = rewriteRules.map((r) => makeRewrite(r, env));

    const compilerVersion: string = versions[0];

    return {
        files: args,
        rewriteDepth: Number(options.rewriteDepth),
        numTests: Number(options.numTests),
        testCallFunction: options.testCallFunction,
        testEof: options.testEof,
        verbose: options.verbose,
        timeLimit: options.timeLimit,
        config: options.config,
        versions,
        compilerVersion,
        compilerSettings,
        rewrites,
        outputPath: options.output,
        saveVariants: options.save
    };
}
