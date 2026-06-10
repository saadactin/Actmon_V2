"""
Cloud Discovery Service
Main orchestration service for all cloud providers
"""

from typing import Dict, List, Any
import logging
from cloud.aws.discovery import AWSDiscovery
from cloud.azure.discovery import AzureDiscovery
from cloud.oracle.discovery import OracleCloudDiscovery

logger = logging.getLogger(__name__)


class CloudDiscoveryService:
    """
    Main service to discover resources across all cloud providers
    """

    @staticmethod
    def get_discovery_engine(account_config: Dict[str, Any]):
        """
        Factory method to get the appropriate discovery engine

        Args:
            account_config: Cloud account configuration dictionary

        Returns:
            Discovery engine instance for the provider
        """
        provider = account_config.get("provider", "").lower()

        if provider == "aws":
            return AWSDiscovery(account_config)
        elif provider == "azure":
            return AzureDiscovery(account_config)
        elif provider == "oracle":
            return OracleCloudDiscovery(account_config)
        else:
            raise ValueError(f"Unsupported cloud provider: {provider}")

    @staticmethod
    def discover_resources(account_config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Discover all resources for a given cloud account

        Args:
            account_config: Dictionary containing cloud account details

        Returns:
            Dictionary with discovered resources categorized by type
        """
        try:
            # Get the appropriate discovery engine
            discovery_engine = CloudDiscoveryService.get_discovery_engine(
                account_config
            )

            # Run discovery
            logger.info(
                f"Starting discovery for {account_config.get('provider')} account: {account_config.get('account_name')}"
            )
            results = discovery_engine.discover_all()

            return results

        except Exception as e:
            logger.error(f"Cloud discovery failed: {e}")
            return {
                "error": str(e),
                "provider": account_config.get("provider"),
                "account_name": account_config.get("account_name"),
            }

    @staticmethod
    def discover_by_category(
        account_config: Dict[str, Any], category: str
    ) -> List[Dict[str, Any]]:
        """
        Discover resources for a specific category only

        Args:
            account_config: Cloud account configuration
            category: Resource category (compute, storage, databases, networking)

        Returns:
            List of discovered resources for that category
        """
        try:
            discovery_engine = CloudDiscoveryService.get_discovery_engine(
                account_config
            )

            if not discovery_engine.authenticate():
                return []

            if category == "compute":
                return discovery_engine.discover_compute()
            elif category == "storage":
                return discovery_engine.discover_storage()
            elif category == "databases":
                return discovery_engine.discover_databases()
            elif category == "networking":
                return discovery_engine.discover_networking()
            else:
                raise ValueError(f"Invalid category: {category}")

        except Exception as e:
            logger.error(f"Category discovery failed: {e}")
            return []
