# solc-fuzz

A script for differential random testing of different Solidity compiler versions built on top of [sol-fizz][https://github.com/Consensys/sol-fuzz].
The script generated a specified number of random variations of a seed program and runs a set of different Solidity compiler versions on all mutations, checking that they produce the same result.
Currently the only supported outcomes are Successful Compilation, Compile Error, Crash.

## Installation

The tool requires a special hacked version of EVMC to compare storage after execution. For convenience we package it in a docker container and run it in there. To install from source run:
```bash
git clone https://github.com/Consensys/solc-fuzz
cd solc-fuzz
npm install
npm run build
docker build . -t solc-fuzz
```

## Usage

To use the tool you need a Solidity seed file and a set of rewrites as required by [sol-fuzz](https://github.com/Consensys/sol-fuzz). So for example given the following seed file:

```solidity seed.sol
contract Test {
  int64 x;
  /// <SOL-FUZZ-TARGET>
  function foo(int64 y) public {
  }
}
```

And the following rewrites:

```solidity arith.rewrites
#0u64 = Literal('int64', 'number', '', '0');
#1u64 = Literal('int64', 'number', '', '1');
#2u64 = Literal('int64', 'number', '', '2');
#X = Identifier('int64', 'x', -1);
#Y = Identifier('int64', 'y', -1);

#AtomU64 = any(#X, #Y, #0u64, #1u64, #2u64);
#UnaryOp = any("~", "-");
#UnaryOrLower = any(UnaryOperation('int64', true, #UnaryOp, #AtomU64), #AtomU64);
#BinaryArithOp = any("+", "-", "*", "/", "%");
#BinaryArithOrLower= any(BinaryOperation('int64', #BinaryArithOp, #BinaryArithOrLower, #UnaryOrLower), #UnaryOrLower);
#ExprU64 = #BinaryArithOrLower;

Block([$a@..., $b@...], $doc@*) =>
    Block(
        [$a, ExpressionStatement(#ExprU64), $b],
        $doc
    );
```

The tool itself is ran as a docker container as follows:

```bash
docker run -t solc-fuzz -v ${PWD}:/data --compiler-versions 0.8.20  --num-tests 1 --rewrite-depth 10 /data/seed.sol --rewrites /data/arith.rewrites --test-call-function foo --output /data
```

Lets break down the options:

- `-v ${PWD}:/data` - this mounts the current directory as `/data` in the container. This allows us to access the seed file and re-writes in the container, and also to get the tool output
- `--num-tests 1` - how many test variants to generate
- `--rewrite-depth 10` - how many random rewrites to apply to get a new random variant
- `/data/seed.sol` - path to the seed file. Note that since this is in the container, we used the mount path `/data` specified earlier
- `--rewrites /data/arith.rewrites` - path to the rewrites file (again in the container)
- `--test-call-function foo` - path to a public function to try executing. If compilation succeeds, we will try to run the code for different compiler versions and compare the resulting state
- `--output /data` - path where to write results. Results are written in JSON format in a file `results.json`. 
The result format is a sequence of JSON object. One object per test for which some compiler produced a differing result. For the failing test we output the result (compiler error or execution result) for all compiler versions.
If you want to save the generated random files add the `--save` command line option.
