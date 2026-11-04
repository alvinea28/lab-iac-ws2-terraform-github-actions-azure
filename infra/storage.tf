# Storage: an Azure naming exception; no hyphens and no public/shared-key access.
resource "azurerm_storage_account" "workshop" {
  name                             = local.names.storage
  location                         = azurerm_resource_group.workshop.location
  resource_group_name              = azurerm_resource_group.workshop.name
  account_kind                     = "StorageV2"
  account_tier                     = "Standard"
  account_replication_type         = "LRS"
  access_tier                      = "Hot"
  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  shared_access_key_enabled        = false
  allow_nested_items_to_be_public  = false
  public_network_access_enabled    = false
  cross_tenant_replication_enabled = false
  default_to_oauth_authentication  = true
  is_hns_enabled                   = false
  sftp_enabled                     = false
  local_user_enabled               = false
  tags                             = local.tags
}

resource "azurerm_private_dns_zone" "blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = azurerm_resource_group.workshop.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "blob" {
  name                 = local.names.dns_link
  private_dns_zone_id  = azurerm_private_dns_zone.blob.id
  virtual_network_id   = azurerm_virtual_network.workshop.id
  registration_enabled = false
  tags                 = local.tags
}

resource "azurerm_private_endpoint" "blob" {
  name                = local.names.blob_endpoint
  location            = azurerm_resource_group.workshop.location
  resource_group_name = azurerm_resource_group.workshop.name
  subnet_id           = azurerm_subnet.endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = local.names.blob_endpoint
    private_connection_resource_id = azurerm_storage_account.workshop.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = local.names.dns_group
    private_dns_zone_ids = [azurerm_private_dns_zone.blob.id]
  }
}

# The trusted runner must resolve/reach the Blob private endpoint for data calls.
resource "azurerm_storage_container" "workshop" {
  name                  = local.names.container
  storage_account_id    = azurerm_storage_account.workshop.id
  container_access_type = "private"
  depends_on            = [azurerm_private_endpoint.blob, azurerm_private_dns_zone_virtual_network_link.blob]
}
