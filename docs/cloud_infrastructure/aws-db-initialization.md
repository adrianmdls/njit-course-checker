# AWS database initialization

Run the initializer as a standalone Fargate task in the existing ECS cluster.
It uses the existing backend security group and one private application subnet.
Keep `enable_runtime=true` while it runs so ECR, Secrets Manager, and CloudWatch
Logs are reachable over HTTPS through the existing NAT gateway. RDS traffic
uses the private VPC route on TCP 3306.
Enabling runtime also starts the existing ALB and frontend service, which
requires its `:m1` image in ECR.

## Prepare the image

For a future deployment, verify the AWS account and authoritative Terraform
state first. The backend ECR repository and app secret can be provisioned with
runtime disabled. Once they exist, use AWS CLI v2, Docker BuildKit, and `jq`
from the repository root. Build and publish the initializer before running the
task. The initial tag is `db-init-m2`. For updates, set
`db_initializer_image_tag` to a new immutable tag and publish that build before
running the new task revision.

```bash
set -euo pipefail
export AWS_PROFILE=njit-terraform AWS_REGION=us-east-1 AWS_PAGER=""
image=$(terraform -chdir=infrastructure/terraform output -raw db_initializer_image)
registry=${image%%/*}

aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"
docker buildx build --platform linux/amd64 --load --tag "$image" \
  --file infrastructure/db-initializer/Dockerfile .
docker push "$image"
```

The standalone [Dockerfile](../../infrastructure/db-initializer/Dockerfile)
uses the repository root as its build context. It installs dependencies from
the backend lockfile, copies `database/init/01-schema.sql`, and verifies the
regional RDS CA bundle checksum. Its entrypoint runs
[`init-db.cjs`](../../infrastructure/db-initializer/init-db.cjs).

## Populate the application secret

Check that the app secret has no versions. Substitute the configured project
prefix if it differs from `njit-course-checker`.

```bash
aws secretsmanager describe-secret --secret-id njit-course-checker/db/app \
  --query 'VersionIdsToStages' --output json
```

Run this once for an empty secret from the same shell. Turn off shell tracing
and AWS CLI debug output. Keep the secret version stable while the task runs.

```bash
python3 -c 'import json, secrets; print(json.dumps({"username": "njit_app", "password": secrets.token_urlsafe(32)}))' |
  aws secretsmanager put-secret-value --secret-id njit-course-checker/db/app \
    --secret-string file:///dev/stdin --query 'VersionId' --output text
```

## Run once

After runtime is enabled and RDS and the NAT routes are ready, use the same
shell. The operator needs `ecs:RunTask`, `ecs:DescribeTasks`, and
`iam:PassRole` on the initializer execution role to launch and verify the task.

```bash
cluster=$(terraform -chdir=infrastructure/terraform output -raw ecs_cluster_name)
definition=$(terraform -chdir=infrastructure/terraform output -raw db_initializer_task_definition_arn)
subnet=$(terraform -chdir=infrastructure/terraform output -json private_app_subnet_ids | jq -er '.[0]')
sg=$(terraform -chdir=infrastructure/terraform output -raw backend_security_group_id)

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

If the task stops with an error, check its stopped reason and the
`/ecs/njit-course-checker-db-initializer` log group. The initializer uses an
advisory lock and records a schema fingerprint after creating all tables. A
matching retry preserves rows and passwords. Partial, unfamiliar, or drifted
schemas require manual review.

The dedicated execution role injects the master and app secrets by exact ARN,
pulls from backend ECR, and writes to its own log streams. The future backend
task needs access only to the app secret and must configure verified database
TLS before using `njit_app`.
