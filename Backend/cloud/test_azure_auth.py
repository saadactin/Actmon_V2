import asyncio
from typing import Dict, Any

from azure.identity import ClientSecretCredential
from azure.mgmt.subscription import SubscriptionClient
from azure.mgmt.resource import ResourceManagementClient

credentials = {
    'tenant_id': 'cd9feb27-365f-4dbb-8bcf-2d92decee427',
    'client_id': 'adee7090-639c-4dfd-8508-4368d53c61a6',
    'client_secret': 'YOUR_AZURE_CLIENT_SECRET',
    'subscription_id': 'c27e8e3c-43a4-4c60-a0e1-73fafa80b8fa'
}

def test_auth():
    print("Testing Azure auth...")
    cred = ClientSecretCredential(
        tenant_id=credentials["tenant_id"],
        client_id=credentials["client_id"],
        client_secret=credentials["client_secret"],
    )
    client = SubscriptionClient(cred)
    try:
        sub = client.subscriptions.get(credentials["subscription_id"])
        print("Success! Subscription:", sub.display_name)
    except Exception as e:
        print("Auth failed:", e)

if __name__ == "__main__":
    test_auth()
