terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.31"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.14"
    }
  }

  # Remote state is what makes this "explainable to recruiters" —
  # it shows you understand state isn't supposed to live on a laptop.
  # Create the bucket + DynamoDB lock table once, by hand or via a
  # small bootstrap script, then uncomment this block.
  #
  # backend "s3" {
  #   bucket         = "nexus-tfstate-<your-account-id>"
  #   key            = "eks/terraform.tfstate"
  #   region         = "ap-south-1"
  #   dynamodb_table = "nexus-tfstate-lock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region
}