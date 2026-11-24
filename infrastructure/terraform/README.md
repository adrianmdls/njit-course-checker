# AWS runtime operations

Run these commands from the repository root with Bash, AWS CLI v2, Terraform
1.6 or later, and `jq`. Use the authenticated `njit-terraform` profile for AWS
account `010603499490` in `us-east-1`. The scripts use the `default` Terraform
workspace and the existing deployment's state. Run `terraform init` in this
directory when setting up the working copy. The profile needs the Terraform
deployment permissions and `rds:DescribeDBInstances`, `rds:StartDBInstance`, and
`rds:StopDBInstance`.

## First-time deployment

Follow the [AWS deployment and database initialization guide](../../docs/cloud_infrastructure/aws-db-initialization.md)
to provision the persistent resources, publish the ECR images, populate the
application secrets, run the one-time ECS database initializer, and verify it
exits successfully. Confirm that `runtime.tfvars` uses the published image
tags and intended Banner terms before the first scripted start. Routine runs
reuse the existing images, secret values, and initialized MariaDB data.

## Start

```bash
./infrastructure/terraform/start.sh
```

Review the saved plan from `runtime.tfvars` and type `yes` to proceed. The
script starts RDS if needed, waits for it to become `available`, applies the
approved plan if there are changes, and prints the RDS status and frontend URL.
The ALB DNS name can change after a shutdown and restart.

## Stop

```bash
./infrastructure/terraform/stop.sh
```

Review the saved plan from `idle.tfvars` and type `yes` to proceed. Terraform
removes the runtime resources, including the ECS services, ALB, NAT gateways,
and application log groups. Export any application logs you need before
approving the plan. After Terraform succeeds or confirms the runtime is already
idle, the script stops RDS if needed and waits for `stopped`. The database and
its storage, ECS cluster, ECR repositories, S3 bucket, and application secrets
remain in place.

RDS automatically restarts after seven consecutive days stopped. Storage and
backup charges continue while it is stopped. [AWS RDS stop behavior](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html)

## Retrying an operation

The scripts reject plans that change persistent resources. Review and resolve
such drift separately before retrying. Each script waits up to 30 minutes for
RDS. If startup fails after RDS starts, it can remain running. If shutdown's
Terraform apply fails, RDS stays in its current state. Rerun the appropriate
script to generate a fresh plan after reviewing the failure.

Run one infrastructure operation at a time against the deployment. The scripts
share a local lock in `.terraform/runtime-operation.lock`. If an abrupt exit
leaves that directory behind, confirm the previous operation has ended before
removing the empty lock directory with `rmdir`.
