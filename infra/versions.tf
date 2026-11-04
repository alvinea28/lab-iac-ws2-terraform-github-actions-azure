terraform {
  required_version = "= 1.16.1"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "= 5.4.0"
    }
  }
}
