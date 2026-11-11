output "ecs_cluster_name" {
  description = "Name of the ECS cluster."
  value       = var.enable_frontend ? aws_ecs_cluster.main[0].name : null
}

output "ecs_frontend_service_name" {
  description = "Name of the frontend ECS service."
  value       = var.enable_frontend ? aws_ecs_service.frontend[0].name : null
}

output "alb_dns_name" {
  description = "DNS name of the internet-facing frontend ALB."
  value       = var.enable_frontend ? aws_lb.frontend[0].dns_name : null
}

output "frontend_url" {
  description = "HTTP URL of the frontend through the ALB."
  value       = var.enable_frontend ? "http://${aws_lb.frontend[0].dns_name}" : null
}

output "frontend_repository_url" {
  description = "URL of the private frontend ECR repository."
  value       = aws_ecr_repository.frontend.repository_url
}

output "storage_bucket_name" {
  description = "Name of the private project S3 bucket."
  value       = aws_s3_bucket.project.bucket
}

output "alb_security_group_id" {
  description = "ID of the alb security group."
  value       = aws_security_group.alb.id
}

output "frontend_security_group_id" {
  description = "ID of the frontend security group."
  value       = aws_security_group.frontend.id
}

output "backend_security_group_id" {
  description = "ID of the backend security group."
  value       = aws_security_group.backend.id
}

output "database_security_group_id" {
  description = "ID of the database security group."
  value       = aws_security_group.database.id
}

output "vpc_id" {
  description = "ID of the project VPC."
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "IPv4 CIDR block of the project VPC."
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs in Availability Zone order."
  value       = aws_subnet.public[*].id
}

output "private_app_subnet_ids" {
  description = "Private application subnet IDs in Availability Zone order."
  value       = aws_subnet.private_app[*].id
}

output "private_db_subnet_ids" {
  description = "Private database subnet IDs in Availability Zone order."
  value       = aws_subnet.private_db[*].id
}

output "availability_zones" {
  description = "Availability Zones used by the project subnets."
  value       = local.availability_zones
}
