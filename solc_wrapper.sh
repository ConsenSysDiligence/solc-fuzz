# Wrapper for solc to use the experimental EOF version. Invoking solc directly from nodejs is not working because it outputs the
# Warning: This is a pre-release compiler version, please do not use it in production. message in stderr which triggers nodejs' process to fail.
# This wrapper is a workaround to avoid this issue.

# get from ENV or default
SOLC_PATH=${SOLC_PATH:-solc}

$SOLC_PATH $1 \
  --experimental-eof-version 1  \
  --evm-version=prague \
  --via-ir \
  --combined-json bin,bin-runtime,hashes
#   > $2 2>&1
