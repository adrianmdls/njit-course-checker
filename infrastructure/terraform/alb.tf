locals {
  frontend_http_origin = var.enable_runtime ? "http://${aws_lb.frontend[0].dns_name}" : null
}

resource "aws_lb" "frontend" {
  count = var.enable_runtime ? 1 : 0

  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  ip_address_type    = "ipv4"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]

  xff_header_processing_mode = "append"
  enable_xff_client_port     = false

  tags = {
    Name = "${var.project_name}-alb"
  }
}

resource "aws_lb_target_group" "frontend" {
  count = var.enable_runtime ? 1 : 0

  name        = "${var.project_name}-fe-tg"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  protocol    = "HTTP"
  port        = 80

  health_check {
    enabled             = true
    path                = "/"
    protocol            = "HTTP"
    port                = "traffic-port"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name = "${var.project_name}-fe-tg"
  }
}

resource "aws_lb_listener" "frontend_http" {
  count = var.enable_runtime ? 1 : 0

  load_balancer_arn = aws_lb.frontend[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend[0].arn
  }

  tags = {
    Name = "${var.project_name}-http"
  }
}

resource "aws_lb_listener_rule" "block_ingestion" {
  count = local.backend_enabled ? 1 : 0

  listener_arn = aws_lb_listener.frontend_http[0].arn
  priority     = 10

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
    }
  }

  condition {
    path_pattern {
      # The listener evaluates the normalized path. Express routes are case-insensitive.
      regex_values = ["^/+[aA][pP][iI]/+[iI][nN][tT][eE][rR][nN][aA][lL]/+[sS][yY][nN][cC](/.*)?$"]
    }
  }
}

resource "aws_lb_listener_rule" "block_bearer" {
  count = local.backend_enabled ? 1 : 0

  listener_arn = aws_lb_listener.frontend_http[0].arn
  priority     = 20

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
    }
  }

  # Browser auth uses cookies. Keep machine credentials private independently of URI parsing.
  condition {
    http_header {
      http_header_name = "Authorization"
      regex_values     = ["^[Bb][Ee][Aa][Rr][Ee][Rr] .+$"]
    }
  }
}
