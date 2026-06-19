"""
ClickHouse AI Analysis Service
"""

def analyze_clickhouse_error(error_message: str, error_code: str, engine=None) -> str:
    """Analyze ClickHouse error and provide AI-driven insights"""
    
    error_msg_lower = error_message.lower()
    
    analysis = f"""
ClickHouse Error Analysis Report
===============================

What is error:
ClickHouse reported error: {error_message}

"""
    
    if "syntax error" in error_msg_lower:
        analysis += """Why it is coming:
Invalid SQL syntax in the ClickHouse query.

How to solve:
1. Review query syntax for errors
2. Check column names and table references
3. Verify function names are correct
4. Use ClickHouse documentation for syntax
5. Test query in clickhouse-client

Exactly where to change:
Fix syntax errors in your SQL query.

Exact variable to remove:
No configuration change needed.
"""
    elif "table doesn't exist" in error_msg_lower or "unknown table" in error_msg_lower:
        analysis += """Why it is coming:
Referenced table does not exist in ClickHouse database.

How to solve:
1. Verify table name and database
2. Check table creation in correct database
3. Review table schema
4. Use SHOW TABLES to list tables
5. Check for typos in table name

Exactly where to change:
Correct the table name in your query or create the missing table.

Exact variable to remove:
No configuration change needed.
"""
    elif "not enough memory" in error_msg_lower or "memory limit" in error_msg_lower:
        analysis += """Why it is coming:
ClickHouse query exceeded available memory limit.

How to solve:
1. Increase max_memory_usage setting
2. Optimize query to process less data
3. Add WHERE clauses to filter data
4. Use sampling for large datasets
5. Break large query into smaller parts
6. Review server memory availability

Exactly where to change:
Adjust max_memory_usage in ClickHouse config or optimize query.

Exact variable to remove:
Consider increasing max_memory_usage if needed.
"""
    elif "disconnected" in error_msg_lower or "connection refused" in error_msg_lower:
        analysis += """Why it is coming:
Cannot connect to ClickHouse server. Connection was refused or terminated.

How to solve:
1. Check if ClickHouse server is running
2. Verify connection host and port
3. Check firewall allows ClickHouse port (8123 for HTTP)
4. Verify credentials
5. Check server logs for connection issues
6. Verify network connectivity

Exactly where to change:
Update connection settings or check ClickHouse server configuration.

Exact variable to remove:
No configuration change needed.
"""
    elif "code 47" in error_msg_lower or "unsupported" in error_msg_lower:
        analysis += """Why it is coming:
ClickHouse encountered an unsupported operation or data type.

How to solve:
1. Review the unsupported feature in documentation
2. Use alternative functions or data types
3. Check ClickHouse version for feature availability
4. Consider upgrading ClickHouse if needed
5. Review data type compatibility

Exactly where to change:
Modify query to use supported functions or data types.

Exact variable to remove:
No configuration change needed.
"""
    else:
        analysis += """Why it is coming:
Review the ClickHouse error logs and documentation.

How to solve:
1. Check ClickHouse system.errors table
2. Review error logs in /var/log/clickhouse-server
3. Check system.query_log for query details
4. Verify server configuration
5. Monitor server resources

Exactly where to change:
Refer to ClickHouse documentation and logs for specific guidance.

Exact variable to remove:
No configuration change needed.
"""
    
    return analysis.strip()
