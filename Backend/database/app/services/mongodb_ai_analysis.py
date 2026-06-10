"""
MongoDB AI Analysis Service
"""

def analyze_mongodb_error(error_message: str, error_code: str, engine=None) -> str:
    """Analyze MongoDB error and provide AI-driven insights"""
    
    error_msg_lower = error_message.lower()
    
    analysis = f"""
MongoDB Error Analysis Report
============================

What is error:
MongoDB reported error: {error_message}

"""
    
    if "duplicate key" in error_msg_lower:
        analysis += """Why it is coming:
Attempted to insert or update a document with a duplicate value in a unique indexed field.

How to solve:
1. Check existing documents for duplicate values
2. Use updateOne with upsert option
3. Remove or modify the unique index if appropriate
4. Implement application-level duplicate detection
5. Review data import/migration logic

Exactly where to change:
Review your insert/update operations in application code.

Exact variable to remove:
No configuration change needed.
"""
    elif "connection refused" in error_msg_lower or "unable to connect" in error_msg_lower:
        analysis += """Why it is coming:
Cannot connect to the MongoDB server. The server is not responding or network is unreachable.

How to solve:
1. Check if MongoDB server is running
2. Verify connection string and credentials
3. Check firewall rules allow MongoDB port (27017)
4. Ensure network connectivity
5. Check MongoDB server logs for errors
6. Verify bind_ip configuration

Exactly where to change:
Update connection string or MongoDB server configuration.

Exact variable to remove:
Check MongoDB bind_ip setting if needed.
"""
    elif "unauthorized" in error_msg_lower or "authentication failed" in error_msg_lower:
        analysis += """Why it is coming:
User authentication failed. Invalid credentials or insufficient permissions.

How to solve:
1. Verify username and password
2. Check user exists in the database
3. Reset password if needed
4. Verify user roles and permissions
5. Check authentication mechanism (SCRAM, x509)
6. Review admin user configuration

Exactly where to change:
Update connection credentials in application.

Exact variable to remove:
No configuration change needed.
"""
    elif "disk quota exceeded" in error_msg_lower:
        analysis += """Why it is coming:
MongoDB has exceeded available disk space on the server.

How to solve:
1. Free up disk space
2. Delete old data or logs
3. Archive data to external storage
4. Increase storage capacity
5. Implement data retention policy
6. Monitor disk usage regularly

Exactly where to change:
Allocate more storage or implement cleanup policies.

Exact variable to remove:
No configuration change needed.
"""
    else:
        analysis += """Why it is coming:
Review the MongoDB error logs and error code documentation.

How to solve:
1. Check MongoDB server logs
2. Review error code in MongoDB documentation
3. Verify server configuration
4. Check network connectivity
5. Monitor server resources

Exactly where to change:
Refer to MongoDB error logs for specific guidance.

Exact variable to remove:
No configuration change needed.
"""
    
    return analysis.strip()
