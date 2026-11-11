provider "aws" {
  region  = "us-east-1"
  profile = "njit-terraform"

  default_tags {
    tags = {
      Project     = "NJIT-Course-Checker"
      Environment = "development"
      ManagedBy   = "Terraform"
    }
  }
}
