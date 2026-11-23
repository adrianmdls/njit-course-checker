# AWS deployment and HTTP demo

This is the temporary IT 342 HTTP demo. Use disposable credentials. HTTP
exposes passwords and session cookies in transit. The demo uses
`APP_ENV=development`, signed sessions stored in MariaDB, and cookies with
`HttpOnly` and `SameSite=Lax`. Public production deployments require HTTPS
and `Secure` cookies.

Run these steps in the same Bash session from the repository root. Use
Terraform 1.6 or later, AWS CLI v2, Docker Buildx with `linux/amd64` support,
`jq`, Python 3, OpenSSL, and curl. Verify the AWS account and use the authoritative
Terraform state for an existing deployment.

## Provision persistent resources

```bash
set -euo pipefail
export AWS_PROFILE=njit-terraform AWS_REGION=us-east-1 AWS_PAGER=""
project=njit-course-checker

tf() {
  terraform -chdir=infrastructure/terraform "$@"
}

aws sts get-caller-identity
tf init
tf workspace show
```

The examples use the default project name. If you use a different prefix, set
`project_name` in the variable file and match it in the shell's `project`.
Create the ignored file `infrastructure/terraform/demo.tfvars` with the settings
below. Pick fresh tags for new builds and use them throughout the walkthrough.

```hcl
enable_runtime           = false
frontend_image_tag       = "frontend-demo-1"
db_initializer_image_tag = "db-init-demo-1"
backend_image_tag        = null
checker_image_tag        = null
checker_terms            = []
```

Review the proposed changes before approving the apply. Use this same pair of
commands for each change to the variable file below.

```bash
tf plan -var-file=demo.tfvars
tf apply -var-file=demo.tfvars
```

With runtime disabled, Terraform provisions the VPC and subnets, ECS cluster,
ECR repositories, project S3 bucket, Secrets Manager entries, and RDS. The RDS
subnet group spans two isolated DB subnets in separate AZs
(`10.0.21.0/24` and `10.0.22.0/24` with the default VPC CIDR). The private
MariaDB instance runs in one AZ and uses the VPC-local route.

## Build, publish, and verify images

Match the frontend tag in `demo.tfvars` and use the Terraform output for the
initializer image reference. The immutable backend repository holds the
backend, checker, and initializer images under distinct tags.

```bash
frontend_repo=$(tf output -raw frontend_repository_url)
backend_repo=$(tf output -raw backend_repository_url)
frontend_tag=frontend-demo-1
backend_tag=backend-demo-1
checker_tag=checker-demo-1
initializer_image=$(tf output -raw db_initializer_image)
registry=${frontend_repo%%/*}

aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"

docker buildx build --platform linux/amd64 --push \
  --tag "$frontend_repo:$frontend_tag" --file frontend/Dockerfile frontend
docker buildx build --platform linux/amd64 --push \
  --tag "$backend_repo:$backend_tag" --file backend/Dockerfile backend
docker buildx build --platform linux/amd64 --push \
  --tag "$backend_repo:$checker_tag" --file Dockerfile .
docker buildx build --platform linux/amd64 --push \
  --tag "$initializer_image" --file infrastructure/db-initializer/Dockerfile .
```

Confirm that ECR reports the matching tag and a SHA-256 digest for each of the
four images before enabling runtime.

```bash
aws ecr describe-images --repository-name "${frontend_repo##*/}" \
  --image-ids "imageTag=$frontend_tag" \
  --query 'imageDetails[].[imageTags,imageDigest]' --output json
aws ecr describe-images --repository-name "${backend_repo##*/}" \
  --image-ids "imageTag=$backend_tag" "imageTag=$checker_tag" "imageTag=${initializer_image##*:}" \
  --query 'imageDetails[].[imageTags,imageDigest]' --output json
```

## Populate Secrets Manager

RDS manages its master password. Terraform creates the three application secret
entries. Write their values directly to Secrets Manager. Check for versions
first and run each corresponding write only for an empty entry. Keep existing
values on redeploy. Turn off shell tracing and AWS CLI debug output.

```bash
set +x
for name in db/app backend/session checker/ingestion-token; do
  printf '%s\n' "$project/$name"
  aws secretsmanager describe-secret --secret-id "$project/$name" \
    --query 'VersionIdsToStages' --output json
done
```

The app credential is JSON with the `njit_app` username. The session secret
and ingestion token are separate strings generated from 32 random bytes,
stored as hex with no JSON wrapper or trailing newline.

```bash
python3 -c 'import json, secrets; print(json.dumps({"username": "njit_app", "password": secrets.token_urlsafe(32)}))' |
  aws secretsmanager put-secret-value --secret-id "$project/db/app" \
    --secret-string file:///dev/stdin --query 'VersionId' --output text

openssl rand -hex 32 | tr -d '\n' |
  aws secretsmanager put-secret-value --secret-id "$project/backend/session" \
    --secret-string file:///dev/stdin --query 'VersionId' --output text

openssl rand -hex 32 | tr -d '\n' |
  aws secretsmanager put-secret-value --secret-id "$project/checker/ingestion-token" \
    --secret-string file:///dev/stdin --query 'VersionId' --output text
```

Keep the app credential stable while the initializer runs. Changing the
session secret invalidates existing sessions. Redeploy both the backend and
checker after rotating the shared ingestion token because ECS injects it at
task startup.

## Initialize RDS and start the frontend

Get the RDS identifier and check its status. If it is stopped, run
`aws rds start-db-instance --db-instance-identifier "$db"` before the waiter.

```bash
db=$(tf output -raw rds_instance_identifier)
aws rds describe-db-instances --db-instance-identifier "$db" \
  --query 'DBInstances[0].DBInstanceStatus' --output text
```

```bash
aws rds wait db-instance-available --db-instance-identifier "$db"
```

Set `enable_runtime = true` in `demo.tfvars`, keep both backend and checker tags
`null` for initial deployment, and [plan and apply](#provision-persistent-resources).
This starts the ALB, frontend service, and one NAT gateway per application AZ.
The ALB can serve the frontend during initialization.

Launch the standalone initializer in a private application subnet using the
backend security group. It reaches AWS services via NAT and RDS over TCP 3306
with verified TLS. The operator needs `ecs:RunTask`, `ecs:DescribeTasks`, and
`iam:PassRole` on the initializer execution role.

```bash
cluster=$(tf output -raw ecs_cluster_name)
definition=$(tf output -raw db_initializer_task_definition_arn)
subnet=$(tf output -json private_app_subnet_ids | jq -er '.[0]')
sg=$(tf output -raw backend_security_group_id)

launch=$(aws ecs run-task --cluster "$cluster" --task-definition "$definition" \
  --launch-type FARGATE --platform-version 1.4.0 --count 1 \
  --network-configuration "awsvpcConfiguration={subnets=[$subnet],securityGroups=[$sg],assignPublicIp=DISABLED}" \
  --output json)
task=$(jq -er 'if (.failures | length) > 0 then error(.failures | tostring) else .tasks[0].taskArn end' <<< "$launch")
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
result=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --output json)
jq '.tasks[0] | {stopCode, stoppedReason, containers: [.containers[] | {name, exitCode, reason}]}' <<< "$result"
jq -e 'any(.tasks[0].containers[]; .name == "db-initializer" and .exitCode == 0)' <<< "$result"
```

Require exit code `0` before enabling the backend. On failure, check the stopped
reason and `/ecs/<project_name>-db-initializer`. The initializer uses an advisory
lock and schema fingerprint. A matching retry preserves rows and passwords.
Review partial, unfamiliar, or drifted schemas before retrying.

## Start and test the backend

Set `backend_image_tag` to the published backend tag, keep
`checker_image_tag = null`, and [plan and apply](#provision-persistent-resources).
The backend uses verified TLS to RDS. Terraform derives `APP_ORIGIN` from the
ALB URL. Nginx uses Cloud Map to resolve `backend.<project_name>.internal`
with a 10-second positive DNS cache. Replacing the single backend task can
briefly interrupt the API. DNS negative caching can prolong the interruption.

```bash
url=$(tf output -raw frontend_url)
curl -fsS "$url/api/health"
```

Expect HTTP `200` with `{"status":"ok","database":"connected"}`. Open the exact
`frontend_url` in a browser, register with disposable credentials, log in,
reload to verify the session, and log out.

Check that the public ALB returns `404` for both mixed-case ingestion routes and
for a bearer header on an ordinary API route. Use the fixture token below.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$url/Api/Internal/Sync/Targets"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$url/Api/Internal/Sync/Department"
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer demo-fixture' "$url/api/health"
```

## Start and test the checker

Set `checker_image_tag` to the published checker tag and `checker_terms` to
one or two distinct [Banner terms](../operations.md#banner-term-codes), then
[plan and apply](#provision-persistent-resources). This also updates the
backend with the shared token and search terms. The checker sends its real
token over private HTTP to the backend in the demo VPC.

```bash
aws ecs describe-services --cluster "$cluster" \
  --services "$project-checker" \
  --query 'services[0].{desired:desiredCount,running:runningCount}' --output json
aws logs tail "/ecs/$project-checker" --since 1h
```

Verify one running task and a successful `synchronized N sections` entry after
a scheduled slot. With no watches, regular work runs at :00 and :30 New York
time. Once a sync returns sections, log in to the frontend and search the
synced term and department. Confirm the results include saved sections and
their last-seen times. Empty snapshots can succeed, so use a pair with
sections for this check. Repeat the health and public ALB checks after the
backend rolls out.

The checker cursor is local to the ECS task. Replacements restart regular
rotation at `ACCT` and can delay later departments. Keep one checker producer
for the backend.

## Shut down the demo

Set `enable_runtime = false` and [plan and apply](#provision-persistent-resources).
Review the removal of the ECS services, ALB, and NAT gateways while retaining
the persistent resources. Save any frontend, backend, or checker logs you
need before applying because their log groups are removed.

Stop RDS separately after runtime is down. RDS restarts it automatically
after seven days. Storage and backup charges continue while it is stopped.
Use the same RDS status command above to confirm it reaches `stopped`.
[AWS RDS stop behavior](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html)

```bash
db=$(tf output -raw rds_instance_identifier)
aws rds stop-db-instance --db-instance-identifier "$db"
```
