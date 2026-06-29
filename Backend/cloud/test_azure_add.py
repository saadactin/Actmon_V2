import urllib.request, json

data = json.dumps({
    'account_name': 'Azure-Production',
    'provider': 'Azure',
    'environment': 'Production',
    'tenant_or_region': 'global',
    'tenant_id': 'adee7090-639c-4dfd-8508-4368d53c61a6',
    'client_id': 'cd9feb27-365f-4dbb-8bcf-2d92decee427',
    'client_secret': 'YOUR_AZURE_CLIENT_SECRET',
    'subscription_id': 'c27e8e3c-43a4-4c60-a0e1-73fafa80b8fa'
}).encode('utf-8')

req = urllib.request.Request('http://localhost:8002/api/v1/cloud/accounts', data=data, headers={'Content-Type': 'application/json'})
try:
    res = urllib.request.urlopen(req)
    out = json.loads(res.read().decode('utf-8'))
    print('Account added:', out)
    
    # Run scan
    account_id = out['id']
    scan_req = urllib.request.Request(f'http://localhost:8002/api/v1/cloud/discovery/scan/{account_id}', method='POST')
    scan_res = urllib.request.urlopen(scan_req)
    scan_out = json.loads(scan_res.read().decode('utf-8'))
    print('Scan triggered:', scan_out)

except Exception as e:
    print('Error:', e)
    import traceback
    traceback.print_exc()
