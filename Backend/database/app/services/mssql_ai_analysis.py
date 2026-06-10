"""
MSSQL AI Analysis Service
Generates AI-driven analysis for MSSQL errors
"""

def analyze_mssql_error(error_message: str, error_code: str, engine=None) -> str:
    """
    Analyze MSSQL error and provide AI-driven insights
    
    Args:
        error_message: The MSSQL error message
        error_code: The MSSQL error code
        engine: SQLAlchemy engine for connection
    
    Returns:
        AI analysis text
    """
    
    error_msg_lower = error_message.lower()
    error_code_int = int(error_code) if error_code.isdigit() else 0
    
    analysis = f"""
MSSQL Error Analysis Report
===========================

What is error:
The SQL Server reported error code {error_code} with message: {error_message}

"""
    
    # Common MSSQL error analysis
    if error_code_int == 1205:
        analysis += """Why it is coming:
This is a deadlock error. MSSQL encountered conflicting locks from multiple transactions
trying to access the same resources simultaneously, forcing one transaction to roll back.

How to solve:
1. Review the deadlock victim query and the blocking query
2. Optimize query execution plans to reduce lock duration
3. Use READ COMMITTED SNAPSHOT isolation if appropriate
4. Consider reordering table access in transactions
5. Implement connection pooling to reduce lock contention
6. Use sp_helptext to examine the problematic stored procedures
7. Apply indexes on frequently locked columns

Exactly where to change:
Check the SQL Server error log and deadlock graph XML for specific queries.
Update the query logic in your application code or stored procedures.

Exact variable to remove:
No configuration variable needs removal - adjust query logic instead.
"""
    elif error_code_int == 1053:
        analysis += """Why it is coming:
This error indicates that a SQL Server query timed out or the server is shutting down.
The server was unable to complete the request within the allocated time.

How to solve:
1. Increase the command timeout in your connection string
2. Optimize the slow running query with proper indexing
3. Check if the server is under heavy load
4. Review and optimize table statistics
5. Consider breaking the query into smaller operations
6. Enable parallel query execution if beneficial

Exactly where to change:
Modify the query timeout in your connection string or application settings.
Optimize the slow-running queries causing the timeout.

Exact variable to remove:
No configuration variable removal needed.
"""
    elif error_code_int == 515:
        analysis += """Why it is coming:
Cannot insert NULL value into a column that doesn't allow NULLs.
The SQL Server constraint prevents inserting NULL values into this column.

How to solve:
1. Provide a non-NULL value for the required column
2. Check the table schema to see which columns require values
3. Use DEFAULT constraint if a default value should be applied
4. Ensure all required fields are populated in the INSERT statement

Exactly where to change:
Update the INSERT statement to include values for all NOT NULL columns.
Modify your application code to populate required fields.

Exact variable to remove:
No configuration variable removal needed.
"""
    elif "permission" in error_msg_lower or "denied" in error_msg_lower:
        analysis += """Why it is coming:
The user does not have sufficient permissions to execute this operation.
The SQL Server login lacks the required permissions for the requested action.

How to solve:
1. Grant the necessary permissions using GRANT statement
2. Check the user's role and permissions in SQL Server
3. Use sp_helprotect to review object permissions
4. Assign appropriate database roles (db_owner, db_datareader, etc.)
5. Verify the user is in the correct database context

Exactly where to change:
Execute GRANT statements to provide required permissions to the user.
Review and update user roles and permissions in SQL Server Management Studio.

Exact variable to remove:
No configuration variable removal needed.
"""
    elif "syntax error" in error_msg_lower:
        analysis += """Why it is coming:
There is a syntax error in the SQL query submitted to SQL Server.
The SQL Server parser encountered invalid SQL syntax.

How to solve:
1. Review the SQL query for syntax errors
2. Check for missing commas, parentheses, or semicolons
3. Verify table and column names are correct
4. Use SQL Server Management Studio to validate syntax
5. Test the query piece by piece to isolate the error
6. Check for reserved keywords used as identifiers

Exactly where to change:
Fix the syntax errors in your SQL query.
Update the query in your application code or stored procedures.

Exact variable to remove:
No configuration variable removal needed.
"""
    else:
        analysis += """Why it is coming:
The specific error requires analysis of the SQL Server error logs and server state.
This error may be related to server configuration, resource constraints, or query issues.

How to solve:
1. Check the SQL Server error log for detailed error information
2. Review Event Viewer for system-level errors
3. Check SQL Server Agent jobs for failures
4. Monitor server resources (CPU, Memory, Disk)
5. Verify all database maintenance jobs are running
6. Check transaction log space availability

Exactly where to change:
Refer to the SQL Server error log and diagnostic data to identify the root cause.

Exact variable to remove:
No configuration variable removal needed.
"""
    
    return analysis.strip()

def get_mssql_recommendations(error_code: str) -> dict:
    """Get specific recommendations for MSSQL error codes"""
    
    error_code_int = int(error_code) if error_code.isdigit() else 0
    
    recommendations = {
        1205: {
            "title": "Deadlock Detected",
            "severity": "HIGH",
            "impact": "Transaction rolled back, operations blocked",
            "actions": ["Review conflicting queries", "Optimize indexes", "Adjust isolation levels"]
        },
        1053: {
            "title": "Query Timeout",
            "severity": "MEDIUM",
            "impact": "Slow query execution",
            "actions": ["Increase timeout", "Optimize query", "Add indexes"]
        },
        515: {
            "title": "NULL Constraint Violation",
            "severity": "LOW",
            "impact": "Data insertion failed",
            "actions": ["Provide required values", "Update schema", "Add defaults"]
        }
    }
    
    return recommendations.get(error_code_int, {
        "title": "MSSQL Error",
        "severity": "UNKNOWN",
        "impact": "Check error logs for details",
        "actions": ["Review error logs", "Check server status"]
    })
