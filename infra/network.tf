# Network: the app connects OUTBOUND through its own delegated subnet.
resource "azurerm_virtual_network" "workshop" {
  name                = local.names.vnet
  location            = azurerm_resource_group.workshop.location
  resource_group_name = azurerm_resource_group.workshop.name
  address_space       = [local.vnet_cidr]
  tags                = local.tags
}

resource "azurerm_subnet" "app" {
  name                              = local.names.app_subnet
  resource_group_name               = azurerm_resource_group.workshop.name
  virtual_network_name              = azurerm_virtual_network.workshop.name
  address_prefixes                  = [local.app_cidr]
  default_outbound_access_enabled   = false
  private_endpoint_network_policies = "Enabled"

  delegation {
    name = "app-service"
    service_delegation {
      name    = "Microsoft.Web/serverFarms"
      actions = ["Microsoft.Network/virtualNetworks/subnets/action"]
    }
  }
}

# Private endpoints cannot use the app's delegated integration subnet.
resource "azurerm_subnet" "endpoints" {
  name                              = local.names.pe_subnet
  resource_group_name               = azurerm_resource_group.workshop.name
  virtual_network_name              = azurerm_virtual_network.workshop.name
  address_prefixes                  = [local.pe_cidr]
  default_outbound_access_enabled   = false
  private_endpoint_network_policies = "Disabled"
}

resource "azurerm_network_security_group" "workshop" {
  name                = local.names.nsg
  location            = azurerm_resource_group.workshop.location
  resource_group_name = azurerm_resource_group.workshop.name
  tags                = local.tags
  # Azure default NSG rules remain. This is not a zero-trust egress firewall.
}

resource "azurerm_subnet_network_security_group_association" "app" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.workshop.id
}

resource "azurerm_subnet_network_security_group_association" "endpoints" {
  subnet_id                 = azurerm_subnet.endpoints.id
  network_security_group_id = azurerm_network_security_group.workshop.id
}
