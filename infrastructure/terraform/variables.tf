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

variable "enable_runtime" {
  description = "Enable cost-intensive application infrastructure. Setting this to false does not stop RDS."
  type        = bool
  default     = false
}

variable "frontend_image_tag" {
  description = "ECR tag for the frontend image. The initializer-only workflow defaults to the existing m1 image."
  type        = string
  default     = "m1"
  nullable    = false

  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.frontend_image_tag))
    error_message = "Use a valid container image tag."
  }
}

variable "backend_image_tag" {
  description = "Immutable ECR tag for the Express backend image. Leave unset while provisioning and initializing the database."
  type        = string
  default     = null

  validation {
    condition     = var.backend_image_tag == null || can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.backend_image_tag))
    error_message = "Use a valid container image tag or leave it unset."
  }
}
