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

variable "checker_image_tag" {
  description = "Immutable tag in the backend ECR repository for the checker image. Leave unset to disable the checker."
  type        = string
  default     = null

  validation {
    condition     = var.checker_image_tag == null || can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.checker_image_tag))
    error_message = "Use a valid container image tag or leave it unset."
  }
}

variable "checker_terms" {
  description = "One or two distinct Banner terms for the checker and search. Leave empty when the checker is disabled."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition = (
      length(var.checker_terms) <= 2 &&
      length(distinct(var.checker_terms)) == length(var.checker_terms) &&
      alltrue([for term in var.checker_terms : can(regex("^[0-9]{4}(10|50|90|95)$", term))])
    )
    error_message = "Use at most two distinct six-digit Banner terms ending in 10, 50, 90, or 95."
  }
}
