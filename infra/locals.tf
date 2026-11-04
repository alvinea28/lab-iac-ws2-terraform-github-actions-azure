locals {
  # One name parameter, predictable service prefixes and an unchanged suffix.
  suffix = "${var.participant_name}-${var.instance_number}"
  names = {
    resource_group = "rg-${local.suffix}"
    vnet           = "vnet-${local.suffix}"
    nsg            = "nsg-${local.suffix}"
    app_subnet     = "snet-app-${local.suffix}"
    pe_subnet      = "snet-pe-${local.suffix}"
    plan           = "asp-${local.suffix}"
    app            = "app-${local.suffix}"
    storage        = "st${var.participant_name}${var.instance_number}"
    container      = "cnt-${local.suffix}"
    blob_endpoint  = "pep-blob-${local.suffix}"
    dns_link       = "dnslink-blob-${local.suffix}"
    dns_group      = "dzg-blob-${local.suffix}"
  }
  vnet_cidr = "10.80.${var.assignment.network_slot}.0/24"
  app_cidr  = "10.80.${var.assignment.network_slot}.0/26"
  pe_cidr   = "10.80.${var.assignment.network_slot}.64/27"
  tags = {
    owner              = var.assignment.owner
    environment        = "training"
    cost_center        = var.assignment.cost_center
    workshop           = "ws2-iac"
    participant        = var.participant_name
    workshop_iteration = var.workshop_iteration
    expires_at         = var.assignment.expires_at
  }
}
