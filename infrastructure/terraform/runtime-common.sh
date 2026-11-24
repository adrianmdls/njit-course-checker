#!/usr/bin/env bash

readonly aws_profile=njit-terraform aws_region=us-east-1
readonly expected_account=010603499490 expected_workspace=default

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

tf() {
  terraform -chdir="$terraform_dir" "$@"
}

aws_cli() {
  aws --profile "$aws_profile" --region "$aws_region" --no-cli-pager "$@"
}

verify_account() {
  local account
  account=$(aws_cli sts get-caller-identity --query Account --output text)
  [[ "$account" == "$expected_account" ]] ||
    fail "AWS account is $account; expected $expected_account."
}

cleanup_operation() {
  if [[ -n "$plan_dir" ]]; then
    rm -f -- "$plan_dir/runtime.tfplan"
    rmdir -- "$plan_dir"
  fi
  rmdir -- "$lock_dir"
}

prepare_operation() {
  local mode=$1 enabled=$2 workspace tool status
  for tool in aws terraform jq; do
    command -v "$tool" >/dev/null || fail "$tool is required."
  done
  [[ -f "$terraform_dir/$mode.tfvars" ]] || fail "Missing $mode.tfvars."

  # Keep injected CLI arguments from changing the saved plan or its application.
  unset TF_CLI_ARGS TF_CLI_ARGS_workspace TF_CLI_ARGS_output TF_CLI_ARGS_plan
  unset TF_CLI_ARGS_show TF_CLI_ARGS_apply
  export AWS_PROFILE="$aws_profile" AWS_REGION="$aws_region" AWS_DEFAULT_REGION="$aws_region"
  export AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off TF_IN_AUTOMATION=1

  verify_account
  workspace=$(tf workspace show)
  [[ "$workspace" == "$expected_workspace" ]] ||
    fail "Terraform workspace is $workspace; expected $expected_workspace."
  export TF_WORKSPACE="$expected_workspace"
  printf 'Verified AWS account %s in %s and Terraform workspace %s.\n' \
    "$expected_account" "$aws_region" "$workspace"

  [[ -d "$terraform_dir/.terraform" ]] || fail 'Run terraform init in infrastructure/terraform first.'
  lock_dir="$terraform_dir/.terraform/runtime-operation.lock"
  mkdir -- "$lock_dir" || fail "Unable to acquire $lock_dir. Check for another startup or shutdown."
  plan_dir=''
  trap cleanup_operation EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  db_identifier=$(tf output -raw rds_instance_identifier) ||
    fail 'The default workspace needs existing persistent infrastructure and its Terraform state.'
  [[ -n "$db_identifier" ]] || fail 'The Terraform RDS identifier is empty.'

  umask 077
  plan_dir=$(mktemp -d "${TMPDIR:-/tmp}/njit-runtime.XXXXXXXX")
  plan_file="$plan_dir/runtime.tfplan"
  plan_result=0
  printf 'Planning with %s.tfvars.\n' "$mode"
  tf plan -input=false -lock-timeout=60s -detailed-exitcode -var-file="$mode.tfvars" \
    -out="$plan_file" || plan_result=$?
  case "$plan_result" in
    0|2) ;;
    *) fail "Terraform plan failed with exit code $plan_result." ;;
  esac
  validate_plan "$enabled"
  status=$(rds_status)
  printf 'Current RDS status: %s\n' "$status"
}

validate_plan() {
  local enabled=$1 db_arn
  db_arn="arn:aws:rds:$aws_region:$expected_account:db:$db_identifier"

  # Runtime resources use one of the three feature gates in their Terraform count.
  # Review just the selected plan metadata without storing a second copy of the plan.
  tf show -json "$plan_file" | jq -e --arg account "$expected_account" \
    --arg db_arn "$db_arn" --arg enabled "$enabled" '
      def runtime_address: split("[")[0];
      [.configuration.root_module.resources[]
        | select(any(.count_expression.references[]?;
            . == "var.enable_runtime" or . == "local.backend_enabled" or . == "local.checker_enabled"))
        | .address] as $runtime
      | .planned_values.root_module.resources as $planned
      | [.resource_changes[]?
        | select(.mode == "managed" and .change.actions != ["no-op"])
        | (.address | runtime_address) as $address
        | select(($runtime | index($address)) == null or
            ($enabled == "false" and .change.actions != ["delete"]))
        | .address] as $unexpected
      | if .errored == true or .complete == false then
          error("Expected a complete Terraform plan.")
        elif (.variables.enable_runtime.value | tostring) != $enabled then
          error("Unexpected value for enable_runtime.")
        elif (any(.prior_state.values.root_module.resources[];
          .address == "data.aws_caller_identity.current" and .values.account_id == $account) | not) then
          error("The Terraform provider account could not be verified.")
        elif (any($planned[]; .address == "aws_db_instance.database" and .values.arn == $db_arn) | not) then
          error("The Terraform plan does not retain the expected RDS instance.")
        elif ($unexpected | length) != 0 then
          error("Unexpected resource changes: " + ($unexpected | join(", ")))
        elif $enabled == "false" and any($planned[];
          (.address | runtime_address) as $address | ($runtime | index($address)) != null) then
          error("The idle plan would retain application runtime resources.")
        elif $enabled == "true" and (any($planned[]; .address == "aws_ecs_service.frontend[0]") | not) then
          error("The runtime plan does not include the frontend service.")
        else true end
    ' >/dev/null || fail 'The saved plan did not pass runtime safety checks.'
}

confirm_operation() {
  local confirmation
  printf '%s Type yes to continue: ' "$1"
  if ! IFS= read -r confirmation || [[ "$confirmation" != yes ]]; then
    printf '\nCancelled.\n'
    exit 0
  fi
}

apply_plan() {
  if [[ "$plan_result" == 0 ]]; then
    printf 'Terraform found no runtime changes to apply.\n'
    return
  fi

  verify_account
  printf 'Applying the approved Terraform plan.\n'
  tf apply -input=false -lock-timeout=60s "$plan_file"
}

rds_status() {
  aws_cli rds describe-db-instances --db-instance-identifier "$db_identifier" \
    --query 'DBInstances[0].DBInstanceStatus' --output text
}

ensure_rds_state() {
  local target=$1 source_state action status previous_status='' requested=false
  local deadline=$((SECONDS + 1800))

  case "$target" in
    available) source_state=stopped action=start ;;
    stopped) source_state=available action=stop ;;
    *) fail "Unknown RDS target state $target." ;;
  esac

  while (( SECONDS < deadline )); do
    status=$(rds_status)
    case "$status" in
      "$target") return 0 ;;
      "$source_state")
        if [[ "$requested" == false ]]; then
          verify_account
          printf 'Requesting RDS %s for %s.\n' "$action" "$db_identifier"
          aws_cli rds "$action-db-instance" --db-instance-identifier "$db_identifier" >/dev/null
          requested=true
        fi
        ;;
      starting|stopping|backing-up|maintenance|modifying|rebooting|resetting-master-credentials|\
      storage-optimization|upgrading|configuring-enhanced-monitoring|configuring-iam-database-auth|configuring-log-exports)
        ;;
      *) fail "RDS $db_identifier reported unexpected state $status." ;;
    esac
    if [[ "$status" != "$previous_status" ]]; then
      printf 'RDS %s is %s. Waiting for %s.\n' "$db_identifier" "$status" "$target"
      previous_status=$status
    fi
    sleep 30
  done
  fail "Timed out waiting for RDS $db_identifier to become $target (last state: $previous_status)."
}
