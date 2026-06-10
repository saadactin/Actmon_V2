"""
Base Discovery Class
Abstract base for all cloud provider discovery engines
"""

from abc import ABC, abstractmethod
from typing import Dict, List, Any, Optional
from datetime import datetime
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class BaseCloudDiscovery(ABC):
    """Abstract base class for cloud resource discovery"""

    def __init__(self, account_config: Dict[str, Any]):
        """
        Initialize cloud discovery with account configuration

        Args:
            account_config: Dictionary containing cloud account credentials and config
        """
        self.account_config = account_config
        self.provider = account_config.get("provider")
        self.region = account_config.get("region")
        self.account_name = account_config.get("account_name")
        self.discovered_resources = []

    @abstractmethod
    def authenticate(self) -> bool:
        """Authenticate with cloud provider"""
        pass

    @abstractmethod
    def discover_compute(self) -> List[Dict[str, Any]]:
        """Discover compute resources (VMs, instances)"""
        pass

    @abstractmethod
    def discover_storage(self) -> List[Dict[str, Any]]:
        """Discover storage resources (buckets, volumes)"""
        pass

    @abstractmethod
    def discover_databases(self) -> List[Dict[str, Any]]:
        """Discover database resources"""
        pass

    @abstractmethod
    def discover_networking(self) -> List[Dict[str, Any]]:
        """Discover networking resources"""
        pass

    @abstractmethod
    def discover_all(self) -> Dict[str, List[Dict[str, Any]]]:
        """Run full discovery across all resource types"""
        pass

    def format_resource(
        self,
        resource_id: str,
        resource_name: str,
        resource_type: str,
        region: str,
        status: str,
        metadata: Optional[Dict[str, Any]] = None,
        ip_address: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Standardize resource format across all providers

        Args:
            resource_id: Unique resource identifier
            resource_name: Human-readable resource name
            resource_type: Type of resource
            region: Region/zone where resource is located
            status: Current status
            metadata: Additional resource metadata
            ip_address: IP address if applicable

        Returns:
            Standardized resource dictionary
        """
        return {
            "resource_id": resource_id,
            "resource_name": resource_name,
            "resource_type": resource_type,
            "region_or_zone": region,
            "status": status,
            "ip_address": ip_address,
            "provider": self.provider,
            "account_name": self.account_name,
            "discovered_at": datetime.utcnow().isoformat(),
            "metadata": metadata or {},
        }

    def log_discovery(self, resource_type: str, count: int):
        """Log discovery progress"""
        logger.info(
            f"[{self.provider}] [{self.account_name}] Discovered {count} {resource_type} in {self.region}"
        )
