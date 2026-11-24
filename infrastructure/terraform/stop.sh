#!/usr/bin/env bash
set -euo pipefail

terraform_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=runtime-common.sh
source "$terraform_dir/runtime-common.sh"

prepare_operation idle false
confirm_operation 'Remove the application runtime and stop RDS?'
apply_plan
printf 'Application runtime is idle.\n'
ensure_rds_state stopped
printf 'RDS %s: stopped\n' "$db_identifier"
