"""
PostgreSQL AI Analysis Service
"""

def analyze_postgresql_error(error_message: str, error_code: str, engine=None) -> str:
    """Analyze PostgreSQL error and provide AI-driven insights"""
    
    error_msg_lower = error_message.lower()
    
    analysis = f"""
PostgreSQL Error Analysis Report
================================

What is error:
PostgreSQL reported error: {error_message}

"""
    
    if "unique violation" in error_msg_lower:
        analysis += """Why it is coming:
A unique constraint was violated during INSERT or UPDATE operation.
Attempting to insert a duplicate value in a column with UNIQUE constraint.

How to solve:
1. Check the existing data for duplicates
2. Use INSERT ... ON CONFLICT to handle duplicates
3. Review the constraint definition
4. Validate input data before insert
5. Consider using UPSERT pattern

Exactly where to change:
Update INSERT/UPDATE statements with conflict handling.

Exact variable to remove:
No configuration change needed.
"""
    elif "syntax error" in error_msg_lower:
        analysis += """Why it is coming:
Invalid SQL syntax in the query submitted to PostgreSQL.

How to solve:
1. Review SQL query for syntax errors
2. Check for missing parentheses or semicolons
3. Verify table and column names
4. Test query in psql
5. Use EXPLAIN to validate query

Exactly where to change:
Fix syntax errors in your SQL query.

Exact variable to remove:
No configuration change needed.
"""
    elif "permission denied" in error_msg_lower:
        analysis += """Why it is coming:
User lacks required permissions to perform the operation.

How to solve:
1. Grant necessary privileges using GRANT statement
2. Check current role permissions
3. Assign appropriate database role
4. Review schema ownership
5. Verify user belongs to correct group

Exactly where to change:
Execute GRANT statements to provide required permissions.

Exact variable to remove:
No configuration change needed.
"""
    elif "too many connections" in error_msg_lower:
        analysis += """Why it is coming:
Connection limit reached on the PostgreSQL server.

How to solve:
1. Increase max_connections in postgresql.conf
2. Implement connection pooling (pgBouncer)
3. Close idle connections
4. Review client connection patterns
5. Monitor active connections

Exactly where to change:
Update max_connections in postgresql.conf and restart server.

Exact variable to remove:
Increase the max_connections parameter if needed.
"""
    else:
        analysis += """Why it is coming:
Review the PostgreSQL logs and error message for specific details.

How to solve:
1. Check PostgreSQL error logs
2. Review postgresql.conf settings
3. Monitor server resources
4. Check for transaction conflicts
5. Review query performance

Exactly where to change:
Refer to error logs for specific remediation.

Exact variable to remove:
No configuration change needed.
"""
    
    return analysis.strip()
