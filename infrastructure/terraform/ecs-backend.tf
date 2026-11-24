locals {
  backend_name          = "${var.project_name}-backend"
  backend_dns_namespace = "${var.project_name}.internal"
  backend_enabled       = var.enable_runtime && var.backend_image_tag != null
}

resource "aws_service_discovery_private_dns_namespace" "backend" {
  count = local.backend_enabled ? 1 : 0

  name = local.backend_dns_namespace
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "backend" {
  count = local.backend_enabled ? 1 : 0

  name = "backend"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.backend[0].id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

# Populate the secret value outside Terraform before starting the backend.
resource "aws_secretsmanager_secret" "backend_session" {
  name        = "${var.project_name}/backend/session"
  description = "Express session signing secret"
}

resource "aws_ecs_task_definition" "backend" {
  count = local.backend_enabled ? 1 : 0

  family                   = local.backend_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.backend_execution[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "backend"
    image     = "${aws_ecr_repository.backend.repository_url}:${var.backend_image_tag}"
    essential = true
    user      = "node"
    portMappings = [{
      containerPort = 3000
      hostPort      = 3000
      protocol      = "tcp"
    }]
    environment = concat([
      # Use the existing HTTP-compatible app mode for the temporary demo.
      { name = "APP_ENV", value = "development" },
      { name = "APP_ORIGIN", value = local.frontend_http_origin },
      { name = "PORT", value = "3000" },
      { name = "DB_HOST", value = aws_db_instance.database.address },
      { name = "DB_PORT", value = tostring(aws_db_instance.database.port) },
      { name = "DB_NAME", value = aws_db_instance.database.db_name },
      { name = "DB_TLS_CA_FILE", value = "/app/rds-ca.pem" },
      ], local.checker_enabled ? [
      { name = "SEARCH_TERMS", value = jsonencode(var.checker_terms) },
    ] : [])
    secrets = concat([
      { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.database_app.arn}:username::" },
      { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database_app.arn}:password::" },
      { name = "SESSION_SECRET", valueFrom = aws_secretsmanager_secret.backend_session.arn },
      ], local.checker_enabled ? [
      { name = "CHECKER_API_TOKEN", valueFrom = aws_secretsmanager_secret.checker_token.arn },
    ] : [])
    healthCheck = {
      command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval    = 30
      timeout     = 10
      retries     = 3
      startPeriod = 60
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.backend[0].name
        awslogs-region        = aws_cloudwatch_log_group.backend[0].region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  depends_on = [aws_iam_role_policy.backend_execution]

  tags = {
    Name = local.backend_name
  }
}

resource "aws_ecs_service" "backend" {
  count = local.backend_enabled ? 1 : 0

  name             = local.backend_name
  cluster          = aws_ecs_cluster.main[0].id
  task_definition  = aws_ecs_task_definition.backend[0].arn
  desired_count    = 1
  launch_type      = "FARGATE"
  platform_version = "1.4.0"

  # Cap deployments at one task, allowing brief downtime during replacement.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  wait_for_steady_state              = true

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private_app[*].id
    security_groups  = [aws_security_group.backend.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.backend[0].arn
  }

  depends_on = [
    aws_lb_listener_rule.block_ingestion,
    aws_lb_listener_rule.block_bearer,
    aws_route_table_association.public,
    aws_route_table_association.private_app,
    aws_route_table_association.private_db,
    aws_route.private_app_default,
    aws_vpc_security_group_egress_rule.backend_https,
    aws_vpc_security_group_egress_rule.backend_to_database,
    aws_vpc_security_group_egress_rule.frontend_to_backend,
    aws_vpc_security_group_ingress_rule.backend_from_frontend,
    aws_vpc_security_group_ingress_rule.database_from_backend,
  ]

  tags = {
    Name = local.backend_name
  }
}
