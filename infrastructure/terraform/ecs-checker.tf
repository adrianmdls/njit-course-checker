locals {
  checker_name    = "${var.project_name}-checker"
  checker_enabled = local.backend_enabled && var.checker_image_tag != null
}

# Populate the shared token outside Terraform before enabling the checker.
resource "aws_secretsmanager_secret" "checker_token" {
  name        = "${var.project_name}/checker/ingestion-token"
  description = "Bearer token shared by the checker and backend ingestion API"
}

resource "aws_ecs_task_definition" "checker" {
  count = local.checker_enabled ? 1 : 0

  family                   = local.checker_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.checker_execution[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name        = "checker"
    image       = "${aws_ecr_repository.backend.repository_url}:${var.checker_image_tag}"
    essential   = true
    stopTimeout = 120
    environment = [
      { name = "CHECKER_API_URL", value = "http://backend.${local.backend_dns_namespace}:3000" },
      { name = "CHECKER_TERMS", value = jsonencode(var.checker_terms) },
      { name = "CHECKER_LOG_STDERR", value = "1" },
      { name = "TZ", value = "America/New_York" },
    ]
    secrets = [
      { name = "CHECKER_API_TOKEN", valueFrom = aws_secretsmanager_secret.checker_token.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.checker[0].name
        awslogs-region        = aws_cloudwatch_log_group.checker[0].region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  lifecycle {
    precondition {
      condition     = length(var.checker_terms) > 0
      error_message = "Set checker_terms to one or two Banner terms when enabling the checker."
    }
    precondition {
      condition     = var.checker_image_tag != var.backend_image_tag && var.checker_image_tag != var.db_initializer_image_tag
      error_message = "Use a distinct ECR image tag for the checker."
    }
  }
}

resource "aws_ecs_service" "checker" {
  count = local.checker_enabled ? 1 : 0

  name             = local.checker_name
  cluster          = aws_ecs_cluster.main[0].id
  task_definition  = aws_ecs_task_definition.checker[0].arn
  desired_count    = 1
  launch_type      = "FARGATE"
  platform_version = "1.4.0"

  # Stop the old scheduler before starting a replacement.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  wait_for_steady_state              = true

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private_app[*].id
    security_groups  = [aws_security_group.checker[0].id]
    assign_public_ip = false
  }

  depends_on = [
    aws_ecs_service.backend,
    aws_iam_role_policy.checker_execution,
    aws_vpc_security_group_egress_rule.checker_https,
    aws_vpc_security_group_egress_rule.checker_to_backend,
    aws_vpc_security_group_ingress_rule.backend_from_checker,
  ]
}
