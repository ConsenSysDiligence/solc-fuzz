import random from "crypto-random-bigint";
import {
    InferType,
    IntType,
    SourceUnit,
    TypeNode,
    FunctionDefinition,
    assert
} from "solc-typed-ast";
import { encodeFunctionCall } from "web3-eth-abi";
import { runEVM, RunEVMResult } from "./evmc";

export type FuzzingResult = {
    runResult: RunEVMResult;
    version: string;
    encodedCall: string;
    callParameters: number[];
    functionName: string;
};

export class Fuzzer {
    private functionCall: string;
    private testFunction: FunctionDefinition;
    private callParameters: number[];

    constructor(
        private unit: SourceUnit,
        private testCallFunction: string,
        private version: string
    ) {
        const testFunction = this.unit.vContracts[0].vFunctions.find(
            (f) => f.name === this.testCallFunction
        );
        if (testFunction === undefined) {
            throw new Error(`Function ${this.testCallFunction} not found in contract`);
        }
        this.testFunction = testFunction;
        this.callParameters = this.generateCallParameters();
        this.functionCall = this.prepareFunctionCall();
    }

    private generateCallParameters(): number[] {
        const type = new InferType(this.version);
        const params = [];
        for (const param of this.testFunction.vParameters.vParameters) {
            const typeNode = type.variableDeclarationToTypeNode(param);
            const value = this.generateRandomValue(typeNode);
            assert(value !== undefined, `Missing random value for {0}`, typeNode);
            // assert the value is defined
            params.push(value);
        }
        return params;
    }

    private prepareFunctionCall(): string {
        return encodeFunctionCall(
            {
                name: this.testCallFunction,
                type: "function",
                inputs: this.testFunction.vParameters.vParameters.map((p) => ({
                    name: p.name,
                    type: p.vType?.typeString ?? ""
                }))
            },
            this.callParameters
        );
    }

    private generateRandomValue(typeNode: TypeNode): any {
        if (typeNode instanceof IntType) {
            if (typeNode.signed) {
                const sign = random(1) === 1n;
                if (sign) {
                    return random(typeNode.nBits - 1) * -1n;
                }
                return random(typeNode.nBits - 1);
            } else {
                return random(typeNode.nBits);
            }
        }
        return undefined;
    }

    emptyFuzzingResult(version: string): FuzzingResult {
        return {
            runResult: {
                result: {
                    result: "no-op",
                    output: ""
                },
                storage: {},
                logs: []
            },
            version,
            encodedCall: this.functionCall,
            callParameters: this.callParameters,
            functionName: this.testCallFunction
        };
    }

    async fuzz(bytecode: string, version: string): Promise<FuzzingResult> {
        // version in the parameters can be different from the version in the constructor, because we prepare the same random values for all versions
        const revision = version === "eof" ? 14 : 13;
        const runResult = await runEVM({
            bytecode,
            input: this.functionCall,
            revision
        });
        return {
            runResult,
            version: this.version,
            encodedCall: this.functionCall,
            callParameters: this.callParameters,
            functionName: this.testCallFunction
        };
    }
}
