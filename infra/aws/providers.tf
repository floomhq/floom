terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # Team use: switch to an S3 + DynamoDB backend so state (which holds secret
  # values) is encrypted + shared. See README "Remote state".
  # backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = var.project
      Env       = var.environment
      ManagedBy = "terraform"
    }
  }
}
