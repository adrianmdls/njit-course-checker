locals {
  db_initializer_name = "${var.project_name}-db-initializer"
  db_initializer_secrets = {
    MASTER_DB_SECRET = aws_db_instance.database.master_user_secret[0].secret_arn
    APP_DB_SECRET    = aws_secretsmanager_secret.database_app.arn
  }
}

variable "db_initializer_image_tag" {
  description = "Immutable ECR tag for the database initializer image."
  type        = string
  default     = "db-init-m2"

  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.db_initializer_image_tag))
    error_message = "Use a valid container image tag."
  }
}

resource "aws_ecr_repository" "backend" {
  name                 = "${var.project_name}-backend"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_secretsmanager_secret" "database_app" {
  name        = "${var.project_name}/db/app"
  description = "Credentials for the njit_app MariaDB account"
}

resource "aws_cloudwatch_log_group" "db_initializer" {
  name              = "/ecs/${local.db_initializer_name}"
  retention_in_days = 7
}

resource "aws_iam_role" "db_initializer_execution" {
  count = var.enable_runtime ? 1 : 0

  name               = "${local.db_initializer_name}-execution"
  assume_role_policy = aws_iam_role.ecs_task_execution.assume_role_policy
}

resource "aws_iam_role_policy" "db_initializer_execution" {
  count = var.enable_runtime ? 1 : 0

  name = "db-initializer"
  role = aws_iam_role.db_initializer_execution[0].name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = values(local.db_initializer_secrets)
      },
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = aws_ecr_repository.backend.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.db_initializer.arn}:log-stream:ecs/db-initializer/*"
      },
    ]
  })
}

resource "aws_ecs_task_definition" "db_initializer" {
  count = var.enable_runtime ? 1 : 0

  family                   = local.db_initializer_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.db_initializer_execution[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name                   = "db-initializer"
    image                  = "${aws_ecr_repository.backend.repository_url}:${var.db_initializer_image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    environment = [
      { name = "DB_HOST", value = aws_db_instance.database.address },
      { name = "DB_PORT", value = tostring(aws_db_instance.database.port) },
      { name = "DB_NAME", value = aws_db_instance.database.db_name },
    ]
    secrets = [
      for name, arn in local.db_initializer_secrets : { name = name, valueFrom = arn }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.db_initializer.name
        awslogs-region        = aws_cloudwatch_log_group.db_initializer.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  depends_on = [aws_iam_role_policy.db_initializer_execution]
}

output "db_initializer_image" {
  description = "ECR image tag to build and push for the database initializer."
  value       = "${aws_ecr_repository.backend.repository_url}:${var.db_initializer_image_tag}"
}

output "db_initializer_task_definition_arn" {
  description = "Exact revision ARN for manually running the database initializer."
  value       = one(aws_ecs_task_definition.db_initializer[*].arn)
}
