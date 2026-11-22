# Execution permissions are for the ECS agent, not application code.
# Future application permissions belong in separate task roles.
resource "aws_iam_role" "ecs_task_execution" {
  name        = "${var.project_name}-ecs-task-execution"
  description = "ECS task execution role for image pulls and logging"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = {
    Name = "${var.project_name}-ecs-task-execution"
  }
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "backend_execution" {
  count = local.backend_enabled ? 1 : 0

  name               = "${local.backend_name}-execution"
  description        = "ECS backend agent permissions for image pulls, logs, and secret injection"
  assume_role_policy = aws_iam_role.ecs_task_execution.assume_role_policy
}

resource "aws_iam_role_policy" "backend_execution" {
  count = local.backend_enabled ? 1 : 0

  name = "backend"
  role = aws_iam_role.backend_execution[0].name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        Resource = concat([
          aws_secretsmanager_secret.database_app.arn,
          aws_secretsmanager_secret.backend_session.arn,
        ], local.checker_enabled ? [aws_secretsmanager_secret.checker_token.arn] : [])
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
        Resource = "${aws_cloudwatch_log_group.backend[0].arn}:log-stream:ecs/backend/*"
      },
    ]
  })
}

resource "aws_iam_role" "checker_execution" {
  count = local.checker_enabled ? 1 : 0

  name               = "${local.checker_name}-execution"
  description        = "ECS checker agent permissions for image pulls, logs, and token injection"
  assume_role_policy = aws_iam_role.ecs_task_execution.assume_role_policy
}

resource "aws_iam_role_policy" "checker_execution" {
  count = local.checker_enabled ? 1 : 0

  name = "checker"
  role = aws_iam_role.checker_execution[0].name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.checker_token.arn
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
        Resource = "${aws_cloudwatch_log_group.checker[0].arn}:log-stream:ecs/checker/*"
      },
    ]
  })
}
