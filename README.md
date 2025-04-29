# solc-fuzz

A script for differential random testing of different Solidity compiler versions built on top of [sol-fizz][https://github.com/Consensys/sol-fuzz].
The script generated a specified number of random variations of a seed program and runs a set of different Solidity compiler versions on all mutations, checking that they produce the same result.
Currently the only supported outcomes are Successful Compilation, Compile Error, Crash.

## Installation

Package could be installed globally via following command:

```bash
npm install -g https://github.com/Consensys/solc-fuzz
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

You can use `solc-fuzz` to automatically generate 100 random samples, each utilizing up to 20 rewrites, and compare the result of compiler version 0.8.0 and 0.8.28 on them as follows:

```bash
solc-fuzz seed.sol --rewrites arith.rewrites --num-tests 100 --rewrite-depth 20
```

The output will look something like this:

```
Test #, 0.8.0, 0.8.28
0, ERRORS, OK     
1, ERRORS, ERRORS
2, ERRORS, ERRORS
3, OK, OK     
....
95, OK, OK
96, ERRORS, OK
97, ERRORS, OK
98, ERRORS, OK
99, OK, OK
WARNING: For test 0 compilers 0.8.0 and 0.8.28 differ - ERRORS and OK respectively.
...
WARNING: For test 98 compilers 0.8.0 and 0.8.28 differ - ERRORS and OK respectively.
Total successful compilations: 80 total failing compilations: 120 total crashes: 0
```

The output first list in CSV format the result for each test it executed. For every compiler version it will output either ERRORS (compiler errors), OK (compiled successfully) or CRASH.
Afterwards, if the behavior differed for any tests it will output a warning. Finally it will print out short statistics about the compilations.

If you want to save the generated random files add the `--save` command line option.
