resource "aws_ecs_cluster" "main" {
  count = var.enable_frontend ? 1 : 0

  name = "${var.project_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = {
    Name = "${var.project_name}-cluster"
  }
}

resource "aws_ecs_task_definition" "frontend" {
  count = var.enable_frontend ? 1 : 0

  family                   = "${var.project_name}-frontend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "frontend"
    image     = "${aws_ecr_repository.frontend.repository_url}:m1"
    essential = true
    portMappings = [{
      containerPort = 80
      hostPort      = 80
      protocol      = "tcp"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.frontend[0].name
        awslogs-region        = aws_cloudwatch_log_group.frontend[0].region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  tags = {
    Name = "${var.project_name}-frontend"
  }
}

resource "aws_ecs_service" "frontend" {
  count = var.enable_frontend ? 1 : 0

  name            = "${var.project_name}-frontend"
  cluster         = aws_ecs_cluster.main[0].id
  task_definition = aws_ecs_task_definition.frontend[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Keep at most one task during deployments; updates can briefly interrupt service.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 60
  wait_for_steady_state              = true

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Public IPv4 plus the existing IGW route provides HTTPS access to ECR and Logs.
  # Inbound HTTP remains restricted to the ALB by the existing frontend group.
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.frontend.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend[0].arn
    container_name   = "frontend"
    container_port   = 80
  }

  depends_on = [
    aws_lb_listener.frontend_http,
    aws_iam_role_policy_attachment.ecs_task_execution,
    aws_route_table_association.public,
    aws_vpc_security_group_ingress_rule.frontend_from_alb,
    aws_vpc_security_group_egress_rule.alb_to_frontend,
    aws_vpc_security_group_egress_rule.frontend_https,
  ]

  tags = {
    Name = "${var.project_name}-frontend"
  }
}
