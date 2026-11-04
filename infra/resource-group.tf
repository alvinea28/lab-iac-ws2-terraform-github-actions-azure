# The group is part of this workload's state: create first, destroy last.
resource "azurerm_resource_group" "workshop" {
  name     = local.names.resource_group
  location = var.assignment.location
  tags     = local.tags
}
