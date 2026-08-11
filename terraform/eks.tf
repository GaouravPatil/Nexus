module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.31"

  cluster_name    = var.cluster_name
  cluster_version = var.cluster_version

  vpc_id                         = module.vpc.vpc_id
  subnet_ids                     = module.vpc.private_subnets
  cluster_endpoint_public_access = true # portfolio convenience; lock down to a VPN/CIDR in real prod

  cluster_addons = {
    coredns            = { most_recent = true }
    kube-proxy          = { most_recent = true }
    vpc-cni              = { most_recent = true }
    aws-ebs-csi-driver  = { most_recent = true }
  }

  eks_managed_node_groups = {
    default = {
      instance_types = var.node_instance_types
      min_size       = var.node_min_size
      max_size       = var.node_max_size
      desired_size   = var.node_desired_size
      capacity_type  = "ON_DEMAND"
    }
  }

  # Lets your local `aws eks update-kubeconfig` user manage the cluster via kubectl
  enable_cluster_creator_admin_permissions = true

  tags = {
    Project = "nexus"
  }
}