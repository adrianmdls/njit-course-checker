#!/usr/bin/env bash
set -euo pipefail

terraform_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=runtime-common.sh
source "$terraform_dir/runtime-common.sh"

prepare_operation runtime true
confirm_operation 'Bring RDS to available and deploy the application runtime?'
ensure_rds_state available
apply_plan

frontend_url=$(tf output -raw frontend_url)
final_db_status=$(rds_status)
printf 'Application runtime deployed.\nRDS %s: %s\nFrontend URL: %s\n' \
  "$db_identifier" "$final_db_status" "$frontend_url"
