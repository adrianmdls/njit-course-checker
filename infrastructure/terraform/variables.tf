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

variable "backend_image_tag" {
  description = "Immutable ECR tag for the Express backend image. Leave unset while provisioning and initializing the database."
  type        = string
  default     = null

  validation {
    condition     = var.backend_image_tag == null || can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.backend_image_tag))
    error_message = "Use a valid container image tag or leave it unset."
  }
}

variable "backend_app_origin" {
  description = "Exact HTTP or HTTPS frontend origin for Express. Required when the backend runs."
  type        = string
  default     = null

  validation {
    condition = var.backend_app_origin == null ? true : alltrue([
      can(regex("^https?://([a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)*\\.?|\\[[0-9a-f:]+\\])(:([1-9][0-9]{0,4}|0))?$", var.backend_app_origin)),
      try(tonumber(regex(":([0-9]+)$", var.backend_app_origin)[0]) <= 65535, true),
      !can(regex("^(http://.+:80|https://.+:443)$", var.backend_app_origin)),
      strcontains(var.backend_app_origin, "[") ? try(
        regex("\\[([^]]+)\\]", var.backend_app_origin)[0] == cidrhost("${regex("\\[([^]]+)\\]", var.backend_app_origin)[0]}/128", 0),
        false
      ) : true,
    ])
    error_message = "Use an exact HTTP or HTTPS origin with a lowercase host and an optional non-default port. Omit credentials, paths, queries, and fragments."
  }
}
