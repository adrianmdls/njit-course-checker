# Standalone rules avoid circular dependencies between groups.
# Terraform removes AWS's default allow-all egress on group creation.

resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb-sg"
  description = "Public HTTP and HTTPS entry point"
  vpc_id      = aws_vpc.main.id
  tags = {
    Name = "${var.project_name}-alb-sg"
    Tier = "alb"
  }
}

resource "aws_security_group" "frontend" {
  name        = "${var.project_name}-frontend-sg"
  description = "Frontend ECS tasks"
  vpc_id      = aws_vpc.main.id
  tags = {
    Name = "${var.project_name}-frontend-sg"
    Tier = "frontend"
  }
}

resource "aws_security_group" "backend" {
  name        = "${var.project_name}-backend-sg"
  description = "Backend ECS tasks"
  vpc_id      = aws_vpc.main.id
  tags = {
    Name = "${var.project_name}-backend-sg"
    Tier = "backend"
  }
}

resource "aws_security_group" "database" {
  name        = "${var.project_name}-database-sg"
  description = "MySQL database"
  vpc_id      = aws_vpc.main.id
  tags = {
    Name = "${var.project_name}-database-sg"
    Tier = "database"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "Public HTTP entry point"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
  tags = {
    Name = "${var.project_name}-alb-http"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "Public HTTPS entry point"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  tags = {
    Name = "${var.project_name}-alb-https"
  }
}

resource "aws_vpc_security_group_egress_rule" "alb_to_frontend" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Frontend requests and health checks"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.frontend.id
  tags = {
    Name = "${var.project_name}-alb-to-frontend"
  }
}

resource "aws_vpc_security_group_ingress_rule" "frontend_from_alb" {
  security_group_id            = aws_security_group.frontend.id
  description                  = "HTTP only from ALB"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.alb.id
  tags = {
    Name = "${var.project_name}-frontend-from-alb"
  }
}

resource "aws_vpc_security_group_egress_rule" "frontend_to_backend" {
  security_group_id            = aws_security_group.frontend.id
  description                  = "Future backend API communication"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.backend.id
  tags = {
    Name = "${var.project_name}-frontend-to-backend"
  }
}

resource "aws_vpc_security_group_ingress_rule" "backend_from_frontend" {
  security_group_id            = aws_security_group.backend.id
  description                  = "API requests only from frontend"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.frontend.id
  tags = {
    Name = "${var.project_name}-backend-from-frontend"
  }
}

resource "aws_vpc_security_group_egress_rule" "backend_to_database" {
  security_group_id            = aws_security_group.backend.id
  description                  = "Backend MySQL connections"
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
  referenced_security_group_id = aws_security_group.database.id
  tags = {
    Name = "${var.project_name}-backend-to-database"
  }
}

resource "aws_vpc_security_group_ingress_rule" "database_from_backend" {
  security_group_id            = aws_security_group.database.id
  description                  = "MySQL only from backend"
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
  referenced_security_group_id = aws_security_group.backend.id
  tags = {
    Name = "${var.project_name}-database-from-backend"
  }
}

# Public AWS endpoints have changing IPs: these rules allow any IPv4 HTTPS destination.
# Private tasks still need NAT or appropriate VPC endpoints and routes; security
# groups alone do not provide connectivity. ECR pulls also need S3 image layers.
# When endpoints are added, restrict HTTPS to endpoint groups and the S3 prefix list.

resource "aws_vpc_security_group_egress_rule" "frontend_https" {
  security_group_id = aws_security_group.frontend.id
  description       = "HTTPS for ECR image pulls and CloudWatch logging"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  tags = {
    Name = "${var.project_name}-frontend-https"
  }
}

resource "aws_vpc_security_group_egress_rule" "backend_https" {
  security_group_id = aws_security_group.backend.id
  description       = "HTTPS for ECR image pulls and CloudWatch logging"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  tags = {
    Name = "${var.project_name}-backend-https"
  }
}

# Database has no outbound rules; replies to permitted connections are stateful.
# Direct checker database access, if needed, requires a future explicit rule.
