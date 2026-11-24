resource "aws_cloudwatch_log_group" "frontend" {
  count = var.enable_runtime ? 1 : 0

  name              = "/ecs/${var.project_name}-frontend"
  retention_in_days = 7

  tags = {
    Name = "${var.project_name}-frontend-logs"
  }
}

resource "aws_cloudwatch_log_group" "backend" {
  count = local.backend_enabled ? 1 : 0

  name              = "/ecs/${local.backend_name}"
  retention_in_days = 7

  tags = {
    Name = "${local.backend_name}-logs"
  }
}

resource "aws_cloudwatch_log_group" "checker" {
  count = local.checker_enabled ? 1 : 0

  name              = "/ecs/${local.checker_name}"
  retention_in_days = 7
}
