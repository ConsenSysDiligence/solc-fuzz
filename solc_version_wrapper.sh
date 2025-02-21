# Wrapper for solc to get the version. Invoking solc directly from nodejs is not working because the process
# exits with code 126 (instead of 0) and nodejs doesn't capture stdout if the exit code is not 0.
# This wrapper is a workaround to avoid this issue.

$1 --version

exit 0