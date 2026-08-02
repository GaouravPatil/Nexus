# Using the community module here (not hand-rolled) is deliberate:
# it's the de-facto standard for AWS networking in Terraform and any
# interviewer will recognize the pattern instantly. It gives us public
# subnets (for the ALB) and private subnets (for the EKS worker nodes),
# spread across 3 AZs for real availability.
data "aws_availability_zones" "available" {
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 3)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name = "${var.cluster_name}-vpc"
  cidr = var.vpc_cidr

  azs             = local.azs
  private_subnets = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets  = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  enable_nat_gateway   = true
  single_nat_gateway   = true # cost-saving for a portfolio project; use one-per-AZ in real prod
  enable_dns_hostnames = true

  # Required tags so the AWS Load Balancer Controller & EKS can
  # auto-discover subnets for internet-facing / internal load balancers.
  public_subnet_tags = {
    "kubernetes.io/role/elb"                     = "1"
    "kubernetes.io/cluster/${var.cluster_name}"  = "shared"
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"            = "1"
    "kubernetes.io/cluster/${var.cluster_name}"  = "shared"
  }
}