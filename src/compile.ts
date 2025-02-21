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
    PrettyFormatter,
    SourceUnit
} from "solc-typed-ast";
import { compile as compileEOF, resolveCompilerVersion } from "./eof";

export class Result {
    success: boolean;
    result?: CompileResult;
    error?: string;
    version: string;

    constructor(version: string, success: boolean, result?: CompileResult, error?: string) {
        this.success = success;
        this.result = result;
        this.error = error;
        this.version = version;
    }

    bytecode(contractName: string): string | undefined {
        if (this.success === false) {
            throw new Error("compilation failed");
        }
        if (this.version == "eof") {
            return this.result?.data.contracts[Object.keys(this.result.data.contracts)[0]].bin;
        }
        return this.result?.data.contracts["foo.sol"][contractName].evm.bytecode.object;
    }
}

export async function prepareSeedUnits(
    files: string[],
    compilerVersion: string,
    compilerSettings: any
): Promise<SourceUnit[]> {
    const seedUnits: SourceUnit[] = [];

    for (const fileName of files) {
        let result: CompileResult;
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

    return seedUnits;
}

async function write(s: SourceUnit, version: string): Promise<string> {
    const writer = new ASTWriter(
        DefaultASTWriterMapping,
        new PrettyFormatter(4, 0),
        await resolveCompilerVersion(version),
    );
    return writer.write(s);
}

async function _compile(variantStr: string, version: string): Promise<CompileResult> {
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

export async function compile(unit: SourceUnit, version: string): Promise<Result> {
    const variantStr = await write(unit, version);
    try {
        const result = await _compile(variantStr, version);
        return new Result(version, true, result);
    } catch (e: any) {
        let error = e.message;
        if (e instanceof CompileFailedError) {
            for (const failure of e.failures) {
                for (const err of failure.errors) {
                    error += `\n${err}`;
                }
            }
        }
        return new Result(version, false, undefined, error);
    }
}

export async function unitToSourceCode(unit: SourceUnit, version: string): Promise<string> {
    return await write(unit, version);
}
