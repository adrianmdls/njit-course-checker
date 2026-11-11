resource "aws_cloudwatch_log_group" "frontend" {
  count = var.enable_frontend ? 1 : 0

  name              = "/ecs/${var.project_name}-frontend"
  retention_in_days = 7

  tags = {
    Name = "${var.project_name}-frontend-logs"
  }
}
