variable "project_name" {
  description = "Project name used as the prefix for resource names."
  type        = string
  default     = "njit-course-checker"
}

variable "vpc_cidr" {
  description = "IPv4 CIDR block for the VPC; a /16 provides the intended /24 subnets."
  type        = string
  default     = "10.0.0.0/16"
}

variable "enable_frontend" {
  description = "Enable frontend runtime resources. Disabling removes the ECS runtime, ALB, and frontend logs while preserving foundational infrastructure."
  type        = bool
  default     = true
}
